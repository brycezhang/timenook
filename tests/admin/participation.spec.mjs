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
const schema = `t11_browser_${randomUUID().replaceAll("-", "")}`;
let privateDir;
const apiCwd = resolve("apps/api");
let api,
  vite,
  preview,
  databaseUrl,
  account,
  productSession,
  narratorSession,
  replacementSession,
  projectId;
const logs = [];
const runtimeErrors = [];
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
  privateDir = mkdtempSync(join(tmpdir(), "t11-browser-"));
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
      "care:write",
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
  const { createApplication } = apiRequire("./dist-test/src/application.js");
  const { readConfig } = apiRequire("./dist-test/src/config.js");
  const { paymentConfig, paymentFetch, paid } = apiRequire(
    "./dist-test/test/payment-fixture.js",
  );
  const config = {
    ...readConfig(env),
    wechat: { appId: paymentConfig.appId, secret: "synthetic" },
    payments: paymentConfig,
    participation: { mode: "synthetic-d08" },
  };
  api = await createApplication(config, {
    paymentFetch,
    wechatFetch: async (input) =>
      new Response(
        JSON.stringify({
          openid: new URL(String(input)).searchParams
            .get("js_code")
            .split(":")[0],
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
  productSession = responseData(
    await api.inject({
      method: "POST",
      url: "/v1/sessions/wechat",
      payload: { code: "synthetic-buyer:code" },
    }),
  );
  const headers = {
    authorization: `Bearer ${productSession.session.token}`,
    "idempotency-key": randomUUID(),
  };
  const order = responseData(
    await api.inject({
      method: "POST",
      url: "/v1/orders",
      headers,
      payload: {
        packageVersionId: versionId,
        recipient: { relationshipLabel: "恩师" },
        shippingRegionCode: "CN-110000",
      },
    }),
  );
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
  projectId = responseData(
    await api.inject({ method: "GET", url: `/v1/orders/${order.id}`, headers }),
    200,
  ).project.id;
  narratorSession = await loginProduct("synthetic-narrator");
  replacementSession = await loginProduct("synthetic-replacement");
  responseData(
    await api.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/participation`,
      headers,
    }),
    200,
  );
  await api.listen(3418, "127.0.0.1");
  vite = start(
    process.execPath,
    ["node_modules/vite/bin/vite.js", "--force", "--host", "localhost"],
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
        TIMENOOK_PAYMENT_VERIFICATION: "local-verification",
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
  await api?.close();
  if (databaseUrl) {
    const database = new PrismaClient({ datasourceUrl: databaseUrl });
    const redis = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    redis.on("error", () => {});
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

function responseData(response, status = 201) {
  expect(response.statusCode, response.body).toBe(status);
  expect(response.json().error).toBeUndefined();
  return response.json().data;
}
async function loginProduct(who) {
  return responseData(
    await api.inject({
      method: "POST",
      url: "/v1/sessions/wechat",
      payload: { code: `${who}:${randomUUID()}` },
    }),
  );
}
async function sessionPage(context, session, route) {
  const page = await context.newPage();
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !/\b40[13]\b/.test(message.text()))
      runtimeErrors.push(message.text());
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("http://127.0.0.1:5174/");
  await page.evaluate(
    ({ session }) => {
      localStorage.setItem("timenook.mode.v1", JSON.stringify("live"));
      localStorage.setItem(
        "timenook.session.v1:http://127.0.0.1:5174/timenook/v1",
        JSON.stringify(session),
      );
    },
    { session },
  );
  await page.goto("http://127.0.0.1:5174/#/" + route);
  return page;
}
test("mini-program invitation and separate choices feed the shared care form, which rebinds while the new account must consent again", async ({
  page,
  context,
  browser,
}) => {
  const errors = [];
  const watch = (page) => {
    page.on("pageerror", (e) => errors.push(e.message));
  };
  const buyer = await sessionPage(
    await browser.newContext(),
    productSession,
    `invite?projectId=${projectId}`,
  );
  watch(buyer);
  await expect(
    buyer.getByText("邀请与参与管理", { exact: true }),
  ).toBeVisible();
  await expect(
    buyer.getByRole("button", { name: "准备本人邀请", exact: true }),
    await buyer.locator("body").innerText(),
  ).toBeVisible({ timeout: 5000 });
  const inviteResponse = buyer.waitForResponse(
    (r) =>
      r.url().endsWith(`/projects/${projectId}/invitations`) &&
      r.request().method() === "POST",
  );
  await buyer
    .getByRole("button", { name: "准备本人邀请", exact: true })
    .click();
  const inviteHttp = await inviteResponse;
  expect(inviteHttp.status()).toBe(201);
  const token = (await inviteHttp.json()).data.token;
  await expect(
    buyer.getByRole("button", { name: "发送已准备的邀请" }),
  ).toBeVisible();
  const narrator = await sessionPage(
    await browser.newContext(),
    narratorSession,
    `welcome?token=${token}`,
  );
  watch(narrator);
  await expect(
    narrator.getByText("本人参与与资料用途", { exact: true }),
  ).toBeVisible();
  await expect(
    narrator.getByText(
      `发起人账号尾号 ${productSession.user.id.slice(-6)} 邀请你`,
      { exact: true },
    ),
    await narrator.locator("body").innerText(),
  ).toBeVisible();
  await expect(narrator.getByText("1. 说一段", { exact: true })).toBeVisible();
  await narrator
    .getByRole("button", { name: "已读说明，申请本人参与", exact: true })
    .click();
  await expect(
    narrator.getByText("已申请参与，等待发起人核对；申请不授予内容权限", {
      exact: true,
    }),
  ).toBeVisible();
  await buyer.getByRole("button", { name: "重新查询参与状态" }).click();
  await buyer.getByRole("button", { name: "已核对本人，确认绑定" }).click();
  await expect(buyer.getByText("绑定版本：1", { exact: true })).toBeVisible();
  await narrator.getByRole("button", { name: "重新查询参与状态" }).click();
  const collection = narrator.locator(".paper").filter({
    has: narrator.getByText("采集并保存讲述和照片", { exact: true }),
  });
  await collection
    .getByRole("button", { name: "同意此用途", exact: true })
    .click();
  await expect(collection.getByText("已同意", { exact: true })).toBeVisible();
  const ai = narrator
    .locator(".paper")
    .filter({ has: narrator.getByText("交由AI处理素材", { exact: true }) });
  await ai.getByRole("button", { name: "拒绝此用途", exact: true }).click();
  await expect(ai.getByText("已拒绝或撤回", { exact: true })).toBeVisible();
  await narrator.screenshot({ path: "/tmp/timenook-t11-consents-mobile.png" });
  await narrator
    .getByPlaceholder("目标账号编号")
    .fill(replacementSession.user.id);
  const careResponse = narrator.waitForResponse(
    (r) =>
      r.url().endsWith(`/projects/${projectId}/care-requests`) &&
      r.request().method() === "POST",
  );
  await narrator
    .getByRole("button", { name: "提交客服换绑申请", exact: true })
    .click();
  const careHttp = await careResponse;
  expect(careHttp.status()).toBe(201);
  const care = (await careHttp.json()).data;
  await expect(
    narrator.getByText("处理状态：待客服核验", { exact: true }),
  ).toBeVisible();
  await narrator.goto("http://127.0.0.1:5174/#/welcome");
  await narrator
    .getByRole("button", {
      name: `查看本人的用途选择 · ${projectId}`,
      exact: true,
    })
    .click();
  await expect(
    narrator.getByText(`换绑工单：record:${care.id}`, { exact: true }),
  ).toBeVisible();
  await expect(
    narrator.getByText("处理状态：待客服核验", { exact: true }),
  ).toBeVisible();
  await page.goto("./");
  watch(page);
  await page.getByLabel("管理员账号").fill(account.username);
  await page.getByLabel("密码", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "继续验证" }).click();
  const secret = await page.getByTestId("enrollment-secret").textContent();
  await page.getByLabel("六位验证码").fill(await generate({ secret }));
  await page.getByRole("button", { name: "验证并登录" }).click();
  await expect(
    page.getByRole("button", { name: "客服工单", exact: true }),
  ).toBeVisible({ timeout: 5000 });
  await page.getByRole("button", { name: "客服工单", exact: true }).click();
  await page
    .getByRole("button", { name: `查看 ${care.id}`, exact: true })
    .click();
  await page
    .getByLabel("D08 核验证据引用")
    .fill("synthetic:browser本人核验证据");
  await page.screenshot({ path: "/tmp/timenook-t11-care-desktop.png" });
  await page
    .getByRole("button", { name: "核验完成并换绑", exact: true })
    .click();
  await expect(
    page.getByText("工单已完成，原账号权限已撤销，新账号须重新授权。", {
      exact: true,
    }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".sidebar-brand")).toHaveCount(0);
  await page
    .getByRole("button", { name: `查看 ${care.id}`, exact: true })
    .click();
  await expect(
    page.getByText("来源绑定版本：1", { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: "/tmp/timenook-t11-care-mobile.png" });
  await buyer.goto(`http://127.0.0.1:5174/#/welcome?projectId=${projectId}`);
  await expect(
    buyer.getByText(`换绑工单：record:${care.id}`, { exact: true }),
  ).toBeVisible();
  await expect(
    buyer.getByText("处理状态：已完成", { exact: true }),
  ).toBeVisible();
  await buyer
    .getByText("处理状态：已完成", { exact: true })
    .scrollIntoViewIfNeeded();
  await buyer.screenshot({ path: "/tmp/timenook-t11-care-result-mobile.png" });
  await narrator.getByRole("button", { name: "重新查询参与状态" }).click();
  await expect(
    narrator.getByText("等待发起人核对申请；旧账号或无权限账号不能读取项目", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    narrator.getByRole("button", { name: "同意此用途", exact: true }),
  ).toHaveCount(0);
  const replacement = await sessionPage(
    await browser.newContext(),
    replacementSession,
    `welcome?projectId=${projectId}`,
  );
  watch(replacement);
  await expect(replacement.getByText("尚未选择", { exact: true })).toHaveCount(
    3,
  );
  await expect(replacement.getByText(/未获采集许可/)).toBeVisible();
  const revoked = await api.inject({
    method: "DELETE",
    url: `/v1/sessions/${replacementSession.session.id}`,
    headers: { authorization: `Bearer ${replacementSession.session.token}` },
  });
  expect(revoked.statusCode, revoked.body).toBe(204);
  await replacement.getByRole("button", { name: "重新查询参与状态" }).click();
  await expect(
    replacement.getByRole("button", { name: "微信登录后参与", exact: true }),
  ).toBeEnabled();
  await expect(
    replacement.getByText("登录已失效，请重新登录", { exact: true }),
  ).toBeVisible();
  await expect(
    replacement.getByRole("button", { name: "重新查询参与状态" }),
  ).toBeEnabled();
  for (const target of [buyer, narrator, replacement, page]) {
    expect(await target.locator("vite-error-overlay").count()).toBe(0);
    expect(await target.locator(".preview-error").count()).toBe(0);
  }
  expect(errors).toEqual([]);
  expect(runtimeErrors).toEqual([]);
});
