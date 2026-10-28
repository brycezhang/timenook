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
const origin = "http://127.0.0.1:5198";
const apiOrigin = "http://127.0.0.1:3480";
const adminOrigin = "https://localhost:3483";
let fixture, project, preview, adminVite, privateDir, adminHeaders;
let buyerSession, narratorSession, qualityFixture;
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
  privateDir = mkdtempSync(join(tmpdir(), "t28-browser-"));
  const previous = process.cwd();
  try {
    process.chdir(resolve("apps/api"));
    fixture = apiRequire("./dist-test/test/book-fixture.js");
    await fixture.startBookFixture();
    fixture.config.admin.origin = adminOrigin;
    qualityFixture = apiRequire("./dist-test/test/quality-fixture.js");
    project = await qualityFixture.deliveredQualityOrder();
    adminHeaders = project.headers;
    const session = async (who) =>
      fixture.data(
        await fixture.app.inject({
          method: "POST",
          url: "/v1/sessions/wechat",
          payload: { code: `${who}:${randomUUID()}` },
        }),
      );
    buyerSession = await session(project.buyer.who);
    narratorSession = await session(project.narrator.who);
    await fixture.app.listen(3480, "127.0.0.1");
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
      "5198",
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
      "3483",
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
      `/tmp/timenook-t28-browser-debug-${index}.txt`,
      await page.locator("body").innerText(),
    );
    await page.screenshot({
      path: `/tmp/timenook-t28-browser-failure-${index}.png`,
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
async function openMini(browser, account, target = project, route = "quality") {
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
    route === "quality" || route === "refunds"
      ? `orderId=${target.orderId}&projectId=${target.projectId}`
      : `projectId=${target.projectId}`;
  await page.goto(`${origin}/#/${route}?${query}`);
  await expect(page).toHaveTitle("时光里 · 岁月成书");
  return page;
}
async function openAdmin(browser, headers = adminHeaders) {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 900 },
  });
  const split = headers.cookie.indexOf("=");
  await context.addCookies([
    {
      name: headers.cookie.slice(0, split),
      value: headers.cookie.slice(split + 1),
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
  await expect(page.getByRole("button", { name, exact: true })).toBeEnabled({
    timeout: 10000,
  });
  const pending = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && response.url().endsWith(suffix),
  );
  await page.getByRole("button", { name, exact: true }).click();
  const response = await pending;
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()).data;
}

async function inApi(work) {
  const previous = process.cwd();
  try {
    process.chdir(resolve("apps/api"));
    return await work();
  } finally {
    process.chdir(previous);
  }
}
async function openCase(page, caseId) {
  const loading = page.waitForResponse((r) =>
    r.url().endsWith(`/quality/cases/${caseId}`),
  );
  await page
    .getByRole("button", { name: "查看 " + caseId, exact: true })
    .click();
  expect((await loading).status()).toBe(200);
  await expect(
    page.getByRole("heading", { name: "质量核验与原单重印", exact: true }),
  ).toBeVisible();
}
async function grant(page) {
  await page
    .getByRole("button", { name: "重新查询质量售后", exact: true })
    .click();
  await page
    .getByRole("button", { name: "查看本人资料授权选择", exact: true })
    .click();
  await page
    .getByRole("button", { name: "未选：原确定 PDF", exact: true })
    .click();
  await page
    .getByRole("button", { name: "未选：本次质量问题说明", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "尚未确认：我同意本次范围与时限",
      exact: true,
    })
    .click();
  return command(page, "记录本次限时授权", "/access");
}
async function inspect(page, name, caseId) {
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  expect((await page.locator("body").innerText()).trim()).not.toBe("");
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    if (caseId) {
      await openCase(page, caseId);
      if (name === "original-materials-admin") {
        await page
          .getByRole("button", { name: "查看本次获授权资料", exact: true })
          .click();
        await page
          .getByRole("button", { name: "校验并临时预览原 PDF", exact: true })
          .click();
        await expect(
          page.locator('canvas[data-page-number="1"]'),
        ).toBeVisible();
        await page.locator(".quality-materials").scrollIntoViewIfNeeded();
      } else
        await page
          .getByRole("heading", { name: "质量核验与原单重印", exact: true })
          .scrollIntoViewIfNeeded();
    }
    if (name.startsWith("second-request-"))
      await page.locator(".case.selected").scrollIntoViewIfNeeded();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({ path: `/tmp/timenook-t28-${name}-${width}.png` });
  }
}

