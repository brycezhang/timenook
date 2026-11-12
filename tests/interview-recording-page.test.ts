import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";
const base = "https://example.test/timenook/v1",
  projectId = "33333333-3333-4333-8333-333333333333",
  interviewId = "44444444-4444-4444-8444-444444444444";
const login = {
  user: { id: "11111111-1111-4111-8111-111111111111" },
  session: {
    id: "22222222-2222-4222-8222-222222222222",
    token: "a".repeat(43),
    expiresAt: "2099-01-01T00:00:00Z",
  },
};
const compiled = await build({
  entryPoints: ["miniprogram/pages/interview/index.ts"],
  bundle: true,
  write: false,
  format: "cjs",
  platform: "neutral",
  define: { __TIMENOOK_API_BASE_URL__: JSON.stringify(base) },
});
function harness(
  options: {
    autoUpload?: boolean;
    deferSaves?: boolean;
    deferStops?: boolean;
    deferPauses?: boolean;
    deferUploads?: boolean;
    clock?: { now: number };
  } = {},
) {
  const storage = new Map<string, unknown>([
      ["timenook.mode.v1", "live"],
      [`timenook.session.v1:${base}`, login],
    ]),
    requestedDurations: number[] = [],
    requests: any[] = [],
    uploads: any[] = [],
    downloads: any[] = [],
    removed: string[] = [],
    files = new Set<string>(),
    handlers: Record<string, ((v?: any) => void)[]> = {},
    pendingSaves: any[] = [],
    pendingStops: (() => void)[] = [],
    pendingPauses: (() => void)[] = [],
    uploadProgress: ((event: { progress: number }) => void)[] = [],
    navigation: any[] = [],
    modals: any[] = [],
    played: string[] = [],
    playingAudios = new Set<object>(),
    intervals = new Map<number, () => void>();
  let intervalId = 0;
  const clock = options.clock ?? { now: Date.now() };
  class DeviceDate extends Date {
    static now() {
      return clock.now;
    }
  }
  let page: any,
    saves = 0,
    failManifest = false,
    starts = 0,
    resumes = 0,
    stops = 0,
    deviceStage = "inactive";
  const emit = (event: string, v?: any) =>
    handlers[event]?.forEach((fn) => fn(v));
  runInNewContext(compiled.outputFiles[0].text, {
    Date: DeviceDate,
    setTimeout,
    clearTimeout,
    setInterval: options.clock
      ? (callback: () => void) => {
          intervals.set(++intervalId, callback);
          return intervalId;
        }
      : setInterval,
    clearInterval: options.clock
      ? (id: number) => intervals.delete(id)
      : clearInterval,
    getCurrentPages: () => [{}, {}],
    Page: (value: any) => {
      page = value;
      // Stage fixtures exercise recovery before upload; the automatic path is tested separately below.
      if (!options.autoUpload) page.queueAutoUpload = () => {};
      page.setData = (patch: object) => Object.assign(page.data, patch);
    },
    wx: {
      env: { USER_DATA_PATH: "/user-data" },
      getStorageSync: (key: string) => {
        assert.notEqual(
          key,
          "timenook.projects.v1",
          "live cannot consume demo projects",
        );
        return structuredClone(storage.get(key));
      },
      setStorageSync: (key: string, value: unknown) => {
        if (failManifest && key.includes("recording"))
          throw Error("storage full");
        storage.set(key, structuredClone(value));
      },
      removeStorageSync: (key: string) => storage.delete(key),
      getAccountInfoSync: () => ({ miniProgram: { appId: "synthetic-app" } }),
      request: (o: any) => requests.push(o),
      downloadFile: (o: any) => downloads.push(o),
      uploadFile: (o: any) => {
        uploads.push(o);
        if (!options.deferUploads) o.success({ statusCode: 204 });
        return {
          onProgressUpdate: (callback: any) => uploadProgress.push(callback),
        };
      },
      getRecorderManager: () => ({
        onStart: (f: any) => (handlers.start ??= []).push(f),
        onStop: (f: any) => (handlers.stop ??= []).push(f),
        onPause: (f: any) => (handlers.pause ??= []).push(f),
        onResume: (f: any) => (handlers.resume ??= []).push(f),
        pause: () => {
          const pause = () => {
            deviceStage = "paused";
            emit("pause");
          };
          if (options.deferPauses) pendingPauses.push(pause);
          else pause();
        },
        resume: () => {
          resumes++;
          deviceStage = "recording";
          emit("resume");
        },
        onError: (f: any) => (handlers.error ??= []).push(f),
        onInterruptionBegin: (f: any) => (handlers.interrupt ??= []).push(f),
        start: (options: any) => {
          requestedDurations.push(options.duration);
          starts++;
          deviceStage = "recording";
          emit("start");
        },
        stop: () => {
          stops++;
          deviceStage = "inactive";
          const finish = () =>
            emit("stop", { tempFilePath: "native-temp", duration: 1080 });
          if (options.deferStops) pendingStops.push(finish);
          else finish();
        },
      }),
      getFileSystemManager: () => ({
        saveFile: (o: any) => {
          saves++;
          const savedFilePath = `saved-audio-${saves}`;
          const finish = () => {
            files.add(savedFilePath);
            o.success({ savedFilePath });
          };
          if (options.deferSaves) pendingSaves.push({ finish, fail: o.fail });
          else finish();
        },
        getFileInfo: (o: any) =>
          o.success({ size: 6480, digest: "b".repeat(64) }),
        access: (o: any) => (files.has(o.path) ? o.success({}) : o.fail({})),
        unlink: (o: any) => {
          removed.push(o.filePath);
          o.success({});
        },
      }),
      createInnerAudioContext: () => ({
        src: "",
        onEnded() {},
        onError() {},
        play() {
          played.push(this.src);
          playingAudios.add(this);
        },
        destroy() {
          playingAudios.delete(this);
        },
      }),
      showModal: (options: any) => modals.push(options),
      navigateTo: (options: any) => navigation.push(options),
      redirectTo: (options: any) => navigation.push(options),
      navigateBack: () => navigation.push({ back: true }),
      switchTab: (options: any) => navigation.push(options),
      enableAlertBeforeUnload: (options: any) =>
        modals.push({ nativeAlert: true, ...options }),
      disableAlertBeforeUnload: () => {},
      reLaunch: () => {},
      showToast: () => {},
      openSetting: (options: any) =>
        modals.push({ settings: true, ...options }),
    },
  });
  return {
    page,
    storage,
    requests,
    requestedDurations,
    uploads,
    downloads,
    removed,
    files,
    emit,
    pendingSaves,
    pendingStops,
    pendingPauses,
    uploadProgress,
    navigation,
    modals,
    played,
    expireSession() {
      clock.now = Date.parse(login.session.expiresAt);
    },
    advance(ms: number) {
      assert.ok(options.clock, "controlled device clock required");
      clock.now += ms;
      for (const callback of intervals.values()) callback();
    },
    get saves() {
      return saves;
    },
    get starts() {
      return starts;
    },
    get resumes() {
      return resumes;
    },
    get stops() {
      return stops;
    },
    get deviceStage() {
      return deviceStage;
    },
    get playingAudioCount() {
      return playingAudios.size;
    },
    fail(value: boolean) {
      failManifest = value;
    },
  };
}
function respond(r: any, value: unknown, statusCode = 200) {
  assert.ok(r, "expected platform request");
  r.success({
    statusCode,
    data:
      statusCode < 400
        ? { data: value, meta: { requestId: "synthetic" } }
        : {
            error: {
              code: statusCode === 401 ? "UNAUTHENTICATED" : "FORBIDDEN",
            },
            meta: { requestId: "synthetic" },
          },
  });
}
const tick = () => new Promise((r) => setImmediate(r));
const question = {
  id: "55555555-5555-4555-8555-555555555555",
  projectId,
  planRevision: 1,
  capturedBy: login.user.id,
  questionKey: "place",
  starterKind: null,
  snapshot: { text: "你想讲讲家门前的小路吗？", intent: "具体场景" },
  answerRef: interviewId,
};
const interview = {
  id: interviewId,
  projectId,
  subjectId: "66666666-6666-4666-8666-666666666666",
  actualQuestion: question,
  clips: [],
  usage: { reservedMs: 0, consumedMs: 0 },
};
const context = {
  canRecord: true,
  interviews: [],
  plan: {
    revision: 1,
    defaultQuestion: {
      key: "place",
      text: question.snapshot.text,
      intent: "具体场景",
    },
    eligibleQuestions: [
      { key: "place", text: question.snapshot.text, intent: "具体场景" },
      { key: "memory", text: "还有哪一件小事让你记得很清楚？", intent: "回忆" },
    ],
    starters: [],
  },
};
async function ready(h: ReturnType<typeof harness>) {
  h.page.onLoad({ projectId });
  const showing = h.page.onShow();
  assert.equal(h.requests[0].url, `${base}/projects/${projectId}/interviews`);
  respond(h.requests.shift(), context);
  await showing;
  const selecting = h.page.ensureInterview();
  assert.match(h.requests[0].data.clientInterviewId, /^[a-f0-9-]{36}$/);
  respond(h.requests.shift(), interview, 201);
  await tick();
  respond(h.requests.shift(), null);
  await selecting;
}
async function start(h: ReturnType<typeof harness>) {
  const starting = h.page.startSpeaking();
  await tick();
  const request = h.requests.shift(),
    selectedQuestion =
      h.page.data.interview.currentQuestion ??
      h.page.data.interview.actualQuestion;
  assert.equal(request.data.actualQuestionId, selectedQuestion.id);
  assert.equal(
    request.data.expectedQuestionVersion,
    h.page.data.interview.questionVersion ?? 1,
  );
  respond(
    request,
    {
      allowed: true,
      actualQuestionId: (
        h.page.data.interview.currentQuestion ??
        h.page.data.interview.actualQuestion
      ).id,
      questionVersion: h.page.data.interview.questionVersion ?? 1,
      maxDurationMs: 300000,
    },
    201,
  );
  await starting;
}
test("ready entry displays the actual family author and permits photos without another setup screen", async (t) => {
  const h = harness();
  t.after(() => h.page.onUnload());
  h.page.onLoad({ projectId, interviewId, prepare: "1" });
  const showing = h.page.onShow();
  respond(h.requests.shift(), {
    ...context,
    interviews: [
      {
        ...interview,
        actualQuestion: {
          ...question,
          source: {
            kind: "family",
            authorNickname: "小陈",
            authorRelationship: "女儿",
            authorId: "another-member",
            chapterKey: "childhood",
          },
        },
      },
    ],
  });
  await tick();
  respond(h.requests.shift(), null);
  await showing;
  assert.equal(h.page.data.screen, "ready");
  assert.equal(h.page.data.questionSource, "女儿 · 小陈的提问");
  assert.equal(h.page.data.interview.id, interviewId);
  assert.equal(h.starts, 0);
  assert.equal(h.page.data.canChooseQuestion, true);
});

