import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";
const base = "https://example.test/timenook/v1";
const bundle = await build({
  entryPoints: ["miniprogram/pages/order/index.ts"],
  bundle: true,
  write: false,
  format: "cjs",
  platform: "neutral",
  define: { __TIMENOOK_API_BASE_URL__: JSON.stringify(base) },
});
const login = {
  user: { id: "11111111-1111-4111-8111-111111111111" },
  session: {
    id: "22222222-2222-4222-8222-222222222222",
    token: "a".repeat(43),
    expiresAt: "2099-01-01T00:00:00.000Z",
  },
};
const pendingOrder = {
  id: "33333333-3333-4333-8333-333333333333",
  outTradeNo: "TN" + "a".repeat(30),
  amount: 99900,
  currency: "CNY",
  mode: "local-verification",
  state: "pending",
  recipient: { typeCode: null, relationshipLabel: "恩师" },
  bookTitle: "我的时光手记",
  project: null,
};
const paidOrder = {
  ...pendingOrder,
  state: "paid",
  project: {
    id: "44444444-4444-4444-8444-444444444444",
    subject: {
      id: "55555555-5555-4555-8555-555555555555",
      name: null,
      consent: "not_granted",
    },
    entitlement: {
      id: "66666666-6666-4666-8666-666666666666",
      state: "available",
      copies: 1,
    },
    bookTitle: "我的时光手记",
    recipient: pendingOrder.recipient,
    plan: { revision: 1, chapters: [] },
    terms: { policyStatus: "synthetic-fixed-policy" },
  },
};
function harness() {
  const storage = new Map<string, unknown>([
    ["timenook.mode.v1", "live"],
    [`timenook.session.v1:${base}`, login],
  ]);
  const requests: WechatMiniprogram.RequestOption[] = [];
  const routes: string[] = [];
  let page: any;
  runInNewContext(bundle.outputFiles[0].text, {
    Page(value: any) {
      page = value;
      page.setData = (patch: object) => Object.assign(page.data, patch);
    },
    wx: {
      getStorageSync: (key: string) => structuredClone(storage.get(key)),
      setStorageSync: (key: string, value: unknown) => storage.set(key, value),
      removeStorageSync: (key: string) => storage.delete(key),
      request: (r: WechatMiniprogram.RequestOption) => {
        requests.push(r);
        return {};
      },
      reLaunch: ({ url }: { url: string }) => routes.push(url),
      navigateTo: ({ url }: { url: string }) => routes.push(url),
      showToast: () => {},
    },
  });
  return { page, requests, storage, routes };
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
test("actual live order page restores server orders and the same paid project after reentry without reading demo projects", async () => {
  const { page, requests, routes } = harness();
  page.onLoad?.({});
  const showing = page.onShow();
  assert.equal(requests[0]?.url, base + "/orders");
  respond(requests.shift()!, { orders: [pendingOrder] });
  await tick();
  assert.equal(requests[0]?.url, base + "/orders/" + pendingOrder.id);
  respond(requests.shift()!, paidOrder);
  await showing;
  assert.equal(page.data.activeOrder.project.id, paidOrder.project.id);
  assert.match(page.data.paymentStatus, /合成|模拟/);
  assert.deepEqual(routes, []);
  page.onHide();
  const reentry = page.onShow();
  respond(requests.shift()!, { orders: [paidOrder] });
  await tick();
  respond(requests.shift()!, paidOrder);
  await reentry;
  assert.equal(
    page.data.activeOrder.project.entitlement.id,
    paidOrder.project.entitlement.id,
  );
});
test("order page discards late results after a page or account switch", async () => {
  for (const switchKind of ["page", "account"]) {
    const { page, requests, storage } = harness();
    const action = page.onShow();
    respond(requests.shift()!, { orders: [pendingOrder] });
    await tick();
    if (switchKind === "page") page.onHide();
    else storage.delete(`timenook.session.v1:${base}`);
    respond(requests.shift()!, paidOrder);
    await action;
    assert.equal(page.data.activeOrder, null);
  }
});
