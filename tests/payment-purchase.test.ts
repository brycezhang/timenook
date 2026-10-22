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
function harness(
  storage = new Map<string, unknown>([
    ["timenook.mode.v1", "live"],
    [`timenook.session.v1:${base}`, token],
  ]),
) {
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
function reject(
  r: WechatMiniprogram.RequestOption,
  status: number,
  code: string,
) {
  r.success?.({
    statusCode: status,
    data: {
      error: { code, retryable: false },
      meta: { requestId: "rejected-create" },
    },
    header: {},
    cookies: [],
    errMsg: "ok",
  } as unknown as WechatMiniprogram.RequestSuccessCallbackResult);
}
function timeout(r: WechatMiniprogram.RequestOption) {
  r.fail?.({
    errMsg: "request:fail timeout",
  } as WechatMiniprogram.RequestFailCallbackErr);
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
test("a definitive create rejection lets the purchase page send the corrected region and recipient with a new intent", async () => {
  const { page, requests } = harness();
  page.setData({ packageVersionId: "44444444-4444-4444-8444-444444444444" });
  page.shippingRegion({ detail: { value: "CN-NOT-INCLUDED" } });
  page.customLabel({ detail: { value: "恩师" } });
  const rejected = page.verifyPurchase();
  const first = requests.shift()!;
  reject(first, 400, "INVALID_REQUEST");
  await rejected;
  page.shippingRegion({ detail: { value: "CN-110000" } });
  page.customLabel({ detail: { value: "老师" } });
  const corrected = page.verifyPurchase();
  const second = requests.shift()!;
  assert.equal(
    (second.data as { shippingRegionCode: string }).shippingRegionCode,
    "CN-110000",
  );
  assert.equal(
    (second.data as { recipient: { relationshipLabel: string } }).recipient
      .relationshipLabel,
    "老师",
  );
  assert.notEqual(
    second.header?.["Idempotency-Key"],
    first.header?.["Idempotency-Key"],
  );
  timeout(second);
  await corrected;
});
test("unknown or non-validation create failures preserve the original intent across page reentry and edited inputs", async () => {
  for (const outcome of [
    null,
    [401, "UNAUTHENTICATED"],
    [409, "IDEMPOTENCY_CONFLICT"],
    [500, "INTERNAL_ERROR"],
    [400, "INVALID_RESPONSE"],
  ] as const) {
    const firstPage = harness();
    firstPage.page.setData({
      packageVersionId: "44444444-4444-4444-8444-444444444444",
    });
    firstPage.page.shippingRegion({ detail: { value: "CN-110000" } });
    firstPage.page.customLabel({ detail: { value: "恩师" } });
    const action = firstPage.page.verifyPurchase();
    const first = firstPage.requests.shift()!;
    firstPage.page.onHide();
    if (outcome) reject(first, outcome[0], outcome[1]);
    else timeout(first);
    await action;
    // Re-authentication for the same buyer must not replace an unknown order.
    firstPage.storage.set(`timenook.session.v1:${base}`, token);
    const reentry = harness(firstPage.storage);
    reentry.page.setData({
      packageVersionId: "55555555-5555-4555-8555-555555555555",
    });
    reentry.page.shippingRegion({ detail: { value: "CN-CHANGED" } });
    reentry.page.customLabel({ detail: { value: "老师" } });
    const retry = reentry.page.verifyPurchase();
    const repeated = reentry.requests.shift()!;
    assert.equal(
      repeated.header?.["Idempotency-Key"],
      first.header?.["Idempotency-Key"],
    );
    assert.equal(JSON.stringify(repeated.data), JSON.stringify(first.data));
    timeout(repeated);
    await retry;
  }
});
test("a late rejection from the previous account cannot clear or replace either account's pending purchase", async () => {
  const first = harness();
  first.page.setData({
    packageVersionId: "44444444-4444-4444-8444-444444444444",
  });
  first.page.shippingRegion({ detail: { value: "CN-110000" } });
  first.page.customLabel({ detail: { value: "恩师" } });
  const pending = first.page.verifyPurchase();
  const original = first.requests.shift()!;
  first.page.onHide();
  first.storage.set(`timenook.session.v1:${base}`, {
    ...token,
    user: { id: "66666666-6666-4666-8666-666666666666" },
    session: {
      ...token.session,
      id: "77777777-7777-4777-8777-777777777777",
      token: "b".repeat(43),
    },
  });
  const other = harness(first.storage);
  other.page.setData({
    packageVersionId: "44444444-4444-4444-8444-444444444444",
  });
  other.page.shippingRegion({ detail: { value: "CN-110000" } });
  other.page.customLabel({ detail: { value: "妈妈" } });
  const otherAction = other.page.verifyPurchase();
  const otherRequest = other.requests.shift()!;
  assert.notEqual(
    otherRequest.header?.["Idempotency-Key"],
    original.header?.["Idempotency-Key"],
  );
  reject(original, 400, "INVALID_REQUEST");
  timeout(otherRequest);
  await Promise.all([pending, otherAction]);
  first.storage.set(`timenook.session.v1:${base}`, token);
  const returned = harness(first.storage);
  const retry = returned.page.verifyPurchase();
  const sameOrder = returned.requests.shift()!;
  assert.equal(
    sameOrder.header?.["Idempotency-Key"],
    original.header?.["Idempotency-Key"],
  );
  assert.equal(JSON.stringify(sameOrder.data), JSON.stringify(original.data));
  timeout(sameOrder);
  await retry;
});
