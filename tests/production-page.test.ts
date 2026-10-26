import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";
const base = "https://example.test/timenook/v1";
const projectId = "33333333-3333-4333-8333-333333333333";
const orderId = "44444444-4444-4444-8444-444444444444";
const attemptId = "55555555-5555-4555-8555-555555555555";
const login = {
  user: { id: "11111111-1111-4111-8111-111111111111" },
  session: {
    id: "22222222-2222-4222-8222-222222222222",
    token: "a".repeat(43),
    expiresAt: "2099-01-01T00:00:00Z",
  },
};
async function harness() {
  const bundle = (
    await build({
      entryPoints: ["miniprogram/pages/production/index.ts"],
      bundle: true,
      write: false,
      format: "cjs",
      platform: "neutral",
      define: { __TIMENOOK_API_BASE_URL__: JSON.stringify(base) },
    })
  ).outputFiles[0].text;
  const storage = new Map<string, any>([
    ["timenook.mode.v1", "live"],
    [`timenook.session.v1:${base}`, structuredClone(login)],
  ]);
  const requests: any[] = [],
    routes: string[] = [],
    timers: { callback: () => void; delay: number }[] = [];
  const clock = { now: Date.now() };
  let page: any;
  runInNewContext(bundle, {
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
          "private progress never reads demo data",
        );
        return structuredClone(storage.get(key));
      },
      setStorageSync: (key: string, value: any) =>
        storage.set(key, structuredClone(value)),
      removeStorageSync: (key: string) => storage.delete(key),
      request: (r: any) => requests.push(r),
      navigateTo: ({ url }: any) => routes.push(url),
      reLaunch: ({ url }: any) => routes.push(url),
      showToast() {},
    },
  });
  return {
    page,
    requests,
    routes,
    storage,
    timers,
    clock,
    respond(index: number, data: any, statusCode = 200) {
      assert.ok(requests[index], "expected authenticated HTTP request");
      requests[index].success({
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
    },
  };
}
function summary(): any {
  return {
    projectId,
    orderId,
    reservation: null,
    current: {
      id: attemptId,
      handoffId: "TN-SYNTHETIC-01",
      state: "handoff_pending",
      sequence: 1,
      caseId: "66666666-6666-4666-8666-666666666666",
      ownerAdminId: "77777777-7777-4777-8777-777777777777",
      dueAt: "2099-01-01T00:00:00Z",
      bookVersionId: "88888888-8888-4888-8888-888888888888",
      snapshotHash: "b".repeat(64),
      pdfHash: "f".repeat(64),
      addressHash: "c".repeat(64),
      supplierRef: "synthetic:print-v1",
      receiptRef: null,
      tracking: null,
      deliveredAt: null,
      grantExpiresAt: null,
      cancellationNotice: "交接结果待核实，不会自动重发；取消须人工核实。",
    },
    attempts: [],
    creation: { state: "active", expiresAt: null },
    serviceTerms: {},
    canGrant: false,
    canGrantNarrator: false,
    grantMaxMinutes: 30,
    accessExpiresAt: null,
  };
}
test("production Page reads the server's pending handoff and never invents supplier acceptance or tracking", async () => {
  const h = await harness();
  h.page.onLoad({ projectId });
  const loading = h.page.onShow();
  assert.equal(h.requests[0].url, `${base}/projects/${projectId}/fulfillment`);
  h.respond(0, summary());
  await loading;
  assert.equal(h.page.data.view.current.handoffId, "TN-SYNTHETIC-01");
  assert.equal(h.page.data.stageLabel, "交接结果待核实");
  assert.equal(h.page.data.view.current.tracking, null);
  assert.match(h.page.data.cancellationNotice, /人工核实/);
  h.page.onUnload();
});

test("production Page clears private progress at access expiry and ignores a response after departure", async () => {
  const h = await harness();
  h.page.onLoad({ projectId });
  const loading = h.page.onShow(),
    value = summary();
  value.accessExpiresAt = new Date(h.clock.now + 500).toISOString();
  h.respond(0, value);
  await loading;
  h.clock.now += 500;
  h.timers[h.timers.length - 1].callback();
  assert.equal(h.page.data.view, null);
  assert.equal(h.page.data.stageLabel, "");
  assert.match(h.page.data.status, /到期/);
  const next = h.page.onShow();
  h.page.onHide();
  h.respond(1, summary());
  await next;
  assert.equal(h.page.data.view, null);
  h.page.onUnload();
});

test("narrator explicitly grants only the current fixed production attempt and retries an uncertain grant with the same expiry and key", async () => {
  const h = await harness();
  h.page.onLoad({ projectId });
  const loading = h.page.onShow(),
    value = summary();
  value.current.state = "approved";
  value.canGrant = true;
  value.canGrantNarrator = true;
  value.grantMaxMinutes = 30;
  h.respond(0, value);
  await loading;
  await h.page.grant();
  assert.equal(
    h.requests.length,
    1,
    "grant requires a fresh affirmative choice and evidence",
  );
  h.page.chooseGrant();
  h.page.grantInput({
    currentTarget: { dataset: { field: "grantEvidence" } },
    detail: { value: "本人同意本次印制与配送资料交接" },
  });
  const granting = h.page.grant();
  assert.equal(
    h.requests[1].url,
    `${base}/projects/${projectId}/fulfillment/grants`,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(h.requests[1].data)), {
    attemptId,
    bookVersionId: value.current.bookVersionId,
    snapshotHash: "b".repeat(64),
    pdfHash: "f".repeat(64),
    addressHash: "c".repeat(64),
    expiresAt: new Date(h.clock.now + 600000).toISOString(),
    noticeVersion: "synthetic-d08-v1",
    evidenceRef: "synthetic:本人同意本次印制与配送资料交接",
  });
  const original = {
    data: structuredClone(h.requests[1].data),
    header: { ...h.requests[1].header },
  };
  h.requests[1].fail({ errMsg: "synthetic network unavailable" });
  await granting;
  h.clock.now += 1000;
  const retry = h.page.grant();
  assert.equal(
    h.requests[2].header["Idempotency-Key"],
    original.header["Idempotency-Key"],
  );
  assert.equal(h.requests[2].data.expiresAt, original.data.expiresAt);
  value.current.grantExpiresAt = original.data.expiresAt;
  h.respond(2, value);
  await retry;
  assert.equal(h.page.data.grantChecked, false);
  assert.equal(h.page.data.grantEvidence, "");
  assert.match(h.page.data.status, /限时授权已记录/);
  h.page.onUnload();
});

test("malformed production binding cannot enable a private handoff grant", async () => {
  const h = await harness();
  h.page.onLoad({ projectId });
  const loading = h.page.onShow(),
    value = summary();
  value.current.state = "approved";
  value.current.pdfHash = null;
  value.canGrant = true;
  value.canGrantNarrator = true;
  value.grantMaxMinutes = 30;
  h.respond(0, value);
  await loading;
  assert.equal(h.page.data.view, null);
  assert.equal(h.page.data.canGrant, false);
  h.page.onUnload();
});
