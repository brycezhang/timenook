import { test, expect } from "@playwright/test";
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

const apiRequire = createRequire(resolve("apps/api/package.json"));
const origin = "http://127.0.0.1:5186";
const apiOrigin = "http://127.0.0.1:3434";
const originalTitle = "纸书原版：门前的那条路";
const changedTitle = "在线新版：后来搬家的日子";
let fixture, project, book, entry, session, preview;
const outsiderWho = randomUUID();
const errors = [];
const responses = [];

test.beforeAll(async () => {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const previous = process.cwd();
  try {
    process.chdir(resolve("apps/api"));
    fixture = apiRequire("./dist-test/test/book-fixture.js");
    await fixture.startBookFixture();
    project = await fixture.readyStory();
    const { request, data } = fixture;
    const path = `/v1/projects/${project.projectId}/stories/${project.story.id}`;
    project.story = data(
      await request("POST", `${path}/revisions`, project.narrator.token, {
        baseRevisionId: project.story.revision.id,
        expectedVersion: project.story.version,
        title: originalTitle,
        theme: "故乡",
        paragraphs: project.story.revision.paragraphs,
        reviewResolutions: project.story.revision.reviewItems.map((item) => ({
          item,
          reason: "合成样本：保留约略年代，不添加未知事实。",
        })),
        notes: [],
      }),
    );
    project.story = data(
      await request("POST", `${path}/decisions`, project.narrator.token, {
        revisionId: project.story.revision.id,
        contentHash: project.story.revision.contentHash,
        expectedVersion: project.story.version,
        confirmed: true,
        allowInBook: true,
        noticeVersion: "synthetic-d08-v1",
        evidenceRef: "synthetic:本人确认这版并允许入书",
      }),
    );
    const base = `/v1/projects/${project.projectId}/book`;
    const context = data(
      await request("GET", base, project.narrator.token),
      200,
    );
    book = data(
      await request("POST", `${base}/versions`, project.narrator.token, {
        expectedInputHash: context.inputHash,
      }),
      202,
    );
    const { ProductionTasks } = apiRequire("./dist-test/src/tasks/tasks.js");
    await fixture.app.get(ProductionTasks).run(book.task.id);
    book = data(
      await request(
        "GET",
        `${base}/versions/${book.id}`,
        project.narrator.token,
      ),
      200,
    );
    expect(book.state).toBe("ready");
    entry = book.snapshot.chapters[0].stories[0].entry;
    session = data(
      await fixture.app.inject({
        method: "POST",
        url: "/v1/sessions/wechat",
        payload: { code: `${project.narrator.who}:${randomUUID()}` },
      }),
    );
    await fixture.app.listen(3434, "127.0.0.1");
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
      "5186",
      "--strictPort",
    ],
    {
      cwd: resolve("."),
      env: {
        ...process.env,
        TIMENOOK_API_BASE_URL: `${origin}/timenook/v1`,
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

async function openAudio(
  browser,
  account,
  viewport = { width: 390, height: 844 },
) {
  const context = await browser.newContext({ viewport });
  await context.addInitScript(() => {
    window.syntheticAudioDownloads = [];
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      const path = create(blob);
      const item = { path, type: blob.type, revoked: false, bytes: [] };
      item.ready = blob.arrayBuffer().then((bytes) => {
        item.bytes = Array.from(new Uint8Array(bytes));
      });
      window.syntheticAudioDownloads.push(item);
      return path;
    };
    URL.revokeObjectURL = (path) => {
      for (const item of window.syntheticAudioDownloads)
        if (item.path === path) item.revoked = true;
      revoke(path);
    };
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", async (response) => {
    if (
      !response.url().includes("/book-audio/") &&
      !(
        response.request().method() === "DELETE" &&
        response.url().includes("/sessions/")
      )
    )
      return;
    responses.push({
      path: new URL(response.url()).pathname,
      status: response.status(),
      contentType: response.headers()["content-type"],
      body: response.headers()["content-type"]?.includes("json")
        ? await response.text().catch(() => "")
        : "",
    });
  });
  page.on("console", (message) => {
    if (
      ["error", "warning"].includes(message.type()) &&
      !/\b(?:401|403|404|409)\b/.test(message.text())
    )
      errors.push(message.text());
  });
  await page.goto(origin);
  if (account)
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
  await page.goto(`${origin}/#/original-audio?entryId=${entry.id}`);
  await expect(page).toHaveTitle("时光里 · 岁月成书");
  return page;
}

async function playClip(page, sequence) {
  const download = page.waitForResponse(
    (response) =>
      response.url().includes(`/book-audio/${entry.id}/clips/`) &&
      response.url().includes("/content?epoch="),
  );
  await page
    .getByRole("button", { name: `播放第 ${sequence} 段`, exact: true })
    .click();
  const response = await download;
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toContain("no-store");
  expect(response.headers().location).toBeUndefined();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.syntheticAudioDownloads.filter((item) =>
            item.type.includes("audio"),
          ).length,
      ),
    )
    .toBeGreaterThan(0);
  const delivered = await page.evaluate(async () => {
    const item = window.syntheticAudioDownloads
      .filter((item) => item.type.includes("audio"))
      .at(-1);
    await item.ready;
    return { path: item.path, bytes: item.bytes };
  });
  const expected = readFileSync(
    resolve("apps/api/test/fixtures/synthetic-1s.mp3"),
  );
  expect(Buffer.from(delivered.bytes)).toEqual(expected);
  expect(
    createHash("sha256").update(Buffer.from(delivered.bytes)).digest("hex"),
  ).toBe(book.snapshot.chapters[0].stories[0].audio[sequence - 1].inputHash);
  expect(delivered.path).toMatch(/^blob:/);
  expect(delivered.path).not.toContain(session.session.token);
  return delivered.path;
}

async function expectRemoved(page, path) {
  await expect
    .poll(() =>
      page.evaluate(
        (path) =>
          window.syntheticAudioDownloads.find((item) => item.path === path)
            ?.revoked,
        path,
      ),
    )
    .toBe(true);
}

async function recordFailure(page, error) {
  await writeFile(
    "/tmp/timenook-t21-browser-debug.txt",
    (await page.locator("body").innerText()) +
      "\n" +
      String(error) +
      "\n" +
      JSON.stringify({ errors, responses }),
  );
  await page.screenshot({ path: "/tmp/timenook-t21-browser-failure.png" });
}

async function nativeSessionBridge(page, who) {
  // The preview deliberately has no native WeChat session adapter. Bridge only
  // this external boundary to the fixture's real session HTTP endpoints.
  await page.evaluate((code) => {
    window.wx.login = (options) =>
      options.success?.({ code, errMsg: "login:ok" });
    if (window.syntheticSessionBridge) return;
    window.syntheticSessionBridge = true;
    const request = window.wx.request.bind(window.wx);
    window.wx.request = (options) => {
      if (
        !/\/sessions\/(?:wechat|[a-f0-9-]{36})$/.test(
          new URL(options.url).pathname,
        )
      )
        return request(options);
      void fetch(options.url, {
        method: options.method ?? "GET",
        headers: options.header,
        body:
          options.method === "POST" ? JSON.stringify(options.data) : undefined,
      })
        .then(async (response) => {
          options.success?.({
            statusCode: response.status,
            data: response.status === 204 ? undefined : await response.json(),
          });
        })
        .catch(() => options.fail?.({ errMsg: "request:fail" }));
      return { abort() {} };
    };
  }, `${who}:${randomUUID()}`);
}

test("anonymous paper entry resumes after login and plays the selected frozen clip through the private gateway", async ({
  browser,
}) => {
  const page = await openAudio(browser);
  try {
    await expect(
      page.getByRole("button", { name: "微信登录后回听", exact: true }),
    ).toBeVisible();
    await expect(page.getByText(originalTitle, { exact: true })).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "播放第 1 段", exact: true }),
    ).toHaveCount(0);
    await page.screenshot({ path: "/tmp/timenook-t21-login-390.png" });
    await nativeSessionBridge(page, project.narrator.who);
    await page
      .getByRole("button", { name: "微信登录后回听", exact: true })
      .click();
    await expect(page.getByText(originalTitle, { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "播放第 1 段", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "播放第 2 段", exact: true }),
    ).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`entryId=${entry.id}`));
    await page.screenshot({ path: "/tmp/timenook-t21-original-audio-390.png" });
    const path = await playClip(page, 2);
    await expectRemoved(page, path);
    const actions = await page
      .locator(".original-audio-page button:visible")
      .evaluateAll((nodes) =>
        nodes.map((node) => ({
          width: node.getBoundingClientRect().width,
          height: node.getBoundingClientRect().height,
        })),
      );
    expect(actions.every((size) => size.width >= 48 && size.height >= 48)).toBe(
      true,
    );
    const bodyFonts = await page
      .locator(".audio-intro, .clip-label")
      .evaluateAll((nodes) =>
        nodes.map((node) => parseFloat(getComputedStyle(node).fontSize)),
      );
    expect(bodyFonts.every((size) => size >= 20)).toBe(true);
    expect(await page.locator("vite-error-overlay").count()).toBe(0);
    expect(errors).toEqual([]);
  } catch (error) {
    await recordFailure(page, error);
    throw error;
  } finally {
    await page.context().close();
  }
});

