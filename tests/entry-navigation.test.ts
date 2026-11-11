import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

const phoneEvent = {
  detail: { code: "synthetic-phone-code", errMsg: "getPhoneNumber:ok" },
};
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
      env: { USER_DATA_PATH: "/user-data" },
      getStorageSync: (key: string) => structuredClone(storage.get(key)),
      setStorageSync: (key: string, value: unknown) =>
        storage.set(key, structuredClone(value)),
      removeStorageSync: (key: string) => storage.delete(key),
      switchTab: ({ url }: { url: string }) => routes.push(url),
      navigateTo: ({ url }: { url: string }) => routes.push(url),
      redirectTo: ({ url }: { url: string }) => routes.push(url),
      reLaunch: ({ url }: { url: string }) => routes.push(url),
      pageScrollTo: () => {},
      onNeedPrivacyAuthorization: () => {},
      offNeedPrivacyAuthorization: () => {},
      requirePrivacyAuthorize: () => {},
      openPrivacyContract: () => {},
      login: (options: any) =>
        options.success({ code: "synthetic-device-code" }),
      request(options: any) {
        const route = options.url.slice(base.length);
        requests.push(route);
        if (route === "/participations" && rejectMembership) {
          rejectMembership = false;
          options.success({
            statusCode: 401,
            data: {
              error: { code: "UNAUTHENTICATED" },
              meta: { requestId: projectId },
            },
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
                : route.startsWith("/invitations/")
                  ? route.endsWith("/accept")
                    ? { projectId }
                    : {
                        inviter: "家人",
                        process: [],
                        purposes: [],
                        noticeVersion: "current-terms",
                      }
                  : route.endsWith("/overview")
                    ? {
                        projectId: route.split("/")[2],
                        bookTitle: "当前的书",
                        metadataVersion: 1,
                        canDecide: true,
                        canRecord: true,
                        canInvite: true,
                        stories: [],
                        interviews: [],
                        tasks: [],
                        summary: {},
                        nextStep: "record",
                      }
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

test("invitation login stays in place until the user explicitly accepts", async () => {
  const h = await harness("welcome", [], false);
  h.page.onLoad({ token: "c".repeat(43) });
  await h.page.onShow();
  await h.page.accept();
  assert.equal(h.page.data.loginVisible, true);
  h.storage.set(`timenook.session.v1:${base}`, session);
  h.page.loginSucceeded();
  await h.page.onShow();
  assert.equal(h.page.data.loginVisible, false);
  assert.equal(h.page.data.loggedIn, true);
  assert.equal(
    h.requests.some((route) => route.endsWith("/accept")),
    false,
  );
  assert.deepEqual(h.routes, []);
  await h.page.accept();
  assert.equal(
    h.requests.filter((route) => route.endsWith("/accept")).length,
    1,
  );
  assert.equal(h.routes[0], "/pages/home/index");
});

test("home renders the selected project in place and never opens an order", async () => {
  const second = "44444444-4444-4444-8444-444444444444";
  const h = await harness("home", [{ projectId }, { projectId: second }]);
  h.storage.set(
    `timenook.live-project.v1:${session.user.id}:${session.session.id}`,
    second,
  );
  await h.page.onShow();
  assert.equal(h.page.data.overview.projectId, second);
  assert.equal(h.page.data.count, 2);
  assert.deepEqual(h.routes, []);
  assert.ok(!h.requests.includes("/orders"));
  h.page.switchProject();
  assert.deepEqual(h.routes, ["/pages/projects/index?switch=1"]);
});
test("home without memberships shows the purchase entry", async () => {
  const h = await harness("home", []);
  await h.page.onShow();
  assert.equal(h.page.data.overview, null);
  h.page.purchase();
  assert.deepEqual(h.routes, ["/pages/new-book/index"]);
});
test("home keeps the current book visible while returning from another page", async () => {
  const h = await harness("home", [{ projectId }]);
  await h.page.onShow();
  h.page.onHide();
  assert.equal(h.page.data.overview?.projectId, projectId);
  const returning = h.page.onShow();
  assert.equal(h.page.data.overview?.projectId, projectId);
  assert.equal(h.page.data.busy, false);
  await returning;
});
test("home clears a retained book after rejected membership", async () => {
  const h = await harness("home", [{ projectId }]);
  await h.page.onShow();
  h.expireNextMembership();
  await h.page.onShow();
  assert.equal(h.page.data.overview, null);
  assert.equal(h.page.data.loggedIn, false);
});
test("home clears the retained book immediately when returning after logout", async () => {
  const h = await harness("home", [{ projectId }]);
  await h.page.onShow();
  h.page.onHide();
  h.storage.delete(`timenook.session.v1:${base}`);
  const returning = h.page.onShow();
  assert.equal(h.page.data.overview, null);
  assert.equal(h.page.data.loggedIn, false);
  await returning;
});
test("home opens the shared quick login without starting checkout", async () => {
  const h = await harness("home", [], false);
  await h.page.onShow();
  h.page.login();
  assert.deepEqual(h.routes, []);
  assert.equal(h.page.data.loginVisible, true);
});
test("the public homepage opens the public sample without signing in", async () => {
  const h = await harness("home", [], false);
  await h.page.onShow();
  h.page.sample();
  assert.deepEqual(h.routes, ["/pages/sample/index"]);
  assert.equal(h.page.data.loginVisible, false);
});
test("a standalone login adapter returns home without orders or payment", async () => {
  const h = await harness("login", [], false);
  h.page.onLoad({});
  h.page.loginSucceeded();
  assert.deepEqual(h.routes, ["/pages/home/index"]);
  assert.deepEqual(h.requests, []);
});
test("a direct new-book entry preserves its draft in the shared login sheet", async () => {
  const h = await harness("new-book", [], false);
  h.page.chooseRelationship({
    currentTarget: { dataset: { relationship: "妈妈" } },
  });
  h.page.input({
    currentTarget: { dataset: { field: "bookTitle" } },
    detail: { value: "妈妈 & 回忆" },
  });
  h.page.next();
  assert.deepEqual(h.routes, []);
  assert.equal(h.page.data.loginVisible, true);
  h.storage.set(`timenook.session.v1:${base}`, session);
  h.page.loginSucceeded();
  const destination = new URL(h.routes[0], "https://example.test");
  assert.equal(destination.pathname, "/pages/purchase/index");
  assert.equal(destination.searchParams.get("bookTitle"), "妈妈 & 回忆");
  assert.equal(destination.searchParams.get("relationship"), "妈妈");
});
test("My shows an existing local session while validating it", async () => {
  const h = await harness("account", []);
  const pending = h.page.onShow();
  assert.equal(h.page.data.loggedIn, true);
  await pending;
});
test("native tab taps navigate even when the custom bar selection lags behind the page", async () => {
  const bundle = await build({
    entryPoints: ["miniprogram/custom-tab-bar/index.ts"],
    bundle: true,
    write: false,
    format: "cjs",
    platform: "neutral",
  });
  const routes: string[] = [];
  let bar: any;
  runInNewContext(bundle.outputFiles[0].text, {
    Component(value: any) {
      bar = value;
    },
    wx: {
      getStorageSync: () => undefined,
      switchTab: ({ url }: { url: string }) => routes.push(url),
    },
  });
  bar.methods.switchTab.call(bar, {
    currentTarget: { dataset: { page: "home" } },
  });
  assert.deepEqual(routes, ["/pages/home/index"]);
});
test("My provides project, new purchase and terms entries without loading private projects", async () => {
  const h = await harness("account", [], false);
  await h.page.onShow();
  assert.equal(h.page.data.loggedIn, false);
  h.page.login();
  assert.deepEqual(h.routes, []);
  assert.equal(h.page.data.loginVisible, true);
  h.storage.set(`timenook.session.v1:${base}`, session);
  h.page.loginSucceeded({ detail: { user: { nickname: "用户1234" } } });
  assert.equal(h.page.data.nickname, "用户1234");
  h.page.projects();
  h.page.purchase();
  h.page.terms();
  assert.deepEqual(h.routes, [
    "/pages/projects/index",
    "/pages/new-book/index",
    "/pages/terms/index",
  ]);
  assert.ok(!h.requests.includes("/participations"));
});
test("the standalone adapter returns to My after shared login succeeds", async () => {
  const h = await harness("login", [], false);
  h.page.onLoad({ next: "account" });
  h.page.loginSucceeded();
  assert.deepEqual(h.routes, ["/pages/account/index"]);
});

test("an unsigned home purchase opens quick login before entering the new-book form", async () => {
  const h = await harness("home", [], false);
  await h.page.onShow();
  h.page.purchase();
  assert.deepEqual(h.routes, []);
  assert.equal(h.page.data.loginVisible, true);
});

test("cancelled purchase login stays on home and does not retain the purchase destination", async () => {
  const h = await harness("home", [], false);
  await h.page.onShow();
  h.page.purchase();
  h.page.closeLogin();
  assert.equal(h.page.data.loginVisible, false);
  assert.deepEqual(h.routes, []);
  h.page.login();
  assert.equal(h.page.loginDestination, "home");
});
