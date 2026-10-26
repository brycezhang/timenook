import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";
const base = "https://example.test/timenook/v1",
  id = "33333333-3333-4333-8333-333333333333";
const bundled = await build({
  entryPoints: ["miniprogram/pages/refunds/index.ts"],
  bundle: true,
  write: false,
  format: "cjs",
  platform: "neutral",
  define: { __TIMENOOK_API_BASE_URL__: JSON.stringify(base) },
});
function harness() {
  const storage = new Map<string, unknown>([
    ["timenook.mode.v1", "live"],
    [
      `timenook.session.v1:${base}`,
      {
        user: { id },
        session: {
          id,
          token: "a".repeat(43),
          expiresAt: "2099-01-01T00:00:00Z",
        },
      },
    ],
  ]);
  const calls: any[] = [];
  let page: any;
  runInNewContext(bundled.outputFiles[0].text, {
    Page(p: any) {
      page = p;
      page.setData = (x: object) => Object.assign(page.data, x);
    },
    wx: {
      getStorageSync: (k: string) => storage.get(k),
      setStorageSync: (k: string, v: unknown) => storage.set(k, v),
      removeStorageSync: (k: string) => storage.delete(k),
      request: (r: unknown) => {
        calls.push(r);
        return { abort() {} };
      },
      reLaunch() {},
      navigateTo() {},
      showToast() {},
    },
    setTimeout,
    clearTimeout,
  });
  return { page, calls };
}
function success(call: any, data: unknown, statusCode = 200) {
  call.success({
    statusCode,
    data: { data, meta: { requestId: "synthetic" } },
    header: {},
    cookies: [],
  });
}
const tick = () => new Promise((r) => setImmediate(r));
const initial = {
  orderId: id,
  paidAmountFen: 99900,
  refundedAmountFen: 0,
  reservedAmountFen: 0,
  availableAmountFen: 99900,
  productionFrozen: false,
  creationState: "active",
  refunds: [],
};
test("refund page loads the buyer's actual amounts and retains one uncertain application intent", async () => {
  const { page, calls } = harness();
  page.onLoad({ orderId: id });
  const shown = page.onShow();
  await tick();
  assert.equal(calls[0].url, `${base}/orders/${id}/refunds`);
  success(calls[0], initial);
  await shown;
  assert.equal(page.data.view.paidAmountFen, 99900);
  assert.equal(page.data.rows.length, 0);
  page.setData({ description: "尚未参与，希望取消购买" });
  const first = page.apply();
  await tick();
  const request = calls[1];
  assert.equal(request.method, "POST");
  assert.equal(request.data.reason, "notParticipated");
  request.fail({ errMsg: "timeout" });
  await first;
  const retry = page.apply();
  await tick();
  assert.equal(
    calls[2].header["Idempotency-Key"],
    request.header["Idempotency-Key"],
  );
  success(calls[2], { id, caseId: id, state: "requested" }, 201);
  await tick();
  success(calls[3], {
    ...initial,
    refunds: [
      {
        id,
        caseId: id,
        state: "requested",
        amountFen: null,
        reason: "notParticipated",
      },
    ],
  });
  await retry;
  assert.equal(page.data.rows[0].stateLabel, "待客服核验");
});
test("refund page clears money and ignores a response after leaving the account context", async () => {
  const { page, calls } = harness();
  page.onLoad({ orderId: id });
  const showing = page.onShow();
  await tick();
  page.onHide();
  success(calls[0], initial);
  await showing;
  assert.equal(page.data.view, null);
  assert.equal(page.data.rows.length, 0);
});
