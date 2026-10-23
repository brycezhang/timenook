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
function harness(options: { deferSaves?: boolean } = {}) {
  const storage = new Map<string, unknown>([
      ["timenook.mode.v1", "live"],
      [`timenook.session.v1:${base}`, login],
    ]),
    requests: any[] = [],
    uploads: any[] = [],
    files = new Set<string>(),
    handlers: Record<string, ((v?: any) => void)[]> = {},
    pendingSaves: any[] = [],
    navigation: any[] = [];
  let now = Date.now();
  class DeviceDate extends Date {
    static now() {
      return now;
    }
  }
  let page: any,
    saves = 0,
    failManifest = false,
    starts = 0;
  const emit = (event: string, v?: any) =>
    handlers[event]?.forEach((fn) => fn(v));
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
      uploadFile: (o: any) => {
        uploads.push(o);
        o.success({ statusCode: 204 });
      },
      getRecorderManager: () => ({
        onStart: (f: any) => (handlers.start ??= []).push(f),
        onStop: (f: any) => (handlers.stop ??= []).push(f),
        onError: (f: any) => (handlers.error ??= []).push(f),
        onInterruptionBegin: (f: any) => (handlers.interrupt ??= []).push(f),
        start: () => {
          starts++;
          emit("start");
        },
        stop: () =>
          emit("stop", { tempFilePath: "native-temp", duration: 1080 }),
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
      }),
      navigateTo: (options: any) => navigation.push(options),
      reLaunch: () => {},
      showToast: () => {},
      openSetting: () => {},
    },
  });
  return {
    page,
    storage,
    requests,
    uploads,
    files,
    emit,
    pendingSaves,
    navigation,
    expireSession() {
      now = Date.parse(login.session.expiresAt);
    },
    get saves() {
      return saves;
    },
    get starts() {
      return starts;
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
    starters: [],
  },
};
async function ready(h: ReturnType<typeof harness>) {
  h.page.onLoad({ projectId });
  const showing = h.page.onShow();
  assert.equal(h.requests[0].url, `${base}/projects/${projectId}/interviews`);
  respond(h.requests.shift(), context);
  await showing;
  const selecting = h.page.selectQuestion();
  assert.match(h.requests[0].data.clientInterviewId, /^[a-f0-9-]{36}$/);
  respond(h.requests.shift(), interview, 201);
  await selecting;
}
async function start(h: ReturnType<typeof harness>) {
  const starting = h.page.record();
  respond(
    h.requests.shift(),
    {
      allowed: true,
      actualQuestionId: (
        h.page.data.interview.currentQuestion ??
        h.page.data.interview.actualQuestion
      ).id,
      questionVersion: h.page.data.interview.questionVersion ?? 1,
    },
    201,
  );
  await starting;
}
test("live recording page saves file and manifest before success and restores the same account's pending file after re-login", async () => {
  const h = harness();
  await ready(h);
  await start(h);
  assert.equal(h.page.data.state, "recording");
  h.fail(true);
  h.page.record();
  await tick();
  assert.equal(h.page.data.state, "device-error");
  assert.equal(h.saves, 1);
  assert.match(h.page.data.status, /没有保存成功|未保存|先别退出/);
  h.fail(false);
  await h.page.retry();
  assert.equal(h.saves, 1);
  assert.equal(h.page.data.localClips.length, 1);
  assert.match(h.page.data.status, /本机/);
  h.page.onHide();
  h.storage.set(`timenook.session.v1:${base}`, {
    ...login,
    session: {
      ...login.session,
      id: "77777777-7777-4777-8777-777777777777",
      token: "c".repeat(43),
    },
  });
  const showing = h.page.onShow();
  respond(h.requests.shift(), { ...context, interviews: [interview] });
  await showing;
  assert.equal(h.page.data.localClips.length, 1);
  assert.equal(h.starts, 1);
  assert.equal(h.files.size, 1);
  h.page.onUnload();
});

test("switching accounts hides local material and delayed recorder callbacks retain only their original ownership", async () => {
  const h = harness();
  await ready(h);
  await start(h);
  h.page.onHide();
  h.storage.set(`timenook.session.v1:${base}`, {
    user: { id: "88888888-8888-4888-8888-888888888888" },
    session: {
      ...login.session,
      id: "99999999-9999-4999-8999-999999999999",
      token: "d".repeat(43),
    },
  });
  await tick();
  const showing = h.page.onShow();
  respond(h.requests.shift(), context);
  await showing;
  assert.equal(h.page.data.localClips.length, 0);
  assert.equal(h.page.data.interview, null);
  assert.equal(h.starts, 1);
  assert.equal(h.files.size, 1);
  const manifests = [...h.storage.entries()].filter(
    ([key, value]) =>
      key.includes("recording") &&
      Array.isArray(value) &&
      value.some((clip) => clip && typeof clip === "object" && "path" in clip),
  );
  assert.equal(manifests.length, 1);
  assert.ok(manifests[0][0].includes(login.user.id));
  assert.ok(!manifests[0][0].includes("88888888"));
  h.page.onUnload();
});

