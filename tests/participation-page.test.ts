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
    data: { data, meta: { requestId: "synthetic" } },
    header: {},
    cookies: [],
    errMsg: "ok",
  } as unknown as WechatMiniprogram.RequestSuccessCallbackResult);
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
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
  respond(requests.shift()!, current);
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