test("quality request, personal scoped materials and original-order reprint use the real shared support and production flow", async ({
  browser,
}) => {
  test.setTimeout(120000);
  const buyer = await openMini(browser, buyerSession, project, "production");
  await buyer
    .getByRole("button", { name: "质量售后与原单重印", exact: true })
    .click();
  await expect(buyer).toHaveURL(
    new RegExp(`quality\\?orderId=${project.orderId}`),
  );
  await expect(
    buyer.getByRole("button", { name: "提交质量申请", exact: true }),
  ).toBeVisible();
  await buyer
    .getByPlaceholder("简述质量问题（3到1500字）")
    .fill("合成质量说明：书页破损，请核验原确定文件。");
  const requested = await command(buyer, "提交质量申请", "/quality-care");
  expect(requested.original.pdfHash).toBe(project.binding.pdfHash);
  const admin = await openAdmin(browser);
  await openCase(admin, requested.caseId);
  await admin
    .getByLabel("质量政策核验证据", { exact: true })
    .fill("synthetic:原D06日历与质量处理责任已核验");
  await admin
    .getByLabel("质量处理截止", { exact: true })
    .fill(new Date(Date.now() + 86400000).toISOString().slice(0, 16));
  await command(admin, "领取本次质量工单", "/assign");
  const narrator = await openMini(browser, narratorSession);
  const granted = await grant(narrator);
  expect(granted.grant.scopes).toEqual(["pdf", "evidence"]);
  await admin
    .getByRole("button", { name: "查询原质量工单", exact: true })
    .click();
  await admin
    .getByRole("button", { name: "查看本次获授权资料", exact: true })
    .click();
  await expect(
    admin.getByText(
      "本次质量说明：合成质量说明：书页破损，请核验原确定文件。",
      { exact: true },
    ),
  ).toBeVisible();
  const pdf = admin.waitForResponse((r) => r.url().endsWith("/pdf"));
  await admin
    .getByRole("button", { name: "校验并临时预览原 PDF", exact: true })
    .click();
  expect((await pdf).status()).toBe(200);
  await expect(admin.locator('canvas[data-page-number="1"]')).toBeVisible();
  await inspect(admin, "original-materials-admin", requested.caseId);
  await admin
    .getByLabel("质量政策核验证据", { exact: true })
    .fill("synthetic:原D07质量情形及原文件核验");
  await command(admin, "记录原政策核验方案", "/review");
  await expect(admin.locator('canvas[data-page-number="1"]')).toHaveCount(0);
  const reprinted = await command(admin, "创建原订单重印尝试", "/reprints");
  expect(reprinted.productionOrderId).toBe(project.order.id);
  expect(reprinted.productionAttemptId).toBeTruthy();
  await admin
    .getByRole("button", { name: "继续原单生产与物流", exact: true })
    .click();
  await expect(
    admin.getByText("生产单：" + project.order.id, { exact: true }),
  ).toBeVisible();
  await narrator
    .getByRole("button", { name: "重新查询质量售后", exact: true })
    .click();
  await expect(
    narrator.getByText("破损或装订问题 · 原订单重印处理中", { exact: true }),
  ).toBeVisible();
  await inspect(narrator, "original-mini");
  expect(errors).toEqual([]);
});

