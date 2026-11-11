import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, after, test } from "node:test";
import { startProductionWorker } from "../src/tasks/worker";
import * as fixture from "./book-fixture";

let worker: Awaited<ReturnType<typeof startProductionWorker>>;
before(fixture.startBookFixture);
after(async () => {
  await worker?.close();
  await fixture.stopBookFixture();
});

test(
  "members edit, assign, move, unassign, exclude and restore a story while retaining its photos and all supplementary recordings",
  { timeout: 60000 },
  async () => {
    const project = await fixture.joinedProject();
    const p = await fixture.readyStory(project, {
      starterKind: "free-narration",
    });
    const base = `/v1/projects/${p.projectId}`;
    const readStory = async () =>
      fixture.data(
        await fixture.request(
          "GET",
          `${base}/stories/${p.story.id}`,
          p.narrator.token,
        ),
        200,
      );
    const readPlan = async () =>
      fixture.data(
        await fixture.request("GET", `${base}/plan`, p.narrator.token),
        200,
      );
    const place = async (chapterKey: string | null) => {
      const plan = await readPlan();
      return fixture.data(
        await fixture.request("POST", `${base}/plan`, p.narrator.token, {
          expectedVersion: plan.revision,
          content: {
            chapters: plan.chapters.map((ch: any) => ({
              ...ch,
              storyRefs: [
                ...ch.storyRefs.filter((id: string) => id !== p.story.id),
                ...(ch.key === chapterKey ? [p.story.id] : []),
              ],
            })),
            starters: plan.starters,
          },
        }),
      );
    };
    const photo = await fixture.storyPhoto(p, "雨后的老院子");
    const noteId = randomUUID();
    const edit = {
      baseRevisionId: p.story.revision.id,
      expectedVersion: p.story.version,
      title: "老院子里的一场雨",
      theme: p.story.revision.theme,
      paragraphs: [
        ...p.story.revision.paragraphs,
        { text: "雨停后，我们又坐在门口。", sourceRefs: [`note:${noteId}`] },
      ],
      notes: [{ id: noteId, text: "雨停后，我们又坐在门口。" }],
      reviewResolutions: [],
      photoSnapshotId: photo.id,
      audioClipIds: p.story.revision.sourceManifest.map((s: any) => s.clipId),
    };
    const revised = fixture.data(
      await fixture.request(
        "POST",
        `${base}/stories/${p.story.id}/revisions`,
        p.buyer.token,
        edit,
      ),
    );
    assert.equal(revised.version, p.story.version + 1);
    assert.equal(revised.chapter, null);
    assert.equal(revised.revision.title, "老院子里的一场雨");
    assert.equal(revised.revision.photoSnapshot.id, photo.id);
    assert.deepEqual(
      revised.revision.sourceManifest,
      p.story.revision.sourceManifest,
    );
    assert.equal(
      (
        await fixture.request(
          "POST",
          `${base}/stories/${p.story.id}/revisions`,
          p.buyer.token,
          edit,
        )
      ).statusCode,
      409,
    );

    await place("childhood");
    assert.equal((await readStory()).chapter.key, "childhood");
    const moved = await place("learning");
    assert.equal((await readStory()).chapter.key, "learning");
    assert.deepEqual(
      moved.chapters.flatMap((ch: any) => ch.storyRefs),
      [p.story.id],
    );
    await place(null);
    assert.equal((await readStory()).chapter, null);
    assert.equal((await readStory()).included, true);
    await place("society");
    const excluded = fixture.data(
      await fixture.request(
        "POST",
        `${base}/stories/${p.story.id}/inclusion`,
        p.narrator.token,
        { expectedVersion: revised.version, included: false },
      ),
    );
    assert.equal(excluded.included, false);
    assert.equal(excluded.chapter, null);
    assert.deepEqual(
      (await readPlan()).chapters.flatMap((ch: any) => ch.storyRefs),
      [],
    );
    fixture.data(
      await fixture.request(
        "POST",
        `${base}/stories/${p.story.id}/inclusion`,
        p.narrator.token,
        { expectedVersion: revised.version, included: true },
      ),
    );
    assert.equal((await readStory()).chapter, null);
    await place("learning");
    const restored = await readStory();
    assert.equal(restored.included, true);
    assert.equal(restored.chapter.key, "learning");
    assert.equal(restored.revision.id, revised.revision.id);
    assert.deepEqual(
      restored.revision.photoSnapshot,
      revised.revision.photoSnapshot,
    );
    assert.deepEqual(
      restored.revision.audioManifest,
      revised.revision.audioManifest,
    );
    const stranger = await fixture.joinedProject();
    assert.equal(
      (
        await fixture.request(
          "GET",
          `${base}/stories/${p.story.id}`,
          stranger.narrator.token,
        )
      ).statusCode,
      403,
    );

    worker = await startProductionWorker(fixture.app);
    await fixture.sealedClip(p, p.interviewId);
    let supplemented = restored;
    for (let attempt = 0; attempt < 150; attempt++) {
      await worker.recoverDue();
      supplemented = await readStory();
      if (supplemented.revision.sourceManifest.length === 3) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(supplemented.id, p.story.id);
    assert.equal(supplemented.interviewId, p.interviewId);
    assert.equal(supplemented.revision.sourceManifest.length, 3);
    assert.ok(
      edit.audioClipIds.every((id: string) =>
        supplemented.revision.sourceManifest.some((s: any) => s.clipId === id),
      ),
    );
    assert.equal(supplemented.revision.photoSnapshot.id, photo.id);
    assert.equal(supplemented.chapter.key, "learning");
    const overview = fixture.data(
      await fixture.request("GET", `${base}/overview`, p.narrator.token),
      200,
    );
    assert.deepEqual(
      overview.stories.map((s: any) => s.id),
      [p.story.id],
    );
  },
);