test("collection-only assisted page uses the selected interview and minimal resume endpoint instead of private history", async () => {
  const h = harness(),
    assisted = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  h.page.onLoad({ projectId, assistedSessionId: assisted });
  const show = h.page.onShow();
  assert.equal(
    h.requests[0].url,
    `${base}/projects/${projectId}/interviews/context`,
  );
  respond(h.requests.shift(), context, 201);
  await show;
  const select = h.page.selectQuestion();
  assert.equal(h.requests[0].data.assistedSessionId, assisted);
  respond(h.requests.shift(), interview, 201);
  await select;
  await start(h);
  h.page.onHide();
  await tick();
  const reshow = h.page.onShow();
  respond(h.requests.shift(), context, 201);
  await tick();
  assert.equal(
    h.requests[0].url,
    `${base}/projects/${projectId}/interviews/${interviewId}/resume`,
  );
  respond(h.requests.shift(), interview, 201);
  await reshow;
  assert.equal(h.page.data.localClips.length, 1);
  assert.equal(h.starts, 1);
  h.page.onUnload();
});

test("leaving the live page clears self-written drafts before another account can enter", async () => {
  const h = harness();
  await ready(h);
  h.page.customText({ detail: { value: "私人自拟问题" } });
  h.page.customIntent({ detail: { value: "私人目的" } });
  h.page.onHide();
  assert.equal(h.page.data.customText, "");
  assert.equal(h.page.data.customIntent, "");
  h.page.onUnload();
});

test("starting the microphone rechecks current collection permission and a revoked response clears private UI", async (t) => {
  const h = harness();
  await ready(h);
  t.after(() => h.page.onUnload());
  const starting = h.page.record();
  assert.equal(h.starts, 0);
  assert.equal(
    h.requests[0].url,
    `${base}/projects/${projectId}/interviews/${interviewId}/recording-start`,
  );
  respond(h.requests.shift(), undefined, 403);
  await starting;
  assert.equal(h.starts, 0);
  assert.equal(h.page.data.interview, null);
  assert.equal(h.page.data.question, "");
  h.page.onUnload();
});

test("an OSS upload uses the exact granted destination without disclosing the API bearer and commits success only after seal", async () => {
  const h = harness();
  await ready(h);
  await start(h);
  await h.page.record();
  await tick();
  const local = h.page.data.localClips[0],
    remote = {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      projectId,
      interviewId,
      actualQuestionId: question.id,
      clientClipId: local.clientClipId,
      bytes: local.bytes,
      sha256: local.sha256,
      state: "pending",
      storage: "oss",
      asset: null,
    };
  const uploading = h.page.upload({
    currentTarget: { dataset: { id: local.clientClipId } },
  });
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
  assert.equal(h.uploads.length, 1);
  assert.equal(
    h.uploads[0].url,
    "https://synthetic-t14.oss-cn-hangzhou.aliyuncs.com",
  );
  assert.equal(h.uploads[0].header, undefined);
  assert.equal(h.page.data.localClips[0].sealed, undefined);
  respond(
    h.requests.shift(),
    {
      ...remote,
      state: "sealed",
      asset: {
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        sha256: remote.sha256,
      },
    },
    201,
  );
  await uploading;
  assert.equal(h.page.data.localClips[0].sealed, true);
  assert.equal(h.files.size, 1);
  h.page.onUnload();
});

test("session expiry during recording authorization clears private content even after SessionClient removes the login", async (t) => {
  const h = harness();
  t.after(() => h.page.onUnload());
  await ready(h);
  h.page.customText({ detail: { value: "私人草稿" } });
  const starting = h.page.record();
  respond(h.requests.shift(), undefined, 401);
  await starting;
  assert.equal(h.starts, 0);
  assert.equal(h.page.data.interview, null);
  assert.equal(h.page.data.question, "");
  assert.equal(h.page.data.customText, "");
  assert.equal(h.storage.has(`timenook.session.v1:${base}`), false);
});

test("a pending recording keeps its opening question when the same interview displays a later question", async (t) => {
  const h = harness({ deferSaves: true });
  t.after(() => h.page.onUnload());
  await ready(h);
  const starting = h.page.record();
  const permission = h.requests.shift();
  assert.equal(permission.data.actualQuestionId, question.id);
  assert.equal(permission.data.expectedQuestionVersion, 1);
  respond(
    permission,
    { allowed: true, actualQuestionId: question.id, questionVersion: 1 },
    201,
  );
  await starting;
  h.page.onHide();
  const laterQuestion = {
    ...question,
    id: "88888888-8888-4888-8888-888888888888",
    snapshot: { text: "那时还有什么想留下？", intent: "本人补充" },
  };
  const returning = h.page.onShow();
  respond(h.requests.shift(), {
    ...context,
    interviews: [
      { ...interview, currentQuestion: laterQuestion, questionVersion: 2 },
    ],
  });
  await returning;
  assert.equal(h.page.data.question, laterQuestion.snapshot.text);
  h.pendingSaves[0].finish();
  await tick();
  assert.equal(h.page.data.localClips[0].actualQuestionId, question.id);
  const next = h.page.record();
  const nextPermission = h.requests.shift();
  assert.equal(nextPermission.data.actualQuestionId, laterQuestion.id);
  respond(
    nextPermission,
    { allowed: true, actualQuestionId: laterQuestion.id, questionVersion: 2 },
    201,
  );
  await next;
  await h.page.record();
  h.pendingSaves[1].finish();
  await tick();
  assert.deepEqual(
    Array.from(h.page.data.localClips, (clip: any) => clip.actualQuestionId),
    [question.id, laterQuestion.id],
  );
  assert.equal(h.saves, 2);
});

