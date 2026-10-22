import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

// Execute the actual page and its real session/request modules. Only the native
// WeChat registration, storage, login and network boundaries are substituted.
const bundled = await build({
  entryPoints: ["miniprogram/pages/home/index.ts"],
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

interface HomePage {
  data: { busy: boolean; userId: string; status: string; mode: string };
  setData(patch: Partial<HomePage["data"]>): void;
  onShow(): Promise<void>;
  login(): Promise<void>;
  logout(): Promise<void>;
}

function pageHarness() {
  const storage = new Map<string, unknown>();
  const pending: WechatMiniprogram.RequestOption[] = [];
  let waiter: ((request: WechatMiniprogram.RequestOption) => void) | undefined;
  let page!: HomePage;
  runInNewContext(bundled.outputFiles[0].text, {
    Page: (definition: HomePage) => {
      page = definition;
      page.setData = (patch) => Object.assign(page.data, patch);
    },
    wx: {
      getStorageSync: (key: string) => structuredClone(storage.get(key)),
      setStorageSync: (key: string, value: unknown) =>
        storage.set(key, structuredClone(value)),
      removeStorageSync: (key: string) => storage.delete(key),
      login: (options: WechatMiniprogram.LoginOption) =>
        options.success?.({
          code: "synthetic-device-code",
          errMsg: "login:ok",
        }),
      request: (request: WechatMiniprogram.RequestOption) => {
        if (waiter) {
          const resolve = waiter;
          waiter = undefined;
          resolve(request);
        } else pending.push(request);
        return {};
      },
    },
  });
  return {
    page,
    nextRequest(): Promise<WechatMiniprogram.RequestOption> {
      const request = pending.shift();
      return request
        ? Promise.resolve(request)
        : new Promise((resolve) => {
            waiter = resolve;
          });
    },
  };
}

const user = { id: "11111111-1111-4111-8111-111111111111" };
const loginResponse = {
  user,
  session: {
    id: "22222222-2222-4222-8222-222222222222",
    token: "a".repeat(43),
    expiresAt: "2099-01-01T00:00:00.000Z",
  },
};
function respond(
  request: WechatMiniprogram.RequestOption,
  statusCode: number,
  data?: unknown,
) {
  request.success?.({
    statusCode,
    data: { data, meta: { requestId: "33333333-3333-4333-8333-333333333333" } },
    header: {},
    cookies: [],
    errMsg: "request:ok",
  } as unknown as WechatMiniprogram.RequestSuccessCallbackResult);
}

test("returning to the page during login shows the completed account and enables its actions", async () => {
  const { page, nextRequest } = pageHarness();
  const login = page.login();
  const exchange = await nextRequest();
  await page.onShow();
  respond(exchange, 201, loginResponse);
  await login;
  assert.deepEqual(
    {
      userId: page.data.userId,
      status: page.data.status,
      busy: page.data.busy,
    },
    { userId: user.id, status: "已连接服务端账号", busy: false },
  );

  const reentry = page.onShow();
  respond(await nextRequest(), 200, user);
  await reentry;
  assert.equal(page.data.userId, user.id);
  assert.equal(page.data.busy, false);
});

test("returning during logout preserves the pending exit and finishes with usable login actions", async () => {
  const { page, nextRequest } = pageHarness();
  const login = page.login();
  respond(await nextRequest(), 201, loginResponse);
  await login;
  const logout = page.logout();
  const revocation = await nextRequest();
  await page.onShow();
  assert.equal(page.data.status, "正在退出");
  assert.equal(page.data.userId, "");
  respond(revocation, 204);
  await logout;
  assert.equal(page.data.status, "已退出登录");
  assert.equal(page.data.busy, false);
  await page.onShow();
  assert.equal(page.data.userId, "");
  assert.equal(page.data.busy, false);
});

test("a login failure after foregrounding leaves retry available and the retry can sign in", async () => {
  const { page, nextRequest } = pageHarness();
  const failed = page.login();
  const exchange = await nextRequest();
  await page.onShow();
  exchange.fail?.({
    errMsg: "synthetic offline",
  } as WechatMiniprogram.RequestFailCallbackErr);
  await failed;
  assert.equal(page.data.busy, false);
  assert.equal(page.data.userId, "");
  assert.equal(page.data.status, "服务暂不可用，请稍后重试");
  const retry = page.login();
  respond(await nextRequest(), 201, loginResponse);
  await retry;
  assert.equal(page.data.userId, user.id);
  assert.equal(page.data.busy, false);
});

test("a logout failure after foregrounding reports unconfirmed revocation without locking the page", async () => {
  const { page, nextRequest } = pageHarness();
  const login = page.login();
  respond(await nextRequest(), 201, loginResponse);
  await login;
  const logout = page.logout();
  const revocation = await nextRequest();
  await page.onShow();
  revocation.fail?.({
    errMsg: "synthetic offline",
  } as WechatMiniprogram.RequestFailCallbackErr);
  await logout;
  assert.equal(page.data.busy, false);
  assert.equal(page.data.userId, "");
  assert.equal(
    page.data.status,
    "本机已退出，服务端撤销未确认；原会话将在到期后失效。",
  );
  await page.onShow();
  assert.equal(page.data.busy, false);
  assert.equal(page.data.userId, "");
});

test("an older foreground restore cannot overwrite a different account after logout and login", async () => {
  const { page, nextRequest } = pageHarness();
  const login = page.login();
  respond(await nextRequest(), 201, loginResponse);
  await login;
  const restore = page.onShow();
  const oldIdentity = await nextRequest();
  const logout = page.logout();
  respond(await nextRequest(), 204);
  await logout;
  const nextUser = { id: "44444444-4444-4444-8444-444444444444" };
  const nextLogin = page.login();
  respond(await nextRequest(), 201, {
    user: nextUser,
    session: { ...loginResponse.session, token: "b".repeat(43) },
  });
  await nextLogin;
  respond(oldIdentity, 200, user);
  await restore;
  assert.equal(page.data.userId, nextUser.id);
  assert.equal(page.data.status, "已连接服务端账号");
  assert.equal(page.data.busy, false);
});
