import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";
const projectId = "33333333-3333-4333-8333-333333333333",
  base = "https://example.test/timenook/v1";
async function harness() {
  const bundle = (
    await build({
      entryPoints: ["miniprogram/pages/deletion-status/index.ts"],
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
    timers: (() => void)[] = [];
  let page: any;
  runInNewContext(bundle, {
    Page(v: any) {
      page = v;
      page.setData = (p: object) => Object.assign(page.data, p);
    },
    Date,
    setTimeout(fn: () => void) {
      timers.push(fn);
      return timers.length;
    },
    clearTimeout() {},
    wx: {
      getStorageSync: (k: string) => structuredClone(storage.get(k)),
      setStorageSync: (k: string, v: any) => storage.set(k, structuredClone(v)),
      removeStorageSync: (k: string) => storage.delete(k),
      request: (r: any) => requests.push(r),
      navigateTo() {},
      getFileSystemManager: () => ({
        unlink: ({ success }: any) => success?.(),
      }),
    },
  });
  return {
    page,
    requests,
    timers,
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
    onlineAccessStopped: false,
    permanentProjectDeletion: false,
    accessEpoch: 0,
    changes: [],
    boundary:
      "已传输到设备、已交付导出与纸书不能由平台收回；供应商与备份按各自证据处理。",
  };
}
test("deletion Page reads minimum progress without private plan permission and an empty ledger does not claim deleted", async () => {
  const h = await harness();
  h.page.onLoad({ projectId });
  const loading = h.page.onShow();
  assert.equal(
    h.requests[0].url,
    `${base}/projects/${projectId}/deletion-status`,
  );
  h.respond(0, view());
  await new Promise((r) => setImmediate(r));
  if (h.requests[1]) h.respond(1, { requests: [] });
  await loading;
  assert.equal(h.page.data.view.onlineAccessStopped, false);
  assert.match(h.page.data.summary, /尚无已核验/);
  assert.equal(h.page.data.rows.length, 0);
  h.page.onHide();
});
function deleted() {
  return {
    ...view(),
    onlineAccessStopped: true,
    permanentProjectDeletion: true,
    accessEpoch: 1,
    changes: [
      {
        id: "55555555-5555-4555-8555-555555555555",
        requestId: null,
        trigger: "verified_request",
        categories: ["all"],
        effectiveAt: "2026-10-27T00:00:00Z",
        createdAt: "2026-10-27T00:00:00Z",
        items: [
          {
            id: "66666666-6666-4666-8666-666666666666",
            category: "audio",
            layer: "backup",
            state: "awaiting_evidence",
            deadline: "2020-01-01T00:00:00Z",
            completedAt: null,
            reason: "EXTERNAL_RECEIPT_REQUIRED",
            evidenceRef: null,
          },
        ],
      },
    ],
  };
}
test("verified deletion purges controlled downloaded media while retaining original recordings and rights intents", async () => {
  const h = await harness();
  h.storage.set(`timenook.story-audio.v1:${base}`, ["controlled-audio"]);
  h.storage.set(`timenook.photo-previews.v1:${base}`, ["controlled-photo"]);
  h.storage.set("original-recording", "local-original");
  h.storage.set("rights-intent", "new-intent");
  h.page.onLoad({ projectId });
  const loading = h.page.onShow();
  h.respond(0, deleted());
  await new Promise((r) => setImmediate(r));
  if (h.requests[1]) h.respond(1, { requests: [] });
  await loading;
  assert.equal(h.storage.get(`timenook.story-audio.v1:${base}`).length, 0);
  assert.equal(h.storage.get(`timenook.photo-previews.v1:${base}`).length, 0);
  assert.equal(h.storage.get("original-recording"), "local-original");
  assert.equal(h.storage.get("rights-intent"), "new-intent");
  assert.match(h.page.data.summary, /不可逆/);
  assert.match(h.page.data.rows[0].state, /清理待核验/);
  assert.match(h.page.data.rows[0].deadline, /仍待核实/);
  h.page.onHide();
});
test("a pending deletion request does not claim access stopped and unknown deadlines remain unknown", async () => {
  const h = await harness();
  h.page.onLoad({ projectId });
  const loading = h.page.onShow();
  h.respond(0, view());
  await new Promise((r) => setImmediate(r));
  h.respond(1, {
    requests: [
      {
        id: "44444444-4444-4444-8444-444444444444",
        kind: "delete",
        state: "open",
        createdAt: "2026-10-27T00:00:00Z",
      },
    ],
  });
  await loading;
  assert.match(h.page.data.summary, /待客服核验/);
  assert.equal(h.page.data.view.onlineAccessStopped, false);
  h.page.onHide();
});
for (const event of ["hide", "account"])
  test(`deletion Page clears late progress after ${event}`, async () => {
    const h = await harness();
    h.page.onLoad({ projectId });
    const loading = h.page.onShow();
    if (event === "hide") h.page.onHide();
    else {
      const owner = h.storage.get(`timenook.session.v1:${base}`);
      owner.session.id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      h.storage.set(`timenook.session.v1:${base}`, owner);
      h.timers[h.timers.length - 1]();
    }
    h.respond(0, deleted());
    await loading;
    assert.equal(h.page.data.view, null);
    assert.equal(h.page.data.rows.length, 0);
    assert.equal(h.requests.length, 1);
  });
test("verified scoped deletion does not label the whole project deleted or expose unknown category values", async () => {
  const h = await harness();
  h.page.onLoad({ projectId });
  const loading = h.page.onShow();
  const value = deleted();
  value.permanentProjectDeletion = false;
  value.onlineAccessStopped = false;
  value.changes[0].items[0].category = "/private/untrusted/story-path";
  value.changes[0].items[0].deadline = null as any;
  h.respond(0, value);
  await new Promise((r) => setImmediate(r));
  if (h.requests[1]) h.respond(1, { requests: [] });
  await loading;
  assert.match(h.page.data.summary, /核验的删除范围/);
  assert.equal(h.page.data.rows[0].category, "相关资料");
  assert.match(h.page.data.rows[0].deadline, /待确认/);
  h.page.onHide();
});
test("verified deletion progress stays readable when the old care content route is forbidden", async () => {
  const h = await harness();
  h.page.onLoad({ projectId });
  const loading = h.page.onShow();
  h.respond(0, deleted());
  await new Promise((r) => setImmediate(r));
  if (h.requests[1]) h.respond(1, {}, 403);
  await loading;
  assert.equal(h.page.data.view?.permanentProjectDeletion, true);
  assert.match(h.page.data.summary, /不可逆/);
  h.page.onHide();
});
test("a successful deletion poll applies irreversible progress and clears only controlled media", async () => {
  const h = await harness();
  h.storage.set(`timenook.story-audio.v1:${base}`, ["controlled-audio"]);
  h.storage.set(`timenook.photo-previews.v1:${base}`, ["controlled-photo"]);
  h.storage.set("original-recording", "device-original");
  h.storage.set("rights-intent", "new-input");
  h.page.onLoad({ projectId });
  const loading = h.page.onShow();
  h.respond(0, view());
  await new Promise((r) => setImmediate(r));
  h.respond(1, { requests: [] });
  await loading;
  const poll = h.timers[h.timers.length - 1]();
  h.respond(2, deleted());
  await poll;
  assert.equal(h.page.data.view.permanentProjectDeletion, true);
  assert.match(h.page.data.summary, /不可逆/);
  assert.equal(h.storage.get(`timenook.story-audio.v1:${base}`).length, 0);
  assert.equal(h.storage.get(`timenook.photo-previews.v1:${base}`).length, 0);
  assert.equal(h.storage.get("original-recording"), "device-original");
  assert.equal(h.storage.get("rights-intent"), "new-input");
  h.page.onHide();
});
for (const event of ["hide", "project"] as const)
  test(`a late successful deletion poll cannot apply or purge after ${event}`, async () => {
    const h = await harness();
    h.storage.set(`timenook.story-audio.v1:${base}`, ["new-controlled-audio"]);
    h.page.onLoad({ projectId });
    const loading = h.page.onShow();
    h.respond(0, view());
    await new Promise((r) => setImmediate(r));
    h.respond(1, { requests: [] });
    await loading;
    const poll = h.timers[h.timers.length - 1]();
    h.page.onHide();
    if (event === "project") {
      const nextId = "77777777-7777-4777-8777-777777777777";
      h.page.onLoad({ projectId: nextId });
      const next = h.page.onShow();
      h.respond(3, { ...view(), projectId: nextId });
      await new Promise((r) => setImmediate(r));
      h.respond(4, { requests: [] });
      await next;
    }
    h.respond(2, deleted());
    await poll;
    assert.equal(h.storage.get(`timenook.story-audio.v1:${base}`).length, 1);
    if (event === "hide") assert.equal(h.page.data.view, null);
    else
      assert.equal(
        h.page.data.view.projectId,
        "77777777-7777-4777-8777-777777777777",
      );
    h.page.onHide();
  });