test("adding photos pauses the same native recording, survives the photo page and resumes with elapsed time", async (t) => {
  const h = harness({ clock: { now: 1000 } });
  t.after(() => h.page.onUnload());
  await ready(h);
  await start(h);
  h.advance(42000);
  await h.page.photos();
  assert.equal(h.page.data.screen, "paused");
  assert.equal(h.page.data.timer, "00:42");
  assert.match(h.navigation[0].url, new RegExp("interviewId=" + interviewId));
  h.page.onHide();
  h.advance(60000);
  assert.equal(h.stops, 0);
  const returning = h.page.onShow();
  respond(h.requests.shift(), { allowed: true });
  await tick();
  respond(h.requests.shift(), null);
  await returning;
  assert.equal(h.page.data.timer, "00:42");
  const resuming = h.page.togglePause();
  respond(
    h.requests.shift(),
    {
      allowed: true,
      actualQuestionId: question.id,
      questionVersion: 1,
      maxDurationMs: 600000,
    },
    201,
  );
  await resuming;
  h.advance(3000);
  assert.equal(h.page.data.timer, "00:45");
  assert.equal(h.starts, 1);
  assert.equal(h.resumes, 1);
});

const partition = `timenook.recording.v1:${base}:synthetic-app:${login.user.id}:${projectId}`;
function remoteFor(local: any, storage = "oss") {
  return {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    projectId,
    interviewId,
    actualQuestionId: question.id,
    clientClipId: local.clientClipId,
    bytes: local.bytes,
    sha256: local.sha256,
    state: "pending",
    storage,
    asset: null,
  };
}
function sealed(remote: any) {
  return {
    ...remote,
    state: "sealed",
    asset: {
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      sha256: remote.sha256,
      bytes: remote.bytes,
      mime: "audio/mpeg",
    },
  };
}
async function grantUpload(h: ReturnType<typeof harness>, remote: any) {
  respond(h.requests.shift(), remote, 201);
  await tick();
  respond(
    h.requests.shift(),
    {
      url: "https://synthetic-t14.oss-cn-hangzhou.aliyuncs.com",
      storage: "oss",
      expiresAt: "2099-01-01T00:00:00Z",
      fields: { key: `staging/${remote.id}.mp3`, policy: "synthetic" },
    },
    201,
  );
  await tick();
}

