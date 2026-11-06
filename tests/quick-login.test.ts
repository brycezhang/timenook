import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";
import { USER_TERMS_VERSION } from "../packages/contracts/src";

const base = "https://example.test/api/v1";
const identity = {
  user: { id: "11111111-1111-4111-8111-111111111111", nickname: "用户1234" },
  session: {
    id: "22222222-2222-4222-8222-222222222222",
    token: "a".repeat(43),
    expiresAt: "2099-01-01T00:00:00Z",
  },
};
const phoneEvent = {
  detail: { code: "synthetic-phone-code", errMsg: "getPhoneNumber:ok" },
};
const bundles = await Promise.all(
  ["pages/home", "pages/account", "components/quick-login"].map(
    async (path) =>
      (
        await build({
          entryPoints: [`miniprogram/${path}/index.ts`],
          bundle: true,
          write: false,
          format: "cjs",
          platform: "neutral",
          define: { __TIMENOOK_API_BASE_URL__: JSON.stringify(base) },
        })
      ).outputFiles[0].text,
  ),
);

function harness(name: "home" | "account" = "home", signedIn = false) {
  const storage = new Map<string, unknown>([["timenook.mode.v1", "live"]]);
  if (signedIn) storage.set(`timenook.session.v1:${base}`, identity);
  const routes: string[] = [],
    requests: WechatMiniprogram.RequestOption[] = [];
  let page: any, quick: any, definition: any;
  const scope = {
    Page(value: any) {
      page = value;
      page.setData = (patch: any) => {
        Object.assign(page.data, patch);
        if (quick && "loginVisible" in patch) {
          quick.data.visible = patch.loginVisible;
          definition.observers.visible.call(quick, patch.loginVisible);
        }
      };
    },
    Component(value: any) {
      definition = value;
      quick = {
        ...value.methods,
        data: { ...value.data, visible: false, expectedUserId: "" },
        setData(patch: object) {
          Object.assign(this.data, patch);
        },
        triggerEvent(event: string, detail: unknown) {
          if (event === "success") page.loginSucceeded({ detail });
          if (event === "close") page.closeLogin();
        },
      };
    },
    wx: {
      getStorageSync: (key: string) => structuredClone(storage.get(key)),
      setStorageSync: (key: string, value: unknown) =>
        storage.set(key, structuredClone(value)),
      removeStorageSync: (key: string) => storage.delete(key),
      navigateTo: ({ url }: { url: string }) => routes.push(url),
      pageScrollTo() {},
      login: (options: WechatMiniprogram.LoginOption) =>
        options.success?.({ code: "fresh-wechat-code", errMsg: "login:ok" }),
      request: (options: WechatMiniprogram.RequestOption) => {
        requests.push(options);
        return {};
      },
    },
  };
  runInNewContext(bundles[name === "home" ? 0 : 1], scope);
  runInNewContext(bundles[2], scope);
  return {
    page,
    quick,
    storage,
    routes,
    requests,
    respond() {
      assert.equal(requests.length, 1);
      const request = requests[0];
      assert.equal(request.url, `${base}/sessions/wechat`);
      request.success?.({
        statusCode: 201,
        data: { data: identity, meta: { requestId: "synthetic" } },
      } as unknown as WechatMiniprogram.RequestSuccessCallbackResult);
    },
  };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

for (const surface of ["home", "account"] as const) {
  test(`${surface} purchase opens shared phone login and enters new-book only after successful authorization`, async () => {
    const h = harness(surface);
    h.page.purchase();
    assert.equal(h.quick.data.visible, true);
    assert.equal(h.quick.data.agreed, false);
    assert.deepEqual(h.routes, []);
    await h.quick.login(phoneEvent);
    assert.equal(h.requests.length, 0);
    h.quick.toggleAgreed();
    const pending = h.quick.login(phoneEvent);
    await tick();
    assert.equal(h.quick.data.busy, true);
    assert.deepEqual(h.routes, []);
    assert.deepEqual(JSON.parse(JSON.stringify(h.requests[0].data)), {
      code: "fresh-wechat-code",
      phoneCode: "synthetic-phone-code",
      termsVersion: USER_TERMS_VERSION,
    });
    h.respond();
    await pending;
    assert.equal(h.quick.data.visible, false);
    assert.deepEqual(h.routes, ["/pages/new-book/index"]);
    assert.equal(h.storage.has(`timenook.session.v1:${base}`), true);
  });
}

test("a signed-in home purchase goes directly to new-book without another login", () => {
  const h = harness("home", true);
  h.page.purchase();
  assert.deepEqual(h.routes, ["/pages/new-book/index"]);
  assert.equal(h.quick.data.visible, false);
  assert.equal(h.requests.length, 0);
});

test("declining phone access and closing the popup never advances the purchase", async () => {
  const h = harness();
  h.page.purchase();
  h.quick.toggleAgreed();
  await h.quick.login({ detail: { errMsg: "getPhoneNumber:fail user deny" } });
  assert.equal(h.requests.length, 0);
  assert.match(h.quick.data.status, /需要授权手机号/);
  h.quick.close();
  assert.deepEqual(h.routes, []);
  assert.equal(h.quick.data.visible, false);
  h.page.login();
  assert.equal(h.page.loginDestination, "home");
  assert.equal(h.quick.data.agreed, false);
});

test("the same popup logs in on My and displays the returned nickname", async () => {
  const h = harness("account");
  h.page.login();
  h.quick.toggleAgreed();
  const pending = h.quick.login(phoneEvent);
  await tick();
  h.respond();
  await pending;
  assert.equal(h.page.data.loggedIn, true);
  assert.equal(h.page.data.nickname, "用户1234");
  assert.deepEqual(h.routes, []);
  assert.equal(h.quick.data.visible, false);
});

test("a failed phone login keeps the popup and purchase destination available for retry", async () => {
  const h = harness();
  h.page.purchase();
  h.quick.toggleAgreed();
  const pending = h.quick.login(phoneEvent);
  await tick();
  h.requests[0].fail?.({
    errMsg: "synthetic offline",
  } as WechatMiniprogram.RequestFailCallbackErr);
  await pending;
  assert.equal(h.quick.data.busy, false);
  assert.equal(h.quick.data.visible, true);
  assert.equal(h.page.loginDestination, "new-book");
  assert.deepEqual(h.routes, []);
});
