import { test, expect } from "@playwright/test";
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

const apiRequire = createRequire(resolve("apps/api/package.json"));
const origin = "http://127.0.0.1:5184";
const apiOrigin = "http://127.0.0.1:3432";
let fixture, project, session, worker, preview, latestPage, recovery;
const errors = [];
const paragraph = "我还记得家门前的那条路，和每天走过它的日子。".repeat(28);
const end = "这一段的最后一句，也完整留在这本书里。";

test.beforeAll(async () => {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const previous = process.cwd();
  try {
    process.chdir(resolve("apps/api"));
    fixture = apiRequire("./dist-test/test/book-fixture.js");
    await fixture.startBookFixture();
    project = await fixture.readyStory();
    const photo = await fixture.storyPhoto(project, "合成照片：门前的红墙");
    const { data, request } = fixture;
    const path = `/v1/projects/${project.projectId}/stories/${project.story.id}`;
    const revision = data(
      await request("POST", `${path}/revisions`, project.narrator.token, {
        baseRevisionId: project.story.revision.id,
        expectedVersion: project.story.version,
        title: "门前的那条路",
        theme: "故乡",
        paragraphs: [
          {
            text: paragraph,
            sourceRefs: project.story.revision.paragraphs[0].sourceRefs,
          },
          {
            text: end,
            sourceRefs: project.story.revision.paragraphs[0].sourceRefs,
          },
        ],
        reviewResolutions: project.story.revision.reviewItems.map((item) => ({
          item,
          reason: "合成样本：保留模糊年代，不补写未知事实。",
        })),
        notes: [],
        photoSnapshotId: photo.id,
      }),
    );
    project.story = data(
      await request("POST", `${path}/decisions`, project.narrator.token, {
        revisionId: revision.revision.id,
        contentHash: revision.revision.contentHash,
        expectedVersion: revision.version,
        confirmed: true,
        allowInBook: true,
        noticeVersion: "synthetic-d08-v1",
        evidenceRef: "synthetic:本人确认这版并允许入书",
      }),
    );
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
    session = data(
      await fixture.app.inject({
        method: "POST",
        url: "/v1/sessions/wechat",
        payload: { code: `${project.narrator.who}:${randomUUID()}` },
      }),
    );
    worker = await apiRequire(
      "./dist-test/src/tasks/worker.js",
    ).startProductionWorker(fixture.app);
    recovery = setInterval(
      () => void worker.recoverDue().catch(() => {}),
      1000,
    );
    await fixture.app.listen(3432, "127.0.0.1");
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
      "5184",
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
  if (recovery) clearInterval(recovery);
  if (preview?.exitCode === null)
    await new Promise((done) => {
      preview.once("exit", done);
      preview.kill("SIGTERM");
    });
  await worker?.close();
  await fixture?.stopBookFixture();
});

test.afterEach(async ({}, info) => {
  if (
    info.status !== info.expectedStatus &&
    latestPage &&
    !latestPage.isClosed()
  ) {
    await writeFile(
      "/tmp/timenook-t20-browser-debug.txt",
      await latestPage.locator("body").innerText(),
    );
    await latestPage.screenshot({
      path: "/tmp/timenook-t20-browser-failure.png",
    });
  }
});

async function openBook(
  browser,
  viewport = { width: 390, height: 844 },
  account = session,
) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  latestPage = page;
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (
      ["error", "warning"].includes(message.type()) &&
      !/\b(?:401|403|409)\b/.test(message.text())
    )
      errors.push(message.text());
  });
  await page.goto(origin);
  await page.evaluate(
    ({ origin, session }) => {
      localStorage.setItem("timenook.mode.v1", JSON.stringify("live"));
      localStorage.setItem(
        `timenook.session.v1:${origin}/api/v1`,
        JSON.stringify(session),
      );
    },
    { origin, session: account },
  );
  await page.goto(`${origin}/#/book?projectId=${project.projectId}`);
  await expect(page).toHaveTitle("时光里 · 岁月成书");
  return page;
}

