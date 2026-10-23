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
const schema = `t15_browser_${randomUUID().replaceAll("-", "")}`;
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
const base = "http://127.0.0.1:5177";
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
  root = await mkdtemp(join(tmpdir(), "timenook-transcription-browser-"));
  audioBase64 = readFileSync(
    resolve("apps/api/test/fixtures/synthetic-1s.mp3"),
  ).toString("base64");
  const { createApplication } = apiRequire("./dist-test/src/application.js");
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
  api = await createApplication(
    (config = {
      admin: {
        origin: "https://localhost:5177",
        encryptionKey: randomBytes(32).toString("base64"),
        sessionTtlSeconds: 28800,
        challengeTtlSeconds: 300,
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
      port: 3425,
      databaseUrl,
      redisUrl: process.env.REDIS_URL,
      redisKeyPrefix: schema,
      wechat: { appId: paymentConfig.appId, secret: "synthetic" },
      payments: paymentConfig,
      participation: { mode: "synthetic-d08" },
      recording: { mode: "synthetic-local", storageRoot: root },
    }),
    {
      paymentFetch,
      recordingObjects: new Objects(root),
      aiFetch: async (input, init) =>
        new Response("{}", {
          headers: {
            "X-Api-Status-Code": String(input).endsWith("/submit")
              ? "20000000"
              : "45000132",
          },
        }),
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
  await api.listen(3425, "127.0.0.1");
  preview = spawn(
    process.execPath,
    [
      "node_modules/vite/bin/vite.js",
      "--host",
      "127.0.0.1",
      "--port",
      "5177",
      "--strictPort",
    ],
    {
      cwd: resolve("."),
      env: {
        ...process.env,
        TIMENOOK_API_BASE_URL: `${base}/timenook/v1`,
        TIMENOOK_PREVIEW_API_TARGET: "http://127.0.0.1:3425",
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
  await api?.close();
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
      "/tmp/timenook-t15-browser-debug.txt",
      await latestPage.locator("body").innerText(),
    );
    await latestPage.screenshot({
      path: "/tmp/timenook-t15-browser-failure.png",
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
        `timenook.session.v1:${base}/timenook/v1`,
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

test("the real interview page shows processing, retry and restored completion actions with an actual Worker", async ({
  browser,
}) => {
  const page = await openPage(browser, narrator);
  await page.goto(`${base}/#/interview?projectId=${projectId}`);
  await page
    .getByRole("button", { name: "就从这个问题开始", exact: true })
    .click();
  await page.getByRole("button", { name: "开始说", exact: true }).click();
  await page
    .getByRole("button", { name: "说完了，停止录音", exact: true })
    .click();
  await page
    .getByRole("button", { name: "查询并上传原文件", exact: true })
    .click();
  await expect(
    page.getByText("本地模拟封存完成；转写状态可查询，真实云端尚待验收", {
      exact: true,
    }),
  ).toBeVisible();
  const interviews = data(
    await request("GET", `/v1/projects/${projectId}/interviews`, narrator),
    200,
  );
  data(
    await request("POST", `/v1/projects/${projectId}/tasks/status`, narrator, {
      interviewId: interviews.interviews[0].id,
    }),
  );
  await expect(
    page.getByText("转写中；原声已保存，可以离开，返回后继续查询。", {
      exact: true,
    }),
  ).toBeVisible();
  taskId = data(
    await request("GET", `/v1/projects/${projectId}/tasks`, narrator),
    200,
  )[0].id;
  const wake = async () => {
    const completed = new Promise((resolve) => {
      const onJob = (job) => {
        if (job.id === taskId) {
          runtime.worker.off("completed", onJob);
          resolve();
        }
      };
      runtime.worker.on("completed", onJob);
    });
    await runtime.recoverDue();
    await completed;
  };
  await wake();
  await wake();
  await page
    .getByRole("button", { name: "重新查询转写状态", exact: true })
    .click();
  await expect(
    page.getByText("转写未完成；已保存原声，可以按原任务重试。", {
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({ path: "/tmp/timenook-t15-interview-retry-390.png" });
  const metrics = await page.locator(".live-interview").evaluate((el) => ({
    width: el.getBoundingClientRect().width,
    font: parseFloat(getComputedStyle(el).fontSize),
    controls: [...el.querySelectorAll("button")]
      .filter((n) => n.getBoundingClientRect().height > 0)
      .map((n) => ({
        width: n.getBoundingClientRect().width,
        height: n.getBoundingClientRect().height,
      })),
  }));
  expect(metrics.width).toBeLessThanOrEqual(390);
  expect(metrics.font).toBeGreaterThanOrEqual(20);
  for (const control of metrics.controls) {
    expect(control.width).toBeGreaterThanOrEqual(48);
    expect(control.height).toBeGreaterThanOrEqual(48);
  }
  await page.getByRole("button", { name: "重试这段转写", exact: true }).click();
  await expect(
    page.getByText("转写中；原声已保存，可以离开，返回后继续查询。", {
      exact: true,
    }),
  ).toBeVisible();
  await wake();
  await wake();
  await page.goto(`${base}/#/welcome?projectId=${projectId}`);
  await page.goto(`${base}/#/interview?projectId=${projectId}`);
  await expect(
    page.getByText("转写未完成；已保存原声，可以按原任务重试。", {
      exact: true,
    }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.syntheticDevice.starts)).toBe(1);
  expect(errors).toEqual([]);
  await page.context().close();
});
test("the operator page lists sanitized task failures and executes an audited retry", async ({
  browser,
}) => {
  // Prepare this view independently through the real production recording entry.
  const interview = data(
    await request("POST", `/v1/projects/${projectId}/interviews`, narrator, {
      clientInterviewId: randomUUID(),
      expectedPlanRevision: 1,
      starterKind: "free-narration",
    }),
  );
  const audio = Buffer.from(audioBase64, "base64"),
    { createHash } = await import("node:crypto"),
    clipBase = `/v1/projects/${projectId}/interviews/${interview.id}/clips`;
  const clip = data(
    await request("POST", clipBase, narrator, {
      clientClipId: randomUUID(),
      bytes: audio.length,
      sha256: createHash("sha256").update(audio).digest("hex"),
    }),
  );
  const form = data(
      await request("POST", `${clipBase}/${clip.id}/upload`, narrator, {}),
    ),
    multipart = new FormData();
  for (const [key, value] of Object.entries(form.fields))
    multipart.append(key, value);
  multipart.append(
    "file",
    new Blob([audio], { type: "audio/mpeg" }),
    "synthetic.mp3",
  );
  expect(
    (
      await fetch(`http://127.0.0.1:3425${form.url}`, {
        method: "POST",
        headers: { authorization: `Bearer ${narrator.session.token}` },
        body: multipart,
      })
    ).status,
  ).toBe(204);
  data(await request("POST", `${clipBase}/${clip.id}/seal`, narrator, {}));
  taskId = data(
    await request("GET", `/v1/projects/${projectId}/tasks`, narrator),
    200,
  ).find((task) => task.clipId !== undefined && task.state === "queued").id;
  for (let n = 0; n < 2; n++) {
    const completed = new Promise((resolve) => {
      const onJob = (job) => {
        if (job.id === taskId) {
          runtime.worker.off("completed", onJob);
          resolve();
        }
      };
      runtime.worker.on("completed", onJob);
    });
    await runtime.recoverDue();
    await completed;
  }
  if (preview && preview.exitCode === null)
    await new Promise((resolve) => {
      preview.once("exit", resolve);
      preview.kill("SIGTERM");
    });
  const cert = join(root, "cert.pem"),
    key = join(root, "key.pem");
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
  const account = {
    username: `synthetic-${randomUUID()}`,
    password: randomBytes(24).toString("base64url"),
    realm: "local",
    permissions: ["ops:read", "tasks:retry", "audit:read"],
  };
  const input = join(root, "operator.json");
  await writeFile(input, JSON.stringify(account), { mode: 0o600 });
  const created = spawnSync(
    process.execPath,
    ["dist-test/src/admin/admin-cli.js", "create", "--input-file", input],
    {
      cwd: resolve("apps/api"),
      env: {
        ...process.env,
        NODE_ENV: "test",
        DATABASE_URL: databaseUrl,
        ADMIN_ORIGIN: config.admin.origin,
        ADMIN_ENCRYPTION_KEY: config.admin.encryptionKey,
      },
      encoding: "utf8",
    },
  );
  expect(created.status, "synthetic operator creation").toBe(0);
  preview = spawn(
    process.execPath,
    [
      resolve("node_modules/vite/bin/vite.js"),
      "--host",
      "localhost",
      "--port",
      "5177",
      "--strictPort",
    ],
    {
      cwd: resolve("apps/admin"),
      env: {
        ...process.env,
        ADMIN_API_TARGET: "http://127.0.0.1:3425",
        ADMIN_TLS_CERT: cert,
        ADMIN_TLS_KEY: key,
      },
      stdio: "ignore",
    },
  );
  const https = await import("node:https");
  for (let n = 0; n < 100; n++) {
    const ready = await new Promise((resolve) => {
      const r = https.get(
        "https://localhost:5177/timenook/admin/",
        { rejectUnauthorized: false },
        (res) => {
          res.resume();
          resolve(res.statusCode === 200);
        },
      );
      r.on("error", () => resolve(false));
    });
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      ignoreHTTPSErrors: true,
    }),
    page = await context.newPage();
  latestPage = page;
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto("https://localhost:5177/timenook/admin/");
  await page.getByLabel("管理员账号", { exact: true }).fill(account.username);
  await page.getByLabel("密码", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "继续验证", exact: true }).click();
  const enrollment = await page.getByTestId("enrollment-secret").textContent();
  const { generate } = apiRequire("otplib");
  await page
    .getByLabel("六位验证码", { exact: true })
    .fill(await generate({ secret: enrollment.trim() }));
  await page.getByRole("button", { name: "验证并登录", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "转写任务", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "转写任务", exact: true }).click();
  await expect(
    page.getByText("PROVIDER_FAILED", { exact: true }).first(),
  ).toBeVisible();
  expect(await page.locator("body").innerText()).not.toContain("signature=");
  await page
    .getByRole("button", { name: `重试任务 ${taskId}`, exact: true })
    .click();
  await expect(
    page.getByText("重试已受理，仍使用原业务任务。", { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: "/tmp/timenook-t15-admin-retry-1280.png" });
  expect(errors).toEqual([]);
  await context.close();
});
