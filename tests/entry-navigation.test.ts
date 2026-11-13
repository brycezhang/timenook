import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { offer } from "./purchase-fixture";

const phoneEvent = {
  detail: { code: "synthetic-phone-code", errMsg: "getPhoneNumber:ok" },
};
const base = "https://example.test/api/v1";
const projectId = "33333333-3333-4333-8333-333333333333";
const coverPhoto = {
  id: "55555555-5555-4555-8555-555555555555",
  assetId: "66666666-6666-4666-8666-666666666666",
  sha256: "f".repeat(64),
  bytes: 42,
};
const questions = ["one", "two"].map((id) => ({
  id,
  text: id,
  state: "ready",
  chapterKey: null,
  author: { relationship: "女儿", nickname: "小树" },
}));
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
    stdin: {
      contents:
        name === "home"
          ? 'import "./miniprogram/pages/home/index"; import "./miniprogram/pages/account/index";'
          : `import "./miniprogram/pages/${name}/index";`,
      resolveDir: process.cwd(),
    },
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
  const pages: any[] = [];
  let completeLogin: (() => void) | undefined;
  let rejectMembership = false;
  let membershipOffline = false;
  let rejectOffer = false;
  let showCover = false;
  let coverExpiresAt: string | null = null;
  const files = new Set<string>();
  const downloads: string[] = [];
  let random = 0;
  runInNewContext(bundle.outputFiles[0].text, {
    Date,
    Math: Object.assign(Object.create(Math), {
      random: () => ((++random % 100) + 1) / 1000,
    }),
    setTimeout,
    clearTimeout,
    Page(value: any) {
      pages.push(value);
      value.setData = (patch: object) => Object.assign(value.data, patch);
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
      downloadFile(options: any) {
        downloads.push(options.url);
        files.add(options.filePath);
        options.success({ statusCode: 200, filePath: options.filePath });
      },
      getFileSystemManager: () => ({
        access: (o: any) => (files.has(o.path) ? o.success() : o.fail()),
        getFileInfo: (o: any) =>
          o.success({ size: 42, digest: coverPhoto.sha256 }),
        unlink: (o: any) =>
          files.delete(o.filePath)
            ? o.success()
            : o.fail({ errMsg: "no such file" }),
      }),
      request(options: any) {
        const route = options.url.slice(base.length);
        requests.push(route);
        if (options.method === "DELETE") {
          options.success({ statusCode: 204 });
          return;
        }
        if (route === "/packages/current" && rejectOffer) {
          options.fail({ errMsg: "request:fail timeout" });
          return;
        }
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
        if (route === "/participations" && membershipOffline) {
          membershipOffline = false;
          options.fail({ errMsg: "request:fail timeout" });
          return;
        }
        const extra =
          route === "/packages/current"
            ? offer
            : route.endsWith("/plan")
              ? {
                  projectId: route.split("/")[2],
                  revision: 1,
                  chapters: [],
                  starters: [],
                  preferences: { version: 1, blockedTopics: [] },
                  questionStates: [],
                  actualQuestions: [],
                  answers: [],
                  subjectDecision: "member",
                  accessExpiresAt: null,
                }
              : route.endsWith("/family-questions")
                ? { projectId: route.split("/")[2], questions }
                : route.endsWith("/book")
                  ? {
                      projectId: route.split("/")[2],
                      draftAccess: { allowed: true, expiresAt: coverExpiresAt },
                      inputHash: "f".repeat(64),
                      directory: { version: 1, chapters: [] },
                      eligibleStories: [],
                      cover: {
                        version: 1,
                        salutation: "",
                        photoAssetId: coverPhoto.assetId,
                      },
                      coverPhotoOptions: showCover ? [coverPhoto] : [],
                      current: null,
                      accessExpiresAt: null,
                    }
                  : undefined;
        const data =
          extra ??
          (route === "/users/me"
            ? session.user
            : route === "/sessions/wechat"
              ? session
              : route === "/participations"
                ? { projects: projects.map((p) => ({ categories: [], ...p })) }
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
                    : undefined);
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
  if (name === "home") pages[0].onLoad();
  return {
    page: pages[0],
    account: pages[1],
    routes,
    requests,
    storage,
    files,
    downloads,
    showCover(allowed: boolean, expiresAt: string | null = null) {
      showCover = allowed;
      coverExpiresAt = expiresAt;
    },
    failNextMembership() {
      membershipOffline = true;
    },
    failOfferRefresh() {
      rejectOffer = true;
    },
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
  h.page.chooseRelationship({
    currentTarget: { dataset: { relationship: "女儿" } },
  });
  h.page.agreementChange({ detail: { value: ["agree"] } });
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
test("switching through My keeps the chosen recommendation and reuses the authorized cover file", async () => {
  const h = await harness("home", [{ projectId }]);
  h.showCover(true);
  await h.page.onShow();
  const firstQuestion = h.page.data.question.id;
  h.page.nextQuestion();
  const question = h.page.data.question.id;
  assert.notEqual(question, firstQuestion);
  const image = h.page.data.coverImage;
  assert.ok(image && h.files.has(image));

  h.page.onHide();
  await h.account.onShow();
  h.account.onHide();
  const returning = h.page.onShow();
  assert.equal(h.page.data.coverImage, image);
  await returning;
  assert.equal(h.page.data.question.id, question);
  assert.equal(h.page.data.coverImage, image);
  assert.equal(h.downloads.length, 1);

  h.files.delete(image);
  await h.page.onShow();
  const recoveredImage = h.page.data.coverImage;
  assert.notEqual(recoveredImage, image);
  assert.ok(h.files.has(recoveredImage));
  assert.equal(h.downloads.length, 2);

  h.showCover(false);
  await h.page.onShow();
  assert.equal(h.page.data.coverImage, "");
  assert.equal(h.files.has(recoveredImage), false);
  assert.equal(h.downloads.length, 2);
});
test("logging out in My clears the hidden home cover before visiting home again", async () => {
  const h = await harness("home", [{ projectId }]);
  h.showCover(true);
  await h.page.onShow();
  const image = h.page.data.coverImage;
  assert.ok(h.files.has(image));
  h.page.onHide();
  await h.account.onShow();
  await h.account.logout();
  assert.equal(h.page.data.coverImage, "");
  assert.equal(h.page.data.overview, null);
  assert.equal(h.files.has(image), false);
});
test("an open home page clears the cover at its renewed authorization deadline", async (t) => {
  const start = Date.now();
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: start });
  const h = await harness("home", [{ projectId }]);
  h.showCover(true, new Date(start + 2000).toISOString());
  await h.page.onShow();
  const image = h.page.data.coverImage;
  assert.ok(h.files.has(image));

  t.mock.timers.tick(1000);
  h.showCover(true, new Date(start + 3000).toISOString());
  await h.page.onShow();
  t.mock.timers.tick(1000);
  assert.equal(h.page.data.coverImage, image);
  assert.equal(h.downloads.length, 1);

  t.mock.timers.tick(1000);
  assert.equal(h.page.data.coverImage, "");
  assert.equal(h.page.data.overview.projectId, projectId);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(h.files.has(image), false);
});
test("the public purchase button stays ready when revisiting a loaded home tab", async () => {
  const h = await harness("home", [], false);
  await h.page.onShow();
  assert.equal(h.page.data.offer.purchasable, true);
  h.page.onHide();
  const returning = h.page.onShow();
  await Promise.resolve();
  assert.equal(h.page.data.offerLoading, false);
  await returning;
});
test("a failed background catalog refresh keeps the last price and purchase entry", async () => {
  const h = await harness("home", [], false);
  await h.page.onShow();
  const { price, offerLabel } = h.page.data;
  h.page.onHide();
  h.failOfferRefresh();
  await h.page.onShow();
  assert.equal(h.page.data.price, price);
  assert.equal(h.page.data.offerLabel, offerLabel);
  assert.match(h.page.data.offerError, /套餐加载失败/);
  h.page.purchase();
  assert.equal(h.page.data.loginVisible, true);
});
test("retrying a membership timeout reloads the project with an offer already cached", async () => {
  const projects: object[] = [];
  const h = await harness("home", projects);
  await h.page.onShow();
  const price = h.page.data.price;
  projects.push({ projectId });
  h.failNextMembership();
  await h.page.onShow();
  assert.equal(h.page.data.overview, null);
  assert.equal(h.page.data.price, price);
  assert.match(h.page.data.status, /稍后重试/);
  assert.equal(h.page.data.offerError, "");

  const beforeRetry = h.requests.length;
  await h.page.refresh();
  const retried = h.requests.slice(beforeRetry);
  assert.ok(retried.includes("/participations"));
  assert.ok(retried.includes(`/projects/${projectId}/overview`));
  assert.equal(retried.includes("/packages/current"), false);
  assert.equal(h.page.data.overview.projectId, projectId);
  assert.equal(h.page.data.status, "");
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
