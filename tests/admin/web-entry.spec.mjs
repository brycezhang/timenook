import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const origin = "http://127.0.0.1:4330";
let server;
test.beforeAll(async () => {
  server = spawn(
    process.execPath,
    [
      resolve("node_modules/vite/bin/vite.js"),
      "--host",
      "127.0.0.1",
      "--port",
      "4330",
      "--strictPort",
    ],
    { cwd: resolve("apps/web"), stdio: "ignore" },
  );
  await expect
    .poll(async () => {
      try {
        return (await fetch(`${origin}/app/`)).status;
      } catch {
        return 0;
      }
    })
    .toBe(200);
});
test.afterAll(() => server?.kill());

test("login link waits for an explicit action and removes its ticket from the address", async ({
  page,
}) => {
  const exchanges = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().endsWith("/api/v1/web/session")
    )
      exchanges.push(request);
  });
  await page.goto(`${origin}/app/login#ticket=${"A".repeat(43)}`);
  await expect(
    page.getByRole("button", { name: "进入我的故事书" }),
  ).toBeVisible();
  await expect(page).toHaveURL(`${origin}/app/login`);
  expect(exchanges).toHaveLength(0);
  expect(
    await page.evaluate(() => localStorage.length + sessionStorage.length),
  ).toBe(0);
});

test("an unavailable login service leaves the login retryable", async ({
  page,
}) => {
  await page.goto(`${origin}/app/login#ticket=${"B".repeat(43)}`);
  await page.getByRole("button", { name: "进入我的故事书" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "服务暂不可用，请稍后重试。",
  );
  await expect(
    page.getByRole("button", { name: "进入我的故事书" }),
  ).toBeEnabled();
});

test("a new login link can be opened while the login screen is already visible", async ({ page }) => {
  await page.goto(`${origin}/app/login`);
  await expect(page.getByText("请从内测登录链接进入。")).toBeVisible();
  await page.evaluate(() => { location.hash = `ticket=${"C".repeat(43)}`; });
  await expect(page.getByRole("button", { name: "进入我的故事书" })).toBeVisible();
  expect(await page.evaluate(() => location.hash === "")).toBe(true);
});
