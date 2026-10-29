import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";
const base = "https://example.test/timenook/v1",
  project = "33333333-3333-4333-8333-333333333333",
  interview = "44444444-4444-4444-8444-444444444444";
const login = {
  user: { id: "11111111-1111-4111-8111-111111111111" },
  session: {
    id: "22222222-2222-4222-8222-222222222222",
    token: "a".repeat(43),
    expiresAt: "2099-01-01T00:00:00Z",
  },
};
const compiled = await build({
  stdin: {
    contents:
      'import "./miniprogram/pages/interview/index"; import "./miniprogram/pages/photos/index";',
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  write: false,
  format: "cjs",
  platform: "neutral",
  define: { __TIMENOOK_API_BASE_URL__: JSON.stringify(base) },
});
function harness(options: { controlledTimers?: boolean } = {}) {
  const timers: { callback: () => Promise<void> | void; cleared: boolean }[] =
    [];
  let now = Date.now();
  class DeviceDate extends Date {
    static now() {
      return now;
    }
  }
  const storage = new Map<string, unknown>([
      ["timenook.mode.v1", "live"],
      [`timenook.session.v1:${base}`, login],
    ]),
    requests: any[] = [],
    uploads: any[] = [],
    downloads: any[] = [],
    navigations: string[] = [],
    saved: string[] = [],
    removed: string[] = [],
    pages: any[] = [],
    recorderHandlers: Record<string, ((value?: any) => void)[]> = {};
  let page: any,
    failManifest = false,
    failPreview = false,
    failPreviewCleanup = false,
    failSessionRemoval = false,
    chooseOptions: any;
  runInNewContext(compiled.outputFiles[0].text, {
    Date: DeviceDate,
    setTimeout: options.controlledTimers
      ? (callback: () => Promise<void> | void) => {
          const timer = { callback, cleared: false };
          timers.push(timer);
          return timer;
        }
      : setTimeout,
    clearTimeout: options.controlledTimers
      ? (timer: { cleared: boolean }) => {
          if (timer) timer.cleared = true;
        }
      : clearTimeout,
    setInterval,
    clearInterval,
    Page: (v: any) => {
      page = v;
      v.setData = (patch: object) => Object.assign(v.data, patch);
      pages.push(page);
    },
    wx: {
      getStorageSync: (k: string) => structuredClone(storage.get(k)),
      setStorageSync: (k: string, v: unknown) => {
        if (failPreviewCleanup && k.includes("photo-previews")) {
          failPreviewCleanup = false;
          throw Error("cleanup manifest storage full");
        }
        if (
          failPreview &&
          k.includes("photo-previews") &&
          Array.isArray(v) &&
          v.length
        ) {
          failPreview = false;
          throw Error("preview storage full");
        }
        if (failManifest && k.includes("photos")) {
          failManifest = false;
          throw Error("full");
        }
        storage.set(k, structuredClone(v));
      },
      removeStorageSync: (k: string) => {
        if (failSessionRemoval && k.includes("session.v1"))
          throw Error("device session storage unavailable");
        storage.delete(k);
      },
      getAccountInfoSync: () => ({ miniProgram: { appId: "synthetic" } }),
      getRecorderManager: () => ({
        onStart: (f: any) => (recorderHandlers.start ??= []).push(f),
        onStop: (f: any) => (recorderHandlers.stop ??= []).push(f),
        onError: (f: any) => (recorderHandlers.error ??= []).push(f),
        onInterruptionBegin: (f: any) =>
          (recorderHandlers.interrupt ??= []).push(f),
        start: () => recorderHandlers.start?.forEach((f) => f()),
        stop: () =>
          recorderHandlers.stop?.forEach((f) =>
            f({ tempFilePath: "native-audio-temp", duration: 1080 }),
          ),
      }),
      request: (o: any) => requests.push(o),
      uploadFile: (o: any) => {
        uploads.push(o);
        o.success({ statusCode: 204 });
      },
      chooseMedia: (o: any) => {
        chooseOptions = o;
        o.success({
          tempFiles: [{ tempFilePath: "temp-a" }, { tempFilePath: "temp-b" }],
        });
      },
      getFileSystemManager: () => ({
        saveFile: (o: any) => {
          const path = `saved-${saved.length + 1}`;
          saved.push(path);
          o.success({ savedFilePath: path });
        },
        getFileInfo: (o: any) =>
          o.success({
            size: 123,
            digest: (o.filePath.endsWith("1") ? "a" : "b").repeat(64),
          }),
        access: (o: any) => o.success({}),
        unlink: (o: any) => {
          removed.push(o.filePath);
          o.success({});
        },
      }),
      navigateTo: (o: any) => navigations.push(o.url),
      navigateBack: () => {},
      showToast: () => {},
      downloadFile: (o: any) => downloads.push(o),
    },
  });
  return {
    page,
    timers,
    interviewPage: pages[0],
    storage,
    requests,
    uploads,
    downloads,
    navigations,
    saved,
    removed,
    expireSession() {
      now = Date.parse(login.session.expiresAt);
    },
    fail() {
      failManifest = true;
    },
    failPreview() {
      failPreview = true;
    },
    failPreviewCleanup() {
      failPreviewCleanup = true;
    },
    failSessionRemoval() {
      failSessionRemoval = true;
    },
    get chooseOptions() {
      return chooseOptions;
    },
  };
}
function respond(r: any, data: unknown, statusCode = 200) {
  assert.ok(r, "public platform HTTP request");
  r.success({
    statusCode,
    data:
      statusCode < 400
        ? { data, meta: { requestId: "synthetic" } }
        : {
            error: {
              code: statusCode === 401 ? "UNAUTHENTICATED" : "FORBIDDEN",
            },
            meta: { requestId: "synthetic" },
          },
  });
}
const tick = () => new Promise((r) => setImmediate(r));
async function ready(h: ReturnType<typeof harness>, snapshot: unknown = null) {
  h.page.onLoad({ projectId: project, interviewId: interview });
  if (h.page.onShow) {
    const show = h.page.onShow();
    await tick();
    respond(h.requests.shift(), {
      photos: [],
      snapshot,
      usage: { reservedCount: 0, consumedCount: 0 },
    });
    await show;
  }
}
async function choose(h: ReturnType<typeof harness>) {
  const choosing = h.page.choose();
  await tick();
  assert.equal(
    h.requests[0].url,
    `${base}/projects/${project}/interviews/${interview}/collection-check`,
  );
  if (h.requests.length) respond(h.requests.shift(), { allowed: true }, 201);
  await choosing;
}
test("photo page saves each original independently and retries a failed manifest without copying the file again", async () => {
  const h = harness();
  await ready(h);
  h.fail();
  await choose(h);
  assert.equal(h.page.data.photos.length, 2);
  assert.deepEqual(Array.from(h.chooseOptions.sizeType), ["original"]);
  assert.equal(h.saved.length, 2);
  assert.equal(h.page.data.photos[0].state, "save-error");
  assert.equal(h.page.data.photos[1].state, "local");
  await h.page.retrySave({
    currentTarget: { dataset: { id: h.page.data.photos[0].clientPhotoId } },
  });
  assert.equal(h.saved.length, 2);
  assert.equal(h.page.data.photos[0].state, "local");
  h.page.onHide();
  assert.equal(h.page.data.photos.length, 0);
});

const event = (id: string) => ({ currentTarget: { dataset: { id } } });
function remote(local: any, id: string, state = "pending") {
  return {
    id,
    projectId: project,
    interviewId: interview,
    clientPhotoId: local.clientPhotoId,
    bytes: local.bytes,
    sha256: local.sha256,
    state,
    storage: "local-simulator",
    assets:
      state === "sealed"
        ? [{ id: "original" }, { id: "preview" }, { id: "print" }]
        : [],
    lowResolution: true,
  };
}
async function uploading(
  h: ReturnType<typeof harness>,
  local: any,
  id: string,
  fail = false,
  snapshot: any = { id: "material", revision: 1, entries: [] },
) {
  const work = h.page.upload(event(local.clientPhotoId));
  await tick();
  respond(h.requests.shift(), remote(local, id), 201);
  await tick();
  respond(
    h.requests.shift(),
    {
      url: "/v1/photos/objects",
      storage: "local-simulator",
      expiresAt: "2099-01-01T00:00:00Z",
      fields: {
        key: `photos/staging/${id}.bin`,
        policy: "synthetic",
        "x-photo-capability": "synthetic",
      },
    },
    201,
  );
  await tick();
  respond(h.requests.shift(), remote(local, id, "sealed"), fail ? 422 : 201);
  await tick();
  if (!fail && h.requests.length)
    respond(h.requests.shift(), { photos: [], snapshot });
  await work;
}
test("each photo upload fails and retries independently while delayed completion stays in its original partition", async () => {
  const h = harness();
  await ready(h);
  await choose(h);
  const [first, second] = h.page.data.photos;
  await uploading(h, first, "55555555-5555-4555-8555-555555555555", true);
  assert.equal(
    h.page.data.photos.find((p: any) => p.clientPhotoId === first.clientPhotoId)
      .state,
    "failed",
  );
  assert.equal(
    h.page.data.photos.find(
      (p: any) => p.clientPhotoId === second.clientPhotoId,
    ).state,
    "local",
  );
  await uploading(h, second, "66666666-6666-4666-8666-666666666666");
  assert.equal(
    h.page.data.photos.find(
      (p: any) => p.clientPhotoId === second.clientPhotoId,
    ).state,
    "sealed",
  );
  const retry = h.page.upload(event(first.clientPhotoId));
  await tick();
  assert.match(h.requests[0].url, /55555555.*\/status$/);
  h.page.onHide();
  h.page.onLoad({
    projectId: "77777777-7777-4777-8777-777777777777",
    interviewId: interview,
  });
  const show = h.page.onShow();
  await tick();
  respond(h.requests.pop(), { photos: [], snapshot: null });
  await show;
  respond(
    h.requests.shift(),
    remote(first, "55555555-5555-4555-8555-555555555555", "sealed"),
    201,
  );
  await retry;
  assert.equal(h.page.data.photos.length, 0);
  h.page.onHide();
  h.page.onLoad({ projectId: project, interviewId: interview });
  const restored = h.page.onShow();
  await tick();
  respond(h.requests.shift(), { photos: [], snapshot: null });
  await restored;
  assert.equal(h.page.data.photos.length, 2);
  assert.equal(h.saved.length, 2);
  h.page.onUnload();
});

test("photo page describes and reorders the exact material snapshot and clears private data on denied refresh", async () => {
  const h = harness();
  h.page.onLoad({ projectId: project, interviewId: interview });
  const show = h.page.onShow();
  await tick();
  const snapshot = {
    id: "snapshot-one",
    revision: 2,
    entries: [
      {
        photoId: "55555555-5555-4555-8555-555555555555",
        caption: "",
        assets: [],
      },
      {
        photoId: "66666666-6666-4666-8666-666666666666",
        caption: "",
        assets: [],
      },
    ],
  };
  respond(h.requests.shift(), { photos: [], snapshot });
  await show;
  h.page.caption({
    currentTarget: { dataset: { id: snapshot.entries[0].photoId } },
    detail: { value: "旧屋门口" },
  });
  const edited = h.page.saveCaption(event(snapshot.entries[0].photoId));
  assert.equal(h.requests[0].data.expectedRevision, 2);
  assert.equal(h.requests[0].data.entries[0].caption, "旧屋门口");
  respond(
    h.requests.shift(),
    {
      ...snapshot,
      id: "snapshot-two",
      revision: 3,
      entries: [
        { ...snapshot.entries[0], caption: "旧屋门口" },
        snapshot.entries[1],
      ],
    },
    201,
  );
  await edited;
  const moved = h.page.moveUp(event(snapshot.entries[1].photoId));
  assert.equal(h.requests[0].data.expectedRevision, 3);
  assert.equal(
    h.requests[0].data.entries[0].photoId,
    snapshot.entries[1].photoId,
  );
  respond(
    h.requests.shift(),
    {
      ...snapshot,
      id: "snapshot-three",
      revision: 4,
      entries: [snapshot.entries[1], snapshot.entries[0]],
    },
    201,
  );
  await moved;
  const refresh = h.page.onShow();
  await tick();
  respond(h.requests.shift(), undefined, 403);
  await refresh;
  assert.equal(h.page.data.snapshot, null);
  assert.equal(h.page.data.photos.length, 0);
  h.page.onUnload();
});

test("private preview is authenticated and its temporary image is removed on leave or late download", async () => {
  const h = harness();
  h.page.onLoad({ projectId: project, interviewId: interview });
  const show = h.page.onShow();
  await tick();
  const photoId = "55555555-5555-4555-8555-555555555555",
    assetId = "66666666-6666-4666-8666-666666666666";
  respond(h.requests.shift(), {
    photos: [],
    snapshot: {
      id: "material",
      revision: 1,
      entries: [
        {
          photoId,
          caption: "",
          assets: [
            {
              id: assetId,
              kind: "preview",
              bytes: 123,
              sha256: "b".repeat(64),
            },
          ],
        },
      ],
    },
  });
  await show;
  const opening = h.page.preview(event(photoId));
  await tick();
  assert.match(h.downloads[0].url, /assets\/66666666.*\/content$/);
  assert.equal(
    h.downloads[0].header.authorization,
    `Bearer ${login.session.token}`,
  );
  h.downloads
    .shift()
    .success({ statusCode: 200, tempFilePath: "private-preview" });
  await opening;
  assert.equal(h.page.data.previewPath, "private-preview");
  const late = h.page.preview(event(photoId));
  await tick();
  h.page.onHide();
  h.downloads
    .shift()
    .success({ statusCode: 200, tempFilePath: "late-preview" });
  await late;
  assert.equal(h.page.data.previewPath, "");
  assert.ok(h.removed.includes("private-preview"));
  assert.ok(h.removed.includes("late-preview"));
  h.page.onUnload();
});

test("upload completion keeps an unsaved caption on its original snapshot revision and conflict preserves the draft", async () => {
  const h = harness(),
    photoId = "55555555-5555-4555-8555-555555555555",
    snapshot = {
      id: "before",
      revision: 1,
      entries: [{ photoId, caption: "原说明", assets: [] }],
    };
  await ready(h, snapshot);
  await choose(h);
  h.page.caption({
    currentTarget: { dataset: { id: photoId } },
    detail: { value: "没保存的说明" },
  });
  await uploading(
    h,
    h.page.data.photos[0],
    "77777777-7777-4777-8777-777777777777",
    false,
    { ...snapshot, id: "after-upload", revision: 2 },
  );
  assert.equal(h.page.data.snapshot.revision, 1);
  const save = h.page.saveCaption(event(photoId));
  assert.equal(h.requests[0].data.expectedRevision, 1);
  respond(h.requests.shift(), undefined, 409);
  await save;
  assert.equal(h.page.data.captions[photoId], "没保存的说明");
  h.page.onHide();
  assert.equal(Object.keys(h.page.data.captions).length, 0);
});

test("a failed photo can release its reservation without deleting its only local original", async () => {
  const h = harness();
  await ready(h);
  await choose(h);
  const first = h.page.data.photos[0];
  await uploading(h, first, "55555555-5555-4555-8555-555555555555", true);
  const release = h.page.release(event(first.clientPhotoId));
  await tick();
  assert.match(h.requests[0].url, /\/release$/);
  respond(
    h.requests.shift(),
    remote(first, "55555555-5555-4555-8555-555555555555", "released"),
    201,
  );
  await release;
  const released = h.page.data.photos.find(
    (p: any) => p.clientPhotoId === first.clientPhotoId,
  );
  assert.equal(released.released, true);
  assert.equal(released.path, first.path);
  assert.equal(h.removed.includes(first.path), false);
  h.page.onHide();
});

test("a downloaded private image is removed even when its cleanup manifest cannot be written", async () => {
  const h = harness(),
    photoId = "55555555-5555-4555-8555-555555555555",
    assetId = "66666666-6666-4666-8666-666666666666";
  await ready(h, {
    id: "material",
    revision: 1,
    entries: [
      {
        photoId,
        caption: "",
        assets: [
          { id: assetId, kind: "preview", bytes: 123, sha256: "b".repeat(64) },
        ],
      },
    ],
  });
  const opening = h.page.preview(event(photoId));
  await tick();
  h.failPreview();
  h.downloads
    .shift()
    .success({ statusCode: 200, tempFilePath: "undocumented-private-preview" });
  await opening;
  assert.equal(h.page.data.previewPath, "");
  assert.ok(h.removed.includes("undocumented-private-preview"));
  h.page.onHide();
});

test("an old project's delayed forbidden response cannot erase the current project's photo draft", async () => {
  const h = harness();
  await ready(h);
  await choose(h);
  const first = h.page.data.photos[0];
  const pending = h.page.upload(event(first.clientPhotoId));
  await tick();
  const old = h.requests.shift();
  h.page.onHide();
  h.page.onLoad({
    projectId: "77777777-7777-4777-8777-777777777777",
    interviewId: interview,
  });
  const showing = h.page.onShow();
  await tick();
  const photoId = "88888888-8888-4888-8888-888888888888";
  respond(h.requests.shift(), {
    photos: [],
    snapshot: {
      id: "current-material",
      revision: 1,
      entries: [{ photoId, caption: "", assets: [] }],
    },
  });
  await showing;
  h.page.caption({
    currentTarget: { dataset: { id: photoId } },
    detail: { value: "新项目的说明草稿" },
  });
  respond(old, undefined, 403);
  await pending;
  assert.equal(h.page.data.snapshot.id, "current-material");
  assert.equal(h.page.data.captions[photoId], "新项目的说明草稿");
  h.page.onHide();
});

test("an older preview completion removes only its own temporary image and preserves the latest displayed image", async () => {
  const h = harness(),
    photoId = "55555555-5555-4555-8555-555555555555",
    assetId = "66666666-6666-4666-8666-666666666666";
  await ready(h, {
    id: "material",
    revision: 1,
    entries: [
      {
        photoId,
        caption: "",
        assets: [
          { id: assetId, kind: "preview", bytes: 123, sha256: "b".repeat(64) },
        ],
      },
    ],
  });
  const old = h.page.preview(event(photoId));
  await tick();
  const latest = h.page.preview(event(photoId));
  await tick();
  h.downloads[1].success({ statusCode: 200, tempFilePath: "latest-private" });
  await latest;
  h.downloads[0].success({ statusCode: 200, tempFilePath: "old-private" });
  await old;
  assert.equal(h.page.data.previewPath, "latest-private");
  assert.ok(h.removed.includes("old-private"));
  assert.equal(h.removed.includes("latest-private"), false);
  h.page.onHide();
});

test("a delayed material-edit response cannot replace the newer snapshot returned by photo sealing", async () => {
  const h = harness(),
    snapshot = {
      id: "before",
      revision: 2,
      entries: [
        {
          photoId: "55555555-5555-4555-8555-555555555555",
          caption: "",
          assets: [],
        },
        {
          photoId: "66666666-6666-4666-8666-666666666666",
          caption: "",
          assets: [],
        },
      ],
    };
  await ready(h, snapshot);
  await choose(h);
  const edit = h.page.moveUp(event(snapshot.entries[1].photoId)),
    editRequest = h.requests.shift();
  await uploading(
    h,
    h.page.data.photos[0],
    "77777777-7777-4777-8777-777777777777",
    false,
    { ...snapshot, id: "after-seal", revision: 4 },
  );
  assert.equal(h.page.data.snapshot.revision, 4);
  respond(
    editRequest,
    {
      ...snapshot,
      id: "after-edit",
      revision: 3,
      entries: [snapshot.entries[1], snapshot.entries[0]],
    },
    201,
  );
  await edit;
  assert.equal(h.page.data.snapshot.revision, 4);
  h.page.onHide();
});

function reviewMaterial() {
  return {
    id: "private-material",
    revision: 1,
    entries: [
      {
        photoId: "55555555-5555-4555-8555-555555555555",
        caption: "私人照片说明",
        assets: [
          {
            id: "66666666-6666-4666-8666-666666666666",
            kind: "preview",
            bytes: 123,
            sha256: "b".repeat(64),
          },
        ],
      },
    ],
  };
}
async function showInterview(h: ReturnType<typeof harness>) {
  const p = h.interviewPage;
  p.onLoad({ projectId: project });
  const showing = p.onShow();
  respond(h.requests.shift(), {
    canRecord: true,
    interviews: [
      {
        id: interview,
        projectId: project,
        actualQuestion: {
          id: "55555555-5555-4555-8555-555555555555",
          projectId: project,
          answerRef: interview,
          planRevision: 1,
          snapshot: { text: "私人采访问题", intent: "具体场景" },
        },
        questionVersion: 1,
        clips: [
          { id: "77777777-7777-4777-8777-777777777777", state: "sealed" },
        ],
      },
    ],
    plan: {
      revision: 1,
      defaultQuestion: { text: "私人采访问题" },
      starters: [],
    },
  });
  await showing;
  await tick();
  const status = h.requests.shift();
  assert.match(status.url, /\/tasks\/status$/);
  return status;
}
async function leaveInterviewWithStatusPending(h: ReturnType<typeof harness>) {
  const status = await showInterview(h),
    p = h.interviewPage;
  p.photos();
  p.onHide();
  return status;
}
test("the active photo page clears private material when the hidden interview's in-flight 401 crosses local expiresAt", async (t) => {
  const h = harness(),
    snapshot = reviewMaterial(),
    status = await leaveInterviewWithStatusPending(h);
  t.after(() => {
    h.page.onUnload();
    h.interviewPage.onUnload();
  });
  await ready(h, snapshot);
  await choose(h);
  const originals = [...h.saved];
  h.page.caption({
    currentTarget: { dataset: { id: snapshot.entries[0].photoId } },
    detail: { value: "跨页私人草稿" },
  });
  const previewing = h.page.preview(event(snapshot.entries[0].photoId));
  await tick();
  h.downloads
    .shift()
    .success({ statusCode: 200, tempFilePath: "cross-page-private-preview" });
  await previewing;
  h.expireSession();
  respond(status, undefined, 401);
  await tick();
  assert.equal(h.storage.has(`timenook.session.v1:${base}`), false);
  assert.equal(h.page.data.snapshot, null);
  assert.equal(Object.keys(h.page.data.captions).length, 0);
  assert.equal(h.page.data.previewPath, "");
  assert.equal(h.page.data.photos.length, 0);
  assert.ok(h.removed.includes("cross-page-private-preview"));
  assert.ok(originals.every((path) => !h.removed.includes(path)));
  assert.ok(
    [...h.storage.values()].some(
      (value) =>
        Array.isArray(value) &&
        value.some((photo) => originals.includes(photo.path)),
    ),
  );
});
test("the active interview clears private state when a hidden photo download's 401 crosses local expiresAt", async (t) => {
  const h = harness(),
    snapshot = reviewMaterial(),
    status = await leaveInterviewWithStatusPending(h);
  t.after(() => {
    h.page.onUnload();
    h.interviewPage.onUnload();
  });
  respond(status, [], 201);
  await ready(h, snapshot);
  await choose(h);
  const previewing = h.page.preview(event(snapshot.entries[0].photoId));
  await tick();
  const held = h.downloads.shift();
  h.page.onHide();
  const currentStatus = await showInterview(h);
  respond(
    currentStatus,
    [
      {
        id: "88888888-8888-4888-8888-888888888888",
        projectId: project,
        state: "failed",
        retryable: true,
      },
    ],
    201,
  );
  await tick();
  const starting = h.interviewPage.record();
  const authorization = h.requests.shift();
  assert.match(authorization.url, /recording-start$/);
  assert.equal(
    authorization.data.actualQuestionId,
    "55555555-5555-4555-8555-555555555555",
  );
  assert.equal(authorization.data.expectedQuestionVersion, 1);
  respond(
    authorization,
    {
      allowed: true,
      actualQuestionId: authorization.data.actualQuestionId,
      questionVersion: 1,
      maxDurationMs: 300000,
    },
    201,
  );
  await starting;
  await h.interviewPage.record();
  await tick();
  h.interviewPage.customText({ detail: { value: "采访私人草稿" } });
  const originals = [...h.saved];
  assert.equal(originals.length, 3, "two photos and one pending audio file");
  h.expireSession();
  held.success({ statusCode: 401, tempFilePath: "hidden-photo-denied" });
  await previewing;
  await tick();
  assert.equal(h.interviewPage.data.interview, null);
  assert.equal(h.interviewPage.data.question, "");
  assert.equal(h.interviewPage.data.customText, "");
  assert.equal(h.interviewPage.data.taskRows.length, 0);
  assert.equal(h.interviewPage.data.canRecord, false);
  assert.equal(h.interviewPage.data.busy, false);
  assert.ok(h.removed.includes("hidden-photo-denied"));
  assert.ok(originals.every((path) => !h.removed.includes(path)));
});
test("an old interview's late 401 preserves the new account's active photo draft and private preview", async (t) => {
  const h = harness(),
    snapshot = reviewMaterial(),
    status = await leaveInterviewWithStatusPending(h);
  t.after(() => {
    h.page.onUnload();
    h.interviewPage.onUnload();
  });
  const other = {
    ...login,
    user: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    session: {
      ...login.session,
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      token: "b".repeat(43),
      expiresAt: "2100-01-01T00:00:00Z",
    },
  };
  h.storage.set(`timenook.session.v1:${base}`, other);
  const nextProject = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  h.page.onLoad({ projectId: nextProject, interviewId: interview });
  const showing = h.page.onShow();
  await tick();
  respond(h.requests.shift(), {
    photos: [],
    snapshot: { ...snapshot, id: "new-account-material" },
  });
  await showing;
  h.page.caption({
    currentTarget: { dataset: { id: snapshot.entries[0].photoId } },
    detail: { value: "新账号私人草稿" },
  });
  const previewing = h.page.preview(event(snapshot.entries[0].photoId));
  await tick();
  h.downloads
    .shift()
    .success({ statusCode: 200, tempFilePath: "new-account-private-preview" });
  await previewing;
  h.expireSession();
  respond(status, undefined, 401);
  await tick();
  assert.deepEqual(h.storage.get(`timenook.session.v1:${base}`), other);
  assert.equal(h.page.data.snapshot.id, "new-account-material");
  assert.equal(
    h.page.data.captions[snapshot.entries[0].photoId],
    "新账号私人草稿",
  );
  assert.equal(h.page.data.previewPath, "new-account-private-preview");
  assert.equal(h.removed.includes("new-account-private-preview"), false);
});
test("repeated photo show-hide detaches hidden views and cleans their late download after cross-page invalidation", async (t) => {
  const h = harness(),
    snapshot = reviewMaterial(),
    status = await leaveInterviewWithStatusPending(h);
  t.after(() => {
    h.page.onUnload();
    h.interviewPage.onUnload();
  });
  for (let i = 0; i < 3; i++) {
    await ready(h, snapshot);
    h.page.caption({
      currentTarget: { dataset: { id: snapshot.entries[0].photoId } },
      detail: { value: "保留草稿" },
    });
    await h.page.onShow();
    h.page.onHide();
  }
  await ready(h, snapshot);
  const previewing = h.page.preview(event(snapshot.entries[0].photoId));
  await tick();
  const download = h.downloads.shift();
  h.page.onHide();
  const currentStatus = await showInterview(h);
  respond(currentStatus, [], 201);
  await tick();
  respond(status, undefined, 401);
  await tick();
  assert.equal(h.page.data.status, "", "the hidden photo view is unsubscribed");
  assert.equal(h.interviewPage.data.interview, null);
  download.success({ statusCode: 200, tempFilePath: "late-hidden-preview" });
  await previewing;
  await tick();
  assert.ok(h.removed.includes("late-hidden-preview"));
  assert.equal(h.page.data.previewPath, "");
  assert.equal(h.page.data.status, "");
});
test("an active photo's in-flight download is discarded and cleaned after another page invalidates the shared session", async (t) => {
  const h = harness(),
    snapshot = reviewMaterial(),
    status = await leaveInterviewWithStatusPending(h);
  t.after(() => {
    h.page.onUnload();
    h.interviewPage.onUnload();
  });
  await ready(h, snapshot);
  await choose(h);
  const originals = [...h.saved],
    previewing = h.page.preview(event(snapshot.entries[0].photoId));
  await tick();
  const download = h.downloads.shift();
  respond(status, undefined, 401);
  await tick();
  assert.equal(h.page.data.snapshot, null);
  download.success({ statusCode: 200, tempFilePath: "late-active-preview" });
  await previewing;
  await tick();
  assert.ok(h.removed.includes("late-active-preview"));
  assert.equal(h.page.data.previewPath, "");
  assert.ok(originals.every((path) => !h.removed.includes(path)));
});
test("a current photo-download 401 signs out and clears the private page while retaining pending originals", async () => {
  const h = harness(),
    snapshot = reviewMaterial();
  await ready(h, snapshot);
  await choose(h);
  const originals = h.page.data.photos.map((p: any) => p.path);
  const opening = h.page.preview(event(snapshot.entries[0].photoId));
  await tick();
  h.downloads
    .shift()
    .success({ statusCode: 401, tempFilePath: "denied-current-preview" });
  await opening;
  await tick();
  assert.equal(h.storage.has(`timenook.session.v1:${base}`), false);
  assert.equal(h.page.data.snapshot, null);
  assert.equal(h.page.data.photos.length, 0);
  assert.equal(h.page.data.previewPath, "");
  assert.ok(h.removed.includes("denied-current-preview"));
  assert.ok(originals.every((path: string) => !h.removed.includes(path)));
  h.page.onHide();
});
test("a photo-download 401 still clears private material and its temporary image when device session removal fails", async () => {
  const h = harness(),
    snapshot = reviewMaterial();
  await ready(h, snapshot);
  await choose(h);
  const originals = h.page.data.photos.map((p: any) => p.path);
  h.page.caption({
    currentTarget: { dataset: { id: snapshot.entries[0].photoId } },
    detail: { value: "设备删除失败时也不可留屏的私人草稿" },
  });
  const opening = h.page.preview(event(snapshot.entries[0].photoId));
  await tick();
  h.failSessionRemoval();
  assert.doesNotThrow(() =>
    h.downloads.shift().success({
      statusCode: 401,
      tempFilePath: "denied-session-storage-error",
    }),
  );
  await opening;
  await tick();
  assert.equal(h.page.data.snapshot, null);
  assert.equal(h.page.data.photos.length, 0);
  assert.equal(h.page.data.previewPath, "");
  assert.equal(Object.keys(h.page.data.captions).length, 0);
  assert.ok(h.removed.includes("denied-session-storage-error"));
  assert.ok(originals.every((path: string) => !h.removed.includes(path)));
  assert.equal(h.storage.has(`timenook.session.v1:${base}`), true);
  assert.match(h.page.data.status, /登录已失效.*会话缓存清理失败/);
  await h.page.onShow();
  assert.equal(
    h.requests.length,
    0,
    "an invalidated cached token is not reused",
  );
  assert.equal(h.page.data.snapshot, null);
  h.page.onHide();
});
test("a previous account's delayed photo-download 401 preserves the new account and its current draft", async () => {
  const h = harness(),
    snapshot = reviewMaterial();
  await ready(h, snapshot);
  const opening = h.page.preview(event(snapshot.entries[0].photoId));
  await tick();
  const old = h.downloads.shift();
  h.page.onHide();
  const other = {
    user: { id: "77777777-7777-4777-8777-777777777777" },
    session: {
      ...login.session,
      id: "88888888-8888-4888-8888-888888888888",
      token: "c".repeat(43),
    },
  };
  h.storage.set(`timenook.session.v1:${base}`, other);
  h.page.onLoad({
    projectId: "99999999-9999-4999-8999-999999999999",
    interviewId: interview,
  });
  const showing = h.page.onShow();
  await tick();
  respond(h.requests.shift(), {
    photos: [],
    snapshot: { ...snapshot, id: "new-account-material" },
  });
  await showing;
  h.page.caption({
    currentTarget: { dataset: { id: snapshot.entries[0].photoId } },
    detail: { value: "新账号说明草稿" },
  });
  h.failSessionRemoval();
  old.success({ statusCode: 401, tempFilePath: "previous-account-preview" });
  await opening;
  assert.deepEqual(h.storage.get(`timenook.session.v1:${base}`), other);
  assert.equal(h.page.data.snapshot.id, "new-account-material");
  assert.equal(
    h.page.data.captions[snapshot.entries[0].photoId],
    "新账号说明草稿",
  );
  assert.ok(h.removed.includes("previous-account-preview"));
  h.page.onHide();
});

test("a forbidden photo response clears private material and its temporary image even when preview registration fails", async () => {
  const h = harness(),
    snapshot = reviewMaterial();
  await ready(h, snapshot);
  await choose(h);
  const originals = h.page.data.photos.map((p: any) => p.path);
  h.page.caption({
    currentTarget: { dataset: { id: snapshot.entries[0].photoId } },
    detail: { value: "未保存的私人说明" },
  });
  const opening = h.page.preview(event(snapshot.entries[0].photoId));
  await tick();
  h.failPreview();
  h.downloads.shift().success({
    statusCode: 403,
    tempFilePath: "forbidden-unregistered-preview",
  });
  await opening;
  await tick();
  assert.equal(h.page.data.snapshot, null);
  assert.equal(h.page.data.photos.length, 0);
  assert.equal(h.page.data.previewPath, "");
  assert.equal(Object.keys(h.page.data.captions).length, 0);
  assert.ok(h.removed.includes("forbidden-unregistered-preview"));
  assert.ok(originals.every((path: string) => !h.removed.includes(path)));
  assert.equal(h.storage.has(`timenook.session.v1:${base}`), true);
  h.page.onHide();
});

test("a forbidden photo response remains authoritative when cleanup storage fails after deleting its temporary image", async () => {
  const h = harness(),
    snapshot = reviewMaterial();
  await ready(h, snapshot);
  const opening = h.page.preview(event(snapshot.entries[0].photoId));
  await tick();
  h.failPreviewCleanup();
  h.downloads.shift().success({
    statusCode: 403,
    tempFilePath: "forbidden-cleanup-storage-error",
  });
  await opening;
  await tick();
  assert.equal(h.page.data.snapshot, null);
  assert.equal(h.page.data.photos.length, 0);
  assert.equal(h.page.data.previewPath, "");
  assert.ok(h.removed.includes("forbidden-cleanup-storage-error"));
  assert.equal(h.page.data.status, "照片权限已变化，请重新查询");
  h.page.onHide();
});

test("assisted collection-only photos keep a valid page through remote checks and uploads, then clear on revocation", async () => {
  const h = harness({ controlledTimers: true }),
    assistedSessionId = "88888888-8888-4888-8888-888888888888";
  h.page.onLoad({
    projectId: project,
    interviewId: interview,
    assistedSessionId,
  });
  const show = h.page.onShow();
  await tick();
  assert.match(h.requests[0].url, /photos\/context$/);
  respond(
    h.requests.shift(),
    {
      photos: [],
      snapshot: null,
      usage: { reservedCount: 0, consumedCount: 0 },
    },
    201,
  );
  await show;
  try {
    const check = h.timers
      .filter((timer) => !timer.cleared)
      .slice(-1)[0]
      .callback();
    await tick();
    const current = h.requests.shift();
    assert.equal(
      current.url,
      `${base}/projects/${project}/interviews/${interview}/collection-check`,
    );
    assert.equal(current.data.assistedSessionId, assistedSessionId);
    respond(current, { allowed: true }, 201);
    await check;
    assert.ok(h.page.owner, "no sharing permission is needed for collection");
    await choose(h);
    const first = h.page.data.photos[0];
    await uploading(h, first, "55555555-5555-4555-8555-555555555555");
    assert.equal(h.page.data.photos[0].state, "sealed");
    const denied = h.timers
      .filter((timer) => !timer.cleared)
      .slice(-1)[0]
      .callback();
    await tick();
    respond(h.requests.shift(), undefined, 403);
    await denied;
    assert.equal(h.page.owner, null);
    assert.equal(h.page.data.photos.length, 0);
    assert.match(h.page.data.status, /授权已变化/);
  } finally {
    h.page.onHide();
  }
});
