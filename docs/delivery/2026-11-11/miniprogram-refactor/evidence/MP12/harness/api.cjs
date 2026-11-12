// Loopback-only MP08/10/11 native acceptance fixture. Business state is created
// through real API commands and ProductionTasks; only external providers are fixtures.
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { mkdirSync, writeFileSync, unlinkSync, chmodSync } = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const root = path.resolve(process.env.TIMENOOK_REPO || process.cwd());
const port = Number(process.env.TIMENOOK_MP12_PORT || 3428);
const output = path.join(root, "test-results/mp12-native/fixture.json");
const f = require(root + "/apps/api/dist-test/test/book-fixture.js");
const fc = require(root + "/apps/api/dist-test/test/first-copy-fixture.js");
const { paymentAdmin } = require(
  root + "/apps/api/dist-test/test/payment-admin-fixture.js",
);
const { ProductionTasks } = require(
  root + "/apps/api/dist-test/src/tasks/tasks.js",
);
const projects = [];
const heldTasks = new Set();
let closing = false,
  worker,
  work = Promise.resolve(),
  started = false,
  published = false;

async function cleanup(code = 0) {
  if (closing) return;
  closing = true;
  clearInterval(worker);
  await work.catch(() => {});
  if (started) await f.stopBookFixture();
  if (published) {
    try {
      unlinkSync(output);
    } catch {}
  }
  process.exit(code);
}
process.on("SIGINT", () => void cleanup());
process.on("SIGTERM", () => void cleanup());
const read = (p, suffix) =>
  f
    .request("GET", `/v1/projects/${p.projectId}${suffix}`, p.narrator.token)
    .then((r) => f.data(r, 200));
const post = (p, suffix, body, status = 201) =>
  f
    .request(
      "POST",
      `/v1/projects/${p.projectId}${suffix}`,
      p.narrator.token,
      body,
    )
    .then((r) => f.data(r, status));
