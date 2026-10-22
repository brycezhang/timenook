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
function harness(
  release = false,
  network?: { request(o: any): void; uploadFile(o: any): void },
) {
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
          const savedFilePath = `saved-page-${files.size + 1}`;
          files.add(savedFilePath);
          o.success({ savedFilePath });
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
        if (network) network.request(o);
        else o.fail({});
      },
      uploadFile: (o: any) => network?.uploadFile(o),
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
async function connect(page: any) {
  page.onLoad();
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
}
test("actual probe page connects a private identity, recovers permission denial, saves on hide and wires upload", async () => {
  const { page, requests, allow } = harness();
  await connect(page);
  assert.equal(page.data.enabled, true);
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
test("recording on the actual page blocks uploading an older clip and still saves the new clip on hide", async () => {
  const { page, requests, allow } = harness();
  await connect(page);
  allow();
  page.start();
  page.stop();
  await new Promise((resolve) => setImmediate(resolve));
  const previousClip = page.data.clips[0];

  page.start();
  await page.upload({
    currentTarget: { dataset: { id: previousClip.clientClipId } },
  });
  page.onHide();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(page.data.stage, "local");
  assert.equal(page.data.clips.length, 2);
  assert.notEqual(page.data.clips[1].path, previousClip.path);
  assert.equal(requests.length, 0);
  page.onUnload();
});
test("the actual page blocks new recording throughout upload and sealing, then permits a new saved clip", async () => {
  const pendingRequests: any[] = [];
  const { page, allow } = harness(false, {
    request: (o) => pendingRequests.push(o),
    uploadFile: (o) => o.success({ statusCode: 204 }),
  });
  await connect(page);
  allow();
  page.start();
  page.stop();
  await new Promise((resolve) => setImmediate(resolve));
  const previousClip = page.data.clips[0];
  const uploading = page.upload({
    currentTarget: { dataset: { id: previousClip.clientClipId } },
  });
  assert.equal(page.data.stage, "uploading");
  page.start();
  assert.equal(page.data.stage, "uploading");
  assert.match(page.data.message, /上传.*录音/);

  const remote = {
    id: "22222222-2222-4222-8222-222222222222",
    sha256: previousClip.sha256,
    storage: "local-simulator",
    state: "pending",
  };
  pendingRequests.shift().success({ statusCode: 201, data: { data: remote } });
  await new Promise((resolve) => setImmediate(resolve));
  pendingRequests.shift().success({
    statusCode: 201,
    data: {
      data: {
        storage: "local-simulator",
        url: "/v1/probes/audio/objects",
        fields: {},
      },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.data.stage, "sealing");
  page.start();
  assert.equal(page.data.stage, "sealing");
  page.onHide();
  pendingRequests.shift().success({
    statusCode: 201,
    data: { data: { ...remote, state: "sealed" } },
  });
  await uploading;
  assert.equal(page.data.stage, "sealed");
  assert.equal(page.data.clips.length, 1);
  assert.equal(page.data.clips[0].sealed, true);

  page.start();
  assert.equal(page.data.stage, "recording");
  page.stop();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.data.stage, "local");
  assert.equal(page.data.clips.length, 2);
  page.onUnload();
});
test("release native page refuses the build-enabled probe", () => {
  const { page } = harness(true);
  page.onLoad();
  assert.equal(page.data.enabled, false);
});