test("photo navigation waits for the native pause callback before covering the recording page", async (t) => {
  const h = harness({ deferPauses: true });
  t.after(() => h.page.onUnload());
  await ready(h);
  await start(h);
  await h.page.photos();
  assert.equal(h.navigation.length, 0);
  assert.equal(h.deviceStage, "recording");
  h.pendingPauses.shift()!();
  assert.equal(h.navigation.length, 1);
  assert.equal(h.page.data.screen, "paused");
});

test("new story ignores another interview and keeps only genuine pending local recovery entries", async (t) => {
  const h = harness();
  t.after(() => h.page.onUnload());
  h.storage.set(`${partition}:active`, interviewId);
  h.storage.set(`${partition}:index`, [interviewId]);
  h.storage.set(`${partition}:${interviewId}`, [
    {
      clientClipId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      path: "saved-other-story",
      sha256: "b".repeat(64),
      bytes: 6400,
      durationMs: 1000,
      actualQuestionId: question.id,
    },
  ]);
  h.page.onLoad({
    projectId,
    draftId: "77777777-7777-4777-8777-777777777777",
    prepare: "1",
  });
  const showing = h.page.onShow();
  respond(h.requests.shift(), { ...context, interviews: [interview] });
  await showing;
  assert.equal(h.page.data.interview, null);
  assert.equal(h.page.data.screen, "ready");
  assert.equal(h.page.data.question, question.snapshot.text);
  assert.equal(h.page.data.pendingInterviews[0], interviewId);
  assert.equal(h.requests.length, 0);
  assert.equal(h.starts, 0);
});

