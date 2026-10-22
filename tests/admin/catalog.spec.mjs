import { test, expect } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";
import https from "node:https";
import http from "node:http";
const apiRequire = createRequire(resolve("apps/api/package.json"));
const { PrismaClient } = apiRequire("@prisma/client");
const { generate } = apiRequire("otplib");
const Redis = apiRequire("ioredis");
const schema = `t08_browser_${randomUUID().replaceAll("-", "")}`;
let privateDir;
const apiCwd = resolve("apps/api");
let api, vite, preview, databaseUrl, account;
const logs = [];
function start(command, args, options) {
  const child = spawn(command, args, {
    ...options,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (data) => logs.push(String(data)));
  child.stderr.on("data", (data) => logs.push(String(data)));
  return child;
}
async function stop(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill("SIGTERM");
  });
}
async function waitFor(url) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const ok = await new Promise((resolve) => {
      const request = (url.startsWith("https:") ? https : http).get(
        url,
        { rejectUnauthorized: false },
        (response) => {
          response.resume();
          resolve(response.statusCode === 200);
        },
      );
      request.on("error", () => resolve(false));
    });
    if (ok) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Local HTTPS server did not start");
}
let env;
test.beforeAll(async () => {
  privateDir = mkdtempSync(join(tmpdir(), "t08-browser-"));
  if (existsSync(".env")) process.loadEnvFile(".env");
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set("schema", schema);
  databaseUrl = url.toString();
  env = {
    ...process.env,
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    API_PORT: "3418",
    ADMIN_ORIGIN: "https://localhost:3443",
    ADMIN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    REDIS_KEY_PREFIX: schema,
  };
  const cert = join(privateDir, "cert.pem"),
    key = join(privateDir, "key.pem");
  const tls = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
    ],
    { stdio: "ignore" },
  );
  expect(tls.status).toBe(0);
  const migrated = spawnSync(
    process.execPath,
    ["node_modules/prisma/build/index.js", "migrate", "deploy"],
    { cwd: apiCwd, env, encoding: "utf8" },
  );
  expect(migrated.status).toBe(0);
  account = {
    username: `browser-${randomUUID()}`,
    password: randomBytes(24).toString("base64url"),
    permissions: [
      "ops:read",
      "audit:read",
      "catalog:read",
      "catalog:write",
      "catalog:freeze",
    ],
    realm: "local",
  };
  const input = join(privateDir, "account.json");
  writeFileSync(input, JSON.stringify(account), { mode: 0o600 });
  const created = spawnSync(
    process.execPath,
    ["dist/admin/admin-cli.js", "create", "--input-file", input],
    { cwd: apiCwd, env, encoding: "utf8" },
  );
  expect(created.status).toBe(0);
  api = start(process.execPath, ["dist/main.js"], { cwd: apiCwd, env });
  vite = start(
    process.execPath,
    ["node_modules/vite/bin/vite.js", "--host", "localhost"],
    {
      cwd: resolve("apps/admin"),
      env: {
        ...process.env,
        ADMIN_API_TARGET: "http://127.0.0.1:3418",
        ADMIN_TLS_CERT: cert,
        ADMIN_TLS_KEY: key,
      },
    },
  );
  await waitFor("http://127.0.0.1:3418/health/live");
  await waitFor("https://localhost:3443/timenook/admin/");
  preview = start(
    process.execPath,
    ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "5174"],
    {
      cwd: resolve("."),
      env: {
        ...process.env,
        TIMENOOK_API_BASE_URL: "http://127.0.0.1:5174/timenook/v1",
        TIMENOOK_PREVIEW_API_TARGET: "http://127.0.0.1:3418",
      },
    },
  );
  await waitFor("http://127.0.0.1:5174/");
});
test.afterAll(async () => {
  await stop(preview);
  await stop(vite);
  await stop(api);
  if (databaseUrl) {
    const database = new PrismaClient({ datasourceUrl: databaseUrl });
    const redis = new Redis(process.env.REDIS_URL);
    try {
      await database.$executeRawUnsafe(
        `DROP SCHEMA IF EXISTS "${schema}" CASCADE`,
      );
      const keys = await redis.keys(`${schema}:*`);
      if (keys.length) await redis.del(...keys);
    } finally {
      await database.$disconnect();
      redis.disconnect();
    }
  }
  if (privateDir) rmSync(privateDir, { recursive: true, force: true });
});

