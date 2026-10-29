import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";
import type { AccountLinkChallenge } from "../packages/contracts/src";
const base = "https://example.test/api/v1";
async function harness() {
  const bundled = await build({
    entryPoints: ["miniprogram/pages/account-link/index.ts"],
    bundle: true,
    write: false,
    format: "cjs",
    platform: "neutral",
    define: { __TIMENOOK_API_BASE_URL__: JSON.stringify(base) },
  });
  const storage = new Map<string, unknown>();
  const requests: WechatMiniprogram.RequestOption[] = [];
  let page: any,
    loginCount = 0;
  runInNewContext(bundled.outputFiles[0].text, {
    Page(value: any) {
      page = value;
      page.setData = (patch: object) => Object.assign(page.data, patch);
    },
    wx: {
      getStorageSync: (key: string) => structuredClone(storage.get(key)),
      setStorageSync: (key: string, value: unknown) =>
        storage.set(key, structuredClone(value)),
      removeStorageSync: (key: string) => storage.delete(key),
      login(options: WechatMiniprogram.LoginOption) {
        options.success?.({
          code: `fresh-device-${++loginCount}`,
          errMsg: "login:ok",
        });
      },
      request(request: WechatMiniprogram.RequestOption) {
        requests.push(request);
        return {};
      },
    },
  });
  return { page, storage, requests, logins: () => loginCount };
}
function respond(
  request: WechatMiniprogram.RequestOption,
  data: unknown,
  statusCode = 200,
) {
  request.success?.({
    statusCode,
    data: { data, meta: { requestId: "synthetic-request" } },
    header: {},
    cookies: [],
    errMsg: "request:ok",
  } as unknown as WechatMiniprogram.RequestSuccessCallbackResult);
}
const challenge: AccountLinkChallenge = {
  id: "11111111-1111-4111-8111-111111111111",
  targetUser: { id: "22222222-2222-4222-8222-222222222222" },
  expiresAt: "2099-01-01T00:00:00.000Z",
  state: "paired",
  verificationCode: "123456",
  webConfirmed: false,
  nativeConfirmed: false,
};
test("unconfigured native association does not call wx.login or create a session", async () => {
  const h = await harness(),
    loading = h.page.onLoad();
  respond(h.requests.shift()!, { available: false });
  await loading;
  assert.equal(h.page.data.available, false);
  assert.match(h.page.data.status, /尚未配置/);
  assert.equal(h.logins(), 0);
  assert.equal(h.storage.has(`timenook.session.v1:${base}`), false);
});
test("native pairing uses fresh codes twice, confirms the displayed pair and signs in only after both confirmations", async () => {
  const h = await harness(),
    loading = h.page.onLoad();
  respond(h.requests.shift()!, { available: true });
  await loading;
  h.page.inputCode({ detail: { value: "12345678" } });
  const claiming = h.page.claim();
  await new Promise((resolve) => setImmediate(resolve));
  const claim = h.requests.shift()!;
  assert.equal(claim.url, `${base}/wechat-links/claim`);
  assert.deepEqual(JSON.parse(JSON.stringify(claim.data)), {
    linkCode: "12345678",
    code: "fresh-device-1",
  });
  respond(claim, { proof: "P".repeat(43), challenge }, 201);
  await claiming;
  assert.equal(h.page.data.challenge.verificationCode, "123456");
  assert.equal(h.storage.has(`timenook.session.v1:${base}`), false);
  const confirming = h.page.confirm();
  await new Promise((resolve) => setImmediate(resolve));
  const confirm = h.requests.shift()!;
  assert.equal(confirm.url, `${base}/wechat-links/confirm`);
  assert.deepEqual(JSON.parse(JSON.stringify(confirm.data)), {
    proof: "P".repeat(43),
    code: "fresh-device-2",
    verificationCode: "123456",
  });
  respond(confirm, { challenge: { ...challenge, nativeConfirmed: true } }, 201);
  await confirming;
  assert.equal(h.storage.has(`timenook.session.v1:${base}`), false);
  const refreshing = h.page.refresh();
  respond(h.requests.shift()!, {
    challenge: {
      ...challenge,
      state: "linked",
      nativeConfirmed: true,
      webConfirmed: true,
    },
  });
  await refreshing;
  const signingIn = h.page.finish();
  await new Promise((resolve) => setImmediate(resolve));
  const login = h.requests.shift()!;
  assert.equal(login.url, `${base}/sessions/wechat`);
  assert.equal((login.data as { code: string }).code, "fresh-device-3");
  respond(
    login,
    {
      user: challenge.targetUser,
      session: {
        id: "33333333-3333-4333-8333-333333333333",
        token: "S".repeat(43),
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    },
    201,
  );
  await signingIn;
  assert.equal(h.page.data.userId, challenge.targetUser.id);
  assert.equal(h.logins(), 3);
  assert.equal(
    JSON.stringify([...h.storage]).includes("P".repeat(43)),
    false,
    "proof is never persisted",
  );
});
test("a claim that arrives after leaving the native page cannot restore private pairing state", async () => {
  const h = await harness(),
    loading = h.page.onLoad();
  respond(h.requests.shift()!, { available: true });
  await loading;
  h.page.inputCode({ detail: { value: "12345678" } });
  const claiming = h.page.claim();
  await new Promise((resolve) => setImmediate(resolve));
  const request = h.requests.shift()!;
  h.page.onUnload();
  respond(request, { proof: "Q".repeat(43), challenge }, 201);
  await claiming;
  assert.equal(h.page.data.challenge, null);
  assert.equal(h.storage.has(`timenook.session.v1:${base}`), false);
  const cancellation = h.requests.shift()!;
  assert.equal(cancellation.url, `${base}/wechat-links/cancel`);
  respond(
    cancellation,
    { challenge: { ...challenge, state: "cancelled" } },
    201,
  );
});
test("failed or cancelled native association never falls back to normal login", async () => {
  const h = await harness(),
    loading = h.page.onLoad();
  respond(h.requests.shift()!, { available: true });
  await loading;
  h.page.inputCode({ detail: { value: "12345678" } });
  const claiming = h.page.claim();
  await new Promise((resolve) => setImmediate(resolve));
  respond(h.requests.shift()!, { proof: "R".repeat(43), challenge }, 201);
  await claiming;
  const cancelling = h.page.cancel();
  respond(
    h.requests.shift()!,
    { challenge: { ...challenge, state: "cancelled" } },
    201,
  );
  await cancelling;
  await h.page.finish();
  assert.equal(h.page.data.challenge.state, "cancelled");
  assert.equal(h.requests.length, 0);
  assert.equal(h.logins(), 1);
  assert.equal(h.storage.has(`timenook.session.v1:${base}`), false);
});
