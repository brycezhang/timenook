import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

const base = "https://example.test/api/v1";
const projectId = "33333333-3333-4333-8333-333333333333";
const session = {
  user: { id: "11111111-1111-4111-8111-111111111111" },
  session: {
    id: "22222222-2222-4222-8222-222222222222",
    token: "a".repeat(43),
    expiresAt: "2099-01-01T00:00:00Z",
  },
};
async function harness(
  name: string,
  projects: object[],
  signedIn = true,
  deferLogin = false,
) {
  const bundle = await build({
    entryPoints: [`miniprogram/pages/${name}/index.ts`],
    bundle: true,
    write: false,
    format: "cjs",
    platform: "neutral",
    define: { __TIMENOOK_API_BASE_URL__: JSON.stringify(base) },
  });
  const storage = new Map<string, unknown>([["timenook.mode.v1", "live"]]);
  if (signedIn) storage.set(`timenook.session.v1:${base}`, session);
  const routes: string[] = [],
    requests: string[] = [];
  let page: any;
  let completeLogin: (() => void) | undefined;
  let rejectMembership = false;
  runInNewContext(bundle.outputFiles[0].text, {
    setTimeout,
    clearTimeout,
    Page(value: any) {
      page = value;
      page.setData = (patch: object) => Object.assign(page.data, patch);
    },
    wx: {
      getStorageSync: (key: string) => structuredClone(storage.get(key)),
      setStorageSync: (key: string, value: unknown) =>
        storage.set(key, structuredClone(value)),
      removeStorageSync: (key: string) => storage.delete(key),
      switchTab: ({ url }: { url: string }) => routes.push(url),
      navigateTo: ({ url }: { url: string }) => routes.push(url),
      reLaunch: ({ url }: { url: string }) => routes.push(url),
      login: (options: any) =>
        options.success({ code: "synthetic-device-code" }),
      request(options: any) {
        const route = options.url.slice(base.length);
        requests.push(route);
        if (route === "/participations" && rejectMembership) {
          rejectMembership = false;
          options.success({
            statusCode: 401,
            data: { error: { code: "UNAUTHENTICATED" } },
          });
          return;
        }
        const data =
          route === "/users/me"
            ? session.user
            : route === "/sessions/wechat"
              ? session
              : route === "/participations"
                ? { projects }
                : undefined;
        assert.ok(data, `unexpected request: ${route}`);
        const complete = () =>
          options.success({
            statusCode: 200,
            data: { data, meta: { requestId: projectId } },
          });
        if (route === "/sessions/wechat" && deferLogin)
          completeLogin = complete;
        else complete();
      },
    },
  });
  return {
    page,
    routes,
    requests,
    storage,
    expireNextMembership() {
      rejectMembership = true;
    },
    finishLogin() {
      assert.ok(completeLogin);
      completeLogin();
    },
  };
}

test("a signed-in returning user opens their bound storybook without visiting orders", async () => {
  const h = await harness("home", [{ projectId, state: "bound" }]);
  h.page.onLoad({});
  await h.page.onShow();
  assert.deepEqual(h.routes, ["/pages/project/index"]);
  assert.ok(!h.requests.includes("/orders"));
});

test("explicit gift browsing and pending invitations never auto-open a project", async () => {
  const browsing = await harness("home", [{ projectId, state: "bound" }]);
  browsing.page.onLoad({ browse: "1" });
  await browsing.page.onShow();
  assert.deepEqual(browsing.routes, []);
  const pending = await harness("home", [{ projectId, state: "pending" }]);
  pending.page.onLoad({});
  await pending.page.onShow();
  assert.deepEqual(pending.routes, []);
});

test("an initiator returns to the selected storybook instead of a different membership", async () => {
  const secondId = "44444444-4444-4444-8444-444444444444";
  const h = await harness("home", [
    { projectId, state: "bound" },
    { projectId: secondId, state: "initiator" },
  ]);
  const context = `${session.user.id}:${session.session.id}`;
  h.storage.set(`timenook.live-project.v1:${context}`, secondId);
  h.page.onLoad({});
  await h.page.onShow();
  assert.deepEqual(h.routes, ["/pages/project/index"]);
  assert.equal(h.storage.get(`timenook.live-project.v1:${context}`), secondId);
});

test("My is usable without a project: sign in, view orders and manage participation", async () => {
  const h = await harness("account", [], false);
  h.page.onLoad({});
  await h.page.onShow();
  assert.equal(h.page.data.loggedIn, false);
  assert.deepEqual(h.requests, []);
  await h.page.login();
  assert.equal(h.page.data.loggedIn, true);
  h.page.order();
  h.page.rights();
  assert.deepEqual(h.routes, ["/pages/order/index", "/pages/welcome/index"]);
});

test("My completes a pending native login after background and foreground", async () => {
  const h = await harness("account", [], false, true);
  h.page.onLoad({});
  await h.page.onShow();
  const login = h.page.login();
  h.page.onHide();
  await h.page.onShow();
  h.finishLogin();
  await login;
  assert.equal(h.page.data.loggedIn, true);
  assert.equal(h.page.data.busy, false);
  h.page.order();
  assert.deepEqual(h.routes, ["/pages/order/index"]);
});

test("login completed while My is hidden waits for the real foreground before loading private projects", async () => {
  const h = await harness("account", [], false, true);
  h.page.onLoad({});
  await h.page.onShow();
  const login = h.page.login();
  h.page.onHide();
  await Promise.resolve();
  h.finishLogin();
  await login;
  assert.deepEqual(h.requests, ["/sessions/wechat"]);
  await h.page.onShow();
  assert.equal(h.page.data.loggedIn, true);
  assert.deepEqual(h.requests, ["/sessions/wechat", "/participations"]);
});

test("My can log in again after a server 401 without leaving the visible page", async () => {
  const h = await harness("account", []);
  h.page.onLoad({});
  h.expireNextMembership();
  await h.page.onShow();
  assert.equal(h.page.data.loggedIn, false);
  await h.page.login();
  assert.equal(h.page.data.loggedIn, true);
  assert.equal(h.page.data.busy, false);
});
