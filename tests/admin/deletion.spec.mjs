import { test, expect } from "@playwright/test";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { resolve, join } from "node:path";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import https from "node:https";

// Browser plugin not available. Real Page/Vben + HTTP/PostgreSQL/Redis/private journal;
// only provider protocols use the existing isolated synthetic fixture.
const apiRequire = createRequire(resolve("apps/api/package.json"));
const origin = `http://127.0.0.1:${process.env.TIMENOOK_T26_PREVIEW_PORT ?? "5208"}`;
const apiOrigin = `http://127.0.0.1:${process.env.TIMENOOK_T26_API_PORT ?? "3490"}`;
const adminOrigin = `https://localhost:${process.env.TIMENOOK_T26_ADMIN_PORT ?? "3493"}`;
let fixture, project, preview, adminVite, privateDir, adminHeaders;
let narratorSession, buyerSession;
const errors = [];
const observedPages = [];

function start(args, options) {
  return spawn(process.execPath, args, { ...options, stdio: "ignore" });
}
async function stop(child) {
  if (child?.exitCode !== null) return;
  await new Promise((done) => {
    child.once("exit", done);
    child.kill("SIGTERM");
  });
}
async function ready(url) {
  await expect
    .poll(
      async () => {
        if (url.startsWith("https:"))
          return new Promise((done) => {
            https
              .get(url, { rejectUnauthorized: false }, (response) => {
                response.resume();
                done(response.statusCode);
              })
              .on("error", () => done(0));
          });
        return fetch(url)
          .then((r) => r.status)
          .catch(() => 0);
      },
      { timeout: 30000 },
    )
    .toBe(200);
}

test.beforeAll(async () => {
  if (existsSync(".env")) process.loadEnvFile(".env");
  privateDir = mkdtempSync(join(tmpdir(), "t26-browser-"));
  const previous = process.cwd();
  try {
    process.chdir(resolve("apps/api"));
    fixture = apiRequire("./dist-test/test/book-fixture.js");
    await fixture.startBookFixture();
    const { readyFirstCopyBook } = apiRequire(
      "./dist-test/test/first-copy-fixture.js",
    );
    project = await readyFirstCopyBook();
    fixture.config.admin.origin = adminOrigin;
    await fixture.restartBookApplication();
    const { paymentAdmin } = apiRequire(
      "./dist-test/test/payment-admin-fixture.js",
    );
    adminHeaders = await paymentAdmin(fixture.config, fixture.app, [
      "ops:read",
      "care:write",
      "audit:read",
    ]);
    const session = async (who) =>
      fixture.data(
        await fixture.app.inject({
          method: "POST",
          url: "/v1/sessions/wechat",
          payload: { code: `${who}:${randomUUID()}` },
        }),
      );
    narratorSession = await session(project.narrator.who);
    buyerSession = await session(project.buyer.who);
    await fixture.app.listen(Number(new URL(apiOrigin).port), "127.0.0.1");
  } finally {
    process.chdir(previous);
  }
  const cert = join(privateDir, "cert.pem"),
    key = join(privateDir, "key.pem");
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
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost",
      ],
      { stdio: "ignore" },
    ).status,
  ).toBe(0);
  preview = start(
    [
      "node_modules/vite/bin/vite.js",
      "--host",
      "127.0.0.1",
      "--port",
      new URL(origin).port,
      "--strictPort",
    ],
    {
      cwd: resolve("."),
      env: {
        ...process.env,
        TIMENOOK_API_BASE_URL: `${origin}/timenook/v1`,
        TIMENOOK_PREVIEW_API_TARGET: apiOrigin,
      },
    },
  );
  adminVite = start(
    [
      "node_modules/vite/bin/vite.js",
      "--host",
      "localhost",
      "--port",
      new URL(adminOrigin).port,
    ],
    {
      cwd: resolve("apps/admin"),
      env: {
        ...process.env,
        ADMIN_API_TARGET: apiOrigin,
        ADMIN_TLS_CERT: cert,
        ADMIN_TLS_KEY: key,
      },
    },
  );
  await Promise.all([ready(origin), ready(`${adminOrigin}/timenook/admin/`)]);
});

