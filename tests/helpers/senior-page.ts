import assert from "node:assert/strict";
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
    [
      "book",
      "manuscript",
      "directory",
      "chapter-stories",
      "cover-photos",
      "print",
      "address",
      "cover",
      "chapter",
      "edit-story",
      "production",
      "question-edit",
      "question",
      "chapter-outline",
      "home",
      "account",
      "projects",
      "invite",
      "welcome",
    ].map(
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
  const faults = { openDocument: false };
  const storage = new Map<string, any>([
    ["timenook.mode.v1", "live"],
    [`timenook.session.v1:${base}`, structuredClone(login)],
  ]);
  const requests: any[] = [],
    downloads: any[] = [],
    opened: any[] = [],
    removed: string[] = [],
    routes: string[] = [],
    navigations: any[] = [],
    events: any[] = [],
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
      page.getOpenerEventChannel = () => ({
        emit: (name: string, value: any) => events.push({ name, value }),
      });
    },
    wx: {
      env: { USER_DATA_PATH: "/user-data" },
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
        if (faults.openDocument) o.fail?.({ errMsg: "open failed" });
        else o.success?.({});
      },
      getFileSystemManager: () => ({
        unlink: (o: any) => {
          removed.push(o.filePath);
          o.success?.({});
        },
        getFileInfo: (o: any) =>
          o.success({ size: 4567, digest: "f".repeat(64) }),
      }),
      navigateTo: (options: any) => {
        routes.push(options.url);
        navigations.push(options);
      },
      reLaunch: ({ url }: any) => routes.push(url),
      showToast() {},
      enableAlertBeforeUnload() {},
      disableAlertBeforeUnload() {},
      navigateBack: () => routes.push("back"),
    },
  });
  return {
    page,
    clock,
    faults,
    storage,
    requests,
    downloads,
    opened,
    removed,
    routes,
    navigations,
    events,
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

function overview() {
  return {
    projectId,
    bookTitle: "小路与岁月",
    metadataVersion: 1,
    stories: [],
    interviews: [],
    tasks: [],
    summary: {},
    nextStep: "record",
    canDecide: true,
    canRecord: true,
    canInvite: true,
  };
}

export {
  base,
  projectId,
  versionId,
  storyId,
  login,
  harness,
  version,
  context,
  overview,
  tick,
};