test("online edits retain the paper revision and leaving the page removes the downloaded audio", async ({
  browser,
}) => {
  const { request, data } = fixture;
  const path = `/v1/projects/${project.projectId}/stories/${project.story.id}`;
  const changed = data(
    await request("POST", `${path}/revisions`, project.narrator.token, {
      baseRevisionId: project.story.revision.id,
      expectedVersion: project.story.version,
      title: changedTitle,
      theme: project.story.revision.theme,
      paragraphs: project.story.revision.paragraphs,
      reviewResolutions: project.story.revision.reviewItems.map((item) => ({
        item,
        reason: "合成样本：在线新版仍保留约略年代。",
      })),
      notes: [],
    }),
  );
  project.story = data(
    await request("POST", `${path}/decisions`, project.narrator.token, {
      revisionId: changed.revision.id,
      contentHash: changed.revision.contentHash,
      expectedVersion: changed.version,
      confirmed: true,
      allowInBook: true,
      noticeVersion: "synthetic-d08-v1",
      evidenceRef: "synthetic:在线改稿另行确认",
    }),
  );
  const page = await openAudio(browser, session, { width: 1280, height: 900 });
  try {
    await expect(page.getByText(originalTitle, { exact: true })).toBeVisible();
    await expect(page.getByText(changedTitle, { exact: true })).toHaveCount(0);
    await page.screenshot({
      path: "/tmp/timenook-t21-original-audio-1280.png",
    });
    const audio = await playClip(page, 1);
    await page.evaluate(() => {
      location.hash = "/home";
    });
    await expectRemoved(page, audio);
    await expect(page.getByText(originalTitle, { exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
  } catch (error) {
    await recordFailure(page, error);
    throw error;
  } finally {
    await page.context().close();
  }
});

test("sharing withdrawal and account change clear private metadata and deny new downloads", async ({
  browser,
}) => {
  const buyerSession = fixture.data(
    await fixture.app.inject({
      method: "POST",
      url: "/v1/sessions/wechat",
      payload: { code: `${project.buyer.who}:${randomUUID()}` },
    }),
  );
  const page = await openAudio(browser, buyerSession);
  try {
    await nativeSessionBridge(page, outsiderWho);
    await expect(page.getByText(originalTitle, { exact: true })).toBeVisible();
    const audio = await playClip(page, 1);
    fixture.data(
      (await fixture.choose(project, project.narrator.token, "sharing", false))
        .response,
    );
    await page.getByRole("button", { name: "重新查询", exact: true }).click();
    await expect(page.getByText(originalTitle, { exact: true })).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "播放第 1 段", exact: true }),
    ).toHaveCount(0);
    await expectRemoved(page, audio);
    await page.screenshot({ path: "/tmp/timenook-t21-denied-390.png" });
    const loggedOut = page.waitForResponse(
      (response) =>
        response.request().method() === "DELETE" &&
        response.url().includes("/sessions/"),
    );
    await page.getByRole("button", { name: "退出登录", exact: true }).click();
    expect((await loggedOut).status()).toBe(204);
    await expect(
      page.getByRole("button", { name: "微信登录后回听", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "微信登录后回听", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "重新查询", exact: true }),
    ).toBeVisible();
    await expect(page.getByText(originalTitle, { exact: true })).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "播放第 1 段", exact: true }),
    ).toHaveCount(0);
    expect(errors).toEqual([]);
  } catch (error) {
    await recordFailure(page, error);
    throw error;
  } finally {
    await page.context().close();
  }
});
