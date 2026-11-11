import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";

const base = "https://example.test/api/v1";
const owner = "11111111-1111-4111-8111-111111111111";
const project = "33333333-3333-4333-8333-333333333333";
const self = "44444444-4444-4444-8444-444444444444";
const received = "55555555-5555-4555-8555-555555555555";
const participating = "66666666-6666-4666-8666-666666666666";
const order = "77777777-7777-4777-8777-777777777777";
const tick = () => new Promise((done) => setImmediate(done));
const account = {
  user: { id: owner, nickname: "小陈" },
  session: {
    id: "22222222-2222-4222-8222-222222222222",
    token: "a".repeat(43),
    expiresAt: "2099-01-01T00:00:00Z",
  },
};
async function harness(name: string, loggedIn = true) {
  const bundle = await build({
    entryPoints: [`miniprogram/pages/${name}/index.ts`],
    bundle: true,
    write: false,
    format: "cjs",
    platform: "neutral",
    define: { __TIMENOOK_API_BASE_URL__: JSON.stringify(base) },
  });
  const storage = new Map<string, unknown>([["timenook.mode.v1", "live"]]);
  if (loggedIn) storage.set(`timenook.session.v1:${base}`, account);
  const requests: any[] = [],
    routes: string[] = [];
  let page: any;
  runInNewContext(bundle.outputFiles[0].text, {
    setTimeout,
    clearTimeout,
    Page(value: any) {
      page = value;
      page.setData = (patch: object) => Object.assign(page.data, patch);
    },
    wx: {
      env: { USER_DATA_PATH: "/user-data" },
      getStorageSync: (key: string) => structuredClone(storage.get(key)),
      setStorageSync: (key: string, value: unknown) =>
        storage.set(key, structuredClone(value)),
      removeStorageSync: (key: string) => storage.delete(key),
      request: (request: any) => requests.push(request),
      switchTab: ({ url }: any) => routes.push(url),
      navigateTo: ({ url }: any) => routes.push(url),
      setNavigationBarTitle() {},
    },
  });
  function respond(suffix: string, data: unknown, statusCode = 200) {
    const index = requests.findIndex((r) => r.url.endsWith(suffix));
    assert.notEqual(index, -1, `expected ${suffix}`);
    const [request] = requests.splice(index, 1);
    request.success({
      statusCode,
      data:
        statusCode < 400
          ? { data, meta: { requestId: project } }
          : { error: { code: "NOT_FOUND" }, meta: { requestId: project } },
    });
    return request;
  }
  return { page, storage, requests, routes, respond };
}
const event = (key: string, value: string) => ({
  currentTarget: { dataset: { [key]: value } },
});
const memberships = [
  {
    projectId: project,
    categories: ["sent"],
    bookTitle: "爸爸的故事",
    giftRelationship: "爸爸",
    isSelfGift: false,
    giverNickname: "小陈",
    storyCount: 3,
    giftState: "claimed",
  },
  {
    projectId: self,
    categories: ["sent", "received"],
    bookTitle: "我的故事",
    giftRelationship: "自己",
    isSelfGift: true,
    giverNickname: "小陈",
    storyCount: 0,
    giftState: null,
  },
  {
    projectId: received,
    categories: ["received"],
    bookTitle: "收到的礼物",
    giftRelationship: "爷爷",
    isSelfGift: false,
    giverNickname: "小雨",
    storyCount: 2,
    giftState: "claimed",
  },
  {
    projectId: participating,
    categories: ["participating"],
    bookTitle: "妈妈的故事",
    giftRelationship: "妈妈",
    isSelfGift: false,
    giverNickname: "小林",
    storyCount: 4,
    giftState: "claimed",
  },
];
const pending = {
  id: order,
  state: "pending",
  purchaseKind: "gift",
  paymentStatus: "pending",
  recipient: { relationshipLabel: "妈妈" },
  bookTitle: "给妈妈的书",
  listAmount: 99900,
  amount: 99900,
  isE2e: false,
  currency: "CNY",
  mode: "wechat",
  project: null,
};

