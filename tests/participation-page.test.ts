import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";
const base = "https://example.test/timenook/v1";
const projectId = "33333333-3333-4333-8333-333333333333";
const login = {
  user: { id: "11111111-1111-4111-8111-111111111111" },
  session: {
    id: "22222222-2222-4222-8222-222222222222",
    token: "a".repeat(43),
    expiresAt: "2099-01-01T00:00:00.000Z",
  },
};
const bundles = await Promise.all(
  ["invite", "welcome"].map(
    async (page) =>
      [
        page,
        (
          await build({
            entryPoints: [`miniprogram/pages/${page}/index.ts`],
            bundle: true,
            write: false,
            format: "cjs",
            platform: "neutral",
            define: { __TIMENOOK_API_BASE_URL__: JSON.stringify(base) },
          })
        ).outputFiles[0].text,
      ] as const,
  ),
);
function harness(name: string) {
  const storage = new Map<string, unknown>([
    ["timenook.mode.v1", "live"],
    [`timenook.session.v1:${base}`, login],
  ]);
  const requests: WechatMiniprogram.RequestOption[] = [];
  const routes: string[] = [];
  let page: any;
  runInNewContext(bundles.find(([n]) => n === name)![1], {
    Page(value: any) {
      page = value;
      page.setData = (patch: object) => Object.assign(page.data, patch);
    },
    wx: {
      getStorageSync(key: string) {
        assert.notEqual(
          key,
          "timenook.projects.v1",
          "live never reads demo projects",
        );
        return structuredClone(storage.get(key));
      },
      setStorageSync: (key: string, value: unknown) => storage.set(key, value),
      removeStorageSync: (key: string) => storage.delete(key),
      request: (r: WechatMiniprogram.RequestOption) => {
        requests.push(r);
        return {};
      },
      login: (options: WechatMiniprogram.LoginOption) =>
        options.success?.({
          code: "synthetic-relogin-code",
          errMsg: "login:ok",
        }),
      navigateTo: ({ url }: { url: string }) => routes.push(url),
      reLaunch: ({ url }: { url: string }) => routes.push(url),
      showToast: () => {},
      showModal: () => {},
    },
  });
  return { page, requests, storage, routes };
}
function respond(
  r: WechatMiniprogram.RequestOption,
  data: unknown,
  statusCode = 200,
) {
  assert.ok(r, "expected public platform request");
  r.success?.({
    statusCode,
    data:
      statusCode < 400
        ? { data, meta: { requestId: "synthetic" } }
        : {
            error: {
              code: statusCode === 401 ? "UNAUTHENTICATED" : "FORBIDDEN",
            },
            meta: { requestId: "synthetic" },
          },
    header: {},
    cookies: [],
    errMsg: "ok",
  } as unknown as WechatMiniprogram.RequestSuccessCallbackResult);
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function completeProjectState(
  requests: WechatMiniprogram.RequestOption[],
  value: unknown,
) {
  respond(requests.shift()!, value);
  await tick();
  const query = requests.shift()!;
  assert.equal(query?.url, `${base}/projects/${projectId}/care-requests`);
  respond(query, { requests: [] });
}
const current = {
  projectId,
  subjectId: "44444444-4444-4444-8444-444444444444",
  bindingVersion: 1,
  accessEpoch: 1,
  role: "narrator",
  noticeVersion: "synthetic-d08-v1",
  policyStatus: "synthetic-only",
  choices: ["collection", "ai", "sharing"].map((purpose) => ({
    purpose,
    granted: null,
  })),
  consent: [],
  canCollect: false,
  canProcessAi: false,
  canRead: false,
  careAvailable: true,
};
test("actual live invitation page prepares a server token for native sharing and approves a selected applicant", async () => {
  const { page, requests } = harness("invite");
  page.onLoad({ projectId });
  const showing = page.onShow();
  respond(requests.shift()!, { ...current, role: "initiator" });
  await tick();
  respond(requests.shift()!, {
    requests: [
      {
        id: "55555555-5555-4555-8555-555555555555",
        applicantUserId: login.user.id,
        state: "pending",
      },
    ],
  });
  await showing;
  const sharing = page.share();
  assert.equal(requests[0].url, `${base}/projects/${projectId}/invitations`);
  respond(
    requests.shift()!,
    { token: "b".repeat(43), expiresAt: "2099-01-01T00:00:00.000Z" },
    201,
  );
  await sharing;
  assert.equal(
    page.onShareAppMessage().path,
    `/pages/welcome/index?token=${"b".repeat(43)}`,
  );
  const approving = page.approve({
    currentTarget: { dataset: { id: "55555555-5555-4555-8555-555555555555" } },
  });
  assert.equal(
    requests[0].url,
    `${base}/binding-requests/55555555-5555-4555-8555-555555555555/approve`,
  );
  assert.equal((requests[0].data as any).expectedBindingVersion, 1);
  respond(requests.shift()!, { bindingVersion: 2, accessEpoch: 2 }, 201);
  await tick();
  respond(requests.shift()!, {
    ...current,
    role: "initiator",
    bindingVersion: 2,
  });
  await tick();
  respond(requests.shift()!, { requests: [] });
  await approving;
});
test("welcome refresh releases its own expired session and can log in again while an older 401 cannot replace a newer account", async () => {
  const { page, requests, storage } = harness("welcome");
  page.onLoad({ projectId });
  const expired = page.refreshLive();
  respond(requests.shift()!, undefined, 401);
  await expired;
  assert.equal(storage.has(`timenook.session.v1:${base}`), false);
  assert.equal(page.data.busy, false);
  assert.equal(page.data.loggedIn, false);
  assert.equal(page.data.accountId, "");
  assert.match(page.data.status, /登录已失效/);
  const loggingIn = page.loginLive();
  await page.onShow();
  await tick();
  assert.equal(requests[0].url, `${base}/sessions/wechat`);
  respond(requests.shift()!, login, 201);
  await tick();
  await completeProjectState(requests, current);
  await loggingIn;
  assert.equal(page.data.busy, false);
  assert.equal(page.data.loggedIn, true);
  const old = page.refreshLive();
  const oldRequest = requests.shift()!;
  const nextLogin = {
    user: { id: "77777777-7777-4777-8777-777777777777" },
    session: {
      ...login.session,
      id: "88888888-8888-4888-8888-888888888888",
      token: "z".repeat(43),
    },
  };
  storage.set(`timenook.session.v1:${base}`, nextLogin);
  const next = page.refreshLive();
  const nextRequest = requests.shift()!;
  respond(oldRequest, undefined, 401);
  await old;
  assert.equal(page.data.busy, true);
  assert.equal(page.data.loggedIn, true);
  assert.equal(page.data.accountId, nextLogin.user.id);
  assert.equal(page.data.status, "");
  assert.deepEqual(storage.get(`timenook.session.v1:${base}`), nextLogin);
  respond(nextRequest, current);
  await tick();
  respond(requests.shift()!, { requests: [] });
  await next;
  assert.equal(page.data.busy, false);
  const leaving = page.refreshLive();
  page.onHide();
  page.setData({ status: "页面已离开" });
  respond(requests.shift()!, undefined, 401);
  await leaving;
  assert.equal(page.data.status, "页面已离开");
});
test("actual welcome page applies without a total consent switch, then submits separate decisions with current epochs and drops late account responses", async () => {
  const { page, requests, storage } = harness("welcome");
  page.onLoad({ token: "b".repeat(43) });
  const showing = page.onShow();
  respond(requests.shift()!, {
    inviter: "发起人邀请你",
    process: ["说一段", "保存后看看故事", "确认成书"],
    purposes: ["collection", "ai", "sharing"],
    noticeVersion: "synthetic-d08-v1",
    policyStatus: "synthetic-only",
    choice: "可以撤回",
  });
  await showing;
  const applying = page.accept();
  assert.equal(
    requests[0].url,
    `${base}/invitations/${"b".repeat(43)}/requests`,
  );
  assert.equal((requests[0].data as any).granted, undefined);
  respond(
    requests.shift()!,
    { id: "55555555-5555-4555-8555-555555555555", projectId, state: "pending" },
    201,
  );
  await applying;
  assert.match(page.data.status, /等待发起人/);
  const refreshing = page.refreshLive();
  await completeProjectState(requests, current);
  await refreshing;
  const choice = page.chooseConsent({
    currentTarget: { dataset: { purpose: "collection", granted: "true" } },
  });
  assert.equal((requests[0].data as any).purpose, "collection");
  assert.equal((requests[0].data as any).expectedAccessEpoch, 1);
  respond(
    requests.shift()!,
    { ...current, accessEpoch: 2, canCollect: true, canRead: true },
    201,
  );
  await choice;
  assert.equal(page.data.participation.canCollect, true);
  const late = page.refreshLive();
  storage.delete(`timenook.session.v1:${base}`);
  respond(requests.shift()!, { ...current, canRead: true });
  await late;
  assert.equal(page.data.participation, null);
});
test("welcome restores open and completed care requests on reentry and does not query care after project authorization is rejected", async () => {
  const { page, requests } = harness("welcome");
  page.onLoad({ projectId });
  const show = page.onShow();
  respond(requests.shift()!, current);
  await tick();
  assert.equal(requests[0]?.url, `${base}/projects/${projectId}/care-requests`);
  const openCase = {
    id: "55555555-5555-4555-8555-555555555555",
    kind: "rebind",
    state: "open",
    createdAt: "2026-10-23T01:00:00.000Z",
  };
  respond(requests.shift()!, { requests: [openCase] });
  await show;
  assert.equal(page.data.careRequests[0].state, "open");
  page.onHide();
  assert.equal(page.data.careRequests.length, 0);
  const reentry = page.onShow();
  respond(requests.shift()!, current);
  await tick();
  respond(requests.shift()!, {
    requests: [{ ...openCase, state: "completed" }],
  });
  await reentry;
  assert.equal(page.data.careRequests[0].id, openCase.id);
  assert.equal(page.data.careRequests[0].state, "completed");
  const revoked = page.refreshLive();
  respond(requests.shift()!, undefined, 403);
  await revoked;
  assert.equal(page.data.participation, null);
  assert.equal(page.data.careRequests.length, 0);
  assert.equal(requests.length, 0);
});
for (const action of ["accept", "chooseConsent", "requestRebind"])
  test(`welcome ${action} releases an expired session and exposes login again`, async () => {
    const { page, requests } = harness("welcome");
    page.onLoad(
      action === "accept" ? { token: "b".repeat(43) } : { projectId },
    );
    const showing = page.onShow();
    if (action === "accept")
      respond(requests.shift()!, {
        inviter: "发起人",
        process: ["说一段"],
        purposes: ["collection", "ai", "sharing"],
        noticeVersion: "synthetic-d08-v1",
        policyStatus: "synthetic-only",
        choice: "可撤回",
      });
    else await completeProjectState(requests, current);
    await showing;
    if (action === "requestRebind")
      page.targetInput({
        detail: { value: "77777777-7777-4777-8777-777777777777" },
      });
    const acting =
      action === "chooseConsent"
        ? page.chooseConsent({
            currentTarget: {
              dataset: { purpose: "collection", granted: "true" },
            },
          })
        : page[action]();
    respond(requests.shift()!, undefined, 401);
    await acting;
    assert.equal(page.data.busy, false);
    assert.equal(page.data.loggedIn, false);
    assert.equal(page.data.participation, null);
    assert.match(page.data.status, /登录已失效/);
  });
for (const action of ["refreshLive", "share", "approve"])
  test(`invite ${action} releases an expired session and exposes login again`, async () => {
    const { page, requests, storage } = harness("invite");
    page.onLoad({ projectId });
    if (action !== "refreshLive") {
      const showing = page.onShow();
      respond(requests.shift()!, {
        ...current,
        role: "initiator",
        bindingVersion: 0,
      });
      await tick();
      respond(requests.shift()!, { requests: [] });
      await showing;
    }
    const acting =
      action === "approve"
        ? page.approve({
            currentTarget: {
              dataset: { id: "55555555-5555-4555-8555-555555555555" },
            },
          })
        : page[action]();
    respond(requests.shift()!, undefined, 401);
    await acting;
    assert.equal(page.data.busy, false);
    assert.equal(page.data.loggedIn, false);
    assert.equal(page.data.participation, null);
    assert.equal(page.data.inviteToken, "");
    assert.match(page.data.status, /登录已失效/);
    if (action === "refreshLive") {
      const relogin = page.loginLive();
      await page.onShow();
      await tick();
      respond(requests.shift()!, login, 201);
      await tick();
      respond(requests.shift()!, {
        ...current,
        role: "initiator",
        bindingVersion: 0,
      });
      await tick();
      respond(requests.shift()!, { requests: [] });
      await relogin;
      assert.equal(page.data.loggedIn, true);
      assert.equal(page.data.busy, false);
      const late = page.share();
      const pending = requests.shift()!;
      storage.set(`timenook.session.v1:${base}`, {
        ...login,
        session: { ...login.session, token: "z".repeat(43) },
      });
      page.onHide();
      page.setData({ status: "页面已离开" });
      respond(pending, undefined, 401);
      await late;
      assert.equal(page.data.status, "页面已离开");
      assert.equal(page.data.busy, false);
    }
  });
