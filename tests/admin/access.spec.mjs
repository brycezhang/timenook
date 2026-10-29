import {
  feishuIdentity,
  feishuLogin,
  installFeishuAuthorization,
  syntheticFeishuEnv,
} from "./feishu-fixture.mjs";
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
const Redis = apiRequire("ioredis");
const schema = `t07_browser_${randomUUID().replaceAll("-", "")}`;
let privateDir;
const apiCwd = resolve("apps/api");
let api, vite, databaseUrl, account;
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
  privateDir = mkdtempSync(join(tmpdir(), "t07-browser-"));
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
    ADMIN_SESSION_KEY: randomBytes(32).toString("base64"),
    ...syntheticFeishuEnv,
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
    ...feishuIdentity(),
    permissions: ["ops:read", "audit:read"],
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
  api = start(
    process.execPath,
    [resolve("tests/admin/feishu-api-runner.mjs")],
    { cwd: apiCwd, env },
  );
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
  await waitFor("https://localhost:3443/admin/");
});
test.afterAll(async () => {
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
test("operator login offers one Feishu action without password or MFA fields", async ({
  page,
}) => {
  await page.goto("./");
  await expect(page).toHaveTitle("时光里 · 运营管理");
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "运营登录" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "飞书登录", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("textbox")).toHaveCount(0);
  await expect(page.getByTestId("enrollment-secret")).toHaveCount(0);
});

test("desktop and mobile operator completes one Feishu login, survives API restart, and logs out with real Secure cookies", async ({
  page,
  context,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto("./");
  await expect(page.getByRole("heading", { name: "运营登录" }))
    .toBeVisible({ timeout: 15000 })
    .catch(async (error) => {
      console.error(
        JSON.stringify({
          errors,
          initialPage: await page.locator("body").innerText(),
        }),
      );
      throw error;
    });
  await page.screenshot({
    path: "/tmp/timenook-feishu-login-desktop.png",
    fullPage: true,
  });
  const callbackRequest = page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname === "/api/v1/admin/feishu/callback",
  );
  await feishuLogin(page, account);
  const callbackHeaders = await (await callbackRequest).allHeaders();
  expect(callbackHeaders.cookie).toContain("__Secure-timenook_oauth=");
  expect(callbackHeaders.cookie ?? "").not.toContain(
    "__Secure-timenook_admin=",
  );
  await expect(page.getByRole("heading", { name: "运行信息" })).toBeVisible({
    timeout: 15000,
  });
  await expect(page.getByText("服务可用", { exact: true })).toBeVisible();
  const cookies = await context.cookies(
    "https://localhost:3443/api/v1/admin/runtime",
  );
  const session = cookies.find(
    (cookie) => cookie.name === "__Secure-timenook_admin",
  );
  expect(!!session).toBe(true);
  expect(
    session.httpOnly && session.secure && session.sameSite === "Strict",
  ).toBe(true);
  expect(session.path).toBe("/api/v1/admin");
  expect(
    (await context.cookies("https://localhost:3443/v1/health")).some(
      (c) => c.name === session.name,
    ),
  ).toBe(false);
  expect(
    await page.evaluate(() =>
      document.cookie.includes("__Secure-timenook_admin"),
    ),
  ).toBe(false);
  await page.screenshot({
    path: "/tmp/timenook-feishu-admin-desktop.png",
    fullPage: true,
  });
  await stop(api);
  api = start(
    process.execPath,
    [resolve("tests/admin/feishu-api-runner.mjs")],
    { cwd: apiCwd, env },
  );
  await waitFor("https://localhost:3443/api/v1/admin/session");
  await page.reload();
  await expect(page.getByText("服务可用", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => errors.length).toBe(0);
  await expect(page.getByRole("button", { name: "退出登录" })).toBeVisible();
  await expect(page.locator(".app-header")).toHaveCount(1);
  await expect
    .poll(() =>
      page
        .locator(".app-header")
        .evaluate((el) => Math.round(el.getBoundingClientRect().width)),
    )
    .toBeGreaterThan(340);
  await page.screenshot({
    path: "/tmp/timenook-feishu-admin-mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page.getByRole("heading", { name: "运营登录" })).toBeVisible();
  expect(
    (await context.cookies()).some(
      (cookie) =>
        cookie.name === session.name && cookie.value === session.value,
    ),
  ).toBe(false);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "/tmp/timenook-feishu-login-mobile.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("an expired Feishu authorization returns to the single login action", async ({
  page,
}) => {
  await stop(api);
  api = start(
    process.execPath,
    [resolve("tests/admin/feishu-api-runner.mjs")],
    {
      cwd: apiCwd,
      env: { ...env, ADMIN_CHALLENGE_TTL_SECONDS: "3" },
    },
  );
  await waitFor("https://localhost:3443/api/v1/admin/session");
  await page.goto("./");
  const remove = await installFeishuAuthorization(page, account);
  try {
    await page.getByRole("button", { name: "飞书登录", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "飞书授权（合成测试）" }),
    ).toBeVisible();
    await page.waitForTimeout(3200);
    await page.getByRole("link", { name: "授权并返回", exact: true }).click();
    await expect(page.getByRole("heading", { name: "运营登录" })).toBeVisible();
    await expect(
      page.getByText("飞书登录未完成，请重试或联系管理员。", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("textbox")).toHaveCount(0);
    await expect(page).toHaveURL("https://localhost:3443/admin/");
    await page.screenshot({
      path: "/tmp/timenook-feishu-expired-login.png",
      fullPage: true,
    });
  } finally {
    await remove();
    await stop(api);
    api = start(
      process.execPath,
      [resolve("tests/admin/feishu-api-runner.mjs")],
      { cwd: apiCwd, env },
    );
    await waitFor("https://localhost:3443/api/v1/admin/session");
  }
});

test("an unapproved Feishu identity cannot enter the console", async ({
  page,
}) => {
  await page.goto("./");
  await feishuLogin(page, feishuIdentity());
  await expect(page.getByRole("heading", { name: "运营登录" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText(
    "飞书登录未完成，请重试或联系管理员。",
  );
  await expect(page.getByRole("button", { name: "退出登录" })).toHaveCount(0);
  await expect(page).toHaveURL("https://localhost:3443/admin/");
});

test("cancelled Feishu authorization restores a usable login page", async ({
  page,
}) => {
  await page.goto("./");
  const remove = await installFeishuAuthorization(page, account, {
    cancel: true,
  });
  try {
    await page.getByRole("button", { name: "飞书登录", exact: true }).click();
    await page.getByRole("link", { name: "取消并返回", exact: true }).click();
    await expect(page.getByRole("heading", { name: "运营登录" })).toBeVisible();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "飞书登录", exact: true }),
    ).toBeEnabled();
    await expect(page).toHaveURL("https://localhost:3443/admin/");
  } finally {
    await remove();
  }
});

test("a revoked operator session clears the console and returns to Feishu login", async ({
  page,
}) => {
  await page.goto("./");
  await feishuLogin(page, account);
  await expect(page.getByRole("heading", { name: "运行信息" })).toBeVisible();
  const db = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    await db.adminAccount.updateMany({
      where: { username: account.username },
      data: { disabled: true },
    });
    await page.getByRole("button", { name: "刷新状态", exact: true }).click();
    await expect(page.getByRole("heading", { name: "运营登录" })).toBeVisible();
    await expect(
      page.getByText("登录已到期，请重新使用飞书登录。", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "退出登录" })).toHaveCount(0);
  } finally {
    await db.adminAccount.updateMany({
      where: { username: account.username },
      data: { disabled: false },
    });
    await db.$disconnect();
  }
});

test("an approved operator with no business permissions sees no restricted controls", async ({
  page,
}) => {
  const db = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    await db.adminAccount.updateMany({
      where: { username: account.username },
      data: { permissions: [] },
    });
    await page.goto("./");
    await feishuLogin(page, account);
    await expect(page.getByRole("button", { name: "退出登录" })).toBeVisible();
    await expect(
      page.getByText("当前账号暂无运行信息查看权限，请联系管理员。", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "客服工单", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "生产与物流", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "退出登录" }).click();
  } finally {
    await db.adminAccount.updateMany({
      where: { username: account.username },
      data: { permissions: account.permissions },
    });
    await db.$disconnect();
  }
});

test("callback failure text is fixed and removed from browser history", async ({
  page,
}) => {
  await page.goto(
    "./?login_error=" +
      encodeURIComponent("<script>private-provider-detail</script>"),
  );
  await expect(page.getByRole("alert")).toHaveText(
    /飞书登录暂不可用，请稍后重试。/,
  );
  await expect(page).toHaveURL("https://localhost:3443/admin/");
  expect(await page.locator("body").innerText()).not.toContain(
    "private-provider-detail",
  );
});

test("an unconfigured Feishu login is clearly unavailable on mobile", async ({
  page,
}) => {
  await stop(api);
  const unconfigured = { ...env };
  for (const name of Object.keys(syntheticFeishuEnv)) delete unconfigured[name];
  api = start(
    process.execPath,
    [resolve("tests/admin/feishu-api-runner.mjs")],
    {
      cwd: apiCwd,
      env: unconfigured,
    },
  );
  await waitFor("https://localhost:3443/api/v1/admin/session");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("./");
  await expect(
    page.getByText("飞书登录尚未配置，请联系管理员。", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "飞书登录", exact: true }),
  ).toBeDisabled();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "/tmp/timenook-feishu-unconfigured-mobile.png",
    fullPage: true,
  });
});