test("continuing a saved story prepares the same interview and refuses changing its question", async (t) => {
  const h = harness();
  t.after(() => h.page.onUnload());
  h.page.onLoad({ projectId, interviewId, prepare: "1" });
  const showing = h.page.onShow();
  respond(h.requests.shift(), {
    ...context,
    interviews: [
      { ...interview, clips: [{ id: "saved-clip", state: "sealed" }] },
    ],
  });
  await tick();
  respond(h.requests.shift(), null);
  await showing;
  assert.equal(h.page.data.screen, "ready");
  assert.equal(h.page.data.canChooseQuestion, false);
  h.page.chooseAnother();
  assert.equal(h.navigation.length, 0);
  await start(h);
  assert.equal(h.page.data.interview.id, interviewId);
  assert.equal(h.page.data.timer, "00:00");
  assert.equal(h.starts, 1);
});

test("changing an empty question replaces preparation with the real outline entry", async (t) => {
  const h = harness();
  t.after(() => h.page.onUnload());
  await ready(h);
  h.page.chooseAnother();
  assert.equal(
    h.navigation[0].url,
    `/pages/directory/index?projectId=${projectId}`,
  );
  assert.equal(h.requests.length, 0);
});

test("a free-narration entry preserves its starter when the current project has outline questions", async (t) => {
  const h = harness();
  t.after(() => h.page.onUnload());
  h.page.onLoad({ projectId, starterKind: "free-narration", prepare: "1" });
  const showing = h.page.onShow();
  respond(h.requests.shift(), context);
  await showing;
  assert.equal(h.page.data.question, "自由讲述");
  const preparing = h.page.ensureInterview();
  const request = h.requests.shift();
  assert.equal(request.data.starterKind, "free-narration");
  assert.equal(request.data.questionKey, undefined);
  respond(request, {
    ...interview,
    actualQuestion: {
      ...question,
      questionKey: null,
      starterKind: "free-narration",
      snapshot: { text: "自由讲述", intent: "回忆" },
    },
  });
  await tick();
  respond(h.requests.shift(), null);
  await preparing;
  assert.equal(h.page.data.questionSource, "自由讲述");
});

