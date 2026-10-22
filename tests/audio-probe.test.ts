import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
const handlers: Record<string, ((value?: any) => void)[]> = {};
const emit = (event: string, value?: any) =>
  handlers[event]?.forEach((fn) => fn(value));
const stored = new Map<string, any>();
const files = new Set<string>();
let failSave = false,
  failMetadata = false,
  saveCount = 0;
let requestCount = 0;
const manager = {
  onStart(fn: any) {
    (handlers.start ??= []).push(fn);
  },
  onStop(fn: any) {
    (handlers.stop ??= []).push(fn);
  },
  onError(fn: any) {
    (handlers.error ??= []).push(fn);
  },
  onInterruptionBegin(fn: any) {
    (handlers.interrupt ??= []).push(fn);
  },
  start() {
    emit("start");
  },
  stop() {
    emit("stop", { tempFilePath: "temporary-recording", duration: 1080 });
  },
};
Object.assign(globalThis, {
  wx: {
    getRecorderManager: () => manager,
    getStorageSync: (key: string) => structuredClone(stored.get(key)),
    setStorageSync: (key: string, value: any) => {
      if (failMetadata) throw new Error("full");
      stored.set(key, structuredClone(value));
    },
    getFileSystemManager: () => ({
      saveFile(o: any) {
        saveCount++;
        if (failSave) o.fail({});
        else {
          const path = `saved-${saveCount}`;
          files.add(path);
          o.success({ savedFilePath: path });
        }
      },
      getFileInfo(o: any) {
        if (!files.has(o.filePath)) o.fail({});
        else o.success({ size: 6480, digest: "a".repeat(64) });
      },
      access(o: any) {
        files.has(o.path) ? o.success({}) : o.fail({});
      },
      unlink(o: any) {
        files.delete(o.filePath);
        o.success({});
      },
    }),
    request() {
      requestCount++;
    },
  },
});
const { AudioProbeClient } =
  await import("../miniprogram/services/audio-probe");
const session = () => ({
  id: randomUUID(),
  token: `p2_${"a".repeat(43)}`,
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
});
const flush = () => new Promise((resolve) => setImmediate(resolve));
test("probe promises local saving only after file and manifest succeed; retry keeps the moved file", async () => {
  const identity = session();
  const client = new AudioProbeClient(
    "https://example.com/timenook/v1",
    identity,
    true,
  );
  failMetadata = true;
  client.start();
  client.stop();
  await flush();
  assert.equal(client.snapshot().stage, "device-error");
  assert.match(client.snapshot().message, /请先别退出/);
  assert.equal(requestCount, 0);
  const saved = saveCount;
  failMetadata = false;
  await client.retrySave();
  assert.equal(saveCount, saved);
  assert.equal(client.snapshot().stage, "local");
  assert.equal(client.snapshot().clips.length, 1);
  const restored = new AudioProbeClient(
    "https://example.com/timenook/v1",
    identity,
    true,
  );
  await restored.restore();
  assert.equal(restored.snapshot().clips.length, 1);
  assert.equal(
    new AudioProbeClient(
      "https://example.com/timenook/v1",
      session(),
      true,
    ).snapshot().clips.length,
    0,
  );
});

