import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";

const base = "https://example.test/timenook/v1";
const projectId = "33333333-3333-4333-8333-333333333333";
const storyId = "55555555-5555-4555-8555-555555555555";
const interviewId = "44444444-4444-4444-8444-444444444444";
const source = { clipId: "original-recording", durationMs: 90500 };
function story(included = true) {
  return {
    id: storyId,
    projectId,
    interviewId,
    version: 2,
    chapter: null,
    questionKey: null,
    included,
    currentRevisionId: "revision-2",
    task: null,
    revision: {
      id: "revision-2",
      title: "老院子的夏天",
      theme: "童年",
      version: 2,
      paragraphs: [
        { text: "我们坐在树下听雨。", sourceRefs: ["original-ref"] },
      ],
      sourceManifest: [source],
      audioManifest: [source],
      notes: [],
      reviewResolutions: [],
      photoSnapshot: { id: "saved-photo-version", entries: [] },
    },
  };
}
function plan() {
  return {
    projectId,
    revision: 4,
    starters: [],
    preferences: { version: 1, blockedTopics: [] },
    questionStates: [],
    actualQuestions: [],
    answers: [],
    subjectDecision: "member",
    accessExpiresAt: null,
    chapters: [
      {
        key: "childhood",
        title: "我的童年",
        questions: [],
        storyRefs: ["other-story"],
      },
      { key: "learning", title: "求学与成长", questions: [], storyRefs: [] },
    ],
  };
}
async function harness(name: string, respond: (request: any) => any) {
  const compiled = await build({
    entryPoints: [`miniprogram/pages/${name}/index.ts`],
    bundle: true,
    write: false,
    format: "cjs",
    platform: "neutral",
    define: { __TIMENOOK_API_BASE_URL__: JSON.stringify(base) },
  });
  const storage = new Map<string, any>([
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
  let page: any;
  const requests: any[] = [],
    routes: string[] = [];
  runInNewContext(compiled.outputFiles[0].text, {
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Page(value: any) {
      page = value;
      page.setData = (value: object) => Object.assign(page.data, value);
    },
    wx: {
      getStorageSync: (key: string) => structuredClone(storage.get(key)),
      setStorageSync: (key: string, value: any) =>
        storage.set(key, structuredClone(value)),
      removeStorageSync: (key: string) => storage.delete(key),
      request: (request: any) => {
        requests.push(request);
        Promise.resolve(respond(request)).then((data) =>
          request.success({
            statusCode: 200,
            data: { data, meta: { requestId: "synthetic" } },
          }),
        );
      },
      navigateBack: () => routes.push("back"),
      navigateTo: ({ url }: any) => routes.push(url),
      showToast() {},
      enableAlertBeforeUnload() {},
      disableAlertBeforeUnload() {},
    },
  });
  page.onLoad({ projectId, storyId });
  return { page, requests, routes, storage };
}
const tap = (id: string) => ({ currentTarget: { dataset: { id } } });

test("chapter choice saves the real plan, moves a story once and returns to its caller", async () => {
  const current = story();
  current.chapter = { key: "childhood", title: "我的童年" } as any;
  const original = plan();
  original.chapters[0].storyRefs.push(storyId);
  const h = await harness("assign-story", (r) =>
    r.url.endsWith("/plan")
      ? r.method === "POST"
        ? { ...original, revision: 5, ...r.data.content }
        : original
      : current,
  );
  await h.page.onShow();
  assert.equal(h.page.data.title, "老院子的夏天");
  h.page.choose(tap("learning"));
  await h.page.save();
  const write = h.requests.find((r) => r.method === "POST");
  assert.equal(write.url, `${base}/projects/${projectId}/plan`);
  assert.equal(write.data.expectedVersion, 4);
  assert.deepEqual(Array.from(write.data.content.chapters[0].storyRefs), [
    "other-story",
  ]);
  assert.deepEqual(Array.from(write.data.content.chapters[1].storyRefs), [
    storyId,
  ]);
  assert.deepEqual(h.routes, ["back"]);
  h.page.onUnload();
});

test("excluded stories can return to a chapter or restore as unassigned without changing their materials", async () => {
  for (const destination of ["learning", null]) {
    const original = story(false),
      currentPlan = plan();
    const h = await harness("assign-story", (r) => {
      if (r.url.endsWith("/plan"))
        return r.method === "POST"
          ? { ...currentPlan, revision: 5, ...r.data.content }
          : currentPlan;
      return r.url.endsWith("/inclusion")
        ? { ...original, included: true }
        : original;
    });
    await h.page.onShow();
    if (destination) {
      h.page.choose(tap(destination));
      await h.page.save();
    } else await h.page.unassign();
    const writes = h.requests.filter((r) => r.method === "POST");
    assert.equal(
      writes[0].url,
      `${base}/projects/${projectId}/stories/${storyId}/inclusion`,
    );
    assert.deepEqual(JSON.parse(JSON.stringify(writes[0].data)), {
      expectedVersion: 2,
      included: true,
    });
    assert.deepEqual(
      Array.from(writes[1].data.content.chapters[1].storyRefs),
      destination ? [storyId] : [],
    );
    assert.equal(
      writes.some((r) => r.url.endsWith("/revisions")),
      false,
    );
    assert.deepEqual(h.routes, ["back"]);
    h.page.onUnload();
  }
});

test("confirming the current chapter preserves the story's existing reading order", async () => {
  const current = story();
  current.chapter = { key: "childhood", title: "我的童年" } as any;
  const original = plan();
  original.chapters[0].storyRefs = [storyId, "other-story"];
  const h = await harness("assign-story", (r) =>
    r.url.endsWith("/plan")
      ? r.method === "POST"
        ? { ...original, ...r.data.content }
        : original
      : current,
  );
  await h.page.onShow();
  await h.page.save();
  assert.deepEqual(
    Array.from(
      h.requests.find((r) => r.method === "POST").data.content.chapters[0]
        .storyRefs,
    ),
    [storyId, "other-story"],
  );
  h.page.onUnload();
});

test("unassigned list keeps excluded stories separate and restores through chapter choice", async () => {
  const unassigned = story(),
    excluded = { ...story(false), id: "excluded-story" };
  const overview = {
    projectId,
    bookTitle: "家人的故事",
    metadataVersion: 1,
    stories: [unassigned, excluded],
    interviews: [],
    tasks: [],
    summary: {},
    nextStep: "",
    canDecide: true,
  };
  const h = await harness("stories", () => overview);
  h.page.onLoad({ projectId, filter: "unassigned" });
  await h.page.onShow();
  assert.deepEqual(
    Array.from(h.page.data.rows, (s: any) => s.id),
    [storyId],
  );
  assert.deepEqual(
    Array.from(h.page.data.excludedRows, (s: any) => s.id),
    ["excluded-story"],
  );
  h.page.assign(tap("excluded-story"));
  assert.equal(
    h.routes[0],
    `/pages/assign-story/index?projectId=${projectId}&storyId=excluded-story`,
  );
  h.page.onHide();
  assert.equal(h.page.data.rows.length, 0);
  assert.equal(h.page.data.excludedRows.length, 0);
  h.page.onUnload();
});

test("text editing saves a new revision with existing photo and audio references and returns only after save", async () => {
  const current = story();
  const h = await harness("edit-story", () => current);
  await h.page.onShow();
  h.page.input({
    currentTarget: { dataset: { field: "title" } },
    detail: { value: "老院子里的一场雨" },
  });
  h.page.input({
    currentTarget: { dataset: { field: "body" } },
    detail: { value: "我们坐在树下听雨。\n\n后来雨停了。" },
  });
  await h.page.save();
  const write = h.requests.find((r) => r.method === "POST");
  assert.equal(
    write.url,
    `${base}/projects/${projectId}/stories/${storyId}/revisions`,
  );
  assert.equal(write.data.expectedVersion, 2);
  assert.equal(write.data.baseRevisionId, "revision-2");
  assert.equal(write.data.title, "老院子里的一场雨");
  assert.equal(write.data.photoSnapshotId, "saved-photo-version");
  assert.deepEqual(Array.from(write.data.audioClipIds), ["original-recording"]);
  assert.deepEqual(Array.from(write.data.paragraphs[0].sourceRefs), [
    "original-ref",
  ]);
  assert.match(write.data.paragraphs[1].sourceRefs[0], /^note:/);
  assert.deepEqual(h.routes, ["back"]);
  h.page.onUnload();
});

test("leaving an edit during save never replaces a later page's status or navigation", async () => {
  let finish: (value: unknown) => void = () => {};
  const h = await harness("edit-story", (r) =>
    r.method === "POST"
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : story(),
  );
  await h.page.onShow();
  h.page.input({
    currentTarget: { dataset: { field: "body" } },
    detail: { value: "修改的正文" },
  });
  const saving = h.page.save();
  await new Promise((r) => setImmediate(r));
  h.page.onHide();
  assert.equal(h.page.data.busy, false);
  finish(story());
  await saving;
  assert.deepEqual(h.routes, []);
  h.page.onUnload();
  assert.equal(h.page.data.body, "");
});
