import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";
const base = "https://example.test/timenook/v1";
const projectId = "33333333-3333-4333-8333-333333333333";
const versionId = "44444444-4444-4444-8444-444444444444";
const storyId = "55555555-5555-4555-8555-555555555555";
const login = {
  user: { id: "11111111-1111-4111-8111-111111111111" },
  session: {
    id: "22222222-2222-4222-8222-222222222222",
    token: "a".repeat(43),
    expiresAt: "2099-01-01T00:00:00Z",
  },
};
const bundles = new Map(
  await Promise.all(
    ["book", "manuscript"].map(
      async (name) =>
        [
          name,
          (
            await build({
              entryPoints: [`miniprogram/pages/${name}/index.ts`],
              bundle: true,
              write: false,
              format: "cjs",
              platform: "neutral",
              define: { __TIMENOOK_API_BASE_URL__: JSON.stringify(base) },
            })
          ).outputFiles[0].text,
        ] as const,
    ),
  ),
);
function harness(name = "book") {
  const clock = { now: Date.now() };
  const storage = new Map<string, any>([
    ["timenook.mode.v1", "live"],
    [`timenook.session.v1:${base}`, structuredClone(login)],
  ]);
  const requests: any[] = [],
    downloads: any[] = [],
    opened: any[] = [],
    removed: string[] = [],
    routes: string[] = [],
    timers: { callback: () => void; delay: number }[] = [];
  let page: any;
  runInNewContext(bundles.get(name)!, {
    Date: class extends Date {
      static now() {
        return clock.now;
      }
    },
    setTimeout(callback: () => void, delay: number) {
      timers.push({ callback, delay });
      return timers.length;
    },
    clearTimeout() {},
    Page(value: any) {
      page = value;
      page.setData = (patch: object) => Object.assign(page.data, patch);
    },
    wx: {
      getStorageSync(key: string) {
        assert.notEqual(
          key,
          "timenook.frontend.v1",
          "live never loads demo material",
        );
        return structuredClone(storage.get(key));
      },
      setStorageSync: (key: string, value: any) =>
        storage.set(key, structuredClone(value)),
      removeStorageSync: (key: string) => storage.delete(key),
      request: (r: any) => requests.push(r),
      downloadFile: (d: any) => downloads.push(d),
      openDocument: (o: any) => {
        opened.push(o);
        o.success?.({});
      },
      getFileSystemManager: () => ({
        unlink: (o: any) => {
          removed.push(o.filePath);
          o.success?.({});
        },
        getFileInfo: (o: any) =>
          o.success({ size: 4567, digest: "f".repeat(64) }),
      }),
      navigateTo: ({ url }: any) => routes.push(url),
      reLaunch: ({ url }: any) => routes.push(url),
      showToast() {},
    },
  });
  return {
    page,
    clock,
    storage,
    requests,
    downloads,
    opened,
    removed,
    routes,
    timers,
    respond(index: number, data: any, statusCode = 200) {
      assert.ok(requests[index], "expected HTTP");
      requests[index].success({
        statusCode,
        data:
          statusCode < 400
            ? { data, meta: { requestId: "synthetic" } }
            : {
                error: {
                  code:
                    statusCode === 409
                      ? "VERSION_CONFLICT"
                      : statusCode === 401
                        ? "UNAUTHENTICATED"
                        : "FORBIDDEN",
                },
                meta: { requestId: "synthetic" },
              },
      });
    },
  };
}
function version(state = "ready"): any {
  return {
    id: versionId,
    projectId,
    version: 3,
    state,
    inputHash: "a".repeat(64),
    snapshotHash: "b".repeat(64),
    snapshot: {
      schemaVersion: "t20-v1",
      cover: {
        title: "小路与岁月",
        template: "fixed",
        version: 0,
        salutation: "",
        photo: null,
      },
      plan: { revision: 2, contentHash: "e".repeat(64), content: {} },
      directory: {
        version: 4,
        contentHash: "c".repeat(64),
        chapters: [{ key: "home", title: "故乡", storyRefs: [storyId] }],
      },
      chapters: [
        {
          key: "home",
          title: "故乡",
          stories: [
            {
              id: storyId,
              revisionId: "66666666-6666-4666-8666-666666666666",
              version: 2,
              contentHash: "d".repeat(64),
              title: "门前的小路",
              paragraphs: ["我记得那条小路。".repeat(90), "这是最后一段。"],
              notes: [],
              provenance: {
                origin: "participant",
                label: "根据本人讲述经AI整理，已人工校对",
              },
              photos: [],
              audio: [],
              entry: null,
            },
          ],
        },
      ],
      specification: {
        version: "synthetic-v1",
        widthMm: 148,
        heightMm: 210,
        bleedMm: 0,
        productionReady: false,
        status: "synthetic-unfrozen",
      },
      provenance: {
        version: "synthetic-v1",
        notice: "根据本人讲述经AI整理，人工校对",
      },
    },
    task: {
      id: "77777777-7777-4777-8777-777777777777",
      state: state === "ready" ? "succeeded" : "queued",
      errorCode: null,
    },
    pageCount: state === "ready" ? 7 : null,
    pdf: state === "ready" ? { sha256: "f".repeat(64), bytes: 4567 } : null,
    toc: state === "ready" ? [{ title: "故乡", page: 4 }] : null,
    renderer: null,
    accessExpiresAt: null,
    draftAccess: { allowed: true, expiresAt: null },
    coverPhotoAccess: { allowed: true, expiresAt: null },
  };
}
function context(current: any = version()): any {
  return {
    projectId,
    inputHash: "a".repeat(64),
    cover: { version: 0, salutation: "", photoAssetId: null },
    coverPhotoOptions: [],
    directory: version().snapshot.directory,
    eligibleStories: [
      {
        id: storyId,
        revisionId: "66666666-6666-4666-8666-666666666666",
        version: 2,
        contentHash: "d".repeat(64),
        title: "门前的小路",
      },
    ],
    current,
    accessExpiresAt: null,
    draftAccess: { allowed: true, expiresAt: null },
  };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("a ready live manuscript and Book overview lead to first-copy confirmation for their exact version", async () => {
  for (const name of ["book", "manuscript"]) {
    const h = harness(name);
    h.page.onLoad({ projectId, versionId });
    const show = h.page.onShow();
    h.respond(0, name === "book" ? context() : version());
    await show;
    h.page.print();
    assert.equal(
      h.routes[0],
      `/pages/print/index?projectId=${projectId}&versionId=${versionId}`,
    );
    h.page.onUnload();
  }
});

test("reading a PDF for an assisted book confirmation retains the current purpose identifier on return", async () => {
  const h = harness("manuscript"),
    assistedSessionId = "88888888-8888-4888-8888-888888888888";
  h.page.onLoad({ projectId, versionId, assistedSessionId });
  const show = h.page.onShow();
  h.respond(0, version());
  await show;
  h.page.print();
  assert.equal(
    h.routes[0],
    `/pages/print/index?projectId=${projectId}&versionId=${versionId}&assistedSessionId=${assistedSessionId}`,
  );
  h.page.onUnload();
});

test("source-story retention expiry leaves a ready frozen book reachable and refuses new source edits or generation", async () => {
  const h = harness(),
    retained = context();
  retained.inputHash = null;
  retained.draftAccess = { allowed: false, expiresAt: null };
  retained.current.draftAccess = { allowed: false, expiresAt: null };
  retained.eligibleStories = [];
  retained.coverPhotoOptions = [];
  h.page.onLoad({ projectId });
  const show = h.page.onShow();
  h.respond(0, retained);
  await show;
  assert.equal(h.page.data.version?.id, versionId);
  assert.equal(h.page.data.draftAvailable, false);
  h.page.editDirectory();
  h.page.addChapter();
  h.page.editCover();
  h.page.salutation({ detail: { value: "已到期来源的未授权修改" } });
  await h.page.generate();
  assert.equal(h.page.data.editing, false);
  assert.equal(h.page.data.coverEditing, false);
  assert.equal(h.page.data.draft, null);
  assert.equal(h.page.data.coverDraft, null);
  assert.equal(h.requests.length, 1);
  h.page.manuscript();
  assert.equal(
    h.routes[0],
    `/pages/manuscript/index?projectId=${projectId}&versionId=${versionId}`,
  );
  h.page.onUnload();
});

test("source mutations and failed-book retry stop at their known deadline before the page timer runs", async () => {
  const h = harness(),
    live = context(version("failed"));
  live.draftAccess = {
    allowed: true,
    expiresAt: new Date(h.clock.now + 1000).toISOString(),
  };
  live.current.draftAccess = live.draftAccess;
  h.page.onLoad({ projectId });
  const show = h.page.onShow();
  h.respond(0, live);
  await show;
  h.page.editDirectory();
  h.page.addChapter();
  h.page.editCover();
  h.page.salutation({ detail: { value: "待保存称呼" } });
  h.clock.now += 1000;
  await h.page.saveDirectory();
  await h.page.saveCover();
  await h.page.generate();
  await h.page.retry();
  assert.equal(h.requests.length, 1);
  assert.equal(h.page.data.version.id, versionId);
  assert.equal(h.page.data.version.state, "failed");
  assert.equal(h.page.data.draft, null);
  assert.equal(h.page.data.coverDraft, null);
  h.page.onUnload();
});

test("a manuscript download crossing the source deadline still opens, then book-PDF expiry removes all private content and bytes", async () => {
  const h = harness("manuscript"),
    frozen = version();
  frozen.draftAccess = {
    allowed: true,
    expiresAt: new Date(h.clock.now + 1000).toISOString(),
  };
  frozen.accessExpiresAt = new Date(h.clock.now + 60000).toISOString();
  h.page.onLoad({ projectId, versionId });
  const show = h.page.onShow();
  h.respond(0, frozen);
  await show;
  const opening = h.page.openPdf();
  h.clock.now += 1000;
  h.timers[h.timers.length - 1].callback();
  h.downloads[0].success({
    statusCode: 200,
    tempFilePath: "wxfile://retained-after-source.pdf",
  });
  await opening;
  assert.equal(h.opened.length, 1);
  assert.equal(h.page.data.version.id, versionId);
  assert.ok(!h.removed.includes("wxfile://retained-after-source.pdf"));
  h.clock.now += 59000;
  h.timers[h.timers.length - 1].callback();
  assert.equal(h.page.data.version, null);
  assert.ok(h.removed.includes("wxfile://retained-after-source.pdf"));
});

test("an edit attempted at book-PDF expiry clears the whole private Book before its timer runs", async () => {
  const h = harness(),
    live = context();
  live.accessExpiresAt = new Date(h.clock.now + 1000).toISOString();
  live.current.accessExpiresAt = live.accessExpiresAt;
  live.draftAccess.expiresAt = live.accessExpiresAt;
  live.current.draftAccess.expiresAt = live.accessExpiresAt;
  h.page.onLoad({ projectId });
  const show = h.page.onShow();
  h.respond(0, live);
  await show;
  h.clock.now += 1000;
  h.page.editCover();
  assert.equal(h.page.data.version, null);
  assert.equal(h.page.data.context, null);
  assert.equal(h.requests.length, 1);
});

test("an expired Book cannot navigate into its former private manuscript before its timer runs", async () => {
  const h = harness(),
    live = context();
  live.accessExpiresAt = new Date(h.clock.now + 1000).toISOString();
  live.current.accessExpiresAt = live.accessExpiresAt;
  h.page.onLoad({ projectId });
  const show = h.page.onShow();
  h.respond(0, live);
  await show;
  h.clock.now += 1000;
  h.page.manuscript();
  assert.equal(h.routes.length, 0);
  assert.equal(h.page.data.context, null);
  assert.equal(h.page.data.version, null);
});

test("book overview freezes generation input and shows cover, table of contents, excerpt and real pages from the returned version", async () => {
  const h = harness();
  h.page.onLoad({ projectId });
  const show = h.page.onShow();
  assert.equal(h.requests[0].url, `${base}/projects/${projectId}/book`);
  h.respond(0, context());
  await show;
  assert.equal(h.page.data.version.snapshot.cover.title, "小路与岁月");
  assert.equal(h.page.data.version.pageCount, 7);
  assert.equal(h.page.data.excerpts[0].text, "我记得那条小路。".repeat(20));
  assert.equal(h.page.data.version.toc[0].page, 4);
  h.page.manuscript();
  assert.equal(
    h.routes[0],
    `/pages/manuscript/index?projectId=${projectId}&versionId=${versionId}`,
  );
  h.page.onUnload();
});

test("generation submits the observed input hash with one retry key and refreshes queued work into a ready snapshot", async () => {
  const h = harness();
  h.page.onLoad({ projectId });
  const show = h.page.onShow();
  h.respond(0, context(null));
  await show;
  const first = h.page.generate();
  assert.equal(
    h.requests[1].url,
    `${base}/projects/${projectId}/book/versions`,
  );
  assert.equal(h.requests[1].data.expectedInputHash, "a".repeat(64));
  const key = h.requests[1].header["Idempotency-Key"];
  h.requests[1].fail({ errMsg: "offline" });
  await first;
  const second = h.page.generate();
  assert.equal(h.requests[2].header["Idempotency-Key"], key);
  h.respond(2, version("queued"), 202);
  await second;
  assert.equal(h.page.data.version.state, "queued");
  assert.equal(h.page.data.version.pageCount, null);
  assert.match(h.page.data.stateLabel, /排队/);
  h.timers[h.timers.length - 1].callback();
  await tick();
  h.respond(3, context());
  await tick();
  assert.equal(h.page.data.version.state, "ready");
  assert.equal(h.page.data.version.pageCount, 7);
  h.page.onUnload();
});

test("directory edits rename and reorder actual chapters, move eligible stories and preserve the draft on version conflict", async () => {
  const h = harness();
  h.page.onLoad({ projectId });
  const show = h.page.onShow();
  h.respond(0, context());
  await show;
  h.page.editDirectory();
  h.page.addChapter();
  h.page.chapterTitle({
    currentTarget: { dataset: { chapter: "1" } },
    detail: { value: "走过的地方" },
  });
  h.page.assignStory({
    currentTarget: { dataset: { chapter: "1", id: storyId } },
  });
  assert.equal(h.page.data.draft[0].storyRefs.length, 0);
  assert.equal(h.page.data.draft[1].storyRefs[0], storyId);
  h.page.moveChapter({
    currentTarget: { dataset: { chapter: "1", direction: "-1" } },
  });
  const saving = h.page.saveDirectory();
  assert.equal(h.requests[1].data.expectedVersion, 4);
  assert.equal(h.requests[1].data.chapters[0].title, "走过的地方");
  assert.equal(h.requests[1].data.chapters[0].storyRefs[0], storyId);
  h.respond(1, undefined, 409);
  await saving;
  assert.equal(h.page.data.draft[0].title, "走过的地方");
  assert.equal(h.page.data.dirty, true);
  assert.match(h.page.data.status, /冲突/);
  const saved = h.page.saveDirectory();
  const changed = context(version("obsolete"));
  changed.directory = {
    version: 5,
    contentHash: "e".repeat(64),
    chapters: JSON.parse(JSON.stringify(h.page.data.draft)),
  };
  h.respond(2, changed, 201);
  await saved;
  assert.equal(h.page.data.dirty, false);
  assert.equal(h.page.data.version.state, "obsolete");
  assert.match(h.page.data.stateLabel, /重新生成/);
  h.page.onUnload();
});

test("full manuscript reads one pinned version and opens only its authenticated, hash-verified PDF, then deletes the temporary file on leave", async () => {
  const h = harness("manuscript");
  h.page.onLoad({ projectId, versionId });
  const show = h.page.onShow();
  assert.equal(
    h.requests[0].url,
    `${base}/projects/${projectId}/book/versions/${versionId}`,
  );
  h.respond(0, version());
  await show;
  assert.equal(
    h.page.data.version.snapshot.chapters[0].stories[0].paragraphs[1],
    "这是最后一段。",
  );
  const opening = h.page.openPdf();
  assert.equal(
    h.downloads[0].url,
    `${base}/projects/${projectId}/book/versions/${versionId}/pdf`,
  );
  assert.equal(
    h.downloads[0].header.authorization,
    `Bearer ${login.session.token}`,
  );
  assert.ok(!h.downloads[0].url.includes(login.session.token));
  h.downloads[0].success({
    statusCode: 200,
    tempFilePath: "wxfile://book.pdf",
  });
  await opening;
  assert.equal(h.opened[0].filePath, "wxfile://book.pdf");
  assert.equal(h.opened[0].fileType, "pdf");
  h.page.onHide();
  assert.equal(h.page.data.version, null);
  assert.ok(h.removed.includes("wxfile://book.pdf"));
});

test("a current directory permission denial followed by a denied Book recheck clears the private draft while preserving login and original recordings", async () => {
  const h = harness();
  const originalKey = "private-originals";
  h.storage.set(originalKey, ["wxfile://original.mp3"]);
  h.page.onLoad({ projectId });
  const show = h.page.onShow();
  h.respond(0, context());
  await show;
  h.page.editDirectory();
  h.page.chapterTitle({
    currentTarget: { dataset: { chapter: "0" } },
    detail: { value: "尚未保存的私人章名" },
  });
  const save = h.page.saveDirectory();
  h.respond(1, undefined, 403);
  await tick();
  h.respond(2, undefined, 403);
  await save;
  assert.equal(h.page.data.context, null);
  assert.equal(h.page.data.draft, null);
  assert.equal(h.page.data.version, null);
  assert.deepEqual(h.storage.get(`timenook.session.v1:${base}`), login);
  assert.deepEqual(h.storage.get(originalKey), ["wxfile://original.mp3"]);
  assert.equal(h.removed.length, 0);
  h.page.onUnload();
});

test("a denied source change rechecks Book authorization and retains a valid frozen manuscript when only source retention has expired", async () => {
  const h = harness();
  h.page.onLoad({ projectId });
  const show = h.page.onShow();
  h.respond(0, context());
  await show;
  h.page.editCover();
  h.page.salutation({ detail: { value: "未保存称呼" } });
  const save = h.page.saveCover();
  h.respond(1, undefined, 403);
  await tick();
  assert.equal(h.requests[2]?.url, `${base}/projects/${projectId}/book`);
  const retained = context();
  retained.inputHash = null;
  retained.draftAccess = { allowed: false, expiresAt: null };
  retained.current.draftAccess = { allowed: false, expiresAt: null };
  retained.eligibleStories = [];
  h.respond(2, retained);
  await save;
  assert.equal(h.page.data.version.id, versionId);
  assert.equal(h.page.data.context.inputHash, null);
  assert.equal(h.page.data.coverDraft, null);
  assert.equal(h.page.data.draftAvailable, false);
  assert.equal(h.page.data.busy, false);
  h.page.manuscript();
  assert.equal(h.routes.length, 1);
  h.page.onUnload();
});

test("an account change during PDF download discards the returned bytes and never opens the previous account's manuscript", async () => {
  const h = harness("manuscript");
  h.page.onLoad({ projectId, versionId });
  const show = h.page.onShow();
  h.respond(0, version());
  await show;
  const opening = h.page.openPdf();
  h.storage.set(`timenook.session.v1:${base}`, {
    ...login,
    session: {
      ...login.session,
      id: "99999999-9999-4999-8999-999999999999",
      token: "b".repeat(43),
    },
  });
  h.downloads[0].success({
    statusCode: 200,
    tempFilePath: "wxfile://stale-book.pdf",
  });
  await opening;
  assert.equal(h.opened.length, 0);
  assert.ok(h.removed.includes("wxfile://stale-book.pdf"));
  assert.equal(h.page.data.version, null);
  assert.equal(h.page.data.busy, false);
  h.page.onUnload();
});

test("a late PDF download after leaving the page only removes its temporary file", async () => {
  const h = harness("manuscript");
  h.page.onLoad({ projectId, versionId });
  const show = h.page.onShow();
  h.respond(0, version());
  await show;
  const opening = h.page.openPdf();
  h.page.onHide();
  h.downloads[0].success({
    statusCode: 200,
    tempFilePath: "wxfile://late-book.pdf",
  });
  await opening;
  assert.equal(h.opened.length, 0);
  assert.ok(h.removed.includes("wxfile://late-book.pdf"));
  assert.equal(h.page.data.version, null);
});

test("a download completing at the exact content-access expiry clears the book before any viewer opens", async () => {
  const h = harness("manuscript");
  const frozen = version();
  frozen.accessExpiresAt = new Date(h.clock.now + 5000).toISOString();
  h.page.onLoad({ projectId, versionId });
  const show = h.page.onShow();
  h.respond(0, frozen);
  await show;
  const opening = h.page.openPdf();
  h.clock.now += 5000;
  h.downloads[0].success({
    statusCode: 200,
    tempFilePath: "wxfile://expired-book.pdf",
  });
  await opening;
  assert.equal(h.opened.length, 0);
  assert.ok(h.removed.includes("wxfile://expired-book.pdf"));
  assert.equal(h.page.data.version, null);
  assert.equal(h.page.data.busy, false);
});

test("a failed book retries its existing version and an obsolete manuscript cannot download the old PDF", async () => {
  const h = harness();
  h.page.onLoad({ projectId });
  const show = h.page.onShow();
  h.respond(0, context(version("failed")));
  await show;
  const retry = h.page.retry();
  assert.equal(
    h.requests[1].url,
    `${base}/projects/${projectId}/book/versions/${versionId}/retry`,
  );
  h.respond(1, version("queued"), 202);
  await retry;
  assert.equal(h.page.data.version.id, versionId);
  assert.equal(h.page.data.version.state, "queued");
  h.page.onUnload();
  const old = harness("manuscript");
  old.page.onLoad({ projectId, versionId });
  const reading = old.page.onShow();
  old.respond(0, version("obsolete"));
  await reading;
  await old.page.openPdf();
  assert.equal(old.downloads.length, 0);
  assert.match(old.page.data.status, /重新生成/);
  old.page.onUnload();
});

test("a PDF whose bytes differ from the pinned version hash is removed without opening", async () => {
  const h = harness("manuscript"),
    frozen = version();
  frozen.pdf.sha256 = "e".repeat(64);
  h.page.onLoad({ projectId, versionId });
  const show = h.page.onShow();
  h.respond(0, frozen);
  await show;
  const opening = h.page.openPdf();
  h.downloads[0].success({
    statusCode: 200,
    tempFilePath: "wxfile://wrong-version.pdf",
  });
  await opening;
  assert.equal(h.opened.length, 0);
  assert.ok(h.removed.includes("wxfile://wrong-version.pdf"));
  assert.match(h.page.data.status, /校验失败/);
  assert.equal(h.page.data.version, null);
  h.page.onUnload();
});

test("an already expired private manuscript clears before issuing any PDF download", async () => {
  const h = harness("manuscript"),
    frozen = version();
  frozen.accessExpiresAt = new Date(h.clock.now + 1000).toISOString();
  h.page.onLoad({ projectId, versionId });
  const show = h.page.onShow();
  h.respond(0, frozen);
  await show;
  h.clock.now += 1000;
  const opening = h.page.openPdf();
  assert.equal(h.downloads.length, 0);
  await opening;
  assert.equal(h.page.data.version, null);
  assert.equal(h.page.data.busy, false);
});

const coverPhoto = {
  id: "88888888-8888-4888-8888-888888888888",
  interviewId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  assetId: "99999999-9999-4999-8999-999999999999",
  bytes: 4567,
  sha256: "f".repeat(64),
  caption: "门前那棵树",
  width: 600,
  height: 800,
};
test("an open book removes source choices and unsaved drafts at their own deadline while retaining the frozen book and PDF route", async () => {
  const h = harness(),
    live = context();
  live.accessExpiresAt = new Date(h.clock.now + 60000).toISOString();
  live.current.accessExpiresAt = live.accessExpiresAt;
  live.draftAccess = {
    allowed: true,
    expiresAt: new Date(h.clock.now + 400).toISOString(),
  };
  live.current.draftAccess = live.draftAccess;
  live.coverPhotoOptions = [coverPhoto];
  live.directory = {
    ...live.directory,
    chapters: [
      { key: "unprinted", title: "尚未入书的私人章名", storyRefs: [] },
    ],
  };
  h.page.onLoad({ projectId });
  const show = h.page.onShow();
  h.respond(0, live);
  await show;
  h.page.editDirectory();
  h.page.chapterTitle({
    currentTarget: { dataset: { chapter: "0" } },
    detail: { value: "尚未保存的私人章名" },
  });
  h.page.editCover();
  h.page.salutation({ detail: { value: "尚未保存的私人称呼" } });
  assert.ok(h.timers[h.timers.length - 1].delay <= 400);
  h.clock.now += 400;
  h.timers[h.timers.length - 1].callback();
  assert.equal(h.page.data.version.id, versionId);
  assert.equal(h.page.data.version.snapshot.cover.title, "小路与岁月");
  assert.equal(h.page.data.context.eligibleStories.length, 0);
  assert.equal(h.page.data.context.coverPhotoOptions.length, 0);
  assert.equal(h.page.data.context.inputHash, null);
  assert.equal(h.page.data.context.directory.chapters[0].title, "故乡");
  assert.equal(h.page.data.context.cover.salutation, "");
  assert.equal(h.page.data.draftAvailable, false);
  assert.equal(h.page.data.draft, null);
  assert.equal(h.page.data.coverDraft, null);
  assert.equal(h.page.data.editing, false);
  assert.equal(h.page.data.coverEditing, false);
  await h.page.saveDirectory();
  await h.page.saveCover();
  await h.page.generate();
  assert.equal(h.requests.length, 2);
  h.respond(1, {
    projectId,
    role: "narrator",
    bindingVersion: 1,
    accessEpoch: 1,
    choices: ["collection", "ai", "sharing"].map((purpose) => ({
      purpose,
      granted: true,
    })),
    canRead: true,
  });
  await tick();
  h.page.manuscript();
  assert.equal(h.routes.length, 1);
  h.page.onUnload();
});
test("cover edits save a salutation and one permitted photo with a pinned version, preserve conflict drafts, then obsolete the prior book", async () => {
  const h = harness(),
    input = context();
  input.cover = { version: 2, salutation: "给我的家人", photoAssetId: null };
  input.coverPhotoOptions = [coverPhoto];
  h.page.onLoad({ projectId });
  const show = h.page.onShow();
  h.respond(0, input);
  await show;
  h.page.editCover();
  h.page.salutation({ detail: { value: "写给一路同行的你" } });
  h.page.chooseCoverPhoto({
    currentTarget: { dataset: { assetId: coverPhoto.assetId } },
  });
  const saving = h.page.saveCover();
  assert.equal(h.requests[1].url, `${base}/projects/${projectId}/book/cover`);
  assert.equal(h.requests[1].data.expectedVersion, 2);
  assert.equal(h.requests[1].data.salutation, "写给一路同行的你");
  assert.equal(h.requests[1].data.photoAssetId, coverPhoto.assetId);
  h.respond(1, undefined, 409);
  await saving;
  assert.equal(h.page.data.coverDraft.salutation, "写给一路同行的你");
  assert.equal(h.page.data.coverDirty, true);
  const saved = h.page.saveCover(),
    response = context(version("obsolete"));
  response.cover = {
    version: 3,
    salutation: "写给一路同行的你",
    photoAssetId: coverPhoto.assetId,
  };
  response.coverPhotoOptions = [coverPhoto];
  h.respond(2, response, 201);
  await saved;
  assert.equal(h.page.data.coverDirty, false);
  assert.equal(h.page.data.version.state, "obsolete");
  assert.equal(h.page.data.coverDraftVersion, 3);
  assert.equal(
    h.page.data.version.snapshot.cover.salutation,
    "",
    "old frozen cover does not silently adopt the draft",
  );
  h.page.onUnload();
});

test("book polling never rebases unsaved cover or directory edits onto another participant's newer versions", async () => {
  const h = harness(),
    input = context(version("queued"));
  input.cover.version = 2;
  h.page.onLoad({ projectId });
  const show = h.page.onShow();
  h.respond(0, input);
  await show;
  h.page.chapterTitle({
    currentTarget: { dataset: { chapter: "0" } },
    detail: { value: "我正在编辑的目录" },
  });
  h.page.salutation({ detail: { value: "我正在编辑的称呼" } });
  h.timers[h.timers.length - 1].callback();
  await tick();
  const newer = context(version("queued"));
  newer.directory.version = 5;
  newer.cover = {
    version: 3,
    salutation: "另一位参与人保存的称呼",
    photoAssetId: null,
  };
  h.respond(1, newer);
  await tick();
  h.respond(2, {
    projectId,
    role: "narrator",
    bindingVersion: 1,
    accessEpoch: 1,
    choices: ["collection", "ai", "sharing"].map((purpose) => ({
      purpose,
      granted: true,
    })),
    canRead: true,
  });
  await tick();
  assert.equal(h.page.data.coverDraft.salutation, "我正在编辑的称呼");
  assert.equal(h.page.data.draft[0].title, "我正在编辑的目录");
  const saveDirectory = h.page.saveDirectory();
  assert.equal(h.requests[3].data.expectedVersion, 4);
  h.respond(3, undefined, 409);
  await saveDirectory;
  const saveCover = h.page.saveCover();
  assert.equal(h.requests[4].data.expectedVersion, 2);
  h.respond(4, undefined, 409);
  await saveCover;
  assert.equal(h.page.data.coverDirty, true);
  assert.equal(h.page.data.dirty, true);
  h.page.onUnload();
});

for (const surface of ["book", "manuscript"]) {
  test(`${surface} preserves an authorized ready book after optional cover Media access expires, and the complete PDF remains usable`, async () => {
    const h = harness(surface),
      frozen = version();
    frozen.snapshot.cover.photo = coverPhoto;
    h.page.onLoad({ projectId, versionId });
    const show = h.page.onShow();
    h.respond(0, surface === "book" ? context(frozen) : frozen);
    await tick();
    h.downloads[0].success({
      statusCode: 403,
      tempFilePath: "wxfile://expired-derived-cover.png",
    });
    await tick();
    assert.equal(
      h.requests[1]?.url,
      `${base}/projects/${projectId}/book/versions/${versionId}`,
      "ambiguous Media403 must revalidate the book boundary",
    );
    const retained = version();
    retained.snapshot.cover.photo = coverPhoto;
    retained.coverPhotoAccess = {
      allowed: false,
      expiresAt: new Date(h.clock.now - 1).toISOString(),
    };
    h.respond(1, retained);
    await show;
    assert.equal(h.page.data.version.id, versionId);
    assert.equal(h.page.data.version.state, "ready");
    assert.equal(h.page.data.coverImage, "");
    assert.ok(h.removed.includes("wxfile://expired-derived-cover.png"));
    if (surface === "manuscript") {
      const opening = h.page.openPdf();
      assert.equal(
        h.downloads[1].url,
        `${base}/projects/${projectId}/book/versions/${versionId}/pdf`,
      );
      h.downloads[1].success({
        statusCode: 200,
        tempFilePath: "wxfile://still-authorized.pdf",
      });
      await opening;
      assert.equal(h.opened.length, 1);
    } else {
      h.page.manuscript();
      assert.equal(
        h.routes[0],
        `/pages/manuscript/index?projectId=${projectId}&versionId=${versionId}`,
      );
    }
    h.page.onUnload();
  });
  test(`${surface} clears only the raw cover image at derived-photo expiry while book access remains active`, async () => {
    const h = harness(surface),
      frozen = version();
    frozen.snapshot.cover.photo = coverPhoto;
    frozen.accessExpiresAt = new Date(h.clock.now + 60000).toISOString();
    frozen.coverPhotoAccess = {
      allowed: true,
      expiresAt: new Date(h.clock.now + 1000).toISOString(),
    };
    const value = context(frozen);
    value.accessExpiresAt = frozen.accessExpiresAt;
    h.page.onLoad({ projectId, versionId });
    const show = h.page.onShow();
    h.respond(0, surface === "book" ? value : frozen);
    await tick();
    h.downloads[0].success({
      statusCode: 200,
      tempFilePath: "wxfile://short-lived-cover.png",
    });
    await show;
    h.clock.now += 1000;
    h.timers[h.timers.length - 1].callback();
    assert.equal(h.page.data.coverImage, "");
    assert.equal(h.page.data.version.id, versionId);
    assert.ok(h.removed.includes("wxfile://short-lived-cover.png"));
    h.page.onUnload();
  });
  test(`${surface} skips an expired raw-photo preview while keeping the already authorized complete book`, async () => {
    const h = harness(surface),
      frozen = version();
    frozen.snapshot.cover.photo = coverPhoto;
    frozen.coverPhotoAccess = {
      allowed: false,
      expiresAt: new Date(h.clock.now - 1).toISOString(),
    };
    h.page.onLoad({ projectId, versionId });
    const show = h.page.onShow();
    h.respond(0, surface === "book" ? context(frozen) : frozen);
    await show;
    assert.equal(h.downloads.length, 0);
    assert.equal(h.page.data.version.id, versionId);
    assert.equal(h.page.data.coverImage, "");
    assert.match(h.page.data.coverStatus, /完整 PDF/);
    h.page.onUnload();
  });
  test(`${surface} discards a raw-photo response at its own expiry without expiring the complete book`, async () => {
    const h = harness(surface),
      frozen = version();
    frozen.snapshot.cover.photo = coverPhoto;
    frozen.coverPhotoAccess = {
      allowed: true,
      expiresAt: new Date(h.clock.now + 1000).toISOString(),
    };
    h.page.onLoad({ projectId, versionId });
    const show = h.page.onShow();
    h.respond(0, surface === "book" ? context(frozen) : frozen);
    await tick();
    h.clock.now += 1000;
    h.timers[h.timers.length - 1].callback();
    assert.equal(h.page.data.version.id, versionId);
    h.downloads[0].success({
      statusCode: 200,
      tempFilePath: "wxfile://late-derived-photo.png",
    });
    await show;
    assert.ok(h.removed.includes("wxfile://late-derived-photo.png"));
    assert.equal(h.page.data.version.id, versionId);
    assert.equal(h.page.data.coverImage, "");
    assert.equal(h.page.data.busy, false);
    h.page.onUnload();
  });
  test(`${surface} clears private book state if an unexpected Media403 cannot be reauthorized`, async () => {
    const h = harness(surface),
      frozen = version();
    frozen.snapshot.cover.photo = coverPhoto;
    h.page.onLoad({ projectId, versionId });
    const show = h.page.onShow();
    h.respond(0, surface === "book" ? context(frozen) : frozen);
    await tick();
    h.downloads[0].success({
      statusCode: 403,
      tempFilePath: "wxfile://unverified-cover.png",
    });
    await tick();
    h.requests[1].fail({ errMsg: "offline" });
    await show;
    assert.equal(h.page.data.version, null);
    assert.equal(h.page.data.coverImage, "");
    assert.match(h.page.data.status, /重新核对/);
    assert.ok(h.removed.includes("wxfile://unverified-cover.png"));
    h.page.onUnload();
  });
  test(`${surface} displays only the frozen cover salutation and authenticated exact photo, then removes the temporary preview`, async () => {
    const h = harness(surface),
      frozen = version();
    frozen.snapshot.cover = {
      ...frozen.snapshot.cover,
      version: 2,
      salutation: "写给一路同行的你",
      photo: coverPhoto,
    };
    h.page.onLoad({ projectId, versionId });
    const show = h.page.onShow();
    h.respond(0, surface === "book" ? context(frozen) : frozen);
    await tick();
    assert.equal(
      h.downloads[0]?.url,
      `${base}/projects/${projectId}/interviews/${coverPhoto.interviewId}/photos/${coverPhoto.id}/assets/${coverPhoto.assetId}/content`,
    );
    assert.equal(
      h.downloads[0].header.authorization,
      `Bearer ${login.session.token}`,
    );
    h.downloads[0].success({
      statusCode: 200,
      tempFilePath: "wxfile://cover-photo.png",
    });
    await show;
    assert.equal(
      h.page.data.version.snapshot.cover.salutation,
      "写给一路同行的你",
    );
    assert.equal(h.page.data.coverImage, "wxfile://cover-photo.png");
    h.page.onHide();
    assert.equal(h.page.data.coverImage, "");
    assert.ok(h.removed.includes("wxfile://cover-photo.png"));
  });
  test(`${surface} clears an expired snapshot while its cover image is still downloading and discards the late photo`, async () => {
    const h = harness(surface),
      frozen = version();
    frozen.snapshot.cover.photo = coverPhoto;
    frozen.accessExpiresAt = new Date(h.clock.now + 1000).toISOString();
    const value = context(frozen);
    value.accessExpiresAt = frozen.accessExpiresAt;
    h.page.onLoad({ projectId, versionId });
    const show = h.page.onShow();
    h.respond(0, surface === "book" ? value : frozen);
    await tick();
    assert.ok(
      h.timers.length,
      "private version must be watched while the photo is in flight",
    );
    h.clock.now += 1000;
    h.timers[h.timers.length - 1].callback();
    assert.equal(h.page.data.version, null);
    assert.equal(h.page.data.coverImage, "");
    h.downloads[0].success({
      statusCode: 200,
      tempFilePath: "wxfile://expired-cover.png",
    });
    await show;
    assert.ok(h.removed.includes("wxfile://expired-cover.png"));
    assert.equal(h.page.data.coverImage, "");
  });
  test(`${surface} clears private version data when a denied cover download is followed by a denied Book recheck, without deleting originals`, async () => {
    const h = harness(surface),
      frozen = version();
    frozen.snapshot.cover.photo = coverPhoto;
    h.storage.set("originals", ["wxfile://original.png"]);
    h.page.onLoad({ projectId, versionId });
    const show = h.page.onShow();
    h.respond(0, surface === "book" ? context(frozen) : frozen);
    await tick();
    h.downloads[0].success({
      statusCode: 403,
      tempFilePath: "wxfile://denied-cover.png",
    });
    await tick();
    assert.equal(
      h.requests[1].url,
      `${base}/projects/${projectId}/book/versions/${versionId}`,
    );
    h.respond(1, undefined, 403);
    await show;
    assert.equal(h.page.data.version, null);
    assert.equal(h.page.data.coverImage, "");
    assert.ok(h.removed.includes("wxfile://denied-cover.png"));
    assert.ok(!h.removed.includes("wxfile://original.png"));
    assert.deepEqual(h.storage.get(`timenook.session.v1:${base}`), login);
    assert.deepEqual(h.storage.get("originals"), ["wxfile://original.png"]);
    h.page.onUnload();
  });
  test(`${surface} discards a cover image arriving after the active account changed`, async () => {
    const h = harness(surface),
      frozen = version();
    frozen.snapshot.cover.photo = coverPhoto;
    h.page.onLoad({ projectId, versionId });
    const show = h.page.onShow();
    h.respond(0, surface === "book" ? context(frozen) : frozen);
    await tick();
    h.storage.set(`timenook.session.v1:${base}`, {
      ...login,
      session: {
        ...login.session,
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        token: "b".repeat(43),
      },
    });
    h.downloads[0].success({
      statusCode: 200,
      tempFilePath: "wxfile://old-account-cover.png",
    });
    await show;
    assert.equal(h.page.data.version, null);
    assert.equal(h.page.data.coverImage, "");
    assert.ok(h.removed.includes("wxfile://old-account-cover.png"));
    h.page.onUnload();
  });
}
