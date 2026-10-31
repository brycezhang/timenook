import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";

const base = "https://example.test/timenook/v1";
const projectId = "33333333-3333-4333-8333-333333333333";
const interviewId = "44444444-4444-4444-8444-444444444444";
const storyId = "55555555-5555-4555-8555-555555555555";
const revisionId = "66666666-6666-4666-8666-666666666666";
const login = {
  user: { id: "11111111-1111-4111-8111-111111111111" },
  session: {
    id: "22222222-2222-4222-8222-222222222222",
    token: "a".repeat(43),
    expiresAt: "2099-01-01T00:00:00Z",
  },
};
const compiled = new Map(
  await Promise.all(
    [
      "project",
      "story",
      "edit-story",
      "settings",
      "book",
      "account",
      "assisted",
    ].map(
      async (name) =>
        [
          name,
          (
            await build({
              entryPoints: [`miniprogram/pages/${name}/index.ts`],
              bundle: true,
              write: false,
              format: "cjs",
              platform: "neutral",
              define: { __TIMENOOK_API_BASE_URL__: JSON.stringify(base) },
            })
          ).outputFiles[0].text,
        ] as const,
    ),
  ),
);
compiled.set(
  "story-assisted",
  (
    await build({
      stdin: {
        contents:
          'import "./miniprogram/pages/story/index"; import "./miniprogram/pages/assisted/index";',
        resolveDir: process.cwd(),
      },
      bundle: true,
      write: false,
      format: "cjs",
      platform: "neutral",
      define: { __TIMENOOK_API_BASE_URL__: JSON.stringify(base) },
    })
  ).outputFiles[0].text,
);
function harness(name: string, options: { clock?: { now: number } } = {}) {
  const clock = options.clock ?? { now: Date.now() };
  const storage = new Map<string, any>([
    ["timenook.mode.v1", "live"],
    [`timenook.session.v1:${base}`, structuredClone(login)],
  ]);
  const requests: any[] = [],
    routes: string[] = [],
    timers: (() => void)[] = [],
    pages: any[] = [],
    downloads: any[] = [],
    removed: string[] = [];
  let page: any;
  runInNewContext(compiled.get(name)!, {
    Date: class extends Date {
      static now() {
        return clock.now;
      }
    },
    setTimeout: (f: () => void) => {
      timers.push(f);
      return timers.length;
    },
    clearTimeout() {},
    setInterval,
    clearInterval,
    Page(value: any) {
      page = value;
      const instance = page;
      instance.setData = (patch: object) => Object.assign(instance.data, patch);
      pages.push(instance);
    },
    wx: {
      getStorageSync(key: string) {
        assert.notEqual(
          key,
          "timenook.frontend.v1",
          "live must not read demo state",
        );
        return structuredClone(storage.get(key));
      },
      setStorageSync: (key: string, value: any) =>
        storage.set(key, structuredClone(value)),
      removeStorageSync: (key: string) => storage.delete(key),
      request: (request: any) => requests.push(request),
      login: (o: any) => o.success({ code: "synthetic-new-account" }),
      downloadFile: (download: any) => downloads.push(download),
      navigateTo: ({ url }: any) => routes.push(url),
      switchTab: ({ url }: { url: string }) => routes.push(url),
      reLaunch: ({ url }: any) => routes.push(url),
      navigateBack: () => routes.push("back"),
      showToast() {},
      getFileSystemManager: () => ({
        unlink: (o: any) => {
          removed.push(o.filePath);
          o.success?.({});
        },
      }),
    },
  });
  return {
    page,
    pages,
    downloads,
    removed,
    storage,
    requests,
    routes,
    timers,
    expireSession() {
      clock.now = Date.parse(login.session.expiresAt);
    },
    respond(index: number, data: any, statusCode = 200) {
      assert.ok(requests[index], "expected platform request");
      requests[index].success({
        statusCode,
        data:
          statusCode < 400
            ? { data, meta: { requestId: "synthetic" } }
            : {
                error: {
                  code:
                    statusCode === 409
                      ? "VERSION_CONFLICT"
                      : statusCode === 503
                        ? "SERVICE_UNAVAILABLE"
                        : statusCode === 401
                          ? "UNAUTHENTICATED"
                          : "FORBIDDEN",
                },
                meta: { requestId: "synthetic" },
              },
      });
    },
  };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const participation = {
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
};
function story() {
  return {
    confirmation: {
      canDecide: true,
      allowInBook: false,
      noticeVersion: "synthetic-d08-v1",
      evidencePrefix: "synthetic:",
    },
    id: storyId,
    projectId,
    interviewId,
    version: 1,
    currentRevisionId: revisionId,
    decision: null,
    usage: { organizations: 1, regenerations: 0 },
    task: null,
    revision: {
      id: revisionId,
      version: 1,
      title: "门前的小路",
      theme: "故乡",
      paragraphs: [
        {
          text: "我记得那条很长的小路。".repeat(150),
          sourceRefs: ["note:77777777-7777-4777-8777-777777777777"],
        },
      ],
      reviewItems: [] as string[],
      reviewResolutions: [],
      notes: [{ id: "77777777-7777-4777-8777-777777777777", text: "本人说明" }],
      sourceManifest: [],
      audioManifest: [],
      photoSnapshot: null,
      contentHash: "f".repeat(64),
      origin: "participant",
    },
  };
}
test("reading never confirms; one actual click confirms the pinned revision with actual click evidence", async () => {
  const h = harness("story");
  h.page.onLoad({ projectId, storyId });
  const showing = h.page.onShow();
  await tick();
  const value = story();
  value.confirmation.allowInBook = true;
  h.respond(0, value);
  await showing;
  assert.equal(h.requests.length, 1);
  assert.equal(h.page.data.canDecide, true);
  const deciding = h.page.decideLive();
  const sent = h.requests[1]?.data;
  assert.ok(sent, "one confirm click sends its actual action");
  assert.equal(sent.confirmed, true);
  assert.equal(sent.allowInBook, true);
  assert.equal(sent.revisionId, revisionId);
  assert.equal(sent.contentHash, "f".repeat(64));
  assert.equal(sent.noticeVersion, "synthetic-d08-v1");
  assert.match(sent.evidenceRef, /^synthetic:click:story-confirm:/);
  await h.page.decideLive();
  assert.equal(h.requests.length, 2);
  h.respond(1, {
    ...value,
    decision: { revisionId, confirmed: true, allowInBook: true },
  });
  await deciding;
  assert.match(h.page.data.decisionStatus, /允许这版入书/);
  h.page.onUnload();
});
function overview() {
  const initialQuestion = {
    id: "99999999-9999-4999-8999-999999999991",
    projectId,
    planRevision: 1,
    capturedBy: login.user.id,
    questionKey: "place",
    starterKind: null,
    snapshot: { text: "家门前是什么样？", intent: "回忆故乡" },
    answerRef: interviewId,
  };
  return {
    projectId,
    bookTitle: "我的岁月",
    metadataVersion: 1,
    subjectId: "88888888-8888-4888-8888-888888888888",
    role: "narrator",
    canDecide: true,
    stories: [story()],
    tasks: [] as any[],
    interviews: [
      {
        id: interviewId,
        projectId,
        subjectId: "88888888-8888-4888-8888-888888888888",
        actualQuestion: initialQuestion,
        currentQuestion: {
          ...initialQuestion,
          id: "99999999-9999-4999-8999-999999999992",
          source: {
            kind: "follow-up",
            generationTaskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          },
          snapshot: { text: "那条小路上还有谁？", intent: "补充人物" },
        },
        questionVersion: 2,
        clips: [],
        usage: { reservedMs: 0, consumedMs: 0 },
      },
    ],
    summary: { pending: 1, confirmed: 0, included: 0 },
    nextStep: "请核对并确认一篇故事",
    accessExpiresAt: null,
  };
}

function correctionStory() {
  const current: any = story();
  current.revision.reviewItems = ["请本人核对地点"];
  current.revision.reviewResolutions = [
    { item: "请本人核对地点", reason: "本人独立核对" },
  ];
  current.revision.sourceManifest = [
    { clipId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
  ];
  current.revision.audioManifest = current.revision.sourceManifest;
  current.revision.photoSnapshot = {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    projectId,
    interviewId,
    revision: 1,
    hash: "b".repeat(64),
    entries: [
      {
        photoId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        caption: "私人照片说明",
        assets: [],
      },
    ],
  };
  return current;
}
async function openCorrection() {
  const h = harness("edit-story");
  h.page.onLoad({ projectId, storyId });
  const showing = h.page.onShow();
  h.respond(0, correctionStory());
  await showing;
  h.page.paragraphText({
    currentTarget: { dataset: { index: "0" } },
    detail: { value: "本人正在校对的私人正文" },
  });
  h.page.input({
    currentTarget: { dataset: { field: "noteText" } },
    detail: { value: "尚未保存的私人说明" },
  });
  return h;
}
test("a current correction save 403 clears the private page and its listener without revoking the valid session or deleting pending originals", async () => {
  const h = await openCorrection();
  const originalKey = "synthetic-pending-originals",
    originals = [
      { path: "only-original-audio" },
      { path: "only-original-photo" },
    ];
  h.storage.set(originalKey, originals);
  const saving = h.page.save();
  h.respond(1, undefined, 403);
  await saving;
  assert.equal(h.page.data.story, null);
  assert.equal(h.page.data.title, "");
  assert.equal(h.page.data.theme, "");
  assert.equal(h.page.data.body, "");
  assert.equal(h.page.data.paragraphs.length, 0);
  assert.equal(h.page.data.notes.length, 0);
  assert.equal(h.page.data.reviews.length, 0);
  assert.equal(h.page.data.photoSnapshot, null);
  assert.equal(h.page.data.audioClips.length, 0);
  assert.equal(h.page.data.noteText, "");
  assert.equal(h.page.data.busy, false);
  assert.equal(h.page.stopSessionWatch, undefined);
  assert.equal(h.page.command, null);
  assert.match(h.page.data.error, /访问|授权/);
  assert.deepEqual(h.storage.get(`timenook.session.v1:${base}`), login);
  assert.deepEqual(h.storage.get(originalKey), originals);
  assert.equal(h.removed.length, 0);
  h.page.onUnload();
});

test("a current photo-snapshot read 403 clears the existing correction draft instead of retaining private photos and audio rows", async () => {
  const h = await openCorrection();
  const originalKey = "synthetic-pending-originals",
    originals = [
      { path: "only-original-audio" },
      { path: "only-original-photo" },
    ];
  h.storage.set(originalKey, originals);
  const applying = h.page.applyPhotos();
  h.respond(1, undefined, 403);
  await applying;
  assert.equal(h.page.data.story, null);
  assert.equal(h.page.data.title, "");
  assert.equal(h.page.data.theme, "");
  assert.equal(h.page.data.paragraphs.length, 0);
  assert.equal(h.page.data.notes.length, 0);
  assert.equal(h.page.data.reviews.length, 0);
  assert.equal(h.page.data.photoSnapshot, null);
  assert.equal(h.page.data.audioClips.length, 0);
  assert.equal(h.page.data.noteText, "");
  assert.equal(h.page.data.busy, false);
  assert.equal(h.page.stopSessionWatch, undefined);
  assert.equal(h.page.command, null);
  assert.match(h.page.data.error, /访问|授权/);
  assert.deepEqual(h.storage.get(`timenook.session.v1:${base}`), login);
  assert.deepEqual(h.storage.get(originalKey), originals);
  assert.equal(h.removed.length, 0);
  h.page.onUnload();
});

async function openSettings() {
  const h = harness("settings");
  h.page.onLoad({ projectId });
  const showing = h.page.onShow();
  h.respond(0, overview());
  await showing;
  h.page.input({
    currentTarget: { dataset: { field: "title" } },
    detail: { value: "本人校对中的私人书名" },
  });
  return h;
}
test("a current book-title save 403 clears private overview and title without logging out or removing local originals", async () => {
  const h = await openSettings();
  const originalKey = "synthetic-pending-originals",
    originals = [
      { path: "only-original-audio" },
      { path: "only-original-photo" },
    ];
  h.storage.set(originalKey, originals);
  const saving = h.page.save();
  h.respond(1, undefined, 403);
  await saving;
  assert.equal(h.page.data.overview, null);
  assert.equal(h.page.data.title, "");
  assert.equal(h.page.data.busy, false);
  assert.equal(h.page.stopSessionWatch, undefined);
  assert.equal(h.page.command, null);
  assert.match(h.page.data.error, /访问|授权/);
  assert.deepEqual(h.storage.get(`timenook.session.v1:${base}`), login);
  assert.deepEqual(h.storage.get(originalKey), originals);
  assert.equal(h.removed.length, 0);
  assert.equal(h.routes.length, 0);
  h.page.onUnload();
});

for (const surface of ["correction", "photos", "settings"] as const) {
  for (const outcome of [409, 503, "network"] as const) {
    test(`a valid-session ${surface} ${outcome} preserves its private draft and original save key for recovery`, async () => {
      const h =
        surface === "settings" ? await openSettings() : await openCorrection();
      const originalKey = "synthetic-pending-originals",
        originals = [
          { path: "only-original-audio" },
          { path: "only-original-photo" },
        ];
      h.storage.set(originalKey, originals);
      let key = "";
      if (surface === "photos") {
        const firstSave = h.page.save();
        key = h.requests[1].header["Idempotency-Key"];
        h.requests[1].fail({ errMsg: "controlled uncertain save" });
        await firstSave;
      }
      const index = h.requests.length,
        action = surface === "photos" ? h.page.applyPhotos() : h.page.save();
      if (surface !== "photos")
        key = h.requests[index].header["Idempotency-Key"];
      if (outcome === "network")
        h.requests[index].fail({ errMsg: "controlled network failure" });
      else h.respond(index, undefined, outcome);
      await action;
      if (surface === "settings") {
        assert.ok(h.page.data.overview);
        assert.equal(h.page.data.title, "本人校对中的私人书名");
      } else {
        assert.ok(h.page.data.story);
        assert.equal(h.page.data.paragraphs[0].text, "本人正在校对的私人正文");
        assert.equal(
          h.page.data.photoSnapshot.entries[0].caption,
          "私人照片说明",
        );
        assert.equal(h.page.data.audioClips.length, 1);
        assert.equal(h.page.data.noteText, "尚未保存的私人说明");
      }
      assert.equal(h.page.data.busy, false);
      assert.equal(typeof h.page.stopSessionWatch, "function");
      assert.equal(h.routes.length, 0);
      assert.deepEqual(h.storage.get(`timenook.session.v1:${base}`), login);
      assert.deepEqual(h.storage.get(originalKey), originals);
      assert.equal(h.removed.length, 0);
      const retryIndex = h.requests.length,
        retrying = h.page.save();
      assert.equal(h.requests[retryIndex].header["Idempotency-Key"], key);
      h.respond(
        retryIndex,
        surface === "settings"
          ? {
              ...overview(),
              metadataVersion: 2,
              bookTitle: "本人校对中的私人书名",
            }
          : { ...correctionStory(), version: 2 },
      );
      await retrying;
      h.page.onUnload();
    });
  }
  for (const replacement of ["account", "project"] as const) {
    test(`an old ${surface} 403 cannot clear a later ${replacement}'s page, listener or pending originals`, async () => {
      const h =
        surface === "settings" ? await openSettings() : await openCorrection();
      const originalKey = "synthetic-pending-originals",
        originals = [
          { path: "only-original-audio" },
          { path: "only-original-photo" },
        ];
      h.storage.set(originalKey, originals);
      const oldRequestIndex = h.requests.length,
        oldAction = surface === "photos" ? h.page.applyPhotos() : h.page.save();
      h.page.onHide();
      const nextIdentity = structuredClone(login);
      if (replacement === "account") {
        nextIdentity.user.id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
        nextIdentity.session.id = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
        nextIdentity.session.token = "b".repeat(43);
        h.storage.set(`timenook.session.v1:${base}`, nextIdentity);
      }
      const nextProjectId =
        replacement === "project"
          ? "99999999-9999-4999-8999-999999999999"
          : projectId;
      const nextStory = { ...correctionStory(), projectId: nextProjectId };
      h.page.onLoad({ projectId: nextProjectId, storyId });
      const newRequestIndex = h.requests.length,
        showing = h.page.onShow();
      h.respond(
        newRequestIndex,
        surface === "settings"
          ? {
              ...overview(),
              projectId: nextProjectId,
              bookTitle: "后来页面的私人书名",
              stories: [nextStory],
              interviews: [],
            }
          : nextStory,
      );
      await showing;
      h.page.input({
        currentTarget: { dataset: { field: "title" } },
        detail: { value: "后来页面尚未保存的新书名" },
      });
      h.respond(oldRequestIndex, undefined, 403);
      await oldAction;
      assert.equal(h.page.data.title, "后来页面尚未保存的新书名");
      assert.equal(h.page.data.busy, false);
      assert.equal(typeof h.page.stopSessionWatch, "function");
      assert.equal(h.page.data.error, "");
      if (surface === "settings")
        assert.equal(h.page.data.overview.projectId, nextProjectId);
      else {
        assert.equal(h.page.data.story.projectId, nextProjectId);
        assert.ok(h.page.data.paragraphs.length);
        assert.equal(
          h.page.data.photoSnapshot.entries[0].caption,
          "私人照片说明",
        );
      }
      assert.deepEqual(
        h.storage.get(`timenook.session.v1:${base}`),
        nextIdentity,
      );
      assert.deepEqual(h.storage.get(originalKey), originals);
      assert.equal(h.removed.length, 0);
      assert.equal(h.routes.length, 0);
      h.page.onUnload();
    });
  }
}

test("project page distinguishes real optional-followup, transcription, story and book tasks without counting a task as a confirmed story", async () => {
  const h = harness("project");
  h.page.onLoad({ projectId });
  const showing = h.page.onShow();
  h.respond(0, participation);
  await tick();
  const actual = overview();
  actual.tasks = [
    {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      projectId,
      kind: "ask_followup",
      state: "failed",
      nextAction: "continue",
      retryable: false,
    },
    {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      projectId,
      kind: "transcribe_audio",
      state: "succeeded",
      nextAction: "continue",
      retryable: false,
    },
    {
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      projectId,
      kind: "compose_story",
      state: "queued",
      nextAction: "leave_and_return",
      retryable: false,
    },
    {
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      projectId,
      kind: "render_book",
      state: "queued",
      nextAction: "leave_and_return",
      retryable: false,
    },
  ];
  h.respond(1, actual);
  await showing;
  assert.equal(h.page.data.taskRows[0].kindLabel, "可选追问");
  assert.equal(h.page.data.taskRows[0].stateLabel, "失败");
  assert.equal(h.page.data.taskRows[1].kindLabel, "录音转写");
  assert.equal(h.page.data.taskRows[2].kindLabel, "故事整理");
  assert.equal(h.page.data.taskRows[3].kindLabel, "书稿生成");
  assert.equal(h.page.data.pending, 1);
  assert.equal(h.page.data.confirmed, 0);
  assert.equal(h.page.data.liveStories.length, 1);
  assert.match(h.page.data.taskRows[0].nextActionLabel, /继续/);
  assert.equal(h.page.data.interviews[0].resumeLabel, "那条小路上还有谁？");
  h.page.resume({ currentTarget: { dataset: { id: interviewId } } });
  assert.equal(
    h.routes[h.routes.length - 1],
    `/pages/interview/index?projectId=${projectId}&interviewId=${interviewId}`,
  );
  h.page.record();
  assert.match(
    h.routes[h.routes.length - 1],
    new RegExp(
      `/pages/interview/index\\?projectId=${projectId}&draftId=[a-f0-9-]{36}$`,
    ),
  );
  h.page.onUnload();
});

test("project page displays real overview and preserves project/interview when opening stories, recovering and using bottom navigation", async () => {
  const h = harness("project");
  h.page.onLoad({ projectId });
  const showing = h.page.onShow();
  h.respond(0, participation);
  await tick();
  assert.equal(h.requests[1].url, `${base}/projects/${projectId}/overview`);
  h.respond(1, overview());
  await showing;
  assert.equal(h.page.data.overview.bookTitle, "我的岁月");
  assert.equal(h.page.data.pending, 1);
  assert.equal(h.page.data.overview.nextStep, "请核对并确认一篇故事");
  h.page.story({ currentTarget: { dataset: { id: storyId } } });
  assert.equal(
    h.routes[h.routes.length - 1],
    `/pages/story/index?projectId=${projectId}&storyId=${storyId}`,
  );
  h.page.resume({ currentTarget: { dataset: { id: interviewId } } });
  assert.equal(
    h.routes[h.routes.length - 1],
    `/pages/interview/index?projectId=${projectId}&interviewId=${interviewId}`,
  );
  h.page.book();
  assert.equal(h.routes[h.routes.length - 1], `/pages/book/index`);
  h.page.onUnload();
});

test("a cached live project tab follows the session's changed project selection", async () => {
  const h = harness("project");
  h.page.onLoad({ projectId, assistedSessionId: "previous-assistance" });
  const first = h.page.onShow();
  h.respond(0, participation);
  await tick();
  h.respond(1, overview());
  await first;
  h.page.onHide();
  const otherId = "abababab-abab-4bab-8bab-abababababab";
  const selection = [...h.storage.keys()].find((key) =>
    key.startsWith("timenook.live-project.v1:"),
  );
  assert.ok(selection);
  h.storage.set(selection, otherId);
  const second = h.page.onShow();
  assert.equal(h.requests[2].url, `${base}/projects/${otherId}/participation`);
  assert.equal(h.page.assistedSessionId, "");
  h.respond(2, { ...participation, projectId: otherId });
  await tick();
  h.respond(3, { ...overview(), projectId: otherId });
  await second;
  assert.equal(h.page.data.overview.projectId, otherId);
  h.page.onUnload();
});

for (const policy of [
  {
    noticeVersion: "synthetic-d08-v1",
    evidencePrefix: "synthetic:",
    noticeText: "合成政策验证",
  },
  {
    noticeVersion: "internal-participation-v1",
    evidencePrefix: "internal:",
    noticeText: "内部验收，由本人选择",
  },
]) {
  test(`story confirms the exact version with the existing inclusion decision under ${policy.noticeVersion}`, async () => {
    const h = harness("story");
    h.page.onLoad({ projectId, storyId });
    const showing = h.page.onShow();
    await tick();
    assert.equal(
      h.requests[0]?.url,
      `${base}/projects/${projectId}/stories/${storyId}`,
    );
    h.respond(0, story());
    await showing;
    assert.equal(
      h.page.data.liveParagraphs[0].text,
      story().revision.paragraphs[0].text,
    );
    const preparing = h.page.prepareDecision();
    h.respond(1, { ...overview(), ...policy });
    await preparing;
    const deciding = h.page.decideLive();
    assert.equal(
      h.requests[2].url,
      `${base}/projects/${projectId}/stories/${storyId}/decisions`,
    );
    const sent = h.requests[2].data;
    assert.equal(sent.revisionId, revisionId);
    assert.equal(sent.contentHash, "f".repeat(64));
    assert.equal(sent.expectedVersion, 1);
    assert.equal(sent.confirmed, true);
    assert.equal(sent.allowInBook, false);
    assert.equal(sent.noticeVersion, policy.noticeVersion);
    assert.ok(sent.evidenceRef.startsWith(policy.evidencePrefix));
    assert.equal(h.page.data.noticeText, policy.noticeText);
    h.respond(2, {
      ...story(),
      decision: { revisionId, confirmed: true, allowInBook: false },
    });
    await deciding;
    assert.equal(h.page.data.story.decision.allowInBook, false);
    assert.match(h.page.data.decisionStatus, /暂不入书/);
    h.page.onUnload();
  });
}

test("correction page preserves paragraph sources, records reasons and notes, and appends a revision through HTTP", async () => {
  const h = harness("edit-story");
  h.page.onLoad({ projectId, storyId });
  const showing = h.page.onShow();
  assert.equal(
    h.requests[0]?.url,
    `${base}/projects/${projectId}/stories/${storyId}`,
  );
  const current = story();
  current.revision.reviewItems = ["请核对小路的名称"];
  h.respond(0, current);
  await showing;
  h.page.paragraphText({
    currentTarget: { dataset: { index: "0" } },
    detail: { value: "那条小路叫青石巷。" },
  });
  h.page.reviewReason({
    currentTarget: { dataset: { index: "0" } },
    detail: { value: "本人确认名称为青石巷" },
  });
  h.page.input({
    currentTarget: { dataset: { field: "noteText" } },
    detail: { value: "名称由本人补充说明" },
  });
  h.page.addNote({ currentTarget: { dataset: { index: "0" } } });
  const saving = h.page.save();
  assert.equal(
    h.requests[1].url,
    `${base}/projects/${projectId}/stories/${storyId}/revisions`,
  );
  const sent = h.requests[1].data;
  assert.equal(sent.baseRevisionId, revisionId);
  assert.equal(sent.expectedVersion, 1);
  assert.equal(sent.paragraphs[0].text, "那条小路叫青石巷。");
  assert.ok(
    sent.paragraphs[0].sourceRefs.includes(
      "note:77777777-7777-4777-8777-777777777777",
    ),
  );
  assert.ok(sent.paragraphs[0].sourceRefs.includes(`note:${sent.notes[1].id}`));
  assert.equal(sent.reviewResolutions[0].item, "请核对小路的名称");
  assert.equal(sent.reviewResolutions[0].reason, "本人确认名称为青石巷");
  h.respond(1, { ...current, version: 2, decision: null });
  await saving;
  assert.equal(h.routes[h.routes.length - 1], "back");
  h.page.onUnload();
});

test("renamed live project title is fresh in account while book waits for a generated snapshot without demo content", async () => {
  const settings = harness("settings");
  settings.page.onLoad({ projectId });
  const showing = settings.page.onShow();
  assert.equal(
    settings.requests[0]?.url,
    `${base}/projects/${projectId}/overview`,
  );
  settings.respond(0, overview());
  await showing;
  settings.page.input({
    currentTarget: { dataset: { field: "title" } },
    detail: { value: "小路与岁月" },
  });
  const saving = settings.page.save();
  assert.equal(
    settings.requests[1].url,
    `${base}/projects/${projectId}/metadata`,
  );
  assert.equal(settings.requests[1].data.expectedVersion, 1);
  assert.equal(settings.requests[1].data.bookTitle, "小路与岁月");
  const renamed = {
    ...overview(),
    bookTitle: "小路与岁月",
    metadataVersion: 2,
  };
  settings.respond(1, renamed);
  await saving;
  settings.page.onUnload();
  const book = harness("book");
  book.page.onLoad({ projectId });
  const bookShowing = book.page.onShow();
  assert.equal(book.requests[0].url, `${base}/projects/${projectId}/book`);
  book.respond(0, {
    projectId,
    inputHash: "a".repeat(64),
    cover: { version: 0, salutation: "", photoAssetId: null },
    coverPhotoOptions: [],
    directory: { version: 1, contentHash: "b".repeat(64), chapters: [] },
    eligibleStories: [],
    current: null,
    accessExpiresAt: null,
    draftAccess: { allowed: true, expiresAt: null },
  });
  await bookShowing;
  assert.equal(book.page.data.version, null);
  assert.match(book.page.data.stateLabel, /生成书稿/);
  book.page.account();
  assert.equal(book.routes[book.routes.length - 1], `/pages/account/index`);
  book.page.onUnload();
  const account = harness("account");
  account.page.onLoad({ projectId });
  const accountShowing = account.page.onShow();
  account.respond(0, { projects: [{ projectId, state: "active" }] });
  await tick();
  account.respond(1, renamed);
  await accountShowing;
  assert.equal(account.page.data.overview.bookTitle, "小路与岁月");
  account.page.project();
  assert.equal(
    account.routes[account.routes.length - 1],
    `/pages/project/index`,
  );
  account.page.onUnload();
});

test("denied story sharing keeps the authorized collection path available without rendering a forged overview", async () => {
  const h = harness("project");
  h.page.onLoad({ projectId });
  const showing = h.page.onShow();
  h.respond(0, { ...participation, role: "initiator" });
  await tick();
  h.respond(1, undefined, 403);
  await showing;
  assert.equal(h.page.data.overview, null);
  assert.equal(h.page.data.liveStories.length, 0);
  assert.equal(h.page.data.participation.canCollect, true);
  assert.match(h.page.data.status, /共享|授权/);
  h.page.record();
  assert.match(
    h.routes[h.routes.length - 1],
    new RegExp(
      `/pages/interview/index\\?projectId=${projectId}&draftId=[a-f0-9-]{36}$`,
    ),
  );
  h.page.assisted();
  assert.equal(
    h.routes[h.routes.length - 1],
    `/pages/assisted/index?projectId=${projectId}`,
  );
  h.page.onUnload();
});

test("assisted story confirmation requires a fresh explicit purpose choice and returns only its exact session to the story", async () => {
  const h = harness("assisted");
  h.page.onLoad({
    projectId,
    storyId,
    interviewId,
    purpose: "story_confirmation",
  });
  const showing = h.page.onShow();
  h.respond(0, {
    ...participation,
    role: "initiator",
    noticeVersion: "synthetic-d08-v1",
    policyStatus: "synthetic-only",
  });
  await tick();
  h.respond(1, { sessions: [] });
  await tick();
  h.respond(2, { requests: [] });
  await showing;
  assert.equal(
    h.requests.length,
    3,
    "entering cannot create a story-confirmation session",
  );
  h.page.storyEvidence({
    detail: { value: "本人在场，选择由发起人协助核对这篇故事" },
  });
  const creating = h.page.startStoryConfirmation({
    currentTarget: { dataset: { granted: "true" } },
  });
  assert.equal(h.requests[3].data.purpose, "story_confirmation");
  assert.match(h.requests[3].data.evidenceRef, /本人在场/);
  const sessionId = "99999999-9999-4999-8999-999999999999";
  h.respond(3, {
    id: sessionId,
    purpose: "story_confirmation",
    state: "active",
  });
  await creating;
  assert.equal(
    h.routes[h.routes.length - 1],
    `/pages/story/index?projectId=${projectId}&storyId=${storyId}&interviewId=${interviewId}&assistedSessionId=${sessionId}`,
  );
  h.page.onUnload();
});

async function pendingStoryDownloadOnAssisted() {
  const h = harness("story-assisted"),
    [sourcePage, assistedPage] = h.pages,
    source = {
      clipId: "77777777-7777-4777-8777-777777777777",
      intentId: "88888888-8888-4888-8888-888888888888",
      interviewId,
      actualQuestionId: "99999999-9999-4999-8999-999999999999",
      assetId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      sealedInputId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      inputHash: "a".repeat(64),
    };
  h.storage.set("synthetic-pending-original", [{ path: "only-original" }]);
  sourcePage.onLoad({ projectId, storyId });
  const showing = sourcePage.onShow();
  await tick();
  h.respond(0, {
    ...story(),
    task: {
      id: revisionId,
      kind: "compose_story",
      state: "succeeded",
      sources: [source],
    },
  });
  await showing;
  const playing = sourcePage.playLive({
    currentTarget: { dataset: { id: source.clipId } },
  });
  await tick();
  h.respond(1, {
    id: source.intentId,
    projectId,
    interviewId,
    actualQuestionId: source.actualQuestionId,
    state: "sealed",
    asset: { id: source.assetId, sha256: source.inputHash, bytes: 123 },
    sealedInput: { id: source.sealedInputId },
  });
  await tick();
  assert.equal(h.downloads.length, 1);
  assert.equal(sourcePage.data.audioBusy, true);
  sourcePage.participation();
  assert.match(
    h.routes[h.routes.length - 1],
    /assisted\/index.*purpose=story_confirmation/,
  );
  sourcePage.onHide();
  assistedPage.onLoad({
    projectId,
    storyId,
    interviewId,
    purpose: "story_confirmation",
  });
  const assisting = assistedPage.onShow();
  h.respond(2, {
    ...participation,
    role: "initiator",
    policyStatus: "synthetic-only",
    noticeVersion: "synthetic-d08-v1",
  });
  await tick();
  h.respond(3, {
    sessions: [
      {
        id: revisionId,
        projectId,
        subjectId: storyId,
        operatorUserId: login.user.id,
        purpose: "story_confirmation",
        state: "active",
        expiresAt: login.session.expiresAt,
        evidenceRef: "synthetic:私人会话证据",
      },
    ],
  });
  await tick();
  h.respond(4, {
    requests: [
      {
        id: revisionId,
        kind: "correction",
        state: "open",
        createdAt: "2026-10-24T00:00:00Z",
        evidenceRef: "synthetic:私人工单说明",
      },
    ],
  });
  await assisting;
  assistedPage.storyEvidence({ detail: { value: "本人此次待确认的私人说明" } });
  assert.equal(assistedPage.data.sessions.length, 1);
  assert.equal(assistedPage.data.careRequests.length, 1);
  return { h, sourcePage, assistedPage, playing };
}

test("a Story download's late current-session 401 clears the active Assisted page and preserves the local original", async () => {
  const { h, assistedPage, playing } = await pendingStoryDownloadOnAssisted();
  h.downloads[0].success({
    statusCode: 401,
    tempFilePath: "denied-audio-temp",
  });
  await playing;
  await tick();
  assert.equal(h.storage.has(`timenook.session.v1:${base}`), false);
  assert.equal(assistedPage.data.storyEvidence, "");
  assert.equal(assistedPage.data.participation, null);
  assert.equal(assistedPage.data.sessions.length, 0);
  assert.equal(assistedPage.data.careRequests.length, 0);
  assert.equal(assistedPage.data.busy, false);
  assert.equal(assistedPage.data.loggedIn, false);
  assert.match(assistedPage.data.status, /登录已失效/);
  assert.ok(h.removed.includes("denied-audio-temp"));
  assert.ok(!h.removed.includes("only-original"));
  assert.ok(h.storage.has("synthetic-pending-original"));
  assistedPage.onUnload();
});

test("an old Story download 401 cannot clear a later account's active Assisted page", async () => {
  const { h, assistedPage, playing } = await pendingStoryDownloadOnAssisted();
  const other = structuredClone(login);
  other.user.id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  other.session.id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  other.session.token = "b".repeat(43);
  const signingIn = assistedPage.login();
  await tick();
  assert.equal(h.requests[5].url, `${base}/sessions/wechat`);
  h.respond(5, other, 201);
  await tick();
  h.respond(6, {
    ...participation,
    role: "initiator",
    policyStatus: "synthetic-only",
    noticeVersion: "synthetic-d08-v1",
  });
  await tick();
  h.respond(7, {
    sessions: [
      {
        id: storyId,
        projectId,
        subjectId: revisionId,
        operatorUserId: other.user.id,
        purpose: "story_confirmation",
        state: "active",
        expiresAt: other.session.expiresAt,
      },
    ],
  });
  await tick();
  h.respond(8, { requests: [] });
  await signingIn;
  assistedPage.storyEvidence({ detail: { value: "新账号本人这次的私人说明" } });
  h.downloads[0].success({
    statusCode: 401,
    tempFilePath: "old-denied-audio-temp",
  });
  await playing;
  await tick();
  assert.deepEqual(h.storage.get(`timenook.session.v1:${base}`), other);
  assert.equal(assistedPage.data.loggedIn, true);
  assert.equal(assistedPage.data.storyEvidence, "新账号本人这次的私人说明");
  assert.equal(assistedPage.data.sessions[0].operatorUserId, other.user.id);
  assert.ok(assistedPage.data.participation);
  assert.ok(h.removed.includes("old-denied-audio-temp"));
  assert.ok(!h.removed.includes("only-original"));
  assert.ok(h.storage.has("synthetic-pending-original"));
  assistedPage.onUnload();
});

test("a decision response after account replacement purges the previous private story and cannot report success", async () => {
  const h = harness("story");
  h.page.onLoad({ projectId, storyId });
  const showing = h.page.onShow();
  await tick();
  h.respond(0, story());
  await showing;
  const preparing = h.page.prepareDecision();
  h.respond(1, overview());
  await preparing;
  const saving = h.page.decideLive();
  h.storage.set(`timenook.session.v1:${base}`, {
    ...login,
    user: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    session: {
      ...login.session,
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      token: "b".repeat(43),
    },
  });
  h.respond(2, {
    ...story(),
    decision: { confirmed: true, allowInBook: false },
  });
  await saving;
  assert.equal(h.page.data.story, null);
  assert.equal(h.page.data.liveParagraphs.length, 0);
  assert.equal(h.page.data.busy, false);
  assert.match(h.page.data.stage, /账号|访问/);
  h.page.onUnload();
});

test("project recording recovery retains the explicitly supplied collection session and same interview", async () => {
  const h = harness("project"),
    sessionId = "99999999-9999-4999-8999-999999999999";
  h.page.onLoad({ projectId, assistedSessionId: sessionId });
  const showing = h.page.onShow();
  h.respond(0, participation);
  await tick();
  h.respond(1, overview());
  await showing;
  h.page.resume({ currentTarget: { dataset: { id: interviewId } } });
  assert.equal(
    h.routes[h.routes.length - 1],
    `/pages/interview/index?projectId=${projectId}&interviewId=${interviewId}&assistedSessionId=${sessionId}`,
  );
  h.page.onUnload();
});

test("narrator explicitly chooses correction access expiry and applies for the actual version without inventing approval", async () => {
  const h = harness("story");
  h.page.onLoad({ projectId, storyId });
  const showing = h.page.onShow();
  await tick();
  h.respond(0, story());
  await showing;
  const preparing = h.page.prepareDecision();
  h.respond(1, overview());
  await preparing;
  await h.page.requestCorrection();
  assert.equal(
    h.requests.length,
    2,
    "no request without explicit expiry and evidence",
  );
  h.page.correctionInput({
    currentTarget: { dataset: { field: "careExpiry" } },
    detail: { value: "2098-05-01T10:00:00.000Z" },
  });
  h.page.correctionInput({
    currentTarget: { dataset: { field: "careEvidence" } },
    detail: { value: "本人申请协助核对这版，期限如上" },
  });
  const applying = h.page.requestCorrection();
  const sent = h.requests[2];
  assert.equal(
    sent.url,
    `${base}/projects/${projectId}/stories/${storyId}/care-access`,
  );
  assert.equal(sent.data.revisionId, revisionId);
  assert.equal(sent.data.contentHash, "f".repeat(64));
  assert.equal(sent.data.expectedVersion, 1);
  assert.equal(sent.data.expiresAt, "2098-05-01T10:00:00.000Z");
  h.respond(2, {
    caseId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    storyId,
    expiresAt: sent.data.expiresAt,
  });
  await applying;
  assert.match(h.page.data.careStatus, /已记录/);
  assert.match(h.page.data.careStatus, /aaaaaaaa/);
  assert.equal(h.page.data.story.decision, null);
  h.page.onUnload();
});

test("switching accounts while a project overview is in flight removes the previous membership list", async () => {
  const h = harness("account");
  h.page.onLoad({ projectId });
  const showing = h.page.onShow();
  h.respond(0, { projects: [{ projectId, state: "active" }] });
  await tick();
  h.storage.set(`timenook.session.v1:${base}`, {
    ...login,
    user: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    session: {
      ...login.session,
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      token: "b".repeat(43),
    },
  });
  h.respond(1, overview());
  await showing;
  assert.equal(h.page.data.memberships.length, 0);
  assert.equal(h.page.data.overview, null);
  assert.equal(h.page.data.busy, false);
  h.page.onUnload();
});

test("correction explicitly applies the latest photo snapshot and selected audio order, while an unknown save result retains the draft and command key", async () => {
  const h = harness("edit-story");
  h.page.onLoad({ projectId, storyId });
  const showing = h.page.onShow();
  const current: any = story(),
    first = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    second = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  current.revision.sourceManifest = [{ clipId: first }, { clipId: second }];
  current.revision.audioManifest = [{ clipId: second }];
  h.respond(0, current);
  await showing;
  assert.equal(h.page.data.audioClips[0].clipId, second);
  assert.equal(h.page.data.audioClips[1].included, false);
  h.page.moveAudio({
    currentTarget: { dataset: { index: "0", direction: "1" } },
  });
  h.page.toggleAudio({ currentTarget: { dataset: { index: "0" } } });
  const applying = h.page.applyPhotos();
  assert.equal(
    h.requests[1].url,
    `${base}/projects/${projectId}/interviews/${interviewId}/photos`,
  );
  const snapshot = {
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    projectId,
    interviewId,
    revision: 2,
    hash: "c".repeat(64),
    entries: [
      {
        photoId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        caption: "青石巷的老门",
        assets: [],
      },
    ],
  };
  h.respond(1, {
    photos: [],
    snapshot,
    usage: { reservedCount: 0, consumedCount: 1 },
  });
  await applying;
  assert.equal(h.page.data.photoSnapshot.entries[0].caption, "青石巷的老门");
  const saving = h.page.save();
  assert.equal(h.requests[2].data.photoSnapshotId, snapshot.id);
  assert.deepEqual(Array.from(h.requests[2].data.audioClipIds), [
    first,
    second,
  ]);
  h.requests[2].fail({ errMsg: "network interrupted" });
  await saving;
  assert.equal(h.page.data.story.version, 1);
  assert.equal(h.page.data.photoSnapshot.id, snapshot.id);
  assert.equal(h.routes.length, 0);
  const retrying = h.page.save();
  assert.equal(
    h.requests[3].header["Idempotency-Key"],
    h.requests[2].header["Idempotency-Key"],
  );
  h.respond(3, { ...current, version: 2, decision: null });
  await retrying;
  h.page.onUnload();
});

test("refreshing to a new revision requires an actual new click pinned to its current content", async () => {
  const h = harness("story");
  h.page.onLoad({ projectId, storyId });
  const showing = h.page.onShow();
  await tick();
  h.respond(0, story());
  await showing;
  const preparing = h.page.prepareDecision();
  h.respond(1, overview());
  await preparing;
  const refreshing = h.page.refreshLive(),
    revised = story();
  revised.version = 2;
  revised.currentRevisionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  revised.revision.id = revised.currentRevisionId;
  revised.revision.contentHash = "a".repeat(64);
  h.respond(2, revised);
  await refreshing;
  assert.equal(h.page.data.decisionReady, true);
  assert.equal(h.requests.length, 3, "refresh cannot confirm the new version");
  const saving = h.page.decideLive();
  assert.equal(h.requests[3].data.revisionId, revised.revision.id);
  assert.equal(h.requests[3].data.contentHash, "a".repeat(64));
  assert.equal(h.requests[3].data.expectedVersion, 2);
  h.respond(3, revised);
  await saving;
  h.page.onUnload();
});

test("opening an existing story with story-confirmation assistance never submits that session to collection context", async () => {
  const h = harness("story"),
    confirmationSessionId = "99999999-9999-4999-8999-999999999999";
  h.page.onLoad({
    projectId,
    storyId,
    assistedSessionId: confirmationSessionId,
  });
  const showing = h.page.onShow();
  await tick();
  h.respond(0, story());
  await tick();
  assert.equal(
    h.requests.length,
    1,
    "reading an existing story must not call collection context",
  );
  await showing;
  const preparing = h.page.prepareDecision();
  h.respond(1, { ...overview(), canDecide: false, role: "initiator" });
  await preparing;
  const saving = h.page.decideLive();
  assert.equal(h.requests[2].data.assistedSessionId, confirmationSessionId);
  h.respond(2, story());
  await saving;
  h.page.recoverInterview();
  assert.equal(
    h.routes[h.routes.length - 1],
    `/pages/interview/index?projectId=${projectId}&interviewId=${interviewId}`,
  );
  h.page.onUnload();
});

for (const outcome of ["success", "network"] as const) {
  test(`a narrator decision ${outcome} at exact captured session expiry clears private confirmation content and preserves local audio`, async () => {
    const h = harness("story");
    const originalKey = `timenook.recording.v1:${base}:synthetic-app:${login.user.id}:${projectId}:${interviewId}`;
    const original = [{ path: "only-local-original", durationMs: 1080 }];
    h.storage.set(originalKey, original);
    h.page.onLoad({ projectId, storyId });
    const showing = h.page.onShow();
    await tick();
    h.respond(0, story());
    await showing;
    const preparing = h.page.prepareDecision();
    h.respond(1, overview());
    await preparing;
    const deciding = h.page.decideLive();
    h.expireSession();
    if (outcome === "success")
      h.respond(2, {
        ...story(),
        decision: { confirmed: true, allowInBook: false },
      });
    else h.requests[2].fail({ errMsg: "controlled timeout" });
    await deciding;
    assert.equal(h.page.data.story, null);
    assert.equal(h.page.data.liveParagraphs.length, 0);
    assert.equal(h.page.data.canDecide, false);
    assert.equal(h.page.data.busy, false);
    assert.equal(h.page.data.decisionStatus, "");
    assert.match(h.page.data.stage, /失效/);
    assert.equal(h.storage.has(`timenook.session.v1:${base}`), false);
    assert.deepEqual(h.storage.get(originalKey), original);
    assert.equal(h.removed.includes("only-local-original"), false);
    h.page.onUnload();
  });
}

test("an assisted story-session network result at exact captured expiry clears its private evidence without starting or deleting audio", async () => {
  const h = harness("assisted");
  const originalKey = "synthetic-device-original";
  h.storage.set(originalKey, "only-local-original");
  h.page.onLoad({
    projectId,
    storyId,
    interviewId,
    purpose: "story_confirmation",
  });
  const showing = h.page.onShow();
  h.respond(0, {
    ...participation,
    role: "initiator",
    noticeVersion: "synthetic-d08-v1",
    policyStatus: "synthetic-only",
  });
  await tick();
  h.respond(1, { sessions: [] });
  await tick();
  h.respond(2, { requests: [] });
  await showing;
  h.page.storyEvidence({ detail: { value: "本人当次在场选择故事确认协助" } });
  const creating = h.page.startStoryConfirmation({
    currentTarget: { dataset: { granted: "true" } },
  });
  h.expireSession();
  h.requests[3].fail({ errMsg: "controlled timeout" });
  await creating;
  assert.equal(h.page.data.participation, null);
  assert.equal(h.page.data.sessions.length, 0);
  assert.equal(h.page.data.careRequests.length, 0);
  assert.equal(h.page.data.storyEvidence, "");
  assert.equal(h.page.data.busy, false);
  assert.equal(h.routes.length, 0);
  assert.match(h.page.data.status, /失效/);
  assert.equal(h.storage.get(originalKey), "only-local-original");
  h.page.onUnload();
});
