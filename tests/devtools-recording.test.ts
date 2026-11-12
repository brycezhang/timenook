import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";

const compiled = await build({
  entryPoints: ["miniprogram/services/local-audio-recorder.ts"],
  bundle: true,
  write: false,
  format: "cjs",
  platform: "neutral",
});

function harness(platform = "devtools", webm = true) {
  const source = webm
    ? new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0])
    : new Uint8Array([0xff, 0xf3, 0x68, 0xc4]);
  const files = new Map<string, Uint8Array>([["temp.mp3", source]]);
  const storage = new Map<string, unknown>();
  const handlers: Record<string, (value?: any) => void> = {};
  let failDecode = false,
    decodes = 0,
    closed = 0;
  const module = { exports: {} as any };
  const context = {
    module,
    exports: module.exports,
    setTimeout,
    clearTimeout,
    wx: {
      env: { USER_DATA_PATH: "/private" },
      getDeviceInfo: () => ({ platform }),
      getStorageSync: (key: string) => storage.get(key),
      setStorageSync: (key: string, value: unknown) => storage.set(key, value),
      getRecorderManager: () => ({
        onStart: (fn: any) => (handlers.start = fn),
        onStop: (fn: any) => (handlers.stop = fn),
        onError() {},
        onInterruptionBegin() {},
        start: () => handlers.start(),
        stop: () => handlers.stop({ tempFilePath: "temp.mp3", duration: 1000 }),
      }),
      createWebAudioContext: () => ({
        decodeAudioData(_data: ArrayBuffer, success: any, fail: any) {
          decodes++;
          if (failDecode) return fail(Error("decode failed"));
          success({
            sampleRate: 48000,
            numberOfChannels: 1,
            length: 48000,
            getChannelData: () =>
              Float32Array.from(
                { length: 48000 },
                (_, i) => Math.sin((i * Math.PI * 880) / 48000) * 0.3,
              ),
          });
        },
        close() {
          closed++;
        },
      }),
      getFileSystemManager: () => ({
        readFile: (o: any) =>
          o.success({ data: files.get(o.filePath)!.slice().buffer }),
        writeFile: (o: any) => {
          files.set(o.filePath, new Uint8Array(o.data));
          o.success({});
        },
        saveFile: (o: any) => {
          files.set("saved.mp3", files.get(o.tempFilePath)!);
          files.delete(o.tempFilePath);
          o.success({ savedFilePath: "saved.mp3" });
        },
        getFileInfo: (o: any) =>
          o.success({
            size: files.get(o.filePath)!.length,
            digest: "b".repeat(64),
          }),
      }),
    },
  };
  runInNewContext(compiled.outputFiles[0].text, context);
  const recorder = new module.exports.LocalAudioRecorder("recording-test");
  return {
    recorder,
    files,
    source,
    setFailDecode: (value: boolean) => {
      failDecode = value;
    },
    counts: () => ({ decodes, closed }),
  };
}
async function stop(h: ReturnType<typeof harness>) {
  h.recorder.start();
  h.recorder.stop();
  for (let i = 0; i < 200 && h.recorder.snapshot().stage === "saving"; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  return h.recorder.snapshot();
}

test("devtools WebM named .mp3 is saved as the mono 16kHz MP3 accepted by sealing", async () => {
  const h = harness();
  const snapshot = await stop(h);
  assert.equal(snapshot.stage, "local");
  const bytes = h.files.get(snapshot.clips[0].path)!;
  assert.equal(bytes[0], 0xff, "saved recording must contain MP3, not WebM");
  // MPEG-2 Layer III, 48kbps, 16kHz, mono; catches the mislabeled WebM output.
  assert.deepEqual(Array.from(bytes.slice(0, 4)), [0xff, 0xf3, 0x68, 0xc4]);
  assert.ok(snapshot.clips[0].durationMs >= 1000);
  assert.ok(snapshot.clips[0].durationMs <= 1108);
  assert.equal(snapshot.clips[0].bytes, bytes.length);
  assert.equal(h.counts().closed, 1);
});

test("decode failure keeps the recording pending so saving can be retried", async () => {
  const h = harness();
  h.setFailDecode(true);
  const failed = await stop(h);
  assert.equal(failed.stage, "device-error");
  assert.equal(failed.hasPendingSave, true);
  assert.equal(failed.clips.length, 0);
  assert.ok(h.files.has("temp.mp3"));
  h.recorder.resetDeviceError();
  assert.equal(h.recorder.snapshot().stage, "device-error");
  assert.equal(h.recorder.snapshot().hasPendingSave, true);
  h.setFailDecode(false);
  await h.recorder.retrySave();
  assert.equal(h.recorder.snapshot().stage, "local");
  assert.equal(h.counts().closed, 2);
});

for (const [platform, webm] of [
  ["ios", false],
  ["devtools", false],
] as const)
  test(`${platform} genuine MP3 keeps its original bytes`, async () => {
    const h = harness(platform, webm);
    const snapshot = await stop(h);
    assert.deepEqual(h.files.get(snapshot.clips[0].path), h.source);
    assert.equal(h.counts().decodes, 0);
  });
