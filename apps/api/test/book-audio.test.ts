import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { readFileSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { paymentAdmin } from "./payment-admin-fixture";
import { randomUUID, createHash } from "node:crypto";
import {
  startBookFixture,
  stopBookFixture,
  app,
  config,
  db,
  root,
  readyStory,
  request,
  data,
  login,
  choose,
  syntheticAudio,
  bound,
  restartBookApplication,
  interceptBookObjectRead,
  state,
} from "./book-fixture";

before(startBookFixture);
after(stopBookFixture);

async function frozenEntry(existing?: Awaited<ReturnType<typeof bound>>) {
  const p = await readyStory(existing);
  const story = data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/stories/${p.story.id}/revisions`,
      p.narrator.token,
      {
        baseRevisionId: p.story.revision.id,
        expectedVersion: p.story.version,
        title: "书中固定的私人故事",
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
  data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/stories/${story.id}/decisions`,
      p.narrator.token,
      {
        revisionId: story.revision.id,
        expectedVersion: story.version,
        contentHash: story.revision.contentHash,
        confirmed: true,
        allowInBook: true,
        noticeVersion: "synthetic-d08-v1",
        evidenceRef: `synthetic:本人确认-${randomUUID()}`,
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

test("online story edits and a newer book never retarget the historical entry or replace its original title", async () => {
  const p = await frozenEntry(),
    original = data(await request("GET", p.entry, p.narrator.token), 200);
  const edited = data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/stories/${p.story.id}/revisions`,
      p.narrator.token,
      {
        baseRevisionId: p.story.revision.id,
        expectedVersion: p.story.version,
        title: "在线改稿的新标题",
        theme: p.story.revision.theme,
        paragraphs: p.story.revision.paragraphs,
        reviewResolutions: p.story.revision.reviewResolutions,
        notes: [],
      },
    ),
  );
  data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/stories/${p.story.id}/decisions`,
      p.narrator.token,
      {
        revisionId: edited.revision.id,
        expectedVersion: edited.version,
        contentHash: edited.revision.contentHash,
        confirmed: true,
        allowInBook: true,
        noticeVersion: "synthetic-d08-v1",
        evidenceRef: `synthetic:新版确认-${randomUUID()}`,
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

test("current sharing withdrawal stops metadata and Range reads, and stale epochs remain denied after renewed consent", async () => {
  const p = await frozenEntry(),
    before = data(await request("GET", p.entry, p.buyer.token), 200);
  data((await choose(p, p.narrator.token, "sharing", false)).response);
  assert.equal((await request("GET", p.entry, p.buyer.token)).statusCode, 403);
  const stale = audioUrl(p, before);
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: stale,
        headers: {
          authorization: `Bearer ${p.buyer.token}`,
          range: "bytes=0-9",
        },
      })
    ).statusCode,
    403,
  );
  // Narrator still has current collection access; the printed locator is not an access grant.
  const narrator = data(await request("GET", p.entry, p.narrator.token), 200);
  assert.ok(narrator.accessEpoch > before.accessEpoch);
  data((await choose(p, p.narrator.token, "sharing", true)).response);
  const after = data(await request("GET", p.entry, p.buyer.token), 200);
  assert.equal((await request("GET", stale, p.buyer.token)).statusCode, 403);
  assert.equal(
    (await request("GET", audioUrl(p, after), p.buyer.token)).statusCode,
    200,
  );
  data((await choose(p, p.narrator.token, "collection", false)).response);
  assert.equal(
    (await request("GET", p.entry, p.narrator.token)).statusCode,
    403,
  );
  assert.equal(
    (await request("GET", audioUrl(p, after), p.buyer.token)).statusCode,
    403,
  );
});

test("withdrawal of the exact historical story permission and deleted recording data stop the stable entry", async () => {
  const p = await frozenEntry(),
    view = data(await request("GET", p.entry, p.narrator.token), 200);
  data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/stories/${p.story.id}/decisions`,
      p.narrator.token,
      {
        revisionId: p.story.revision.id,
        expectedVersion: p.story.version,
        contentHash: p.story.revision.contentHash,
        confirmed: true,
        allowInBook: false,
        noticeVersion: "synthetic-d08-v1",
        evidenceRef: `synthetic:撤回入书-${randomUUID()}`,
      },
    ),
  );
  assert.equal(
    (await request("GET", p.entry, p.narrator.token)).statusCode,
    403,
  );
  assert.equal(
    (await request("GET", audioUrl(p, view), p.narrator.token)).statusCode,
    403,
  );
  const other = await frozenEntry(),
    available = data(
      await request("GET", other.entry, other.narrator.token),
      200,
    );
  const clip = await db.recordingClip.findUniqueOrThrow({
    where: { id: available.clips[0].clipId },
  });
  const object = join(root, "objects", "sealed", `${clip.intentId}.mp3`);
  await rm(object);
  const missing = await request(
    "GET",
    audioUrl(other, available),
    other.narrator.token,
  );
  assert.equal(missing.statusCode, 404, missing.body);
  assert.ok(!missing.body.includes("书中固定的私人故事"));
  await writeFile(object, syntheticAudio());
  const current = await state(other, other.narrator.token);
  const care = data(
    await request(
      "POST",
      `/v1/projects/${other.projectId}/care-requests`,
      other.narrator.token,
      { kind: "delete", expectedBindingVersion: current.bindingVersion },
    ),
  );
  const headers = await paymentAdmin(config, app, ["care:write", "audit:read"]);
  data(
    await app.inject({
      method: "POST",
      url: `/v1/admin/care-requests/${care.id}/verify`,
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: {
        expectedBindingVersion: current.bindingVersion,
        expectedAccessEpoch: current.accessEpoch,
        noticeVersion: "synthetic-d08-v1",
        evidenceRef: "synthetic:原声入口删除核验",
      },
    }),
  );
  assert.equal(
    (await db.bookAudioEntry.findUniqueOrThrow({ where: { id: available.id } }))
      .audio,
    null,
  );
  assert.equal(
    (await request("GET", other.entry, other.narrator.token)).statusCode,
    403,
  );
  assert.equal(
    (await request("GET", audioUrl(other, available), other.narrator.token))
      .statusCode,
    403,
  );
});

async function packageWithDurations(values: {
  playback: number;
  audio: number;
  pdf: number;
  stories: number;
}) {
  const snapshot = JSON.parse(
    readFileSync("test/fixtures/catalog-synthetic.json", "utf8"),
  );
  snapshot.admission.d02.duration.value = 1;
  snapshot.admission.d03.onlinePlayback.duration.value = values.playback;
  snapshot.admission.d03.retention.originalAudio.duration.value = values.audio;
  snapshot.admission.d03.retention.bookPdf.duration.value = values.pdf;
  snapshot.admission.d03.retention.confirmedStories.duration.value =
    values.stories;
  const draftId = randomUUID(),
    versionId = randomUUID();
  await db.packageDraft.create({
    data: { id: draftId, realm: "local", ...snapshot },
  });
  await db.packageVersion.create({
    data: {
      id: versionId,
      realm: "local",
      purpose: "local_preview",
      draftId,
      draftRevision: 1,
      snapshot,
      publicOffer: {
        title: "合成独立回听期限套餐",
        price: { value: 99900, unit: "fen", currency: "CNY" },
      },
    },
  });
  return versionId;
}

test("old sale playback lasts independently of production, PDF and story retention, then blocks exactly at its own deadline including Range", async (t) => {
  const versionId = await packageWithDurations({
    playback: 365,
    audio: 400,
    pdf: 1,
    stories: 1,
  });
  const p = await frozenEntry(await bound(versionId)),
    expiresAt = Date.now() + 60000;
  // Controlled historical delivery fixture; real delivery facts remain T23.
  const deliveredAt = new Date(expiresAt - 365 * 86400000);
  await db.projectServiceEvent.create({
    data: {
      projectId: p.projectId,
      eventId: `synthetic-delivery:${randomUUID()}`,
      kind: "delivery_completed",
      occurredAt: deliveredAt,
    },
  });
  const before = data(await request("GET", p.entry, p.narrator.token), 200);
  assert.equal(before.accessExpiresAt, new Date(expiresAt).toISOString());
  assert.equal(
    (await request("GET", `/v1/projects/${p.projectId}/book`, p.narrator.token))
      .statusCode,
    403,
  );
  // A later available offer uses a different playback period; the old sale stays fixed.
  await packageWithDurations({
    playback: 1,
    audio: 400,
    pdf: 400,
    stories: 400,
  });
  for (const offset of [-1, 0, 1]) {
    t.mock.timers.enable({ apis: ["Date"], now: expiresAt + offset });
    try {
      const expected = offset < 0 ? 200 : 403;
      assert.equal(
        (await request("GET", p.entry, p.narrator.token)).statusCode,
        expected,
      );
      assert.equal(
        (await request("GET", audioUrl(p, before), p.narrator.token))
          .statusCode,
        expected,
      );
      const range = await app.inject({
        method: "GET",
        url: audioUrl(p, before),
        headers: {
          authorization: `Bearer ${p.narrator.token}`,
          range: "bytes=0-9",
        },
      });
      assert.equal(range.statusCode, offset < 0 ? 206 : 403);
      if (offset >= 0) assert.ok(!/deleted|已删除/.test(range.body));
    } finally {
      t.mock.timers.reset();
    }
  }
});

test("original-audio retention can end earlier than the online playback contract", async (t) => {
  const p = await frozenEntry(
    await bound(
      await packageWithDurations({
        playback: 365,
        audio: 1,
        pdf: 400,
        stories: 400,
      }),
    ),
  );
  const expiresAt = Date.now() + 60000;
  await db.projectServiceEvent.create({
    data: {
      projectId: p.projectId,
      eventId: `synthetic-delivery:${randomUUID()}`,
      kind: "delivery_completed",
      occurredAt: new Date(expiresAt - 86400000),
    },
  });
  const before = data(await request("GET", p.entry, p.narrator.token), 200);
  assert.equal(before.accessExpiresAt, new Date(expiresAt).toISOString());
  t.mock.timers.enable({ apis: ["Date"], now: expiresAt });
  try {
    assert.equal(
      (await request("GET", p.entry, p.narrator.token)).statusCode,
      403,
    );
    assert.equal(
      (await request("GET", audioUrl(p, before), p.narrator.token)).statusCode,
      403,
    );
  } finally {
    t.mock.timers.reset();
  }
});

test("rebinding the narrator immediately denies the old account and stale epoch while preserving the fixed original entry", async () => {
  const p = await frozenEntry(),
    original = data(await request("GET", p.entry, p.narrator.token), 200),
    replacement = await login();
  const current = await state(p, p.narrator.token);
  const care = data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/care-requests`,
      p.narrator.token,
      {
        kind: "rebind",
        targetUserId: replacement.id,
        expectedBindingVersion: current.bindingVersion,
      },
    ),
  );
  const admin = await paymentAdmin(config, app, ["care:write"]);
  data(
    await app.inject({
      method: "POST",
      url: `/v1/admin/projects/${p.projectId}/rebind`,
      headers: { ...admin, "idempotency-key": randomUUID() },
      payload: {
        supportCaseRef: care.supportCaseRef,
        targetUserId: replacement.id,
        expectedBindingVersion: current.bindingVersion,
        noticeVersion: "synthetic-d08-v1",
        evidenceRef: `synthetic:核验换绑-${randomUUID()}`,
      },
    }),
  );
  assert.equal(
    (await request("GET", p.entry, p.narrator.token)).statusCode,
    403,
  );
  assert.equal(
    (await request("GET", audioUrl(p, original), p.narrator.token)).statusCode,
    403,
  );
  assert.equal((await request("GET", p.entry, p.buyer.token)).statusCode, 403);
  data((await choose(p, replacement.token, "collection", true)).response);
  const rebound = data(await request("GET", p.entry, replacement.token), 200);
  assert.deepEqual(rebound.story, original.story);
  assert.deepEqual(rebound.clips, original.clips);
  assert.ok(rebound.accessEpoch > original.accessEpoch);
  assert.equal(
    (await request("GET", audioUrl(p, original), replacement.token)).statusCode,
    403,
  );
  assert.equal(
    (await request("GET", audioUrl(p, rebound), replacement.token)).statusCode,
    200,
  );
});

