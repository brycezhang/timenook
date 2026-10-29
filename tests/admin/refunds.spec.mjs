import { test, expect } from "@playwright/test";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { resolve, join } from "node:path";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import https from "node:https";

// Browser plugin not available. Real Page/Vben + HTTP/PostgreSQL/Redis;
// only provider protocols use the existing isolated synthetic fixture.
const apiRequire = createRequire(resolve("apps/api/package.json"));
const origin = "http://127.0.0.1:5197";
const apiOrigin = "http://127.0.0.1:3470";
const adminOrigin = "https://localhost:3473";
let fixture, project, preview, adminVite, privateDir, adminHeaders;
let buyerSession;
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
  privateDir = mkdtempSync(join(tmpdir(), "t27-browser-"));
  const previous = process.cwd();
  try {
    process.chdir(resolve("apps/api"));
    fixture = apiRequire("./dist-test/test/book-fixture.js");
    await fixture.startBookFixture();
    fixture.config.admin.origin = adminOrigin;
    await fixture.restartBookApplication();
    project = await fixture.project();
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
    buyerSession = await session(project.buyer.who);
    await fixture.app.listen(3470, "127.0.0.1");
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
      "5197",
      "--strictPort",
    ],
    {
      cwd: resolve("."),
      env: {
        ...process.env,
        TIMENOOK_API_BASE_URL: `${origin}/api/v1`,
        TIMENOOK_PREVIEW_API_TARGET: apiOrigin,
      },
    },
  );
  adminVite = start(
    // Workspace CommonJS contracts may have gained exports since the last
    // local run; rebuild the optimized dependency from this exact checkout.
    [
      "node_modules/vite/bin/vite.js",
      "--force",
      "--host",
      "localhost",
      "--port",
      "3473",
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
  await Promise.all([ready(origin), ready(`${adminOrigin}/admin/`)]);
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
      `/tmp/timenook-t27-browser-debug-${index}.txt`,
      await page.locator("body").innerText(),
    );
    await page.screenshot({
      path: `/tmp/timenook-t27-browser-failure-${index}.png`,
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
async function openMini(browser, account, target = project, route = "refunds") {
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
        `timenook.session.v1:${origin}/api/v1`,
        JSON.stringify(account),
      );
    },
    { origin, account },
  );
  const query =
    route === "refunds"
      ? `orderId=${target.orderId}`
      : `projectId=${target.projectId}`;
  await page.goto(`${origin}/#/${route}?${query}`);
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
      path: "/api/v1/admin",
      secure: true,
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
  const page = await context.newPage();
  observe(page);
  await page.goto(`${adminOrigin}/admin/`);
  await expect(page).toHaveTitle("时光里 · 运营管理");
  await expect(page).toHaveURL(`${adminOrigin}/admin/`);
  await page.getByRole("button", { name: "客服工单", exact: true }).click();
  return page;
}

async function command(page, name, suffix) {
  const pending = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && response.url().endsWith(suffix),
  );
  await page.getByRole("button", { name, exact: true }).click();
  const response = await pending;
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()).data;
}