const run = (id) => f.app.get(ProductionTasks).run(id);
const pause = () => new Promise((resolve) => setTimeout(resolve, 1100));
function register(p) {
  projects.push(p);
  return p;
}
function scene(p, extra = {}) {
  return {
    projectId: p.projectId,
    actorCode: p.narrator.who,
    buyerCode: p.buyer.who,
    paths: {
      home: `pages/home/index?projectId=${p.projectId}`,
      stories: `pages/stories/index?projectId=${p.projectId}`,
      book: `pages/book/index?projectId=${p.projectId}`,
      address: `pages/address/index?projectId=${p.projectId}`,
      print: `pages/print/index?projectId=${p.projectId}`,
      production: `pages/production/index?projectId=${p.projectId}`,
    },
    ...extra,
  };
}
function storyScene(p, story) {
  return {
    storyId: story.id,
    interviewId: story.interviewId,
    path: `pages/story/index?projectId=${p.projectId}&storyId=${story.id}`,
    editPath: `pages/edit-story/index?projectId=${p.projectId}&storyId=${story.id}`,
    assignPath: `pages/assign-story/index?projectId=${p.projectId}&storyId=${story.id}`,
    state: story.task?.state,
    chapterKey: story.chapter?.key ?? null,
  };
}
async function cover(
  p,
  {
    title = "爸爸的时光故事",
    salutation = "把走过的时光，留给家人",
    photoId,
  } = {},
) {
  const [book, overview] = await Promise.all([
    read(p, "/book"),
    read(p, "/overview"),
  ]);
  return post(p, "/book/cover", {
    expectedVersion: book.cover.version,
    expectedMetadataVersion: overview.metadataVersion,
    title,
    salutation,
    photoAssetId: photoId
      ? book.coverPhotoOptions.find((photo) => photo.id === photoId).assetId
      : book.cover.photoAssetId,
  });
}
async function generate(p) {
  const book = await read(p, "/book");
  const queued = await post(
    p,
    "/book/versions",
    { expectedInputHash: book.inputHash },
    202,
  );
  await run(queued.task.id);
  return read(p, `/book/versions/${queued.id}`);
}
async function revise(p, title, photoSnapshotId) {
  const current = await read(p, `/stories/${p.story.id}`);
  return post(p, `/stories/${current.id}/revisions`, {
    baseRevisionId: current.revision.id,
    expectedVersion: current.version,
    title,
    theme: current.revision.theme,
    paragraphs: current.revision.paragraphs,
    photoSnapshotId: photoSnapshotId ?? current.revision.photoSnapshotId,
    reviewResolutions: current.revision.reviewItems.map((item) => ({
      item,
      reason: "合成验收核对",
    })),
    notes: [],
  });
}
async function pendingStory(p) {
  const interview = await f.interview(p, true, {
    starterKind: "free-narration",
  });
  await f.sealedClip(p, interview.id);
  for (const task of await read(p, "/tasks")) {
    if (task.kind !== "transcribe_audio") continue;
    await run(task.id);
    await run(task.id);
  }
  const context = await post(p, "/stories/context", {
    interviewId: interview.id,
  });
  await pause();
  return read(p, `/stories/${context.story.id}`);
}
async function verifyPdf(p, book, minimumClipDurationMs = 0) {
  assert.equal(book.state, "ready");
  const response = await f.request(
    "GET",
    `/v1/projects/${p.projectId}/book/versions/${book.id}/pdf`,
    p.narrator.token,
  );
  assert.equal(response.statusCode, 200);
  assert.equal(response.rawPayload.subarray(0, 5).toString(), "%PDF-");
  const entry = book.snapshot.chapters.flatMap((ch) => ch.stories)[0].entry.id;
  const audio = f.data(
    await f.request("GET", `/v1/book-audio/${entry}`, p.narrator.token),
    200,
  );
  assert.ok(audio.clips.length > 0);
  assert.ok(
    audio.clips.every((clip) => clip.durationMs >= minimumClipDurationMs),
  );
  return {
    bookVersionId: book.id,
    pdfSha256: book.pdf.sha256,
    audioEntryId: entry,
    readerPath: `pages/manuscript/index?projectId=${p.projectId}&versionId=${book.id}`,
    originalAudioPath: `pages/original-audio/index?entryId=${entry}`,
  };
}
async function main() {
  for (const key of ["DATABASE_URL", "REDIS_URL"])
    assert.ok(
      ["localhost", "127.0.0.1"].includes(new URL(process.env[key]).hostname),
      "Expected loopback services",
    );
  assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535);
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(port, "127.0.0.1", () => probe.close(resolve));
  });
  process.chdir(path.join(root, "apps/api"));
  started = true;
  await f.startBookFixture();
  // A 71-board manual capture lasts longer than the unit fixture's ten-minute
  // provider window. Set the local configuration before any story task exists.
  f.config.generation.deadlineMs = 24 * 60 * 60 * 1000;
  // Enough real media time to exercise native pause and seek controls. These
  // bytes pass the same upload, server duration detection and seal as any clip.
  const playbackAudio = execFileSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=30",
      "-ar",
      "16000",
      "-ac",
      "1",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "32k",
      "-f",
      "mp3",
      "pipe:1",
    ],
    { maxBuffer: 1024 * 1024 },
  );
  const empty = register(await f.joinedProject());
  const active = register(await f.joinedProject());
  await cover(active, { title: "爸爸的时光故事：走过的山河与日常" });
  const ready = await f.readyStory(active, undefined, playbackAudio);
  const photos = await f.storyPhoto(ready, "合成家庭照片", {
    width: 1800,
    height: 1200,
  });
  const readyView = await revise(ready, "我记得的那一年", photos.id);
  const unassigned = await f.readyStory(active, {
    starterKind: "free-narration",
  });
  const unassignedView = await revise(unassigned, "还没有放进章节的故事");
  assert.equal(unassignedView.chapter, null);
  const failed = await pendingStory(active);
  // The existing provider simulator echoes sourceRefs into its response. Giving
  // that simulator an unknown source produces an actually rejected AI output.
  f.interceptBookProvider(async (url, init) => {
    if (!url.includes("deepseek.com")) return;
    const payload = JSON.parse(init.body),
      source = JSON.parse(payload.messages[1].content);
    source.sourceRefs = ["transcript:synthetic-invalid-source"];
    payload.messages[1].content = JSON.stringify(source);
    init.body = JSON.stringify(payload);
  });
  try {
    await run(failed.task.id);
  } finally {
    f.interceptBookProvider();
  }
  const failedView = await read(active, `/stories/${failed.id}`);
  assert.equal(failedView.task.state, "failed");
  const failedTask = (await read(active, "/tasks")).find(
    (task) => task.id === failedView.task.id,
  );
  assert.equal(failedTask.retryable, true);
  const processingView = await pendingStory(active);
  heldTasks.add(processingView.task.id);
  assert.ok(["queued", "waiting_inputs"].includes(processingView.task.state));
  const activePhotos = await read(active, "/photos");
  const stories = scene(active, {
    ready: storyScene(active, readyView),
    unassigned: storyScene(active, unassignedView),
    failed: storyScene(active, failedView),
    processing: storyScene(active, processingView),
    photoIds: activePhotos.photos.map((photo) => photo.id),
  });
  console.log("MP12 story scenes seeded through API commands.");

  const readyBook = register(
    await fc.readyFirstCopyBook({}, undefined, playbackAudio),
  );
  const bookPhotos = await f.storyPhoto(readyBook, "留在纸书里的合成照片", {
    width: 1800,
    height: 1200,
  });
  await revise(readyBook, "那些年，家门前的路", bookPhotos.id);
  const photo = (await read(readyBook, "/photos")).photos[0];
  await cover(readyBook, { photoId: photo.id });
  const currentBook = await generate(readyBook);
  const readyBookScene = scene(
    readyBook,
    await verifyPdf(readyBook, currentBook, 29_000),
  );
  const stale = register(await fc.readyFirstCopyBook());
  const staleBook = await read(stale, `/book/versions/${stale.book.id}`);
  const staleDetails = await verifyPdf(stale, staleBook);
  await cover(stale, {
    title: "修改后的时光故事",
    salutation: "封面已修改，等待重新生成",
  });
  assert.equal((await read(stale, "/book")).current.state, "obsolete");
  const broken = register(await fc.readyFirstCopyBook());
  const brokenPhoto = await f.projectPhoto(broken, {
    width: 1800,
    height: 1200,
  });
  await cover(broken, { photoId: brokenPhoto.id });
  f.interceptBookObjectRead(async () => {
    throw Error("SYNTHETIC_OBJECT_READ_FAILURE");
  });
  let brokenBook;
  try {
    brokenBook = await generate(broken);
  } finally {
    f.interceptBookObjectRead();
  }
  assert.equal(brokenBook.state, "failed");
  console.log("MP12 ready, stale and failed PDF scenes verified.");

  const adminHeaders = await paymentAdmin(f.config, f.app, [
    "fulfillment:write",
    "audit:read",
  ]);
  const admin = async (url, payload) =>
    f.data(
      await f.app.inject({
        method: "POST",
        url,
        headers: { ...adminHeaders, "idempotency-key": randomUUID() },
        payload,
      }),
    );
  const printScenes = {};
  for (const state of [
    "awaiting",
    "production",
    "shipped",
    "delivered",
    "cancelled",
  ]) {
    const p = register(await fc.readyReservedFirstCopy());
    const base = `/v1/admin/fulfillment/${p.order.id}`;
    if (state !== "awaiting") {
      const attempt = await admin(base + "/attempts", {
        ...p.binding,
        supplierRef: "record:synthetic-provider",
        dueAt: new Date(Date.now() + 86400000).toISOString(),
      });
      const attemptBase = `${base}/attempts/${attempt.current.id}`;
      if (state === "cancelled") {
        await admin(attemptBase + "/cancel", {
          evidenceRef: "synthetic:原生验收确认取消",
        });
      } else {
        await admin(attemptBase + "/handoff", {});
        await admin(attemptBase + "/receipt", {
          outcome: "accepted",
          evidenceRef: "synthetic:印厂接单边界",
        });
        if (["shipped", "delivered"].includes(state)) {
          await admin(attemptBase + "/printing", {
            printedAt: new Date().toISOString(),
            evidenceRef: "synthetic:完成印制边界",
          });
          await admin(attemptBase + "/shipping", {
            carrier: "合成物流",
            number: "SYNTHETIC123456",
            shippedAt: new Date().toISOString(),
            evidenceRef: "synthetic:承运接收边界",
          });
        }
        if (state === "delivered")
          await admin(attemptBase + "/delivery", {
            deliveredAt: new Date().toISOString(),
            evidenceRef: "synthetic:签收边界",
          });
      }
    }
    // This is the frozen-production-PDF regression: its manuscript remains the
    // reserved one even when the editable project cover changes afterward.
    if (state === "production") await cover(p, { title: "制作之后修改的封面" });
    const view = await read(p, "/fulfillment");
    assert.equal(
      view.current?.state ?? "awaiting",
      state === "production" ? "in_production" : state,
    );
    printScenes[state] = scene(p, {
      orderId: p.order.id,
      state: view.current?.state ?? "awaiting",
      bookVersionId: p.book.id,
      pdfSha256: p.binding.pdfHash,
      frozenReaderPath: `pages/manuscript/index?projectId=${p.projectId}&production=1`,
    });
  }
  // Permit ordinary user-generated/retried tasks to finish. The explicitly held
  // processing story remains queued for repeatable screenshots; no DB edits.
  let working = false;
  worker = setInterval(() => {
    if (working || closing) return;
    working = true;
    work = (async () => {
      for (const p of projects)
        for (const task of await read(p, "/tasks")) {
          if (
            !heldTasks.has(task.id) &&
            [
              "queued",
              "waiting_inputs",
              "waiting_provider",
              "submitting",
            ].includes(task.state)
          )
            await run(task.id);
        }
    })()
      .catch(() =>
        console.error(
          "MP12 task pump failed; inspect private fixture locally.",
        ),
      )
      .finally(() => {
        working = false;
      });
  }, 1500);
  const fixture = {
    apiBase: `http://127.0.0.1:${port}/v1`,
    pid: process.pid,
    evidenceBoundary:
      "Real local PostgreSQL/Redis/API/tasks/PDF. Synthetic external identity/payment/AI/storage failure and fulfillment evidence; no real money, printer, shipment or device acceptance.",
    empty: scene(empty),
    stories,
    books: {
      ready: readyBookScene,
      stale: scene(stale, staleDetails),
      failed: scene(broken, {
        bookVersionId: brokenBook.id,
        taskId: brokenBook.task.id,
      }),
    },
    print: printScenes,
  };
  await f.app.listen({ host: "127.0.0.1", port });
  mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  chmodSync(path.dirname(output), 0o700);
  writeFileSync(output, JSON.stringify(fixture, null, 2), { mode: 0o600 });
  chmodSync(output, 0o600);
  published = true;
  console.log(
    `MP12 isolated API ready at loopback:${port}; private fixture manifest saved outside Git.`,
  );
}
main().catch(async (error) => {
  // Assertions can contain private API bodies; never print them to shared logs.
  console.error(
    `MP12 fixture setup failed (${error.code || error.name}); details saved privately.`,
  );
  mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(path.dirname(output), "setup-error.log"),
    String(error.stack || error),
    { mode: 0o600 },
  );
  await cleanup(1);
});
