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
const origin = "http://127.0.0.1:5190";
const apiOrigin = "http://127.0.0.1:3440";
const adminOrigin = "https://localhost:3443";
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
  privateDir = mkdtempSync(join(tmpdir(), "t23-browser-"));
  const previous = process.cwd();
  try {
    process.chdir(resolve("apps/api"));
    fixture = apiRequire("./dist-test/test/book-fixture.js");
    await fixture.startBookFixture();
    const { readyReservedFirstCopy } = apiRequire(
      "./dist-test/test/first-copy-fixture.js",
    );
    project = await readyReservedFirstCopy();
    const { paymentAdmin } = apiRequire(
      "./dist-test/test/payment-admin-fixture.js",
    );
    adminHeaders = await paymentAdmin(fixture.config, fixture.app, [
      "ops:read",
      "fulfillment:write",
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
    await fixture.app.listen(3440, "127.0.0.1");
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
      "5190",
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
  adminVite = start(["node_modules/vite/bin/vite.js", "--host", "localhost"], {
    cwd: resolve("apps/admin"),
    env: {
      ...process.env,
      ADMIN_API_TARGET: apiOrigin,
      ADMIN_TLS_CERT: cert,
      ADMIN_TLS_KEY: key,
    },
  });
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
      `/tmp/timenook-t23-browser-debug-${index}.txt`,
      await page.locator("body").innerText(),
    );
    await page.screenshot({
      path: `/tmp/timenook-t23-browser-failure-${index}.png`,
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
async function openMini(
  browser,
  account,
  target = project,
  route = "production",
) {
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
  await page.getByRole("button", { name: "生产与物流", exact: true }).click();
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

async function fillDate(page, label, date) {
  const input = page.getByLabel(label, { exact: true });
  const type = await input.getAttribute("type");
  const step = await input.getAttribute("step");
  const value =
    type === "datetime-local"
      ? await page.evaluate((iso) => {
          const value = new Date(iso);
          return new Date(value.getTime() - value.getTimezoneOffset() * 60000)
            .toISOString()
            .slice(0, 23);
        }, date.toISOString())
      : date.toISOString();
  await input.fill(
    type === "datetime-local"
      ? step
        ? value.replace(/\.000$/, "").replace(/:00$/, "")
        : value.slice(0, 16)
      : value,
  );
}

test("operator hands off the authorized exact PDF, records supplier acceptance and shipping, and user sees the unique delivery", async ({
  browser,
}) => {
  const admin = await openAdmin(browser);
  await admin
    .getByRole("button", { name: "查看此生产单", exact: true })
    .click();
  await expect(admin.getByLabel("印厂引用", { exact: true })).toHaveValue(
    "record:synthetic-provider",
  );
  await expect(admin.getByLabel("印厂引用", { exact: true })).toBeDisabled();
  await fillDate(admin, "本次处理期限", new Date(Date.now() + 86400000));
  let view = await command(admin, "建立生产尝试", "/attempts");
  const attempt = view.current;
  expect(attempt.bookVersionId).toBe(project.book.id);
  expect(attempt.pdfHash).toBe(project.book.pdf.sha256);
  await expect(
    admin.getByText(attempt.handoffId, { exact: false }).first(),
  ).toBeVisible();
  await expect(
    admin.getByRole("button", { name: "下载本次生产 PDF", exact: true }),
  ).toBeDisabled();

  const narrator = await openMini(browser, narratorSession);
  await expect(
    narrator.getByText("已审核，等待交接", { exact: true }),
  ).toBeVisible();
  await narrator.getByRole("button", { name: /我同意.*PDF.*地址/ }).click();
  await narrator
    .getByPlaceholder("记录本人对本次限时交接的独立授权说明", { exact: true })
    .fill("合成测试：仅授权本工单负责人取得本版 PDF 和配送地址十分钟。");
  await command(narrator, "授权本次生产资料限时交接", "/fulfillment/grants");
  await admin
    .getByRole("button", { name: "重新查询生产单", exact: true })
    .click();
  await admin
    .getByRole("button", { name: "查看此生产单", exact: true })
    .click();
  await admin
    .getByRole("button", { name: "查看限时生产资料", exact: true })
    .click();
  await expect(
    admin.getByText("合成收件人", { exact: false }).first(),
  ).toBeVisible();
  const download = admin.waitForEvent("download");
  await admin
    .getByRole("button", { name: "下载本次生产 PDF", exact: true })
    .click();
  const file = await download;
  const stream = await file.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const bytes = Buffer.concat(chunks);
  expect(bytes.length).toBe(project.book.pdf.bytes);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(
    project.book.pdf.sha256,
  );
  await command(admin, "记录人工交接已开始", "/handoff");
  await admin
    .getByLabel("回执或处理证据", { exact: true })
    .fill("synthetic:已发文件结果未知");
  await command(admin, "记录接单结果待核实", "/receipt");
  await narrator
    .getByRole("button", { name: "重新查询生产与物流", exact: true })
    .click();
  await expect(
    narrator.getByText("交接结果待核实", { exact: true }),
  ).toBeVisible();
  await narrator.screenshot({ path: "/tmp/timenook-t23-unknown-390.png" });
  await expect(
    admin.getByRole("button", { name: "建立生产尝试", exact: true }),
  ).toHaveCount(0);

  await admin
    .getByLabel("回执或处理证据", { exact: true })
    .fill("synthetic:印厂明确接单回执");
  await command(admin, "记录印厂确认接单", "/receipt");
  await admin
    .getByLabel("回执或处理证据", { exact: true })
    .fill("synthetic:请求取消已接单生产");
  await command(admin, "请求取消本次生产", "/cancel");
  await admin
    .getByLabel("回执或处理证据", { exact: true })
    .fill("synthetic:印厂核实已无法取消并继续生产");
  const continuing = await command(
    admin,
    "核实取消未成功，继续实际履约",
    "/receipt",
  );
  expect(continuing.current.state).toBe("in_production");
  expect(continuing.entitlementState).toBe("consumed");
  await admin.getByLabel("物流公司", { exact: true }).fill("合成快递");
  await admin
    .getByLabel("物流单号", { exact: true })
    .fill("SYNTHETIC-T23-0001");
  await fillDate(
    admin,
    "发货时间",
    new Date(Math.floor(Date.now() / 1000) * 1000),
  );
  await admin
    .getByLabel("物流证据", { exact: true })
    .fill("synthetic:人工核对物流");
  await admin
    .getByLabel("微信发货证据", { exact: true })
    .fill("synthetic:隔离发货管理结果");
  await admin.getByLabel(/微信发货处理结果/).selectOption("recorded");
  await command(admin, "保存物流与微信发货记录", "/shipping");
  await admin
    .getByLabel("回执或处理证据", { exact: true })
    .fill("synthetic:已发货后请求取消");
  await command(admin, "请求取消本次生产", "/cancel");
  await admin
    .getByLabel("回执或处理证据", { exact: true })
    .fill("synthetic:物流已交运无法取消");
  const stillShipped = await command(
    admin,
    "核实取消未成功，继续实际履约",
    "/receipt",
  );
  expect(stillShipped.current.state).toBe("shipped");
  expect(stillShipped.current.tracking.number).toBe("SYNTHETIC-T23-0001");
  const buyer = await openMini(browser, buyerSession);
  await expect(buyer.getByText("已发货", { exact: true })).toBeVisible();
  await expect(
    buyer.getByText("单号：SYNTHETIC-T23-0001", { exact: true }),
  ).toBeVisible();
  await buyer.screenshot({ path: "/tmp/timenook-t23-shipped-390.png" });
  await buyer.setViewportSize({ width: 1280, height: 900 });
  await buyer.screenshot({ path: "/tmp/timenook-t23-shipped-1280.png" });
  expect(
    await buyer
      .locator("#page")
      .evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  const controls = await narrator
    .locator("#page button:visible")
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const rect = node.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      }),
    );
  expect(controls.length).toBeGreaterThan(0);
  expect(controls.every((rect) => rect.width >= 48 && rect.height >= 48)).toBe(
    true,
  );

  const deliveredAt = new Date(
    Math.floor(Date.now() / 1000) * 1000,
  ).toISOString();
  await fillDate(admin, "交付时间", new Date(deliveredAt));
  await admin
    .getByLabel("交付证据", { exact: true })
    .fill("synthetic:人工核对签收");
  view = await command(admin, "记录交付完成", "/delivery");
  expect(view.serviceTerms.playback.startsAt).toBe(deliveredAt);
  const originalExpiry = view.serviceTerms.playback.expiresAt;
  await narrator
    .getByRole("button", { name: "重新查询生产与物流", exact: true })
    .click();
  await expect(narrator.getByText("已交付", { exact: true })).toBeVisible();
  await expect(
    narrator.getByText(`交付记录：${deliveredAt}`, { exact: true }),
  ).toBeVisible();
  const after = fixture.data(
    await fixture.request(
      "GET",
      `/v1/projects/${project.projectId}/fulfillment`,
      project.buyer.token,
    ),
    200,
  );
  expect(after.current.deliveredAt).toBe(deliveredAt);
  expect(after.serviceTerms.playback.expiresAt).toBe(originalExpiry);
  await admin.screenshot({
    path: "/tmp/timenook-t23-admin-delivered-1280.png",
    fullPage: true,
  });
  await expect(
    admin.locator(".production-row").getByText(/已交付/),
  ).toBeVisible();
  await admin.setViewportSize({ width: 390, height: 844 });
  await expect(
    admin.getByRole("heading", { name: "生产与物流", exact: true }),
  ).toBeVisible();
  const mobileRefresh = admin.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      response.url().endsWith("/v1/admin/fulfillment"),
  );
  await admin
    .getByRole("button", { name: "重新查询生产单", exact: true })
    .click();
  expect((await mobileRefresh).status()).toBe(200);
  await expect(
    admin.locator(".production-row").getByText(/已交付/),
  ).toBeVisible();
  await admin.evaluate(() => window.scrollTo(0, 0));
  await admin.screenshot({ path: "/tmp/timenook-t23-admin-390.png" });
  expect(
    await admin.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await expect(admin.locator("vite-error-overlay")).toHaveCount(0);
  await expect(narrator.locator("vite-error-overlay")).toHaveCount(0);
  expect(errors).toEqual([]);
  await Promise.all([
    admin.context().close(),
    narrator.context().close(),
    buyer.context().close(),
  ]);
});

test("verified cancellation permits corrected address confirmation and a new attempt on the same first-copy order", async ({
  browser,
}) => {
  const previous = process.cwd();
  let retry;
  try {
    process.chdir(resolve("apps/api"));
    retry = await apiRequire(
      "./dist-test/test/first-copy-fixture.js",
    ).readyReservedFirstCopy();
  } finally {
    process.chdir(previous);
  }
  const base = `/v1/admin/fulfillment/${retry.order.id}`;
  const adminCommand = async (suffix, payload) =>
    fixture.data(
      await fixture.app.inject({
        method: "POST",
        url: base + suffix,
        headers: { ...adminHeaders, "idempotency-key": randomUUID() },
        payload,
      }),
    );
  const created = await adminCommand("/attempts", {
    ...retry.binding,
    supplierRef: "record:synthetic-provider",
    dueAt: new Date(Date.now() + 86400000).toISOString(),
  });
  const attemptBase = `/attempts/${created.current.id}`;
  fixture.data(
    await fixture.request(
      "POST",
      `/v1/projects/${retry.projectId}/fulfillment/grants`,
      retry.narrator.token,
      {
        ...retry.binding,
        attemptId: created.current.id,
        expiresAt: new Date(Date.now() + 600000).toISOString(),
        noticeVersion: "synthetic-d08-v1",
        evidenceRef: "synthetic:本次测试取消前的本人限时授权",
      },
    ),
  );
  await adminCommand(attemptBase + "/handoff", {});
  await adminCommand(attemptBase + "/cancel", {
    evidenceRef: "synthetic:人工请求取消待核实交接",
  });
  await adminCommand(attemptBase + "/receipt", {
    outcome: "cancelled",
    evidenceRef: "synthetic:印厂明确确认取消原尝试",
  });
  const account = fixture.data(
    await fixture.app.inject({
      method: "POST",
      url: "/v1/sessions/wechat",
      payload: { code: `${retry.buyer.who}:${randomUUID()}` },
    }),
  );
  const buyer = await openMini(browser, account, retry, "print");
  const detail = buyer.getByPlaceholder("省、市、区、街道及门牌号", {
    exact: true,
  });
  await expect(detail).toBeVisible();
  await detail.fill("合成地址二号：确认取消后的更正");
  const changed = await command(buyer, "保存收货地址", "/first-copy/address");
  expect(changed.confirmations).toEqual({ narrator: true, initiator: false });
  expect(changed.canReviseProduction).toBe(true);
  await buyer
    .getByRole("button", {
      name: "我已逐页核对本版完整 PDF 和当前收货地址",
      exact: true,
    })
    .click();
  await buyer
    .getByPlaceholder("记录发起人核对本版与地址的独立说明", { exact: true })
    .fill("合成测试：重新核对相同完整 PDF 与更正后的地址。");
  await command(buyer, "保存排版与地址确认", "/first-copy/confirmations");
  const resubmitted = await command(
    buyer,
    "使用首本权益提交制作",
    "/first-copy/submit",
  );
  expect(resubmitted.production.id).toBe(retry.order.id);
  expect(resubmitted.production.addressHash).toBe(changed.address.hash);
  expect(resubmitted.canReviseProduction).toBe(false);
  await expect(detail).toHaveCount(0);
  await buyer.screenshot({
    path: "/tmp/timenook-t23-corrected-reservation-390.png",
  });
  const admin = await openAdmin(browser);
  await admin
    .locator(".production-row")
    .filter({ hasText: retry.order.id })
    .getByRole("button", { name: "查看此生产单", exact: true })
    .click();
  await fillDate(admin, "本次处理期限", new Date(Date.now() + 86400000));
  const next = await command(admin, "建立生产尝试", "/attempts");
  expect(next.orderId).toBe(retry.order.id);
  expect(next.current.sequence).toBe(2);
  expect(next.current.addressHash).toBe(changed.address.hash);
  const historic = next.attempts.find(
    (attempt) => attempt.id === created.current.id,
  );
  expect(historic.state).toBe("cancelled");
  expect(historic.addressHash).toBe(retry.binding.addressHash);
  expect(historic.pdfHash).toBe(retry.binding.pdfHash);
  expect(errors).toEqual([]);
  await Promise.all([buyer.context().close(), admin.context().close()]);
});

test("withdrawing sharing clears the initiator production and tracking details", async ({
  browser,
}) => {
  fixture.data(
    (await fixture.choose(project, project.narrator.token, "sharing", false))
      .response,
  );
  const buyer = await openMini(browser, buyerSession);
  await expect(buyer.getByText(/无权查询|授权已失效/).first()).toBeVisible();
  const body = await buyer.locator("#page").innerText();
  expect(body).not.toContain("SYNTHETIC-T23-0001");
  expect(body).not.toContain("合成快递");
  await buyer.screenshot({ path: "/tmp/timenook-t23-denied-390.png" });
  expect(errors).toEqual([]);
  await buyer.context().close();
});
