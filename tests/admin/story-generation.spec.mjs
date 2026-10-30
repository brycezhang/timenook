import { resumeVisiblePage } from "./recording-step-helper.mjs";
import { openInterviewPhotos, storyAction } from "./recording-step-helper.mjs";
import {
  prepareRecordingStep,
  showProcessingStep,
} from "./recording-step-helper.mjs";
import {
  createPrivacyFixtureApplication,
  closePrivacyFixtureApplication,
} from "./privacy-fixture.mjs";
import { test, expect } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
const apiRequire = createRequire(resolve("apps/api/package.json"));
const { PrismaClient } = apiRequire("@prisma/client");
const Redis = apiRequire("ioredis");
const schema = `t18_browser_${randomUUID().replaceAll("-", "")}`;
let api,
  runtime,
  taskId,
  config,
  preview,
  databaseUrl,
  projectId,
  buyer,
  narrator,
  root,
  audioBase64,
  versionId,
  latestPage;
const errors = [];
let invalidComposition = false;
let noContentComposition = false;
const base = "http://127.0.0.1:5180";
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
  root = await mkdtemp(join(tmpdir(), "timenook-story-browser-"));
  audioBase64 = readFileSync(
    resolve("apps/api/test/fixtures/synthetic-1s.mp3"),
  ).toString("base64");
  const { LocalProbeObjects } = apiRequire(
    "./dist-test/src/probe/local-objects.js",
  );
  class Objects extends LocalProbeObjects {
    async asrSource(key) {
      return {
        url: `https://synthetic.oss-cn-shanghai.aliyuncs.com/${key}?synthetic=private`,
        expiresAt: new Date(Date.now() + 120000).toISOString(),
        credentialsExpireAt: new Date(Date.now() + 180000).toISOString(),
      };
    }
  }
  const { paymentConfig, paymentFetch, paid } = apiRequire(
    "./dist-test/test/payment-fixture.js",
  );
  api = await createPrivacyFixtureApplication(
    (config = {
      admin: {
        origin: "https://localhost:5180",
        sessionKey: randomBytes(32).toString("base64"),
        sessionTtlSeconds: 28800,
        challengeTtlSeconds: 300,
      },
      generation: {
        mode: "synthetic-local",
        configVersion: "synthetic-t18-browser",
        deepseek: {
          apiKey: "synthetic-key",
          model: "synthetic-story",
          maxTokens: 4000,
        },
        submissionReservationFen: 1,
        maxSubmissions: 10,
        deadlineMs: 600000,
      },
      transcription: {
        mode: "synthetic-local",
        configVersion: "synthetic-t15-browser",
        doubao: {
          apiKey: "synthetic-key",
          resourceId: "synthetic-resource",
          fetchWindowSeconds: 60,
        },
        pollIntervalMs: 0,
        submissionReservationFen: 1,
        deadlineMs: 600000,
      },
      environment: "test",
      host: "127.0.0.1",
      port: 3428,
      databaseUrl,
      redisUrl: process.env.REDIS_URL,
      redisKeyPrefix: schema,
      wechat: { appId: paymentConfig.appId, secret: "synthetic" },
      payments: paymentConfig,
      participation: { mode: "synthetic-d08" },
      recording: { mode: "synthetic-local", storageRoot: root },
      photos: {
        mode: "synthetic-local",
        placement: { widthMm: 100, heightMm: 150 },
      },
    }),
    {
      paymentFetch,
      recordingObjects: new Objects(root),
      aiFetch: async (input, init) => {
        if (String(input).includes("deepseek.com")) {
          const source = JSON.parse(
            JSON.parse(String(init.body)).messages[1].content,
          );
          const output = {
            title: "那些年我记得的事",
            theme: "旧时光",
            paragraphs: [
              {
                text: "那一年我第一次离开家，心里又期待又舍不得。".repeat(12),
                sourceRefs: [source.sourceRefs[0]],
              },
              {
                text: "后来我记得家门口那棵树，一年又一年长高。".repeat(12),
                sourceRefs: [source.sourceRefs[1]],
              },
              {
                text: "这就是这段讲述的最后一段，所有文字都保留了。",
                sourceRefs: source.sourceRefs,
              },
            ],
            reviewItems: [
              "出门的具体年份待本人核对",
              "家门口那棵树的品种尚不确定",
            ],
          };
          return new Response(
            JSON.stringify({
              model: "synthetic-story",
              usage: {
                prompt_tokens: 20,
                completion_tokens: 40,
                total_tokens: 60,
              },
              choices: [
                {
                  finish_reason: "stop",
                  message: {
                    role: "assistant",
                    content: JSON.stringify(
                      noContentComposition
                        ? {
                            status: "not_applicable",
                            title: null,
                            theme: null,
                            paragraphs: [],
                            reviewItems: [],
                          }
                        : invalidComposition
                          ? {
                              ...output,
                              paragraphs: [
                                {
                                  text: "无来源正文",
                                  sourceRefs: ["invented"],
                                },
                              ],
                            }
                          : output,
                    ),
                  },
                },
              ],
            }),
          );
        }
        const id = new Headers(init.headers).get("X-Api-Request-Id");
        return new Response(
          JSON.stringify(
            String(input).endsWith("/query")
              ? {
                  task_id: id,
                  result: {
                    text: "我那一年第一次出门，后来家门口的树长高了。",
                  },
                }
              : {},
          ),
          { headers: { "X-Api-Status-Code": "20000000" } },
        );
      },
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
  const draftId = randomUUID();
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
  for (const purpose of ["collection", "ai", "sharing"]) {
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
  runtime = await apiRequire(
    "./dist-test/src/tasks/worker.js",
  ).startProductionWorker(api);
  await api.listen(3428, "127.0.0.1");
  preview = spawn(
    process.execPath,
    [
      "node_modules/vite/bin/vite.js",
      "--host",
      "127.0.0.1",
      "--port",
      "5180",
      "--strictPort",
    ],
    {
      cwd: resolve("."),
      env: {
        ...process.env,
        TIMENOOK_API_BASE_URL: `${base}/api/v1`,
        TIMENOOK_PREVIEW_API_TARGET: "http://127.0.0.1:3428",
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
  await runtime?.close();
  await closePrivacyFixtureApplication(api);
  if (root) await rm(root, { recursive: true, force: true });
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

test.afterEach(async ({}, info) => {
  if (
    info.status !== info.expectedStatus &&
    latestPage &&
    !latestPage.isClosed()
  ) {
    await writeFile(
      "/tmp/timenook-t18-browser-debug.txt",
      await latestPage.locator("body").innerText(),
    );
    await latestPage.screenshot({
      path: "/tmp/timenook-t18-browser-failure.png",
    });
  }
});
async function openPage(
  browser,
  session,
  viewport = { width: 390, height: 844 },
) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  latestPage = page;
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/\b(?:40[139]|503)\b/.test(m.text()))
      errors.push(m.text());
  });
  await page.goto(base);
  await page.evaluate(
    ({ session, base, audioBase64 }) => {
      localStorage.setItem("timenook.mode.v1", JSON.stringify("live"));
      localStorage.setItem(
        `timenook.session.v1:${base}/api/v1`,
        JSON.stringify(session),
      );
      // Only the native device/file boundary is controlled. Page, HTTP and PG remain real.
      const source = `data:audio/mpeg;base64,${audioBase64}`,
        handlers = {};
      window.syntheticDevice = { starts: 0 };
      window.syntheticPlayback = {
        src: "",
        plays: 0,
        destroyed: 0,
        removed: [],
      };
      window.browserAudioFactory = window.wx.createInnerAudioContext;
      window.wx.createInnerAudioContext = () => ({
        src: "",
        onEnded() {},
        onError() {},
        pause() {},
        stop() {},
        play() {
          window.syntheticPlayback.src = this.src;
          window.syntheticPlayback.plays++;
        },
        destroy() {
          window.syntheticPlayback.destroyed++;
        },
      });
      const emit = (name, value) => handlers[name]?.forEach((fn) => fn(value));
      window.wx.getRecorderManager = () => ({
        onStart: (fn) => (handlers.start ??= []).push(fn),
        onStop: (fn) => (handlers.stop ??= []).push(fn),
        onError: (fn) => (handlers.error ??= []).push(fn),
        onInterruptionBegin: (fn) => (handlers.interrupt ??= []).push(fn),
        start: () => {
          window.syntheticDevice.starts++;
          emit("start");
        },
        stop: () => emit("stop", { tempFilePath: source, duration: 1080 }),
      });
      const fs = window.wx.getFileSystemManager();
      window.wx.getFileSystemManager = () => ({
        ...fs,
        saveFile: (o) => o.success({ savedFilePath: o.tempFilePath }),
        unlink: (o) =>
          fs.unlink({
            ...o,
            success: (r) => {
              window.syntheticPlayback.removed.push(o.filePath);
              o.success?.(r);
            },
          }),
      });
    },
    { session, base, audioBase64 },
  );
  return page;
}

async function savedInterview() {
  const interview = data(
      await request("POST", `/v1/projects/${projectId}/interviews`, narrator, {
        clientInterviewId: randomUUID(),
        expectedPlanRevision: 1,
        starterKind: "free-narration",
      }),
    ),
    audio = Buffer.from(audioBase64, "base64");
  const { createHash } = await import("node:crypto");
  for (let n = 0; n < 2; n++) {
    const path = `/v1/projects/${projectId}/interviews/${interview.id}/clips`,
      clip = data(
        await request("POST", path, narrator, {
          clientClipId: randomUUID(),
          bytes: audio.length,
          sha256: createHash("sha256").update(audio).digest("hex"),
        }),
      ),
      form = data(
        await request("POST", `${path}/${clip.id}/upload`, narrator, {}),
      ),
      boundary = `story-${randomUUID()}`;
    const fields = Object.entries(form.fields).map(([key, value]) =>
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`,
      ),
    );
    const payload = Buffer.concat([
      ...fields,
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="synthetic.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`,
      ),
      audio,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    expect(
      (
        await api.inject({
          method: "POST",
          url: form.url,
          headers: {
            authorization: `Bearer ${narrator.session.token}`,
            "content-type": `multipart/form-data; boundary=${boundary}`,
          },
          payload,
        })
      ).statusCode,
    ).toBe(204);
    data(await request("POST", `${path}/${clip.id}/seal`, narrator, {}));
  }
  return interview;
}
test("real story Page submits, leaves and restores the same task then renders every paragraph and review item", async ({
  browser,
}) => {
  const interview = await savedInterview(),
    page = await openPage(browser, narrator);
  try {
    await page.goto(
      `${base}/#/interview?projectId=${projectId}&interviewId=${interview.id}`,
    );
    await expect(
      page.getByRole("button", { name: "整理成故事", exact: true }),
    ).toBeVisible({ timeout: 5000 });
    await showProcessingStep(page);
    await page.getByRole("button", { name: "整理成故事", exact: true }).click();
    await expect(page).toHaveURL(
      new RegExp(
        `/story\\?projectId=${projectId}&interviewId=${interview.id}&organize=1$`,
      ),
    );
    const beforeSubmission = data(
      await request(
        "POST",
        `/v1/projects/${projectId}/stories/context`,
        narrator,
        { interviewId: interview.id },
      ),
    );
    await expect
      .poll(
        async () =>
          data(
            await request(
              "POST",
              `/v1/projects/${projectId}/stories/context`,
              narrator,
              { interviewId: interview.id },
            ),
          ).story?.task?.state,
      )
      .toBe("waiting_inputs");
    await expect(
      page.getByText("正在等待全部录音转写，可离开", { exact: true }),
    ).toBeVisible();
    const context = data(
        await request(
          "POST",
          `/v1/projects/${projectId}/stories/context`,
          narrator,
          { interviewId: interview.id },
        ),
      ),
      id = context.story.task.id;
    await page.screenshot({ path: "/tmp/timenook-t18-waiting-390.png" });
    await page
      .getByRole("button", { name: "回采访页继续讲", exact: true })
      .click();
    await page
      .getByRole("button", { name: "今天先到这里", exact: true })
      .click();
    await page
      .locator(".resume-row")
      .filter({ hasText: `${interview.actualQuestion.snapshot.text}` })
      .click();
    await showProcessingStep(page);
    await page.getByRole("button", { name: "整理成故事", exact: true }).click();
    await expect(
      page.getByText("正在等待全部录音转写，可离开", { exact: true }),
    ).toBeVisible();
    const restored = data(
      await request(
        "POST",
        `/v1/projects/${projectId}/stories/context`,
        narrator,
        { interviewId: interview.id },
      ),
    );
    expect(restored.story.task.id).toBe(id);
    expect(restored.story.usage.organizations).toBe(
      context.story.usage.organizations,
    );
    const { ProductionTasks } = apiRequire("./dist-test/src/tasks/tasks.js");
    for (const source of context.story.task.sources) {
      await api.get(ProductionTasks).run(source.transcriptionTaskId);
      await api.get(ProductionTasks).run(source.transcriptionTaskId);
    }
    const db = new PrismaClient({ datasourceUrl: databaseUrl });
    await db.productionTask.update({
      where: { id },
      data: { nextRunAt: new Date(0) },
    });
    await db.$disconnect();
    const completed = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Worker timeout")),
        10000,
      );
      function done(job) {
        if (job.id === id) {
          clearTimeout(timer);
          runtime.worker.off("completed", done);
          resolve();
        }
      }
      runtime.worker.on("completed", done);
    });
    await runtime.recoverDue();
    await completed;
    await expect(
      page.getByText("故事已整理，待本人核对", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("这就是这段讲述的最后一段，所有文字都保留了。", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByText(/出门的具体年份待本人核对/)).toBeVisible();
    await expect(
      page.getByText("AI 整理 · 待本人核对", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "本人确认或调整这版决定", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "先核对待确认事项", exact: true }),
    ).toBeEnabled();
    await expect(page.locator(".live-error")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "确认这版内容", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "不确认／撤回确认", exact: true }),
    ).toBeEnabled();
    const body = page.locator(".live-story .paragraph");
    expect(await body.count()).toBe(3);
    expect(
      await body
        .first()
        .evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
    ).toBeGreaterThanOrEqual(20);
    expect(
      await page
        .getByRole("button", { name: "没问题，同意入书", exact: true })
        .count(),
    ).toBe(0);
    expect(await page.title()).not.toBe("");
    expect(
      await page
        .locator("body")
        .innerText()
        .catch(() => "closed"),
    ).not.toContain("页面渲染失败");
    expect(await page.locator("vite-error-overlay").count()).toBe(0);
    await page.screenshot({
      path: "/tmp/timenook-t18-story-390.png",
      fullPage: true,
    });
    const reviews = page.locator(".live-story .live-reviews").filter({
      has: page.locator(".section-title").filter({
        hasText: /^请本人核对$/,
      }),
    });
    await expect(reviews).toHaveCount(1);
    await expect(reviews.locator(".live-review")).toHaveText([
      "1. 出门的具体年份待本人核对",
      "2. 家门口那棵树的品种尚不确定",
    ]);
    await reviews.scrollIntoViewIfNeeded();
    await page.screenshot({ path: "/tmp/timenook-t18-story-review-390.png" });
    const currentStory = data(
      await request(
        "GET",
        `/v1/projects/${projectId}/stories/${context.story.id}`,
        narrator,
      ),
      200,
    );
    expect(currentStory.task.id).toBe(id);
    expect(currentStory.revision.audioManifest).toHaveLength(2);
    expect(
      currentStory.revision.audioManifest.map((source) => source.clipId),
    ).toEqual(context.story.task.sources.map((source) => source.clipId));
    await storyAction(page, "回听已保存的原声");
    const audioOrder = page.locator(".live-story .live-reviews").filter({
      has: page.getByText("本版关联的原声顺序", { exact: true }),
    });
    await expect(audioOrder).toHaveCount(1);
    await expect(audioOrder.locator(".live-review")).toHaveText(
      currentStory.revision.audioManifest.map(
        (source, index) =>
          `第 ${index + 1} 段：${source.question.snapshot.text}`,
      ),
    );
    await audioOrder.scrollIntoViewIfNeeded();
    await expect(audioOrder).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 900 });
    expect(
      await page
        .locator(".live-story")
        .evaluate((el) => el.getBoundingClientRect().width),
    ).toBeLessThanOrEqual(390);
    await page.screenshot({
      path: "/tmp/timenook-t18-story-1280.png",
      fullPage: true,
    });
    await storyAction(page, "回听已保存的原声");
    await expect(
      page.getByRole("button", { name: "回听第 1 段原声", exact: true }),
    ).toBeVisible();
    await storyAction(page, "回听已保存的原声");
    await page
      .getByRole("button", { name: "回听第 1 段原声", exact: true })
      .click();
    await expect
      .poll(() => page.evaluate(() => window.syntheticPlayback.plays))
      .toBe(1);
    const played = await page.evaluate(async () => {
      const bytes = await fetch(window.syntheticPlayback.src).then((r) =>
        r.arrayBuffer(),
      );
      return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
        .map((n) => n.toString(16).padStart(2, "0"))
        .join("");
    });
    const { createHash } = await import("node:crypto");
    expect(played).toBe(
      createHash("sha256")
        .update(Buffer.from(audioBase64, "base64"))
        .digest("hex"),
    );
    await storyAction(page, "继续补充讲述");
    await expect
      .poll(() => page.evaluate(() => window.syntheticPlayback.destroyed))
      .toBe(1);
    expect(
      await page.evaluate(() =>
        window.syntheticPlayback.removed.includes(window.syntheticPlayback.src),
      ),
    ).toBe(true);
    expect(errors).toEqual([]);
  } catch (error) {
    await writeFile(
      "/tmp/timenook-t18-browser-debug.txt",
      JSON.stringify(
        {
          url: page.url(),
          body: await page
            .locator("body")
            .innerText()
            .catch(() => "closed"),
          errors,
        },
        null,
        2,
      ),
    );
    throw error;
  } finally {
    await page
      .context()
      .close()
      .catch(() => {});
  }
});