test("operator manages relationships and package drafts, freezes a local preview and sees the same offer in the mini-program", async ({
  page,
  context,
}) => {
  const errors = [];
  page.on("pageerror", (error) =>
    errors.push({ kind: "page", message: error.message }),
  );
  page.on("console", (message) => {
    if (message.type() === "error")
      errors.push({
        kind: "console",
        message: message.text(),
        url: message.location().url,
      });
  });
  await page.goto("./");
  await page.getByLabel("管理员账号").fill(account.username);
  await page.getByLabel("密码", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "继续验证" }).click();
  const secret = await page.getByTestId("enrollment-secret").textContent();
  await page.getByLabel("六位验证码").fill(await generate({ secret }));
  await page.getByRole("button", { name: "验证并登录" }).click();
  await page.getByRole("button", { name: "关系与套餐", exact: true }).click();
  await expect(page.getByRole("heading", { name: "赠礼关系" })).toBeVisible();
  await page.getByLabel("关系代码").fill("mentor");
  await page.getByLabel("公开称呼").fill("恩师");
  await page.getByRole("button", { name: "新增关系", exact: true }).click();
  await expect(
    page.getByRole("cell", { name: "恩师", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "停用 mentor" }).click();
  await expect(page.getByRole("button", { name: "启用 mentor" })).toBeVisible();
  await page.getByRole("button", { name: "启用 mentor" }).click();
  await page.getByLabel("套餐草稿名称").fill("待补套餐");
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(
    page.getByText("参数尚未完整，补齐后才能冻结预览。"),
  ).toBeVisible();
  const incompleteFreeze = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/preview-versions"),
  );
  await page.getByRole("button", { name: "冻结本地预览", exact: true }).click();
  const incompleteResponse = await incompleteFreeze;
  expect(incompleteResponse.status()).toBe(422);
  const incompleteFreezeUrl = incompleteResponse.url();
  await expect(
    page.getByRole("alert").filter({ hasText: "参数不完整" }),
  ).toBeVisible();
  await page
    .getByLabel("导入套餐参数 JSON")
    .setInputFiles(resolve("apps/api/test/fixtures/catalog-synthetic.json"));
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(
    page.getByText("结构完整；审批真实性未核验，销售未开放。"),
  ).toBeVisible();
  await page.getByRole("button", { name: "冻结本地预览", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "不可变预览版本" }),
  ).toBeVisible();
  await expect(page.getByText("¥999.00").first()).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "关系与套餐", exact: true }).click();
  await page.getByRole("button", { name: /打开草稿 合成套餐预览/ }).click();
  await expect(page.getByLabel("套餐草稿名称")).toHaveValue("合成套餐预览");
  await expect(
    page.getByRole("button", { name: "冻结本地预览", exact: true }),
  ).toBeEnabled();
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await expect(
    page.getByRole("button", { name: "关系与套餐", exact: true }),
  ).toHaveClass(/ant-btn-primary/);
  await expect(
    page.getByRole("button", { name: "运行信息", exact: true }),
  ).not.toHaveClass(/ant-btn-primary/);
  await page.screenshot({
    path: "/tmp/t08-admin-catalog-desktop.png",
    fullPage: false,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: /打开草稿 合成套餐预览/ }).click();
  await expect(page.getByLabel("套餐草稿名称")).toHaveValue("合成套餐预览");
  await expect(
    page.getByRole("button", { name: "冻结本地预览", exact: true }),
  ).toBeEnabled();
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await page.screenshot({
    path: "/tmp/t08-admin-catalog-mobile.png",
    fullPage: false,
    animations: "disabled",
  });
  const consumer = await context.newPage();
  consumer.on("pageerror", (error) =>
    errors.push({ kind: "page", message: error.message }),
  );
  consumer.on("console", (message) => {
    if (message.type() === "error")
      errors.push({
        kind: "console",
        message: message.text(),
        url: message.location().url,
      });
  });
  await consumer.setViewportSize({ width: 390, height: 844 });
  await consumer.goto("http://127.0.0.1:5174/");
  await consumer.evaluate(() =>
    localStorage.setItem("timenook.mode.v1", JSON.stringify("live")),
  );
  await consumer.reload();
  await consumer
    .getByRole("button", { name: "查看套餐与赠礼称呼", exact: true })
    .click();
  await expect(consumer).toHaveURL("http://127.0.0.1:5174/#/purchase");
  await expect(
    consumer.getByRole("button", { name: "送给恩师", exact: true }),
  ).toBeVisible();
  await consumer.getByRole("button", { name: "送给恩师", exact: true }).click();
  await expect(
    consumer.getByText("这份礼物，送给恩师", { exact: true }),
  ).toBeVisible();
  await consumer.getByPlaceholder("也可以自定义称呼，最多40字").fill("老同学");
  await expect(
    consumer.getByText("这份礼物，送给老同学", { exact: true }),
  ).toBeVisible();
  await expect(consumer.getByText("¥999.00", { exact: true })).toBeVisible();
  await expect(
    consumer.getByText("套餐准备中，暂未开放购买", { exact: true }),
  ).toBeVisible();
  await expect(consumer.getByText(/支持地区：北京地区（合成）/)).toBeVisible();
  await expect(
    consumer.getByRole("button", { name: "暂未开放购买", exact: true }),
  ).toBeDisabled();
  await consumer.route("**/timenook/v1/packages/current", (route) =>
    route.abort(),
  );
  await consumer.reload();
  await expect(
    consumer.getByText("套餐加载失败，请检查网络后重试", { exact: true }),
  ).toBeVisible();
  await expect(consumer.getByText("¥999.00", { exact: true })).toHaveCount(0);
  await consumer.setViewportSize({ width: 390, height: 844 });
  await consumer.screenshot({
    path: "/tmp/t08-miniprogram-catalog-error.png",
    fullPage: false,
    animations: "disabled",
  });
  await consumer.unroute("**/timenook/v1/packages/current");
  await consumer.getByRole("button", { name: "重新加载", exact: true }).click();
  await expect(consumer.getByText("¥999.00", { exact: true })).toBeVisible();
  expect(
    await consumer.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await expect(
    consumer.locator(".preview-error,vite-error-overlay"),
  ).toHaveCount(0);
  await consumer.screenshot({
    path: "/tmp/t08-miniprogram-catalog-mobile.png",
    fullPage: false,
    animations: "disabled",
  });
  await consumer.setViewportSize({ width: 1280, height: 900 });
  await consumer.screenshot({
    path: "/tmp/t08-miniprogram-catalog-desktop.png",
    fullPage: false,
    animations: "disabled",
  });
  expect(
    await consumer.evaluate(() => localStorage.getItem("timenook.frontend.v1")),
  ).toBeNull();
  const expectedFailure = (error) =>
    error.kind === "console" &&
    ((error.url === incompleteFreezeUrl &&
      /^Failed to load resource: the server responded with a status of 422 \(.*\)$/.test(
        error.message,
      )) ||
      (error.url === "http://127.0.0.1:5174/timenook/v1/packages/current" &&
        error.message === "Failed to load resource: net::ERR_FAILED"));
  expect(errors.filter(expectedFailure)).toHaveLength(2);
  expect(errors.filter((error) => !expectedFailure(error))).toEqual([]);
});