test("real book generation freezes one snapshot and delivers the same complete PDF to the native page", async ({
  browser,
}) => {
  const page = await openBook(browser);
  try {
    await expect(
      page.getByRole("button", { name: "生成完整书稿", exact: true }),
    ).toBeVisible();
    const generated = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith(`/projects/${project.projectId}/book/versions`),
    );
    await page
      .getByRole("button", { name: "生成完整书稿", exact: true })
      .click();
    const accepted = await generated;
    expect(accepted.status()).toBe(202);
    const queued = (await accepted.json()).data;
    expect(queued.snapshot.cover.title).toBe("一路走来的故事");
    expect(
      queued.snapshot.chapters
        .flatMap((chapter) => chapter.stories)
        .map((story) => story.revisionId),
    ).toEqual([project.story.revision.id]);
    await expect(
      page.getByRole("button", { name: "查看完整书稿", exact: true }),
    ).toBeEnabled({ timeout: 30000 });
    const current = fixture.data(
      await fixture.request(
        "GET",
        `/v1/projects/${project.projectId}/book`,
        project.narrator.token,
      ),
      200,
    ).current;
    expect(current.state).toBe("ready");
    expect(current.pageCount).toBeGreaterThan(2);
    expect(current.id).toBe(queued.id);
    await expect(
      page.getByText(new RegExp(`第\\s*${current.version}\\s*版`)).first(),
    ).toBeVisible();
    await expect(
      page.getByText(new RegExp(`${current.pageCount}\\s*页`)).first(),
    ).toBeVisible();
    await expect(
      page.getByText("一路走来的故事", { exact: true }).first(),
    ).toBeVisible();
    await page.screenshot({ path: "/tmp/timenook-t20-book-390.png" });

    await page
      .getByRole("button", { name: "查看完整书稿", exact: true })
      .click();
    await expect(page).toHaveURL(/#\/manuscript\?/);
    await expect(page.getByText(end, { exact: true })).toBeVisible();
    await page.evaluate(() => {
      window.syntheticDocument = { opened: [] };
      window.wx.openDocument = (options) => {
        window.syntheticDocument.opened.push(options.filePath);
        options.success?.({ errMsg: "openDocument:ok" });
      };
    });
    const pdf = page.waitForResponse((response) =>
      response.url().endsWith(`/book/versions/${current.id}/pdf`),
    );
    await page
      .getByRole("button", { name: "打开完整 PDF", exact: true })
      .click();
    const response = await pdf;
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("application/pdf");
    await expect
      .poll(() => page.evaluate(() => window.syntheticDocument.opened.length))
      .toBe(1);
    const delivered = Buffer.from(
      await page.evaluate(async () => {
        const response = await fetch(window.syntheticDocument.opened[0]);
        return Array.from(new Uint8Array(await response.arrayBuffer()));
      }),
    );
    expect(delivered.length).toBe(current.pdf.bytes);
    expect(createHash("sha256").update(delivered).digest("hex")).toBe(
      current.pdf.sha256,
    );
    expect(
      await page.evaluate(() => window.syntheticDocument.opened[0]),
    ).not.toContain(session.session.token);
    const bodyFonts = await page
      .locator(".live-manuscript .manuscript-body")
      .evaluateAll((nodes) =>
        nodes.map((node) => parseFloat(getComputedStyle(node).fontSize)),
      );
    expect(bodyFonts.length).toBeGreaterThan(0);
    expect(bodyFonts.every((size) => size >= 20)).toBe(true);
    const actions = await page
      .locator(".live-manuscript button:visible")
      .evaluateAll((nodes) =>
        nodes.map((node) => ({
          width: node.getBoundingClientRect().width,
          height: node.getBoundingClientRect().height,
        })),
      );
    expect(actions.every((size) => size.width >= 48 && size.height >= 48)).toBe(
      true,
    );
    expect(await page.locator("vite-error-overlay").count()).toBe(0);
    expect(errors).toEqual([]);
    await page.screenshot({ path: "/tmp/timenook-t20-manuscript-390.png" });
  } catch (error) {
    const book = fixture.data(
      await fixture.request(
        "GET",
        `/v1/projects/${project.projectId}/book`,
        project.narrator.token,
      ),
      200,
    );
    await writeFile(
      "/tmp/timenook-t20-browser-debug.txt",
      (await page.locator("body").innerText()) +
        "\nERRORS\n" +
        JSON.stringify(errors) +
        "\nTASK\n" +
        JSON.stringify(book.current?.task),
    );
    await page.screenshot({ path: "/tmp/timenook-t20-browser-failure.png" });
    throw error;
  } finally {
    await page.context().close();
  }
});

