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
  ["invite", "welcome", "assisted"].map(
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
function harness(name: string, clock?: { now: number }) {
  const storage = new Map<string, unknown>([
    ["timenook.mode.v1", "live"],
    [`timenook.session.v1:${base}`, login],
  ]);
  const requests: WechatMiniprogram.RequestOption[] = [];
  const routes: string[] = [];
  const clipboard: string[] = [];
  let page: any;
  runInNewContext(bundles.find(([n]) => n === name)![1], {
    ...(clock
      ? {
          Date: class extends Date {
            static now() {
              return clock?.now ?? Date.now();
            }
            constructor(value?: string | number) {
              super(value === undefined ? (clock?.now ?? Date.now()) : value);
            }
          },
        }
      : {}),
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
      setClipboardData: (options: { data: string }) =>
        clipboard.push(options.data),
      showToast: () => {},
      showModal: () => {},
    },
  });
  return { page, requests, storage, routes, clipboard };
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
test("assisted book confirmation records a distinct current purpose and returns to the pinned book", async () => {
  const { page, requests, routes } = harness("assisted"),
    bookVersionId = "66666666-6666-4666-8666-666666666666";
  page.onLoad({ projectId, bookVersionId, purpose: "book_confirmation" });
  const showing = page.onShow();
  respond(requests.shift()!, { ...current, role: "initiator" });
  await tick();
  respond(requests.shift()!, { sessions: [] });
  await tick();
  respond(requests.shift()!, { requests: [] });
  await showing;
  page.storyEvidence({ detail: { value: "本人同意本次书稿确认协助" } });
  const choosing = page.startStoryConfirmation({
    currentTarget: { dataset: { granted: "true" } },
  });
  const request = requests.shift()!;
  assert.ok(request);
  assert.equal((request.data as any).purpose, "book_confirmation");
  respond(request, {
    id: "55555555-5555-4555-8555-555555555555",
    purpose: "book_confirmation",
    state: "active",
  });
  await choosing;
  assert.equal(
    routes[0],
    `/pages/print/index?projectId=${projectId}&versionId=${bookVersionId}&assistedSessionId=55555555-5555-4555-8555-555555555555`,
  );
  page.onUnload();
});
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

for (const [name, actions] of [
  ["welcome", ["refreshLive", "accept", "chooseConsent", "requestRebind"]],
  ["invite", ["refreshLive", "share", "approve"]],
] as const)
  for (const action of actions)
    test(`${name} ${action} recovers when a successful response crosses the local session TTL`, async () => {
      const clock = { now: Date.parse("2026-10-23T01:00:00.000Z") };
      const { page, requests, storage } = harness(name, clock);
      storage.set(`timenook.session.v1:${base}`, {
        ...login,
        session: {
          ...login.session,
          expiresAt: new Date(clock.now + 1000).toISOString(),
        },
      });
      page.onLoad(
        action === "accept" ? { token: "b".repeat(43) } : { projectId },
      );
      if (action !== "refreshLive") {
        const showing = page.onShow();
        if (name === "invite") {
          respond(requests.shift()!, {
            ...current,
            role: "initiator",
            bindingVersion: 0,
          });
          await tick();
          respond(requests.shift()!, { requests: [] });
        } else if (action === "accept")
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
      }
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
          : action === "approve"
            ? page.approve({
                currentTarget: {
                  dataset: { id: "55555555-5555-4555-8555-555555555555" },
                },
              })
            : page[action]();
      const pending = requests.shift()!;
      assert.ok(pending);
      assert.equal(page.data.busy, true);
      clock.now += 2000;
      respond(pending, current, 200);
      await acting;
      assert.equal(page.data.busy, false);
      assert.equal(page.data.loggedIn, false);
      assert.equal(page.data.participation, null);
      assert.match(page.data.status, /登录已失效/);
      const relogin = page.loginLive();
      await tick();
      assert.equal(requests[0].url, `${base}/sessions/wechat`);
      respond(requests.shift()!, login, 201);
      await tick();
      if (name === "invite") {
        respond(requests.shift()!, {
          ...current,
          role: "initiator",
          bindingVersion: 0,
        });
        await tick();
        respond(requests.shift()!, { requests: [] });
      } else if (action === "accept")
        respond(requests.shift()!, {
          inviter: "发起人",
          process: ["说一段"],
          purposes: ["collection", "ai", "sharing"],
          noticeVersion: "synthetic-d08-v1",
          policyStatus: "synthetic-only",
          choice: "可撤回",
        });
      else await completeProjectState(requests, current);
      await relogin;
      assert.equal(page.data.busy, false);
      assert.equal(page.data.loggedIn, true);
    });
for (const name of ["welcome", "invite"])
  test(`${name} drops a cross-TTL success after an account or page change`, async () => {
    const clock = { now: Date.parse("2026-10-23T01:00:00.000Z") };
    const { page, requests, storage } = harness(name, clock);
    storage.set(`timenook.session.v1:${base}`, {
      ...login,
      session: {
        ...login.session,
        expiresAt: new Date(clock.now + 1000).toISOString(),
      },
    });
    page.onLoad({ projectId });
    const old = page.refreshLive();
    const oldRequest = requests.shift()!;
    clock.now += 2000;
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
    respond(oldRequest, current, 200);
    await old;
    assert.equal(page.data.busy, true);
    assert.equal(page.data.loggedIn, true);
    assert.equal(page.data.status, "");
    assert.deepEqual(storage.get(`timenook.session.v1:${base}`), nextLogin);
    respond(nextRequest, current);
    await tick();
    respond(requests.shift()!, { requests: [] });
    await next;
    assert.equal(page.data.busy, false);
    storage.set(`timenook.session.v1:${base}`, {
      ...nextLogin,
      session: {
        ...nextLogin.session,
        expiresAt: new Date(clock.now + 1000).toISOString(),
      },
    });
    const leaving = page.refreshLive();
    const leavingRequest = requests.shift()!;
    clock.now += 2000;
    page.onHide();
    page.setData({ status: "页面已离开" });
    respond(leavingRequest, current, 200);
    await leaving;
    assert.equal(page.data.status, "页面已离开");
    assert.equal(page.data.busy, false);
    assert.equal(page.data.participation, null);
  });

function submitSingleChoice(page: any, purpose: string, checked: boolean) {
  page.setData({
    purposes: [{ purpose, checked, label: purpose, description: "synthetic" }],
  });
  return page.submitChoices();
}
test("actual assisted page separately records consent and refusal with fresh evidence then recovers rights requests", async () => {
  const { page, requests } = harness("assisted");
  page.onLoad({ projectId });
  const showing = page.onShow();
  assert.equal(requests[0]?.url, `${base}/projects/${projectId}/participation`);
  respond(requests.shift()!, {
    ...current,
    role: "initiator",
    bindingVersion: 0,
  });
  await tick();
  respond(requests.shift()!, { sessions: [] });
  await tick();
  respond(requests.shift()!, { requests: [] });
  await showing;
  const chosen = submitSingleChoice(page, "collection", true);
  const post = requests.shift()!;
  assert.equal(post.url, `${base}/projects/${projectId}/assisted-sessions`);
  const body = post.data as Record<string, unknown>;
  assert.equal(body.purpose, "collection");
  assert.equal(body.granted, true);
  assert.match(String(body.evidenceRef), /^synthetic:/);
  assert.equal(body.expectedBindingVersion, 0);
  respond(
    post,
    {
      id: "55555555-5555-4555-8555-555555555555",
      projectId,
      subjectId: current.subjectId,
      operatorUserId: login.user.id,
      purpose: "collection",
      granted: true,
      noticeVersion: "synthetic-d08-v1",
      evidenceRef: body.evidenceRef,
      bindingVersion: 0,
      accessEpoch: 2,
      createdAt: "2026-01-01T00:00:00Z",
      expiresAt: "2099-01-01T00:00:00Z",
      state: "active",
    },
    201,
  );
  await tick();
  respond(requests.shift()!, {
    ...current,
    role: "initiator",
    bindingVersion: 0,
    accessEpoch: 2,
  });
  await tick();
  respond(requests.shift()!, { sessions: [] });
  await tick();
  respond(requests.shift()!, { requests: [] });
  await chosen;
  assert.match(page.data.status, /已保存/);
  assert.equal(page.data.busy, false);
  const refusal = submitSingleChoice(page, "ai", false);
  const denied = requests.shift()!;
  assert.equal((denied.data as any).granted, false);
  assert.notEqual((denied.data as any).evidenceRef, body.evidenceRef);
  respond(denied, {}, 403);
  await refusal;
  assert.equal(page.data.busy, false);
  assert.match(page.data.status, /未确认|重新查询/);
});

test("assisted page releases a pending operation after an account change and ignores its old result", async () => {
  const { page, requests, storage } = harness("assisted");
  page.onLoad({ projectId });
  const showing = page.onShow();
  storage.set(`timenook.session.v1:${base}`, {
    ...login,
    user: { id: "66666666-6666-4666-8666-666666666666" },
    session: {
      ...login.session,
      id: "77777777-7777-4777-8777-777777777777",
      token: "z".repeat(43),
    },
  });
  respond(requests.shift()!, {
    ...current,
    role: "initiator",
    bindingVersion: 0,
  });
  await showing;
  assert.equal(page.data.participation, null);
  assert.equal(page.data.busy, false);
  assert.match(page.data.status, /账号已变化/);
});

for (const expiration of ["401", "local-ttl"]) {
  test(`assisted ${expiration} expiry releases busy and clears subject data before relogin`, async () => {
    const clock = { now: Date.parse("2026-10-23T00:00:00Z") };
    const { page, requests } = harness("assisted", clock);
    page.onLoad({ projectId });
    const showing = page.onShow();
    if (expiration === "local-ttl")
      clock.now = Date.parse(login.session.expiresAt) + 1;
    respond(
      requests.shift()!,
      { ...current, role: "initiator", bindingVersion: 0 },
      expiration === "401" ? 401 : 200,
    );
    await showing;
    assert.equal(page.data.busy, false);
    assert.equal(page.data.loggedIn, false);
    assert.equal(page.data.participation, null);
    assert.equal(page.data.sessions.length, 0);
    assert.match(page.data.status, /登录已失效/);
  });
}

test("assisted rights submission reads the tracked case again and page departure fences old results", async () => {
  const { page, requests } = harness("assisted");
  page.onLoad({ projectId });
  const showing = page.onShow();
  respond(requests.shift()!, {
    ...current,
    role: "initiator",
    bindingVersion: 0,
  });
  await tick();
  respond(requests.shift()!, { sessions: [] });
  await tick();
  respond(requests.shift()!, { requests: [] });
  await showing;
  const submitting = page.requestRight({
    currentTarget: { dataset: { kind: "delete" } },
  });
  const posted = requests.shift()!;
  assert.equal(posted.url, `${base}/projects/${projectId}/care-requests`);
  assert.equal((posted.data as any).kind, "delete");
  respond(posted, { supportCaseRef: "record:synthetic" }, 201);
  await tick();
  const recovered = requests.shift()!;
  assert.equal(recovered.method, "GET");
  assert.equal(recovered.url, `${base}/projects/${projectId}/care-requests`);
  respond(recovered, {
    requests: [
      {
        id: "55555555-5555-4555-8555-555555555555",
        kind: "delete",
        state: "verified",
        createdAt: "2026-10-23T00:00:00Z",
      },
    ],
  });
  await submitting;
  assert.equal(page.data.careRequests[0].state, "verified");
  assert.match(page.data.status, /尚未完成/);
  const late = page.refresh();
  const pending = requests.shift()!;
  page.onHide();
  respond(pending, { ...current, role: "initiator", bindingVersion: 0 });
  await late;
  assert.equal(page.data.participation, null);
  assert.equal(page.data.busy, false);
  assert.equal(requests.length, 0);
});

test("assisted renewal sends the latest observed purpose session as its compare-and-swap precondition", async () => {
  const { page, requests } = harness("assisted");
  page.onLoad({ projectId });
  const showing = page.onShow();
  const prior = {
    id: "55555555-5555-4555-8555-555555555555",
    projectId,
    subjectId: current.subjectId,
    operatorUserId: login.user.id,
    purpose: "collection",
    granted: true,
    noticeVersion: "synthetic-d08-v1",
    evidenceRef: "synthetic:previous",
    bindingVersion: 0,
    accessEpoch: 0,
    createdAt: "2026-01-01T00:00:00Z",
    expiresAt: "2099-01-01T00:00:00Z",
    state: "active",
  };
  respond(requests.shift()!, {
    ...current,
    role: "initiator",
    bindingVersion: 0,
    accessEpoch: 0,
  });
  await tick();
  respond(requests.shift()!, { sessions: [prior] });
  await tick();
  respond(requests.shift()!, { requests: [] });
  await showing;
  const choosing = submitSingleChoice(page, "collection", true);
  const command = requests.shift()!;
  assert.equal((command.data as any).expectedSessionId, prior.id);
  respond(command, {}, 403);
  await choosing;
  assert.equal(page.data.busy, false);
});

test("assisted production authorization returns to the current production attempt instead of re-confirming a book", async () => {
  const { page, requests, routes } = harness("assisted"),
    bookVersionId = "66666666-6666-4666-8666-666666666666";
  page.onLoad({
    projectId,
    bookVersionId,
    purpose: "book_confirmation",
    returnTo: "production",
  });
  const showing = page.onShow();
  respond(requests.shift()!, { ...current, role: "initiator" });
  await tick();
  respond(requests.shift()!, { sessions: [] });
  await tick();
  respond(requests.shift()!, { requests: [] });
  await showing;
  page.storyEvidence({ detail: { value: "本人同意本次生产资料授权协助" } });
  const choosing = page.startStoryConfirmation({
    currentTarget: { dataset: { granted: "true" } },
  });
  respond(requests.shift()!, {
    id: "55555555-5555-4555-8555-555555555555",
    purpose: "book_confirmation",
    state: "active",
  });
  await choosing;
  assert.equal(
    routes[0],
    `/pages/production/index?projectId=${projectId}&assistedSessionId=55555555-5555-4555-8555-555555555555`,
  );
  page.onUnload();
});

test("a narrator can inspect withdrawal disposition after collection access ends and leaving clears it", async () => {
  const { page, requests } = harness("welcome");
  page.onLoad({ projectId });
  const shown = page.onShow();
  await completeProjectState(requests, current);
  await shown;
  const checking = page.showWithdrawal();
  const query = requests.shift()!;
  assert.equal(query.url, `${base}/projects/${projectId}/withdrawal-status`);
  respond(query, {
    projectId,
    accessEpoch: 2,
    changes: [
      {
        id: "66666666-6666-4666-8666-666666666666",
        purpose: "collection",
        applied: true,
      },
    ],
    production: {
      state: "cancellation_pending",
      ownerAdminId: "客服编号",
      caseId: "工单编号",
      dueAt: "2099-01-01T00:00:00Z",
    },
    boundary: "已导出文件和纸书不能远程收回",
  });
  await checking;
  assert.match(page.data.productionDisposition, /人工核实/);
  assert.equal(page.data.participation.canRead, false);
  page.onHide();
  assert.equal(page.data.withdrawal, null);
});

for (const route of ["welcome", "assisted"])
  test(`${route} keeps participation and tracked refund cases after the shared care list gains a refund`, async () => {
    const { page, requests } = harness(route);
    page.onLoad({ projectId });
    const showing = page.onShow();
    respond(
      requests.shift()!,
      route === "assisted"
        ? { ...current, role: "initiator", bindingVersion: 0 }
        : current,
    );
    await tick();
    if (route === "assisted") {
      respond(requests.shift()!, { sessions: [] });
      await tick();
    }
    respond(requests.shift()!, {
      requests: [
        {
          id: "55555555-5555-4555-8555-555555555555",
          kind: "refund",
          state: "open",
          createdAt: "2026-10-26T00:00:00Z",
        },
      ],
    });
    await showing;
    assert.ok(
      page.data.participation,
      "a refund case must not erase the current participation view",
    );
    assert.equal(page.data.careRequests[0]?.kind, "refund");
    assert.equal(page.data.careRequests[0].state, "open");
    page.onHide();
  });

test("本人参与与同机协助从当前项目进入删除进度，不要求私人内容可读", () => {
  for (const name of ["welcome", "assisted"]) {
    const h = harness(name);
    h.page.onLoad({ projectId });
    h.page.deletion();
    assert.equal(
      h.routes[0],
      `/pages/deletion-status/index?projectId=${projectId}`,
    );
    assert.equal(h.requests.length, 0);
  }
});
test("本人可从用途页提交删除申请，核验前不会声称删除完成", async () => {
  const h = harness("welcome");
  h.page.onLoad({ projectId });
  const showing = h.page.onShow();
  await completeProjectState(h.requests, current);
  await showing;
  const pending = h.page.requestDelete();
  const sent = h.requests.shift()!;
  assert.equal(sent.url, `${base}/projects/${projectId}/care-requests`);
  assert.deepEqual(JSON.parse(JSON.stringify(sent.data)), {
    kind: "delete",
    expectedBindingVersion: 1,
  });
  respond(sent, { supportCaseRef: "record:synthetic-delete" });
  await pending;
  assert.match(h.page.data.status, /待客服核验/);
  assert.doesNotMatch(h.page.data.status, /已删除/);
});

test("internal notice enables native invitation and separate choices without claiming the user's channel", async () => {
  const internal = {
    ...current,
    noticeVersion: "internal-participation-v1",
    policyStatus: "internal-acceptance",
    evidencePrefix: "internal:",
    noticeText: "内部功能验收告知",
  };
  const invite = harness("invite");
  invite.page.onLoad({ projectId });
  const showing = invite.page.onShow();
  respond(invite.requests.shift()!, { ...internal, role: "initiator" });
  await tick();
  respond(invite.requests.shift()!, { requests: [] });
  await showing;
  const sharing = invite.page.share();
  respond(
    invite.requests.shift()!,
    { token: "i".repeat(43), expiresAt: "2099-01-01T00:00:00.000Z" },
    201,
  );
  await sharing;
  invite.page.copyInvitation();
  assert.equal(
    invite.clipboard[0],
    `https://sgl.wootoon.cn/app/invitation/${"i".repeat(43)}`,
  );
  const welcome = harness("welcome");
  welcome.page.onLoad({ projectId });
  const refreshing = welcome.page.onShow();
  await completeProjectState(welcome.requests, internal);
  await refreshing;
  const choosing = welcome.page.chooseConsent({
    currentTarget: { dataset: { purpose: "collection", granted: "true" } },
  });
  const data = welcome.requests[0].data as Record<string, unknown>;
  assert.equal(data.noticeVersion, "internal-participation-v1");
  assert.match(String(data.evidenceRef), /^internal:/);
  assert.equal(data.method, undefined);
  respond(
    welcome.requests.shift()!,
    { ...internal, canCollect: true, canRead: true },
    201,
  );
  await choosing;
  assert.equal(welcome.page.data.participation.canCollect, true);
});

async function respondAssistedLoad(
  h: ReturnType<typeof harness>,
  sessions: unknown[] = [],
) {
  respond(h.requests.shift()!, {
    ...current,
    role: "initiator",
    bindingVersion: 0,
  });
  await tick();
  respond(h.requests.shift()!, { sessions });
  await tick();
  respond(h.requests.shift()!, { requests: [] });
  await tick();
}
test("one submit saves three independent checkbox choices then opens a fresh recording only after all succeed", async () => {
  const h = harness("assisted");
  h.page.onLoad({ projectId });
  const showing = h.page.onShow();
  await respondAssistedLoad(h);
  await showing;
  assert.deepEqual(
    Array.from(h.page.data.purposes, (row: any) => row.checked),
    [true, true, true],
  );
  assert.equal(
    h.requests.length,
    0,
    "defaults never grant permission before the click",
  );
  h.page.choicesChanged({ detail: { value: ["collection", "sharing"] } });
  const submitting = h.page.submitChoices();
  const sessions: any[] = [],
    evidence = new Set<string>();
  for (const [index, purpose] of ["collection", "ai", "sharing"].entries()) {
    const request = h.requests.shift()!;
    const body = request.data as any;
    assert.equal(body.purpose, purpose);
    assert.equal(body.granted, purpose !== "ai");
    evidence.add(body.evidenceRef);
    assert.equal(h.routes.length, 0, "wait for every independent choice");
    assert.equal(h.page.data.busy, true);
    const session = {
      ...body,
      projectId,
      subjectId: current.subjectId,
      operatorUserId: login.user.id,
      bindingVersion: 0,
      accessEpoch: current.accessEpoch,
      createdAt: "2026-10-30T00:00:00Z",
      id: `55555555-5555-4555-8555-55555555555${index}`,
      purpose,
      state: body.granted ? "active" : "rejected",
      expiresAt: "2099-01-01T00:00:00Z",
    };
    sessions.unshift(session);
    respond(request, session, 201);
    await tick();
    await respondAssistedLoad(h, sessions);
  }
  await submitting;
  assert.equal(evidence.size, 3);
  assert.match(
    h.routes[0],
    new RegExp(
      `/pages/interview/index\\?projectId=${projectId}&draftId=[a-f0-9-]{36}&assistedSessionId=55555555-5555-4555-8555-555555555550$`,
    ),
  );
  h.page.onUnload();
});
test("a failed later choice reports partial saving and never starts recording", async () => {
  const h = harness("assisted");
  h.page.onLoad({ projectId });
  const showing = h.page.onShow();
  await respondAssistedLoad(h);
  await showing;
  const submitting = h.page.submitChoices();
  respond(h.requests.shift()!, {}, 201);
  await tick();
  await respondAssistedLoad(h);
  respond(h.requests.shift()!, {}, 503);
  await submitting;
  assert.match(h.page.data.status, /已有 1 项选择保存/);
  assert.equal(h.routes.length, 0);
  assert.equal(h.page.data.busy, false);
  assert.equal(h.requests.length, 0);
  h.page.onUnload();
});