test("slow private storage reads cannot outlive sharing, session, independent playback deadline or storage configuration", async (t) => {
  for (const change of ["sharing", "session", "deadline", "scope"] as const) {
    await t.test(change, async () => {
      const p = await frozenEntry();
      const expiresAt = Date.now() + 60000;
      if (change === "deadline")
        await db.projectServiceEvent.create({
          data: {
            projectId: p.projectId,
            eventId: `synthetic-delivery:${randomUUID()}`,
            kind: "delivery_completed",
            occurredAt: new Date(expiresAt - 365 * 86400000),
          },
        });
      const before = data(await request("GET", p.entry, p.buyer.token), 200);
      const clip = await db.recordingClip.findUniqueOrThrow({
        where: { id: before.clips[0].clipId },
      });
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>((resolve) => {
          enter = resolve;
        }),
        wait = new Promise<void>((resolve) => {
          release = resolve;
        });
      const key = `sealed/${clip.intentId}.mp3`;
      interceptBookObjectRead(async (objectKey) => {
        if (objectKey === key) {
          enter();
          await wait;
        }
      });
      const deadline = setTimeout(() => release(), 15000);
      const downloading = request("GET", audioUrl(p, before), p.buyer.token);
      const originalRoot = config.recording!.storageRoot;
      try {
        await Promise.race([
          entered,
          new Promise<never>((_resolve, reject) => {
            const timer = setTimeout(
              () => reject(Error("storage read did not start")),
              10000,
            );
            timer.unref();
          }),
        ]);
        if (change === "sharing")
          data((await choose(p, p.narrator.token, "sharing", false)).response);
        if (change === "session") {
          const revoked = await app.inject({
            method: "DELETE",
            url: `/v1/sessions/${p.buyer.sessionId}`,
            headers: { authorization: `Bearer ${p.buyer.token}` },
          });
          assert.equal(revoked.statusCode, 204, revoked.body);
        }
        if (change === "deadline")
          t.mock.timers.enable({ apis: ["Date"], now: expiresAt });
        if (change === "scope")
          config.recording!.storageRoot = originalRoot + "-changed";
        release();
        const result = await downloading;
        assert.equal(
          result.statusCode,
          change === "session" ? 401 : 403,
          result.body,
        );
        assert.equal(result.headers.location, undefined);
        assert.ok(!result.body.includes("书中固定的私人故事"));
      } finally {
        release();
        clearTimeout(deadline);
        interceptBookObjectRead();
        config.recording!.storageRoot = originalRoot;
        if (change === "deadline") t.mock.timers.reset();
        await downloading;
      }
    });
  }
});