test("uploading an older saved answer sends its original question and refuses a response for the current question", async (t) => {
  const h = harness();
  t.after(() => h.page.onUnload());
  await ready(h);
  await start(h);
  await h.page.record();
  await tick();
  const saved = h.page.data.localClips[0];
  const laterQuestion = {
    ...question,
    id: "88888888-8888-4888-8888-888888888888",
    snapshot: { text: "后来您还做了什么？", intent: "本人补充" },
  };
  h.page.onHide();
  const returning = h.page.onShow();
  respond(h.requests.shift(), {
    ...context,
    interviews: [
      { ...interview, currentQuestion: laterQuestion, questionVersion: 2 },
    ],
  });
  await returning;
  const uploading = h.page.upload({
    currentTarget: { dataset: { id: saved.clientClipId } },
  });
  const intent = h.requests.shift();
  assert.equal(intent.data.actualQuestionId, question.id);
  respond(
    intent,
    {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      projectId,
      interviewId,
      actualQuestionId: laterQuestion.id,
      clientClipId: saved.clientClipId,
      bytes: saved.bytes,
      sha256: saved.sha256,
      state: "pending",
      storage: "local-simulator",
      asset: null,
    },
    201,
  );
  await uploading;
  assert.equal(h.page.data.localClips[0].actualQuestionId, question.id);
  assert.equal(h.page.data.localClips[0].serverId, undefined);
  assert.equal(h.page.data.localClips[0].sealed, undefined);
  assert.equal(h.uploads.length, 0);
  assert.equal(h.files.size, 1);
});

test("an old local manifest without a question restores only the immutable interview starting question", async (t) => {
  const h = harness();
  t.after(() => h.page.onUnload());
  await ready(h);
  await start(h);
  await h.page.record();
  await tick();
  const saved = h.page.data.localClips[0];
  const manifestKey = [...h.storage.keys()].find((key) =>
    key.endsWith(interviewId),
  )!;
  h.storage.set(manifestKey, [{ ...saved, actualQuestionId: undefined }]);
  h.page.onHide();
  const laterQuestion = {
    ...question,
    id: "88888888-8888-4888-8888-888888888888",
    snapshot: { text: "后来您还做了什么？", intent: "本人补充" },
  };
  const returning = h.page.onShow();
  respond(h.requests.shift(), {
    ...context,
    interviews: [
      { ...interview, currentQuestion: laterQuestion, questionVersion: 2 },
    ],
  });
  await returning;
  assert.equal(h.page.data.question, laterQuestion.snapshot.text);
  assert.equal(h.page.data.localClips[0].actualQuestionId, question.id);
  const uploading = h.page.upload({
    currentTarget: { dataset: { id: saved.clientClipId } },
  });
  const intent = h.requests.shift();
  assert.equal(intent.data.actualQuestionId, question.id);
  respond(intent, {}, 403);
  await uploading;
  assert.equal(h.files.size, 1);
  assert.equal(h.saves, 1);
});

test("an old pending upload recovers its question from its verified server intent before sealing", async (t) => {
  const h = harness();
  t.after(() => h.page.onUnload());
  await ready(h);
  await start(h);
  await h.page.record();
  await tick();
  const saved = h.page.data.localClips[0],
    serverId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const manifestKey = [...h.storage.keys()].find((key) =>
    key.endsWith(interviewId),
  )!;
  h.storage.set(manifestKey, [
    { ...saved, actualQuestionId: undefined, serverId },
  ]);
  h.page.onHide();
  const returning = h.page.onShow();
  respond(h.requests.shift(), {
    ...context,
    interviews: [
      {
        ...interview,
        currentQuestion: {
          ...question,
          id: "88888888-8888-4888-8888-888888888888",
        },
        questionVersion: 2,
      },
    ],
  });
  await returning;
  const uploading = h.page.upload({
    currentTarget: { dataset: { id: saved.clientClipId } },
  });
  const status = h.requests.shift();
  assert.equal(
    status?.url,
    `${base}/projects/${projectId}/interviews/${interviewId}/clips/${serverId}/status`,
  );
  const remote = {
    id: serverId,
    projectId,
    interviewId,
    actualQuestionId: question.id,
    clientClipId: saved.clientClipId,
    bytes: saved.bytes,
    sha256: saved.sha256,
    state: "pending",
    storage: "local-simulator",
    asset: null,
  };
  respond(status, remote, 201);
  await tick();
  respond(
    h.requests.shift(),
    {
      url: "/v1/recordings/objects",
      storage: "local-simulator",
      fields: {},
      expiresAt: "2099-01-01T00:00:00Z",
    },
    201,
  );
  await tick();
  respond(
    h.requests.shift(),
    {
      ...remote,
      state: "sealed",
      asset: {
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        sha256: saved.sha256,
      },
    },
    201,
  );
  await uploading;
  assert.equal(h.page.data.localClips[0].actualQuestionId, question.id);
  assert.equal(h.page.data.localClips[0].sealed, true);
  assert.equal(h.saves, 1);
  assert.equal(h.files.size, 1);
});

