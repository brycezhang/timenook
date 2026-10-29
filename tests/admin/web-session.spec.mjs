import { test, expect } from "@playwright/test";
import {
  createPrivacyFixtureApplication,
  closePrivacyFixtureApplication,
} from "./privacy-fixture.mjs";
import { createRequire } from "node:module";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { get as httpsGet } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const apiRequire = createRequire(resolve("apps/api/package.json"));
const { PrismaClient } = apiRequire("@prisma/client");
const Redis = apiRequire("ioredis");
const schema = `w01_browser_${randomUUID().replaceAll("-", "")}`;
const origin = "https://127.0.0.1:4331";
let app, server, config, root;

async function cli(command, input) {
  const id = randomUUID();
  const inputFile = join(root, `${id}-input.json`);
  const outputFile = join(root, `${id}-output.json`);
  await writeFile(inputFile, JSON.stringify(input), {
    mode: 0o600,
    flag: "wx",
  });
  const result = spawnSync(
    process.execPath,
    [
      resolve("apps/api/dist/web/web-cli.js"),
      command,
      "--input-file",
      inputFile,
      "--output-file",
      outputFile,
    ],
    {
      cwd: resolve("apps/api"),
      env: {
        PATH: process.env.PATH,
        NODE_ENV: "test",
        DATABASE_URL: config.databaseUrl,
        REDIS_URL: config.redisUrl,
        WEB_ORIGIN: origin,
        WEB_SESSION_KEY: config.web.sessionKey,
        PRIVACY_JOURNAL_ROOT: config.privacyJournal.root,
        PRIVACY_JOURNAL_KEY: config.privacyJournal.key,
      },
      stdio: "pipe",
      timeout: 15000,
    },
  );
  expect(result.status, `controlled CLI ${command} completed`).toBe(0);
  return JSON.parse(await readFile(outputFile, "utf8"));
}
async function loginLink() {
  const account = await cli("create", {});
  const issued = await cli("issue", { userId: account.user.id });
  return { ...issued, userId: account.user.id };
}
async function openLink(page, url) {
  // Keep a live one-time ticket out of navigation failure messages and traces.
  await page.goto(`${origin}/app/login`);
  await page.evaluate((value) => location.replace(value), url);
  await expect(
    page.getByRole("button", { name: "进入我的故事书" }),
  ).toBeVisible();
}

test.beforeAll(async () => {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set("schema", schema);
  root = await mkdtemp(join(tmpdir(), "timenook-web-browser-"));
  await chmod(root, 0o700);
  const migrated = spawnSync(
    process.execPath,
    ["node_modules/prisma/build/index.js", "migrate", "deploy"],
    {
      cwd: resolve("apps/api"),
      env: { ...process.env, DATABASE_URL: url.toString() },
      stdio: "pipe",
    },
  );
  expect(migrated.status, "isolated database migrations").toBe(0);
  config = {
    environment: "test",
    host: "127.0.0.1",
    port: 3451,
    databaseUrl: url.toString(),
    redisUrl: process.env.REDIS_URL,
    redisKeyPrefix: schema,
    web: {
      origin,
      sessionKey: randomBytes(32).toString("base64"),
      loginTtlSeconds: 900,
      sessionTtlSeconds: 43200,
    },
  };
  app = await createPrivacyFixtureApplication(config);
  await app.listen(3451, "127.0.0.1");
  const cert = join(root, "localhost.crt"),
    key = join(root, "localhost.key");
  const certificate = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-keyout",
      key,
      "-out",
      cert,
    ],
    { stdio: "pipe" },
  );
  expect(certificate.status, "local HTTPS certificate").toBe(0);
  const build = spawnSync(
    process.execPath,
    [resolve("node_modules/vite/bin/vite.js"), "build"],
    { cwd: resolve("apps/web"), stdio: "pipe" },
  );
  expect(build.status, "production web build").toBe(0);
  server = spawn(
    process.execPath,
    [
      resolve("node_modules/vite/bin/vite.js"),
      "preview",
      "--port",
      "4331",
      "--strictPort",
    ],
    {
      cwd: resolve("apps/web"),
      stdio: "ignore",
      env: {
        ...process.env,
        TIMENOOK_WEB_TLS_CERT: cert,
        TIMENOOK_WEB_TLS_KEY: key,
        TIMENOOK_WEB_API_TARGET: "http://127.0.0.1:3451",
      },
    },
  );
  await expect
    .poll(
      () =>
        new Promise((resolveStatus) => {
          httpsGet(
            `${origin}/app/`,
            { rejectUnauthorized: false },
            (response) => {
              response.resume();
              resolveStatus(response.statusCode);
            },
          ).on("error", () => resolveStatus(0));
        }),
    )
    .toBe(200);
});
test.afterAll(async () => {
  server?.kill();
  await closePrivacyFixtureApplication(app);
  if (config) {
    const db = new PrismaClient({ datasourceUrl: config.databaseUrl });
    const redis = new Redis(config.redisUrl);
    try {
      await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      const keys = await redis.keys(`${schema}:*`);
      if (keys.length) await redis.del(...keys);
    } finally {
      await db.$disconnect();
      redis.disconnect();
    }
  }
  if (root) await rm(root, { recursive: true, force: true });
});

test("a controlled login restores its account after reload and logout revokes the session", async ({
  page,
  context,
}) => {
  const link = await loginLink();
  await openLink(page, link.url);
  await page.getByRole("button", { name: "进入我的故事书" }).click();
  await expect(page.getByRole("heading", { name: "我的故事书" })).toBeVisible();
  await expect(page.getByRole("status")).toHaveText(
    "还没有人生项目。项目准备好后，会出现在这里。",
  );
  const cookie = (await context.cookies()).find(
    (value) => value.name === "__Secure-timenook_web",
  );
  expect(!!cookie).toBe(true);
  expect(cookie.httpOnly && cookie.secure && cookie.sameSite === "Strict").toBe(
    true,
  );
  expect(cookie.path).toBe("/api/v1");
  expect(
    await page.evaluate(
      () =>
        location.hash === "" &&
        localStorage.length === 0 &&
        sessionStorage.length === 0,
    ),
  ).toBe(true);
  await page.reload();
  await expect(page.getByRole("heading", { name: "我的故事书" })).toBeVisible();
  await page.getByRole("button", { name: "退出", exact: true }).click();
  await expect(page.getByText("请从内测登录链接进入。")).toBeVisible();
  await page.goto(`${origin}/app/projects`);
  await expect(page.getByText("请从内测登录链接进入。")).toBeVisible();
});

test("used and revoked login links cannot open an account", async ({
  page,
}) => {
  const used = await loginLink();
  await openLink(page, used.url);
  await page.getByRole("button", { name: "进入我的故事书" }).click();
  await expect(page.getByRole("heading", { name: "我的故事书" })).toBeVisible();
  await page.getByRole("button", { name: "退出", exact: true }).click();
  await expect(page.getByText("请从内测登录链接进入。")).toBeVisible();
  await openLink(page, used.url);
  await page.getByRole("button", { name: "进入我的故事书" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "登录链接无效或已失效，请重新获取。",
  );
  const revoked = await loginLink();
  await cli("revoke", { ticketId: revoked.ticket.id });
  await openLink(page, revoked.url);
  await page.getByRole("button", { name: "进入我的故事书" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "登录链接无效或已失效，请重新获取。",
  );
});
