import { test, expect } from "@playwright/test";
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { resolve, join } from "node:path";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import https from "node:https";

// Browser plugin not available. Real Page/Vben + HTTP/PostgreSQL/Redis/PDF;
// only provider protocols use the existing isolated synthetic fixture.
const apiRequire = createRequire(resolve("apps/api/package.json"));
const origin = `http://127.0.0.1:${process.env.TIMENOOK_T25_PREVIEW_PORT ?? "5195"}`;
const apiOrigin = `http://127.0.0.1:${process.env.TIMENOOK_T25_API_PORT ?? "3445"}`;
const adminOrigin = `https://localhost:${process.env.TIMENOOK_T25_ADMIN_PORT ?? "3446"}`;
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
  privateDir = mkdtempSync(join(tmpdir(), "t25-browser-"));
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
    ["node_modules/vite/bin/vite.js", "--host", "localhost", "--port", "3446"],
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
      `/tmp/timenook-t25-browser-debug-${index}.txt`,
      await page.locator("body").innerText(),
    );
    await page.screenshot({
      path: `/tmp/timenook-t25-browser-failure-${index}.png`,
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
async function openMini(browser, account, target = project, route = "export") {
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
test("narrator requests a complete export, operator verifies and packs it, recipient saves a verified ZIP", async ({
  browser,
}) => {
  const mini = await openMini(browser, narratorSession);
  await expect(
    mini.locator("#page").getByText("完整资料导出", { exact: true }),
  ).toBeVisible();
  await mini.getByRole("button", { name: "由我本人领取", exact: true }).click();
  await mini.locator("textarea").fill("本人申请导出并自行保管完整资料");
  await mini
    .getByRole("button", {
      name: "确认：这是讲述者本人的完整资料导出申请",
      exact: true,
    })
    .click();
  const created = await command(mini, "提交申请，等待客服核验", "/exports");
  await expect(
    mini.getByText("待客服核验本人及范围", { exact: true }),
  ).toBeVisible();
  const admin = await openAdmin(browser);
  await admin
    .getByRole("button", { name: `查看 ${created.id}`, exact: true })
    .click();
  await admin
    .getByLabel("D08 核验证据引用", { exact: true })
    .fill("synthetic:本人及本次完整资料范围核验");
  await command(admin, "核验本人申请", "/verify");
  await expect(admin.getByText("状态：待核验", { exact: true })).toBeVisible();
  const due = await admin.evaluate(() => {
    const v = new Date(Date.now() + 86400000);
    return new Date(v.getTime() - v.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
  });
  await admin.getByLabel("导出处理截止", { exact: true }).fill(due);
  await admin
    .getByLabel("导出核验证据", { exact: true })
    .fill("synthetic:原订单工作日历核算及受理证据");
  await command(admin, "核验范围与接收人并受理", "/accept");
  const packed = await command(admin, "打包并核对完整 ZIP", "/pack");
  await expect(
    admin.getByText("状态：已完成，接收人可领取", { exact: true }),
  ).toBeVisible();
  await mini.getByRole("button", { name: "重新查询", exact: true }).click();
  await expect(
    mini.getByRole("button", { name: "下载并保存完整 ZIP", exact: true }),
  ).toBeVisible();
  const download = mini.waitForEvent("download");
  await mini
    .getByRole("button", { name: "下载并保存完整 ZIP", exact: true })
    .click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("岁月成书-完整资料.zip");
  const path = await file.path();
  const bytes = await import("node:fs/promises").then((fs) =>
    fs.readFile(path),
  );
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(packed.sha256);
  await expect(mini.getByText(/资料包已交给设备保存或发送/)).toBeVisible();
  await mini.screenshot({
    path: "/tmp/timenook-t25-export-390.png",
    fullPage: true,
  });
  await mini.setViewportSize({ width: 1280, height: 900 });
  await mini.screenshot({
    path: "/tmp/timenook-t25-export-1280.png",
    fullPage: true,
  });
  await expect(
    admin.getByText(`ZIP SHA256：${packed.sha256}`, { exact: true }),
  ).toBeVisible();
  await admin.screenshot({
    path: "/tmp/timenook-t25-admin-1280.png",
    fullPage: true,
  });
  for (const page of [mini, admin]) {
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
  await Promise.all([mini.context().close(), admin.context().close()]);
});