test("upload retains the API path prefix, waits for seal, and names local simulation honestly", async () => {
  const identity = session();
  const client = new AudioProbeClient(
    "https://example.com/timenook/v1",
    identity,
    true,
  );
  client.start();
  client.stop();
  await flush();
  const clip = client.snapshot().clips[0];
  const urls: string[] = [];
  let sealReply: any;
  Object.assign(wx, {
    request(o: any) {
      requestCount++;
      urls.push(o.url);
      assert.equal(o.header.authorization, `Bearer ${identity.token}`);
      if (o.url.endsWith("/seal")) {
        sealReply = o;
        return;
      }
      const data = o.url.endsWith("/upload")
        ? {
            url: "/v1/probes/audio/objects",
            fields: {
              key: "staging/synthetic.mp3",
              policy: "policy",
              "x-probe-capability": "short-lived",
            },
            storage: "local-simulator",
          }
        : {
            id: "server-clip",
            clientClipId: clip.clientClipId,
            sha256: clip.sha256,
            bytes: clip.bytes,
            state: "pending",
            storage: "local-simulator",
          };
      o.success({ statusCode: 201, data: { data } });
    },
    uploadFile(o: any) {
      urls.push(o.url);
      assert.equal(o.filePath, clip.path);
      o.success({ statusCode: 204 });
    },
  });
  const uploading = client.upload(clip.clientClipId);
  await flush();
  assert.equal(client.snapshot().stage, "sealing");
  assert.ok(
    urls.includes("https://example.com/timenook/v1/probes/audio/objects"),
  );
  sealReply.success({
    statusCode: 201,
    data: {
      data: {
        id: "server-clip",
        clientClipId: clip.clientClipId,
        sha256: clip.sha256,
        bytes: clip.bytes,
        state: "sealed",
        storage: "local-simulator",
      },
    },
  });
  await uploading;
  assert.equal(client.snapshot().stage, "sealed");
  assert.match(client.snapshot().message, /本地模拟封存/);
  assert.doesNotMatch(client.snapshot().message, /云端已保存/);
});

test("authenticated temporary playback is discarded on hide, including a late download", async () => {
  const identity = session();
  const client = new AudioProbeClient(
    "https://example.com/timenook/v1",
    identity,
    true,
  );
  client.start();
  client.stop();
  await flush();
  const clip = client.snapshot().clips[0];
  let downloaded: any;
  const played: string[] = [];
  let stopped = 0;
  Object.assign(wx, {
    downloadFile(o: any) {
      assert.equal(o.header.authorization, `Bearer ${identity.token}`);
      downloaded = o;
      return { abort() {} };
    },
    createInnerAudioContext() {
      return {
        src: "",
        play() {
          played.push(this.src);
        },
        stop() {
          stopped++;
        },
        destroy() {},
        onEnded() {},
        onError() {},
      };
    },
  });
  // Restore a server-sealed manifest through the same external storage boundary used on restart.
  const key = [...stored.keys()].find((k) => k.endsWith(identity.id))!;
  stored.set(key, [{ ...clip, serverId: "server-clip", sealed: true }]);
  await client.restore();
  const first = client.play(clip.clientClipId);
  await flush();
  files.add("download-a");
  downloaded.success({ statusCode: 200, tempFilePath: "download-a" });
  await first;
  assert.deepEqual(played, ["download-a"]);
  await client.onHide();
  assert.ok(stopped > 0);
  assert.equal(files.has("download-a"), false);
  const late = client.play(clip.clientClipId);
  await flush();
  await client.onHide();
  files.add("download-late");
  downloaded.success({ statusCode: 200, tempFilePath: "download-late" });
  await late;
  assert.deepEqual(played, ["download-a"]);
  assert.equal(files.has("download-late"), false);
});

test("the singleton microphone never sends probe audio to a previously opened demo recorder", async () => {
  const { recorder } = await import("../miniprogram/services/recorder");
  const store = await import("../miniprogram/services/store");
  const project = store.start("妈妈");
  project.consent = true;
  store.save(project);
  let demoState = "";
  recorder.subscribe((s) => {
    demoState = s.state;
  });
  recorder.start("演示问题");
  recorder.stop();
  await flush();
  const before = store.read(project.id)!.recordings;
  const probe = new AudioProbeClient(
    "https://example.com/timenook/v1",
    session(),
    true,
  );
  probe.start();
  assert.equal(demoState, "saved");
  probe.stop();
  await flush();
  assert.deepEqual(store.read(project.id)!.recordings, before);
  const saved = probe.snapshot();
  recorder.reset();
  recorder.start("另一演示问题");
  recorder.stop();
  await flush();
  assert.deepEqual(probe.snapshot(), saved);
});