test("all starter kinds load selected photos and removing one changes references without deleting project material", async (t) => {
  const h = harness();
  t.after(() => h.page.onUnload());
  h.page.onLoad({ projectId, interviewId, prepare: "1" });
  const showing = h.page.onShow();
  respond(h.requests.shift(), { ...context, interviews: [interview] });
  await tick();
  const snapshot = {
    id: "snapshot",
    projectId,
    interviewId,
    revision: 2,
    hash: "h",
    entries: [
      { photoId: "photo-a", caption: "小时候", assets: [] },
      { photoId: "photo-b", caption: "家门口", assets: [] },
    ],
  };
  respond(h.requests.shift(), snapshot);
  await showing;
  assert.equal(h.page.data.recordingPhotos.length, 2);
  const removing = h.page.removePhoto({
    currentTarget: { dataset: { id: "photo-a" } },
  });
  const request = h.requests.shift();
  assert.equal(
    request.url,
    `${base}/projects/${projectId}/interviews/${interviewId}/photo-materials`,
  );
  assert.equal(request.data.expectedRevision, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(request.data.entries)), [
    { photoId: "photo-b", caption: "家门口" },
  ]);
  respond(request, {
    ...snapshot,
    revision: 3,
    entries: snapshot.entries.slice(1),
  });
  await removing;
  assert.equal(h.page.data.recordingPhotos.length, 1);
  assert.equal(h.page.data.recordingPhotos[0].photoId, "photo-b");
  assert.equal(h.requests.length, 0);
});

test("ending records a durable file and manifest before automatic upload, then opens the same story after seal", async (t) => {
  const h = harness({ autoUpload: true, deferSaves: true, deferUploads: true });
  t.after(() => h.page.onUnload());
  await ready(h);
  await start(h);
  h.page.finishRecording();
  await tick();
  assert.equal(h.page.data.screen, "saving");
  assert.equal(h.uploads.length, 0);
  assert.equal(h.requests.length, 0);
  assert.equal(h.page.data.localClips.length, 0);
  h.pendingSaves.shift().finish();
  await tick();
  const local = h.page.data.localClips[0];
  assert.equal(h.files.has(local.path), true);
  assert.equal(
    (h.storage.get(`${partition}:${interviewId}`) as any[])[0].clientClipId,
    local.clientClipId,
  );
  const remote = remoteFor(local);
  await grantUpload(h, remote);
  assert.equal(h.uploads.length, 1);
  assert.equal(h.uploads[0].header, undefined);
  assert.equal(h.uploads[0].filePath, local.path);
  assert.equal(h.navigation.length, 0);
  h.uploadProgress[0]({ progress: 37 });
  assert.equal(h.page.data.uploadProgress, 37);
  assert.equal(h.page.data.hasUploadProgress, true);
  h.uploads[0].success({ statusCode: 204 });
  await tick();
  assert.equal(h.page.data.screen, "saving");
  assert.equal(h.page.data.state, "sealing");
  assert.equal(h.navigation.length, 0);
  respond(h.requests.shift(), sealed(remote), 201);
  await tick();
  assert.equal(h.page.data.localClips[0].sealed, true);
  assert.equal(h.navigation.length, 1);
  assert.equal(
    h.navigation[0].url,
    `/pages/story/index?projectId=${projectId}&interviewId=${interviewId}`,
  );
  assert.equal(
    h.requests.length,
    0,
    "no separate transcription or compose submission",
  );
});