test("reviewed revised remedy enters existing book and fresh confirmation views, while quality refund enters the original money workflow", async ({
  browser,
}) => {
  test.setTimeout(120000);
  const p = await inApi(() => qualityFixture.reviewedQualityOrder("revised"));
  const session = async (who) =>
    fixture.data(
      await fixture.app.inject({
        method: "POST",
        url: "/v1/sessions/wechat",
        payload: { code: `${who}:${randomUUID()}` },
      }),
    );
  const buyerAccount = await session(p.buyer.who);
  const buyer = await openMini(browser, buyerAccount, p);
  await buyer
    .getByRole("button", { name: "修订书稿并重新核对", exact: true })
    .click();
  await expect(buyer).toHaveURL(
    new RegExp(`#/book\\?projectId=${p.projectId}`),
  );
  await expect(
    buyer.getByRole("button", { name: "双方确认与首本制作", exact: true }),
  ).toBeVisible();
  await buyer
    .getByRole("button", { name: "双方确认与首本制作", exact: true })
    .click();
  await expect(buyer.getByText(/本次为原订单质量售后的书稿修订/)).toBeVisible();
  await expect(
    buyer.getByRole("button", { name: "使用首本权益提交制作", exact: true }),
  ).toHaveCount(0);
  const admin = await openAdmin(browser, p.headers);
  await openCase(admin, p.quality.caseId);
  await expect(
    admin.getByRole("button", { name: "创建原订单重印尝试", exact: true }),
  ).toBeDisabled();
  await inspect(buyer, "revised-confirmation-mini");
  await inspect(admin, "revised-waiting-admin", p.quality.caseId);
  const refundProject = await inApi(() =>
      qualityFixture.reviewedQualityOrder("refund"),
    ),
    refundBuyer = await session(refundProject.buyer.who);
  const payer = await openMini(browser, refundBuyer, refundProject);
  const opened = await command(payer, "付款发起人继续退款申请", "/refund");
  expect(opened.refund.state).toBe("requested");
  await expect(payer).toHaveURL(
    new RegExp(`#/refunds\\?orderId=${refundProject.orderId}`),
  );
  await expect(
    payer.getByText("收到的书漏页 · 待客服核验", { exact: true }),
  ).toBeVisible();
  const moneyAdmin = await openAdmin(browser, refundProject.headers);
  const detail = moneyAdmin.waitForResponse((r) =>
    r.url().includes("/refunds/cases/"),
  );
  const money = fixture.data(
    await fixture.request(
      "GET",
      `/v1/orders/${refundProject.orderId}/refunds`,
      refundProject.buyer.token,
    ),
    200,
  );
  const refund = money.refunds.find((r) => r.id === opened.refund.id);
  await moneyAdmin
    .getByRole("button", { name: "查看 " + refund.caseId, exact: true })
    .click();
  expect((await detail).status()).toBe(200);
  await expect(
    moneyAdmin.getByRole("heading", {
      name: "退款核验与原单对账",
      exact: true,
    }),
  ).toBeVisible();
  await inspect(payer, "quality-refund-mini");
  expect(errors).toEqual([]);
});

