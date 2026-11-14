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
const buyerId = randomUUID(),
  packageId = randomUUID(),
  orderIds = Array.from({ length: 121 }, () => randomUUID());
test.beforeAll(async () => {
  test.setTimeout(120000);
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
        snapshot: { title: "合成渠道套餐" },
        publicOffer: { title: "合成渠道套餐", price: { value: 99900 } },
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
        purchaseKind: "gift",
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
  const build = spawnSync(
    process.execPath,
    ["node_modules/vite/bin/vite.js", "build"],
    { cwd: resolve("apps/admin"), env: process.env, encoding: "utf8" },
  );
  expect(build.status, build.stdout + build.stderr).toBe(0);
  vite = start(
    process.execPath,
    [
      "node_modules/vite/bin/vite.js",
      "preview",
      "--host",
      "localhost",
      "--port",
      "3443",
    ],
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
test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus) {
    console.error((await page.locator("body").innerText()).slice(0, 3000));
    console.error(logs.slice(-10).join("\n"));
    await page.screenshot({
      path: "/tmp/timenook-admin-implementation/151-failure.png",
      fullPage: true,
    });
  }
});
test("HTTPS operator searches historical orders, navigates actual Vben tabs/detail, appends notes and preserves query location", async ({
  page,
  context,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("./orders?page=7&pageSize=20");
  await expect(page.getByRole("heading", { name: "运营登录" })).toBeVisible();
  await page.screenshot({
    path: "/tmp/timenook-admin-implementation/151-login.png",
    fullPage: true,
  });
  await feishuLogin(page, account);
  await expect(
    page.getByRole("heading", { name: "订单管理", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("BROWSER-ORDER-000", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("2023-11-15 06:13:20", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "搜索订单" })
    .fill("BROWSER-ORDER-000");
  await page.getByRole("button", { name: "查询", exact: true }).click();
  await expect(page.getByText("共 1 条订单", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "BROWSER-ORDER-000", exact: true })
    .click();
  await expect(
    page.getByText("2026-11-02 09:00:00", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "订单详情", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("受控 1 分验收订单", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("¥999.00", { exact: true })).toBeVisible();
  await expect(page.getByText("¥0.01", { exact: true })).toHaveCount(2);
  await page
    .getByRole("textbox", { name: "内部备注", exact: true })
    .fill("合成浏览器沟通备注");
  await page.getByRole("button", { name: "追加备注", exact: true }).click();
  await expect(page.getByText("备注已保存。", { exact: true })).toBeVisible();
  await page.reload();
  await expect(
    page.getByText("合成浏览器沟通备注", { exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: buyerId, exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "用户详情", exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: "订单详情", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "返回订单列表", exact: true }).click();
  await expect(page).toHaveURL(/q=BROWSER-ORDER-000/);
  await expect(page.getByText("共 1 条订单", { exact: true })).toBeVisible();
  await page.goto("./missing-route");
  await expect(
    page.getByText("页面不存在", { exact: true }).last(),
  ).toBeVisible();
  await page.goto(`./orders/${orderIds[0]}`);
  await expect(
    page.getByText("合成浏览器沟通备注", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "/tmp/timenook-admin-implementation/151-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("heading", { name: "订单详情", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "/tmp/timenook-admin-implementation/151-mobile.png",
    fullPage: true,
  });
  const cookies = await context.cookies(
    "https://localhost:3443/api/v1/admin/orders",
  );
  const cookie = cookies.find((c) => c.name === "__Secure-timenook_admin");
  expect(cookie.secure && cookie.httpOnly && cookie.sameSite === "Strict").toBe(
    true,
  );
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await expect(page.getByRole("heading", { name: "运营登录" })).toBeVisible();
  await expect(
    page.getByText("合成浏览器沟通备注", { exact: true }),
  ).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("read-only admin cannot write notes or open protected user routes and revoked authority clears private details", async ({
  page,
}) => {
  const restricted = {
    ...account,
    ...feishuIdentity(),
    username: `reader-${randomUUID()}`,
    permissions: ["orders:read"],
  };
  const input = join(privateDir, "reader.json");
  writeFileSync(input, JSON.stringify(restricted), { mode: 0o600 });
  const created = spawnSync(
    process.execPath,
    ["dist/admin/admin-cli.js", "create", "--input-file", input],
    { cwd: apiCwd, env, encoding: "utf8" },
  );
  expect(created.status).toBe(0);
  const adminId = JSON.parse(created.stdout).id;
  await page.goto(`./orders/${orderIds[0]}`);
  await feishuLogin(page, restricted);
  await expect(
    page.getByRole("heading", { name: "订单详情", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "追加备注", exact: true }),
  ).toHaveCount(0);
  await page.goto(`./users/${buyerId}`);
  await expect(page).toHaveURL(/\/403$/);
  await page.goto(`./orders/${orderIds[0]}`);
  await expect(
    page.getByText("BROWSER-ORDER-000", { exact: true }),
  ).toBeVisible();
  const db = new PrismaClient({ datasourceUrl: databaseUrl });
  await db.adminAccount.update({
    where: { id: adminId },
    data: { disabled: true },
  });
  await db.$disconnect();
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(page.getByRole("heading", { name: "运营登录" })).toBeVisible();
  await expect(
    page.getByText("合成浏览器沟通备注", { exact: true }),
  ).toHaveCount(0);
});

test("channel phone-only entry preserves a lost-response submission across reload and explicitly starts the next purchase", async ({
  page,
}) => {
  await page.goto("./orders");
  await feishuLogin(page, account);
  await expect(
    page.getByRole("heading", { name: "订单管理", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "购买者手机号", exact: true })
    .fill("13800001234");
  let submitted;
  await page.route("**/api/v1/admin/channel-gifts", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    submitted = (await response.json()).data;
    await route.abort("failed");
  });
  await page
    .getByRole("button", { name: "确认购买并录入", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("重试本次录入");
  expect(submitted.paidAmount).toBeNull();
  expect(submitted.paidAt).toBeNull();
  await page.unroute("**/api/v1/admin/channel-gifts");
  await page.reload();
  await expect(
    page.getByRole("textbox", { name: "购买者手机号", exact: true }),
  ).toHaveValue("13800001234");
  await page.getByRole("button", { name: "重试本次录入", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(
    submitted.internalNumber,
  );
  await expect(
    page.getByText(submitted.internalNumber, { exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByText("实付金额 未提供", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("付款时间 未提供", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("套餐标价 ¥999.00", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "录入新的一笔", exact: true }).click();
  await page
    .getByRole("textbox", { name: "购买者手机号", exact: true })
    .fill("13800001234");
  await page.locator("summary").click();
  await page
    .getByRole("textbox", { name: "原订单号", exact: true })
    .fill("小店订单-002");
  await page
    .getByRole("textbox", { name: "实付金额（元）", exact: true })
    .fill("888.88");
  await page.getByLabel("付款时间", { exact: true }).fill("2026-11-14T09:30");
  await page
    .getByRole("button", { name: "确认购买并录入", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("录入成功");
  await expect(
    page.getByText("实付金额 ¥888.88", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("原订单号 小店订单-002", { exact: true }),
  ).toBeVisible();
  const data = await page.evaluate(
    async () =>
      (await (await fetch("/api/v1/admin/channel-gifts")).json()).data,
  );
  expect(
    data.filter((row) => row.buyerPhone === "+8613800001234"),
  ).toHaveLength(2);
  expect(data.every((row) => row.projectId === null)).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
