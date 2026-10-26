import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";
const projectId = "33333333-3333-4333-8333-333333333333",
  id = "44444444-4444-4444-8444-444444444444",
  base = "https://example.test/timenook/v1";
async function harness() {
  const bundle = (
    await build({
      entryPoints: ["miniprogram/pages/export/index.ts"],
      bundle: true,
      write: false,
      format: "cjs",
      platform: "neutral",
      define: { __TIMENOOK_API_BASE_URL__: JSON.stringify(base) },
    })
  ).outputFiles[0].text;
  const storage = new Map<string, any>([
    ["timenook.mode.v1", "live"],
    [
      `timenook.session.v1:${base}`,
      {
        user: { id: "11111111-1111-4111-8111-111111111111" },
        session: {
          id: "22222222-2222-4222-8222-222222222222",
          token: "a".repeat(43),
          expiresAt: "2099-01-01T00:00:00Z",
        },
      },
    ],
  ]);
  const requests: any[] = [],
    downloads: any[] = [],
    removed: string[] = [],
    shares: any[] = [];
  let page: any;
  runInNewContext(bundle, {
    Page(v: any) {
      page = v;
      page.setData = (p: object) => Object.assign(page.data, p);
    },
    Date,
    setTimeout() {
      return 1;
    },
    clearTimeout() {},
    wx: {
      getStorageSync: (k: string) => structuredClone(storage.get(k)),
      setStorageSync: (k: string, v: any) => storage.set(k, structuredClone(v)),
      removeStorageSync: (k: string) => storage.delete(k),
      request: (r: any) => requests.push(r),
      downloadFile: (r: any) => downloads.push(r),
      getFileSystemManager: () => ({
        unlink: ({ filePath, success }: any) => {
          removed.push(filePath);
          success?.();
        },
        getFileInfo: ({ success }: any) =>
          success({ size: 42, digest: "f".repeat(64) }),
      }),
      shareFileMessage: (r: any) => {
        shares.push(r);
        r.success?.();
      },
      navigateTo() {},
    },
  });
  return {
    page,
    requests,
    downloads,
    removed,
    shares,
    storage,
    respond(i: number, data: any, statusCode = 200) {
      requests[i].success({
        statusCode,
        data:
          statusCode < 400
            ? { data, meta: { requestId: "synthetic" } }
            : {
                error: { code: "FORBIDDEN" },
                meta: { requestId: "synthetic" },
              },
      });
    },
  };
}
function view() {
  return {
    projectId,
    canRequest: true,
    amountDueFen: 0,
    requestWindow: { state: "active", startsAt: null, expiresAt: null },
    service: {
      within: 3,
      unit: "business_days",
      ownerRef: "record:owner",
      calendarRef: "record:calendar",
    },
    accessEpoch: 0,
    requests: [],
  };
}
test("complete export Page reads the current private service and requires an explicit recipient choice", async () => {
  const h = await harness();
  h.page.onLoad({ projectId });
  const loading = h.page.onShow();
  h.respond(0, view());
  await loading;
  assert.equal(h.requests[0].url, `${base}/projects/${projectId}/exports`);
  assert.equal(h.page.data.context.amountDueFen, 0);
  await h.page.request();
  assert.equal(h.requests.length, 1);
  h.page.recipient({ currentTarget: { dataset: { value: "self" } } });
  h.page.evidence({ detail: { value: "本人同意导出完整资料" } });
  h.page.choose();
  const pending = h.page.request();
  assert.equal(h.requests[1].data.recipient, "self");
  assert.equal(h.requests[1].data.noticeVersion, "synthetic-d08-v1");
  h.respond(
    1,
    {
      id,
      projectId,
      state: "requested",
      recipient: "self",
      recipientUserId: "11111111-1111-4111-8111-111111111111",
      requestedAt: new Date().toISOString(),
      acceptedAt: null,
      dueAt: null,
      ownerId: null,
      readyAt: null,
      expiresAt: null,
      sha256: null,
      bytes: null,
      missingReason: null,
      canDownload: false,
      deliveredAt: null,
    },
    201,
  );
  await pending;
  assert.match(h.page.data.status, /客服核验/);
  assert.equal(h.page.data.rows.length, 1);
  h.page.onHide();
  assert.equal(h.page.data.context, null);
});
function ready() {
  return {
    id,
    projectId,
    state: "ready",
    recipient: "self",
    recipientUserId: "11111111-1111-4111-8111-111111111111",
    requestedAt: new Date().toISOString(),
    acceptedAt: new Date().toISOString(),
    dueAt: "2099-01-01T00:00:00Z",
    ownerId: "55555555-5555-4555-8555-555555555555",
    readyAt: new Date().toISOString(),
    expiresAt: "2099-01-01T00:00:00Z",
    sha256: "f".repeat(64),
    bytes: 42,
    missingReason: null,
    canDownload: true,
    deliveredAt: null,
  };
}
test("leaving during package download discards late bytes and never offers them to another session", async () => {
  const h = await harness();
  h.page.onLoad({ projectId });
  const loading = h.page.onShow();
  h.respond(0, { ...view(), requests: [ready()] });
  await loading;
  const pending = h.page.download({ currentTarget: { dataset: { id } } });
  assert.equal(h.downloads[0].header.authorization, "Bearer " + "a".repeat(43));
  h.page.onHide();
  h.downloads[0].success({ statusCode: 200, tempFilePath: "private-late.zip" });
  await pending;
  assert.deepEqual(h.removed, ["private-late.zip"]);
  assert.equal(h.shares.length, 0);
  assert.equal(h.page.data.context, null);
});
test("package download rechecks exact epoch and receipt before offering a verified ZIP", async () => {
  const h = await harness();
  h.page.onLoad({ projectId });
  const loading = h.page.onShow();
  h.respond(0, { ...view(), requests: [ready()] });
  await loading;
  const pending = h.page.download({ currentTarget: { dataset: { id } } });
  h.downloads[0].success({ statusCode: 200, tempFilePath: "verified.zip" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.requests[1].method, "GET");
  h.respond(1, { ...view(), accessEpoch: 1, requests: [ready()] });
  await pending;
  assert.equal(h.shares.length, 0);
  assert.deepEqual(h.removed, ["verified.zip"]);
  assert.match(h.page.data.status, /授权已变化/);
});
