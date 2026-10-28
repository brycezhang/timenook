import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";
const base = "https://example.test/timenook/v1";
const bundle = await build({
  entryPoints: ["miniprogram/services/payments.ts"],
  bundle: true,
  write: false,
  format: "cjs",
  platform: "neutral",
  define: { __TIMENOOK_API_BASE_URL__: JSON.stringify(base) },
});
const id = "33333333-3333-4333-8333-333333333333";
const order = {
  id,
  outTradeNo: "TN" + "a".repeat(30),
  amount: 99900,
  currency: "CNY",
  mode: "local-verification",
  state: "pending",
  recipient: { typeCode: null, relationshipLabel: "讲述者" },
  bookTitle: "我的时光手记",
  project: null,
};
const params = {
  timeStamp: "1780000000",
  nonceStr: "synthetic",
  package: "prepay_id=synthetic",
  signType: "RSA",
  paySign: "synthetic-signature",
};
function harness() {
  const storage = new Map<string, unknown>([
    ["timenook.mode.v1", "live"],
    [
      `timenook.session.v1:${base}`,
      {
        user: { id: "11111111-1111-4111-8111-111111111111" },
        session: {
          id: "22222222-2222-4222-8222-222222222222",
          token: "a".repeat(43),
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
      },
    ],
  ]);
  const requests: WechatMiniprogram.RequestOption[] = [];
  const payments: WechatMiniprogram.RequestPaymentOption[] = [];
  const module = { exports: {} as any };
  runInNewContext(bundle.outputFiles[0].text, {
    module,
    exports: module.exports,
    wx: {
      getStorageSync: (key: string) => structuredClone(storage.get(key)),
      setStorageSync: (key: string, value: unknown) => storage.set(key, value),
      removeStorageSync: (key: string) => storage.delete(key),
      request: (r: WechatMiniprogram.RequestOption) => {
        requests.push(r);
        return {};
      },
      requestPayment: (p: WechatMiniprogram.RequestPaymentOption) =>
        payments.push(p),
    },
  });
  return {
    client: module.exports.paymentClient,
    status: module.exports.paymentStatus,
    requests,
    payments,
    storage,
  };
}
function respond(request: WechatMiniprogram.RequestOption, data: unknown) {
  request.success?.({
    statusCode: 200,
    data: { data, meta: { requestId: "synthetic" } },
    header: {},
    cookies: [],
    errMsg: "ok",
  } as unknown as WechatMiniprogram.RequestSuccessCallbackResult);
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
test("real merchant orders retain their mode and payment progress is not labelled synthetic", async () => {
  const { client, status, requests } = harness();
  const pending = client.get(id);
  respond(requests.shift()!, { ...order, mode: "wechat" });
  const result = await pending;
  assert.equal(result.mode, "wechat");
  assert.equal(status(result), "订单待付款核验 · 尚未发放权益");
  assert.equal(status({ ...result, state: "paid" }), "付款核验完成");
});
test("native success, cancellation, failure and timeout all resolve authority by querying the server", async () => {
  for (const outcome of ["success", "cancel", "fail", "timeout"]) {
    const { client, requests, payments } = harness();
    const running = client.pay(id, { localOnly: false, isCurrent: () => true });
    assert.equal(requests[0].method, "POST");
    respond(requests.shift()!, {
      mode: "wechat",
      status: "prepared",
      parameters: params,
    });
    await tick();
    assert.equal(payments.length, 1);
    if (outcome === "success")
      payments[0].success?.({ errMsg: "requestPayment:ok" });
    else payments[0].fail?.({ errMsg: "requestPayment:fail " + outcome });
    await tick();
    assert.equal(requests[0].url, base + "/orders/" + id);
    respond(requests.shift()!, order);
    assert.equal((await running).project, null);
  }
});
test("synthetic parameters never launch native payment, and account/page changes discard old preparation", async () => {
  for (const boundary of ["synthetic", "page", "account"]) {
    const { client, requests, payments, storage } = harness();
    let current = true;
    const running = client.pay(id, {
      localOnly: true,
      isCurrent: () => current,
    });
    const rejected =
      boundary === "account"
        ? assert.rejects(running, /账号已切换/)
        : undefined;
    if (boundary === "page") current = false;
    if (boundary === "account") storage.delete(`timenook.session.v1:${base}`);
    respond(requests.shift()!, {
      mode: "local-verification",
      status: "prepared",
      parameters: params,
    });
    await tick();
    assert.equal(payments.length, 0);
    if (boundary === "account") {
      await rejected;
      assert.equal(requests.length, 0);
    } else {
      respond(requests.shift()!, order);
      await running;
    }
  }
});