async function wakeBrowserTask(id) {
  const completed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Worker timeout")), 10000);
    function done(job) {
      if (job.id === id) {
        clearTimeout(timer);
        runtime.worker.off("completed", done);
        resolve();
      }
    }
    runtime.worker.on("completed", done);
  });
  await runtime.recoverDue();
  await completed;
}
test("the shared story screen displays transcribed text when no story was formed and preserves it after refresh", async ({
  browser,
}) => {
  const interview = await savedInterview();
  const { ProductionTasks } = apiRequire("./dist-test/src/tasks/tasks.js");
  const audio = data(
    await request("POST", `/v1/projects/${projectId}/tasks/status`, narrator, {
      interviewId: interview.id,
    }),
  );
  for (const task of audio) {
    await api.get(ProductionTasks).run(task.id);
    await api.get(ProductionTasks).run(task.id);
  }
  const story = data(
    await request(
      "POST",
      `/v1/projects/${projectId}/stories/organize`,
      narrator,
      { interviewId: interview.id, baseVersion: 0 },
    ),
    202,
  );
  noContentComposition = true;
  try {
    await api.get(ProductionTasks).run(story.task.id);
  } finally {
    noContentComposition = false;
  }
  const page = await openPage(browser, narrator);
  try {
    await page.goto(
      `${base}/#/story?projectId=${projectId}&interviewId=${interview.id}`,
    );
    await expect(
      page.getByText("已识别到文字，暂未形成故事，可以继续补充讲述", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.locator(".live-transcripts .paragraph")).toHaveCount(2);
    await expect(page.locator(".live-audio-button")).toHaveCount(2);
    await expect(page.locator(".live-sources")).toHaveCount(0);
    await page.evaluate(() => {
      window.playbackParagraph = document.querySelector(
        ".live-transcripts .paragraph",
      );
      window.realPlayback = { players: 0, player: null };
      window.wx.createInnerAudioContext = () => {
        const player = window.browserAudioFactory();
        window.realPlayback.players++;
        window.realPlayback.player = player;
        return player;
      };
    });
    await page
      .getByRole("button", { name: "回听第 1 段原声", exact: true })
      .click();
    await expect
      .poll(() =>
        page.evaluate(() => window.realPlayback.player?.currentTime ?? 0),
      )
      .toBeGreaterThan(0);
    await page.locator(".live-audio-button").first().click();
    await expect
      .poll(() => page.evaluate(() => window.realPlayback.player.paused))
      .toBe(true);
    const pausedAt = await page.evaluate(
      () => window.realPlayback.player.currentTime,
    );
    await page.locator(".live-audio-button").first().click();
    await expect
      .poll(() => page.evaluate(() => window.realPlayback.player.currentTime))
      .toBeGreaterThan(pausedAt);
    expect(await page.evaluate(() => window.realPlayback.players)).toBe(1);
    expect(
      await page.evaluate(() => window.playbackParagraph.isConnected),
    ).toBe(true);
    await page.locator(".live-audio-button").first().click();
    await expect(
      page.getByRole("button", { name: "继续回听第 1 段原声", exact: true }),
    ).toBeEnabled();
    await expect(
      page.locator(".live-transcripts .paragraph").first(),
    ).toHaveText("我那一年第一次出门，后来家门口的树长高了。");
    await expect(
      page.getByText("未识别到有效语音，请再录一段", { exact: true }),
    ).toHaveCount(0);
    await page.reload();
    await expect(page.getByText("已识别的内容", { exact: true })).toBeVisible();
    await expect(page.locator(".live-error")).toHaveCount(0);
    await page.setViewportSize({ width: 320, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({ path: "/tmp/timenook-story-no-content-320.png" });
    await page
      .getByRole("button", { name: "回采访页继续讲", exact: true })
      .click();
    await expect(page).toHaveURL(
      new RegExp(
        `/interview\\?projectId=${projectId}&interviewId=${interview.id}`,
      ),
    );
    expect(errors).toEqual([]);
  } finally {
    await page.context().close();
  }
});
test("the rendered failed story retries from its saved sources and recovers without another user intent", async ({
  browser,
}) => {
  const interview = await savedInterview(),
    page = await openPage(browser, narrator);
  try {
    const { ProductionTasks } = apiRequire("./dist-test/src/tasks/tasks.js"),
      audio = data(
        await request(
          "POST",
          `/v1/projects/${projectId}/tasks/status`,
          narrator,
          { interviewId: interview.id },
        ),
      );
    for (const task of audio) {
      await api.get(ProductionTasks).run(task.id);
      await api.get(ProductionTasks).run(task.id);
    }
    await page.goto(
      `${base}/#/story?projectId=${projectId}&interviewId=${interview.id}`,
    );
    await page.getByRole("button", { name: "整理故事", exact: true }).click();
    await expect(
      page.getByText("正在等待全部录音转写，可离开", { exact: true }),
    ).toBeVisible();
    const context = data(
        await request(
          "POST",
          `/v1/projects/${projectId}/stories/context`,
          narrator,
          { interviewId: interview.id },
        ),
      ),
      id = context.story.task.id;
    invalidComposition = true;
    await wakeBrowserTask(id);
    await expect(
      page.getByText("整理失败，原声仍保留", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "从原素材重试", exact: true }),
    ).toBeEnabled();
    await page.screenshot({ path: "/tmp/timenook-t18-failure-390.png" });
    invalidComposition = false;
    await page
      .getByRole("button", { name: "从原素材重试", exact: true })
      .click();
    await expect(
      page.getByText("正在排队，可离开", { exact: true }),
    ).toBeVisible();
    await wakeBrowserTask(id);
    await expect(
      page.getByText("故事已整理，待本人核对", { exact: true }),
    ).toBeVisible();
    const recovered = data(
      await request(
        "GET",
        `/v1/projects/${projectId}/stories/${context.story.id}`,
        narrator,
      ),
      200,
    );
    expect(recovered.task.id).toBe(id);
    expect(recovered.task.attempts.length).toBe(2);
    expect(recovered.usage.organizations).toBe(
      context.story.usage.organizations,
    );
    expect(errors).toEqual([]);
  } finally {
    invalidComposition = false;
    await page
      .context()
      .close()
      .catch(() => {});
  }
});

test("entering story from the interview keeps an unsealed local recording recoverable and cannot submit a partial story", async ({
  browser,
}) => {
  const interview = await savedInterview(),
    page = await openPage(browser, narrator);
  try {
    await page.goto(
      `${base}/#/interview?projectId=${projectId}&interviewId=${interview.id}`,
    );
    await prepareRecordingStep(page);
    await page.getByRole("button", { name: "开始说", exact: true }).click();
    await page
      .getByRole("button", { name: "说完了，停止录音", exact: true })
      .click();
    await expect(
      page
        .locator(".local-recording")
        .getByText("已保存在这台设备，还未上传", { exact: true }),
    ).toBeVisible();
    await showProcessingStep(page);
    await page.getByRole("button", { name: "整理成故事", exact: true }).click();
    await expect(
      page.getByText("还有录音没有云端保存，请回采访页恢复", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "整理故事", exact: true }),
    ).toHaveCount(0);
    const context = data(
      await request(
        "POST",
        `/v1/projects/${projectId}/stories/context`,
        narrator,
        { interviewId: interview.id },
      ),
    );
    expect(context.story).toBeNull();
    await page
      .getByRole("button", { name: "回采访页恢复保存", exact: true })
      .click();
    await expect(
      page
        .locator(".local-recording")
        .getByText("已保存在这台设备，还未上传", { exact: true }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await page
      .context()
      .close()
      .catch(() => {});
  }
});

test("a hidden interview current-session HTTP 401 clears the active story, playing temporary audio and busy while retaining its pending original", async ({
  browser,
}) => {
  const interview = await savedInterview(),
    activeSession = await login("synthetic-plan-narrator"),
    page = await openPage(browser, activeSession);
  const { ProductionTasks } = apiRequire("./dist-test/src/tasks/tasks.js");
  const tasks = data(
    await request("POST", `/v1/projects/${projectId}/tasks/status`, narrator, {
      interviewId: interview.id,
    }),
  );
  for (const t of tasks) {
    await api.get(ProductionTasks).run(t.id);
    await api.get(ProductionTasks).run(t.id);
  }
  const organized = data(
    await request(
      "POST",
      `/v1/projects/${projectId}/stories/organize`,
      narrator,
      { interviewId: interview.id, baseVersion: 0 },
    ),
    202,
  );
  await api.get(ProductionTasks).run(organized.task.id);
  let releaseStatus,
    statusStarted,
    releaseContext,
    contextStarted,
    holdContext = false;
  const statusGate = new Promise((r) => (releaseStatus = r)),
    statusSeen = new Promise((r) => (statusStarted = r)),
    contextGate = new Promise((r) => (releaseContext = r)),
    contextSeen = new Promise((r) => (contextStarted = r));
  let heldStatus = false;
  await page.route("**/tasks/status", async (route) => {
    if (heldStatus) return route.continue();
    heldStatus = true;
    statusStarted();
    await statusGate;
    await route.continue();
  });
  await page.route("**/stories/context", async (route) => {
    if (!holdContext) return route.continue();
    contextStarted();
    await contextGate;
    await route.continue();
  });
  try {
    await page.goto(
      `${base}/#/interview?projectId=${projectId}&interviewId=${interview.id}`,
    );
    await statusSeen;
    await prepareRecordingStep(page);
    await page.getByRole("button", { name: "开始说", exact: true }).click();
    await page
      .getByRole("button", { name: "说完了，停止录音", exact: true })
      .click();
    await expect(
      page
        .locator(".local-recording")
        .getByText("已保存在这台设备，还未上传", { exact: true }),
    ).toBeVisible();
    const original = await page.evaluate(
      () =>
        Object.entries(localStorage)
          .map(([k, v]) => [k, JSON.parse(v)])
          .find(
            ([k, v]) =>
              k.includes("timenook.recording") && Array.isArray(v) && v.length,
          )?.[1],
    );
    expect(original).toHaveLength(1);
    await showProcessingStep(page);
    await page.getByRole("button", { name: "整理成故事", exact: true }).click();
    await expect(page.locator(".live-story .paragraph")).toHaveCount(3);
    await storyAction(page, "回听已保存的原声");
    await page
      .getByRole("button", { name: "回听第 1 段原声", exact: true })
      .click();
    await expect
      .poll(() => page.evaluate(() => window.syntheticPlayback.plays))
      .toBe(1);
    holdContext = true;
    await resumeVisiblePage(page);
    await contextSeen;
    const revoked = await api.inject({
      method: "DELETE",
      url: `/v1/sessions/${activeSession.session.id}`,
      headers: { authorization: `Bearer ${activeSession.session.token}` },
    });
    expect(revoked.statusCode, revoked.body).toBe(204);
    releaseStatus();
    await expect(page.locator(".live-story .paragraph")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "回采访页恢复保存", exact: true }),
    ).toBeEnabled();
    await expect
      .poll(() => page.evaluate(() => window.syntheticPlayback.destroyed))
      .toBe(1);
    expect(
      await page.evaluate(() =>
        window.syntheticPlayback.removed.includes(window.syntheticPlayback.src),
      ),
    ).toBe(true);
    const retained = await page.evaluate(
      () =>
        Object.entries(localStorage)
          .map(([k, v]) => [k, JSON.parse(v)])
          .find(
            ([k, v]) =>
              k.includes("timenook.recording") && Array.isArray(v) && v.length,
          )?.[1],
    );
    expect(retained).toEqual(original);
    expect(
      await page.evaluate(
        (path) => window.syntheticPlayback.removed.includes(path),
        original[0].path,
      ),
    ).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    releaseStatus();
    releaseContext();
    await page
      .context()
      .close()
      .catch(() => {});
  }
});

test("cancelling PhotoPage selection leaves the waiting story intact while actual supplementary recording obsoletes it", async ({
  browser,
}) => {
  const interview = await savedInterview(),
    page = await openPage(browser, narrator);
  try {
    await page.goto(
      `${base}/#/interview?projectId=${projectId}&interviewId=${interview.id}`,
    );
    await showProcessingStep(page);
    await page.getByRole("button", { name: "整理成故事", exact: true }).click();
    await expect(
      page.getByText("正在等待全部录音转写，可离开", { exact: true }),
    ).toBeVisible();
    const current = () =>
      request("POST", `/v1/projects/${projectId}/stories/context`, narrator, {
        interviewId: interview.id,
      }).then((r) => data(r));
    const before = await current();
    await page
      .getByRole("button", { name: "回采访页继续讲", exact: true })
      .click();
    await openInterviewPhotos(page);
    await page.evaluate(() => {
      window.wx.chooseMedia = (o) =>
        o.fail({ errMsg: "chooseMedia:fail cancel" });
    });
    await page.getByRole("button", { name: "选择原照片", exact: true }).click();
    await expect(page.getByText(/未取得照片，请重试/)).toBeVisible();
    const cancelled = await current();
    expect(cancelled.story.task.id).toBe(before.story.task.id);
    expect(cancelled.story.task.state).toBe("waiting_inputs");
    expect(cancelled.story.task.queuedAt).toBe(before.story.task.queuedAt);
    expect(cancelled.story.task.sources).toEqual(before.story.task.sources);
    expect(cancelled.clipCount).toBe(2);
    expect(cancelled.pendingCount).toBe(0);
    await page
      .getByRole("button", { name: "返回采访，开始说", exact: true })
      .click();
    await prepareRecordingStep(page);
    await page.getByRole("button", { name: "开始说", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "说完了，停止录音", exact: true }),
    ).toBeVisible();
    const recording = await current();
    expect(recording.story.task.id).toBe(before.story.task.id);
    expect(recording.story.task.state).toBe("obsolete");
    expect(recording.story.task.errorCode).toBe("INPUT_CHANGED");
    expect(recording.clipCount).toBe(2);
    expect(recording.pendingCount).toBe(0);
    await page
      .getByRole("button", { name: "说完了，停止录音", exact: true })
      .click();
    await expect(
      page
        .locator(".local-recording")
        .getByText("已保存在这台设备，还未上传", { exact: true }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await page
      .context()
      .close()
      .catch(() => {});
  }
});
