import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

// Execute the actual page and its real session/request modules. Only the native
// WeChat registration, storage, login and network boundaries are substituted.
const bundled = await build({
  entryPoints: ["miniprogram/pages/account/index.ts"],
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
  data: {
    busy: boolean;
    loggedIn: boolean;
    status: string;
    mode: string;
    nickname: string;
    editing: boolean;
  };
  editNickname(): void;
  saveNickname(e: { detail: { value: { nickname: string } } }): Promise<void>;
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
      env: { USER_DATA_PATH: "/user-data" },
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
    storage,
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

const user = {
  id: "11111111-1111-4111-8111-111111111111",
  nickname: "用户1234",
};
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

function signIn(storage: Map<string, unknown>, value = loginResponse) {
  storage.set("timenook.mode.v1", "live");
  storage.set("timenook.session.v1:https://example.test/timenook/v1", value);
}

test("My displays the saved nickname immediately and refreshes it from the server", async () => {
  const { page, storage, nextRequest } = pageHarness();
  signIn(storage);
  const restore = page.onShow();
  assert.equal(page.data.nickname, "用户1234");
  respond(await nextRequest(), 200, { ...user, nickname: "小树" });
  await restore;
  assert.equal(page.data.nickname, "小树");
});

test("My saves the submitted nickname and retains it when returning", async () => {
  const { page, storage, nextRequest } = pageHarness();
  signIn(storage);
  page.editNickname();
  const save = page.saveNickname({
    detail: { value: { nickname: "  小树  " } },
  });
  const command = await nextRequest();
  assert.equal(
    command.url,
    "https://example.test/timenook/v1/users/me/profile",
  );
  assert.deepEqual(JSON.parse(JSON.stringify(command.data)), {
    nickname: "小树",
  });
  respond(command, 201, { ...user, nickname: "小树" });
  await save;
  assert.equal(page.data.nickname, "小树");
  assert.equal(page.data.editing, false);
  const restore = page.onShow();
  assert.equal(page.data.nickname, "小树");
  respond(await nextRequest(), 200, { ...user, nickname: "小树" });
  await restore;
});

test("returning during logout preserves the pending exit and clears the nickname", async () => {
  const { page, storage, nextRequest } = pageHarness();
  signIn(storage);
  const logout = page.logout();
  const revocation = await nextRequest();
  await page.onShow();
  assert.equal(page.data.busy, true);
  assert.equal(page.data.loggedIn, false);
  assert.equal(page.data.nickname, "");
  respond(revocation, 204);
  await logout;
  assert.equal(page.data.busy, false);
});

test("a failed nickname save leaves editing and retry available", async () => {
  const { page, storage, nextRequest } = pageHarness();
  signIn(storage);
  page.editNickname();
  const save = page.saveNickname({ detail: { value: { nickname: "小树" } } });
  (await nextRequest()).fail?.({
    errMsg: "synthetic offline",
  } as WechatMiniprogram.RequestFailCallbackErr);
  await save;
  assert.equal(page.data.busy, false);
  assert.equal(page.data.editing, true);
  assert.equal(page.data.status, "服务暂不可用，请稍后重试");
});

test("an older foreground restore cannot overwrite the next account after logout", async () => {
  const { page, storage, nextRequest } = pageHarness();
  signIn(storage);
  const restore = page.onShow();
  const oldIdentity = await nextRequest();
  const logout = page.logout();
  respond(await nextRequest(), 204);
  await logout;
  const nextUser = {
    id: "44444444-4444-4444-8444-444444444444",
    nickname: "新用户",
  };
  signIn(storage, {
    ...loginResponse,
    user: nextUser,
    session: { ...loginResponse.session, token: "b".repeat(43) },
  });
  const reentry = page.onShow();
  respond(await nextRequest(), 200, nextUser);
  await reentry;
  respond(oldIdentity, 200, user);
  await restore;
  assert.equal(page.data.nickname, "新用户");
  assert.equal(page.data.loggedIn, true);
});
