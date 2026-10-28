import { test, expect } from "@playwright/test";
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

// Actual Page + HTTP + PostgreSQL + renderer; only external providers are synthetic.
const apiRequire = createRequire(resolve("apps/api/package.json"));
const origin = "http://127.0.0.1:5188";
const apiOrigin = "http://127.0.0.1:3436";
let fixture, project, book, buyerSession, narratorSession, preview, latestPage;
const errors = [];
const paymentRequests = [];

test.beforeAll(async () => {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const previous = process.cwd();
  try {
    process.chdir(resolve("apps/api"));
    fixture = apiRequire("./dist-test/test/book-fixture.js");
    await fixture.startBookFixture();
    // This test's private package is explicitly synthetic. Published/default
    // specifications stay intact; a short sample is not a production offer.
    const snapshot = JSON.parse(
      readFileSync("test/fixtures/catalog-synthetic.json", "utf8"),
    );
    snapshot.d01.minPages = 1;
    snapshot.d01.bleedMm = 0;
    const draftId = randomUUID(),
      packageId = randomUUID();
    await fixture.db.packageDraft.create({
      data: { id: draftId, realm: "local", ...snapshot },
    });
    await fixture.db.packageVersion.create({
      data: {
        id: packageId,
        realm: "local",
        purpose: "local_preview",
        draftId,
        draftRevision: 1,
        snapshot,
        publicOffer: {
          title: "T22 隔离合成套餐",
          price: { value: 99900, unit: "fen", currency: "CNY" },
        },
      },
    });
    project = await fixture.readyStory(await fixture.bound(packageId));
    const { data, request } = fixture;
    const overview = data(
      await request(
        "GET",
        `/v1/projects/${project.projectId}/overview`,
        project.narrator.token,
      ),
      200,
    );
    data(
      await request(
        "POST",
        `/v1/projects/${project.projectId}/metadata`,
        project.narrator.token,
        {
          expectedVersion: overview.metadataVersion,
          bookTitle: "一路走来的故事",
        },
      ),
    );
    const storyPath = `/v1/projects/${project.projectId}/stories/${project.story.id}`;
    project.story = data(
      await request("POST", `${storyPath}/revisions`, project.narrator.token, {
        baseRevisionId: project.story.revision.id,
        expectedVersion: project.story.version,
        title: "一路走来的故事",
        theme: "旧时光",
        paragraphs: project.story.revision.paragraphs,
        reviewResolutions: project.story.revision.reviewItems.map((item) => ({
          item,
          reason: "合成样本：本人核对后保留约略年代。",
        })),
        notes: [],
      }),
    );
    project.story = data(
      await request("POST", `${storyPath}/decisions`, project.narrator.token, {
        revisionId: project.story.revision.id,
        contentHash: project.story.revision.contentHash,
        expectedVersion: project.story.version,
        confirmed: true,
        allowInBook: true,
        noticeVersion: "synthetic-d08-v1",
        evidenceRef: "synthetic:T22本人确认这版并允许入书",
      }),
    );
    const bookPath = `/v1/projects/${project.projectId}/book`;
    const context = data(
      await request("GET", bookPath, project.narrator.token),
      200,
    );
    book = data(
      await request("POST", `${bookPath}/versions`, project.narrator.token, {
        expectedInputHash: context.inputHash,
      }),
      202,
    );
    const { ProductionTasks } = apiRequire("./dist-test/src/tasks/tasks.js");
    await fixture.app.get(ProductionTasks).run(book.task.id);
    book = data(
      await request(
        "GET",
        `${bookPath}/versions/${book.id}`,
        project.narrator.token,
      ),
      200,
    );
    expect(book.state).toBe("ready");
    const session = async (who) =>
      data(
        await fixture.app.inject({
          method: "POST",
          url: "/v1/sessions/wechat",
          payload: { code: `${who}:${randomUUID()}` },
        }),
      );
    buyerSession = await session(project.buyer.who);
    narratorSession = await session(project.narrator.who);
    await fixture.app.listen(3436, "127.0.0.1");
  } finally {
    process.chdir(previous);
  }
  preview = spawn(
    process.execPath,
    [
      "node_modules/vite/bin/vite.js",
      "--host",
      "127.0.0.1",
      "--port",
      "5188",
      "--strictPort",
    ],
    {
      cwd: resolve("."),
      env: {
        ...process.env,
        TIMENOOK_API_BASE_URL: `${origin}/api/v1`,
        TIMENOOK_PREVIEW_API_TARGET: apiOrigin,
      },
      stdio: "ignore",
    },
  );
  await expect
    .poll(
      async () => {
        try {
          return (await fetch(origin)).status;
        } catch {
          return 0;
        }
      },
      { timeout: 15000 },
    )
    .toBe(200);
});

test.afterAll(async () => {
  if (preview?.exitCode === null)
    await new Promise((done) => {
      preview.once("exit", done);
      preview.kill("SIGTERM");
    });
  await fixture?.stopBookFixture();
});

