import { showSavedRecording } from "./recording-step-helper.mjs";
import { storyAction } from "./recording-step-helper.mjs";
import { prepareRecordingStep } from "./recording-step-helper.mjs";
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
const schema = `t19_browser_${randomUUID().replaceAll("-", "")}`;
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
const base = "http://127.0.0.1:5182";
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
        origin: "https://localhost:5182",
        sessionKey: randomBytes(32).toString("base64"),
        sessionTtlSeconds: 28800,
        challengeTtlSeconds: 300,
      },
      generation: {
        mode: "synthetic-local",
        configVersion: "synthetic-t19-browser",
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
      port: 3430,
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
                      source.currentQuestion
                        ? {
                            action: "ask",
                            question:
                              "您还记得家门口那棵树旁的一个具体场景吗？",
                            intent: "scene",
                            sourceRefs: source.sourceRefs,
                            reasonCode: "SCENE_AVAILABLE",
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
  await api.listen(3430, "127.0.0.1");
  preview = spawn(
    process.execPath,
    [
      "node_modules/vite/bin/vite.js",
      "--host",
      "127.0.0.1",
      "--port",
      "5182",
      "--strictPort",
    ],
    {
      cwd: resolve("."),
      env: {
        ...process.env,
        TIMENOOK_API_BASE_URL: `${base}/api/v1`,
        TIMENOOK_PREVIEW_API_TARGET: "http://127.0.0.1:3430",
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
      "/tmp/timenook-t19-browser-debug.txt",
      await latestPage.locator("body").innerText(),
    );
    await latestPage.screenshot({
      path: "/tmp/timenook-t19-browser-failure.png",
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

async function adjustStoryDecision(page, label) {
  await storyAction(page, "回听已保存的原声");
  await page.getByRole("button", { name: "调整本版决定", exact: true }).click();
  const saved = page.waitForResponse((response) =>
    response.url().endsWith("/decisions"),
  );
  await page.getByRole("button", { name: label, exact: true }).click();
  expect((await saved).status()).toBe(201);
}

test("real project, full-story correction and independent narrator decisions persist through HTTP and PostgreSQL", async ({
  browser,
}) => {
  const interview = await savedInterview();
  const Tasks = apiRequire("./dist-test/src/tasks/tasks.js").ProductionTasks;
  const tasks = data(
    await request("GET", `/v1/projects/${projectId}/tasks`, narrator),
    200,
  );
  for (const task of tasks) {
    await api.get(Tasks).run(task.id);
    await api.get(Tasks).run(task.id);
  }
  const started = data(
    await request(
      "POST",
      `/v1/projects/${projectId}/stories/organize`,
      narrator,
      { interviewId: interview.id, baseVersion: 0 },
    ),
    202,
  );
  await expect
    .poll(
      async () => {
        await runtime.recoverDue();
        return data(
          await request(
            "GET",
            `/v1/projects/${projectId}/stories/${started.id}`,
            narrator,
          ),
          200,
        ).version;
      },
      { timeout: 15000 },
    )
    .toBe(1);
  const page = await openPage(browser, narrator);
  try {
    await page.goto(`${base}/#/project?projectId=${projectId}`);
    await expect(
      page.getByRole("button", { name: /待本人确认 1/ }),
    ).toBeVisible();
    await page
      .getByRole("button")
      .filter({ hasText: "那些年我记得的事" })
      .click();
    await expect(
      page.getByText("这就是这段讲述的最后一段，所有文字都保留了。", {
        exact: true,
      }),
    ).toBeVisible();
    expect(
      Math.round(
        await page
          .locator("#phone")
          .evaluate((node) => node.getBoundingClientRect().width),
      ),
    ).toBe(390);
    const bodyFonts = await page
      .locator(".live-story .paragraph")
      .evaluateAll((nodes) =>
        nodes.map((node) => Number.parseFloat(getComputedStyle(node).fontSize)),
      );
    expect(bodyFonts.length).toBe(3);
    expect(bodyFonts.every((size) => size >= 20)).toBe(true);
    const actions = await page
      .locator(".live-story .btn:visible")
      .evaluateAll((nodes) =>
        nodes.map((node) => ({
          width: node.getBoundingClientRect().width,
          height: node.getBoundingClientRect().height,
        })),
      );
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every((size) => size.width >= 48 && size.height >= 48)).toBe(
      true,
    );
    await storyAction(page, "修改故事文字");
    await expect(page.getByText("校对故事", { exact: true })).toBeVisible();
    const paragraphs = page.locator("textarea");
    await paragraphs.nth(0).fill("本人校对后的首段，保留原有来源。");
    await page
      .getByPlaceholder("逐项填写处理理由；未处理的核对项会阻止本人确认")
      .nth(0)
      .fill("本人只记得大约年份，保留模糊表述");
    await page
      .getByPlaceholder("逐项填写处理理由；未处理的核对项会阻止本人确认")
      .nth(1)
      .fill("本人无法确认品种，保留未知");
    await page
      .getByRole("button", { name: "保存为新版本", exact: true })
      .click();
    await expect(
      page.getByText("本人校对后的首段，保留原有来源。", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "确认", exact: true }).click();
    await expect(
      page.locator(".live-decision textarea, .live-decision checkbox"),
    ).toHaveCount(0);
    await adjustStoryDecision(page, "这版暂不入书");
    await expect
      .poll(
        async () =>
          data(
            await request(
              "GET",
              `/v1/projects/${projectId}/stories/${started.id}`,
              narrator,
            ),
            200,
          ).decision?.confirmed,
      )
      .toBe(true);
    const current = data(
      await request(
        "GET",
        `/v1/projects/${projectId}/stories/${started.id}`,
        narrator,
      ),
      200,
    );
    expect(current.version).toBe(2);
    expect(current.decision.allowInBook).toBe(false);
    await page.goto(`${base}/#/project?projectId=${projectId}`);
    await expect(page.getByText("1 篇已确认", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "修改书名", exact: true }).click();
    await page.locator("input").fill("本人的新书名");
    const renaming = page.waitForResponse((r) =>
      r.url().endsWith(`/projects/${projectId}/metadata`),
    );
    await page.getByRole("button", { name: "保存书名", exact: true }).click();
    const renameResponse = await renaming;
    expect(renameResponse.status()).toBe(201);
    expect((await renameResponse.json()).data.bookTitle).toBe("本人的新书名");
    await expect(
      page.locator(".title").filter({ hasText: "本人的新书名" }),
    ).toBeVisible();
    await expect(page.locator(".tab-label").first()).toHaveText("本人的新书名");
    await page.screenshot({ path: "/tmp/timenook-t19-project-390.png" });
    expect(errors).toEqual([]);
  } catch (error) {
    await writeFile(
      "/tmp/timenook-t19-browser-debug.txt",
      (await page
        .locator("body")
        .innerText()
        .catch(() => "closed")) +
        "\nERRORS\n" +
        JSON.stringify(errors),
    );
    throw error;
  } finally {
    await page
      .context()
      .close()
      .catch(() => {});
  }
});
async function unboundStory() {
  const operator = await login(`synthetic-assisted-${randomUUID()}`);
  const order = data(
    await request("POST", "/v1/orders", operator, {
      packageVersionId: versionId,
      recipient: { relationshipLabel: "朋友" },
      shippingRegionCode: "CN-110000",
    }),
  );
  data(await request("POST", `/v1/orders/${order.id}/payment`, operator, {}));
  apiRequire("./dist-test/test/payment-fixture.js").paid(order.outTradeNo);
  const pid = data(
    await request("GET", `/v1/orders/${order.id}`, operator),
    200,
  ).project.id;
  let collection;
  for (const purpose of ["collection", "ai", "sharing"]) {
    const s = data(
      await request("GET", `/v1/projects/${pid}/participation`, operator),
      200,
    );
    const granted = data(
      await request("POST", `/v1/projects/${pid}/assisted-sessions`, operator, {
        purpose,
        granted: true,
        noticeVersion: "synthetic-d08-v1",
        evidenceRef: `synthetic:无微信本人当次用途-${randomUUID()}`,
        expectedBindingVersion: s.bindingVersion,
        expectedAccessEpoch: s.accessEpoch,
      }),
    );
    if (purpose === "collection") collection = granted;
  }
  const interview = data(
    await request("POST", `/v1/projects/${pid}/interviews`, operator, {
      clientInterviewId: randomUUID(),
      expectedPlanRevision: 1,
      starterKind: "free-narration",
      assistedSessionId: collection.id,
    }),
  );
  const audio = Buffer.from(audioBase64, "base64"),
    { createHash } = await import("node:crypto");
  for (let n = 0; n < 2; n++) {
    const basePath = `/v1/projects/${pid}/interviews/${interview.id}/clips`,
      body = { assistedSessionId: collection.id };
    const clip = data(
      await request("POST", basePath, operator, {
        ...body,
        clientClipId: randomUUID(),
        bytes: audio.length,
        sha256: createHash("sha256").update(audio).digest("hex"),
      }),
    );
    const form = data(
        await request("POST", `${basePath}/${clip.id}/upload`, operator, body),
      ),
      boundary = `story-${randomUUID()}`;
    const parts = Object.entries(form.fields).map(([key, value]) =>
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`,
      ),
    );
    const uploaded = await api.inject({
      method: "POST",
      url: form.url,
      headers: {
        authorization: `Bearer ${operator.session.token}`,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload: Buffer.concat([
        ...parts,
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="synthetic.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`,
        ),
        audio,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    });
    expect(uploaded.statusCode).toBe(204);
    data(await request("POST", `${basePath}/${clip.id}/seal`, operator, body));
  }
  const started = data(
    await request("POST", `/v1/projects/${pid}/stories/organize`, operator, {
      interviewId: interview.id,
      baseVersion: 0,
      assistedSessionId: collection.id,
    }),
    202,
  );
  await expect
    .poll(
      async () => {
        await runtime.recoverDue();
        return data(
          await request(
            "GET",
            `/v1/projects/${pid}/stories/${started.id}`,
            operator,
          ),
          200,
        ).version;
      },
      { timeout: 20000 },
    )
    .toBe(1);
  const story = data(
    await request("GET", `/v1/projects/${pid}/stories/${started.id}`, operator),
    200,
  );
  const corrected = data(
    await request(
      "POST",
      `/v1/projects/${pid}/stories/${story.id}/revisions`,
      operator,
      {
        baseRevisionId: story.revision.id,
        expectedVersion: story.version,
        title: story.revision.title,
        theme: story.revision.theme,
        paragraphs: story.revision.paragraphs,
        notes: [],
        reviewResolutions: story.revision.reviewItems.map((item) => ({
          item,
          reason: "本人要求保留大约年代与未知细节",
        })),
      },
    ),
  );
  return { operator, projectId: pid, interview, story: corrected, collection };
}
test("the actual no-WeChat narrator grants story-purpose assistance then confirms the exact story and separately permits book use", async ({
  browser,
}) => {
  const p = await unboundStory(),
    page = await openPage(browser, p.operator),
    collectionRequests = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/stories/context")) collectionRequests.push(r.url());
  });
  try {
    const participation = data(
      await request(
        "GET",
        `/v1/projects/${p.projectId}/participation`,
        p.operator,
      ),
      200,
    );
    expect(participation.bindingVersion).toBe(0);
    await page.evaluate((url) => {
      location.hash = url;
    }, `#/assisted?projectId=${p.projectId}&storyId=${p.story.id}&interviewId=${p.interview.id}&purpose=story_confirmation`);
    await page
      .getByPlaceholder("记录本人本次选择同机协助核对的说明")
      .fill("本地合成本人在场，愿意由发起人协助核对此故事");
    await page
      .getByRole("button", {
        name: "本人同意当次故事确认协助，返回故事",
        exact: true,
      })
      .click();
    await expect(page).toHaveURL(
      new RegExp(`/story\\?projectId=${p.projectId}&storyId=${p.story.id}`),
    );
    await expect(
      page.getByText("这就是这段讲述的最后一段，所有文字都保留了。", {
        exact: true,
      }),
    ).toBeVisible();
    await page.getByRole("button", { name: "确认", exact: true }).click();
    await expect(
      page.locator(".live-decision textarea, .live-decision checkbox"),
    ).toHaveCount(0);
    await adjustStoryDecision(page, "这版暂不入书");
    await expect
      .poll(
        async () =>
          data(
            await request(
              "GET",
              `/v1/projects/${p.projectId}/stories/${p.story.id}`,
              p.operator,
            ),
            200,
          ).decision?.confirmed,
      )
      .toBe(true);
    let current = data(
      await request(
        "GET",
        `/v1/projects/${p.projectId}/stories/${p.story.id}`,
        p.operator,
      ),
      200,
    );
    expect(current.decision.allowInBook).toBe(false);
    expect(current.decision.operatorUserId).toBe(p.operator.user.id);
    expect(current.decision.method).toBe("assisted");
    await adjustStoryDecision(page, "重新确认并允许这版入书");
    await expect
      .poll(
        async () =>
          data(
            await request(
              "GET",
              `/v1/projects/${p.projectId}/stories/${p.story.id}`,
              p.operator,
            ),
            200,
          ).decision?.allowInBook,
      )
      .toBe(true);
    expect(collectionRequests).toEqual([]);
    expect(errors).toEqual([]);
    await page.screenshot({ path: "/tmp/timenook-t19-assisted-story-390.png" });
  } catch (error) {
    await writeFile(
      "/tmp/timenook-t19-assisted-debug.txt",
      await page
        .locator("body")
        .innerText()
        .catch(() => "closed"),
    );
    throw error;
  } finally {
    await page
      .context()
      .close()
      .catch(() => {});
  }
});
test("real project resume keeps the same interview's saved native-file timing and an HTTP failure stays recoverable", async ({
  browser,
}) => {
  const interview = await savedInterview(),
    page = await openPage(browser, narrator);
  try {
    await page.evaluate(() => {
      window.syntheticTime = Date.now();
      Date.now = () => window.syntheticTime;
    });
    await page.evaluate((url) => {
      location.hash = url;
    }, `#/project?projectId=${projectId}`);
    await page.locator(".resume-row").first().click();
    await expect(page).toHaveURL(new RegExp(`interviewId=${interview.id}`));
    await prepareRecordingStep(page);
    await page.getByRole("button", { name: "开始说", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "说完了，停止录音", exact: true }),
    ).toBeVisible();
    await page.evaluate(() => {
      window.syntheticTime += 3000;
    });
    await expect(page.locator(".record-timer, .review-duration")).toHaveText(
      "00:03",
    );
    await page
      .getByRole("button", { name: "说完了，停止录音", exact: true })
      .click();
    await expect(
      page
        .locator(".local-recording")
        .getByText("已保存在这台设备，还未上传", { exact: true }),
    ).toBeVisible();
    await expect(page.locator(".record-timer, .review-duration")).toHaveText(
      "00:01",
    );
    await page.evaluate((url) => {
      location.hash = url;
    }, `#/project?projectId=${projectId}`);
    await page.evaluate(() => {
      window.syntheticTime += 60000;
    });
    await page.locator(".resume-row").first().click();
    await expect(page).toHaveURL(new RegExp(`interviewId=${interview.id}`));
    await showSavedRecording(page);
    await expect(page.locator(".record-timer, .review-duration")).toHaveText(
      "00:01",
    );
    expect(await page.evaluate(() => window.syntheticDevice.starts)).toBe(1);
    await prepareRecordingStep(page);
    await page.getByRole("button", { name: "开始说", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "说完了，停止录音", exact: true }),
    ).toBeVisible();
    await page.evaluate(() => {
      window.syntheticTime += 3000;
    });
    await expect(page.locator(".record-timer, .review-duration")).toHaveText(
      "00:04",
    );
    await page
      .getByRole("button", { name: "说完了，停止录音", exact: true })
      .click();
    await expect(page.locator(".record-timer, .review-duration")).toHaveText(
      "00:01",
    );
    let once = true;
    await page.route(`**/projects/${projectId}/overview`, async (route) => {
      if (once) {
        once = false;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            error: {
              code: "SERVICE_UNAVAILABLE",
              message: "synthetic unavailable",
              retryable: true,
            },
            meta: { requestId: "synthetic" },
          }),
        });
      } else await route.continue();
    });
    await page.evaluate((url) => {
      location.hash = url;
    }, `#/project?projectId=${projectId}`);
    await expect(
      page.getByText("服务暂不可用，请稍后重试", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "重新查询项目", exact: true }),
    ).toBeEnabled();
    await page
      .getByRole("button", { name: "重新查询项目", exact: true })
      .click();
    await expect(page.locator(".resume-row").first()).toBeVisible();
    await page.locator(".resume-row").first().click();
    await expect(page.locator(".record-timer, .review-duration")).toHaveText(
      "00:01",
    );
    expect(await page.evaluate(() => window.syntheticDevice.starts)).toBe(2);
    expect(errors).toEqual([]);
    await page.screenshot({
      path: "/tmp/timenook-t19-recording-resume-390.png",
    });
  } catch (error) {
    await writeFile(
      "/tmp/timenook-t19-recording-debug.txt",
      (await page
        .locator("body")
        .innerText()
        .catch(() => "closed")) +
        "\n" +
        JSON.stringify(errors),
    );
    throw error;
  } finally {
    await page
      .context()
      .close()
      .catch(() => {});
  }
});
test("a collection-only assisted project home starts real recording without exposing its saved private story or history", async ({
  browser,
}) => {
  const p = await unboundStory();
  const update = async (purpose, granted) => {
    const state = data(
        await request(
          "GET",
          `/v1/projects/${p.projectId}/participation`,
          p.operator,
        ),
        200,
      ),
      sessions = data(
        await request(
          "GET",
          `/v1/projects/${p.projectId}/assisted-sessions`,
          p.operator,
        ),
        200,
      ).sessions,
      prior = sessions.find((s) => s.purpose === purpose);
    return data(
      await request(
        "POST",
        `/v1/projects/${p.projectId}/assisted-sessions`,
        p.operator,
        {
          purpose,
          granted,
          expectedBindingVersion: state.bindingVersion,
          expectedAccessEpoch: state.accessEpoch,
          ...(prior ? { expectedSessionId: prior.id } : {}),
          noticeVersion: "synthetic-d08-v1",
          evidenceRef: `synthetic:同机用途-${randomUUID()}`,
        },
      ),
    );
  };
  await update("sharing", false);
  await update("collection", true);
  expect(
    (await request("GET", `/v1/projects/${p.projectId}/overview`, p.operator))
      .statusCode,
  ).toBe(403);
  const page = await openPage(browser, p.operator);
  try {
    await page.evaluate((url) => {
      location.hash = url;
    }, `#/project?projectId=${p.projectId}`);
    await expect(page.getByText(/尚未取得共享查看授权/)).toBeVisible();
    await expect(
      page.getByText(p.story.revision.title, { exact: true }),
    ).toHaveCount(0);
    await expect(page.locator(".resume-row")).toHaveCount(0);
    await page
      .getByRole("button", { name: "本人在场，进入同机协助", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "同意所选并开始讲述", exact: true }),
    ).toBeVisible();
    const contextResponse = page.waitForResponse((r) =>
      r.url().endsWith(`/projects/${p.projectId}/interviews/context`),
    );
    await page
      .getByRole("button", { name: "同意所选并开始讲述", exact: true })
      .click();
    const safe = await (await contextResponse).json();
    expect(safe.data.interviews).toEqual([]);
    expect(JSON.stringify(safe)).not.toContain(p.story.revision.title);
    await page.getByRole("button", { name: "换个问题", exact: true }).click();
    await page.getByRole("button", { name: "自由讲述", exact: true }).click();
    await prepareRecordingStep(page);
    await page.getByRole("button", { name: "开始说", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "说完了，停止录音", exact: true }),
    ).toBeVisible();
    expect(await page.evaluate(() => window.syntheticDevice.starts)).toBe(1);
    await page
      .getByRole("button", { name: "说完了，停止录音", exact: true })
      .click();
    await expect(
      page
        .locator(".local-recording")
        .getByText("已保存在这台设备，还未上传", { exact: true }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  } catch (error) {
    await writeFile(
      "/tmp/timenook-t19-collection-debug.txt",
      (await page
        .locator("body")
        .innerText()
        .catch(() => "closed")) +
        "\n" +
        JSON.stringify(errors),
    );
    throw error;
  } finally {
    await page
      .context()
      .close()
      .catch(() => {});
  }
});