test("an ambiguous old local answer remains on the device without being assigned to the current question", async (t) => {
  const h = harness();
  t.after(() => h.page.onUnload());
  await ready(h);
  await start(h);
  await h.page.record();
  await tick();
  const saved = h.page.data.localClips[0];
  const manifestKey = [...h.storage.keys()].find((key) =>
    key.endsWith(interviewId),
  )!;
  h.storage.set(manifestKey, [
    {
      ...saved,
      actualQuestionId: undefined,
      serverId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    },
  ]);
  h.page.onHide();
  const returning = h.page.onShow();
  respond(h.requests.shift(), {
    ...context,
    interviews: [
      {
        ...interview,
        currentQuestion: {
          ...question,
          id: "88888888-8888-4888-8888-888888888888",
        },
        questionVersion: 2,
      },
    ],
  });
  await returning;
  const uploading = h.page.upload({
    currentTarget: { dataset: { id: saved.clientClipId } },
  });
  const status = h.requests.shift();
  assert.match(status?.url, /\/status$/);
  respond(
    status,
    {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      projectId,
      interviewId,
      actualQuestionId: "88888888-8888-4888-8888-888888888888",
      clientClipId: "different-file",
      bytes: saved.bytes,
      sha256: saved.sha256,
      state: "pending",
      storage: "local-simulator",
      asset: null,
    },
    201,
  );
  await uploading;
  assert.equal(h.requests.length, 0);
  assert.equal(h.page.data.localClips[0].actualQuestionId, undefined);
  assert.equal(h.page.data.localClips[0].sealed, undefined);
  assert.equal(h.files.size, 1);
  assert.match(h.page.data.status, /未确认/);
});

test("returning during a native save retains its pending owner and retries the same saved file before another clip", async (t) => {
  const h = harness({ deferSaves: true });
  t.after(() => h.page.onUnload());
  await ready(h);
  await start(h);
  h.page.onHide();
  assert.equal(h.pendingSaves.length, 1);
  const showing = h.page.onShow();
  respond(h.requests.shift(), { ...context, interviews: [interview] });
  await showing;
  assert.equal(h.page.data.state, "saving");
  assert.equal(h.starts, 1);
  h.fail(true);
  h.pendingSaves[0].finish();
  await tick();
  assert.equal(h.page.data.state, "device-error");
  assert.equal(h.files.size, 1);
  h.page.onHide();
  const returning = h.page.onShow();
  respond(h.requests.shift(), { ...context, interviews: [interview] });
  await returning;
  assert.equal(h.page.data.state, "device-error");
  h.fail(false);
  await h.page.retry();
  assert.equal(h.saves, 1);
  assert.equal(h.page.data.localClips.length, 1);
  await start(h);
  await h.page.record();
  h.pendingSaves[1].finish();
  await tick();
  assert.equal(h.files.size, 2);
  assert.equal(h.page.data.localClips.length, 2);
  h.page.onHide();
  const restored = h.page.onShow();
  respond(h.requests.shift(), { ...context, interviews: [interview] });
  await restored;
  assert.equal(h.page.data.localClips.length, 2);
  assert.equal(h.starts, 2);
});

test("a delayed seal completion merges its clip state without removing a later saved recording after re-entry", async (t) => {
  const h = harness();
  t.after(() => h.page.onUnload());
  await ready(h);
  await start(h);
  await h.page.record();
  await tick();
  const first = h.page.data.localClips[0],
    remote = {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      projectId,
      interviewId,
      actualQuestionId: question.id,
      clientClipId: first.clientClipId,
      bytes: first.bytes,
      sha256: first.sha256,
      state: "pending",
      storage: "local-simulator",
      asset: null,
    };
  const uploading = h.page.upload({
    currentTarget: { dataset: { id: first.clientClipId } },
  });
  respond(h.requests.shift(), remote, 201);
  await tick();
  respond(
    h.requests.shift(),
    {
      url: "/v1/recordings/objects",
      storage: "local-simulator",
      expiresAt: "2099-01-01T00:00:00Z",
      fields: {},
    },
    201,
  );
  await tick();
  const delayed = h.requests.shift();
  assert.match(delayed.url, /seal$/);
  h.page.onHide();
  const returning = h.page.onShow();
  respond(h.requests.shift(), { ...context, interviews: [interview] });
  await returning;
  await start(h);
  await h.page.record();
  await tick();
  assert.equal(h.page.data.localClips.length, 2);
  assert.equal(h.files.size, 2);
  const second = h.page.data.localClips.find(
    (c: any) => c.clientClipId !== first.clientClipId,
  );
  respond(
    delayed,
    {
      ...remote,
      state: "sealed",
      asset: {
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        sha256: first.sha256,
      },
    },
    201,
  );
  await uploading;
  const manifest = [...h.storage.entries()].find(
    ([key, value]) => key.endsWith(interviewId) && Array.isArray(value),
  )![1] as any[];
  assert.equal(manifest.length, 2);
  assert.equal(
    manifest.find((c) => c.clientClipId === first.clientClipId).sealed,
    true,
  );
  assert.equal(
    manifest.find((c) => c.clientClipId === second.clientClipId).sealed,
    undefined,
  );
  h.page.onHide();
  const showing = h.page.onShow();
  respond(h.requests.shift(), { ...context, interviews: [interview] });
  await showing;
  assert.equal(h.page.data.localClips.length, 2);
  assert.equal(h.files.size, 2);
});