test("actual directory edits invalidate the previous PDF and empty chapters do not add invented text", async ({
  browser,
}) => {
  const { request, data } = fixture;
  const path = `/v1/projects/${project.projectId}/book`;
  let currentContext = data(
    await request("GET", path, project.narrator.token),
    200,
  );
  if (!currentContext.current || currentContext.current.state !== "ready") {
    data(
      await request("POST", `${path}/versions`, project.narrator.token, {
        expectedInputHash: currentContext.inputHash,
      }),
      202,
    );
    await expect
      .poll(
        async () => {
          await worker.recoverDue();
          currentContext = data(
            await request("GET", path, project.narrator.token),
            200,
          );
          return currentContext.current.state;
        },
        { timeout: 30000 },
      )
      .toBe("ready");
  }
  const previous = currentContext.current;
  const page = await openBook(browser, { width: 1280, height: 900 });
  try {
    await expect(
      page.getByRole("button", { name: "调整入书目录", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "调整书封", exact: true }).click();
    await page.locator(".cover-salutation").click();
    await page.locator(".cover-salutation").pressSequentially("给一路陪伴的人");
    await expect(page.locator(".cover-salutation")).toHaveValue(
      "给一路陪伴的人",
    );
    await page
      .getByRole("button", {
        name: "选用封面照片：合成照片：门前的红墙",
        exact: true,
      })
      .click();
    const covering = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith(`${path.slice(3)}/cover`),
    );
    await page.getByRole("button", { name: "保存书封", exact: true }).click();
    const coverResponse = await covering;
    expect(coverResponse.status()).toBe(201);
    const settings = (await coverResponse.json()).data;
    expect(settings.cover.salutation).toBe("给一路陪伴的人");
    expect(settings.current.state).toBe("obsolete");
    await page
      .getByRole("button", { name: "调整入书目录", exact: true })
      .click();
    await page.locator(".directory-title").first().fill("我走过的那些日子");
    await page.getByRole("button", { name: "添加章节", exact: true }).click();
    await page.locator(".directory-title").last().fill("空章不会印入");
    const saving = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith(`${path.slice(3)}/directory`),
    );
    await page
      .getByRole("button", { name: "保存入书目录", exact: true })
      .click();
    expect((await saving).status()).toBe(201);
    const obsolete = data(
      await request(
        "GET",
        `${path}/versions/${previous.id}`,
        project.narrator.token,
      ),
      200,
    );
    expect(obsolete.state).toBe("obsolete");
    const denied = await request(
      "GET",
      `${path}/versions/${previous.id}/pdf`,
      project.narrator.token,
    );
    expect(denied.statusCode).toBe(409);
    await expect(
      page.getByRole("button", { name: "查看完整书稿", exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "生成完整书稿", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "查看完整书稿", exact: true }),
    ).toBeVisible({ timeout: 30000 });
    const changed = data(
      await request("GET", path, project.narrator.token),
      200,
    ).current;
    expect(changed.version).toBe(previous.version + 1);
    expect(changed.snapshot.cover.salutation).toBe("给一路陪伴的人");
    expect(changed.snapshot.cover.photo.assetId).toBe(
      settings.cover.photoAssetId,
    );
    expect(changed.snapshot.cover.photo.sha256).toBe(
      changed.snapshot.chapters[0].stories[0].photos[0].sha256,
    );
    expect(changed.snapshot.chapters.map((chapter) => chapter.title)).toEqual([
      "我走过的那些日子",
    ]);
    expect(
      changed.snapshot.directory.chapters.map((chapter) => chapter.title),
    ).toContain("空章不会印入");
    expect(changed.snapshot.chapters[0].stories[0].revisionId).toBe(
      project.story.revision.id,
    );
    expect(changed.snapshot.chapters[0].stories[0].entry.id).toBe(
      previous.snapshot.chapters[0].stories[0].entry.id,
    );
    expect(changed.pdf.sha256).not.toBe(previous.pdf.sha256);
    await expect(page.locator(".live-cover .book-cover-photo")).toBeVisible();
    await expect
      .poll(() =>
        page
          .locator(".live-cover .book-cover-photo")
          .evaluate((node) => node.complete && node.naturalWidth > 0),
      )
      .toBe(true);
    await expect(
      page.locator(".live-cover").getByText("给一路陪伴的人", { exact: true }),
    ).toBeVisible();
    const phoneWidth = await page
      .locator("#phone")
      .evaluate((node) => node.getBoundingClientRect().width);
    expect(Math.round(phoneWidth)).toBe(390);
    await page.screenshot({ path: "/tmp/timenook-t20-directory-1280.png" });
    expect(await page.locator("vite-error-overlay").count()).toBe(0);
    expect(errors).toEqual([]);
  } catch (error) {
    await writeFile(
      "/tmp/timenook-t20-browser-debug.txt",
      (await page.locator("body").innerText()) +
        "\nERRORS\n" +
        JSON.stringify(errors),
    );
    await page.screenshot({ path: "/tmp/timenook-t20-browser-failure.png" });
    throw error;
  } finally {
    await page.context().close();
  }
});