test("the native ten-minute stop automatically saves and uploads without a manual finish action", async (t) => {
  const h = harness({ autoUpload: true });
  t.after(() => h.page.onUnload());
  await ready(h);
  const starting = h.page.startSpeaking();
  await tick();
  respond(
    h.requests.shift(),
    {
      allowed: true,
      actualQuestionId: question.id,
      questionVersion: 1,
      maxDurationMs: 600000,
    },
    201,
  );
  await starting;
  assert.equal(h.requestedDurations[0], 599500);
  h.emit("stop", { tempFilePath: "native-ten-minutes", duration: 599700 });
  await tick();
  assert.equal(h.page.data.timer, "09:59");
  assert.equal(h.page.data.screen, "saving");
  const remote = remoteFor(h.page.data.localClips[0]);
  await grantUpload(h, remote);
  respond(h.requests.shift(), sealed(remote), 201);
  await tick();
  assert.equal(h.navigation.length, 1);
});

test("an unknown seal retains the same original and retries its status instead of duplicating a clip or story", async (t) => {
  const h = harness({ autoUpload: true });
  t.after(() => h.page.onUnload());
  await ready(h);
  await start(h);
  h.page.finishRecording();
  await tick();
  const local = h.page.data.localClips[0],
    remote = remoteFor(local);
  await grantUpload(h, remote);
  h.requests.shift().fail({ errMsg: "request:fail timeout" });
  await tick();
  assert.equal(h.page.data.screen, "failed");
  assert.equal(h.files.has(local.path), true);
  assert.equal(h.navigation.length, 0);
  const retry = h.page.retryProcessing(),
    status = h.requests.shift();
  assert.equal(
    status.url,
    `${base}/projects/${projectId}/interviews/${interviewId}/clips/${remote.id}/status`,
  );
  respond(status, sealed(remote), 201);
  await retry;
  assert.equal(h.uploads.length, 1);
  assert.equal(h.page.data.localClips.length, 1);
  assert.equal(h.navigation.length, 1);
});

test("failed native persistence stays recoverable on the original recorder and never offers cloud success", async (t) => {
  const h = harness({ autoUpload: true, deferSaves: true });
  t.after(() => h.page.onUnload());
  await ready(h);
  await start(h);
  h.page.finishRecording();
  h.pendingSaves.shift().fail({ errMsg: "saveFile:fail" });
  await tick();
  assert.equal(h.page.data.localSaveFailed, true);
  assert.equal(h.page.data.screen, "failed");
  assert.equal(h.requests.length, 0);
  assert.equal(h.navigation.length, 0);
  const retry = h.page.retryProcessing();
  h.pendingSaves.shift().finish();
  await retry;
  await tick();
  assert.equal(h.page.data.localClips.length, 1);
  assert.equal(h.requests.length, 1);
  assert.equal(h.page.data.screen, "saving");
});