test("the interview page restores transcription state, stops polling in background and refreshes immediately on return", async () => {
  const h = harness();
  h.page.onLoad({ projectId });
  const restored = {
    ...interview,
    clips: [
      {
        id: "77777777-7777-4777-8777-777777777777",
        clientClipId: "88888888-8888-4888-8888-888888888888",
        state: "sealed",
      },
    ],
  };
  const showing = h.page.onShow();
  respond(h.requests.shift(), { ...context, interviews: [restored] });
  await showing;
  await tick();
  const status = h.requests.shift();
  assert.equal(status?.url, `${base}/projects/${projectId}/tasks/status`);
  respond(
    status,
    [
      {
        id: "99999999-9999-4999-8999-999999999999",
        projectId,
        state: "waiting_provider",
        retryable: false,
        nextAction: "leave_and_return",
      },
    ],
    201,
  );
  await tick();
  assert.match(h.page.data.taskRows[0].label, /转写中.*离开/);
  assert.ok(h.page.taskPollHandle);
  h.page.onHide();
  assert.equal(h.page.taskPollHandle, undefined);
  assert.equal(h.page.data.taskRows.length, 0);
  const returning = h.page.onShow();
  respond(h.requests.shift(), { ...context, interviews: [restored] });
  await returning;
  await tick();
  const refresh = h.requests.shift();
  assert.equal(refresh?.url, `${base}/projects/${projectId}/tasks/status`);
  respond(
    refresh,
    [
      {
        id: "99999999-9999-4999-8999-999999999999",
        projectId,
        state: "no_speech",
        retryable: false,
        nextAction: "record_again",
      },
    ],
    201,
  );
  await tick();
  assert.match(h.page.data.taskRows[0].label, /无有效语音.*补录/);
  assert.equal(h.page.taskPollHandle, undefined);
  h.page.onUnload();
});

const taskId = "99999999-9999-4999-8999-999999999999";
async function restoredTaskPage() {
  const h = harness();
  await ready(h);
  await start(h);
  await h.page.record();
  await tick();
  h.page.onHide();
  const showing = h.page.onShow();
  respond(h.requests.shift(), {
    ...context,
    interviews: [
      {
        ...interview,
        clips: [
          { id: "77777777-7777-4777-8777-777777777777", state: "sealed" },
        ],
      },
    ],
  });
  await showing;
  await tick();
  respond(
    h.requests.shift(),
    [
      {
        id: taskId,
        projectId,
        state: "failed",
        retryable: true,
        nextAction: "retry",
      },
    ],
    201,
  );
  await tick();
  h.page.customText({ detail: { value: "私人采访草稿" } });
  return h;
}

test("current task-status 401 clears private interview content and stops polling while keeping the only pending recording", async (t) => {
  const h = await restoredTaskPage();
  t.after(() => h.page.onUnload());
  const querying = h.page.refreshTasks();
  respond(h.requests.shift(), undefined, 401);
  await querying;
  assert.equal(h.storage.has(`timenook.session.v1:${base}`), false);
  assert.equal(h.page.data.taskRows.length, 0);
  assert.equal(h.page.data.question, "");
  assert.equal(h.page.data.interview, null);
  assert.equal(h.page.data.customText, "");
  assert.equal(h.page.data.canRecord, false);
  assert.equal(h.page.data.busy, false);
  assert.equal(h.page.taskPollHandle, undefined);
  assert.equal(h.files.size, 1);
  assert.ok(
    [...h.storage.values()].some(
      (value) =>
        Array.isArray(value) &&
        value.some((clip) => clip.path === "saved-audio-1"),
    ),
  );
});

test("current transcription-retry 401 clears private interview content and releases busy without deleting the pending recording", async (t) => {
  const h = await restoredTaskPage();
  t.after(() => h.page.onUnload());
  const retrying = h.page.retryTranscription({
    currentTarget: { dataset: { id: taskId } },
  });
  respond(h.requests.shift(), undefined, 401);
  await retrying;
  assert.equal(h.page.data.busy, false);
  assert.equal(h.page.data.taskRows.length, 0);
  assert.equal(h.page.data.interview, null);
  assert.equal(h.page.data.question, "");
  assert.equal(h.page.data.customText, "");
  assert.equal(h.page.data.canRecord, false);
  assert.equal(h.files.size, 1);
  assert.equal(h.storage.has(`timenook.session.v1:${base}`), false);
});

test("a current-session 401 still clears private task content when a newer status query is already pending", async (t) => {
  const h = await restoredTaskPage();
  t.after(() => h.page.onUnload());
  const earlier = h.page.refreshTasks(),
    first = h.requests.shift(),
    latest = h.page.refreshTasks(),
    second = h.requests.shift();
  respond(first, undefined, 401);
  await earlier;
  respond(
    second,
    [
      {
        id: taskId,
        projectId,
        state: "succeeded",
        retryable: false,
        nextAction: "continue",
      },
    ],
    201,
  );
  await latest;
  assert.equal(h.page.data.taskRows.length, 0);
  assert.equal(h.page.data.interview, null);
  assert.equal(h.page.data.question, "");
  assert.equal(h.page.data.customText, "");
  assert.equal(h.page.data.busy, false);
  assert.equal(h.files.size, 1);
});

