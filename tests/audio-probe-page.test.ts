import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
const compiled = await build({
  entryPoints: ["miniprogram/pages/audio-probe/index.ts"],
  bundle: true,
  write: false,
  format: "cjs",
  platform: "neutral",
  define: {
    __TIMENOOK_API_BASE_URL__: JSON.stringify(
      "https://example.test/timenook/v1",
    ),
    __TIMENOOK_AUDIO_PROBE__: "true",
  },
});
function harness(release = false) {
  let page: any;
  const storage = new Map<string, any>();
  const files = new Set<string>();
  const handlers: Record<string, (value?: any) => void> = {};
  let allowMicrophone = false;
  const requests: string[] = [];
  runInNewContext(compiled.outputFiles[0].text, {
    setTimeout,
    clearTimeout,
    Page: (p: any) => {
      page = p;
      page.setData = (patch: any) => Object.assign(page.data, patch);
    },
    wx: {
      getAccountInfoSync: () => ({
        miniProgram: { envVersion: release ? "release" : "develop" },
      }),
      getStorageSync: (k: string) => storage.get(k),
      setStorageSync: (k: string, v: any) => storage.set(k, v),
      getRecorderManager: () => ({
        onStart: (fn: any) => (handlers.start = fn),
        onStop: (fn: any) => (handlers.stop = fn),
        onError: (fn: any) => (handlers.error = fn),
        onInterruptionBegin: (fn: any) => (handlers.interrupt = fn),
        start: () => (allowMicrophone ? handlers.start() : handlers.error()),
        stop: () =>
          handlers.stop({ tempFilePath: "native-temp", duration: 1080 }),
      }),
      getFileSystemManager: () => ({
        saveFile: (o: any) => {
          files.add("saved-page");
          o.success({ savedFilePath: "saved-page" });
        },
        getFileInfo: (o: any) =>
          o.success({ size: 6480, digest: "b".repeat(64) }),
        access: (o: any) => (files.has(o.path) ? o.success({}) : o.fail({})),
        unlink: (o: any) => {
          files.delete(o.filePath);
          o.success({});
        },
      }),
      request: (o: any) => {
        requests.push(o.url);
        o.fail({});
      },
    },
  });
  return {
    page,
    requests,
    allow() {
      allowMicrophone = true;
    },
  };
}
test("actual probe page connects a private identity, recovers permission denial, saves on hide and wires upload", async () => {
  const { page, requests, allow } = harness();
  page.onLoad();
  assert.equal(page.data.enabled, true);
  page.input({
    detail: {
      value: JSON.stringify({
        id: "11111111-1111-4111-8111-111111111111",
        token: `p2_${"a".repeat(43)}`,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      }),
    },
  });
  await page.connect();
  assert.equal(page.data.connected, true);
  assert.equal(page.data.sessionInput, "");
  page.start();
  assert.equal(page.data.stage, "device-error");
  assert.equal(page.data.hasPendingSave, false);
  allow();
  page.start();
  assert.equal(page.data.stage, "recording");
  page.onHide();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.data.stage, "local");
  assert.equal(page.data.clips.length, 1);
  await page.upload({
    currentTarget: { dataset: { id: page.data.clips[0].clientClipId } },
  });
  assert.equal(
    requests[0],
    "https://example.test/timenook/v1/probes/audio/clips",
  );
  assert.equal(page.data.stage, "upload-error");
  page.onUnload();
  assert.ok(!JSON.stringify(page.data).includes("p2_"));
});
test("release native page refuses the build-enabled probe", () => {
  const { page } = harness(true);
  page.onLoad();
  assert.equal(page.data.enabled, false);
});
