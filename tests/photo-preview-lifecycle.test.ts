import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";
const base = "https://example.test/api/v1";
const bundle = await build({
  entryPoints: ["miniprogram/services/story-photos.ts"],
  bundle: true,
  write: false,
  format: "cjs",
  platform: "neutral",
  define: { __TIMENOOK_API_BASE_URL__: JSON.stringify(base) },
});
function harness(stale = false) {
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
  if (stale)
    storage.set(`timenook.photo-previews.v2:${base}`, ["/tmp/already-removed"]);
  const files = new Set<string>();
  let count = 0,
    failUnlink = false;
  const module = { exports: {} as any };
  runInNewContext(bundle.outputFiles[0].text, {
    module,
    exports: module.exports,
    wx: {
      env: { USER_DATA_PATH: "/user-data" },
      getStorageSync: (k: string) => structuredClone(storage.get(k)),
      setStorageSync: (k: string, v: any) => storage.set(k, structuredClone(v)),
      removeStorageSync: (k: string) => storage.delete(k),
      downloadFile: (o: any) => {
        const p = "/tmp/preview-" + ++count;
        files.add(p);
        o.success({ statusCode: 200, tempFilePath: p });
      },
      getFileSystemManager: () => ({
        unlink: (o: any) =>
          !failUnlink && files.delete(o.filePath)
            ? o.success()
            : o.fail({
                errMsg: failUnlink
                  ? "unlink:fail permission denied"
                  : "unlink:fail no such file or directory",
              }),
        getFileInfo: (o: any) =>
          files.has(o.filePath)
            ? o.success({ size: 42, digest: "f".repeat(64) })
            : o.fail({ errMsg: "no such file" }),
      }),
    },
  });
  return {
    files,
    failCleanup(value: boolean) {
      failUnlink = value;
    },
    api: module.exports,
    preview: () =>
      module.exports.privatePhotoPreview(
        "33333333-3333-4333-8333-333333333333",
        "44444444-4444-4444-8444-444444444444",
        "55555555-5555-4555-8555-555555555555",
        {
          id: "66666666-6666-4666-8666-666666666666",
          bytes: 42,
          sha256: "f".repeat(64),
        },
        () => true,
      ),
  };
}
test("a second visible photo does not delete the first photo's verified file", async () => {
  const h = harness();
  const first = await h.preview(),
    second = await h.preview();
  assert.ok(h.files.has(first));
  assert.ok(h.files.has(second));
  await h.api.clearPhotoPreviews([first]);
  assert.ok(h.files.has(second));
});
test("cleanup remains successful when another page already deleted the same temporary photo", async () => {
  const h = harness(true);
  const path = await h.preview();
  assert.ok(h.files.has(path));
  await Promise.all([
    h.api.clearPhotoPreviews([path]),
    h.api.clearPhotoPreviews([path]),
  ]);
  assert.equal(h.files.size, 0);
});

test("reopening a preview retries a transient cleanup failure", async () => {
  const h = harness();
  await h.preview();
  h.failCleanup(true);
  await assert.rejects(h.api.clearPhotoPreviews());
  h.failCleanup(false);
  const next = await h.preview();
  assert.ok(h.files.has(next));
});
