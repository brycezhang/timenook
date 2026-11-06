import {
  feishuIdentity,
  feishuLogin,
  installFeishuAuthorization,
  syntheticFeishuEnv,
} from "../feishu-fixture.mjs";
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
const schema = `users_browser_${randomUUID().replaceAll("-", "")}`;
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
const buyerId = randomUUID(),
  packageId = randomUUID(),
  userIds = Array.from({ length: 121 }, () => randomUUID()),
  projectId = randomUUID(),
  subjectId = randomUUID(),
  caseId = randomUUID(),
  orderIds = Array.from({ length: 121 }, () => randomUUID());
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
    API_PORT: "3458",
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
    permissions: [
      "orders:read",
      "orders:write",
      "care:write",
      "fulfillment:write",
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
  const db = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    await db.user.create({
      data: {
        id: buyerId,
        identities: { create: { appId: "synthetic-browser", openId: "buyer" } },
      },
    });
    await db.user.createMany({
      data: userIds.map((id, i) => ({
        id,
        createdAt: new Date(1700000000000 + i * 1000),
      })),
    });
    const { ProjectPlans } = apiRequire("./dist/projects/project-plans.js");
    const plans = new ProjectPlans(databaseUrl);
    await plans.createProject({ projectId, createdBy: userIds[0] });
    await plans.close();
    const { internalSnapshot, INTERNAL_PROFILE_VERSION } = apiRequire(
      "./dist/projects/internal-profile.js",
    );
    await db.internalProjectAdmission.create({
      data: {
        id: randomUUID(),
        projectId,
        initiatorUserId: userIds[0],
        provisionKey: randomUUID(),
        requestHash: "a".repeat(64),
        profileVersion: INTERNAL_PROFILE_VERSION,
        snapshot: internalSnapshot(INTERNAL_PROFILE_VERSION),
      },
    });
    await db.projectSubject.create({
      data: { id: subjectId, projectId, name: "无账号浏览器讲述者" },
    });
    await db.careRequest.create({
      data: {
        id: caseId,
        projectId,
        requesterSubjectId: subjectId,
        operatorId: userIds[0],
        operatorRealm: "product",
        sourceBindingVersion: 0,
        sourceAccessEpoch: 0,
        idempotencyKey: caseId,
        requestHash: "b".repeat(64),
        kind: "delete",
        state: "open",
      },
    });
    const draftId = randomUUID();
    await db.packageDraft.create({
      data: {
        id: draftId,
        realm: "local",
        title: "合成套餐",
        d01: {},
        admission: {},
        shippingRegionLabels: {},
      },
    });
    await db.packageVersion.create({
      data: {
        id: packageId,
        realm: "local",
        purpose: "local_preview",
        draftId,
        draftRevision: 1,
        snapshot: {},
        publicOffer: {},
      },
    });
    await db.paymentOrder.createMany({
      data: orderIds.map((id, i) => ({
        id,
        buyerId,
        appId: "synthetic-browser",
        openId: "buyer",
        merchantId: "synthetic",
        outTradeNo: `BROWSER-ORDER-${String(i).padStart(3, "0")}`,
        idempotencyKey: id,
        requestHash: "a".repeat(64),
        amount: i === 0 ? 1 : 99900,
        listAmount: 99900,
        isE2e: i === 0,
        currency: "CNY",
        mode: "wechat",
        packageVersionId: packageId,
        packageSnapshot: {},
        recipient: {},
        template: {},
        subjectName: "合成讲述者",
        bookTitle: "合成书名",
        state: i === 0 ? "paid" : "pending",
        createdAt: new Date(1700000000000 + i * 1000),
      })),
    });
    await db.paymentTransaction.create({
      data: {
        orderId: orderIds[0],
        providerTransactionId: "synthetic-browser-paid",
        paidAt: new Date("2026-11-02T01:00:00Z"),
        amount: 1,
        currency: "CNY",
      },
    });
  } finally {
    await db.$disconnect();
  }
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
        ADMIN_API_TARGET: "http://127.0.0.1:3458",
        ADMIN_TLS_CERT: cert,
        ADMIN_TLS_KEY: key,
      },
    },
  );
  await waitFor("http://127.0.0.1:3458/health/live");
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
test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus) {
    console.error((await page.locator("body").innerText()).slice(0, 3000));
    console.error(logs.slice(-10).join("\n"));
    await page.screenshot({
      path: "/tmp/timenook-admin-implementation/152-failure.png",
      fullPage: true,
    });
  }
});
test("HTTPS operator discovers pending orderless narrators, opens linked account and project, adds notes and preserves list query", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("./users?page=7&pageSize=20");
  await feishuLogin(page, account);
  await expect(
    page.getByRole("heading", { name: "用户管理", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("共 123 条用户或讲述者", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "搜索用户" })
    .fill("无账号浏览器讲述者");
  await page.getByRole("button", { name: "查询", exact: true }).click();
  await expect(
    page.getByText("共 2 条用户或讲述者", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: userIds[0], exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "用户详情", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("内部验收项目 · 无付款、无生产权益", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "用户内部备注", exact: true })
    .fill("浏览器合成用户备注");
  await page.getByRole("button", { name: "追加用户备注", exact: true }).click();
  await expect(page.getByText("备注已保存。", { exact: true })).toBeVisible();
  await page.reload();
  await expect(
    page.getByText("浏览器合成用户备注", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "无账号浏览器讲述者", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "项目详情", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: `查看 ${caseId}`, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "代录项目编号", exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "项目详情", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "返回关联列表", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "用户详情", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "返回用户列表", exact: true }).click();
  await expect(page).toHaveURL(/q=/);
  await expect(
    page.getByText("共 2 条用户或讲述者", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "无账号浏览器讲述者", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "项目详情", exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "/tmp/timenook-admin-implementation/152-mobile.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "运营登录", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("无账号浏览器讲述者", { exact: true }),
  ).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("account permission revocation clears detail and denies user queries", async ({
  page,
}) => {
  await page.goto(`./users/${userIds[0]}`);
  await feishuLogin(page, account);
  await expect(
    page.getByRole("heading", { name: "用户详情", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "用户内部备注", exact: true })
    .fill("本次失权测试备注");
  await page.getByRole("button", { name: "追加用户备注", exact: true }).click();
  await expect(
    page.getByText("本次失权测试备注", { exact: true }),
  ).toBeVisible();
  const db = new PrismaClient({ datasourceUrl: databaseUrl });
  await db.adminAccount.updateMany({
    where: { username: account.username },
    data: { permissions: ["orders:read"] },
  });
  await db.$disconnect();
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(page).toHaveURL(/\/403$/);
  await expect(page.getByText("本次失权测试备注", { exact: true })).toHaveCount(
    0,
  );
  const result = await page.request.get("/api/v1/admin/users");
  expect(result.status()).toBe(403);
});
