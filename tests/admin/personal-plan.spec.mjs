import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
const apiRequire = createRequire(resolve("apps/api/package.json"));
const { PrismaClient } = apiRequire("@prisma/client");
const Redis = apiRequire("ioredis");
const schema = `t13_browser_${randomUUID().replaceAll("-", "")}`;
let api, preview, databaseUrl, projectId, buyer, narrator;
const errors = [];
const base = "http://127.0.0.1:5174";
const data = (r, status = 201) => {
  expect(r.statusCode, r.body).toBe(status);
  expect(r.json().error).toBeUndefined();
  return r.json().data;
};
function request(method, url, session, payload) {
  return api.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${session.session.token}`,
      "idempotency-key": randomUUID(),
    },
    ...(payload ? { payload } : {}),
  });
}
async function login(who) {
  return data(
    await api.inject({
      method: "POST",
      url: "/v1/sessions/wechat",
      payload: { code: `${who}:${randomUUID()}` },
    }),
  );
}
test.beforeAll(async () => {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set("schema", schema);
  databaseUrl = url.toString();
  const migrated = spawnSync(
    process.execPath,
    ["node_modules/prisma/build/index.js", "migrate", "deploy"],
    {
      cwd: resolve("apps/api"),
      env: { ...process.env, DATABASE_URL: databaseUrl },
      encoding: "utf8",
    },
  );
  expect(migrated.status, "isolated migrations").toBe(0);
  const { createApplication } = apiRequire("./dist-test/src/application.js");
  const { paymentConfig, paymentFetch, paid } = apiRequire(
    "./dist-test/test/payment-fixture.js",
  );
  api = await createApplication(
    {
      environment: "test",
      host: "127.0.0.1",
      port: 3421,
      databaseUrl,
      redisUrl: process.env.REDIS_URL,
      redisKeyPrefix: schema,
      wechat: { appId: paymentConfig.appId, secret: "synthetic" },
      payments: paymentConfig,
      participation: { mode: "synthetic-d08" },
    },
    {
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
    },
  );
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
        price: { value: 99900, unit: "fen", currency: "CNY" },
      },
    },
  });
  await db.$disconnect();
  buyer = await login("synthetic-plan-buyer");
  narrator = await login("synthetic-plan-narrator");
  const order = data(
    await request("POST", "/v1/orders", buyer, {
      packageVersionId: versionId,
      recipient: { relationshipLabel: "朋友" },
      shippingRegionCode: "CN-110000",
    }),
  );
  data(await request("POST", `/v1/orders/${order.id}/payment`, buyer, {}));
  paid(order.outTradeNo);
  projectId = data(await request("GET", `/v1/orders/${order.id}`, buyer), 200)
    .project.id;
  const invitation = data(
    await request("POST", `/v1/projects/${projectId}/invitations`, buyer, {}),
  );
  const application = data(
    await request(
      "POST",
      `/v1/invitations/${invitation.token}/requests`,
      narrator,
      {
        noticeVersion: "synthetic-d08-v1",
        evidenceRef: "synthetic:browser本人申请",
      },
    ),
  );
  data(
    await request(
      "POST",
      `/v1/binding-requests/${application.id}/approve`,
      buyer,
      { expectedBindingVersion: 0, evidenceRef: "synthetic:browser核对申请者" },
    ),
  );
  for (const purpose of ["collection", "sharing"]) {
    const state = data(
      await request("GET", `/v1/projects/${projectId}/participation`, narrator),
      200,
    );
    data(
      await request("POST", `/v1/projects/${projectId}/consents`, narrator, {
        purpose,
        granted: true,
        noticeVersion: "synthetic-d08-v1",
        evidenceRef: "synthetic:browser本人选择",
        expectedBindingVersion: state.bindingVersion,
        expectedAccessEpoch: state.accessEpoch,
      }),
    );
  }
  await api.listen(3421, "127.0.0.1");
  preview = spawn(
    process.execPath,
    [
      "node_modules/vite/bin/vite.js",
      "--host",
      "127.0.0.1",
      "--port",
      "5174",
      "--strictPort",
    ],
    {
      cwd: resolve("."),
      env: {
        ...process.env,
        TIMENOOK_API_BASE_URL: `${base}/timenook/v1`,
        TIMENOOK_PREVIEW_API_TARGET: "http://127.0.0.1:3421",
      },
      stdio: "ignore",
    },
  );
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(base)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Preview did not start");
});
test.afterAll(async () => {
  if (preview && preview.exitCode === null)
    await new Promise((r) => {
      preview.once("exit", r);
      preview.kill("SIGTERM");
    });
  await api?.close();
  if (databaseUrl) {
    const db = new PrismaClient({ datasourceUrl: databaseUrl });
    const redis = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    redis.on("error", () => {});
    try {
      await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      const keys = await redis.keys(`${schema}:*`);
      if (keys.length) await redis.del(...keys);
    } finally {
      await db.$disconnect();
      redis.disconnect();
    }
  }
});
async function pageFor(browser, session) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !/\b(?:40[139]|503)\b/.test(message.text())
    )
      errors.push(message.text());
  });
  await page.goto(base);
  await page.evaluate(
    ({ session, base }) => {
      localStorage.setItem("timenook.mode.v1", JSON.stringify("live"));
      localStorage.setItem(
        `timenook.session.v1:${base}/timenook/v1`,
        JSON.stringify(session),
      );
    },
    { session, base },
  );
  await page.goto(`${base}/#/welcome?projectId=${projectId}`);
  await page
    .getByRole("button", { name: "编辑个人大纲与问题", exact: true })
    .click();
  await expect(page.locator(".plan-page .title")).toBeVisible();
  await expect(page.getByPlaceholder("章节标题").first()).toHaveValue(
    "记得的地方",
  );
  return page;
}
test("both roles edit their actual personal plan, preserve subject choices, show a real 409 and save a blank plan", async ({
  browser,
}) => {
  const initiator = await pageFor(browser, buyer);
  const subject = await pageFor(browser, narrator);
  await subject
    .getByRole("button", { name: "不适用", exact: true })
    .first()
    .click();
  await expect(
    subject.getByText("本人选择：不适用", { exact: true }),
  ).toBeVisible();
  await subject.getByPlaceholder("不再主动提问的主题").fill("工作");
  await subject
    .getByRole("button", { name: "本人选择不再问此主题", exact: true })
    .click();
  await expect(subject.getByText("工作", { exact: true })).toBeVisible();
  await initiator.getByPlaceholder("章节标题").first().fill("我自己选的地方");
  await initiator
    .getByPlaceholder("自拟问题")
    .first()
    .fill("那条小路，你还记得什么？");
  await initiator
    .getByRole("button", { name: "保存个人计划", exact: true })
    .click();
  await expect(
    initiator.getByText("个人计划已保存；已回答内容和本人偏好继续保留。", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    initiator.getByText("本人选择：不适用", { exact: true }),
  ).toBeVisible();
  await expect(initiator.getByText("工作", { exact: true })).toBeVisible();
  await expect(
    initiator.getByRole("button", {
      name: "本人明确重新启用此主题",
      exact: true,
    }),
  ).toHaveCount(0);
  await subject.getByPlaceholder("章节标题").first().fill("另一方的修改草稿");
  const conflict = subject.waitForResponse(
    (r) =>
      r.url().endsWith(`/projects/${projectId}/plan`) &&
      r.request().method() === "POST",
  );
  await subject
    .getByRole("button", { name: "保存个人计划", exact: true })
    .click();
  expect((await conflict).status()).toBe(409);
  await expect(subject.getByText(/编辑冲突：保留了你的修改/)).toBeVisible();
  await expect(subject.getByPlaceholder("章节标题").first()).toHaveValue(
    "另一方的修改草稿",
  );
  await subject.locator("#page").evaluate((el) => {
    el.scrollTop = 0;
  });
  await subject.screenshot({ path: "/tmp/timenook-t13-conflict-mobile.png" });
  await subject
    .getByRole("button", { name: "重新查询并放弃未保存修改", exact: true })
    .click();
  await expect(subject.getByPlaceholder("章节标题").first()).toHaveValue(
    "我自己选的地方",
  );
  await subject
    .getByRole("button", { name: "本人明确重新启用此主题", exact: true })
    .click();
  await expect(
    subject.getByText("尚无禁问主题", { exact: true }),
  ).toBeVisible();
  await subject
    .getByRole("button", { name: "清空个人计划", exact: true })
    .click();
  await subject
    .getByRole("button", { name: "保存个人计划", exact: true })
    .click();
  await expect(
    subject.getByText("个人计划已保存；已回答内容和本人偏好继续保留。", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    subject.getByText("这是一份空白计划，你仍可选择照片或自由讲述。", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(subject.getByText(/照片起讲：/)).toBeVisible();
  await expect(subject.getByText(/自由讲述：/)).toBeVisible();
  for (const width of [390, 768]) {
    await subject.setViewportSize({ width, height: 900 });
    await subject.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    const metrics = await subject.locator(".plan-page").evaluate((el) => ({
      overflow: el.scrollWidth > el.clientWidth,
      font: parseFloat(getComputedStyle(el).fontSize),
      buttons: [...el.querySelectorAll("button")].map((b) => ({
        w: b.getBoundingClientRect().width,
        h: b.getBoundingClientRect().height,
      })),
    }));
    expect(metrics.overflow).toBe(false);
    expect(metrics.font).toBeGreaterThanOrEqual(20);
    expect(metrics.buttons.every((b) => b.w >= 48 && b.h >= 48)).toBe(true);
  }
  await subject.locator("#page").evaluate((el) => {
    el.scrollTop = 0;
  });
  await subject.screenshot({ path: "/tmp/timenook-t13-blank-tablet.png" });
  for (const page of [subject, initiator]) {
    expect(
      await page.locator("vite-error-overlay,.preview-error").count(),
    ).toBe(0);
    expect(await page.title()).toContain("时光里");
  }
  expect(errors).toEqual([]);
});