test("the browser PDF viewer uses authenticated temporary bytes and a revoked initiator loses the private manuscript", async ({
  browser,
}) => {
  const { data, request } = fixture;
  const path = `/v1/projects/${project.projectId}/book`;
  let context = data(await request("GET", path, project.narrator.token), 200);
  if (context.current?.state !== "ready") {
    data(
      await request("POST", `${path}/versions`, project.narrator.token, {
        expectedInputHash: context.inputHash,
      }),
      202,
    );
    await expect
      .poll(
        async () => {
          context = data(
            await request("GET", path, project.narrator.token),
            200,
          );
          return context.current.state;
        },
        { timeout: 30000 },
      )
      .toBe("ready");
  }
  const buyerSession = data(
    await fixture.app.inject({
      method: "POST",
      url: "/v1/sessions/wechat",
      payload: { code: `${project.buyer.who}:${randomUUID()}` },
    }),
  );
  const page = await openBook(
    browser,
    { width: 390, height: 844 },
    buyerSession,
  );
  try {
    await page
      .getByRole("button", { name: "查看完整书稿", exact: true })
      .click();
    await expect(page.getByText(end, { exact: true })).toBeVisible();
    await page
      .getByRole("button", { name: "打开完整 PDF", exact: true })
      .click();
    const viewer = page.locator(".pdf-viewer");
    const canvas = viewer.locator("canvas.pdf-page");
    await expect(viewer).toBeVisible();
    await expect(canvas).toHaveAttribute("data-page-number", "1");
    await expect
      .poll(async () =>
        canvas.evaluate((node) => {
          const data = node
            .getContext("2d")
            .getImageData(0, 0, node.width, node.height).data;
          let dark = 0;
          for (let n = 0; n < data.length; n += 4) {
            if (
              data[n + 3] > 200 &&
              data[n] < 180 &&
              data[n + 1] < 180 &&
              data[n + 2] < 180
            )
              dark++;
          }
          return dark;
        }),
      )
      .toBeGreaterThan(150);
    expect(
      (await viewer.locator(".pdf-page-number").innerText()).match(/\d+/g),
    ).toEqual(["1", String(context.current.pageCount)]);
    await viewer.locator(".pdf-next").click();
    await expect(canvas).toHaveAttribute("data-page-number", "2");
    expect(
      (await viewer.locator(".pdf-page-number").innerText()).match(/\d+/g),
    ).toEqual(["2", String(context.current.pageCount)]);
    expect(await viewer.innerHTML()).not.toContain(buyerSession.session.token);
    await page.screenshot({ path: "/tmp/timenook-t20-pdf-viewer-390.png" });
    data(
      (await fixture.choose(project, project.narrator.token, "sharing", false))
        .response,
    );
    await viewer.locator(".pdf-close").click();
    const forbidden = page.waitForResponse(
      (response) =>
        response.status() === 403 && response.url().includes(`/book/versions/`),
    );
    await page
      .getByRole("button", { name: "重新核对本版状态", exact: true })
      .click();
    await forbidden;
    await expect(page.getByText(end, { exact: true })).toHaveCount(0);
    await expect(page.getByText("一路走来的故事", { exact: true })).toHaveCount(
      0,
    );
    await expect(viewer).toHaveCount(0);
    expect(await page.locator("vite-error-overlay").count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await page.context().close();
  }
});
