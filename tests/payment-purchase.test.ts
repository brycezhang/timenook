import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";
const base = "http://127.0.0.1:3417/v1";
const bundle = await build({
  entryPoints: ["miniprogram/pages/purchase/index.ts"],
  bundle: true,
  write: false,
  format: "cjs",
  platform: "neutral",
  define: {
    __TIMENOOK_API_BASE_URL__: JSON.stringify(base),
    __TIMENOOK_PAYMENT_VERIFICATION__: "true",
  },
});
const token = {
  user: { id: "11111111-1111-4111-8111-111111111111" },
  session: {
    id: "22222222-2222-4222-8222-222222222222",
    token: "a".repeat(43),
    expiresAt: "2099-01-01T00:00:00.000Z",
  },
};
const order = {
  id: "33333333-3333-4333-8333-333333333333",
  outTradeNo: "TN" + "a".repeat(30),
  amount: 99900,
  currency: "CNY",
  mode: "local-verification",
  state: "pending",
  recipient: { typeCode: null, relationshipLabel: "讲述者" },
  bookTitle: "我的时光手记",
  project: null,
};
function harness() {
  const storage = new Map<string, unknown>([
    ["timenook.mode.v1", "live"],
    [`timenook.session.v1:${base}`, token],
  ]);
  const requests: WechatMiniprogram.RequestOption[] = [];
  const calls: string[] = [];
  let page: any;
  runInNewContext(bundle.outputFiles[0].text, {
    Page(v: any) {
      page = v;
      page.setData = (p: object) => Object.assign(page.data, p);
    },
    wx: {
      getStorageSync: (k: string) => structuredClone(storage.get(k)),
      setStorageSync: (k: string, v: unknown) => storage.set(k, v),
      removeStorageSync: (k: string) => storage.delete(k),
      request: (r: WechatMiniprogram.RequestOption) => {
        requests.push(r);
        return {};
      },
      requestPayment: () => calls.push("native-payment"),
      navigateTo: ({ url }: { url: string }) => calls.push(url),
      showToast: () => {},
    },
  });
  return { page, requests, calls, storage };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
function respond(r: WechatMiniprogram.RequestOption, data: unknown) {
  r.success?.({
    statusCode: 200,
    data: { data, meta: { requestId: "synthetic" } },
    header: {},
    cookies: [],
    errMsg: "ok",
  } as unknown as WechatMiniprogram.RequestSuccessCallbackResult);
}
test("actual purchase action persists one local order intent, skips native payment for synthetic parameters and opens server order recovery", async () => {
  const { page, requests, calls } = harness();
  page.setData({
    packageVersionId: "44444444-4444-4444-8444-444444444444",
    shippingRegionCode: "CN-110000",
    selection: { recipientCode: null, customLabel: "恩师" },
    selectedLabel: "恩师",
  });
  const action = page.verifyPurchase();
  assert.equal(requests[0].url, base + "/orders");
  const key = requests[0].header?.["Idempotency-Key"];
  respond(requests.shift()!, order);
  await tick();
  respond(requests.shift()!, {
    mode: "local-verification",
    status: "prepared",
    parameters: {
      timeStamp: "1780000000",
      nonceStr: "synthetic",
      package: "prepay_id=synthetic",
      signType: "RSA",
      paySign: "synthetic",
    },
  });
  await tick();
  respond(requests.shift()!, order);
  await action;
  assert.deepEqual(calls, ["/pages/order/index?id=" + order.id]);
  const retry = page.verifyPurchase();
  assert.equal(requests[0].header?.["Idempotency-Key"], key);
  respond(requests.shift()!, order);
  await tick();
  respond(requests.shift()!, {
    mode: "local-verification",
    status: "unknown",
    parameters: null,
  });
  await tick();
  respond(requests.shift()!, order);
  await retry;
  assert.ok(!calls.includes("native-payment"));
});
