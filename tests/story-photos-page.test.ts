import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";
const base = "https://example.test/timenook/v1";
const project = "33333333-3333-4333-8333-333333333333";
const interview = "44444444-4444-4444-8444-444444444444";
const photoId = "55555555-5555-4555-8555-555555555555";
const assetId = "66666666-6666-4666-8666-666666666666";
const login = {
  user: { id: "11111111-1111-4111-8111-111111111111" },
  session: {
    id: "22222222-2222-4222-8222-222222222222",
    token: "a".repeat(43),
    expiresAt: "2099-01-01T00:00:00Z",
  },
};
const bundle = await build({
  entryPoints: ["miniprogram/pages/photos/index.ts"],
  bundle: true,
  write: false,
  format: "cjs",
  platform: "neutral",
  define: { __TIMENOOK_API_BASE_URL__: JSON.stringify(base) },
});
const image = () => ({
  id: photoId,
  projectId: project,
  clientPhotoId: "77777777-7777-4777-8777-777777777777",
  state: "sealed",
  bytes: 123,
  sha256: "a".repeat(64),
  lowResolution: false,
  assets: [
    {
      id: assetId,
      kind: "preview",
      processingVersion: "t04-pixels-v1",
      bytes: 123,
      sha256: "a".repeat(64),
    },
    { id: "88888888-8888-4888-8888-888888888888", kind: "original" },
    { id: "99999999-9999-4999-8999-999999999999", kind: "print" },
  ],
});
const tick = () => new Promise((resolve) => setImmediate(resolve));
function harness(
  options: {
    photos?: any[];
    snapshot?: any;
    holdDownloads?: boolean;
    failManifest?: boolean;
    failUpload?: boolean;
  } = {},
) {
  const storage = new Map<string, any>([
    ["timenook.mode.v1", "live"],
    [`timenook.session.v1:${base}`, login],
  ]);
  const requests: any[] = [],
    downloads: any[] = [],
    removed: string[] = [],
    saved: string[] = [],
    navigations: string[] = [];
  const photos = options.photos ?? [];
  const snapshots: any[] = options.snapshot ? [options.snapshot] : [];
  const timers: (() => Promise<void>)[] = [];
  let page: any,
    failManifest = options.failManifest,
    failUpload = options.failUpload,
    denied = false;
  let holdList = false;
  const held: any[] = [];
  const response = (request: any, data: any, statusCode = 200) =>
    request.success({
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
  runInNewContext(bundle.outputFiles[0].text, {
    setTimeout: (callback: () => Promise<void>) => {
      timers.push(callback);
      return timers.length;
    },
    clearTimeout() {},
    Page(value: any) {
      page = value;
      page.setData = (data: any) => Object.assign(page.data, data);
    },
    wx: {
      env: { USER_DATA_PATH: "/user-data" },
      getStorageSync: (key: string) => structuredClone(storage.get(key)),
      setStorageSync(key: string, data: any) {
        if (failManifest && key.includes("timenook.photos")) {
          failManifest = false;
          throw Error("storage full");
        }
        storage.set(key, structuredClone(data));
      },
      removeStorageSync: (key: string) => storage.delete(key),
      getAccountInfoSync: () => ({ miniProgram: { appId: "synthetic" } }),
      setNavigationBarTitle() {},
      enableAlertBeforeUnload() {},
      disableAlertBeforeUnload() {},
      chooseMedia: (request: any) =>
        request.success({ tempFiles: [{ tempFilePath: "chosen-photo" }] }),
      getFileSystemManager: () => ({
        saveFile(request: any) {
          const path = `saved-${saved.length + 1}`;
          saved.push(path);
          request.success({ savedFilePath: path });
        },
        access: (request: any) => request.success({}),
        getFileInfo: (request: any) =>
          request.success({ size: 123, digest: "a".repeat(64) }),
        unlink(request: any) {
          removed.push(request.filePath);
          request.success({});
        },
      }),
      request(request: any) {
        requests.push(request);
        const path = request.url.slice(base.length);
        if (denied) {
          response(request, null, 403);
          return;
        }
        if (request.method === "GET") {
          if (path.endsWith("/photos")) {
            if (holdList) held.push(request);
            else
              response(request, {
                photos,
                usage: { reservedCount: 0, consumedCount: photos.length },
              });
          } else if (path.endsWith("/photo-materials"))
            response(request, snapshots[snapshots.length - 1] ?? null);
          else if (path.endsWith("/participation"))
            response(request, { canRead: true, canCollect: true });
          else if (path.endsWith("/interviews"))
            response(request, {
              canRecord: true,
              plan: { revision: 1 },
              interviews: [],
            });
          else assert.fail(`Unhandled GET ${path}`);
        } else if (path.endsWith("/photos")) {
          const existing = photos.find(
            (photo) => photo.clientPhotoId === request.data.clientPhotoId,
          );
          const photo = existing ?? {
            ...image(),
            ...request.data,
            state: "pending",
            assets: [],
          };
          if (!existing) photos.push(photo);
          response(request, photo, 201);
        } else if (path.endsWith("/status")) response(request, photos[0], 201);
        else if (path.endsWith("/upload"))
          response(
            request,
            {
              url: "/v1/photos/objects",
              storage: "local-simulator",
              expiresAt: "2099-01-01T00:00:00Z",
              fields: {
                key: "private-photo",
                policy: "policy",
                "x-photo-capability": "capability",
              },
            },
            201,
          );
        else if (path.endsWith("/seal")) {
          Object.assign(photos[0], { state: "sealed", assets: image().assets });
          response(request, photos[0], 201);
        } else if (path.endsWith("/photo-materials")) {
          const snapshot = {
            id: `snapshot-${snapshots.length + 1}`,
            projectId: project,
            interviewId: interview,
            revision: snapshots.length + 1,
            entries: request.data.entries.map((entry: any) => ({
              ...entry,
              assets:
                photos.find((photo) => photo.id === entry.photoId)?.assets ??
                [],
            })),
          };
          if (request.data.expectedRevision !== snapshots.length)
            response(request, null, 409);
          else {
            snapshots.push(snapshot);
            response(request, snapshot, 201);
          }
        } else if (path.endsWith("/interviews"))
          response(request, { id: interview }, 201);
        else if (path.endsWith("/release")) {
          Object.assign(photos[0], { state: "released" });
          response(request, photos[0], 201);
        } else assert.fail(`Unhandled POST ${path}`);
      },
      uploadFile(request: any) {
        if (failUpload) {
          failUpload = false;
          request.fail({ errMsg: "network error" });
        } else request.success({ statusCode: 204 });
      },
      downloadFile(request: any) {
        downloads.push(request);
        if (!options.holdDownloads)
          request.success({ statusCode: 200, tempFilePath: "private-preview" });
      },
      previewImage(request: any) {
        request.complete();
      },
      navigateTo: (request: any) => navigations.push(request.url),
      navigateBack: () => navigations.push("back"),
    },
  });
  return {
    page,
    photos,
    snapshots,
    requests,
    downloads,
    saved,
    removed,
    storage,
    navigations,
    timers,
    held,
    response,
    deny() {
      denied = true;
    },
    holdList() {
      holdList = true;
    },
  };
}
const event = (id: string) => ({ currentTarget: { dataset: { id } } });
async function ready(
  h: ReturnType<typeof harness>,
  query: Record<string, string> = {},
) {
  h.page.onLoad({ projectId: project, ...query });
  await h.page.onShow();
}
test("an empty project opens the real photo library without creating an interview", async (t) => {
  const h = harness();
  t.after(() => h.page.onUnload());
  await ready(h);
  assert.equal(h.page.data.pageLoading, false);
  assert.equal(h.page.data.rows.length, 0);
  assert.equal(h.page.data.selection, false);
  assert.ok(
    h.requests.every((request) => !request.url.includes("/interviews")),
  );
  await h.page.choose();
  assert.equal(h.page.data.rows.length, 1);
  assert.equal(h.page.data.rows[0].image, "private-preview");
  assert.equal(h.photos.length, 1);
  assert.equal(h.snapshots.length, 0);
  assert.ok(
    h.requests.every((request) => !request.url.includes("/interviews")),
  );
  assert.equal(
    h.downloads[0].url,
    `${base}/projects/${project}/photos/${photoId}/assets/${assetId}/content`,
  );
});
test("selecting a project photo starts a photo interview and attaches the same asset before navigating to recording", async (t) => {
  const h = harness({ photos: [image()] });
  t.after(() => h.page.onUnload());
  await ready(h);
  h.page.select(event(photoId));
  await h.page.recordPhoto();
  assert.equal(h.snapshots.length, 1);
  assert.equal(h.snapshots[0].entries[0].photoId, photoId);
  assert.equal(h.photos.length, 1);
  assert.equal(
    h.navigations[0],
    `/pages/interview/index?projectId=${project}&interviewId=${interview}&prepare=1`,
  );
  const creation = h.requests.find(
    (request) =>
      request.method === "POST" && request.url.endsWith("/interviews"),
  );
  assert.equal(creation.data.starterKind, "photo");
  assert.equal(
    h.requests.filter(
      (request) => request.method === "POST" && request.url.endsWith("/photos"),
    ).length,
    0,
  );
});
test("selecting and removing an interview photo only appends immutable references", async (t) => {
  const original = {
    id: "snapshot-1",
    revision: 1,
    entries: [{ photoId, caption: "那年夏天", assets: image().assets }],
  };
  const h = harness({ photos: [image()], snapshot: original });
  t.after(() => h.page.onUnload());
  await ready(h, { interviewId: interview });
  assert.equal(h.page.data.rows[0].selected, true);
  h.page.select(event(photoId));
  await h.page.done();
  assert.deepEqual(h.snapshots[1].entries, []);
  assert.equal(h.snapshots[0].entries[0].caption, "那年夏天");
  assert.equal(h.photos[0].state, "sealed");
  assert.equal(h.navigations[0], "back");
  assert.ok(!h.requests.some((request) => request.url.endsWith("/release")));
});
test("upload failure retains the project original and retries the same reserved photo", async (t) => {
  const h = harness({ failUpload: true });
  t.after(() => h.page.onUnload());
  await ready(h);
  await h.page.choose();
  assert.equal(h.page.data.photos[0].state, "failed");
  const local = h.page.data.photos[0];
  await h.page.upload(event(local.clientPhotoId));
  assert.equal(h.saved.length, 1);
  assert.equal(h.photos.length, 1);
  assert.equal(h.page.data.rows.length, 1);
  assert.equal(h.page.data.photos.length, 0);
  assert.equal(
    h.requests.filter(
      (request) => request.method === "POST" && request.url.endsWith("/photos"),
    ).length,
    1,
  );
});
test("failed local manifest storage retries without duplicating the only original file", async (t) => {
  const h = harness({ failManifest: true });
  t.after(() => h.page.onUnload());
  await ready(h);
  await h.page.choose();
  assert.equal(h.page.data.photos[0].state, "save-error");
  await h.page.retrySave(event(h.page.data.photos[0].clientPhotoId));
  assert.equal(h.saved.length, 1);
  assert.equal(h.page.data.rows.length, 1);
});
test("project permission loss clears rendered private photos and downloads", async (t) => {
  const h = harness({ photos: [image()] });
  t.after(() => h.page.onUnload());
  await ready(h);
  h.deny();
  await h.page.onShow();
  await tick();
  assert.equal(h.page.data.rows.length, 0);
  assert.match(h.page.data.status, /权限已变化/);
  assert.ok(h.removed.includes("private-preview"));
});
test("a photo downloaded after leaving is removed instead of appearing in the new page", async (t) => {
  const h = harness({ photos: [image()], holdDownloads: true });
  t.after(() => h.page.onUnload());
  h.page.onLoad({ projectId: project });
  const showing = h.page.onShow();
  await tick();
  assert.equal(h.downloads.length, 1);
  h.page.onHide();
  h.downloads[0].success({ statusCode: 200, tempFilePath: "late-photo" });
  await showing;
  await tick();
  assert.equal(h.page.data.rows.length, 0);
  assert.ok(h.removed.includes("late-photo"));
});
test("a stale forbidden library response does not erase the current project's selection", async (t) => {
  const h = harness();
  t.after(() => h.page.onUnload());
  await ready(h);
  h.holdList();
  const oldShow = h.page.onShow();
  await tick();
  h.page.onLoad({ projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
  const newShow = h.page.onShow();
  await tick();
  h.response(h.held[1], {
    photos: [],
    usage: { reservedCount: 0, consumedCount: 0 },
  });
  await newShow;
  h.page.setData({ selectedId: "current-choice" });
  h.response(h.held[0], null, 403);
  await oldShow;
  assert.equal(h.page.data.selectedId, "current-choice");
  assert.equal(h.page.data.status, "");
});
