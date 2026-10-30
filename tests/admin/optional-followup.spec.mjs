import { chooseDefaultQuestion } from "./recording-step-helper.mjs";
import {
  prepareRecordingStep,
  showProcessingStep,
} from "./recording-step-helper.mjs";
import {
  createPrivacyFixtureApplication,
  closePrivacyFixtureApplication,
} from "./privacy-fixture.mjs";
import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
const apiRequire = createRequire(resolve("apps/api/package.json"));
const { PrismaClient } = apiRequire("@prisma/client");
const Redis = apiRequire("ioredis");
const schema = `t17_browser_${randomUUID().replaceAll("-", "")}`;
let api,
  runtime,
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
const apiPort = Number(process.env.TIMENOOK_FOLLOWUP_API_PORT ?? 3429);
const previewPort = Number(process.env.TIMENOOK_FOLLOWUP_PREVIEW_PORT ?? 5181);
const base = `http://127.0.0.1:${previewPort}`;
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
  root = await mkdtemp(join(tmpdir(), "timenook-followup-browser-"));
  audioBase64 = readFileSync(
    resolve("apps/api/test/fixtures/synthetic-1s.mp3"),
  ).toString("base64");
  const { paymentConfig, paymentFetch, paid } = apiRequire(
    "./dist-test/test/payment-fixture.js",
  );
  api = await createPrivacyFixtureApplication(
    {
      environment: "test",
      host: "127.0.0.1",
      port: apiPort,
      databaseUrl,
      redisUrl: process.env.REDIS_URL,
      redisKeyPrefix: schema,
      wechat: { appId: paymentConfig.appId, secret: "synthetic" },
      payments: paymentConfig,
      participation: { mode: "synthetic-d08" },
      recording: { mode: "synthetic-local", storageRoot: root },
      transcription: {
        mode: "synthetic-local",
        configVersion: "synthetic-t17-browser-asr",
        doubao: {
          apiKey: "synthetic-key",
          resourceId: "synthetic-resource",
          fetchWindowSeconds: 60,
        },
        pollIntervalMs: 0,
        submissionReservationFen: 1,
        deadlineMs: 600000,
      },
      generation: {
        mode: "synthetic-local",
        configVersion: "synthetic-t17-browser-question",
        deepseek: {
          apiKey: "synthetic-key",
          model: "synthetic-question",
          maxTokens: 4000,
        },
        submissionReservationFen: 1,
        maxSubmissions: 10,
        deadlineMs: 600000,
      },
    },
    {
      paymentFetch,
      recordingObjects: new (class
        extends apiRequire("./dist-test/src/probe/local-objects.js")
          .LocalProbeObjects
      {
        async asrSource(key) {
          return {
            url: `https://synthetic.oss-cn-shanghai.aliyuncs.com/${key}?synthetic=private`,
            expiresAt: new Date(Date.now() + 120000).toISOString(),
            credentialsExpireAt: new Date(Date.now() + 180000).toISOString(),
          };
        }
      })(root),
      aiFetch: async (input, init) => {
        if (String(input).includes("deepseek.com")) {
          const source = JSON.parse(
            JSON.parse(String(init.body)).messages[1].content,
          );
          return Response.json({
            model: "synthetic-question",
            usage: {
              prompt_tokens: 10,
              completion_tokens: 20,
              total_tokens: 30,
            },
            choices: [
              {
                finish_reason: "stop",
                message: {
                  role: "assistant",
                  content: JSON.stringify({
                    action: "ask",
                    question: "关于那一年的经历，您最记得哪个场景？",
                    intent: "scene",
                    sourceRefs: source.sourceRefs,
                    reasonCode: "SCENE_AVAILABLE",
                  }),
                },
              },
            ],
          });
        }
        const id = new Headers(init.headers).get("X-Api-Request-Id");
        return new Response(
          JSON.stringify(
            String(input).endsWith("/query")
              ? {
                  task_id: id,
                  result: {
                    text: "那一年我第一次出门，后来家门口的树长高了。",
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
  for (const purpose of ["collection", "sharing", "ai"]) {
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
  await api.listen(apiPort, "127.0.0.1");
  preview = spawn(
    process.execPath,
    [
      "node_modules/vite/bin/vite.js",
      "--host",
      "127.0.0.1",
      "--port",
      String(previewPort),
      "--strictPort",
    ],
    {
      cwd: resolve("."),
      env: {
        ...process.env,
        TIMENOOK_API_BASE_URL: `${base}/api/v1`,
        TIMENOOK_PREVIEW_API_TARGET: `http://127.0.0.1:${apiPort}`,
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
      "/tmp/timenook-t17-browser-debug.txt",
      await latestPage.locator("body").innerText(),
    );
    await writeFile(
      "/tmp/timenook-t17-browser-errors.json",
      JSON.stringify(errors),
    );
    await latestPage.screenshot({
      path: "/tmp/timenook-t17-browser-failure.png",
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
      });
    },
    { session, base, audioBase64 },
  );
  return page;
}

test("actual interview Page, HTTP and Worker display and rewrite one optional question and seal its answer with real source ownership", async ({
  browser,
}) => {
  const page = await openPage(browser, narrator);
  page.setDefaultTimeout(5000);
  await page.goto(`${base}/#/interview?projectId=${projectId}`);
  await chooseDefaultQuestion(page);
  const current = () =>
    request("GET", `/v1/projects/${projectId}/interviews`, narrator).then(
      (r) => data(r, 200).interviews[0],
    );
  const record = async () => {
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
    await page
      .getByRole("button", { name: "提交这段讲述", exact: true })
      .click();
    await expect(
      page.getByText("录音已在测试环境保存；这不代表真实云端存储。", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "整理成故事", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "再聊一个问题", exact: true }),
    ).toHaveCount(0);
    const saved = await current();
    await expect
      .poll(async () => {
        await runtime.recoverDue();
        const tasks = data(
          await request(
            "POST",
            `/v1/projects/${projectId}/tasks/status`,
            narrator,
            {
              interviewId: saved.id,
            },
          ),
        );
        return tasks.map((task) => task.state);
      })
      .toEqual(saved.clips.map(() => "succeeded"));
    await page
      .getByRole("button", { name: "重新查询转写状态", exact: true })
      .click();
    await expect(page.getByText("文字已转写", { exact: true })).toBeVisible();
  };
  await record();
  const first = await current();
  const db = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    await expect
      .poll(async () => {
        await runtime.recoverDue();
        return db.formalTranscript.count({ where: { projectId } });
      })
      .toBe(1);
    await page
      .getByRole("button", { name: "再聊一个问题", exact: true })
      .click();
    await expect
      .poll(async () => {
        await runtime.recoverDue();
        return db.productionTask.count({
          where: { projectId, kind: "ask_followup", state: "succeeded" },
        });
      })
      .toBe(1);
    await expect(
      page.getByText("关于那一年的经历，您最记得哪个场景？", { exact: true }),
    ).toBeVisible({ timeout: 15000 });
    const shown = await current();
    expect(shown.actualQuestion.id).toBe(first.actualQuestion.id);
    expect(shown.currentQuestion.source.kind).toBe("follow-up");
    expect(shown.questionHistory).toHaveLength(2);
    await page
      .getByRole("button", { name: "换成自己的问法", exact: true })
      .click();
    await page
      .locator(".optional-followup textarea")
      .fill("那一年您最记得哪件事？");
    await page
      .getByRole("button", { name: "保存实际改写的问题", exact: true })
      .click();
    await expect(
      page.getByText("那一年您最记得哪件事？", { exact: true }),
    ).toBeVisible();
    const edited = await current();
    expect(edited.currentQuestion.source.generationTaskId).toBe(
      shown.currentQuestion.source.generationTaskId,
    );
    expect(edited.questionHistory[2].parentActualQuestionId).toBe(
      shown.currentQuestion.id,
    );
    await page.locator("#page").evaluate((n) => (n.scrollTop = 0));
    await page.screenshot({
      path: test.info().outputPath("optional-followup-390.png"),
    });
    const sizes = await page
      .locator(".optional-followup button")
      .evaluateAll((ns) =>
        ns.map((n) => ({
          font: parseFloat(getComputedStyle(n).fontSize),
          width: n.getBoundingClientRect().width,
          height: n.getBoundingClientRect().height,
        })),
      );
    expect(sizes.length).toBeGreaterThan(0);
    for (const size of sizes) {
      // The approved UI uses 15–17px operation text.
      expect(size.font).toBeGreaterThanOrEqual(15);
      expect(size.width).toBeGreaterThanOrEqual(48);
      expect(size.height).toBeGreaterThanOrEqual(48);
    }
    await page.setViewportSize({ width: 768, height: 1000 });
    expect(
      await page
        .locator("#phone")
        .evaluate((n) => n.getBoundingClientRect().width),
    ).toBe(390);
    await page.screenshot({
      path: test.info().outputPath("optional-followup-outer768-content390.png"),
    });
    await record();
    const answered = await current();
    expect(answered.clips.map((c) => c.actualQuestionId).sort()).toEqual(
      [first.actualQuestion.id, edited.currentQuestion.id].sort(),
    );
    await showProcessingStep(page);
    await page.getByRole("button", { name: "整理成故事", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`story.*interviewId=${first.id}`));
    await page.goto(
      `${base}/#/interview?projectId=${projectId}&draftId=${randomUUID()}&prepare=1`,
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
    await expect(
      page.getByText("这段讲述还在本机", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "整理成故事", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "再聊一个问题", exact: true }),
    ).toHaveCount(0);
    // Keep this unsubmitted recording in its own interview; only the fully
    // transcribed interview may open another question or finish the follow-up.
    await page.goto(
      `${base}/#/interview?projectId=${projectId}&interviewId=${first.id}`,
    );
    await expect(page.getByText("文字已转写", { exact: true })).toBeVisible();
    const pending = await page.evaluate(() =>
      Object.entries(localStorage).filter(([key]) => key.includes("recording")),
    );
    expect(
      pending.some(([, value]) => {
        const clips = JSON.parse(value);
        return Array.isArray(clips) && clips.some((clip) => !clip.sealed);
      }),
    ).toBe(true);
    // Drop a genuine successful HTTP response at exact device expiry to model a transport timeout.
    await page.route(
      `**/interviews/${first.id}/follow-up/finish`,
      async (route) => {
        const response = await route.fetch();
        expect(response.status()).toBe(201);
        await page.evaluate((expiresAt) => {
          Date.now = () => Date.parse(expiresAt);
        }, narrator.session.expiresAt);
        await route.abort("timedout");
      },
    );
    await showProcessingStep(page);
    await page
      .getByRole("button", { name: "再聊一个问题", exact: true })
      .click();
    await page
      .getByRole("button", { name: "就讲到这里，整理故事", exact: true })
      .click();
    await expect(page.getByText(/当前权限已失效/)).toBeVisible();
    await expect(
      page.locator(".live-interview .interview-question"),
    ).toHaveCount(0);
    await expect(page.locator(".optional-followup")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "开始说", exact: true }),
    ).toHaveCount(0);
    expect(
      await page.evaluate(() =>
        Object.entries(localStorage).filter(([key]) =>
          key.includes("recording"),
        ),
      ),
    ).toEqual(pending);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("net::ERR_TIMED_OUT");
  } catch (error) {
    await writeFile(
      "/tmp/timenook-t17-browser-state.json",
      JSON.stringify(
        {
          errors,
          body: await page
            .locator("body")
            .innerText()
            .catch(() => "closed"),
          tasks: await db.productionTask
            .findMany({
              where: { projectId },
              select: { kind: true, state: true, errorCode: true },
            })
            .catch(() => []),
        },
        null,
        2,
      ),
    );
    throw error;
  } finally {
    await db.$disconnect();
    await page
      .context()
      .close()
      .catch(() => {});
  }
});