test("leaving during permission request stops a late microphone start and interrupted clips only recover saved files", async () => {
  const originalStart = manager.start;
  manager.start = () => {};
  const identity = session();
  const client = new AudioProbeClient(
    "https://example.com/timenook/v1",
    identity,
    true,
  );
  client.start();
  const originalStop = manager.stop;
  manager.stop = () => {};
  await client.onHide();
  manager.stop = originalStop;
  emit("start");
  await flush();
  assert.equal(client.snapshot().stage, "local");
  manager.start = originalStart;
  client.start();
  emit("interrupt");
  await flush();
  assert.equal(client.snapshot().clips.length, 2);
  files.delete(client.snapshot().clips[0].path);
  const restart = new AudioProbeClient(
    "https://example.com/timenook/v1",
    identity,
    true,
  );
  await restart.restore();
  assert.equal(restart.snapshot().clips.length, 1);
});

test("an OSS form keeps its absolute upload host and only a verified OSS seal uses cloud wording", async () => {
  const identity = session();
  const client = new AudioProbeClient(
    "https://example.com/timenook/v1",
    identity,
    true,
  );
  client.start();
  client.stop();
  await flush();
  const clip = client.snapshot().clips[0];
  let uploadUrl = "";
  Object.assign(wx, {
    request(o: any) {
      const data = o.url.endsWith("/upload")
        ? {
            storage: "oss",
            url: "https://timenook-test.oss-cn-hangzhou.aliyuncs.com",
            fields: { key: "staging/file.mp3", policy: "policy" },
          }
        : {
            id: "oss-clip",
            clientClipId: clip.clientClipId,
            sha256: clip.sha256,
            bytes: clip.bytes,
            state: o.url.endsWith("/seal") ? "sealed" : "pending",
            storage: "oss",
          };
      o.success({ statusCode: 201, data: { data } });
    },
    uploadFile(o: any) {
      uploadUrl = o.url;
      assert.equal(o.header, undefined);
      o.success({ statusCode: 204 });
    },
  });
  await client.upload(clip.clientClipId);
  assert.equal(uploadUrl, "https://timenook-test.oss-cn-hangzhou.aliyuncs.com");
  assert.equal(client.snapshot().stage, "sealed");
  assert.match(client.snapshot().message, /云端已保存/);
});

test("device save failure blocks replacement and network failure keeps the saved clip available", async () => {
  const client = new AudioProbeClient(
    "https://example.com/timenook/v1",
    session(),
    true,
  );
  failSave = true;
  client.start();
  client.stop();
  await flush();
  assert.equal(client.snapshot().stage, "device-error");
  client.start();
  assert.equal(client.snapshot().stage, "device-error");
  failSave = false;
  await client.retrySave();
  const clip = client.snapshot().clips[0];
  Object.assign(wx, {
    request(o: any) {
      o.fail({ errMsg: "offline" });
    },
  });
  await client.upload(clip.clientClipId);
  assert.equal(client.snapshot().stage, "upload-error");
  assert.equal(client.snapshot().clips[0].path, clip.path);
  assert.equal(files.has(clip.path), true);
});

test("failed cache cleanup prevents a new unattended download and reports the retained file", async () => {
  const identity = session();
  const client = new AudioProbeClient(
    "https://example.com/timenook/v1",
    identity,
    true,
  );
  client.start();
  client.stop();
  await flush();
  const clip = client.snapshot().clips[0];
  const key = [...stored.keys()].find((k) => k.endsWith(identity.id))!;
  stored.set(key, [{ ...clip, serverId: "server-clip", sealed: true }]);
  await client.restore();
  stored.set("timenook.probe.cache.v1", ["locked-cache"]);
  files.add("locked-cache");
  const originalFs = wx.getFileSystemManager;
  let downloads = 0;
  Object.assign(wx, {
    getFileSystemManager: () => ({
      ...originalFs(),
      unlink: (o: any) => o.fail({ errMsg: "locked" }),
    }),
    downloadFile() {
      downloads++;
      return { abort() {} };
    },
  });
  try {
    await client.play(clip.clientClipId);
    assert.equal(downloads, 0);
    assert.equal(files.has("locked-cache"), true);
    assert.match(client.snapshot().message, /清理失败/);
    assert.doesNotMatch(client.snapshot().message, /已清理/);
  } finally {
    Object.assign(wx, { getFileSystemManager: originalFs });
    await client.stopPlayback();
  }
});