test.afterEach(async ({}, info) => {
  if (
    info.status !== info.expectedStatus &&
    latestPage &&
    !latestPage.isClosed()
  ) {
    await writeFile(
      "/tmp/timenook-t22-browser-debug.txt",
      await latestPage.locator("body").innerText(),
    );
    await latestPage.screenshot({
      path: "/tmp/timenook-t22-browser-failure.png",
    });
  }
});

async function openPrint(
  browser,
  account,
  viewport = { width: 390, height: 844 },
) {
  const context = await browser.newContext({ viewport });
  await context.addInitScript(() => {
    window.syntheticPdfFiles = [];
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      const path = create(blob);
      if (blob.type === "application/pdf") window.syntheticPdfFiles.push(path);
      return path;
    };
  });
  const page = await context.newPage();
  latestPage = page;
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (
      ["error", "warning"].includes(message.type()) &&
      !/\b(?:401|403|404|409)\b/.test(message.text())
    )
      errors.push(message.text());
  });
  page.on("request", (request) => {
    if (/\/orders\/[^/]+\/payment(?:\?|$)/.test(request.url()))
      paymentRequests.push(request.url());
  });
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
  await page.goto(
    `${origin}/#/print?projectId=${project.projectId}&versionId=${book.id}`,
  );
  await expect(page).toHaveTitle("时光里 · 岁月成书");
  return page;
}

async function checkPdfBytes(page, openedPath) {
  const bytes = Buffer.from(
    await page.evaluate(async (path) => {
      const response = await fetch(path);
      return Array.from(new Uint8Array(await response.arrayBuffer()));
    }, openedPath),
  );
  expect(bytes.length).toBe(book.pdf.bytes);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(
    book.pdf.sha256,
  );
}

async function readFullPdf(page) {
  await page
    .getByRole("button", { name: "查看本版完整 PDF", exact: true })
    .click();
  await expect(page).toHaveURL(/#\/manuscript\?/);
  await page.getByRole("button", { name: "打开完整 PDF", exact: true }).click();
  await expect(page.locator(".pdf-page-number")).toHaveText(
    new RegExp(`第 1 / ${book.pageCount} 页`),
    { timeout: 15000 },
  );
  const pdfPath = await page.evaluate(() => window.syntheticPdfFiles.at(-1));
  expect(pdfPath).toBeTruthy();
  await checkPdfBytes(page, pdfPath);
  await page.getByRole("button", { name: "关闭完整书稿", exact: true }).click();
  await page
    .getByRole("button", { name: "核对本版确认与首本制作", exact: true })
    .click();
  await expect(page).toHaveURL(/#\/print\?/);
}

async function saveAddress(page, detail = "北京市合成街1号（合成测试）") {
  await page
    .getByPlaceholder("填写收件人姓名", { exact: true })
    .fill("合成收件人");
  await page
    .getByPlaceholder("填写11位手机号", { exact: true })
    .fill("13800000000");
  if (
    (await page.getByRole("button", { name: /^已选配送地区：/ }).count()) === 0
  )
    await page
      .getByRole("button", { name: /^选择配送地区：/ })
      .first()
      .click();
  await page
    .getByPlaceholder("省、市、区、街道及门牌号", { exact: true })
    .fill(detail);
  const saved = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      r.url().endsWith("/first-copy/address"),
  );
  await page.getByRole("button", { name: "保存收货地址", exact: true }).click();
  expect((await saved).status()).toBe(201);
}

async function confirmInitiator(
  page,
  evidence = "合成测试：已核对同一完整 PDF、全部页数和当前地址。",
) {
  await page
    .getByRole("button", {
      name: "我已逐页核对本版完整 PDF 和当前收货地址",
      exact: true,
    })
    .click();
  await page
    .getByPlaceholder("记录发起人核对本版与地址的独立说明", { exact: true })
    .fill(evidence);
  const saved = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      r.url().endsWith("/first-copy/confirmations"),
  );
  await page
    .getByRole("button", { name: "保存排版与地址确认", exact: true })
    .click();
  expect((await saved).status()).toBe(201);
}

