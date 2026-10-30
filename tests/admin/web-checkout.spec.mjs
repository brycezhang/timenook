import { chooseDefaultQuestion } from "./recording-step-helper.mjs";

import { test, expect } from "@playwright/test";
import { randomUUID, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { get as httpsGet } from "node:https";
import {
  createPrivacyFixtureApplication,
  closePrivacyFixtureApplication,
} from "./privacy-fixture.mjs";
const apiRequire = createRequire(resolve("apps/api/package.json"));
const { PrismaClient } = apiRequire("@prisma/client");
const Redis = apiRequire("ioredis");
const origin = "https://127.0.0.1:4337";
const schema = `web_checkout_${randomUUID().replaceAll("-", "")}`;
let app, server, config, root;

test.beforeAll(async () => {
  if (existsSync(".env")) process.loadEnvFile(".env");
  root = await mkdtemp(join(tmpdir(), "timenook-web-checkout-"));
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set("schema", schema);
  const migration = spawnSync(
    process.execPath,
    ["node_modules/prisma/build/index.js", "migrate", "deploy"],
    {
      cwd: resolve("apps/api"),
      env: { ...process.env, DATABASE_URL: url.toString() },
      stdio: "pipe",
    },
  );
  expect(migration.status, "isolated migrations").toBe(0);
  config = {
    environment: "test",
    host: "127.0.0.1",
    port: 3457,
    databaseUrl: url.toString(),
    redisUrl: process.env.REDIS_URL,
    redisKeyPrefix: schema,
    acceptance: {
      mode: "internal-acceptance",
      profileVersion: "internal-acceptance-v1",
    },
    web: {
      origin,
      sessionKey: randomBytes(32).toString("base64"),
      loginTtlSeconds: 900,
      sessionTtlSeconds: 43200,
    },
  };
  app = await createPrivacyFixtureApplication(config);
  await app.listen(3457, "127.0.0.1");
  const cert = join(root, "cert.pem"),
    key = join(root, "key.pem");
  expect(
    spawnSync(
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
        "/CN=127.0.0.1",
      ],
      { stdio: "ignore" },
    ).status,
  ).toBe(0);
  server = spawn(
    process.execPath,
    [
      resolve("node_modules/vite/bin/vite.js"),
      "preview",
      "--port",
      "4337",
      "--strictPort",
    ],
    {
      cwd: resolve("apps/web"),
      stdio: "ignore",
      env: {
        ...process.env,
        TIMENOOK_WEB_TLS_CERT: cert,
        TIMENOOK_WEB_TLS_KEY: key,
        TIMENOOK_WEB_API_TARGET: "http://127.0.0.1:3457",
      },
    },
  );
  await expect
    .poll(
      () =>
        new Promise((resolve) => {
          const request = httpsGet(
            origin + "/app/",
            { rejectUnauthorized: false },
            (response) => {
              response.resume();
              resolve(response.statusCode);
            },
          );
          request.on("error", () => resolve(0));
        }),
      { timeout: 15000 },
    )
    .toBe(200);
});
test.afterAll(async () => {
  server?.kill("SIGTERM");
  await closePrivacyFixtureApplication(app);
  if (!config) return;
  const db = new PrismaClient({ datasourceUrl: config.databaseUrl }),
    redis = new Redis(config.redisUrl);
  try {
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    const keys = await redis.keys(`${schema}:*`);
    if (keys.length) await redis.del(...keys);
  } finally {
    await db.$disconnect();
    redis.disconnect();
    await rm(root, { recursive: true, force: true });
  }
});

