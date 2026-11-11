import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import * as fixture from "./book-fixture";
import { startProductionWorker } from "../src/tasks/worker";

let worker: Awaited<ReturnType<typeof startProductionWorker>>;
before(async () => {
  await fixture.startBookFixture();
  worker = await startProductionWorker(fixture.app);
});
after(async () => {
  await worker?.close();
  await fixture.stopBookFixture();
});

test(
  "the first photo-origin story freezes its saved interview photos",
  { timeout: 60000 },
  async () => {
    const p = await fixture.joinedProject();
    const interview = fixture.data(
      await fixture.request(
        "POST",
        `/v1/projects/${p.projectId}/interviews`,
        p.narrator.token,
        {
          clientInterviewId: randomUUID(),
          expectedPlanRevision: 1,
          starterKind: "photo",
        },
      ),
    );
    const path = `/v1/projects/${p.projectId}/photos`;
    const materials = `/v1/projects/${p.projectId}/interviews/${interview.id}/photo-materials`;
    const image = await sharp({
      create: { width: 960, height: 640, channels: 3, background: "#e54334" },
    })
      .jpeg()
      .toBuffer();
    const photo = fixture.data(
      await fixture.request("POST", path, p.narrator.token, {
        clientPhotoId: randomUUID(),
        bytes: image.length,
        sha256: createHash("sha256").update(image).digest("hex"),
      }),
    );
    const form = fixture.data(
      await fixture.request(
        "POST",
        `${path}/${photo.id}/upload`,
        p.narrator.token,
        {},
      ),
    );
    assert.equal(
      (await fixture.formUpload(fixture.app, form, image, {}, p.narrator.token))
        .statusCode,
      204,
    );
    fixture.data(
      await fixture.request(
        "POST",
        `${path}/${photo.id}/seal`,
        p.narrator.token,
        {},
      ),
    );
    const collection = fixture.data(
      await fixture.request("GET", path, p.narrator.token),
      200,
    );
    const snapshot = fixture.data(
      await fixture.request("POST", materials, p.narrator.token, {
        expectedRevision: 0,
        entries: [{ photoId: photo.id, caption: "一家人在老院子里" }],
      }),
    );
    await fixture.sealedClip(p, interview.id);
    let story;
    for (let attempt = 0; attempt < 150; attempt++) {
      await worker.recoverDue();
      const context = fixture.data(
        await fixture.request(
          "POST",
          `/v1/projects/${p.projectId}/stories/context`,
          p.narrator.token,
          { interviewId: interview.id },
        ),
      );
      if (context.story?.currentRevisionId) {
        story = fixture.data(
          await fixture.request(
            "GET",
            `/v1/projects/${p.projectId}/stories/${context.story.id}`,
            p.narrator.token,
          ),
          200,
        );
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(story?.revision, "saved recording must produce a readable story");
    assert.equal(story.revision.photoSnapshot?.id, snapshot.id);
    assert.equal(
      story.revision.photoSnapshot.entries[0].caption,
      "一家人在老院子里",
    );
    fixture.data(
      await fixture.request("POST", materials, p.narrator.token, {
        expectedRevision: snapshot.revision,
        entries: [{ photoId: photo.id, caption: "之后补写的新说明" }],
      }),
    );
    const unchanged = fixture.data(
      await fixture.request(
        "GET",
        `/v1/projects/${p.projectId}/stories/${story.id}`,
        p.narrator.token,
      ),
      200,
    );
    assert.equal(unchanged.revision.photoSnapshot.id, snapshot.id);
    assert.equal(
      unchanged.revision.photoSnapshot.entries[0].caption,
      "一家人在老院子里",
    );
  },
);
