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
    pendingSaves: any[] = [];
  let page: any,
    saves = 0,
    failManifest = false,
    starts = 0;
  const emit = (event: string, v?: any) =>
    handlers[event]?.forEach((fn) => fn(v));
  runInNewContext(compiled.outputFiles[0].text, {
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
      navigateTo: () => {},
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
  respond(h.requests.shift(), { allowed: true }, 201);
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