test("both participants confirm the same actual PDF, address changes invalidate only initiator and first copy has no payment", async ({
  browser,
}) => {
  const narrator = await openPrint(browser, narratorSession);
  await expect(
    narrator.getByText("确认书稿与首本制作", { exact: true }),
  ).toBeVisible();
  await readFullPdf(narrator);
  await narrator
    .getByRole("button", {
      name: "我已逐页核对本版完整 PDF，确认内容",
      exact: true,
    })
    .click();
  await narrator
    .getByPlaceholder("记录本人核对本版内容的独立说明", { exact: true })
    .fill("合成测试：本人逐页核对完整 PDF，确认这版内容。");
  const confirmed = narrator.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      r.url().endsWith("/first-copy/confirmations"),
  );
  await narrator
    .getByRole("button", { name: "保存本人内容确认", exact: true })
    .click();
  expect((await confirmed).status()).toBe(201);
  await narrator.context().close();

  const buyer = await openPrint(browser, buyerSession);
  await expect(buyer.getByText(/已付.*999/).first()).toBeVisible();
  await expect(buyer.getByText(/本次无需支付/).first()).toBeVisible();
  await buyer.screenshot({ path: "/tmp/timenook-t22-paid-390.png" });
  const submit = buyer.getByRole("button", {
    name: "使用首本权益提交制作",
    exact: true,
  });
  await expect(submit).toBeDisabled();
  await saveAddress(buyer);
  await readFullPdf(buyer);
  await confirmInitiator(buyer);
  await expect(submit).toBeEnabled();
  await saveAddress(buyer, "北京市合成街2号（改地址后重新确认）");
  await expect(submit).toBeDisabled();
  const changed = fixture.data(
    await fixture.request(
      "GET",
      `/v1/projects/${project.projectId}/first-copy`,
      project.buyer.token,
    ),
    200,
  );
  expect(changed.confirmations).toEqual({ narrator: true, initiator: false });
  await confirmInitiator(
    buyer,
    "合成测试：本次重新核对完整 PDF 和合成街2号新地址。",
  );
  await expect(submit).toBeEnabled();
  await buyer.screenshot({ path: "/tmp/timenook-t22-confirm-390.png" });
  const controls = await buyer
    .locator("#page button:visible")
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        width: node.getBoundingClientRect().width,
        height: node.getBoundingClientRect().height,
      })),
    );
  expect(controls.every((size) => size.width >= 48 && size.height >= 48)).toBe(
    true,
  );
  await buyer.setViewportSize({ width: 1280, height: 900 });
  await buyer.screenshot({ path: "/tmp/timenook-t22-confirm-1280.png" });
  const submitted = buyer.waitForResponse(
    (r) =>
      r.request().method() === "POST" && r.url().endsWith("/first-copy/submit"),
  );
  await submit.click();
  const response = await submitted;
  expect(response.status()).toBe(201);
  const result = (await response.json()).data;
  expect(result.production).toMatchObject({
    bookVersionId: book.id,
    snapshotHash: book.snapshotHash,
    pdfHash: book.pdf.sha256,
    copies: 1,
    amountDueFen: 0,
  });
  await expect(
    buyer.getByText(result.production.id, { exact: false }).first(),
  ).toBeVisible();
  await buyer
    .getByText("首本制作已预留", { exact: true })
    .scrollIntoViewIfNeeded();
  await buyer.screenshot({ path: "/tmp/timenook-t22-reserved-1280.png" });
  await buyer.setViewportSize({ width: 390, height: 844 });
  await buyer.screenshot({ path: "/tmp/timenook-t22-reserved-390.png" });
  expect(
    await buyer
      .locator("#page")
      .evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  await expect(buyer.locator("vite-error-overlay")).toHaveCount(0);
  await buyer.reload();
  await expect(
    buyer.getByText(result.production.id, { exact: false }).first(),
  ).toBeVisible();
  expect(paymentRequests).toEqual([]);
  expect(errors).toEqual([]);
  await buyer.context().close();
});

test("a changed book cannot be confirmed from its old version link", async ({
  browser,
}) => {
  const overview = fixture.data(
    await fixture.request(
      "GET",
      `/v1/projects/${project.projectId}/overview`,
      project.narrator.token,
    ),
    200,
  );
  fixture.data(
    await fixture.request(
      "POST",
      `/v1/projects/${project.projectId}/metadata`,
      project.narrator.token,
      {
        expectedVersion: overview.metadataVersion,
        bookTitle: "在线改稿后的新书名",
      },
    ),
  );
  const page = await openPrint(browser, narratorSession);
  await expect(page.getByText("首本实体书", { exact: true })).toBeVisible();
  const confirmation = page.getByRole("button", {
    name: "保存本人内容确认",
    exact: true,
  });
  if (await confirmation.count()) await expect(confirmation).toBeDisabled();
  else await expect(confirmation).toHaveCount(0);
  const context = fixture.data(
    await fixture.request(
      "GET",
      `/v1/projects/${project.projectId}/first-copy`,
      project.narrator.token,
    ),
    200,
  );
  expect(context.canSubmit).toBe(false);
  expect(context.confirmations).toEqual({ narrator: false, initiator: false });
  await page.context().close();
});

test("sharing withdrawal clears the initiator's private print details", async ({
  browser,
}) => {
  fixture.data(
    (await fixture.choose(project, project.narrator.token, "sharing", false))
      .response,
  );
  const page = await openPrint(browser, buyerSession);
  await expect(
    page.getByText(/授权已失效|授权已到期|无法访问/).first(),
  ).toBeVisible();
  const text = await page.locator("#page").innerText();
  expect(text).not.toContain("一路走来的故事");
  expect(text).not.toContain("合成收件人");
  expect(text).not.toContain("北京市合成街");
  await expect(
    page.getByPlaceholder("填写收件人姓名", { exact: true }),
  ).toHaveCount(0);
  await page.screenshot({ path: "/tmp/timenook-t22-denied-390.png" });
  expect(errors).toEqual([]);
  await page.context().close();
});