test.afterAll(async () => {
  await Promise.all([stop(preview), stop(adminVite)]);
  await fixture?.stopBookFixture();
  if (privateDir) rmSync(privateDir, { recursive: true, force: true });
});

test.afterEach(async ({}, info) => {
  if (info.status === info.expectedStatus) return;
  for (const [index, page] of observedPages.entries()) {
    if (page.isClosed()) continue;
    await writeFile(
      `/tmp/timenook-t26-browser-debug-${index}.txt`,
      await page.locator("body").innerText(),
    );
    await page.screenshot({
      path: `/tmp/timenook-t26-browser-failure-${index}.png`,
    });
  }
});

function observe(page) {
  observedPages.push(page);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (
      ["error", "warning"].includes(message.type()) &&
      !/\b(?:401|403|404|409)\b/.test(message.text())
    )
      errors.push(message.text());
  });
}
async function openMini(browser, account, target = project, route = "welcome") {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  observe(page);
  await page.goto(origin);
  await page.evaluate(
    ({ origin, account }) => {
      localStorage.setItem("timenook.mode.v1", JSON.stringify("live"));
      localStorage.setItem(
        `timenook.session.v1:${origin}/timenook/v1`,
        JSON.stringify(account),
      );
    },
    { origin, account },
  );
  await page.goto(`${origin}/#/${route}?projectId=${target.projectId}`);
  await expect(page).toHaveTitle("时光里 · 岁月成书");
  return page;
}
async function openAdmin(browser) {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 900 },
  });
  const split = adminHeaders.cookie.indexOf("=");
  await context.addCookies([
    {
      name: adminHeaders.cookie.slice(0, split),
      value: adminHeaders.cookie.slice(split + 1),
      domain: "localhost",
      path: "/timenook/v1/admin",
      secure: true,
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
  const page = await context.newPage();
  observe(page);
  await page.goto(`${adminOrigin}/timenook/admin/`);
  await expect(page).toHaveTitle("时光里 · 运营管理");
  await expect(page).toHaveURL(`${adminOrigin}/timenook/admin/`);
  await page.getByRole("button", { name: "客服工单", exact: true }).click();
  return page;
}

async function command(page, name, suffix) {
  const pending = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith(suffix),
  );
  await page.getByRole("button", { name, exact: true }).click();
  const r = await pending;
  expect(r.status(), await r.text()).toBe(201);
  return (await r.json()).data;
}

test("本人申请删除、客服核验、在线停止与逐层外部证据保持各自真实进度", async ({
  browser,
}) => {
  const mini = await openMini(browser, narratorSession);
  await expect(
    mini.getByRole("button", {
      name: "提交本人删除申请，等待客服核验",
      exact: true,
    }),
  ).toBeVisible();
  const created = await command(
    mini,
    "提交本人删除申请，等待客服核验",
    "/care-requests",
  );
  await expect(mini.getByText(/本人删除申请已记录，待客服核验/)).toBeVisible();
  await mini
    .getByRole("button", { name: "查看资料删除进度", exact: true })
    .click();
  await expect(mini).toHaveURL(
    `${origin}/#/deletion-status?projectId=${project.projectId}`,
  );
  await expect(
    mini.getByText("在线访问尚未确认停止", { exact: true }),
  ).toBeVisible();
  await expect(mini.getByText(/删除申请待客服核验/)).toBeVisible();
  await mini.screenshot({
    path: "/tmp/timenook-t26-pending-390.png",
    fullPage: false,
  });
  const admin = await openAdmin(browser);
  await admin
    .getByRole("button", { name: `查看 ${created.id}`, exact: true })
    .click();
  await expect(
    admin.getByText("尚无已核验删除或保留期届满记录。", { exact: false }),
  ).toBeVisible();
  await admin
    .getByLabel("D08 核验证据引用", { exact: true })
    .fill("synthetic:浏览器本人删除核验");
  await command(admin, "核验本人申请", "/verify");
  await expect(
    admin.getByText(/本人删除已核验，在线访问立即停止/),
  ).toBeVisible();
  // The semantic section is exposed by its accessible label, even when the UI library wraps it.
  const panel = admin.locator('section[aria-label="逐层资料删除"]');
  await expect(panel.getByText(/全项目删除已核验且不可逆/)).toBeVisible();
  const cleared = await command(
    admin,
    "重新执行系统活动层清理",
    "/deletion/reconcile",
  );
  expect(cleared.onlineAccessStopped).toBe(true);
  expect(
    cleared.changes[0].items.some(
      (item) => item.layer === "active_database" && item.state === "completed",
    ),
  ).toBe(true);
  expect(
    cleared.changes[0].items.some(
      (item) => item.layer === "backup" && item.state === "awaiting_evidence",
    ),
  ).toBe(true);
  const supplier = panel
    .locator("article")
    .filter({ hasText: "副本层：supplier" })
    .first();
  await supplier
    .getByRole("button", { name: "录入此项核验记录", exact: true })
    .click();
  await panel
    .getByLabel("删除单项回执引用", { exact: true })
    .fill("record:synthetic-browser-pending");
  const pending = await command(admin, "记录本项仍待核实", "/evidence");
  expect(
    pending.changes
      .flatMap((change) => change.items)
      .some(
        (item) =>
          item.evidenceRef === "record:synthetic-browser-pending" &&
          item.state === "awaiting_evidence",
      ),
  ).toBe(true);
  await supplier
    .getByRole("button", { name: "录入此项核验记录", exact: true })
    .click();
  await panel
    .getByLabel("删除单项回执引用", { exact: true })
    .fill("record:synthetic-browser-confirmed");
  const confirmed = await command(admin, "记录本项已核验回执", "/evidence");
  expect(
    confirmed.changes
      .flatMap((change) => change.items)
      .some(
        (item) =>
          item.evidenceRef === "record:synthetic-browser-confirmed" &&
          item.state === "completed",
      ),
  ).toBe(true);
  expect(
    confirmed.changes
      .flatMap((change) => change.items)
      .some(
        (item) => item.layer === "backup" && item.state === "awaiting_evidence",
      ),
  ).toBe(true);
  await mini
    .getByRole("button", { name: "重新查询删除进度", exact: true })
    .click();
  await expect(mini.getByText("在线访问已停止", { exact: true })).toBeVisible();
  await expect(mini.getByText(/项目删除不可逆/)).toBeVisible();
  await expect(
    mini.getByText("备份待到期或核验", { exact: true }).first(),
  ).toBeVisible();
  const backup = confirmed.changes
    .flatMap((change) => change.items)
    .find((item) => item.layer === "backup");
  expect(backup.deadline).toBeTruthy();
  await expect(
    mini.getByText(`原截止：${backup.deadline}`, { exact: true }).first(),
  ).toBeVisible();
  const body = await mini.locator("#page").innerText();
  expect(body).not.toContain("我记得那一年");
  expect(body).not.toContain(
    project.story?.revision?.title ?? "我记得的那一年",
  );
  expect(body).not.toMatch(/book_title|storageRoot|\/private\//);
  expect(
    (
      await fetch(`${apiOrigin}/v1/projects/${project.projectId}/plan`, {
        headers: { authorization: `Bearer ${narratorSession.session.token}` },
      })
    ).status,
  ).toBe(403);
  await mini.screenshot({
    path: "/tmp/timenook-t26-deletion-390.png",
    fullPage: false,
  });
  await mini.setViewportSize({ width: 1280, height: 900 });
  await mini.screenshot({
    path: "/tmp/timenook-t26-deletion-1280.png",
    fullPage: false,
  });
  await admin.screenshot({
    path: "/tmp/timenook-t26-admin-receipt-1280.png",
    fullPage: false,
  });
  await panel
    .getByRole("heading", { name: "资料删除与副本清单", exact: true })
    .scrollIntoViewIfNeeded();
  await admin.screenshot({
    path: "/tmp/timenook-t26-admin-1280.png",
    fullPage: false,
  });
  const buyer = await openMini(browser, buyerSession, project, "welcome");
  await buyer
    .getByRole("button", { name: "查看资料删除进度", exact: true })
    .click();
  await expect(
    buyer.getByText("在线访问已停止", { exact: true }),
  ).toBeVisible();
  for (const page of [mini, admin, buyer]) {
    expect(await page.locator("body").innerText()).not.toMatch(
      /Internal Server Error|Failed to resolve import/,
    );
    expect(await page.locator("vite-error-overlay").count()).toBe(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  }
  expect(errors).toEqual([]);
  await Promise.all([
    mini.context().close(),
    admin.context().close(),
    buyer.context().close(),
  ]);
});

test("管理员切换工单后，旧删除清单的迟到响应不会恢复旧操作目标", async ({
  browser,
}) => {
  const openRequest = async () => {
    const p = await fixture.bound();
    const current = await fixture.state(p, p.narrator.token);
    const care = fixture.data(
      await fixture.request(
        "POST",
        `/v1/projects/${p.projectId}/care-requests`,
        p.narrator.token,
        { kind: "delete", expectedBindingVersion: current.bindingVersion },
      ),
    );
    return { p, current, care };
  };
  const a = await openRequest(),
    b = await openRequest();
  fixture.data(
    await fixture.app.inject({
      method: "POST",
      url: `/v1/admin/care-requests/${a.care.id}/verify`,
      headers: { ...adminHeaders, "idempotency-key": randomUUID() },
      payload: {
        expectedBindingVersion: a.current.bindingVersion,
        expectedAccessEpoch: a.current.accessEpoch,
        noticeVersion: "synthetic-d08-v1",
        evidenceRef: "synthetic:切工单迟到响应核验",
      },
    }),
  );
  const admin = await openAdmin(browser);
  await admin
    .getByRole("button", { name: `查看 ${a.care.id}`, exact: true })
    .click();
  const panel = admin.locator('section[aria-label="逐层资料删除"]');
  await expect(panel.getByText(/全项目删除已核验且不可逆/)).toBeVisible();
  let release, received;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const arrived = new Promise((resolve) => {
    received = resolve;
  });
  await admin.route(
    `**/care-requests/${a.care.id}/deletion-status`,
    async (route) => {
      const response = await route.fetch();
      received();
      await gate;
      await route.fulfill({ response });
    },
  );
  try {
    await panel
      .getByRole("button", { name: "查询删除清单", exact: true })
      .click();
    await arrived;
    await admin
      .getByRole("button", { name: `查看 ${b.care.id}`, exact: true })
      .click();
    await expect(
      admin.getByText(`共享工单：record:${b.care.id}`, { exact: true }),
    ).toBeVisible();
    await expect(
      panel.getByText(/尚无已核验删除或保留期届满记录/),
    ).toBeVisible();
    const late = admin.waitForResponse((response) =>
      response.url().endsWith(`/care-requests/${a.care.id}/deletion-status`),
    );
    release();
    await late;
    await expect(panel.getByText(/全项目删除已核验且不可逆/)).toHaveCount(0);
    await expect(
      panel.getByRole("button", {
        name: "重新执行系统活动层清理",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      admin.getByText(`共享工单：record:${b.care.id}`, { exact: true }),
    ).toBeVisible();
    await admin.screenshot({
      path: "/tmp/timenook-t26-case-switch-1280.png",
      fullPage: false,
    });
    expect(errors).toEqual([]);
  } finally {
    release();
    await admin.context().close();
  }
});
