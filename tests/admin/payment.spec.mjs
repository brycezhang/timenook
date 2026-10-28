import {
  createPrivacyFixtureApplication,
  closePrivacyFixtureApplication,
} from "./privacy-fixture.mjs";
import { test, expect } from "@playwright/test";
test.use({ timezoneId: "Asia/Shanghai" });
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";
import https from "node:https";
import http from "node:http";
const apiRequire = createRequire(resolve("apps/api/package.json"));
const { PrismaClient } = apiRequire("@prisma/client");
const { generate } = apiRequire("otplib");
const Redis = apiRequire("ioredis");
const schema = `t10_browser_${randomUUID().replaceAll("-", "")}`;
let privateDir;
const apiCwd = resolve("apps/api");
let api, vite, preview, databaseUrl, account, productSession, projectId;
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
  privateDir = mkdtempSync(join(tmpdir(), "t10-browser-"));
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
      "service-terms:write",
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
  const { readConfig } = apiRequire("./dist-test/src/config.js");
  const { paymentConfig, paymentFetch, paid } = apiRequire(
    "./dist-test/test/payment-fixture.js",
  );
  const config = {
    ...readConfig(env),
    wechat: { appId: paymentConfig.appId, secret: "synthetic" },
    payments: paymentConfig,
  };
  api = await createPrivacyFixtureApplication(config, {
    paymentFetch,
    wechatFetch: async () =>
      new Response(
        JSON.stringify({
          openid: "synthetic-browser",
          session_key: "synthetic",
        }),
      ),
  });
  const db = new PrismaClient({ datasourceUrl: databaseUrl });
  const snapshot = JSON.parse(
    readFileSync(
      resolve("apps/api/test/fixtures/catalog-synthetic.json"),
      "utf8",
    ),
  );
  const draftId = randomUUID(),
    versionId = randomUUID();
  await db.packageDraft.create({
    data: { id: draftId, realm: "local", ...snapshot },
  });
  await db.packageVersion.create({
    data: {
      id: versionId,
      realm: "local",
      purpose: "local_preview",
      draftId,
      draftRevision: 1,
      snapshot,
      publicOffer: {
        title: snapshot.title,
        price: { value: 99900, currency: "CNY", unit: "fen" },
        purpose: "local_preview",
        scope: {
          projects: 1,
          adultSubjects: 1,
          initiators: 1,
          firstCopies: 1,
          agreedShippingIncluded: true,
          completeExportIncluded: true,
        },
        terms: [],
      },
    },
  });
  await db.$disconnect();
  productSession = (
    await api.inject({
      method: "POST",
      url: "/v1/sessions/wechat",
      payload: { code: "synthetic-browser-code" },
    })
  ).json().data;
  const headers = {
    authorization: `Bearer ${productSession.session.token}`,
    "idempotency-key": randomUUID(),
  };
  const order = (
    await api.inject({
      method: "POST",
      url: "/v1/orders",
      headers,
      payload: {
        packageVersionId: versionId,
        recipient: { relationshipLabel: "恩师" },
        shippingRegionCode: "CN-110000",
      },
    })
  ).json().data;
  await api.inject({
    method: "POST",
    url: `/v1/orders/${order.id}/payment`,
    headers,
    payload: {},
  });
  const supportStart = Date.now() - 2 * 86400000;
  paid(order.outTradeNo, {
    success_time: new Date(supportStart).toISOString(),
  });
  projectId = (
    await api.inject({ method: "GET", url: `/v1/orders/${order.id}`, headers })
  ).json().data.project.id;
  const { ProjectServiceTerms } = apiRequire(
    "./dist-test/src/projects/service-terms.js",
  );
  const terms = new ProjectServiceTerms(databaseUrl);
  await terms.recordFact({
    projectId,
    eventId: "synthetic-browser-participation",
    kind: "subject_participation",
    occurredAt: new Date(supportStart + 86400000),
  });
  await terms.close();
  await api.listen(3418, "127.0.0.1");
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
  preview = start(
    process.execPath,
    ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "5174"],
    {
      cwd: resolve("."),
      env: {
        ...process.env,
        TIMENOOK_PAYMENT_VERIFICATION: "local-verification",
        TIMENOOK_API_BASE_URL: "http://127.0.0.1:5174/api/v1",
        TIMENOOK_PREVIEW_API_TARGET: "http://127.0.0.1:3418",
      },
    },
  );
  await waitFor("http://127.0.0.1:5174/");
});
test.afterAll(async () => {
  await stop(preview);
  await stop(vite);
  await closePrivacyFixtureApplication(api);
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

test("support uses a minimal shared-case pause form and the mini-program restores the same server project", async ({
  page,
  context,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto("./");
  await page.getByLabel("管理员账号").fill(account.username);
  await page.getByLabel("密码", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "继续验证" }).click();
  const secret = await page.getByTestId("enrollment-secret").textContent();
  await page.getByLabel("六位验证码").fill(await generate({ secret }));
  await page.getByRole("button", { name: "验证并登录" }).click();
  await page.getByRole("button", { name: "服务期限", exact: true }).click();
  await page.getByLabel("项目编号").fill(projectId);
  const query = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/service-terms/${projectId}`) &&
      response.request().method() === "GET",
  );
  await page.getByRole("button", { name: "查询期限" }).click();
  await expect(page.getByText("制作进行中", { exact: true })).toBeVisible();
  const deadline = (await (await query).json()).data.creation.expiresAt;
  await expect(
    page.getByText("显示时区：Asia/Shanghai", { exact: true }),
  ).toBeVisible();
  const localDeadline = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(new Date(deadline));
  await expect(
    page.getByText(`制作到期：${localDeadline}`, { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("回听到期：未起算", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("导出申请到期：未起算", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("共享工单引用").fill("record:synthetic-browser-case");
  await page.getByRole("button", { name: "暂停制作计时", exact: true }).click();
  await expect(page.getByText("制作已暂停", { exact: true })).toBeVisible();
  await page.screenshot({ path: "/tmp/timenook-t10-admin-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  // Existing Vben responsive layout remounts its slot at this breakpoint.
  // Wait for the mobile render before filling its new form instance.
  await expect(page.locator(".sidebar-brand")).toHaveCount(0);
  await expect(page.getByLabel("项目编号")).toHaveValue("");
  // Re-enter the minimal form and recover authoritative server state.
  await page.getByLabel("项目编号").fill(projectId);
  await page.getByRole("button", { name: "查询期限" }).click();
  await expect(page.getByText("制作已暂停", { exact: true })).toBeVisible();
  await page.getByLabel("共享工单引用").fill("record:synthetic-browser-case");
  await page.getByRole("button", { name: "恢复制作计时", exact: true }).click();
  await expect(page.getByText("制作进行中", { exact: true })).toBeVisible();
  await page.screenshot({ path: "/tmp/timenook-t10-admin-mobile.png" });
  const previewPage = await context.newPage();
  await previewPage.setViewportSize({ width: 390, height: 844 });
  previewPage.on("pageerror", (error) => errors.push(error.message));
  await previewPage.goto("http://127.0.0.1:5174/");
  await previewPage.evaluate(
    ({ session }) => {
      localStorage.setItem("timenook.mode.v1", JSON.stringify("live"));
      localStorage.setItem(
        "timenook.session.v1:http://127.0.0.1:5174/api/v1",
        JSON.stringify(session),
      );
    },
    { session: productSession },
  );
  await previewPage.goto("http://127.0.0.1:5174/#/order");
  await expect(
    previewPage.getByText("合成付款核验完成 · 未真实扣款", { exact: true }),
  ).toBeVisible();
  await expect(
    previewPage.getByText("项目：" + projectId, { exact: true }),
  ).toBeVisible();
  await previewPage.getByRole("button", { name: "重新查询订单" }).click();
  await expect(
    previewPage.getByText("项目：" + projectId, { exact: true }),
  ).toBeVisible();
  await previewPage.screenshot({ path: "/tmp/timenook-t10-order-mobile.png" });
  await previewPage.getByRole("button", { name: "查看套餐与赠礼称呼" }).click();
  await expect(
    previewPage.getByRole("button", { name: "暂未开放购买" }),
  ).toBeDisabled();
  await expect(
    previewPage.getByText("本地合成付款验证", { exact: true }),
  ).toBeVisible();
  await previewPage.screenshot({
    path: "/tmp/timenook-t10-purchase-mobile.png",
  });
  expect(errors).toEqual([]);
  expect(await previewPage.locator("vite-error-overlay").count()).toBe(0);
  await previewPage.close();
});
