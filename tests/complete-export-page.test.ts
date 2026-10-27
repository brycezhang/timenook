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
    shares: any[] = [],
    timers: { callback: () => void; cancelled: boolean }[] = [];
  let page: any;
  runInNewContext(bundle, {
    Page(v: any) {
      page = v;
      page.setData = (p: object) => Object.assign(page.data, p);
    },
    Date,
    setTimeout(callback: () => void) {
      timers.push({ callback, cancelled: false });
      return timers.length;
    },
    clearTimeout(id: number) {
      if (timers[id - 1]) timers[id - 1].cancelled = true;
    },
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
    timers,
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
test("a current collection denial keeps the rights request visible while the ready package is unavailable", async () => {
  const h = await harness();
  h.page.onLoad({ projectId });
  const loading = h.page.onShow();
  h.respond(0, {
    ...view(),
    requests: [
      {
        ...ready(),
        canDownload: false,
        missingReason: "EXPORT_CURRENT_AUTHORIZATION_REQUIRED",
      },
    ],
  });
  await loading;
  assert.equal(h.page.data.context.canRequest, true);
  assert.equal(h.page.data.rows[0].canDownload, false);
  assert.equal(h.page.data.rows[0].label, "当前本人授权不可用，请重新核验");
  await h.page.download({ currentTarget: { dataset: { id } } });
  assert.equal(h.downloads.length, 0);
});
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

test("a slow same-account export request survives an already queued old watcher and current ticks", async () => {
  const h = await harness();
  h.page.onLoad({ projectId });
  const loading = h.page.onShow();
  h.respond(0, view());
  await loading;
  const old = h.timers[h.timers.length - 1];
  h.page.recipient({ currentTarget: { dataset: { value: "self" } } });
  h.page.evidence({ detail: { value: "本人申请完整资料" } });
  h.page.choose();
  const pending = h.page.request();
  old.callback();
  assert.equal(
    h.page.active,
    true,
    "stale watcher cannot hide the current operation",
  );
  assert.equal(h.page.data.busy, true);
  assert.ok(h.page.data.context);
  h.timers[h.timers.length - 1].callback();
  assert.equal(h.page.active, true);
  h.respond(
    1,
    {
      ...ready(),
      state: "requested",
      readyAt: null,
      expiresAt: null,
      sha256: null,
      bytes: null,
      canDownload: false,
    },
    201,
  );
  await pending;
  assert.equal(h.page.data.rows.length, 1);
  assert.equal(h.page.data.rows[0].state, "requested");
  assert.match(h.page.data.status, /客服核验/);
  h.page.onHide();
});
test("a slow same-account package download survives watcher ticks then validates, saves and acknowledges the same ZIP", async () => {
  const h = await harness();
  h.page.onLoad({ projectId });
  const loading = h.page.onShow();
  h.respond(0, { ...view(), requests: [ready()] });
  await loading;
  const old = h.timers[h.timers.length - 1],
    pending = h.page.download({ currentTarget: { dataset: { id } } });
  old.callback();
  assert.equal(
    h.page.active,
    true,
    "old watcher must not treat a new operation as account switching",
  );
  assert.ok(h.page.data.context);
  h.timers[h.timers.length - 1].callback();
  h.downloads[0].success({
    statusCode: 200,
    tempFilePath: "slow-verified.zip",
  });
  await new Promise((resolve) => setImmediate(resolve));
  h.respond(1, { ...view(), requests: [ready()] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.shares.length, 1);
  assert.equal(
    h.requests[2].url,
    `${base}/projects/${projectId}/exports/${id}/receipt`,
  );
  h.respond(
    2,
    { ...ready(), state: "delivered", deliveredAt: new Date().toISOString() },
    201,
  );
  await pending;
  assert.deepEqual(h.removed, ["slow-verified.zip"]);
  assert.match(h.page.data.status, /设备保存或发送/);
  assert.equal(h.page.active, true);
  h.page.onHide();
});

test("the current watcher still clears a slow download when the account actually changes", async () => {
  const h = await harness();
  h.page.onLoad({ projectId });
  const loading = h.page.onShow();
  h.respond(0, { ...view(), requests: [ready()] });
  await loading;
  const pending = h.page.download({ currentTarget: { dataset: { id } } });
  const switched = structuredClone(
    h.storage.get(`timenook.session.v1:${base}`),
  );
  switched.user.id = "99999999-9999-4999-8999-999999999999";
  switched.session.id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  h.storage.set(`timenook.session.v1:${base}`, switched);
  h.timers[h.timers.length - 1].callback();
  assert.equal(h.page.data.context, null);
  assert.equal(h.page.active, false);
  assert.match(h.page.data.status, /账号已变化/);
  h.downloads[0].success({
    statusCode: 200,
    tempFilePath: "switched-late.zip",
  });
  await pending;
  assert.deepEqual(h.removed, ["switched-late.zip"]);
  assert.equal(h.shares.length, 0);
});

test("an account switch immediately before a request clears the old view without sending it", async () => {
  const h = await harness();
  h.page.onLoad({ projectId });
  const loading = h.page.onShow();
  h.respond(0, view());
  await loading;
  h.page.recipient({ currentTarget: { dataset: { value: "self" } } });
  h.page.evidence({ detail: { value: "本人申请完整资料" } });
  h.page.choose();
  const switched = structuredClone(
    h.storage.get(`timenook.session.v1:${base}`),
  );
  switched.session.id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  h.storage.set(`timenook.session.v1:${base}`, switched);
  await h.page.request();
  assert.equal(h.page.data.context, null);
  assert.equal(h.page.active, false);
  assert.equal(h.requests.length, 1);
});
