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
test("desktop and mobile operator completes MFA, survives API restart, and logs out with real Secure cookies", async ({
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
  await page.getByLabel("管理员账号").fill(account.username);
  await page.getByLabel("密码", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "继续验证" }).click();
  await expect(page.getByRole("heading", { name: "双重验证" })).toBeVisible();
  const secret = await page.getByTestId("enrollment-secret").textContent();
  await page.getByLabel("六位验证码").fill(await generate({ secret }));
  await page.getByRole("button", { name: "验证并登录" }).click();
  await expect(page.getByRole("heading", { name: "运行信息" })).toBeVisible();
  await expect(page.getByText("服务可用", { exact: true })).toBeVisible();
  const cookies = await context.cookies(
    "https://localhost:3443/timenook/v1/admin/runtime",
  );
  const session = cookies.find(
    (cookie) => cookie.name === "__Secure-timenook_admin",
  );
  expect(!!session).toBe(true);
  expect(
    session.httpOnly && session.secure && session.sameSite === "Strict",
  ).toBe(true);
  expect(session.path).toBe("/timenook/v1/admin");
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
  await page.screenshot({ path: "/tmp/t07-admin-desktop.png", fullPage: true });
  await stop(api);
  api = start(process.execPath, ["dist/main.js"], { cwd: apiCwd, env });
  await waitFor("https://localhost:3443/timenook/v1/admin/session");
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
  await page.screenshot({ path: "/tmp/t07-admin-mobile.png", fullPage: true });
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
  expect(errors).toEqual([]);
});

test("an expired MFA challenge returns the operator to login and clears enrollment material", async ({
  page,
}) => {
  await stop(api);
  api = start(process.execPath, ["dist/main.js"], {
    cwd: apiCwd,
    env: { ...env, ADMIN_CHALLENGE_TTL_SECONDS: "3" },
  });
  await waitFor("https://localhost:3443/timenook/v1/admin/session");
  await page.goto("./");
  await page.getByLabel("管理员账号").fill(account.username);
  await page.getByLabel("密码", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "继续验证" }).click();
  await expect(page.getByRole("heading", { name: "双重验证" })).toBeVisible();
  await page.waitForTimeout(3200);
  await page.getByLabel("六位验证码").fill("000000");
  await page.getByRole("button", { name: "验证并登录" }).click();
  await expect(page.getByRole("heading", { name: "运营登录" })).toBeVisible();
  await expect(page.getByText("登录或验证已到期，请重新登录。")).toBeVisible();
  await expect(page.getByTestId("enrollment-secret")).toHaveCount(0);
  await page.screenshot({
    path: "/tmp/t07-admin-expired-login.png",
    fullPage: true,
  });
});
