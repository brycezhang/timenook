import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { readFileSync } from "node:fs";
import { rm, writeFile, chmod, stat, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import Redis from "ioredis";
import { paymentAdmin } from "./payment-admin-fixture";
import type { DeletionStatus } from "@timenook/contracts";
import { PrismaClient, Prisma } from "@prisma/client";
import { Deletions } from "../src/care/deletions";
import { ProjectServiceTerms } from "../src/projects/service-terms";
import { performance } from "node:perf_hooks";
import { randomUUID, createHash } from "node:crypto";
import {
  startBookFixture,
  stopBookFixture,
  app,
  config,
  db,
  root,
  readyStory,
  storyPhoto,
  request,
  data,
  login,
  syntheticAudio,
  joinedProject,
  restartBookApplication,
  interceptBookObjectRead,
  interceptBookErasureError,
  state,
} from "./book-fixture";

before(startBookFixture);
after(stopBookFixture);

async function frozenEntry(
  existing?: Awaited<ReturnType<typeof joinedProject>>,
  withPhoto = false,
) {
  const p = await readyStory(existing);
  const photos = withPhoto ? await storyPhoto(p, "纸书中保留的照片") : null;
  const story = data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/stories/${p.story.id}/revisions`,
      p.narrator.token,
      {
        baseRevisionId: p.story.revision.id,
        expectedVersion: p.story.version,
        title: "书中固定的私人故事",
        photoSnapshotId: photos?.id ?? null,
        theme: p.story.revision.theme,
        paragraphs: p.story.revision.paragraphs,
        reviewResolutions: p.story.revision.reviewItems.map((item: string) => ({
          item,
          reason: "本人核对",
        })),
        notes: [],
      },
    ),
  );
  const base = `/v1/projects/${p.projectId}/book`;
  const context = data(await request("GET", base, p.narrator.token), 200);
  const book = data(
    await request("POST", base + "/versions", p.narrator.token, {
      expectedInputHash: context.inputHash,
    }),
    202,
  );
  const item = book.snapshot.chapters[0].stories[0];
  return { ...p, story, book, item, entry: `/v1/book-audio/${item.entry.id}` };
}

test("a stable book entry resolves its exact ordered original clips only to the narrator and authorized initiator", async () => {
  const p = await frozenEntry();
  const response = await request("GET", p.entry, p.narrator.token);
  assert.equal(
    response.json().meta?.requestId,
    response.headers["x-request-id"],
  );
  const view = data(response, 200);
  assert.equal(view.id, p.item.entry.id);
  assert.equal(view.projectId, p.projectId);
  assert.deepEqual(view.story, {
    id: p.story.id,
    revisionId: p.story.revision.id,
    version: p.story.version,
    title: "书中固定的私人故事",
  });
  assert.deepEqual(
    view.clips.map((c: any) => [c.clipId, c.assetId, c.sequence]),
    p.item.audio.map((c: any) => [c.clipId, c.assetId, c.sequence]),
  );
  assert.equal(view.clips.length, 2);
  assert.equal(
    view.clips[0].sha256,
    createHash("sha256").update(syntheticAudio()).digest("hex"),
  );
  assert.equal(view.clips[0].bytes, syntheticAudio().length);
  assert.ok(view.clips[0].durationMs > 0);
  assert.equal(
    data(await request("GET", p.entry, p.buyer.token), 200).story.title,
    view.story.title,
  );
  for (const token of [undefined, (await login()).token]) {
    const denied = await request("GET", p.entry, token);
    assert.equal(denied.statusCode, token ? 403 : 401);
    assert.ok(!denied.body.includes("书中固定的私人故事"));
    assert.equal(denied.json().data, undefined);
  }
  assert.equal(
    (
      await request(
        "GET",
        "/v1/book-audio/AAAAAAAAAAAAAAAAAAAAAA",
        p.narrator.token,
      )
    ).statusCode,
    404,
  );
});

test("entry audio uses the private Media gateway, exact clip membership and a current epoch for full and Range reads", async () => {
  const p = await frozenEntry(),
    view = data(await request("GET", p.entry, p.buyer.token), 200);
  const clip = view.clips[0],
    url = `${p.entry}/clips/${clip.clipId}/content?epoch=${view.accessEpoch}`;
  const full = await request("GET", url, p.buyer.token);
  assert.equal(full.statusCode, 200, full.body);
  assert.deepEqual(full.rawPayload, syntheticAudio());
  assert.equal(full.headers.location, undefined);
  assert.equal(full.headers["cache-control"], "private, no-store");
  assert.equal(full.headers["content-type"], "audio/mpeg");
  const range = await app.inject({
    method: "GET",
    url,
    headers: { authorization: `Bearer ${p.buyer.token}`, range: "bytes=7-19" },
  });
  assert.equal(range.statusCode, 206, range.body);
  assert.deepEqual(range.rawPayload, syntheticAudio().subarray(7, 20));
  assert.equal(
    range.headers["content-range"],
    `bytes 7-19/${syntheticAudio().length}`,
  );
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url,
        headers: {
          authorization: `Bearer ${p.buyer.token}`,
          range: "bytes=999999-",
        },
      })
    ).statusCode,
    416,
  );
  assert.equal(
    (
      await request(
        "GET",
        `${p.entry}/clips/${clip.clipId}/content`,
        p.buyer.token,
      )
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await request(
        "GET",
        `${p.entry}/clips/${clip.clipId}/content?epoch=${view.accessEpoch + 1}`,
        p.buyer.token,
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await request(
        "GET",
        `${p.entry}/clips/${randomUUID()}/content?epoch=${view.accessEpoch}`,
        p.buyer.token,
      )
    ).statusCode,
    404,
  );
  assert.equal((await request("GET", url)).statusCode, 401);
  assert.equal(
    (await request("GET", url, (await login()).token)).statusCode,
    403,
  );
});

const audioUrl = (
  p: { entry: string },
  view: any,
  clipId = view.clips[0].clipId,
) => `${p.entry}/clips/${clipId}/content?epoch=${view.accessEpoch}`;

test("original audio and Range playback remain available beyond 2099 with a current security session", async (t) => {
  const p = await frozenEntry();
  await db.session.updateMany({
    where: { userId: p.narrator.id },
    data: { expiresAt: new Date("2200-01-01T00:00:00Z") },
  });
  t.mock.timers.enable({
    apis: ["Date"],
    now: Date.parse("2100-01-01T00:00:00Z"),
  });
  try {
    const view = data(await request("GET", p.entry, p.narrator.token), 200);
    assert.equal(view.accessExpiresAt, null);
    const range = await app.inject({
      method: "GET",
      url: audioUrl(p, view),
      headers: {
        authorization: `Bearer ${p.narrator.token}`,
        range: "bytes=0-9",
      },
    });
    assert.equal(range.statusCode, 206);
    assert.equal(range.rawPayload.length, 10);
  } finally {
    t.mock.timers.reset();
  }
});

test("online story edits and a newer book never retarget the historical entry, photo or original title", async () => {
  const p = await frozenEntry(undefined, true),
    original = data(await request("GET", p.entry, p.narrator.token), 200);
  assert.deepEqual(original.photo, p.item.photos[0]);
  const edited = data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/stories/${p.story.id}/revisions`,
      p.narrator.token,
      {
        baseRevisionId: p.story.revision.id,
        expectedVersion: p.story.version,
        title: "在线改稿的新标题",
        photoSnapshotId: null,
        theme: p.story.revision.theme,
        paragraphs: p.story.revision.paragraphs,
        reviewResolutions: p.story.revision.reviewResolutions,
        notes: [],
      },
    ),
  );

  const base = `/v1/projects/${p.projectId}/book`,
    context = data(await request("GET", base, p.narrator.token), 200);
  assert.equal(context.current.state, "obsolete");
  const newer = data(
    await request("POST", base + "/versions", p.narrator.token, {
      expectedInputHash: context.inputHash,
    }),
    202,
  );
  assert.notEqual(
    newer.snapshot.chapters[0].stories[0].entry.id,
    p.item.entry.id,
  );
  assert.deepEqual(
    data(await request("GET", p.entry, p.narrator.token), 200),
    original,
  );
  await restartBookApplication();
  assert.deepEqual(
    data(await request("GET", p.entry, p.narrator.token), 200),
    original,
  );
  assert.deepEqual(
    (await request("GET", audioUrl(p, original), p.narrator.token)).rawPayload,
    syntheticAudio(),
  );
});