test("buyer requests a refund and the shared support case approves, executes and reconciles actual money", async ({
  browser,
}) => {
  const buyer = await openMini(browser, buyerSession);
  await expect(
    buyer.getByRole("button", { name: "提交退款申请", exact: true }),
  ).toBeVisible({ timeout: 10000 });
  await expect(
    buyer.getByText("退款申请与进展", { exact: true }).last(),
  ).toBeVisible();
  await buyer
    .getByPlaceholder("简述申请原因（3到150字）")
    .fill("合成申请：讲述者尚未参与，希望取消购买。");
  const pending = buyer.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/refunds"),
  );
  await buyer
    .getByRole("button", { name: "提交退款申请", exact: true })
    .click();
  const response = await pending;
  expect(response.status(), await response.text()).toBe(201);
  const refund = (await response.json()).data;
  await expect(
    buyer.getByText("尚未参与 · 待客服核验", { exact: true }),
  ).toBeVisible();
  // T24/T27 combination: the same project care list must accept the refund
  // kind, keep both rights pages active, and retain the withdrawal proxy.
  for (const route of ["welcome", "assisted"]) {
    const rights = await openMini(browser, buyerSession, project, route);
    const label =
      route === "welcome"
        ? `退款工单：record:${refund.caseId}`
        : "退款：待客服核验";
    await expect(rights.getByText(label, { exact: true })).toBeVisible();
    const progress = rights.waitForResponse((r) =>
      r.url().endsWith("/withdrawal-status"),
    );
    await rights
      .getByRole("button", { name: "查看撤回处置进度", exact: true })
      .click();
    expect((await progress).status()).toBe(200);
    await expect(rights.getByText(/已停止相关在线访问与新处理/)).toBeVisible();
    for (const width of [390, 1280]) {
      await rights.setViewportSize({ width, height: 900 });
      expect(
        await rights.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await rights.screenshot({
        path: `/tmp/timenook-t24-main-refund-care-${route}-${width}.png`,
      });
    }
  }
  const admin = await openAdmin(browser);
  const caseDetails = admin.waitForResponse((r) =>
    r.url().endsWith(`/refunds/cases/${refund.caseId}`),
  );
  await admin
    .getByRole("button", { name: "查看 " + refund.caseId, exact: true })
    .click();
  const detailResponse = await caseDetails;
  expect(detailResponse.status(), await detailResponse.text()).toBe(200);
  expect((await detailResponse.json()).data.id).toBe(refund.id);
  await expect(admin.getByLabel("退款核验证据", { exact: true })).toBeVisible({
    timeout: 5000,
  });
  await admin
    .getByLabel("退款核验证据", { exact: true })
    .fill("synthetic:policy-and-buyer-verified");
  await command(admin, "按购买政策批准退款", "/approve");
  await expect(
    admin.getByText("尚未参与 · 已批准，待执行", { exact: true }),
  ).toBeVisible();
  await command(admin, "执行原退款", "/submit");
  await expect(
    admin.getByText("尚未参与 · 退款处理中", { exact: true }),
  ).toBeVisible();
  await buyer
    .getByRole("button", { name: "重新查询退款", exact: true })
    .click();
  await expect(
    buyer.getByText("尚未参与 · 退款处理中", { exact: true }),
  ).toBeVisible();
  fixture.setRefundInstant(new Date(Date.now() + 8 * 86400000));
  await buyer
    .getByRole("button", { name: "重新查询退款", exact: true })
    .click();
  await expect(
    buyer.getByText("已超过约定处理期限，客服仍需核实实际退款结果。", {
      exact: true,
    }),
  ).toBeVisible();
  await admin.getByRole("button", { name: "查询原退款", exact: true }).click();
  await expect(
    admin.getByText(
      "已超过购买时约定的处理期限，请跟进原退款；重试不会延长原截止时间。",
      { exact: true },
    ),
  ).toBeVisible();
  const provider = apiRequire(
    "./dist-test/test/payment-fixture.js",
  ).supplierRefunds.get(refund.outRefundNo);
  Object.assign(provider, {
    status: "SUCCESS",
    success_time: new Date().toISOString(),
  });
  await command(admin, "向微信查询原退款", "/reconcile");
  await expect(
    admin.getByText("尚未参与 · 已退款", { exact: true }),
  ).toBeVisible();
  await buyer
    .getByRole("button", { name: "重新查询退款", exact: true })
    .click();
  await expect(
    buyer.getByText("尚未参与 · 已退款", { exact: true }),
  ).toBeVisible();
  await expect(
    buyer.getByText("实付 ¥999 · 已退 ¥999", { exact: true }),
  ).toBeVisible();
  for (const page of [buyer, admin]) {
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
    expect(await page.locator("body").innerText()).not.toBe("");
  }
  for (const width of [390, 1280]) {
    await buyer.setViewportSize({ width, height: 900 });
    await buyer.screenshot({
      path: "/tmp/timenook-t27-refund-" + width + ".png",
    });
    expect(
      await buyer.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  }
  await admin.screenshot({ path: "/tmp/timenook-t27-refund-admin.png" });
  await admin.setViewportSize({ width: 390, height: 844 });
  await expect(
    admin.getByRole("button", { name: "查看 " + refund.caseId, exact: true }),
  ).toBeEnabled();
  await admin
    .getByRole("button", { name: "查看 " + refund.caseId, exact: true })
    .click();
  await admin
    .getByRole("heading", { name: "退款核验与原单对账", exact: true })
    .scrollIntoViewIfNeeded();
  await admin.screenshot({ path: "/tmp/timenook-t27-refund-admin-390.png" });
  expect(
    await admin.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});
