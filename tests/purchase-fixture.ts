import { build } from "esbuild";
import { runInNewContext } from "node:vm";
export const base = "https://purchase.example.test/v1";
export const login = {
  user: { id: "11111111-1111-4111-8111-111111111111" },
  session: {
    id: "22222222-2222-4222-8222-222222222222",
    token: "a".repeat(43),
    expiresAt: "2099-01-01T00:00:00Z",
  },
};
export const offer = {
  purchasable: true,
  reason: "AVAILABLE",
  checkout: { listAmount: 99900, amount: 99900, currency: "CNY", isE2e: false },
  version: {
    id: "44444444-4444-4444-8444-444444444444",
    purpose: "production",
    title: "时光故事套餐",
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
};
export const pendingOrder = {
  id: "33333333-3333-4333-8333-333333333333",
  outTradeNo: "TN" + "a".repeat(30),
  amount: 99900,
  listAmount: 99900,
  isE2e: false,
  currency: "CNY",
  mode: "wechat",
  state: "pending",
  paymentStatus: "pending",
  purchaseKind: "gift",
  recipient: { typeCode: null, relationshipLabel: "妈妈" },
  bookTitle: "妈妈的故事",
  project: null,
};
export const paidOrder = {
  ...pendingOrder,
  state: "paid",
  paymentStatus: "paid",
  project: {
    id: "55555555-5555-4555-8555-555555555555",
    bookTitle: pendingOrder.bookTitle,
    subject: { id: "66666666-6666-4666-8666-666666666666", boundUserId: null },
    entitlement: {
      id: "77777777-7777-4777-8777-777777777777",
      state: "available",
      copies: 1,
    },
  },
};
export const parameters = {
  timeStamp: "1780000000",
  nonceStr: "synthetic",
  package: "prepay_id=synthetic",
  signType: "RSA",
  paySign: "synthetic-signature",
};
const bundles = new Map<string, string>();
export async function purchasePage(
  pageName: string,
  storage = new Map<string, unknown>([[`timenook.session.v1:${base}`, login]]),
) {
  if (!bundles.has(pageName)) {
    const bundle = await build({
      entryPoints: [`miniprogram/pages/${pageName}/index.ts`],
      bundle: true,
      write: false,
      platform: "neutral",
      format: "cjs",
      define: {
        __TIMENOOK_API_BASE_URL__: JSON.stringify(base),
        __TIMENOOK_NATIVE_RELEASE__: "true",
      },
    });
    bundles.set(pageName, bundle.outputFiles[0].text);
  }
  const requests: WechatMiniprogram.RequestOption[] = [],
    routes: string[] = [],
    payments: WechatMiniprogram.RequestPaymentOption[] = [];
  let page: any;
  runInNewContext(bundles.get(pageName)!, {
    Page(value: any) {
      page = value;
      page.setData = (patch: object) => Object.assign(page.data, patch);
    },
    wx: {
      getStorageSync: (key: string) => structuredClone(storage.get(key)),
      setStorageSync: (key: string, value: unknown) =>
        storage.set(key, structuredClone(value)),
      removeStorageSync: (key: string) => storage.delete(key),
      request: (r: WechatMiniprogram.RequestOption) => {
        requests.push(r);
        return {};
      },
      requestPayment: (p: WechatMiniprogram.RequestPaymentOption) =>
        payments.push(p),
      navigateTo: ({ url }: { url: string }) => routes.push(url),
      switchTab: ({ url }: { url: string }) => routes.push(url),
      showToast() {},
    },
  });
  return { page, requests, routes, payments, storage };
}
export function respond(r: WechatMiniprogram.RequestOption, data: unknown) {
  r.success?.({
    statusCode: 200,
    data: { data, meta: { requestId: "synthetic" } },
    header: {},
    cookies: [],
    errMsg: "ok",
  } as any);
}
export function timeout(r: WechatMiniprogram.RequestOption) {
  r.fail?.({ errMsg: "request:fail timeout", errno: 5, exception: { reasons: [], retryCount: 0 }, useHttpDNS: false });
}
export const tick = () => new Promise((resolve) => setImmediate(resolve));
export async function checkoutPage(
  storage?: Map<string, unknown>,
  kind = "gift",
) {
  const h = await purchasePage("purchase", storage);
  h.page.onLoad({
    bookTitle: encodeURIComponent("妈妈的故事"),
    relationship: encodeURIComponent(kind === "self" ? "自己" : "妈妈"),
    purchaseKind: kind,
  });
  const load = h.page.onShow();
  respond(h.requests.shift()!, offer);
  await load;
  return h;
}
