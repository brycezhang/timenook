import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";
const base = "https://example.test/timenook/v1",
  projectId = "33333333-3333-4333-8333-333333333333",
  interviewId = "44444444-4444-4444-8444-444444444444",
  storyId = "55555555-5555-4555-8555-555555555555",
  taskId = "66666666-6666-4666-8666-666666666666";
const login = {
  user: { id: "11111111-1111-4111-8111-111111111111" },
  session: {
    id: "22222222-2222-4222-8222-222222222222",
    token: "a".repeat(43),
    expiresAt: "2099-01-01T00:00:00Z",
  },
};
const compiled = await build({
  entryPoints: ["miniprogram/pages/story/index.ts"],
  bundle: true,
  write: false,
  format: "cjs",
  platform: "neutral",
  define: { __TIMENOOK_API_BASE_URL__: JSON.stringify(base) },
});
function harness(
  options: {
    storage?: Map<string, any>;
    missingFiles?: string[];
    unlinkFailure?: number;
  } = {},
) {
  let now = Date.now();
  class DeviceDate extends Date {
    static now() {
      return now;
    }
  }
  const storage = new Map<string, any>(
      options.storage ?? [
        ["timenook.mode.v1", "live"],
        [`timenook.session.v1:${base}`, structuredClone(login)],
      ],
    ),
    requests: any[] = [],
    navigation: any[] = [],
    downloads: any[] = [],
    removed: string[] = [],
    players: any[] = [];
  let info = { size: 123, digest: "a".repeat(64) },
    failAudioCleanup = false;
  let page: any;
  runInNewContext(compiled.outputFiles[0].text, {
    Date: DeviceDate,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Page: (value: any) => {
      page = value;
      page.setData = (patch: object) => Object.assign(page.data, patch);
    },
    wx: {
      getStorageSync: (key: string) => {
        assert.notEqual(
          key,
          "timenook.projects.v1",
          "live story cannot consume demo state",
        );
        return structuredClone(storage.get(key));
      },
      setStorageSync: (key: string, value: any) => {
        if (
          failAudioCleanup &&
          key.includes("story-audio") &&
          Array.isArray(value) &&
          !value.length
        ) {
          failAudioCleanup = false;
          throw Error("device cleanup bookkeeping full");
        }
        storage.set(key, structuredClone(value));
      },
      removeStorageSync: (key: string) => storage.delete(key),
      request: (o: any) => requests.push(o),
      downloadFile: (o: any) => downloads.push(o),
      getFileSystemManager: () => ({
        getFileInfo: (o: any) => o.success(info),
        unlink: (o: any) => {
          if (options.unlinkFailure) {
            o.fail({
              errCode: options.unlinkFailure,
              errMsg: "permission denied",
            });
            return;
          }
          if (
            removed.includes(o.filePath) ||
            options.missingFiles?.includes(o.filePath)
          ) {
            o.fail({ errCode: 1300002, errMsg: "no such file or directory" });
            return;
          }
          removed.push(o.filePath);
          o.success({});
        },
      }),
      createInnerAudioContext: () => {
        const player = {
          src: "",
          plays: 0,
          destroyed: false,
          stops: 0,
          destroys: 0,
          play() {
            this.plays++;
          },
          pause() {},
          stop() {
            this.stops++;
          },
          destroy() {
            this.destroys++;
            this.destroyed = true;
          },
          onEnded() {},
          onError() {},
        };
        players.push(player);
        return player;
      },
      getAccountInfoSync: () => ({ miniProgram: { appId: "synthetic-app" } }),
      navigateTo: (o: any) => navigation.push(o),
      reLaunch: (o: any) => navigation.push(o),
      showToast: () => {},
    },
  });
  const respond = (index: number, data: any, status = 200) =>
    requests[index].success({
      statusCode: status,
      data:
        status >= 400
          ? {
              error: { code: status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN" },
              meta: { requestId: "synthetic" },
            }
          : { data, meta: { requestId: "synthetic" } },
    });
  return {
    page,
    storage,
    requests,
    respond,
    navigation,
    downloads,
    removed,
    players,
    failAudioCleanup() {
      failAudioCleanup = true;
    },
    expireSession() {
      now = Date.parse(login.session.expiresAt);
    },
    fileInfo(value: typeof info) {
      info = value;
    },
  };
}
const turn = () => new Promise<void>((r) => setImmediate(r));
function story(state = "waiting_inputs", version = 0) {
  return {
    id: storyId,
    projectId,
    interviewId,
    version,
    currentRevisionId: null,
    usage: { organizations: 1, regenerations: 0 },
    revision: null,
    task: {
      id: taskId,
      kind: "compose_story",
      state,
      sources: [],
      attempts: [],
      errorCode: null,
    },
  };
}
test("the live story Page restores its real HTTP task and shows the complete sourced text and review items", async () => {
  const h = harness();
  h.page.onLoad({ projectId, interviewId });
  const showing = h.page.onShow();
  await turn();
  assert.equal(
    h.requests[0].url,
    `${base}/projects/${projectId}/stories/context`,
  );
  h.respond(0, {
    interviewId,
    clipCount: 2,
    pendingCount: 0,
    cloudSaved: true,
    story: story(),
  });
  await turn();
  assert.equal(
    h.requests[1].url,
    `${base}/projects/${projectId}/stories/${storyId}`,
  );
  h.respond(1, {
    ...story("succeeded", 1),
    revision: {
      id: "revision1",
      title: "我记得的那一年",
      theme: "旧时光",
      origin: "ai",
      paragraphs: [
        { text: "第一段完整正文", sourceRefs: ["transcript:one"] },
        { text: "后半段也完整展示", sourceRefs: ["transcript:two"] },
      ],
      reviewItems: ["年份待本人核对"],
      sourceManifest: [],
    },
  });
  await showing;
  assert.equal(h.page.data.story.revision.paragraphs.length, 2);
  assert.equal(h.page.data.story.revision.reviewItems[0], "年份待本人核对");
  assert.equal(h.page.data.stage, "故事已整理，待本人核对");
  assert.equal(h.page.data.busy, false);
  h.page.onHide();
});
async function loaded(h: ReturnType<typeof harness>, title = "私人正文") {
  h.page.onLoad({ projectId, interviewId });
  const showing = h.page.onShow();
  await turn();
  const first = h.requests.length - 1;
  h.respond(first, {
    interviewId,
    clipCount: 2,
    pendingCount: 0,
    cloudSaved: true,
    story: story("succeeded", 1),
  });
  await turn();
  h.respond(first + 1, {
    ...story("succeeded", 1),
    revision: {
      id: "revision1",
      title,
      theme: "主题",
      origin: "ai",
      paragraphs: [{ text: "私人正文", sourceRefs: ["transcript:one"] }],
      reviewItems: [],
      sourceManifest: [],
    },
  });
  await showing;
}
test("the current story request 401 clears private content and busy after Session has already removed its token", async () => {
  const h = harness();
  await loaded(h);
  h.page.refresh();
  await turn();
  h.respond(2, null, 401);
  await turn();
  assert.equal(h.storage.has(`timenook.session.v1:${base}`), false);
  assert.equal(h.page.data.story, null);
  assert.equal(h.page.data.liveParagraphs.length, 0);
  assert.equal(h.page.data.busy, false);
  h.page.onHide();
});
test("a late old-session 401 cannot clear a newer session's rendered story", async () => {
  const h = harness();
  await loaded(h);
  h.page.refresh();
  await turn();
  h.page.onHide();
  const newer = {
    ...login,
    session: {
      ...login.session,
      id: "77777777-7777-4777-8777-777777777777",
      token: "b".repeat(43),
    },
  };
  h.storage.set(`timenook.session.v1:${base}`, newer);
  const showing = h.page.onShow();
  await turn();
  h.respond(3, {
    interviewId,
    clipCount: 2,
    pendingCount: 0,
    cloudSaved: true,
    story: story("succeeded", 1),
  });
  await turn();
  h.respond(4, {
    ...story("succeeded", 1),
    revision: {
      id: "new",
      title: "新会话正文",
      theme: "主题",
      origin: "ai",
      paragraphs: [],
      reviewItems: [],
      sourceManifest: [],
    },
  });
  await showing;
  h.respond(2, null, 401);
  await turn();
  assert.equal(h.page.data.story.revision.title, "新会话正文");
  assert.equal(h.page.data.busy, false);
  assert.equal(
    h.storage.get(`timenook.session.v1:${base}`).session.token,
    newer.session.token,
  );
  h.page.onHide();
});
test("a local unsaved supplement stays visibly incomplete beside the earlier successful story and cannot submit", async () => {
  const h = harness();
  h.storage.set(
    `timenook.recording.v1:${base}:synthetic-app:${login.user.id}:${projectId}:${interviewId}`,
    [{ clientClipId: "local-tail", sealed: false }],
  );
  await loaded(h);
  assert.equal(h.page.data.pendingLocal, true);
  assert.equal(h.page.data.canOrganize, false);
  assert.equal(h.page.data.saveWarning, "还有录音没有云端保存，请回采访页恢复");
  h.page.onHide();
});
test("an uncertain submit response keeps its original command key and returning restores the same task", async () => {
  const h = harness();
  h.page.onLoad({ projectId, interviewId });
  const showing = h.page.onShow();
  await turn();
  h.respond(0, {
    interviewId,
    clipCount: 2,
    pendingCount: 0,
    cloudSaved: true,
    story: null,
  });
  await showing;
  const first = h.page.submitLive();
  await turn();
  const key = h.requests[1].header["Idempotency-Key"];
  h.requests[1].fail({});
  await first;
  assert.equal(h.page.data.busy, false);
  const retry = h.page.submitLive();
  await turn();
  assert.equal(h.requests[2].header["Idempotency-Key"], key);
  h.respond(2, story());
  await turn();
  h.respond(3, {
    interviewId,
    clipCount: 2,
    pendingCount: 0,
    cloudSaved: true,
    story: story(),
  });
  await turn();
  h.respond(4, story());
  await retry;
  assert.equal(h.page.data.story.task.id, taskId);
  h.page.onHide();
  const returning = h.page.onShow();
  await turn();
  h.respond(5, {
    interviewId,
    clipCount: 2,
    pendingCount: 0,
    cloudSaved: true,
    story: story(),
  });
  await turn();
  h.respond(6, story());
  await returning;
  assert.equal(h.page.data.story.task.id, taskId);
  assert.equal(h.requests.filter((r) => r.url.endsWith("/organize")).length, 2);
  h.page.onHide();
});

const source = {
  clipId: "77777777-7777-4777-8777-777777777777",
  intentId: "88888888-8888-4888-8888-888888888888",
  interviewId,
  actualQuestionId: "99999999-9999-4999-8999-999999999999",
  sequence: 1,
  assetId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  sealedInputId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  inputHash: "a".repeat(64),
  transcriptionTaskId: taskId,
  state: "succeeded",
  transcript: null,
};
const recording = {
  id: source.intentId,
  projectId,
  interviewId,
  actualQuestionId: source.actualQuestionId,
  state: "sealed",
  asset: { id: source.assetId, bytes: 123, sha256: source.inputHash },
  sealedInput: { id: source.sealedInputId },
};
async function showAudioStory(
  h: ReturnType<typeof harness>,
  start = 0,
  text = "原账号私人正文",
  state = "succeeded",
) {
  h.page.onLoad({ projectId, interviewId });
  const showing = h.page.onShow();
  await turn();
  const current = {
    ...story(state, 1),
    task: { ...story(state, 1).task, sources: [source] },
    revision: {
      id: storyId,
      title: "真实故事",
      paragraphs: [{ text, sourceRefs: [] }],
      sourceManifest: [source],
      reviewItems: ["私人核对项"],
      origin: "ai",
      version: 1,
    },
  };
  h.respond(start, {
    interviewId,
    clipCount: 1,
    pendingCount: 0,
    cloudSaved: true,
    story: current,
  });
  await turn();
  h.respond(start + 1, current);
  if (state === "failed") {
    await turn();
    h.respond(start + 2, {
      id: taskId,
      projectId,
      kind: "compose_story",
      state: "failed",
      retryable: true,
    });
  }
  await showing;
}
const audioEvent = { currentTarget: { dataset: { id: source.clipId } } };
test("saved source playback uses its recording intent, validates downloaded hash and only removes temporary audio", async () => {
  const h = harness();
  await showAudioStory(h);
  h.storage.set("synthetic-pending-original", [
    { path: "only-original", sealed: false },
  ]);
  const playing = h.page.playLive(audioEvent);
  await turn();
  assert.ok(h.requests[2].url.endsWith(`/clips/${source.intentId}`));
  h.respond(2, recording);
  await turn();
  assert.ok(h.downloads[0].url.endsWith(`/clips/${source.intentId}/content`));
  assert.equal(
    h.downloads[0].header.authorization,
    `Bearer ${login.session.token}`,
  );
  h.downloads[0].success({ statusCode: 200, tempFilePath: "private-audio" });
  await playing;
  assert.equal(h.players[0].src, "private-audio");
  assert.equal(h.players[0].plays, 1);
  h.page.onHide();
  await turn();
  assert.equal(h.players[0].destroyed, true);
  assert.ok(h.removed.includes("private-audio"));
  assert.ok(!h.removed.includes("only-original"));
  assert.ok(h.storage.has("synthetic-pending-original"));
});
test("a downloaded source with the wrong hash is removed without playing and remains recoverable", async () => {
  const h = harness();
  await showAudioStory(h);
  h.fileInfo({ size: 123, digest: "b".repeat(64) });
  const playing = h.page.playLive(audioEvent);
  await turn();
  h.respond(2, recording);
  await turn();
  h.downloads[0].success({ statusCode: 200, tempFilePath: "wrong-audio" });
  await playing;
  assert.equal(h.players.length, 0);
  assert.ok(h.removed.includes("wrong-audio"));
  assert.match(h.page.data.audioError, /校验/);
  assert.equal(h.page.data.audioBusy, false);
  h.page.onUnload();
});
test("an old account's late audio 401 removes denied temporary bytes without clearing the newer story or its login", async () => {
  const h = harness();
  await showAudioStory(h);
  const playing = h.page.playLive(audioEvent);
  await turn();
  h.respond(2, recording);
  await turn();
  h.page.onHide();
  const other = structuredClone(login);
  other.user.id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  other.session.id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  other.session.token = "b".repeat(43);
  h.storage.set(`timenook.session.v1:${base}`, other);
  await showAudioStory(h, 3, "新账号私人正文");
  h.downloads[0].success({ statusCode: 401, tempFilePath: "old-denied-audio" });
  await playing;
  await turn();
  assert.deepEqual(h.storage.get(`timenook.session.v1:${base}`), other);
  assert.equal(h.page.data.liveParagraphs[0].text, "新账号私人正文");
  assert.ok(h.removed.includes("old-denied-audio"));
  assert.equal(h.page.data.busy, false);
  assert.equal(h.page.data.audioBusy, false);
  h.page.onUnload();
});

test("a successful audio response arriving at local session expiry cannot play or leave the private story busy", async () => {
  const h = harness();
  await showAudioStory(h);
  h.storage.set("synthetic-pending-original", [
    { path: "only-original", sealed: false },
  ]);
  const playing = h.page.playLive(audioEvent);
  await turn();
  h.respond(2, recording);
  await turn();
  h.expireSession();
  h.downloads[0].success({ statusCode: 200, tempFilePath: "expired-audio" });
  await playing;
  assert.equal(h.players.length, 0);
  assert.ok(h.removed.includes("expired-audio"));
  assert.equal(h.page.data.audioBusy, false);
  assert.equal(h.page.data.story, null);
  assert.ok(h.storage.has("synthetic-pending-original"));
  h.page.onUnload();
});

test("a story refresh arriving after local session expiry clears its private view and releases busy", async () => {
  const h = harness();
  await showAudioStory(h);
  const refreshing = h.page.refresh();
  await turn();
  h.expireSession();
  h.respond(2, {
    interviewId,
    clipCount: 1,
    pendingCount: 0,
    cloudSaved: true,
    story: story("succeeded", 1),
  });
  await refreshing;
  await turn();
  assert.equal(h.page.data.story, null);
  assert.equal(h.page.data.liveParagraphs.length, 0);
  assert.equal(h.page.data.busy, false);
  h.page.onUnload();
});

test("audio cleanup whose device bookkeeping fails after unlink can be retried without losing the pending original", async () => {
  const h = harness();
  await showAudioStory(h);
  h.storage.set("synthetic-pending-original", [
    { path: "only-original", sealed: false },
  ]);
  const first = h.page.playLive(audioEvent);
  await turn();
  h.respond(2, recording);
  await turn();
  h.downloads[0].success({
    statusCode: 200,
    tempFilePath: "first-private-audio",
  });
  await first;
  h.failAudioCleanup();
  h.page.onHide();
  await turn();
  await showAudioStory(h, 3);
  const second = h.page.playLive(audioEvent);
  await turn();
  if (h.requests[5]) {
    h.respond(5, recording);
    await turn();
    h.downloads[1].success({
      statusCode: 200,
      tempFilePath: "second-private-audio",
    });
  }
  await second;
  assert.equal(h.players.length, 2);
  assert.equal(h.players[1].plays, 1);
  assert.ok(h.storage.has("synthetic-pending-original"));
  assert.ok(!h.removed.includes("only-original"));
  h.page.onUnload();
});

test("a fresh StoryPage runtime recovers a persisted audio cache pointing at an already unlinked file", async () => {
  const old = harness();
  await showAudioStory(old);
  old.storage.set("synthetic-pending-original", [
    { path: "only-original", sealed: false },
  ]);
  const first = old.page.playLive(audioEvent);
  await turn();
  old.respond(2, recording);
  await turn();
  old.downloads[0].success({
    statusCode: 200,
    tempFilePath: "removed-before-restart",
  });
  await first;
  old.failAudioCleanup();
  old.page.onHide();
  await turn();
  assert.ok(
    (old.storage.get(`timenook.story-audio.v1:${base}`) as string[]).includes(
      "removed-before-restart",
    ),
  );
  const persisted = new Map(structuredClone([...old.storage])),
    fresh = harness({
      storage: persisted,
      missingFiles: ["removed-before-restart"],
    });
  assert.notEqual(fresh.page, old.page);
  await showAudioStory(fresh);
  assert.deepEqual(fresh.storage.get(`timenook.story-audio.v1:${base}`), []);
  const replay = fresh.page.playLive(audioEvent);
  await turn();
  if (fresh.requests[2]) {
    fresh.respond(2, recording);
    await turn();
    fresh.downloads[0].success({
      statusCode: 200,
      tempFilePath: "new-private-audio",
    });
  }
  await replay;
  assert.equal(fresh.players.length, 1);
  assert.equal(fresh.players[0].plays, 1);
  assert.ok(fresh.storage.has("synthetic-pending-original"));
  assert.ok(!fresh.removed.includes("only-original"));
  fresh.page.onUnload();
  old.page.onUnload();
});

test("a fresh story runtime retains an audio cleanup reference on permission failure and keeps the unique original", async () => {
  const storage = new Map<string, any>([
    ["timenook.mode.v1", "live"],
    [`timenook.session.v1:${base}`, structuredClone(login)],
    [`timenook.story-audio.v1:${base}`, ["still-private-audio"]],
    ["synthetic-pending-original", [{ path: "only-original", sealed: false }]],
  ]);
  const h = harness({ storage, unlinkFailure: 1300013 });
  h.page.onLoad({ projectId, interviewId });
  await h.page.onShow();
  assert.equal(h.requests.length, 0);
  assert.equal(h.page.data.story, null);
  assert.match(h.page.data.stage, /临时文件尚未清理/);
  assert.deepEqual(h.storage.get(`timenook.story-audio.v1:${base}`), [
    "still-private-audio",
  ]);
  assert.ok(h.storage.has("synthetic-pending-original"));
  h.page.onUnload();
});

test("direct StoryPage unload releases played private audio, listener and private view and tolerates repeated lifecycle cleanup", async () => {
  const h = harness();
  await showAudioStory(h);
  h.storage.set("synthetic-pending-original", [
    { path: "only-original", sealed: false },
  ]);
  const playing = h.page.playLive(audioEvent);
  await turn();
  h.respond(2, recording);
  await turn();
  h.downloads[0].success({
    statusCode: 200,
    tempFilePath: "unload-playing-audio",
  });
  await playing;
  h.page.onUnload();
  await turn();
  assert.equal(h.players[0].destroys, 1);
  assert.equal(h.players[0].stops, 1);
  assert.ok(h.removed.includes("unload-playing-audio"));
  assert.equal(h.page.stopSessionWatch, undefined);
  assert.equal(h.page.data.story, null);
  assert.equal(h.page.data.liveParagraphs.length, 0);
  assert.equal(h.page.data.busy, false);
  assert.equal(h.page.data.audioBusy, false);
  h.page.onHide();
  h.page.onUnload();
  await turn();
  assert.equal(h.players[0].destroys, 1);
  assert.ok(h.storage.has("synthetic-pending-original"));
  assert.ok(!h.removed.includes("only-original"));
});
test("direct StoryPage unload fences an in-flight download and removes its late temporary bytes while retaining the pending original", async () => {
  const h = harness();
  await showAudioStory(h);
  h.storage.set("synthetic-pending-original", [
    { path: "only-original", sealed: false },
  ]);
  const playing = h.page.playLive(audioEvent);
  await turn();
  h.respond(2, recording);
  await turn();
  h.page.onUnload();
  h.downloads[0].success({
    statusCode: 200,
    tempFilePath: "unload-late-audio",
  });
  await playing;
  await turn();
  assert.equal(h.players.length, 0);
  assert.ok(h.removed.includes("unload-late-audio"));
  assert.equal(h.page.stopSessionWatch, undefined);
  assert.equal(h.page.data.story, null);
  assert.equal(h.page.data.liveParagraphs.length, 0);
  assert.equal(h.page.data.audioBusy, false);
  h.page.onHide();
  h.page.onUnload();
  await turn();
  assert.ok(h.storage.has("synthetic-pending-original"));
  assert.ok(!h.removed.includes("only-original"));
});

for (const action of ["submitLive", "retryLive"]) {
  test(`${action} response at exact local expiry clears private story, audio and busy`, async () => {
    const h = harness();
    await showAudioStory(
      h,
      0,
      "当前私人正文",
      action === "retryLive" ? "failed" : "succeeded",
    );
    h.storage.set("synthetic-pending-original", [
      { path: "only-original", sealed: false },
    ]);
    const metadata = h.requests.length,
      playing = h.page.playLive(audioEvent);
    await turn();
    h.respond(metadata, recording);
    await turn();
    h.downloads[0].success({
      statusCode: 200,
      tempFilePath: `${action}-private-audio`,
    });
    await playing;
    const index = h.requests.length,
      pending = h.page[action]();
    await turn();
    assert.ok(
      h.requests[index].url.endsWith(
        action === "submitLive" ? "/organize" : `/tasks/${taskId}/retry`,
      ),
    );
    h.expireSession();
    h.respond(
      index,
      action === "submitLive"
        ? story("waiting_inputs", 1)
        : { id: taskId, projectId, kind: "compose_story", state: "queued" },
      202,
    );
    await pending;
    await turn();
    assert.equal(h.page.data.story, null);
    assert.equal(h.page.data.context, null);
    assert.equal(h.page.data.liveParagraphs.length, 0);
    assert.equal(h.page.data.busy, false);
    assert.equal(h.page.data.audioBusy, false);
    assert.equal(h.page.data.canOrganize, false);
    assert.equal(h.players[0].destroys, 1);
    assert.ok(h.removed.includes(`${action}-private-audio`));
    assert.equal(h.page.stopSessionWatch, undefined);
    assert.ok(h.storage.has("synthetic-pending-original"));
    assert.ok(!h.removed.includes("only-original"));
    h.page.onUnload();
  });
}

for (const action of ["submitLive", "retryLive"]) {
  test(`${action} late response cannot clear a newer account or page instance`, async () => {
    const h = harness();
    await showAudioStory(
      h,
      0,
      "旧页面私人正文",
      action === "retryLive" ? "failed" : "succeeded",
    );
    const index = h.requests.length,
      pending = h.page[action]();
    await turn();
    h.page.onHide();
    const identity = structuredClone(login);
    if (action === "submitLive") {
      identity.user.id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
      identity.session.id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
      identity.session.token = "b".repeat(43);
      h.storage.set(`timenook.session.v1:${base}`, identity);
    }
    await showAudioStory(h, h.requests.length, "后来页面私人正文");
    h.respond(
      index,
      action === "submitLive"
        ? story("waiting_inputs", 1)
        : { id: taskId, projectId, kind: "compose_story", state: "queued" },
      202,
    );
    await pending;
    assert.deepEqual(h.storage.get(`timenook.session.v1:${base}`), identity);
    assert.equal(h.page.data.liveParagraphs[0].text, "后来页面私人正文");
    assert.equal(h.page.data.busy, false);
    assert.equal(h.page.visible, true);
    h.page.onUnload();
  });
}
