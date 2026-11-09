import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";
import { readFileSync } from "node:fs";
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
const liveBundle = await build({
  entryPoints: ["miniprogram/pages/purchase/index.ts"],
  bundle: true,
  write: false,
  format: "cjs",
  platform: "neutral",
  define: {
    __TIMENOOK_API_BASE_URL__: JSON.stringify(base),
    __TIMENOOK_NATIVE_RELEASE__: "true",
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
  listAmount: 99900,
  isE2e: false,
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
  live = false,
) {
  const requests: WechatMiniprogram.RequestOption[] = [];
  const calls: string[] = [];
  const payments: WechatMiniprogram.RequestPaymentOption[] = [];
  let page: any;
  runInNewContext((live ? liveBundle : bundle).outputFiles[0].text, {
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
      requestPayment: (p: WechatMiniprogram.RequestPaymentOption) => {
        calls.push("native-payment");
        payments.push(p);
      },
      navigateTo: ({ url }: { url: string }) => calls.push(url),
      showToast: () => {},
    },
  });
  return { page, requests, calls, storage, payments };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
test("purchase page offers checkout without collecting a shipping region", () => {
  const template = readFileSync(
    "miniprogram/pages/purchase/index.wxml",
    "utf8",
  );
  assert.doesNotMatch(
    template,
    /选择配送地区|<picker|shippingRegion|actualPrice|isE2e|受控|验收|0\.01/,
  );
  const disabled = template.match(
    /bindtap="pay"[^>]*disabled="\{\{(.*?)\}\}"/,
  )![1];
  assert.equal(
    runInNewContext(disabled, {
      verificationBusy: false,
      loading: false,
      hasOrderIntent: false,
      purchasable: true,
    }),
    false,
  );
});
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
    selection: { recipientCode: null, customLabel: "恩师" },
    selectedLabel: "恩师",
  });
  const action = page.verifyPurchase();
  assert.equal(requests[0].url, base + "/orders");
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
  assert.equal(requests[0].url, base + "/orders/" + order.id);
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
test("a definitive create rejection lets the purchase page correct the recipient with a new intent", async () => {
  const { page, requests } = harness();
  page.setData({ packageVersionId: "44444444-4444-4444-8444-444444444444" });
  page.customLabel({ detail: { value: "恩师" } });
  const rejected = page.verifyPurchase();
  const first = requests.shift()!;
  reject(first, 400, "INVALID_REQUEST");
  await rejected;
  assert.equal(page.data.hasOrderIntent, false);
  page.customLabel({ detail: { value: "老师" } });
  const corrected = page.verifyPurchase();
  const second = requests.shift()!;
  assert.equal("shippingRegionCode" in (second.data as object), false);
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

const nativeOrder = {
  ...order,
  mode: "wechat",
  listAmount: 99900,
  amount: 1,
  isE2e: true,
};
const paidNativeOrder = {
  ...nativeOrder,
  state: "paid",
  project: {
    id: "88888888-8888-4888-8888-888888888888",
    subject: { id: "99999999-9999-4999-8999-999999999999" },
    entitlement: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", copies: 1 },
  },
};

test("a fresh book opens native payment for a new order even when a previous order is cached", async () => {
  const h = harness(undefined, true);
  h.storage.set(`timenook.payment-intent.v1:${base}:${token.user.id}`, {
    key: "previous-purchase",
    command: { bookTitle: "上一本书" },
    orderId: order.id,
  });
  h.page.onLoad({ bookTitle: encodeURIComponent("我") });
  const shown = h.page.onShow();
  respond(
    h.requests.find((r) => r.url.endsWith("recipient-types"))!,
    {
      types: [],
      customLabelAllowed: true,
      scope: "one_adult_subject_one_initiator",
    },
  );
  respond(
    h.requests.find((r) => r.url.endsWith("packages/current"))!,
    {
      purchasable: true,
      reason: "E2E_ONLY",
      checkout: { listAmount: 99900, amount: 1, currency: "CNY", isE2e: true },
      version: {
        id: "44444444-4444-4444-8444-444444444444",
        purpose: "e2e",
        title: "故事记录与整理",
        price: { value: 99900, unit: "fen", currency: "CNY" },
        scope: {
          projects: 1,
          adultSubjects: 1,
          initiators: 1,
          firstCopies: 1,
          agreedShippingIncluded: true,
          completeExportIncluded: true,
        },
        shippingRegions: [],
        terms: [],
      },
    },
  );
  await tick();
  assert.equal(h.page.data.hasOrderIntent, false);
  await shown;
  assert.equal(h.requests.length, 2);
  assert.equal(h.payments.length, 0);
  h.requests.length = 0;

  const action = h.page.pay();
  const create = h.requests.shift()!;
  assert.equal(create.url, base + "/orders");
  assert.equal((create.data as { bookTitle: string }).bookTitle, "我");
  assert.notEqual(create.header?.["Idempotency-Key"], "previous-purchase");
  const newOrder = {
    ...nativeOrder,
    id: "66666666-6666-4666-8666-666666666666",
    bookTitle: "我",
  };
  respond(create, newOrder);
  await tick();
  const prepare = h.requests.shift()!;
  assert.equal(prepare.url, base + "/orders/" + newOrder.id + "/payment");
  respond(prepare, {
    mode: "wechat",
    status: "prepared",
    parameters: {
      timeStamp: "1780000000",
      nonceStr: "native",
      package: "prepay_id=new-book",
      signType: "RSA",
      paySign: "signed",
    },
  });
  await tick();
  assert.equal(h.payments[0]?.package, "prepay_id=new-book");
  assert.deepEqual(h.calls, ["native-payment"]);
  h.payments[0].fail?.({ errMsg: "requestPayment:fail cancel" });
  await tick();
  respond(h.requests.shift()!, newOrder);
  await action;
  assert.deepEqual(h.calls, [
    "native-payment",
    "/pages/order/index?id=" + newOrder.id,
  ]);
});

test("release checkout keeps the created order on the same page and queries it after cancellation", async () => {
  const h = harness(undefined, true);
  h.page.setData({
    purchasable: true,
    agreed: true,
    packageVersionId: "44444444-4444-4444-8444-444444444444",
    selection: { recipientCode: null, customLabel: "恩师" },
    selectedLabel: "恩师",
  });
  const action = h.page.pay();
  assert.equal(h.requests[0]?.url, base + "/orders");
  assert.equal("amount" in (h.requests[0].data as object), false);
  assert.equal("shippingRegionCode" in (h.requests[0].data as object), false);
  const intents = () =>
    [...h.storage.entries()].filter(([k]) =>
      k.startsWith("timenook.payment-intent"),
    );
  assert.equal(intents().length, 1);
  assert.equal(h.page.data.hasOrderIntent, true);
  respond(h.requests.shift()!, nativeOrder);
  await tick();
  assert.equal(intents().length, 0);
  assert.equal(h.page.data.restoredOrder.id, order.id);
  respond(h.requests.shift()!, {
    mode: "wechat",
    status: "prepared",
    parameters: {
      timeStamp: "1780000000",
      nonceStr: "native",
      package: "prepay_id=native",
      signType: "RSA",
      paySign: "signed",
    },
  });
  await tick();
  assert.equal(h.payments.length, 1);
  h.payments[0].fail?.({ errMsg: "requestPayment:fail cancel" });
  await tick();
  assert.equal(h.requests[0].url, base + "/orders/" + order.id);
  respond(h.requests.shift()!, nativeOrder);
  await action;
  assert.equal(h.calls.at(-1), "/pages/order/index?id=" + order.id);

  h.page.onHide();
  const shown = h.page.onShow();
  const recipients = h.requests.find((r) => r.url.endsWith("recipient-types"))!;
  const current = h.requests.find((r) => r.url.endsWith("packages/current"))!;
  respond(recipients, {
    types: [],
    customLabelAllowed: true,
    scope: "one_adult_subject_one_initiator",
  });
  respond(current, {
    purchasable: false,
    reason: "PACKAGE_PREPARING",
    version: null,
    checkout: null,
  });
  await tick();
  assert.equal(h.requests.at(-1)?.url, base + "/orders/" + order.id);
  respond(h.requests.at(-1)!, paidNativeOrder);
  await shown;
  assert.equal(h.page.data.hasOrderIntent, true);
  assert.equal(
    h.page.data.restoredOrder.project.id,
    paidNativeOrder.project.id,
  );
  assert.equal("actualPrice" in h.page.data, false);
  assert.equal(h.payments.length, 1);
});
