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
  ["plan"].map(
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
  const timers: (() => void)[] = [];
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
    setTimeout(callback: () => void) {
      timers.push(callback);
      return timers.length;
    },
    clearTimeout() {},
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
  return { page, requests, storage, routes, timers };
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

const plan = {
  subjectDecision: "self",
  decisionSessionId: null,
  projectId,
  revision: 1,
  createdBy: login.user.id,
  contentHash: "f".repeat(64),
  sourceTemplate: {
    id: "timenook-default",
    version: 1,
    contentHash: "f".repeat(64),
    reviewStatus: "unreviewed-test-only",
  },
  chapters: [
    {
      key: "places",
      title: "记得的地方",
      questions: [
        {
          key: "place",
          text: "那条小路是什么样的？",
          intent: "回忆一个具体场景",
          optionalContext: [],
          sensitivityTags: [],
          followupCandidates: [],
          locale: "zh-CN",
        },
      ],
    },
  ],
  starters: [
    { kind: "photo", text: "照片起讲", intent: "照片" },
    { kind: "free-narration", text: "自由讲述", intent: "自由" },
  ],
  preferences: { version: 1, blockedTopics: [] },
  questionStates: [],
  preferenceHistory: [],
  actualQuestions: [],
  accessExpiresAt: null,
};
test("actual personal plan page loads live HTTP, saves chapter/question changes and keeps a draft visible on conflict", async () => {
  const { page, requests } = harness("plan");
  page.onLoad({ projectId });
  const showing = page.onShow();
  assert.equal(requests[0].url, `${base}/projects/${projectId}/plan`);
  respond(requests.shift()!, plan);
  await showing;
  page.chapterTitle({
    currentTarget: { dataset: { chapter: "0" } },
    detail: { value: "我住过的地方" },
  });
  page.questionText({
    currentTarget: { dataset: { chapter: "0", question: "0" } },
    detail: { value: "门前的小路，你记得什么？" },
  });
  const saving = page.save();
  assert.equal(requests[0].url, `${base}/projects/${projectId}/plan`);
  assert.equal((requests[0].data as any).expectedVersion, 1);
  assert.equal(
    (requests[0].data as any).content.chapters[0].title,
    "我住过的地方",
  );
  respond(requests.shift()!, undefined, 409);
  await saving;
  assert.match(page.data.status, /冲突/);
  assert.equal(
    page.data.draft.chapters[0].questions[0].text,
    "门前的小路，你记得什么？",
  );
  assert.equal(page.data.plan.revision, 1);
});

test("account switch during a save removes all previous private plan and draft content", async () => {
  const { page, requests, storage } = harness("plan");
  page.onLoad({ projectId });
  const showing = page.onShow();
  respond(requests.shift()!, plan);
  await showing;
  page.addChapter();
  const saving = page.save();
  storage.set(`timenook.session.v1:${base}`, {
    ...login,
    user: { id: "99999999-9999-4999-8999-999999999999" },
    session: {
      ...login.session,
      id: "88888888-8888-4888-8888-888888888888",
      token: "b".repeat(43),
    },
  });
  respond(requests.shift()!, { ...plan, revision: 2 }, 201);
  await saving;
  assert.equal(page.data.plan, null);
  assert.equal(page.data.draft, null);
  assert.equal(page.data.busy, false);
  assert.match(page.data.status, /账号已变化/);
});

test("subject choices use a separate preference version and the actual current assisted evidence", async () => {
  const { page, requests } = harness("plan");
  page.onLoad({ projectId });
  const showing = page.onShow();
  const assisted = {
    ...plan,
    subjectDecision: "assisted",
    decisionSessionId: "55555555-5555-4555-8555-555555555555",
    preferences: { version: 4, blockedTopics: ["work"] },
  };
  respond(requests.shift()!, assisted);
  await showing;
  const choosing = page.decision({
    currentTarget: { dataset: { key: "place", state: "not-applicable" } },
  });
  const request = requests.shift()!;
  assert.equal(request.url, `${base}/projects/${projectId}/plan/preferences`);
  assert.equal((request.data as any).expectedVersion, 4);
  assert.equal(
    (request.data as any).assistedSessionId,
    assisted.decisionSessionId,
  );
  assert.deepEqual((request.data as any).blockedTopics, ["work"]);
  respond(
    request,
    {
      ...assisted,
      preferences: { ...assisted.preferences, version: 5 },
      questionStates: [{ questionKey: "place", state: "not-applicable" }],
    },
    201,
  );
  await choosing;
  assert.equal(page.data.plan.questionStates[0].state, "not-applicable");
});

test("expiry purges rendered private content, and a response arriving after hide cannot restore it", async () => {
  const clock = { now: Date.parse("2026-10-23T12:00:00.000Z") };
  const { page, requests, timers } = harness("plan", clock);
  page.onLoad({ projectId });
  const showing = page.onShow();
  respond(requests.shift()!, {
    ...plan,
    accessExpiresAt: "2026-10-23T12:10:00.000Z",
  });
  await showing;
  clock.now = Date.parse("2026-10-23T12:10:01.000Z");
  timers.shift()!();
  assert.equal(page.data.plan, null);
  assert.equal(page.data.draft, null);
  assert.match(page.data.status, /到期/);
  const refresh = page.refresh();
  page.onHide();
  respond(requests.shift()!, plan);
  await refresh;
  assert.equal(page.data.plan, null);
  assert.equal(page.data.draft, null);
});
