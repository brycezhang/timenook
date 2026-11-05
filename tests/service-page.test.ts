import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";

const base = "https://example.test/timenook/v1";
const projectId = "33333333-3333-4333-8333-333333333333";
const source = (
  await build({
    entryPoints: ["miniprogram/pages/service/index.ts"],
    bundle: true,
    write: false,
    format: "cjs",
    platform: "neutral",
    define: { __TIMENOOK_API_BASE_URL__: JSON.stringify(base) },
  })
).outputFiles[0].text;
function harness() {
  const storage = new Map<string, unknown>([
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
  const requests: any[] = [],
    routes: string[] = [];
  let page: any;
  runInNewContext(source, {
    setTimeout,
    clearTimeout,
    Page(value: any) {
      page = value;
      page.setData = (patch: object) => Object.assign(page.data, patch);
    },
    wx: {
      getStorageSync(key: string) {
        assert.notEqual(
          key,
          "timenook.frontend.v1",
          "live service never reads demo material",
        );
        return storage.get(key);
      },
      setStorageSync(key: string, value: unknown) {
        storage.set(key, value);
      },
      removeStorageSync(key: string) {
        storage.delete(key);
      },
      request(request: unknown) {
        requests.push(request);
      },
      switchTab: ({ url }: { url: string }) => routes.push(url),
      navigateTo({ url }: { url: string }) {
        routes.push(url);
      },
      setNavigationBarTitle() {},
    },
  });
  page.onLoad({ projectId, kind: "support" });
  const respond = (requestsIndex: number, value: unknown) =>
    requests[requestsIndex].success({
      statusCode: 200,
      data: { data: value, meta: { requestId: "synthetic" } },
    });
  return { page, requests, routes, respond };
}

test("live help queries actual project cases and keeps every service link in that project", async () => {
  const h = harness(),
    pending = h.page.onShow();
  assert.equal(
    h.requests[0].url,
    `${base}/projects/${projectId}/care-requests`,
  );
  h.respond(0, {
    requests: [
      {
        id: "44444444-4444-4444-8444-444444444444",
        kind: "export",
        state: "open",
        createdAt: "2026-10-30T00:00:00Z",
      },
    ],
  });
  await pending;
  assert.equal(h.page.data.careRequests[0].kind, "export");
  assert.equal(h.page.data.recordings.length, 0);
  h.page.rights();
  h.page.completeExport();
  h.page.deletion();
  h.page.project();
  assert.deepEqual(h.routes, [
    `/pages/welcome/index?projectId=${projectId}&manage=1`,
    `/pages/export/index?projectId=${projectId}`,
    `/pages/deletion-status/index?projectId=${projectId}`,
    `/pages/project/index`,
  ]);
});

test("leaving live help clears private cases and fences a late response", async () => {
  const h = harness(),
    pending = h.page.onShow();
  h.page.onHide();
  h.respond(0, {
    requests: [
      {
        id: "44444444-4444-4444-8444-444444444444",
        kind: "delete",
        state: "open",
        createdAt: "2026-10-30T00:00:00Z",
      },
    ],
  });
  await pending;
  assert.equal(h.page.data.careRequests.length, 0);
  assert.equal(h.page.data.busy, false);
});