test("microphone permission enabled in settings stays ready after adding photos and returning", async (t) => {
  const h = harness();
  t.after(() => h.page.onUnload());
  await ready(h);
  await start(h);
  h.emit("error");
  assert.equal(h.page.data.screen, "blocked");
  h.page.settings();
  const setting = h.modals.find((modal) => modal.settings);
  h.page.onHide();
  setting.success({ authSetting: { "scope.record": true } });
  setting.complete();
  assert.equal(h.page.data.screen, "ready");
  assert.equal(h.page.data.question, question.snapshot.text);
  assert.equal(h.page.data.interview.id, interviewId);
  assert.equal(h.saves, 0);
  await h.page.photos();
  assert.match(h.navigation[0].url, new RegExp("interviewId=" + interviewId));
  h.page.onHide();
  const returning = h.page.onShow();
  respond(h.requests.shift(), { allowed: true });
  await tick();
  respond(h.requests.shift(), {
    id: "selected-photos",
    projectId,
    interviewId,
    revision: 1,
    hash: "h",
    entries: [{ photoId: "photo-a", caption: "小时候", assets: [] }],
  });
  await returning;
  assert.equal(h.page.data.recordingPhotos.length, 1);
  assert.equal(h.page.data.screen, "ready");
  assert.equal(h.page.data.state, "idle");
  assert.equal(h.page.data.question, question.snapshot.text);
  await start(h);
  assert.equal(h.page.data.screen, "recording");
  assert.equal(h.starts, 2);
});

test("the visible back action offers save or continue, and save leaves only after the recording is sealed", async (t) => {
  const h = harness({ autoUpload: true });
  t.after(() => h.page.onUnload());
  await ready(h);
  await start(h);
  const cancel = h.page.leave();
  h.modals.find((modal) => !modal.nativeAlert).success({ confirm: false });
  await cancel;
  assert.equal(h.stops, 0);
  assert.equal(h.navigation.length, 0);
  h.modals.splice(0);
  const leaving = h.page.leave();
  h.modals.find((modal) => !modal.nativeAlert).success({ confirm: true });
  await leaving;
  await tick();
  assert.equal(h.stops, 1);
  assert.equal(h.navigation.length, 0);
  const remote = remoteFor(h.page.data.localClips[0]);
  await grantUpload(h, remote);
  respond(h.requests.shift(), sealed(remote), 201);
  await tick();
  assert.equal(h.navigation[0].url, "/pages/home/index");
});

test("native back and unexpected unload stop once and finish the durable save in the original project", async () => {
  const h = harness({ deferStops: true, deferSaves: true });
  await ready(h);
  await start(h);
  await h.page.togglePause();
  assert.ok(h.modals.some((modal) => modal.nativeAlert));
  h.page.onHide();
  h.page.onUnload();
  assert.equal(h.stops, 1);
  assert.equal(h.page.data.question, "");
  h.pendingStops.shift()!();
  h.pendingSaves.shift().finish();
  await tick();
  const manifest = h.storage.get(`${partition}:${interviewId}`) as any[];
  assert.equal(manifest.length, 1);
  assert.equal(manifest[0].actualQuestionId, question.id);
  assert.equal(h.files.has(manifest[0].path), true);
  assert.equal(h.navigation.length, 0);
});

test("permission revocation during start clears private data and does not start the microphone", async (t) => {
  const h = harness();
  t.after(() => h.page.onUnload());
  await ready(h);
  const starting = h.page.startSpeaking();
  await tick();
  respond(h.requests.shift(), {}, 403);
  await starting;
  assert.equal(h.page.data.interview, null);
  assert.equal(h.page.data.question, "");
  assert.equal(h.starts, 0);
  assert.equal(h.page.data.canRecord, false);
});

