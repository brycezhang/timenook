import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const origin = "http://127.0.0.1:5198";
const projectId = "33333333-3333-4333-8333-333333333333";
let preview;
test.beforeAll(async () => {
  preview = spawn(
    process.execPath,
    [
      resolve("node_modules/vite/bin/vite.js"),
      "--host",
      "127.0.0.1",
      "--port",
      "5198",
      "--strictPort",
    ],
    { cwd: process.cwd(), stdio: "ignore" },
  );
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (
      await fetch(origin)
        .then((r) => r.ok)
        .catch(() => false)
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Preview did not become ready");
});
test.afterAll(() => preview?.kill("SIGTERM"));

test("preview request adapter forwards first-copy queries and four commands with exact method, body and idempotency header", async ({
  page,
}) => {
  const observed = [];
  await page.route(
    `${origin}/api/v1/projects/${projectId}/first-copy**`,
    async (route) => {
      const request = route.request();
      observed.push({
        path: new URL(request.url()).pathname,
        method: request.method(),
        key: request.headers()["idempotency-key"],
        body: request.postDataJSON(),
      });
      await route.fulfill({
        status: 200,
        json: {
          data: { acknowledged: true },
          meta: { requestId: "synthetic" },
        },
      });
    },
  );
  await page.goto(origin);
  await page.waitForFunction(() => !!window.wx?.request);
  for (const [suffix, method] of [
    ["", "GET"],
    ["/address", "POST"],
    ["/confirmations", "POST"],
    ["/submit", "POST"],
    ["/expiry-review", "POST"],
  ]) {
    const result = await page.evaluate(
      ({ url, method }) =>
        new Promise((resolve) =>
          window.wx.request({
            url,
            method,
            data: { synthetic: "first-copy" },
            header: { "Idempotency-Key": "synthetic-first-copy-key" },
            success: (value) =>
              resolve({ ok: true, status: value.statusCode, body: value.data }),
            fail: () => resolve({ ok: false }),
          }),
        ),
      {
        url: `${origin}/api/v1/projects/${projectId}/first-copy${suffix}`,
        method,
      },
    );
    expect(result).toEqual({
      ok: true,
      status: 200,
      body: { data: { acknowledged: true }, meta: { requestId: "synthetic" } },
    });
    expect(observed.at(-1)).toEqual({
      path: `/api/v1/projects/${projectId}/first-copy${suffix}`,
      method,
      key: "synthetic-first-copy-key",
      body: method === "POST" ? { synthetic: "first-copy" } : null,
    });
  }
  const count = observed.length;
  for (const [suffix, method] of [
    ["/unknown", "POST"],
    ["/submit", "DELETE"],
  ]) {
    const result = await page.evaluate(
      ({ url, method }) =>
        new Promise((resolve) =>
          window.wx.request({
            url,
            method,
            success: () => resolve(true),
            fail: () => resolve(false),
          }),
        ),
      {
        url: `${origin}/api/v1/projects/${projectId}/first-copy${suffix}`,
        method,
      },
    );
    expect(result).toBe(false);
  }
  expect(observed).toHaveLength(count);
});