test("normal login, cancel or mock payment, project creation, invitation, consent and narration are operable", async ({
  page,
  browser,
}) => {
  test.setTimeout(120000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const shots = "/tmp/timenook-ui3-123";
  await mkdir(shots, { recursive: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(async () => {
    await page.goto(`${origin}/app/`);
    await expect(
      page.getByRole("button", { name: "进入内测", exact: true }),
    ).toBeVisible();
  }).toPass();
  await page.screenshot({ path: `${shots}/login-mobile.png` });
  await page.getByRole("button", { name: "进入内测", exact: true }).click();
  await page
    .getByRole("button", { name: "开始制作我的故事书", exact: true })
    .click();
  await page.getByRole("button", { name: "送给爸爸", exact: false }).click();
  await expect(page.getByRole("heading", { name: "爸爸的一生" })).toBeVisible();
  const pay = page.getByRole("button", {
    name: "模拟支付，创建项目",
    exact: true,
  });
  await expect(pay).toBeDisabled();
  await page.getByRole("checkbox").check();
  await pay.click();
  await page.getByRole("button", { name: "取消支付", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.screenshot({ path: `${shots}/purchase-mobile.png` });
  await pay.click();
  await page
    .getByRole("button", { name: "确认支付（模拟）", exact: true })
    .click();
  await expect(
    page.getByText("模拟支付成功 · 未扣款", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.locator('[name="bookTitle"]').fill("爸爸的时光手记");
  await page
    .getByRole("button", { name: "创建我的故事书", exact: true })
    .click();
  await expect(page.locator(".live-project > .title")).toHaveText(
    "爸爸的时光手记",
  );
  // No shared-reading consent exists yet. The next action must remain usable.
  await page
    .getByRole("button", { name: "邀请家人开始讲述", exact: true })
    .click();
  await page.getByRole("button", { name: "准备本人邀请", exact: true }).click();
  await page.evaluate(() => {
    navigator.clipboard.writeText = async (value) => {
      window.testInvitation = value;
    };
  });
  await page
    .getByRole("button", { name: "复制网页邀请链接", exact: true })
    .click();
  const invitation = await page.evaluate(() => window.testInvitation);
  expect(new URL(invitation).pathname).toMatch(/^\/app\/invitation\//);
  const narratorContext = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 844 },
  });
  try {
    const narrator = await narratorContext.newPage();
    narrator.on("pageerror", (e) => errors.push(e.message));
    await narrator.goto(invitation);
    await narrator
      .getByRole("button", { name: "进入内测", exact: true })
      .click();
    await narrator
      .getByRole("button", { name: "已读说明，申请本人参与", exact: true })
      .click();
    await page
      .getByRole("button", { name: "重新查询参与状态", exact: true })
      .click();
    await page
      .getByRole("button", { name: "已核对本人，确认绑定", exact: true })
      .click();
    await expect(page.getByText(/已绑定。本人须分别授权/)).toBeVisible();
    await narrator
      .getByRole("button", { name: "重新查询参与状态", exact: true })
      .click();
    const membership = narrator.getByRole("button", {
      name: /查看本人的用途选择/,
    });
    if (await membership.isVisible()) await membership.click();
    for (const text of [
      "采集并保存讲述和照片",
      "交由AI处理素材",
      "向本项目发起人共享资料",
    ]) {
      await narrator
        .locator(".paper")
        .filter({ hasText: text })
        .getByRole("button", { name: "同意此用途", exact: true })
        .click();
    }
    await narrator
      .getByRole("button", { name: "进入本人参与的项目", exact: true })
      .click();
    await expect(narrator.locator(".live-project > .title")).toHaveText(
      "爸爸的时光手记",
    );
    await narrator.screenshot({ path: `${shots}/project-mobile.png` });
    await narrator
      .getByRole("button", { name: "个人大纲与问题", exact: true })
      .click();
    const chapter = narrator.locator(".chapter input").first();
    await chapter.fill("");
    await chapter.pressSequentially("童年的老房子", { delay: 50 });
    await expect(chapter).toHaveValue("童年的老房子");
    await expect(chapter).toBeFocused();
    await narrator
      .getByRole("button", { name: "保存个人计划", exact: true })
      .click();
    await narrator
      .getByRole("button", { name: "返回项目", exact: true })
      .click();
    await narrator
      .getByRole("button", { name: "开始一段讲述", exact: true })
      .click();
    await chooseDefaultQuestion(narrator);
    await expect(
      narrator.getByRole("button", { name: "开始说", exact: true }),
    ).toBeVisible();
    await narrator.screenshot({ path: `${shots}/recording-mobile.png` });
    await narrator.setViewportSize({ width: 1280, height: 900 });
    await narrator.screenshot({ path: `${shots}/recording-desktop.png` });
    expect(
      await narrator.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.getByRole("button", { name: "返回首页", exact: true }).click();
    await page.getByRole("button", { name: "成书", exact: true }).click();
    await expect(page.getByText("我的人生书", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "我的", exact: true }).click();
    await expect(page.locator(".live-account .account-book")).toContainText(
      "爸爸的时光手记",
    );
    for (const width of [320, 375, 390, 430, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.locator("#page")).toBeVisible();
      await expect
        .poll(() =>
          page.evaluate(() => ({
            document: document.documentElement.scrollWidth <= innerWidth,
            content:
              document.querySelector("#page").scrollWidth <=
              document.querySelector("#page").clientWidth,
          })),
        )
        .toEqual({ document: true, content: true });
      if (width > 650) {
        await expect(
          page.getByRole("navigation", { name: "主导航", exact: true }),
        ).toBeVisible();
        expect(
          (await page.locator("#phone").boundingBox()).width,
        ).toBeGreaterThan(900);
        await expect(page.locator(".live-account .tabs")).toHaveCount(0);
        await expect(page.locator("#page .tabs")).toBeHidden();
      } else {
        await expect(page.locator("#page .tabs")).toBeVisible();
        await expect(page.locator(".app-side")).toBeHidden();
      }
      await page.screenshot({ path: `${shots}/account-${width}.png` });
    }
    await page
      .getByRole("button", { name: "资料用途与帮助", exact: true })
      .click();
    await expect(page.getByText("项目服务工单", { exact: true })).toBeVisible();
    await expect(
      page.getByText("暂无服务工单。", { exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: `${shots}/service-desktop.png` });
    await page
      .getByRole("button", {
        name: "返回项目，查看保存与处理详情",
        exact: true,
      })
      .click();
    await expect(page.locator(".live-project > .title")).toHaveText(
      "爸爸的时光手记",
    );
    await expect(page.locator("#capsule")).toHaveCount(0);
  } finally {
    await narratorContext.close();
  }
  const db = new PrismaClient({ datasourceUrl: config.databaseUrl });
  try {
    expect(await db.paymentOrder.count()).toBe(0);
    expect(await db.paymentTransaction.count()).toBe(0);
    expect(await db.internalProjectAdmission.count()).toBe(1);
  } finally {
    await db.$disconnect();
  }
  expect(errors).toEqual([]);
});
