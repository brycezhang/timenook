import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
const bundle = await build({
  entryPoints: ["miniprogram/pages/purchase/index.ts"],
  bundle: true,
  write: false,
  format: "cjs",
  platform: "neutral",
  define: {
    __TIMENOOK_API_BASE_URL__: JSON.stringify(
      "https://example.test/timenook/v1",
    ),
  },
});
interface CatalogPage {
  data: {
    mode: string;
    loading: boolean;
    catalogError: string;
    recipientTypes: { code: string; label: string; revision: number }[];
    packagePrice: string;
    packageTerms: { label: string; text: string }[];
    packageTitle: string;
    availability: string;
    selectedLabel: string;
    selection: unknown;
  };
  setData(patch: Partial<CatalogPage["data"]>): void;
  onLoad(q: Record<string, string>): void;
  onShow(): Promise<void>;
  onHide(): void;
  chooseType(event: { currentTarget: { dataset: { code: string } } }): void;
  customLabel(event: { detail: { value: string } }): void;
  pay(): void;
}
function harness(mode = "live") {
  const storage = new Map<string, unknown>([["timenook.mode.v1", mode]]);
  const requests: WechatMiniprogram.RequestOption[] = [];
  const sideEffects: string[] = [];
  let page!: CatalogPage;
  runInNewContext(bundle.outputFiles[0].text, {
    Page(definition: CatalogPage) {
      page = definition;
      page.setData = (patch) => Object.assign(page.data, patch);
    },
    wx: {
      getStorageSync: (key: string) => structuredClone(storage.get(key)),
      setStorageSync: (key: string, value: unknown) => {
        sideEffects.push(key);
        storage.set(key, structuredClone(value));
      },
      request: (request: WechatMiniprogram.RequestOption) => {
        requests.push(request);
        return {};
      },
      reLaunch: () => sideEffects.push("navigate"),
      showToast: () => {},
      showModal: () => sideEffects.push("modal"),
      requestPayment: () => sideEffects.push("payment"),
    },
  });
  return { page, storage, requests, sideEffects };
}
const directory = {
  types: [
    { code: "mentor", label: "恩师", revision: 2 },
    { code: "friend", label: "朋友", revision: 1 },
  ],
  customLabelAllowed: true,
  scope: "one_adult_subject_one_initiator",
};
const offer = {
  purchasable: false,
  reason: "PREVIEW_ONLY",
  version: {
    id: "11111111-1111-4111-8111-111111111111",
    sequence: 1,
    purpose: "local_preview",
    title: "合成套餐预览",
    price: { value: 99900, unit: "fen", currency: "CNY" },
    scope: {
      projects: 1,
      adultSubjects: 1,
      initiators: 1,
      firstCopies: 1,
      agreedShippingIncluded: true,
      completeExportIncluded: true,
    },
    terms: [
      { label: "配送范围", text: "约定运费包含，北京地区（合成）" },
      { label: "制作期限", text: "参与后180天（合成）" },
      { label: "退款与售后", text: "按已公示条款核验处理（合成）" },
    ],
  },
};
function respond(
  request: WechatMiniprogram.RequestOption,
  data: unknown,
  statusCode = 200,
) {
  request.success?.({
    statusCode,
    data: { data, meta: { requestId: "synthetic" } },
    header: {},
    cookies: [],
    errMsg: "request:ok",
  } as unknown as WechatMiniprogram.RequestSuccessCallbackResult);
}
function complete(requests: WechatMiniprogram.RequestOption[]) {
  for (const request of requests)
    respond(
      request,
      request.url.endsWith("recipient-types") ? directory : offer,
    );
}