test("gift filters use facts, self opens one project in both categories and pending payment stays in sent", async () => {
  const h = await harness("projects");
  h.page.onLoad({ switch: "1" });
  const showing = h.page.onShow();
  h.respond("/users/me", account.user);
  await tick();
  h.respond("/participations", { projects: memberships });
  h.respond("/orders", { orders: [pending] });
  await showing;
  assert.equal(h.page.data.rows.length, 2);
  assert.equal(h.page.data.pending.length, 1);
  h.page.changeCategory(event("category", "received"));
  assert.equal(h.page.data.rows.length, 2);
  assert.equal(h.page.data.pending.length, 0);
  h.page.choose(event("id", self));
  assert.equal(h.routes[h.routes.length - 1], "/pages/home/index");
  h.page.changeCategory(event("category", "participating"));
  assert.equal(h.page.data.rows[0].projectId, participating);
  h.page.payment(event("id", order));
  assert.equal(h.routes.length, 1, "hidden pending order cannot be opened");
  h.page.changeCategory(event("category", "sent"));
  h.page.payment(event("id", order));
  assert.equal(h.routes[h.routes.length - 1], `/pages/order/index?id=${order}`);
  h.storage.delete(`timenook.session.v1:${base}`);
  await h.page.onShow();
  assert.equal(h.page.data.rows.length, 0);
  assert.equal(h.page.data.pending.length, 0);
});

test("an invitation preserves custom relation across login and terms; only explicit acceptance sends the current form", async () => {
  const h = await harness("welcome", false);
  h.page.onLoad({ token: "c".repeat(43) });
  const showing = h.page.onShow();
  h.respond(`/invitations/${"c".repeat(43)}`, {
    projectId: project,
    bookTitle: "爸爸的故事",
    inviter: "小陈",
    process: [],
    purposes: [],
    noticeVersion: "terms",
  });
  await showing;
  await h.page.accept();
  assert.match(h.page.data.status, /关系|主讲人/);
  h.page.chooseRelationship(event("relationship", "自定义"));
  h.page.customRelationshipInput({ detail: { value: " 外孙女 " } });
  h.page.agreementChange({ detail: { value: ["agree"] } });
  h.page.terms();
  assert.equal(h.routes[h.routes.length - 1], "/pages/terms/index");
  await h.page.accept();
  assert.equal(h.page.data.loginVisible, true);
  h.storage.set(`timenook.session.v1:${base}`, account);
  h.page.loginSucceeded();
  assert.equal(h.requests.length, 0, "login does not accept");
  const joining = h.page.accept();
  const request = h.respond("/accept", { projectId: project });
  assert.equal(request.data.relationship, "外孙女");
  await joining;
  assert.equal(h.routes[h.routes.length - 1], "/pages/home/index");
});

test("an invalid invitation stays on the join page and never submits or opens a project", async () => {
  const h = await harness("welcome");
  h.page.onLoad({ token: "c".repeat(43) });
  const showing = h.page.onShow();
  h.respond(`/invitations/${"c".repeat(43)}`, null, 404);
  await showing;
  assert.equal(h.page.data.expired, true);
  await h.page.accept();
  assert.equal(h.requests.length, 0);
  assert.equal(h.routes.length, 0);
});

test("only the purchaser issues a family invitation and a different account cannot reuse its share", async () => {
  const h = await harness("invite");
  h.page.onLoad({ projectId: project });
  const state = {
    projectId: project,
    bookTitle: "爸爸的故事",
    role: "member",
    canRead: true,
    accessEpoch: 0,
    bindingVersion: 0,
    choices: ["collection", "ai", "sharing"].map((purpose) => ({
      purpose,
      granted: true,
    })),
  };
  const showing = h.page.onShow();
  h.respond("/participation", { ...state, canInvite: true });
  await tick();
  h.respond("/invitations", {
    token: "c".repeat(43),
    expiresAt: "2099-01-01T00:00:00Z",
  });
  await showing;
  assert.equal(
    h.page.onShareAppMessage().path,
    `/pages/welcome/index?token=${"c".repeat(43)}`,
  );
  h.storage.set(`timenook.session.v1:${base}`, {
    ...account,
    user: { id: "88888888-8888-4888-8888-888888888888" },
    session: { ...account.session, token: "b".repeat(43) },
  });
  assert.equal(h.page.onShareAppMessage().path, "/pages/home/index");
  const switched = h.page.onShow();
  assert.equal(h.page.data.bookTitle, "");
  h.respond("/participation", { ...state, canInvite: false });
  await switched;
  assert.equal(h.page.data.canInvite, false);
  assert.equal(h.page.data.token, "");
  assert.equal(
    h.requests.length,
    0,
    "ordinary members cannot issue invitations",
  );
});
