import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";
const base = "https://example.test/timenook/v1";
const projectId = "33333333-3333-4333-8333-333333333333";
const interviewId = "44444444-4444-4444-8444-444444444444";
const clipId = "55555555-5555-4555-8555-555555555555";
const code = (
  await build({
    entryPoints: ["miniprogram/pages/project/index.ts"],
    bundle: true,
    write: false,
    format: "cjs",
    platform: "neutral",
    define: { __TIMENOOK_API_BASE_URL__: JSON.stringify(base) },
  })
).outputFiles[0].text;
const tick = () => new Promise((resolve) => setImmediate(resolve));
test("project keeps pending stories and recording recovery visible while completed history stays folded", async () => {
  let page: any;
  const routes: string[] = [],
    requests: any[] = [];
  const storage = new Map<string, unknown>([
    ["timenook.mode.v1", "live"],
    [
      `timenook.session.v1:${base}`,
      {
        user: { id: "11111111-1111-4111-8111-111111111111" },
        session: {
          id: "22222222-2222-4222-8222-222222222222",
          token: "a".repeat(43),
          expiresAt: "2099-01-01T00:00:00Z",
        },
      },
    ],
  ]);
  runInNewContext(code, {
    setTimeout: () => 1,
    clearTimeout() {},
    Page(value: any) {
      page = value;
      page.setData = (patch: object) => Object.assign(page.data, patch);
    },
    wx: {
      getStorageSync: (key: string) => structuredClone(storage.get(key)),
      setStorageSync: (key: string, value: unknown) =>
        storage.set(key, structuredClone(value)),
      request: (r: any) => requests.push(r),
      navigateTo: ({ url }: any) => routes.push(url),
    },
  });
  const respond = (data: unknown) =>
    requests
      .shift()
      .success({
        statusCode: 200,
        data: { data, meta: { requestId: "synthetic" } },
      });
  page.onLoad({ projectId });
  const showing = page.onShow();
  respond({
    projectId,
    role: "narrator",
    accessEpoch: 1,
    bindingVersion: 1,
    choices: ["collection", "ai", "sharing"].map((purpose) => ({
      purpose,
      granted: true,
    })),
    canRead: true,
    canCollect: true,
  });
  await tick();
  respond({
    projectId,
    bookTitle: "真实项目",
    metadataVersion: 1,
    canDecide: true,
    accessExpiresAt: null,
    nextStep: "请核对故事",
    summary: { pending: 1, confirmed: 1, included: 1 },
    interviews: [
      {
        id: interviewId,
        actualQuestion: { snapshot: { text: "小时候的家是什么样？" } },
        clips: [{ id: clipId, state: "sealed" }],
      },
    ],
    stories: [
      {
        id: "confirmed",
        interviewId: "older",
        revision: { title: "已经确认的故事" },
        decision: { confirmed: true },
      },
      {
        id: "pending",
        interviewId,
        revision: { title: "待本人核对" },
        decision: null,
      },
    ],
    tasks: [
      {
        id: "failure",
        projectId,
        clipId,
        kind: "transcribe_audio",
        state: "failed",
        retryable: true,
        nextAction: "retry",
      },
      {
        id: "done",
        projectId,
        kind: "compose_story",
        state: "succeeded",
        retryable: false,
        nextAction: "continue",
      },
    ],
  });
  await showing;
  assert.equal(page.data.liveStories[0].id, "pending");
  assert.equal(page.data.recentInterview.id, interviewId);
  assert.equal(page.data.historyExpanded, false);
  assert.equal(page.data.faultRows[0].id, "failure");
  page.recoverTask({ currentTarget: { dataset: { id: "failure" } } });
  assert.equal(
    routes.pop(),
    `/pages/interview/index?projectId=${projectId}&interviewId=${interviewId}`,
  );
  page.toggleHistory();
  assert.equal(page.data.historyExpanded, true);
  assert.equal(page.data.historyTaskRows[0].id, "done");
  page.onHide();
  assert.equal(page.data.recentInterview, null);
  assert.equal(page.data.faultRows.length, 0);
  assert.equal(page.data.historyTaskRows.length, 0);
});