test("a real revoked Story download clears the active Assisted page including its actual correction case", async ({
  browser,
}) => {
  const p = await unboundStory(),
    state = data(
      await request(
        "GET",
        `/v1/projects/${p.projectId}/participation`,
        p.operator,
      ),
      200,
    ),
    session = data(
      await request(
        "POST",
        `/v1/projects/${p.projectId}/assisted-sessions`,
        p.operator,
        {
          purpose: "story_confirmation",
          granted: true,
          expectedBindingVersion: state.bindingVersion,
          expectedAccessEpoch: state.accessEpoch,
          noticeVersion: "synthetic-d08-v1",
          evidenceRef: `synthetic:本次故事协助-${randomUUID()}`,
        },
      ),
    ),
    grant = data(
      await request(
        "POST",
        `/v1/projects/${p.projectId}/stories/${p.story.id}/care-access`,
        p.operator,
        {
          revisionId: p.story.revision.id,
          contentHash: p.story.revision.contentHash,
          expectedVersion: p.story.version,
          assistedSessionId: session.id,
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          noticeVersion: "synthetic-d08-v1",
          evidenceRef: `synthetic:仅同意本次有限客服校对-${randomUUID()}`,
        },
      ),
    ),
    page = await openPage(browser, p.operator);
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let captured;
  const downloading = new Promise((resolve) => {
    captured = resolve;
  });
  await page.route(/\/clips\/[a-f0-9-]{36}\/content$/, async (route) => {
    captured();
    await held;
    await route.continue();
  });
  try {
    await page.evaluate((url) => {
      location.hash = url;
    }, `#/story?projectId=${p.projectId}&storyId=${p.story.id}`);
    await storyAction(page, "回听已保存的原声");
    await page
      .getByRole("button", { name: "回听第 1 段原声", exact: true })
      .click();
    await downloading;
    await page
      .getByRole("button", {
        name: "本人在场，申请当次故事确认协助",
        exact: true,
      })
      .click();
    await page
      .getByRole("button", { name: "其他操作与本人权利", exact: true })
      .click();
    await expect(
      page.getByText(`工单 record:${grant.caseId}`, { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("故事限时校对：待客服核验", { exact: true }),
    ).toBeVisible();
    await page
      .getByPlaceholder("记录本人本次选择同机协助核对的说明")
      .fill("会话仍有效时输入的私人说明");
    const response = page.waitForResponse((r) =>
      /\/clips\/[a-f0-9-]{36}\/content$/.test(r.url()),
    );
    expect(
      (
        await api.inject({
          method: "DELETE",
          url: `/v1/sessions/${p.operator.session.id}`,
          headers: { authorization: `Bearer ${p.operator.session.token}` },
        })
      ).statusCode,
    ).toBe(204);
    release();
    expect((await response).status()).toBe(401);
    await expect(
      page.getByText("登录已失效，请重新登录", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByPlaceholder("记录本人本次选择同机协助核对的说明"),
    ).toHaveCount(0);
    await expect(
      page.getByText(`工单 record:${grant.caseId}`, { exact: true }),
    ).toHaveCount(0);
    await expect(page.getByText(/当次有效期至/)).toHaveCount(0);
    expect(
      await page.evaluate(
        (key) => localStorage.getItem(key),
        `timenook.session.v1:${base}/api/v1`,
      ),
    ).toBeNull();
    await expect
      .poll(() => page.evaluate(() => window.syntheticPlayback.removed.length))
      .toBeGreaterThan(0);
    expect(await page.evaluate(() => window.syntheticPlayback.plays)).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    release();
    await page
      .context()
      .close()
      .catch(() => {});
  }
});

test("project progress keeps optional follow-up distinct while the same interview resumes local timing against its displayed question", async ({
  browser,
}) => {
  const p = await unboundStory(),
    page = await openPage(browser, p.operator),
    path = `/v1/projects/${p.projectId}/interviews/${p.interview.id}`;
  try {
    await page.evaluate(() => {
      window.syntheticTime = Date.now();
      Date.now = () => window.syntheticTime;
    });
    await page.evaluate((url) => {
      location.hash = url;
    }, `#/project?projectId=${p.projectId}&assistedSessionId=${p.collection.id}`);
    await page.locator(".resume-row").first().click();
    await expect(page).toHaveURL(new RegExp(`interviewId=${p.interview.id}`));
    await prepareRecordingStep(page);
    await page.getByRole("button", { name: "开始说", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "说完了，停止录音", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "说完了，停止录音", exact: true })
      .click();
    await expect(page.locator(".record-timer, .review-duration")).toHaveText(
      "00:01",
    );
    await page
      .getByRole("button", { name: "提交这段讲述", exact: true })
      .click();
    await expect(page.locator(".processing-step")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "再聊一个问题", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "整理成故事", exact: true }),
    ).toHaveCount(0);
    await expect
      .poll(
        async () => {
          await runtime.recoverDue();
          const tasks = data(
            await request(
              "POST",
              `/v1/projects/${p.projectId}/tasks/status`,
              p.operator,
              {
                interviewId: p.interview.id,
                assistedSessionId: p.collection.id,
              },
            ),
          );
          return (
            tasks.length === 3 &&
            tasks.every((task) => task.state === "succeeded")
          );
        },
        { timeout: 20000 },
      )
      .toBe(true);
    await page
      .getByRole("button", { name: "重新查询转写状态", exact: true })
      .click();
    await expect(page.getByText("文字已转写", { exact: true })).toBeVisible();
    const followupResponse = page.waitForResponse((r) =>
      r.url().endsWith(`${path.slice(3)}/follow-up`),
    );
    await page
      .getByRole("button", { name: "再聊一个问题", exact: true })
      .click();
    expect((await followupResponse).status()).toBe(202);
    await expect
      .poll(
        async () => {
          await runtime.recoverDue();
          return data(
            await request("POST", `${path}/follow-up/status`, p.operator, {
              assistedSessionId: p.collection.id,
            }),
          ).task?.state;
        },
        { timeout: 20000 },
      )
      .toBe("succeeded");
    // Follow-up status advances automatically; wait for the actual question below.
    await expect(page.locator(".interview-question")).toHaveText(
      "您还记得家门口那棵树旁的一个具体场景吗？",
      { timeout: 20000 },
    );
    const displayed = data(
      await request("POST", `${path}/resume`, p.operator, {
        assistedSessionId: p.collection.id,
      }),
    );
    expect(displayed.questionVersion).toBe(2);
    expect(displayed.currentQuestion.id).not.toBe(displayed.actualQuestion.id);
    await page.evaluate((url) => {
      location.hash = url;
    }, `#/project?projectId=${p.projectId}&assistedSessionId=${p.collection.id}`);
    await page.getByRole("button", { name: /保存与处理详情/ }).click();
    await expect(
      page.locator(".live-task").filter({ hasText: "可选追问" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /待本人确认 1/ }),
    ).toBeVisible();
    await expect(page.getByText("0 篇已确认", { exact: true })).toBeVisible();
    await page.evaluate(() => {
      window.syntheticTime += 60000;
    });
    await page
      .locator(".resume-row")
      .filter({ hasText: `${displayed.currentQuestion.snapshot.text}` })
      .click();
    await showSavedRecording(page);
    await expect(page.locator(".record-timer, .review-duration")).toHaveText(
      "00:01",
    );
    expect(await page.evaluate(() => window.syntheticDevice.starts)).toBe(1);
    const startResponse = page.waitForResponse((r) =>
      r.url().endsWith(`${path.slice(3)}/recording-start`),
    );
    await prepareRecordingStep(page);
    await page.getByRole("button", { name: "开始说", exact: true }).click();
    const authorized = await startResponse;
    expect(authorized.status()).toBe(201);
    expect(authorized.request().postDataJSON().actualQuestionId).toBe(
      displayed.currentQuestion.id,
    );
    expect(authorized.request().postDataJSON().expectedQuestionVersion).toBe(2);
    expect((await authorized.json()).data.actualQuestionId).toBe(
      displayed.currentQuestion.id,
    );
    await expect(
      page.getByRole("button", { name: "说完了，停止录音", exact: true }),
    ).toBeVisible();
    await page.evaluate(() => {
      window.syntheticTime += 3000;
    });
    await expect(page.locator(".record-timer, .review-duration")).toHaveText(
      "00:04",
    );
    await page
      .getByRole("button", { name: "说完了，停止录音", exact: true })
      .click();
    await expect(page.locator(".record-timer, .review-duration")).toHaveText(
      "00:01",
    );
    await expect(page.locator(".review-player")).toBeVisible();
    const clips = await page.evaluate((interviewId) => {
      const key = Object.keys(localStorage).find(
        (k) =>
          k.startsWith("timenook.recording.v1:") &&
          k.endsWith(`:${interviewId}`),
      );
      return JSON.parse(localStorage.getItem(key));
    }, p.interview.id);
    expect(clips.map((clip) => clip.actualQuestionId)).toEqual([
      displayed.actualQuestion.id,
      displayed.currentQuestion.id,
    ]);
    expect(clips.map((clip) => clip.durationMs)).toEqual([1080, 1080]);
    expect(errors).toEqual([]);
  } catch (error) {
    await writeFile(
      "/tmp/timenook-t19-followup-timer-debug.txt",
      (await page
        .locator("body")
        .innerText()
        .catch(() => "closed")) +
        "\n" +
        JSON.stringify(errors),
    );
    throw error;
  } finally {
    await page
      .context()
      .close()
      .catch(() => {});
  }
});

for (const action of ["save", "photos", "title"]) {
  test(`revoked sharing clears private ${action} state while the product session and pending originals stay valid`, async ({
    browser,
  }) => {
    const p = await unboundStory(),
      page = await openPage(browser, p.operator),
      path = `/v1/projects/${p.projectId}`;
    try {
      const overview = data(
        await request("GET", `${path}/overview`, p.operator),
        200,
      );
      const url =
        action === "title"
          ? `#/settings?projectId=${p.projectId}`
          : `#/edit-story?projectId=${p.projectId}&storyId=${p.story.id}`;
      await page.evaluate((url) => {
        location.hash = url;
      }, url);
      const input = page
        .locator(action === "title" ? ".live-title" : ".live-input")
        .first();
      await expect(input).toHaveValue(
        action === "title" ? overview.bookTitle : p.story.revision.title,
      );
      await page.evaluate(() => {
        localStorage.setItem(
          "synthetic-only-pending-originals",
          JSON.stringify({
            audio: "only-audio-original",
            photo: "only-photo-original",
          }),
        );
      });
      const state = data(
          await request("GET", `${path}/participation`, p.operator),
          200,
        ),
        sessions = data(
          await request("GET", `${path}/assisted-sessions`, p.operator),
          200,
        ).sessions,
        sharing = sessions.find((session) => session.purpose === "sharing");
      data(
        await request("POST", `${path}/assisted-sessions`, p.operator, {
          purpose: "sharing",
          granted: false,
          expectedBindingVersion: state.bindingVersion,
          expectedAccessEpoch: state.accessEpoch,
          expectedSessionId: sharing.id,
          noticeVersion: "synthetic-d08-v1",
          evidenceRef: `synthetic:本人撤回当前共享-${randomUUID()}`,
        }),
      );
      const suffix =
          action === "title"
            ? "/metadata"
            : action === "photos"
              ? "/photos"
              : "/revisions",
        denied = page.waitForResponse((response) =>
          response.url().endsWith(suffix),
        );
      await page
        .getByRole("button", {
          name:
            action === "title"
              ? "保存书名"
              : action === "photos"
                ? "选用已保存的最新照片清单"
                : "保存为新版本",
          exact: true,
        })
        .click();
      expect((await denied).status()).toBe(403);
      await expect(
        page.getByText("当前资料访问已失效，私人内容已清除，请重新查询授权", {
          exact: true,
        }),
      ).toBeVisible();
      if (action === "title") {
        await expect(page.locator(".live-title")).toHaveValue("");
      } else {
        await expect(page.locator(".live-input")).toHaveCount(0);
        await expect(page.locator(".live-textarea")).toHaveCount(0);
        await expect(
          page.getByText("原声清单与顺序", { exact: true }),
        ).toHaveCount(0);
      }
      expect(
        (await request("GET", "/v1/users/me", p.operator)).statusCode,
      ).toBe(200);
      expect(
        await page.evaluate(
          (key) => !!localStorage.getItem(key),
          `timenook.session.v1:${base}/api/v1`,
        ),
      ).toBe(true);
      expect(
        await page.evaluate(() =>
          JSON.parse(localStorage.getItem("synthetic-only-pending-originals")),
        ),
      ).toEqual({ audio: "only-audio-original", photo: "only-photo-original" });
      expect(errors).toEqual([]);
    } finally {
      await page
        .context()
        .close()
        .catch(() => {});
    }
  });
}