test("live purchase displays server relationships and the same package, supports a custom label without making a global type or project", async () => {
  const { page, requests, sideEffects } = harness();
  page.onLoad({});
  const loading = page.onShow();
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map((request) => request.url).sort(), [
    "https://example.test/timenook/v1/packages/current",
    "https://example.test/timenook/v1/recipient-types",
  ]);
  complete(requests);
  await loading;
  assert.deepEqual(
    Array.from(page.data.recipientTypes, (item) => item.label),
    ["恩师", "朋友"],
  );
  assert.equal(page.data.packagePrice, "999.00");
  assert.equal(page.data.availability, "套餐准备中，暂未开放购买");
  page.chooseType({ currentTarget: { dataset: { code: "mentor" } } });
  assert.equal(page.data.selectedLabel, "恩师");
  assert.equal(
    JSON.stringify(page.data.selection),
    JSON.stringify({
      recipientCode: "mentor",
      recipientRevision: 2,
      customLabel: null,
    }),
  );
  page.customLabel({ detail: { value: "  老同学  " } });
  assert.equal(page.data.selectedLabel, "老同学");
  assert.equal(
    JSON.stringify(page.data.selection),
    JSON.stringify({
      recipientCode: null,
      recipientRevision: null,
      customLabel: "老同学",
    }),
  );
  page.pay();
  assert.equal(requests.length, 2);
  assert.deepEqual(sideEffects, []);
});

test("late catalog responses after leaving or switching to demo cannot restore stale live offers", async () => {
  const { page, requests, storage } = harness();
  page.onLoad({});
  const first = page.onShow();
  page.onHide();
  storage.set("timenook.mode.v1", "demo");
  await page.onShow();
  complete(requests);
  await first;
  assert.equal(page.data.mode, "demo");
  assert.equal(page.data.packagePrice, "");
  assert.equal(page.data.recipientTypes.length, 0);
  storage.set("timenook.mode.v1", "live");
  const second = page.onShow();
  complete(requests.slice(2));
  await second;
  assert.equal(page.data.packagePrice, "999.00");
});

test("failed catalog refresh clears the previous offer and allows an explicit retry without falling back to demo", async () => {
  const { page, requests, sideEffects } = harness();
  page.onLoad({});
  const initial = page.onShow();
  complete(requests);
  await initial;
  const failed = page.onShow();
  requests[2].fail?.({
    errMsg: "synthetic offline",
  } as WechatMiniprogram.RequestFailCallbackErr);
  respond(requests[3], offer);
  await failed;
  assert.equal(page.data.packagePrice, "");
  assert.equal(page.data.recipientTypes.length, 0);
  assert.match(page.data.catalogError, /加载失败/);
  assert.equal(page.data.mode, "live");
  page.pay();
  assert.deepEqual(sideEffects, []);
  const retry = page.onShow();
  complete(requests.slice(4));
  await retry;
  assert.equal(page.data.packagePrice, "999.00");
  assert.equal(page.data.catalogError, "");
});

test("an older refresh cannot overwrite the newest catalog, including an empty catalog or unavailable package", async () => {
  const { page, requests } = harness();
  page.onLoad({});
  const old = page.onShow();
  const latest = page.onShow();
  respond(requests[2], { ...directory, types: [] });
  respond(requests[3], {
    purchasable: false,
    reason: "PACKAGE_PREPARING",
    version: null,
  });
  await latest;
  complete(requests.slice(0, 2));
  await old;
  assert.equal(page.data.recipientTypes.length, 0);
  assert.equal(page.data.packagePrice, "");
  assert.equal(page.data.selection, null);
  page.customLabel({ detail: { value: "朋友" } });
  assert.equal(page.data.selectedLabel, "朋友");
  page.customLabel({ detail: { value: " " } });
  assert.equal(page.data.selection, null);
  page.customLabel({ detail: { value: "称".repeat(41) } });
  assert.equal(page.data.selection, null);
});

test("invalid HTTP payloads do not create a buyable offer and demo mode makes no catalog requests", async () => {
  const { page, requests, sideEffects } = harness();
  page.onLoad({});
  const loading = page.onShow();
  respond(requests[0], directory);
  respond(requests[1], { ...offer, purchasable: true });
  await loading;
  assert.match(page.data.catalogError, /加载失败/);
  assert.equal(page.data.packagePrice, "");
  page.pay();
  assert.deepEqual(sideEffects, []);
  const demo = harness("demo");
  demo.page.onLoad({});
  await demo.page.onShow();
  assert.equal(demo.requests.length, 0);
  assert.equal(demo.page.data.mode, "demo");
});
