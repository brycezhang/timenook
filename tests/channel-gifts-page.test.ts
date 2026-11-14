import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";
const base = "https://example.test/api/v1",
  id = "33333333-3333-4333-8333-333333333333";
const tick = () => new Promise((r) => setImmediate(r));
async function harness(name: string, storage = new Map<string, any>()) {
  storage.set("timenook.mode.v1", "live");
  storage.set(`timenook.session.v1:${base}`, {
    user: { id: "11111111-1111-4111-8111-111111111111" },
    session: {
      id: "22222222-2222-4222-8222-222222222222",
      token: "a".repeat(43),
      expiresAt: "2099-01-01T00:00:00Z",
    },
  });
  const bundle = await build({
    entryPoints: [`miniprogram/pages/${name}/index.ts`],
    bundle: true,
    write: false,
    format: "cjs",
    platform: "neutral",
    define: { __TIMENOOK_API_BASE_URL__: JSON.stringify(base) },
  });
  let page: any;
  const requests: any[] = [],
    routes: string[] = [],
    modals: any[] = [];
  runInNewContext(bundle.outputFiles[0].text, {
    setTimeout,
    clearTimeout,
    Page(p: any) {
      page = p;
      page.setData = (v: any) => Object.assign(page.data, v);
    },
    wx: {
      env: { USER_DATA_PATH: "/tmp" },
      getStorageSync: (k: string) => structuredClone(storage.get(k) ?? ""),
      setStorageSync: (k: string, v: any) => storage.set(k, structuredClone(v)),
      removeStorageSync: (k: string) => storage.delete(k),
      request: (r: any) => requests.push(r),
      navigateTo: ({ url }: any) => routes.push(url),
      switchTab: ({ url }: any) => routes.push(url),
      redirectTo: ({ url }: any) => routes.push(url),
      showModal: (v: any) =>
        new Promise((resolve) => modals.push({ ...v, success: resolve })),
      showTabBar() {},
      hideTabBar() {},
      pageScrollTo() {},
    },
  });
  function respond(suffix: string, data: any) {
    const i = requests.findIndex((r) => r.url.endsWith(suffix));
    assert.notEqual(i, -1, suffix);
    requests
      .splice(i, 1)[0]
      .success({ statusCode: 200, data: { data, meta: { requestId: id } } });
  }
  return { page, requests, routes, modals, storage, respond };
}
test("channel form reads without activation and confirms self book directly", async () => {
  const h = await harness("new-book");
  h.page.onLoad({ channelGiftId: id });
  const loading = h.page.onShow();
  h.respond("/channel-gifts", [
    { id, state: "active", projectId: null, paidAmount: null },
  ]);
  await loading;
  assert.equal(h.requests.length, 0);
  h.page.chooseRelationship({
    currentTarget: { dataset: { relationship: "自己" } },
  });
  const saving = h.page.next();
  assert.equal(h.requests[0].url, `${base}/channel-gifts/${id}/activate`);
  assert.equal(h.requests[0].data.bookTitle, "我的故事");
  h.respond(`/channel-gifts/${id}/activate`, {
    id,
    projectId: id,
    purchaseKind: "self",
  });
  await saving;
  assert.deepEqual(h.routes, ["/pages/home/index"]);
});
test("a lost activation response keeps the exact command on re-entry", async () => {
  const h = await harness("new-book");
  h.page.onLoad({ channelGiftId: id });
  let loading = h.page.onShow();
  h.respond("/channel-gifts", [{ id, state: "active", projectId: null }]);
  await loading;
  h.page.chooseRelationship({
    currentTarget: { dataset: { relationship: "妈妈" } },
  });
  const saving = h.page.next();
  const first = h.requests.shift();
  first.fail({ errMsg: "timeout" });
  await saving;
  const restored = await harness("new-book", h.storage);
  restored.page.onLoad({ channelGiftId: id });
  loading = restored.page.onShow();
  restored.respond("/channel-gifts", [
    { id, state: "active", projectId: null },
  ]);
  await loading;
  const retry = restored.page.next();
  assert.deepEqual(
    JSON.parse(JSON.stringify(restored.requests[0].data)),
    JSON.parse(JSON.stringify(first.data)),
  );
  restored.respond(`/channel-gifts/${id}/activate`, {
    id,
    projectId: id,
    purchaseKind: "gift",
  });
  await retry;
  assert.deepEqual(restored.routes, [
    `/pages/gift-recipient/index?projectId=${id}`,
  ]);
});
test("account merges reminders, persists later and keeps the real pending count", async () => {
  const h = await harness("account");
  const showing = h.page.onShow();
  h.respond("/users/me", {
    id: "11111111-1111-4111-8111-111111111111",
    nickname: "小陈",
  });
  await showing;
  await tick();
  h.respond("/channel-gifts/reminders", {
    newGiftIds: [id],
    newCount: 1,
    pendingCount: 2,
  });
  await tick();
  assert.equal(h.page.data.pendingGifts, 2);
  assert.equal(h.modals[0].title, "你有 1 份新礼物待送出");
  h.modals[0].success({ cancel: true, confirm: false });
  await tick();
  h.respond("/channel-gifts/reminders/handle", {
    newGiftIds: [],
    newCount: 0,
    pendingCount: 2,
  });
  await tick();
  assert.equal(h.page.data.pendingGifts, 2);
  assert.equal(h.routes.length, 0);
});
test("a stale channel form rereads current ownership and disables void or reassigned gifts", async () => {
  for (const rows of [[], [{ id, state: "void", projectId: null }]]) {
    const h = await harness("new-book");
    h.page.onLoad({ channelGiftId: id });
    const show = h.page.onShow();
    h.respond("/channel-gifts", rows);
    await show;
    assert.equal(h.page.data.available, false);
    assert.match(h.page.data.error, /不可开通/);
    assert.equal(h.requests.length, 0);
  }
});
test("view acknowledges the displayed batch before opening sent gifts", async () => {
  const h = await harness("account");
  const show = h.page.onShow();
  h.respond("/users/me", { id: "11111111-1111-4111-8111-111111111111" });
  await show;
  await tick();
  h.respond("/channel-gifts/reminders", {
    newGiftIds: [id],
    newCount: 1,
    pendingCount: 1,
  });
  await tick();
  h.modals[0].success({ confirm: true, cancel: false });
  await tick();
  assert.equal(h.routes.length, 0);
  h.respond("/channel-gifts/reminders/handle", {
    newGiftIds: [],
    newCount: 0,
    pendingCount: 1,
  });
  await tick();
  assert.deepEqual(h.routes, ["/pages/projects/index?category=sent"]);
});
