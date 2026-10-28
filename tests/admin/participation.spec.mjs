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
  projectId,
  assistedProjectId;
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
let adminCookies;
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
  api = await createPrivacyFixtureApplication(config, {
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
  const assistedHeaders = { ...headers, "idempotency-key": randomUUID() };
  const assistedOrder = responseData(
    await api.inject({
      method: "POST",
      url: "/v1/orders",
      headers: assistedHeaders,
      payload: {
        packageVersionId: versionId,
        recipient: { relationshipLabel: "朋友" },
        shippingRegionCode: "CN-110000",
      },
    }),
  );
  responseData(
    await api.inject({
      method: "POST",
      url: `/v1/orders/${assistedOrder.id}/payment`,
      headers: assistedHeaders,
      payload: {},
    }),
  );
  paid(assistedOrder.outTradeNo);
  assistedProjectId = responseData(
    await api.inject({
      method: "GET",
      url: `/v1/orders/${assistedOrder.id}`,
      headers: assistedHeaders,
    }),
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
  await closePrivacyFixtureApplication(api);
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
    if (
      message.type() === "error" &&
      !/\b(?:40[13]|503)\b/.test(message.text())
    )
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
  adminCookies = await page.context().cookies();
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

test("assisted subject choices and Care manual intake preserve real actors, withdrawal and permanent deletion", async ({
  page,
  browser,
}) => {
  const buyer = await sessionPage(
    await browser.newContext(),
    productSession,
    `assisted?projectId=${assistedProjectId}`,
  );
  await expect(
    buyer.getByText("本人在场，同机协助", { exact: true }),
  ).toBeVisible();
  const collection = buyer
    .locator(".paper")
    .filter({ has: buyer.getByText("采集并保存讲述和照片", { exact: true }) });
  let releaseConsent;
  const consentGate = new Promise((resolve) => {
    releaseConsent = resolve;
  });
  await buyer.route("**/assisted-sessions", async (route) => {
    if (route.request().method() === "POST") await consentGate;
    await route.continue();
  });
  await collection
    .getByRole("button", { name: "本人同意此用途，记录当次证据", exact: true })
    .click();
  await expect(
    buyer.getByText("正在查询或保存，请稍候…", { exact: true }),
  ).toBeVisible();
  await expect(
    collection.getByRole("button", {
      name: "本人同意此用途，记录当次证据",
      exact: true,
    }),
  ).toBeDisabled();
  const consentResponse = buyer.waitForResponse(
    (r) =>
      r.url().endsWith("/assisted-sessions") && r.request().method() === "POST",
  );
  releaseConsent();
  const consentHttp = await consentResponse;
  expect(consentHttp.status(), await consentHttp.text()).toBe(201);
  await expect(buyer.getByText("当次许可有效", { exact: true })).toBeVisible();
  await buyer.unroute("**/assisted-sessions");
  const ai = buyer
    .locator(".paper")
    .filter({ has: buyer.getByText("交由 AI 处理素材", { exact: true }) });
  await ai.getByRole("button", { name: "本人拒绝此用途", exact: true }).click();
  await expect(buyer.getByText("本人已拒绝", { exact: true })).toBeVisible();
  const sharing = buyer.locator(".paper").filter({
    has: buyer.getByText("向本项目发起人共享资料", { exact: true }),
  });
  await buyer.route(
    "**/assisted-sessions",
    (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "NOT_CONFIGURED", message: "synthetic unavailable" },
          meta: { requestId: "synthetic" },
        }),
      }),
    { times: 1 },
  );
  await sharing
    .getByRole("button", { name: "本人同意此用途，记录当次证据", exact: true })
    .click();
  await expect(buyer.getByText(/操作未确认，请重新查询/)).toBeVisible();
  await buyer
    .getByRole("button", { name: "重新查询协助与工单状态", exact: true })
    .click();
  // Explicit expired-session fixture; observe its state only through the real
  // session HTTP and rendered page, without waiting for a short natural TTL.
  const expiredDb = new PrismaClient({ datasourceUrl: databaseUrl });
  const subject = await expiredDb.projectSubject.findUnique({
    where: { projectId: assistedProjectId },
  });
  const project = await expiredDb.project.findUnique({
    where: { id: assistedProjectId },
  });
  await expiredDb.assistedSession.create({
    data: {
      id: randomUUID(),
      projectId: assistedProjectId,
      subjectId: subject.id,
      operatorUserId: productSession.user.id,
      purpose: "collection",
      granted: true,
      noticeVersion: "synthetic-d08-v1",
      evidenceRef: `synthetic:expired-fixture-${randomUUID()}`,
      bindingVersion: 0,
      accessEpoch: project.accessEpoch,
      idempotencyKey: randomUUID(),
      requestHash: "f".repeat(64),
      createdAt: new Date(Date.now() - 20 * 60000),
      expiresAt: new Date(Date.now() - 5 * 60000),
    },
  });
  await expiredDb.$disconnect();
  await buyer
    .getByRole("button", { name: "重新查询协助与工单状态", exact: true })
    .click();
  await expect(
    buyer.getByText("证据已过期，请取得新的当次证据", { exact: true }),
  ).toBeVisible();
  await expect(
    buyer.getByText(/当次有效期至：.*设备时间 UTC\+08:00/).first(),
  ).toBeVisible();
  const renewalResponse = buyer.waitForResponse(
    (r) =>
      r.url().endsWith("/assisted-sessions") && r.request().method() === "POST",
  );
  await collection
    .getByRole("button", { name: "本人同意此用途，记录当次证据", exact: true })
    .click();
  const renewalHttp = await renewalResponse;
  expect(renewalHttp.status(), await renewalHttp.text()).toBe(201);
  const renewalBody = renewalHttp.request().postDataJSON();
  expect(renewalBody.expectedSessionId).toBeTruthy();
  await expect(buyer.getByText("当次许可有效", { exact: true })).toBeVisible();
  await buyer
    .getByRole("button", { name: "记录本人完整资料导出申请", exact: true })
    .click();
  await expect(
    buyer.getByText(
      "本人申请已记录，等待客服核验；导出交付与删除执行尚未完成",
      { exact: true },
    ),
  ).toBeVisible();
  await buyer.reload();
  await expect(buyer.getByText(/资料导出：待客服核验/)).toBeVisible();
  for (const width of [390, 768]) {
    await buyer.setViewportSize({ width, height: 900 });
    const metrics = await buyer.locator(".assisted-page").evaluate((el) => ({
      overflow: el.scrollWidth > el.clientWidth,
      body: parseFloat(getComputedStyle(el).fontSize),
      buttons: [...el.querySelectorAll("button")].map((b) => ({
        w: b.getBoundingClientRect().width,
        h: b.getBoundingClientRect().height,
      })),
    }));
    expect(metrics.overflow).toBe(false);
    expect(metrics.body).toBeGreaterThanOrEqual(20);
    expect(metrics.buttons.every((b) => b.w >= 48 && b.h >= 48)).toBe(true);
  }
  await buyer.screenshot({ path: "/tmp/timenook-t12-assisted-mobile.png" });
  if (adminCookies) {
    await page.context().addCookies(adminCookies);
    await page.goto("./");
  } else {
    await page.goto("./");
    await page.getByLabel("管理员账号").fill(account.username);
    await page.getByLabel("密码", { exact: true }).fill(account.password);
    await page.getByRole("button", { name: "继续验证" }).click();
    const secret = await page.getByTestId("enrollment-secret").textContent();
    await page.getByLabel("六位验证码").fill(await generate({ secret }));
    await page.getByRole("button", { name: "验证并登录" }).click();
  }
  await page.getByRole("button", { name: "客服工单", exact: true }).click();
  await expect(page.getByLabel("代录项目编号")).toBeVisible();
  await page.getByLabel("代录项目编号").fill(assistedProjectId);
  await page.getByLabel("代录申请类型").selectOption("withdraw");
  await page.getByRole("button", { name: "代录本人申请", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "本人撤回申请", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "核验本人申请", exact: true }),
  ).toBeDisabled();
  await page
    .getByLabel("D08 核验证据引用")
    .fill("synthetic:browser独立撤回核验");
  await page.getByRole("button", { name: "核验本人申请", exact: true }).click();
  await expect(
    page.getByText("本人申请已核验，导出交付与后续联动仍待对应流程处理。", {
      exact: true,
    }),
  ).toBeVisible();
  await buyer
    .getByRole("button", { name: "重新查询协助与工单状态", exact: true })
    .click();
  await expect(
    buyer.getByText(/撤回：当前访问已撤销，后续联动待处理/),
  ).toBeVisible();
  await page.screenshot({ path: "/tmp/timenook-t12-care-rights-desktop.png" });
  await buyer.goto(
    `http://127.0.0.1:5174/#/welcome?projectId=${assistedProjectId}`,
  );
  await expect(buyer.getByText(/撤回工单：record:/)).toBeVisible();
  await expect(
    buyer.getByText("处理状态：当前访问已撤销，后续联动待处理", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    buyer.getByRole("button", {
      name: "提交客服本人账号绑定申请",
      exact: true,
    }),
  ).toBeVisible();
  // Permanent deletion is the final operation: its tombstone must not be
  // treated as the old T12 pending placeholder or used to reauthorize a case.
  await page.getByLabel("代录申请类型").selectOption("delete");
  await page.getByRole("button", { name: "代录本人申请", exact: true }).click();
  await expect(
    page.getByText("代录申请已记录，等待独立核验。", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "本人删除申请", exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("D08 核验证据引用")
    .fill("synthetic:browser无微信本人核验");
  await page.getByRole("button", { name: "核验本人申请", exact: true }).click();
  await expect(
    page.getByText(
      "本人删除已核验，在线访问立即停止且项目删除不可逆；各层清理按下方独立证据处理。",
      { exact: true },
    ),
  ).toBeVisible();
  const unavailable = await buyer.request.get(
    `http://127.0.0.1:3418/v1/projects/${assistedProjectId}/plan`,
    { headers: { authorization: `Bearer ${productSession.session.token}` } },
  );
  expect(unavailable.status()).toBe(403);
  expect(runtimeErrors).toEqual([]);
});