test("an explicit assisted quality grant does not grant the buyer private content sharing", async ({
  browser,
}) => {
  test.setTimeout(120000);
  const p = await inApi(() => qualityFixture.deliveredQualityOrder());
  const created = fixture.data(
    await fixture.request("POST", p.qualityBase, p.buyer.token, {
      attemptId: p.attempt.id,
      reason: "qualityDamaged",
      description: "合成专属客服质量说明",
    }),
  );
  fixture.data(
    await qualityFixture.adminRequest(
      "POST",
      `/v1/admin/quality/cases/${created.caseId}/assign`,
      p.headers,
      {
        expectedVersion: created.version,
        dueAt: new Date(Date.now() + 86400000).toISOString(),
        evidenceRef: "synthetic:独立质量工单负责人及原D06核验",
      },
    ),
  );
  fixture.data(
    (await fixture.choose(p, p.narrator.token, "sharing", false)).response,
  );
  const account = fixture.data(
    await fixture.app.inject({
      method: "POST",
      url: "/v1/sessions/wechat",
      payload: { code: `${p.buyer.who}:${randomUUID()}` },
    }),
  );
  const buyer = await openMini(browser, account, p);
  await buyer
    .getByRole("button", { name: "查看本人资料授权选择", exact: true })
    .click();
  await expect(
    buyer.getByRole("button", { name: "记录本次限时授权", exact: true }),
  ).toHaveCount(0);
  await buyer
    .getByRole("button", { name: "与本人同机确认本次授权", exact: true })
    .click();
  await buyer
    .getByPlaceholder("记录本人本次选择同机协助核对的说明")
    .fill("合成本人在场，同意仅本次客服资料授权协助");
  await buyer
    .getByRole("button", {
      name: "本人同意当次售后授权协助，返回售后",
      exact: true,
    })
    .click();
  await expect(buyer).toHaveURL(/#\/quality\?.*assistedSessionId=/);
  const granted = await grant(buyer);
  expect(granted.grant.scopes).toEqual(["pdf", "evidence"]);
  const denied = await fixture.request(
    "GET",
    `/v1/projects/${p.projectId}/book/versions/${p.binding.bookVersionId}/pdf`,
    p.buyer.token,
  );
  expect(denied.statusCode).toBe(403);
  const admin = await openAdmin(browser, p.headers);
  await openCase(admin, created.caseId);
  await admin
    .getByRole("button", { name: "查看本次获授权资料", exact: true })
    .click();
  await expect(
    admin.getByText("本次质量说明：合成专属客服质量说明", { exact: true }),
  ).toBeVisible();
  await admin
    .getByRole("button", { name: "关闭并清理本次资料", exact: true })
    .click();
  await expect(
    admin.getByText("本次质量说明：合成专属客服质量说明", { exact: true }),
  ).toHaveCount(0);
  await inspect(buyer, "assisted-private-grant-mini");

  await buyer
    .getByRole("button", { name: "查看本人资料授权选择", exact: true })
    .click();
  await buyer
    .getByRole("button", { name: "未选：原确定 PDF", exact: true })
    .click();
  await buyer
    .getByRole("button", {
      name: "尚未确认：我同意本次范围与时限",
      exact: true,
    })
    .click();
  await buyer.getByRole("button", { name: "缺页或漏印", exact: true }).click();
  await buyer
    .getByPlaceholder("简述质量问题（3到1500字）")
    .fill("合成第二次质量说明：同次制作另有书页缺页，请分别处理。");
  const second = await command(buyer, "提交质量申请", "/quality-care");
  expect(second.id).not.toBe(created.id);
  await expect(buyer.locator(".case.selected")).toContainText(
    "缺页或漏印 · 待客服核验",
  );
  expect(
    await buyer
      .getByRole("button", { name: "查看本人资料授权选择", exact: true })
      .count(),
  ).toBe(0);
  expect(
    await buyer
      .getByRole("button", { name: "记录本次限时授权", exact: true })
      .count(),
  ).toBe(0);
  await inspect(buyer, "second-request-selected-mini");
  fixture.data(
    await qualityFixture.adminRequest(
      "POST",
      `/v1/admin/quality/cases/${second.caseId}/assign`,
      p.headers,
      {
        expectedVersion: second.version,
        dueAt: new Date(Date.now() + 86400000).toISOString(),
        evidenceRef: "synthetic:第二次质量申请独立核验负责人及原D06",
      },
    ),
  );
  await buyer
    .getByRole("button", { name: "重新查询质量售后", exact: true })
    .click();
  await buyer
    .getByRole("button", { name: "查看本人资料授权选择", exact: true })
    .click();
  await expect(
    buyer.getByRole("button", { name: "与本人同机确认本次授权", exact: true }),
  ).toBeVisible();
  expect(
    await buyer
      .getByRole("button", { name: "记录本次限时授权", exact: true })
      .count(),
  ).toBe(0);
  await buyer
    .getByRole("button", { name: "与本人同机确认本次授权", exact: true })
    .click();
  await buyer
    .getByPlaceholder("记录本人本次选择同机协助核对的说明")
    .fill("合成本人在场，为第二次质量申请重新选择授权协助");
  await buyer
    .getByRole("button", {
      name: "本人同意当次售后授权协助，返回售后",
      exact: true,
    })
    .click();
  await expect(buyer).toHaveURL(
    new RegExp(`requestId=${second.id}&assistedSessionId=`),
  );
  const target = buyer.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/${second.id}/access`),
  );
  const secondGrant = await grant(buyer);
  expect((await target).status()).toBe(201);
  expect(secondGrant.id).toBe(second.id);
  expect(secondGrant.grant.scopes).toEqual(["pdf", "evidence"]);
  await expect(buyer.locator(".case.selected")).toContainText(
    "缺页或漏印 · 客服已领取",
  );
  await inspect(buyer, "second-request-fresh-grant-mini");
  expect(errors).toEqual([]);
});