for (const action of ["status", "retry"]) {
  test(`an old task ${action} 401 cannot clear the new account's interview, task state or draft`, async (t) => {
    const h = await restoredTaskPage();
    t.after(() => h.page.onUnload());
    const old =
        action === "status"
          ? h.page.refreshTasks()
          : h.page.retryTranscription({
              currentTarget: { dataset: { id: taskId } },
            }),
      held = h.requests.shift();
    h.page.onHide();
    const nextProject = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      other = {
        user: { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
        session: {
          ...login.session,
          id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          token: "c".repeat(43),
        },
      };
    h.storage.set(`timenook.session.v1:${base}`, other);
    h.page.onLoad({ projectId: nextProject });
    const showing = h.page.onShow();
    respond(h.requests.shift(), {
      ...context,
      interviews: [
        {
          ...interview,
          projectId: nextProject,
          actualQuestion: {
            ...question,
            projectId: nextProject,
            snapshot: { text: "新账号的私人问题", intent: "具体场景" },
          },
          clips: [
            { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", state: "sealed" },
          ],
        },
      ],
    });
    await showing;
    await tick();
    respond(
      h.requests.shift(),
      [
        {
          id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          projectId: nextProject,
          state: "succeeded",
          retryable: false,
          nextAction: "continue",
        },
      ],
      201,
    );
    await tick();
    h.page.customText({ detail: { value: "新账号草稿" } });
    respond(held, undefined, 401);
    await old;
    assert.deepEqual(h.storage.get(`timenook.session.v1:${base}`), other);
    assert.equal(h.page.data.interview.projectId, nextProject);
    assert.equal(h.page.data.question, "新账号的私人问题");
    assert.equal(h.page.data.customText, "新账号草稿");
    assert.equal(h.page.data.taskRows[0].projectId, nextProject);
    assert.equal(h.page.data.taskRows[0].state, "succeeded");
    assert.equal(h.page.data.canRecord, true);
    assert.equal(h.page.data.busy, false);
    assert.equal(h.files.size, 1);
  });
}

test("the story entry preserves the selected assisted interview and blocks recording or another account without submitting generation", async () => {
  const h = harness(),
    assistedSessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  h.page.onLoad({ projectId, interviewId, assistedSessionId });
  const showing = h.page.onShow();
  respond(h.requests.shift(), context, 201);
  await tick();
  respond(h.requests.shift(), interview, 201);
  await showing;
  h.page.openStory();
  assert.equal(
    h.navigation[0].url,
    `/pages/story/index?projectId=${projectId}&interviewId=${interviewId}&assistedSessionId=${assistedSessionId}`,
  );
  await start(h);
  h.page.openStory();
  assert.equal(
    h.navigation.length,
    1,
    "active recording cannot navigate away through the story entry",
  );
  await h.page.record();
  await tick();
  assert.equal(h.page.data.localClips[0].sealed, undefined);
  h.page.openStory();
  assert.equal(
    h.navigation.length,
    2,
    "a saved local file may enter the story save-recovery view",
  );
  const other = structuredClone(login);
  other.user.id = "99999999-9999-4999-8999-999999999999";
  other.session.id = "88888888-8888-4888-8888-888888888888";
  other.session.token = "b".repeat(43);
  h.storage.set(`timenook.session.v1:${base}`, other);
  h.page.openStory();
  assert.equal(
    h.navigation.length,
    2,
    "old interview data cannot navigate for the new account",
  );
  assert.equal(h.requests.length, 0);
  assert.equal(h.uploads.length, 0);
  h.page.onUnload();
});

test("optional follow-up waits without blocking recording and saves the actual snapshot before displaying a model question", async () => {
  const h = harness();
  await ready(h);
  const taskId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const requesting = h.page.requestFollowup();
  assert.equal(
    h.requests[0].url,
    `${base}/projects/${projectId}/interviews/${interviewId}/follow-up`,
  );
  assert.equal(h.requests[0].data.actualQuestionId, question.id);
  assert.equal(h.requests[0].data.expectedQuestionVersion, 1);
  respond(
    h.requests.shift(),
    {
      interviewId,
      actualQuestionId: question.id,
      questionVersion: 1,
      planRevision: 1,
      task: { id: taskId, state: "queued", errorCode: null },
      result: null,
      canFinish: true,
      usage: 1,
    },
    202,
  );
  await requesting;
  assert.equal(h.page.data.busy, false);
  assert.match(h.page.data.followupStatus, /等待|正在/);
  assert.equal(h.page.data.question, question.snapshot.text);
  const refreshing = h.page.refreshFollowup();
  respond(
    h.requests.shift(),
    {
      interviewId,
      actualQuestionId: question.id,
      questionVersion: 1,
      planRevision: 1,
      task: { id: taskId, state: "succeeded", errorCode: null },
      result: {
        action: "ask",
        question: "那一年您最记得哪个场景？",
        intent: "scene",
        sourceRefs: [],
        reasonCode: "SCENE_AVAILABLE",
      },
      canFinish: true,
      usage: 1,
    },
    201,
  );
  await tick();
  assert.equal(
    h.requests[0].url,
    `${base}/projects/${projectId}/interviews/${interviewId}/actual-question`,
  );
  assert.equal(h.requests[0].data.followupTaskId, taskId);
  assert.equal(
    h.page.data.question,
    question.snapshot.text,
    "an uncommitted suggestion must never become the recording question",
  );
  const currentQuestion = {
    ...question,
    id: taskId,
    source: { kind: "follow-up", generationTaskId: taskId },
    snapshot: { text: "那一年您最记得哪个场景？", intent: "scene" },
  };
  respond(
    h.requests.shift(),
    { ...interview, currentQuestion, questionVersion: 2 },
    201,
  );
  await refreshing;
  assert.equal(h.page.data.question, currentQuestion.snapshot.text);
  await start(h);
  await h.page.record();
  await tick();
  assert.equal(h.page.data.localClips[0].actualQuestionId, taskId);
  h.page.onUnload();
});

test("a displayed follow-up can be rewritten and skipped while pending audio keeps its original question and a hidden page ignores late status", async () => {
  const h = harness(),
    taskId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const displayed = {
    ...question,
    id: taskId,
    source: { kind: "follow-up", generationTaskId: taskId },
    snapshot: { text: "那一年您最记得哪个场景？", intent: "scene" },
  };
  h.page.onLoad({ projectId });
  const showing = h.page.onShow();
  respond(h.requests.shift(), {
    ...context,
    interviews: [
      { ...interview, currentQuestion: displayed, questionVersion: 2 },
    ],
  });
  await showing;
  await start(h);
  await h.page.record();
  await tick();
  assert.equal(h.page.data.localClips[0].actualQuestionId, taskId);
  h.page.followupText({ detail: { value: "那一年您最记得哪件事？" } });
  const rewrite = h.page.rewriteFollowup();
  assert.equal(h.requests[0].data.followupTaskId, taskId);
  assert.equal(h.requests[0].data.expectedActualQuestionId, taskId);
  const edited = {
    ...displayed,
    id: h.requests[0].data.clientQuestionId,
    snapshot: { text: "那一年您最记得哪件事？", intent: "scene" },
  };
  respond(
    h.requests.shift(),
    { ...interview, currentQuestion: edited, questionVersion: 3 },
    201,
  );
  await rewrite;
  assert.equal(h.page.data.question, edited.snapshot.text);
  assert.equal(
    h.page.data.localClips[0].actualQuestionId,
    taskId,
    "pending audio cannot be relabelled after rewriting",
  );
  const skip = h.page.skipFollowup();
  assert.equal(
    h.requests[0].url,
    `${base}/projects/${projectId}/interviews/${interviewId}/follow-up/finish`,
  );
  respond(
    h.requests.shift(),
    {
      interviewId,
      task: null,
      result: null,
      canFinish: true,
      finishReason: "USER_FINISHED",
      usage: 1,
    },
    201,
  );
  await skip;
  assert.match(h.page.data.followupStatus, /跳过/);
  const query = h.page.refreshFollowup(),
    request = h.requests.shift();
  h.page.onHide();
  respond(
    request,
    {
      interviewId,
      task: { id: taskId, state: "succeeded" },
      result: { action: "ask", question: "迟到的问题？" },
    },
    201,
  );
  await query;
  assert.equal(h.requests.length, 0);
  assert.equal(h.page.data.question, "");
  assert.equal(h.page.data.followup, null);
  assert.equal(h.files.size, 1);
  h.page.onUnload();
});

test("a follow-up request crossing exact local expiry clears the private page and preserves pending audio", async () => {
  const h = harness();
  await ready(h);
  await start(h);
  await h.page.record();
  await tick();
  const manifest = [...h.storage.entries()].find(([key]) =>
    key.includes("recording"),
  );
  assert.ok(manifest);
  const original = structuredClone(manifest);
  const request = h.page.requestFollowup();
  const held = h.requests.shift();
  assert.equal(h.page.data.busy, true);
  h.expireSession();
  respond(
    held,
    { interviewId, task: null, result: null, canFinish: true, usage: 0 },
    202,
  );
  await request;
  assert.equal(h.page.data.busy, false);
  assert.equal(h.page.data.question, "");
  assert.equal(h.page.data.interview, null);
  assert.equal(h.page.data.followup, null);
  assert.equal(h.page.data.followupText, "");
  assert.equal(h.page.stopSessionWatch, undefined);
  assert.equal(h.page.followupPoll, undefined);
  assert.deepEqual(
    [...h.storage.entries()].find(([key]) => key.includes("recording")),
    original,
  );
  assert.equal(h.files.size, 1);
  h.page.onUnload();
});

for (const action of [
  "retry",
  "rewrite",
  "skip",
  "refresh",
  "display",
] as const) {
  test(`a follow-up ${action} crossing exact local expiry clears its owned private page without deleting original audio`, async () => {
    const h = harness(),
      taskId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const displayed = {
      ...question,
      id: taskId,
      source: { kind: "follow-up", generationTaskId: taskId },
      snapshot: { text: "那一年您最记得哪个场景？", intent: "scene" },
    };
    h.page.onLoad({ projectId });
    const showing = h.page.onShow();
    respond(h.requests.shift(), {
      ...context,
      interviews: [
        { ...interview, currentQuestion: displayed, questionVersion: 2 },
      ],
    });
    await showing;
    await start(h);
    await h.page.record();
    await tick();
    const manifest = [...h.storage.entries()].find(([key]) =>
      key.includes("recording"),
    );
    assert.ok(manifest);
    const original = structuredClone(manifest);
    const view = {
      interviewId,
      actualQuestionId: displayed.id,
      questionVersion: 2,
      planRevision: 1,
      task: { id: taskId, state: "failed", errorCode: "PROVIDER_FAILED" },
      result: null,
      canFinish: true,
      usage: 1,
    };
    if (action === "retry") {
      const querying = h.page.refreshFollowup();
      respond(h.requests.shift(), view, 201);
      await querying;
    }
    h.page.followupText({ detail: { value: "那一年您最记得哪件事？" } });
    const pending =
      action === "retry"
        ? h.page.retryFollowup()
        : action === "rewrite"
          ? h.page.rewriteFollowup()
          : action === "skip"
            ? h.page.skipFollowup()
            : h.page.refreshFollowup();
    let held = h.requests.shift();
    if (action === "display") {
      respond(
        held,
        {
          ...view,
          task: { id: taskId, state: "succeeded" },
          result: { action: "ask", question: "下一个场景？" },
        },
        201,
      );
      await tick();
      held = h.requests.shift();
      assert.match(held.url, /actual-question$/);
    }
    h.expireSession();
    respond(
      held,
      action === "rewrite" || action === "display"
        ? { ...interview, currentQuestion: displayed, questionVersion: 3 }
        : view,
      201,
    );
    await pending;
    assert.equal(h.page.data.busy, false);
    assert.equal(h.page.data.question, "");
    assert.equal(h.page.data.interview, null);
    assert.equal(h.page.data.followup, null);
    assert.equal(h.page.data.followupText, "");
    assert.equal(h.page.stopSessionWatch, undefined);
    assert.equal(h.page.followupPoll, undefined);
    assert.equal(h.page.timerHandle, undefined);
    assert.deepEqual(
      [...h.storage.entries()].find(([key]) => key.includes("recording")),
      original,
    );
    assert.equal(h.files.size, 1);
    h.page.onUnload();
  });
}

for (const outcome of ["success", "network failure"] as const)
  test(`an old follow-up ${outcome} cannot clear a newer expired account's page or its draft after a project switch`, async () => {
    const h = harness();
    await ready(h);
    const pending = h.page.requestFollowup(),
      held = h.requests.shift();
    h.page.onHide();
    const other = structuredClone(login),
      nextProject = "99999999-9999-4999-8999-999999999999";
    other.user.id = "88888888-8888-4888-8888-888888888888";
    other.session.id = "77777777-7777-4777-8777-777777777777";
    other.session.token = "c".repeat(43);
    h.storage.set(`timenook.session.v1:${base}`, other);
    h.page.onLoad({ projectId: nextProject });
    const showing = h.page.onShow();
    respond(h.requests.shift(), {
      ...context,
      interviews: [
        {
          ...interview,
          projectId: nextProject,
          actualQuestion: {
            ...question,
            projectId: nextProject,
            snapshot: { text: "新账号的私人问题", intent: "具体场景" },
          },
        },
      ],
    });
    await showing;
    h.page.customText({ detail: { value: "新账号草稿" } });
    h.expireSession();
    if (outcome === "network failure")
      held.fail({ errMsg: "request:fail timeout" });
    else
      respond(
        held,
        { interviewId, task: null, result: null, canFinish: true, usage: 0 },
        202,
      );
    await pending;
    assert.deepEqual(h.storage.get(`timenook.session.v1:${base}`), other);
    assert.equal(h.page.data.question, "新账号的私人问题");
    assert.equal(h.page.data.interview.projectId, nextProject);
    assert.equal(h.page.data.customText, "新账号草稿");
    assert.equal(h.page.data.busy, false);
    assert.equal(typeof h.page.stopSessionWatch, "function");
    h.page.onUnload();
  });

test("an owned follow-up network timeout at its captured exact expiry clears private state while preserving pending audio", async () => {
  const h = harness();
  await ready(h);
  await start(h);
  await h.page.record();
  await tick();
  const original = structuredClone(
    [...h.storage.entries()].find(([key]) => key.includes("recording")),
  );
  assert.ok(original);
  const key = `timenook.session.v1:${base}`,
    identity = structuredClone(h.storage.get(key)) as typeof login;
  const pending = h.page.requestFollowup(),
    held = h.requests.shift();
  assert.equal(held.header.authorization, `Bearer ${identity.session.token}`);
  h.expireSession();
  assert.deepEqual(
    h.storage.get(key),
    identity,
    "only the device clock advanced before the network completed",
  );
  held.fail({ errMsg: "request:fail timeout" });
  await pending;
  assert.equal(h.page.data.busy, false);
  assert.equal(h.page.data.question, "");
  assert.equal(h.page.data.interview, null);
  assert.equal(h.page.data.followup, null);
  assert.equal(h.page.data.followupText, "");
  assert.equal(h.page.stopSessionWatch, undefined);
  assert.equal(h.page.followupPoll, undefined);
  assert.equal(h.storage.has(key), false);
  assert.deepEqual(
    [...h.storage.entries()].find(([key]) => key.includes("recording")),
    original,
  );
  assert.equal(h.files.size, 1);
  h.page.onUnload();
});

test("a follow-up network failure in a valid session retains the private question and original request for recovery", async () => {
  const h = harness();
  await ready(h);
  const pending = h.page.requestFollowup(),
    held = h.requests.shift(),
    identity = structuredClone(h.storage.get(`timenook.session.v1:${base}`));
  held.fail({ errMsg: "request:fail timeout" });
  await pending;
  assert.equal(h.page.data.busy, false);
  assert.equal(h.page.data.question, question.snapshot.text);
  assert.equal(h.page.data.interview.id, interviewId);
  assert.equal(h.page.data.canRecord, true);
  assert.equal(typeof h.page.stopSessionWatch, "function");
  assert.deepEqual(h.storage.get(`timenook.session.v1:${base}`), identity);
  const recovering = h.page.requestFollowup(),
    retried = h.requests.shift();
  assert.ok(held.header["Idempotency-Key"]);
  assert.equal(
    retried.header["Idempotency-Key"],
    held.header["Idempotency-Key"],
  );
  assert.equal(retried.data.clientRequestId, held.data.clientRequestId);
  respond(
    retried,
    { interviewId, task: null, result: null, canFinish: true, usage: 0 },
    202,
  );
  await recovering;
  assert.equal(h.page.data.busy, false);
  h.page.onUnload();
});
