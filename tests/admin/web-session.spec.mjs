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
import { createServer, request as forwardRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const apiRequire = createRequire(resolve("apps/api/package.json"));
const { PrismaClient } = apiRequire("@prisma/client");
const Redis = apiRequire("ioredis");
const schema = `w01_browser_${randomUUID().replaceAll("-", "")}`;
const origin = "https://127.0.0.1:4331";
let app, linkedApp, server, config, root, relay;
let delayedLogin;
let linkedBackend = false;
const wechatCodes = new Map();
function freshCode(identity) {
  const code = `synthetic-${randomUUID()}`;
  wechatCodes.set(code, identity);
  return code;
}

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
  const { createApplication } = apiRequire("./dist-test/src/application.js");
  linkedApp = await createApplication(
    {
      ...config,
      wechat: { appId: "synthetic-browser-app", secret: "synthetic-secret" },
    },
    {
      wechatFetch: async (input) => {
        const identity = wechatCodes.get(
          new URL(String(input)).searchParams.get("js_code"),
        );
        return new Response(
          JSON.stringify(
            identity
              ? { openid: identity, session_key: "synthetic" }
              : { errcode: 40029 },
          ),
        );
      },
    },
  );
  await linkedApp.listen(3453, "127.0.0.1");
  // Transparent HTTP transport fault injection; application responses are real.
  relay = createServer((request, response) => {
    const held =
      request.method === "POST" && request.url === "/v1/web/session"
        ? delayedLogin
        : undefined;
    if (held) delayedLogin = undefined;
    const upstream = forwardRequest(
      {
        host: "127.0.0.1",
        port: linkedBackend ? 3453 : 3451,
        path: request.url,
        method: request.method,
        headers: request.headers,
      },
      (result) => {
        const chunks = [];
        let size = 0;
        result.on("data", (chunk) => {
          size += chunk.length;
          if (size > 1048576) result.destroy();
          else chunks.push(chunk);
        });
        result.on("end", async () => {
          if (held) {
            held.started();
            await held.release;
          }
          if (!response.destroyed) {
            response.writeHead(result.statusCode, result.headers);
            response.end(Buffer.concat(chunks));
          }
        });
        result.on("error", () => response.destroy());
      },
    );
    upstream.on("error", () => {
      response.writeHead(502);
      response.end();
    });
    request.pipe(upstream);
  });
  await new Promise((resolveReady) =>
    relay.listen(3452, "127.0.0.1", resolveReady),
  );
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
        TIMENOOK_WEB_API_TARGET: "http://127.0.0.1:3452",
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
  if (relay) {
    relay.closeAllConnections();
    await new Promise((resolveClosed) => relay.close(resolveClosed));
  }
  await closePrivacyFixtureApplication(app);
  await linkedApp?.close();
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

for (const separateTab of [false, true])
  test(`a delayed login cannot replace the newer account in ${separateTab ? "another tab" : "the same tab"}`, async ({
    page,
    context,
  }) => {
    const first = await loginLink(),
      second = await loginLink();
    const activePage = separateTab ? await context.newPage() : page;
    let release;
    let started;
    const began = new Promise((resolve) => {
      started = resolve;
    });
    delayedLogin = {
      started,
      release: new Promise((resolve) => {
        release = resolve;
      }),
    };
    try {
      await openLink(page, first.url);
      await page.getByRole("button", { name: "进入我的故事书" }).click();
      await began;
      if (separateTab) {
        await activePage.goto(`${origin}/app/login`);
        await expect(
          activePage.getByText("请从内测登录链接进入。"),
        ).toBeVisible();
      }
      await activePage.evaluate((value) => {
        location.hash = new URL(value).hash;
      }, second.url);
      const response = activePage.waitForResponse(
        (value) =>
          value.request().method() === "POST" &&
          value.url().endsWith("/api/v1/web/session"),
      );
      await activePage.getByRole("button", { name: "进入我的故事书" }).click();
      // Fault injection at the HTTP response boundary: allow a second response
      // to overtake the held first one if exchanges have not been serialized.
      await Promise.race([
        response,
        new Promise((resolve) => setTimeout(resolve, 300)),
      ]);
      release();
      await response;
      await expect(
        activePage.getByRole("heading", { name: "我的故事书" }),
      ).toBeVisible();
      await activePage.reload();
      await expect(
        activePage.getByRole("heading", { name: "我的故事书" }),
      ).toBeVisible();
      const correct = await activePage.evaluate(async (userId) => {
        const result = await (
          await fetch("/api/v1/web/session", { credentials: "same-origin" })
        ).json();
        return result.data.user.id === userId;
      }, second.userId);
      expect(correct).toBe(true);
    } finally {
      release?.();
      delayedLogin = undefined;
      if (separateTab) await activePage.close();
    }
  });

test("logout finishes when another tab already revoked the shared session", async ({
  page,
  context,
}) => {
  const link = await loginLink();
  await openLink(page, link.url);
  await page.getByRole("button", { name: "进入我的故事书" }).click();
  await expect(page.getByRole("heading", { name: "我的故事书" })).toBeVisible();
  const other = await context.newPage();
  try {
    await other.goto(`${origin}/app/projects`);
    await expect(
      other.getByRole("heading", { name: "我的故事书" }),
    ).toBeVisible();
    await other.getByRole("button", { name: "退出", exact: true }).click();
    await expect(other.getByText("请从内测登录链接进入。")).toBeVisible();
    await page.getByRole("button", { name: "退出", exact: true }).click();
    await expect(page.getByText("请从内测登录链接进入。")).toBeVisible();
  } finally {
    await other.close();
  }
});

test("an old tab can exit after account switching without signing out the new account", async ({
  page,
  context,
}) => {
  const first = await loginLink(),
    second = await loginLink();
  await openLink(page, first.url);
  await page.getByRole("button", { name: "进入我的故事书" }).click();
  await expect(page.getByRole("heading", { name: "我的故事书" })).toBeVisible();
  const other = await context.newPage();
  try {
    await openLink(other, second.url);
    await other.getByRole("button", { name: "进入我的故事书" }).click();
    await expect(
      other.getByRole("heading", { name: "我的故事书" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "退出", exact: true }).click();
    await expect(page.getByText("请从内测登录链接进入。")).toBeVisible();
    const correct = await other.evaluate(async (userId) => {
      const result = await (
        await fetch("/api/v1/web/session", { credentials: "same-origin" })
      ).json();
      return result.data.user.id === userId;
    }, second.userId);
    expect(correct).toBe(true);
  } finally {
    await other.close();
  }
});

test("web association clearly remains unavailable without independent WeChat configuration", async ({
  page,
}) => {
  const issued = await loginLink();
  await openLink(page, issued.url);
  await page.getByRole("button", { name: "进入我的故事书" }).click();
  await page.getByRole("button", { name: "关联微信小程序" }).click();
  await expect(
    page.getByText("独立小程序尚未配置，暂不可关联。正式微信验证仍待完成。"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "生成短期关联码" }),
  ).toHaveCount(0);
});

test("web page and server-proven native identity explicitly confirm the same product account", async ({
  page,
}) => {
  linkedBackend = true;
  const issued = await loginLink();
  await openLink(page, issued.url);
  await page.getByRole("button", { name: "进入我的故事书" }).click();
  await page.getByRole("button", { name: "关联微信小程序" }).click();
  await page.getByRole("button", { name: "生成短期关联码" }).click();
  await expect(page.locator(".pair-code")).toHaveText(/^\d{8}$/);
  const linkCode = await page.locator(".pair-code").textContent();
  const native = await linkedApp.inject({
    method: "POST",
    url: "/v1/wechat-links/claim",
    payload: { linkCode, code: freshCode("browser-native-identity") },
  });
  expect(native.statusCode).toBe(201);
  const { proof, challenge } = native.json().data;
  await page.getByRole("button", { name: "刷新关联状态" }).click();
  await expect(page.locator(".pair-code")).toHaveText(
    challenge.verificationCode,
  );
  await expect(page.locator(".account-id")).toContainText(issued.userId);
  await page
    .getByLabel("输入小程序上的6位核对码")
    .fill(challenge.verificationCode);
  await page.getByRole("button", { name: "核对一致，确认关联" }).click();
  await expect(page.getByText("网页已确认 · 小程序待确认")).toBeVisible();
  const confirmed = await linkedApp.inject({
    method: "POST",
    url: "/v1/wechat-links/confirm",
    payload: {
      proof,
      code: freshCode("browser-native-identity"),
      verificationCode: challenge.verificationCode,
    },
  });
  expect(confirmed.statusCode).toBe(201);
  await page.getByRole("button", { name: "刷新关联状态" }).click();
  await expect(
    page.getByText("两端已确认，关联完成。请在小程序重新微信登录同一账号。"),
  ).toBeVisible();
  const restored = await linkedApp.inject({
    method: "POST",
    url: "/v1/sessions/wechat",
    payload: {
      code: freshCode("browser-native-identity"),
      expectedUserId: issued.userId,
    },
  });
  expect(restored.statusCode).toBe(201);
  expect(restored.json().data.user.id).toBe(issued.userId);
  expect(
    await page.evaluate(() => JSON.stringify(Object.entries(localStorage))),
  ).not.toContain(proof);
  expect(new URL(page.url()).hash).toBe("");
  await page.setViewportSize({ width: 320, height: 740 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("a stale web pairing view cannot confirm after another tab changes account", async ({
  page,
  context,
}) => {
  linkedBackend = true;
  const first = await loginLink();
  await openLink(page, first.url);
  await page.getByRole("button", { name: "进入我的故事书" }).click();
  await page.getByRole("button", { name: "关联微信小程序" }).click();
  await page.getByRole("button", { name: "生成短期关联码" }).click();
  const linkCode = await page.locator(".pair-code").textContent();
  const claimed = await linkedApp.inject({
    method: "POST",
    url: "/v1/wechat-links/claim",
    payload: { linkCode, code: freshCode("stale-browser-native") },
  });
  expect(claimed.statusCode).toBe(201);
  const { proof, challenge } = claimed.json().data;
  await page.getByRole("button", { name: "刷新关联状态" }).click();
  await expect(page.locator(".pair-code")).toHaveText(
    challenge.verificationCode,
  );
  const second = await context.newPage(),
    replacement = await loginLink();
  await openLink(second, replacement.url);
  await second.getByRole("button", { name: "进入我的故事书" }).click();
  await expect(
    second.getByRole("heading", { name: "我的故事书" }),
  ).toBeVisible();
  await page
    .getByLabel("输入小程序上的6位核对码")
    .fill(challenge.verificationCode);
  await page.getByRole("button", { name: "核对一致，确认关联" }).click();
  await expect(
    page.getByText("账号已切换，请重新打开当前账号后再关联。"),
  ).toBeVisible();
  await expect(page.locator(".pair-code")).toHaveCount(0);
  const late = await linkedApp.inject({
    method: "POST",
    url: "/v1/wechat-links/confirm",
    payload: {
      proof,
      code: freshCode("stale-browser-native"),
      verificationCode: challenge.verificationCode,
    },
  });
  expect(late.statusCode).toBe(401);
  await second.close();
});
