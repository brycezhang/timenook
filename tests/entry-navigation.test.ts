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
      env: { USER_DATA_PATH: "/user-data" },
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
test("My provides project, new purchase and terms entries without loading private projects", async () => {
  const h = await harness("account", [], false);
  await h.page.onShow();
  assert.equal(h.page.data.loggedIn, false);
  await h.page.login();
  assert.equal(h.page.data.loggedIn, true);
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
test("native login completes through background and foreground without a second click", async () => {
  const h = await harness("account", [], false, true);
  const pending = h.page.login();
  h.page.onHide();
  await h.page.onShow();
  h.finishLogin();
  await pending;
  assert.equal(h.page.data.loggedIn, true);
  assert.equal(h.page.data.busy, false);
});
