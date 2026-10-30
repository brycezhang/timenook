import { chooseDefaultQuestion } from "./recording-step-helper.mjs";
import { prepareRecordingStep } from "./recording-step-helper.mjs";
import {
  createPrivacyFixtureApplication,
  closePrivacyFixtureApplication,
} from "./privacy-fixture.mjs";
import { test, expect } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
const apiRequire = createRequire(resolve("apps/api/package.json"));
const { PrismaClient } = apiRequire("@prisma/client");
const Redis = apiRequire("ioredis");
const schema = `t14_browser_${randomUUID().replaceAll("-", "")}`;
let api,
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
const apiPort = Number(process.env.TIMENOOK_RECORDING_API_PORT ?? 3424);
const previewPort = Number(process.env.TIMENOOK_RECORDING_PREVIEW_PORT ?? 5176);
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
  root = await mkdtemp(join(tmpdir(), "timenook-recording-browser-"));
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
    },
    {
      paymentFetch,
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
  for (const purpose of ["collection", "sharing"]) {
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
      "/tmp/timenook-t14-browser-debug.txt",
      await latestPage.locator("body").innerText(),
    );
    await latestPage.screenshot({
      path: "/tmp/timenook-t14-browser-failure.png",
    });
  }
});
async function openPage(
  browser,
  session,
  viewport = { width: 390, height: 844 },
  realInput = false,
) {
  const context = await browser.newContext({ viewport });
  if (realInput)
    await context.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = async () => {
        const source = new AudioContext({ sampleRate: 48000 });
        const oscillator = source.createOscillator(),
          output = source.createMediaStreamDestination();
        oscillator.frequency.value = 440;
        oscillator.connect(output);
        oscillator.start();
        await source.resume();
        window.syntheticMicrophone = { source, output };
        return output.stream;
      };
    });
  const page = await context.newPage();
  latestPage = page;
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/\b(?:40[139]|503)\b/.test(m.text()))
      errors.push(m.text());
  });
  await page.goto(base);
  await page.evaluate(
    ({ session, base, audioBase64, realInput }) => {
      localStorage.setItem("timenook.mode.v1", JSON.stringify("live"));
      localStorage.setItem(
        `timenook.session.v1:${base}/api/v1`,
        JSON.stringify(session),
      );
      if (realInput) return;
      // Only the native device/file boundary is controlled. Page, HTTP and PG remain real.
      const source = `data:audio/mpeg;base64,${audioBase64}`,
        handlers = {};
      window.syntheticDevice = { starts: 0 };
      const emit = (name, value) => handlers[name]?.forEach((fn) => fn(value));
      window.wx.getRecorderManager = () => ({
        onStart: (fn) => (handlers.start ??= []).push(fn),
        onStop: (fn) => (handlers.stop ??= []).push(fn),
        onPause: (fn) => (handlers.pause ??= []).push(fn),
        onResume: (fn) => (handlers.resume ??= []).push(fn),
        pause: () => emit("pause"),
        resume: () => emit("resume"),
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
    { session, base, audioBase64, realInput },
  );
  return page;
}
test("bound project home reaches the actual recording page, seals a file and returns without restarting the microphone", async ({
  browser,
}) => {
  const page = await openPage(browser, narrator);
  await page.goto(`${base}/#/welcome?projectId=${projectId}`);
  await page
    .getByRole("button", { name: "调整用途与资料服务", exact: true })
    .click();
  const overviewLoaded = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      response.url().endsWith(`/v1/projects/${projectId}/overview`),
  );
  await page
    .getByRole("button", { name: "返回本人参与的项目", exact: true })
    .click();
  const overviewResponse = await overviewLoaded;
  expect(overviewResponse.status()).toBe(200);
  const overviewEnvelope = await overviewResponse.json();
  expect(overviewEnvelope.error).toBeUndefined();
  const overview = overviewEnvelope.data;
  expect(overview.projectId).toBe(projectId);
  expect(overview.bookTitle).toBe("我的时光手记");
  const title = page.locator(".live-project > .title");
  await expect(title).toHaveCount(1);
  await expect(title).toHaveText(overview.bookTitle);
  await expect(page.locator(".filters")).toBeVisible();
  const began = performance.now();
  await page.getByRole("button", { name: "开始一段讲述", exact: true }).click();
  for (const width of [320, 375, 390, 430]) {
    await page.setViewportSize({ width, height: 900 });
    const actions = page.locator(".question-card .question-actions");
    await expect(actions).toBeVisible();
    const start = await actions
      .getByRole("button", { name: "就从这个问题开始", exact: true })
      .boundingBox();
    const change = await actions
      .getByRole("button", { name: "换个问题", exact: true })
      .boundingBox();
    expect(start.height).toBeGreaterThanOrEqual(52);
    expect(change.height).toBeGreaterThanOrEqual(48);
    expect(change.y - start.y - start.height).toBeGreaterThanOrEqual(12);
    expect(
      await page
        .locator("#page")
        .evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);
    await page.screenshot({ path: `/tmp/timenook-ui1-choose-${width}.png` });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await chooseDefaultQuestion(page);
  await expect(
    page.getByRole("button", { name: "开始说", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: "/tmp/timenook-w03-prepare-390.png" });
  await prepareRecordingStep(page);
  await page.getByRole("button", { name: "开始说", exact: true }).click();
  const elapsed = performance.now() - began;
  expect(elapsed).toBeLessThan(60000);
  await expect(
    page.getByRole("button", { name: "说完了，停止录音", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "暂停一下", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "继续说", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: "/tmp/timenook-w03-paused-390.png" });
  await page.getByRole("button", { name: "继续说", exact: true }).click();
  await page
    .getByRole("button", { name: "说完了，停止录音", exact: true })
    .click();
  await expect(
    page
      .locator(".local-recording")
      .getByText("已保存在这台设备，还未上传", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".step-title")).toHaveText(
    "听一听，再留下这段讲述",
  );
  await page.locator("#page").evaluate((node) => {
    node.scrollTop = 0;
  });
  await page.screenshot({ path: "/tmp/timenook-w03-review-390.png" });
  await page.getByRole("button", { name: "回听这段录音", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "停止回听", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "停止回听", exact: true }).click();
  await page.getByRole("button", { name: "重新录这一段", exact: true }).click();
  await page.getByRole("button", { name: "保留这段", exact: true }).click();
  expect(await page.evaluate(() => window.syntheticDevice.starts)).toBe(1);
  await page.getByRole("button", { name: "提交这段讲述", exact: true }).click();
  await expect(
    page.getByText("录音已在测试环境保存；这不代表真实云端存储。", {
      exact: true,
    }),
  ).toBeVisible();
  const context = data(
    await request("GET", `/v1/projects/${projectId}/interviews`, narrator),
    200,
  );
  expect(context.interviews[0].clips).toHaveLength(1);
  expect(context.interviews[0].clips[0].state).toBe("sealed");
  expect(context.interviews[0].clips[0].actualQuestionId).toBe(
    context.interviews[0].currentQuestion.id,
  );
  expect(context.interviews[0].usage.consumedMs).toBe(1080);
  await page.screenshot({ path: "/tmp/timenook-t14-recording-390.png" });
  const sizes = await page
    .locator(".live-interview button:visible")
    .evaluateAll((nodes) =>
      nodes.map((n) => ({
        text: n.textContent,
        font: Number.parseFloat(getComputedStyle(n).fontSize),
        width: n.getBoundingClientRect().width,
        height: n.getBoundingClientRect().height,
      })),
    );
  for (const size of sizes) {
    expect(size.font).toBeGreaterThanOrEqual(16);
    expect(size.height).toBeGreaterThanOrEqual(48);
    expect(size.width).toBeGreaterThanOrEqual(48);
  }
  await page.getByRole("button", { name: "先回到项目", exact: true }).click();
  await page
    .locator(".resume-row")
    .filter({
      hasText: `${context.interviews[0].currentQuestion.snapshot.text}`,
    })
    .click();
  await expect(page.locator(".processing-status")).toContainText(
    "原声已保存，等待转写",
  );
  await expect(
    page.getByRole("button", { name: "整理成故事", exact: true }),
  ).toHaveCount(0);
  expect(await page.evaluate(() => window.syntheticDevice.starts)).toBe(1);
  await page.setViewportSize({ width: 768, height: 1000 });
  await page.screenshot({ path: "/tmp/timenook-t14-recording-768.png" });
  expect(
    await page
      .locator("#phone")
      .evaluate((n) => n.getBoundingClientRect().width),
  ).toBe(390);
  test.info().annotations.push({
    type: "engineering-path-ms",
    description: String(Math.round(elapsed)),
  });
  expect(errors).toEqual([]);
  await page.context().close();
});

test("actual Page and HTTP retain an older answer source after another question is displayed in the same interview", async ({
  browser,
}) => {
  const started = data(
    await request("POST", `/v1/projects/${projectId}/interviews`, narrator, {
      clientInterviewId: randomUUID(),
      expectedPlanRevision: 1,
      selfWritten: {
        text: "您想说说家门前的小路吗？",
        intent: "本人选择的起点",
      },
    }),
  );
  const page = await openPage(browser, narrator);
  await page.goto(
    `${base}/#/interview?projectId=${projectId}&interviewId=${started.id}`,
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
  const laterText = "那条路上还有什么让您记得清楚？";
  const displayed = data(
    await request(
      "POST",
      `/v1/projects/${projectId}/interviews/${started.id}/actual-question`,
      narrator,
      {
        clientQuestionId: randomUUID(),
        expectedVersion: 1,
        expectedActualQuestionId: started.actualQuestion.id,
        expectedPlanRevision: 1,
        selfWritten: { text: laterText, intent: "本人改写的补充问题" },
      },
    ),
  );
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await expect(page.getByText(laterText, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "提交这段讲述", exact: true }).click();
  await expect(page.locator(".processing-status")).toContainText(
    "原声已保存，等待转写",
  );
  await expect(
    page.getByRole("button", { name: "整理成故事", exact: true }),
  ).toHaveCount(0);
  await prepareRecordingStep(page);
  await page.getByRole("button", { name: "开始说", exact: true }).click();
  await page
    .getByRole("button", { name: "说完了，停止录音", exact: true })
    .click();
  await page.getByRole("button", { name: "提交这段讲述", exact: true }).click();
  await expect(page.locator(".processing-status")).toContainText(
    "原声已保存，等待转写",
  );
  await expect(
    page.getByRole("button", { name: "整理成故事", exact: true }),
  ).toHaveCount(0);
  const restored = data(
    await request(
      "GET",
      `/v1/projects/${projectId}/interviews/${started.id}`,
      narrator,
    ),
    200,
  );
  expect(restored.actualQuestion.id).toBe(started.actualQuestion.id);
  expect(restored.currentQuestion.id).toBe(displayed.currentQuestion.id);
  expect(restored.clips.map((clip) => clip.actualQuestionId).sort()).toEqual(
    [started.actualQuestion.id, displayed.currentQuestion.id].sort(),
  );
  expect(await page.evaluate(() => window.syntheticDevice.starts)).toBe(2);
  await page.screenshot({
    path: test.info().outputPath("actual-questions-390.png"),
  });
  expect(errors).toEqual([]);
  await page.context().close();
});

test("a collection-only assisted participant starts and resumes its own pending file through real page and HTTP", async ({
  browser,
}) => {
  const { paid } = apiRequire("./dist-test/test/payment-fixture.js");
  const order = data(
    await request("POST", "/v1/orders", buyer, {
      packageVersionId: versionId,
      recipient: { relationshipLabel: "朋友" },
      shippingRegionCode: "CN-110000",
    }),
  );
  data(await request("POST", `/v1/orders/${order.id}/payment`, buyer, {}));
  paid(order.outTradeNo);
  const id = data(await request("GET", `/v1/orders/${order.id}`, buyer), 200)
    .project.id;
  const state = data(
    await request("GET", `/v1/projects/${id}/participation`, buyer),
    200,
  );
  data(
    await request("POST", `/v1/projects/${id}/assisted-sessions`, buyer, {
      purpose: "collection",
      granted: true,
      noticeVersion: "synthetic-d08-v1",
      evidenceRef: "synthetic:browser当次采集",
      expectedBindingVersion: 0,
      expectedAccessEpoch: state.accessEpoch,
    }),
  );
  const page = await openPage(browser, buyer);
  await page.goto(`${base}/#/welcome?projectId=${id}`);
  await page
    .getByRole("button", { name: "本人在场，协助开始", exact: true })
    .click();
  const choices = page.getByRole("checkbox");
  await expect(choices).toHaveCount(3);
  await choices.nth(0).check();
  await choices.nth(1).uncheck();
  await choices.nth(2).uncheck();
  const submittedChoices = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/assisted-sessions")) {
      const { purpose, granted } = r.postDataJSON();
      submittedChoices.push({ purpose, granted });
    }
  });
  await page
    .getByRole("button", { name: "同意所选并开始讲述", exact: true })
    .click();
  await chooseDefaultQuestion(page);
  expect(submittedChoices).toEqual([
    { purpose: "collection", granted: true },
    { purpose: "ai", granted: false },
    { purpose: "sharing", granted: false },
  ]);
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
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await expect(
    page
      .locator(".local-recording")
      .getByText("已保存在这台设备，还未上传", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "提交这段讲述", exact: true }).click();
  await expect(page.locator(".processing-status")).toContainText(
    "原声已保存，等待转写",
  );
  await expect(page.locator(".processing-status")).toContainText(
    "测试环境保存",
  );
  await expect(
    page.getByRole("button", { name: "整理成故事", exact: true }),
  ).toHaveCount(0);
  const assisted = data(
    await request("GET", `/v1/projects/${id}/participation`, buyer),
    200,
  );
  expect(assisted.choices.find((row) => row.purpose === "ai").granted).not.toBe(
    true,
  );
  expect(
    (await request("GET", `/v1/projects/${id}/interviews`, buyer)).statusCode,
  ).toBe(403);
  expect(await page.evaluate(() => window.syntheticDevice.starts)).toBe(1);
  expect(errors).toEqual([]);
  await page.context().close();
});

test("actual browser MP3 pauses, survives reload in IndexedDB and seals the identical original through HTTP", async ({
  browser,
}) => {
  const interview = data(
    await request("POST", `/v1/projects/${projectId}/interviews`, narrator, {
      clientInterviewId: randomUUID(),
      expectedPlanRevision: 1,
      selfWritten: {
        text: "您记得哪一段夏天的声音？",
        intent: "合成音源工程验收",
      },
    }),
  );
  const page = await openPage(browser, narrator, undefined, true);
  const url = `${base}/#/interview?projectId=${projectId}&interviewId=${interview.id}`;
  await page.goto(url);
  await prepareRecordingStep(page);
  await page.getByRole("button", { name: "开始说", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "暂停一下", exact: true }),
  ).toBeVisible();
  await page.waitForTimeout(450);
  await page.getByRole("button", { name: "暂停一下", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "继续说", exact: true }),
  ).toBeVisible();
  await page.waitForTimeout(1100);
  await page.getByRole("button", { name: "继续说", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "暂停一下", exact: true }),
  ).toBeVisible();
  await page.waitForTimeout(450);
  await page
    .getByRole("button", { name: "说完了，停止录音", exact: true })
    .click();
  await expect(
    page
      .locator(".local-recording")
      .getByText("已保存在这台设备，还未上传", { exact: true }),
  ).toBeVisible();
  const local = await page.evaluate(async () => {
    const { resolveBlob } = await import("/preview/media.ts");
    const clips = Object.keys(localStorage)
      .filter((key) => key.includes("timenook.recording.v1:"))
      .flatMap((key) => JSON.parse(localStorage.getItem(key)));
    const clip = clips.at(-1),
      url = await resolveBlob(clip.path),
      response = await fetch(url);
    const bytes = Array.from(new Uint8Array(await response.arrayBuffer()));
    URL.revokeObjectURL(url);
    return {
      clip,
      bytes,
      mime: response.headers.get("content-type"),
      sourceRate: window.syntheticMicrophone.source.sampleRate,
      tracks: window.syntheticMicrophone.output.stream
        .getTracks()
        .map((track) => track.readyState),
    };
  });
  expect(local.mime).toBe("audio/mpeg");
  expect(local.sourceRate).toBe(48000);
  expect(local.tracks).toEqual(["ended"]);
  expect(local.clip.durationMs).toBeGreaterThan(800);
  expect(local.clip.durationMs).toBeLessThan(1800); // 1100ms pause must not become encoded silence
  const original = Buffer.from(local.bytes),
    digest = createHash("sha256").update(original).digest("hex");
  expect(local.clip.sha256).toBe(digest);
  expect(local.clip.bytes).toBe(original.length);
  const file = join(root, "actual-browser-original.mp3");
  await writeFile(file, original);
  const decoded = spawnSync(process.env.FFMPEG_PATH ?? "ffmpeg", [
    "-nostdin",
    "-v",
    "error",
    "-xerror",
    "-i",
    file,
    "-ac",
    "1",
    "-ar",
    "16000",
    "-f",
    "s16le",
    "pipe:1",
  ]);
  expect(decoded.status, decoded.stderr.toString()).toBe(0);
  expect(decoded.stdout.length / 32).toBe(local.clip.durationMs);
  await page.reload();
  await expect(page.locator(".local-recording")).toBeVisible();
  await page.getByRole("button", { name: "提交这段讲述", exact: true }).click();
  await expect(
    page.getByText("录音已在测试环境保存；这不代表真实云端存储。", {
      exact: true,
    }),
  ).toBeVisible();
  const restored = data(
    await request(
      "GET",
      `/v1/projects/${projectId}/interviews/${interview.id}`,
      narrator,
    ),
    200,
  );
  const sealed = data(
    await request(
      "GET",
      `/v1/projects/${projectId}/interviews/${interview.id}/clips/${restored.clips[0].id}`,
      narrator,
    ),
    200,
  );
  expect(sealed.sha256).toBe(digest);
  expect(sealed.asset.mime).toBe("audio/mpeg");
  expect(sealed.durationMs).toBe(local.clip.durationMs);
  const content = await request(
    "GET",
    `/v1/projects/${projectId}/interviews/${interview.id}/clips/${sealed.id}/content`,
    narrator,
  );
  expect(content.statusCode).toBe(200);
  expect(content.rawPayload).toEqual(original);
  expect(content.headers["content-type"]).toBe("audio/mpeg");
  await page.context().close();
});