test("another account cannot receive a late microphone authorization or the previous private question", async (t) => {
  const h = harness();
  t.after(() => h.page.onUnload());
  await ready(h);
  const starting = h.page.startSpeaking();
  await tick();
  const request = h.requests.shift();
  h.storage.set(`timenook.session.v1:${base}`, {
    ...login,
    user: { id: "99999999-9999-4999-8999-999999999999" },
    session: { ...login.session, token: "c".repeat(43) },
  });
  h.page.onHide();
  respond(
    request,
    {
      allowed: true,
      actualQuestionId: question.id,
      questionVersion: 1,
      maxDurationMs: 600000,
    },
    201,
  );
  await starting;
  assert.equal(h.starts, 0);
  assert.equal(h.page.data.question, "");
  assert.equal(h.page.data.interview, null);
});

test("an upload finishing after switching projects seals only its captured project and cannot navigate the later page", async (t) => {
  const h = harness({ autoUpload: true, deferUploads: true });
  t.after(() => h.page.onUnload());
  await ready(h);
  await start(h);
  h.page.finishRecording();
  await tick();
  const local = h.page.data.localClips[0],
    remote = remoteFor(local);
  await grantUpload(h, remote);
  h.page.onHide();
  h.page.projectId = "99999999-9999-4999-8999-999999999999";
  h.uploads[0].success({ statusCode: 204 });
  await tick();
  const sealing = h.requests.shift();
  assert.match(sealing.url, new RegExp(`/projects/${projectId}/`));
  respond(sealing, sealed(remote), 201);
  await tick();
  assert.equal(
    (h.storage.get(`${partition}:${interviewId}`) as any[])[0].sealed,
    true,
  );
  assert.equal(h.navigation.length, 0);
  assert.equal(h.page.data.question, "");
});

test("a restored unsaved clip resumes automatically through its original interview while another story remains separate", async (t) => {
  const h = harness({ autoUpload: true });
  t.after(() => h.page.onUnload());
  await ready(h);
  await start(h);
  h.page.finishRecording();
  await tick();
  const local = h.page.data.localClips[0];
  h.requests.shift().fail({ errMsg: "request:fail timeout" });
  await tick();
  h.page.onHide();
  const returning = h.page.onShow();
  respond(h.requests.shift(), { ...context, interviews: [interview] });
  await tick();
  respond(h.requests.shift(), null);
  await returning;
  await tick();
  const request = h.requests.shift();
  assert.equal(request.data.clientClipId, local.clientClipId);
  assert.equal(
    request.url,
    `${base}/projects/${projectId}/interviews/${interviewId}/clips`,
  );
  assert.equal(h.saves, 1);
});

test("the actual remaining budget limits a new segment and pause time does not consume it", async (t) => {
  const h = harness({ clock: { now: 1000 } });
  t.after(() => h.page.onUnload());
  await ready(h);
  const starting = h.page.startSpeaking();
  await tick();
  respond(
    h.requests.shift(),
    {
      allowed: true,
      actualQuestionId: question.id,
      questionVersion: 1,
      maxDurationMs: 17900,
    },
    201,
  );
  await starting;
  assert.equal(h.requestedDurations[0], 17400);
  assert.equal(h.page.data.recordingLimitLabel, "00:18");
  h.advance(3000);
  await h.page.togglePause();
  h.advance(5000);
  assert.equal(h.page.data.timer, "00:03");
});

test("returning during a delayed native save reattaches its owner and retries the same saved file", async (t) => {
  const h = harness({ deferSaves: true });
  t.after(() => h.page.onUnload());
  await ready(h);
  await start(h);
  h.page.finishRecording();
  h.page.onHide();
  const returning = h.page.onShow();
  respond(h.requests.shift(), { ...context, interviews: [interview] });
  await tick();
  respond(h.requests.shift(), null);
  await returning;
  assert.equal(h.page.data.screen, "saving");
  assert.equal(h.starts, 1);
  assert.equal(h.saves, 1);
  h.fail(true);
  h.pendingSaves.shift().finish();
  await tick();
  assert.equal(h.page.data.localSaveFailed, true);
  h.fail(false);
  await h.page.retryProcessing();
  await tick();
  assert.equal(h.saves, 1);
  assert.equal(h.page.data.localClips.length, 1);
  assert.equal(h.files.size, 1);
});
