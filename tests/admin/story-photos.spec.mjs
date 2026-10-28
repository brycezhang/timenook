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
const sharp = apiRequire("sharp");
let photoPaths, sourcePhoto;
const schema = `t16_browser_${randomUUID().replaceAll("-", "")}`;
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
const network = [];
const acceptedRequests = new Set();
const providerCalls = [];
const base = "http://127.0.0.1:5178";
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
  root = await mkdtemp(join(tmpdir(), "timenook-photos-browser-"));
  sourcePhoto = await sharp({
    create: { width: 120, height: 80, channels: 3, background: "#e54334" },
  })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();
  photoPaths = [
    join(root, "synthetic-one.jpg"),
    join(root, "synthetic-two.png"),
  ];
  await writeFile(photoPaths[0], sourcePhoto);
  await sharp({
    create: { width: 60, height: 40, channels: 3, background: "#247b93" },
  })
    .png()
    .toFile(photoPaths[1]);
  audioBase64 = readFileSync(
    resolve("apps/api/test/fixtures/synthetic-1s.mp3"),
  ).toString("base64");
  const { LocalProbeObjects } = apiRequire(
    "./dist-test/src/probe/local-objects.js",
  );
  class Objects extends LocalProbeObjects {
    async asrSource(key) {
      await this.read(key);
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
    {
      environment: "test",
      host: "127.0.0.1",
      port: 3426,
      databaseUrl,
      redisUrl: process.env.REDIS_URL,
      redisKeyPrefix: schema,
      wechat: { appId: paymentConfig.appId, secret: "synthetic" },
      payments: paymentConfig,
      participation: { mode: "synthetic-d08" },
      recording: { mode: "synthetic-local", storageRoot: root },
      transcription: {
        mode: "synthetic-local",
        configVersion: "synthetic-t16-browser-combined",
        doubao: {
          apiKey: "synthetic-t16-key",
          resourceId: "synthetic-t16-resource",
          fetchWindowSeconds: 60,
        },
        pollIntervalMs: 0,
        submissionReservationFen: 1,
        deadlineMs: 600000,
      },
      photos: {
        mode: "synthetic-local",
        placement: { widthMm: 100, heightMm: 150 },
      },
    },
    {
      paymentFetch,
      recordingObjects: new Objects(root),
      aiFetch: async (input, init) => {
        const action = String(input).endsWith("/submit") ? "submit" : "query",
          id = new Headers(init.headers).get("X-Api-Request-Id");
        providerCalls.push({ action, id });
        if (action === "submit") acceptedRequests.add(id);
        if (!acceptedRequests.has(id))
          return new Response("{}", {
            status: 404,
            headers: { "X-Api-Status-Code": "45000001" },
          });
        return new Response(
          action === "submit"
            ? "{}"
            : JSON.stringify({
                task_id: id,
                result: { text: "照片里的旧屋还在记忆里。" },
              }),
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
  runtime = await apiRequire(
    "./dist-test/src/tasks/worker.js",
  ).startProductionWorker(api);
  await api.listen(3426, "127.0.0.1");
  preview = spawn(
    process.execPath,
    [
      "node_modules/vite/bin/vite.js",
      "--host",
      "127.0.0.1",
      "--port",
      "5178",
      "--strictPort",
    ],
    {
      cwd: resolve("."),
      env: {
        ...process.env,
        TIMENOOK_API_BASE_URL: `${base}/api/v1`,
        TIMENOOK_PREVIEW_API_TARGET: "http://127.0.0.1:3426",
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
      "/tmp/timenook-t16-browser-debug.txt",
      (await latestPage.locator("body").innerText()) +
        "\n" +
        JSON.stringify({ network, errors }, null, 2),
    );
    await latestPage.screenshot({
      path: "/tmp/timenook-t16-browser-failure.png",
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
  page.on("response", (r) => {
    if (r.url().includes("/v1/"))
      network.push([new URL(r.url()).pathname, r.status()]);
  });
  page.on("requestfailed", (r) =>
    network.push([new URL(r.url()).pathname, r.failure()?.errorText]),
  );
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/\b(?:40[139]|422|503)\b/.test(m.text()))
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
        saveFile: (o) =>
          o.tempFilePath.startsWith("data:audio")
            ? o.success({ savedFilePath: o.tempFilePath })
            : fs.saveFile(o),
      });
    },
    { session, base, audioBase64 },
  );
  return page;
}
async function wake(taskId) {
  const delivered = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      runtime.worker.off("completed", completed);
      reject(Error("combined browser Worker delivery timed out"));
    }, 5000);
    const completed = (job) => {
      if (job.id !== taskId) return;
      clearTimeout(timer);
      runtime.worker.off("completed", completed);
      resolve();
    };
    runtime.worker.on("completed", completed);
  });
  await runtime.recoverDue();
  await delivered;
}

test("photo starter saves two originals independently, retries one failure and edits private material snapshots through real HTTP", async ({
  browser,
}) => {
  const page = await openPage(browser, narrator);
  await page.goto(`${base}/#/welcome?projectId=${projectId}`);
  await page
    .getByRole("button", { name: "进入本人参与的项目", exact: true })
    .click();
  await page.getByRole("button", { name: "开始一段讲述", exact: true }).click();
  await page
    .getByRole("button", { name: "看着照片讲一讲", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "选择原照片", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("每张照片分别保存和上传；原文件会保留", { exact: true }),
  ).toBeVisible();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "选择原照片", exact: true }).click();
  await (await chooser).setFiles(photoPaths);
  await expect(
    page.getByText("本机原文件和清单已保存，尚未封存", { exact: true }),
  ).toHaveCount(2);
  let fail = true;
  await page.route("**/photos/*/seal", async (route) => {
    if (fail) {
      fail = false;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "SERVICE_UNAVAILABLE" },
          meta: { requestId: "synthetic-controlled-network" },
        }),
      });
    } else await route.continue();
  });
  await page
    .getByRole("button", { name: "单独上传或重试", exact: true })
    .nth(0)
    .click();
  await expect(page.getByText(/封存未确认，原文件仍在/)).toHaveCount(1);
  await page
    .getByRole("button", { name: "单独上传或重试", exact: true })
    .nth(1)
    .click();
  await expect(
    page.getByText("已封存；清晰度较低，只作提示，不会编造图像", {
      exact: true,
    }),
  ).toHaveCount(1);
  await page
    .getByRole("button", { name: "单独上传或重试", exact: true })
    .click();
  await expect(
    page.getByText("已封存；清晰度较低，只作提示，不会编造图像", {
      exact: true,
    }),
  ).toHaveCount(2);
  const interviews = data(
      await request("GET", `/v1/projects/${projectId}/interviews`, narrator),
      200,
    ),
    i = interviews.interviews[0];
  expect(i.actualQuestion.starterKind).toBe("photo");
  const photosBase = `/v1/projects/${projectId}/interviews/${i.id}/photos`;
  const before = data(await request("GET", photosBase, narrator), 200);
  expect(before.photos).toHaveLength(2);
  expect(before.snapshot.revision).toBe(2);
  expect(before.usage).toEqual({ reservedCount: 0, consumedCount: 2 });
  const first = before.photos.find((p) => p.orientedPixels.width === 80);
  const original = await request(
    "GET",
    `${photosBase}/${first.id}/content/original`,
    narrator,
  );
  expect(original.statusCode).toBe(200);
  expect(original.rawPayload.equals(sourcePhoto)).toBe(true);
  const preview = await request(
    "GET",
    `${photosBase}/${first.id}/content/preview`,
    narrator,
  );
  expect(preview.statusCode).toBe(200);
  expect(preview.headers["cache-control"]).toBe("private, no-store");
  const meta = await sharp(preview.rawPayload).metadata();
  expect(meta.exif).toBeUndefined();
  expect(meta.width).toBe(80);
  expect(meta.height).toBe(120);
  const caption = page.getByPlaceholder("这张照片想说明什么？").first();
  await caption.fill("这是老屋的门口");
  await page
    .getByRole("button", { name: "保存这张照片的说明", exact: true })
    .first()
    .click();
  await expect(page.getByText("这是老屋的门口", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "往前放一张", exact: true }).click();
  await expect(page.getByText(/已保存的照片引用 · 版本 4/)).toBeVisible();
  await page
    .getByRole("button", { name: "安全查看这张照片", exact: true })
    .first()
    .click();
  await expect(page.locator(".photos-page > img")).toBeVisible();
  const cacheKey = `timenook.photo-previews.v1:${base}/api/v1`;
  expect(
    await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key) || "[]").length,
      cacheKey,
    ),
  ).toBe(1);
  await page.screenshot({ path: "/tmp/timenook-t16-photos-390.png" });
  for (const size of await page
    .locator(".photos-page button")
    .evaluateAll((nodes) =>
      nodes.map((n) => ({
        font: parseFloat(getComputedStyle(n).fontSize),
        width: n.getBoundingClientRect().width,
        height: n.getBoundingClientRect().height,
      })),
    )) {
    expect(size.font).toBeGreaterThanOrEqual(20);
    expect(size.width).toBeGreaterThanOrEqual(48);
    expect(size.height).toBeGreaterThanOrEqual(48);
  }
  await page.setViewportSize({ width: 768, height: 1000 });
  expect(
    await page
      .locator("#phone")
      .evaluate((n) => n.getBoundingClientRect().width),
  ).toBe(390);
  await page.screenshot({ path: "/tmp/timenook-t16-photos-768.png" });
  await page
    .getByRole("button", { name: "返回采访，开始说", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "开始说", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        (key) => JSON.parse(localStorage.getItem(key) || "[]").length,
        cacheKey,
      ),
    )
    .toBe(0);
  await page.getByRole("button", { name: "开始说", exact: true }).click();
  await page
    .getByRole("button", { name: "说完了，停止录音", exact: true })
    .click();
  await expect(
    page.getByText("本机文件已保存，尚待封存", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "查询并上传原文件", exact: true })
    .click();
  await expect(page.getByText(/本地模拟封存完成/)).toBeVisible();
  const recorded = data(
    await request(
      "GET",
      `/v1/projects/${projectId}/interviews/${i.id}`,
      narrator,
    ),
    200,
  );
  expect(recorded.clips).toHaveLength(1);
  await expect(
    page.getByText("转写中；原声已保存，可以离开，返回后继续查询。", {
      exact: true,
    }),
  ).toBeVisible();
  const tasks = data(
    await request("GET", `/v1/projects/${projectId}/tasks`, narrator),
    200,
  );
  expect(tasks).toHaveLength(1);
  expect(tasks[0].state).toBe("queued");
  const participation = data(
    await request("GET", `/v1/projects/${projectId}/participation`, narrator),
    200,
  );
  data(
    await request("POST", `/v1/projects/${projectId}/consents`, narrator, {
      purpose: "ai",
      granted: true,
      noticeVersion: "synthetic-d08-v1",
      evidenceRef: "synthetic:browser后补AI许可",
      expectedBindingVersion: participation.bindingVersion,
      expectedAccessEpoch: participation.accessEpoch,
    }),
  );
  expect(
    data(
      await request("GET", `/v1/projects/${projectId}/participation`, narrator),
      200,
    ).accessEpoch,
  ).toBe(participation.accessEpoch);
  await wake(tasks[0].id);
  expect(
    data(
      await request("GET", `/v1/projects/${projectId}/tasks`, narrator),
      200,
    )[0].state,
  ).toBe("waiting_provider");
  await page
    .getByRole("button", { name: "查看照片或事后补图", exact: true })
    .click();
  await expect(page.getByText(/已保存的照片引用 · 版本 4/)).toBeVisible();
  const existing = data(
    await request(
      "GET",
      `${photosBase}/materials/${before.snapshot.id}`,
      narrator,
    ),
    200,
  );
  expect(existing).toEqual(before.snapshot);
  const current = data(await request("GET", photosBase, narrator), 200);
  expect(current.snapshot.revision).toBe(4);
  const recordedAgain = data(
    await request(
      "GET",
      `/v1/projects/${projectId}/interviews/${i.id}`,
      narrator,
    ),
    200,
  );
  expect(recordedAgain.clips).toEqual(recorded.clips);
  await wake(tasks[0].id);
  const completed = data(
    await request("GET", `/v1/projects/${projectId}/tasks`, narrator),
    200,
  );
  expect(completed).toHaveLength(1);
  expect(completed[0].id).toBe(tasks[0].id);
  expect(completed[0].state).toBe("succeeded");
  expect(completed[0].queuedAt).toBe(tasks[0].queuedAt);
  expect(completed[0].recordingUsageMs).toBe(1080);
  expect(completed[0].originalTranscript.text).toBe("照片里的旧屋还在记忆里。");
  expect(providerCalls).toEqual([
    { action: "submit", id: tasks[0].providerRequestId },
    { action: "query", id: tasks[0].providerRequestId },
  ]);
  await page
    .getByRole("button", { name: "返回采访，开始说", exact: true })
    .click();
  await expect(
    page.getByText("转写完成；原声与正式转录已保存。", { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.syntheticDevice.starts)).toBe(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "/tmp/timenook-t16-combined-transcription-390.png",
  });
  expect(
    network.filter(
      ([path, status]) => path.includes("/tasks") && status === 404,
    ),
  ).toEqual([]);
  expect(errors).toEqual([]);
  await page.context().close();
});

test("the combined interview clears private task state after an actual status 401 and retains its pending recording", async ({
  browser,
}) => {
  const current = await login("synthetic-plan-narrator"),
    page = await openPage(browser, current);
  await page.goto(`${base}/#/interview?projectId=${projectId}`);
  await expect(
    page.getByText("转写完成；原声与正式转录已保存。", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "开始说", exact: true }).click();
  await page
    .getByRole("button", { name: "说完了，停止录音", exact: true })
    .click();
  await expect(
    page.getByText("本机文件已保存，尚待封存", { exact: true }),
  ).toBeVisible();
  await page
    .getByPlaceholder("想讲的问题", { exact: true })
    .fill("私人采访草稿");
  expect(
    (await request("DELETE", `/v1/sessions/${current.session.id}`, current))
      .statusCode,
  ).toBe(204);
  const denied = page.waitForResponse(
    (r) => r.url().endsWith("/tasks/status") && r.status() === 401,
  );
  await page
    .getByRole("button", { name: "重新查询转写状态", exact: true })
    .click();
  await denied;
  await expect(
    page.getByText("当前权限已失效，请重新查询或登录；本机原文件仍保留", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("转写完成；原声与正式转录已保存。", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "开始说", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByPlaceholder("想讲的问题", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "重新查询与恢复", exact: true }),
  ).toBeEnabled();
  const retained = await page.evaluate(
    ({ base }) => {
      const clips = Object.entries(localStorage)
        .filter(
          ([key, value]) =>
            key.startsWith("timenook.recording.v1:") &&
            Array.isArray(JSON.parse(value)),
        )
        .flatMap(([, value]) => JSON.parse(value));
      return {
        sessionPresent: !!localStorage.getItem(
          `timenook.session.v1:${base}/api/v1`,
        ),
        pending: clips.filter((clip) => !clip.sealed && !!clip.path).length,
      };
    },
    { base },
  );
  expect(retained).toEqual({ sessionPresent: false, pending: 1 });
  expect(errors).toEqual([]);
  await page.context().close();
});

test("an actual download 401 clears private material despite device session-cache removal failure and preserves the pending original", async ({
  browser,
}) => {
  const current = await login("synthetic-plan-narrator"),
    i = data(
      await request("GET", `/v1/projects/${projectId}/interviews`, current),
      200,
    ).interviews[0],
    page = await openPage(browser, current);
  await page.goto(
    `${base}/#/photos?projectId=${projectId}&interviewId=${i.id}`,
  );
  await expect(page.getByText(/已保存的照片引用 · 版本 4/)).toBeVisible();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "选择原照片", exact: true }).click();
  await (await chooser).setFiles(photoPaths[0]);
  await expect(
    page.getByText("本机原文件和清单已保存，尚未封存", { exact: true }),
  ).toHaveCount(1);
  await page
    .getByPlaceholder("这张照片想说明什么？")
    .first()
    .fill("不可留屏的私人说明草稿");
  await page.evaluate(() => {
    window.photoCleanup = { downloaded: [], removed: [] };
    const download = window.wx.downloadFile.bind(window.wx),
      fileSystem = window.wx.getFileSystemManager.bind(window.wx),
      remove = window.wx.removeStorageSync.bind(window.wx);
    window.wx.downloadFile = (options) =>
      download({
        ...options,
        success(result) {
          window.photoCleanup.downloaded.push(result.tempFilePath);
          options.success?.(result);
        },
      });
    window.wx.getFileSystemManager = () => {
      const fs = fileSystem();
      return {
        ...fs,
        unlink(options) {
          fs.unlink({
            ...options,
            success(result) {
              window.photoCleanup.removed.push(options.filePath);
              options.success?.(result);
            },
          });
        },
      };
    };
    window.wx.removeStorageSync = (key) => {
      if (key.includes("session.v1"))
        throw Error("synthetic device session storage unavailable");
      remove(key);
    };
  });
  expect(
    (await request("DELETE", `/v1/sessions/${current.session.id}`, current))
      .statusCode,
  ).toBe(204);
  const denied = page.waitForResponse(
    (r) => /\/assets\/[^/]+\/content$/.test(r.url()) && r.status() === 401,
  );
  await page
    .getByRole("button", { name: "安全查看这张照片", exact: true })
    .first()
    .click();
  await denied;
  await expect(
    page.getByText("登录已失效；设备会话缓存清理失败，请重试登录", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator(".photos-page > img")).toHaveCount(0);
  await expect(page.getByPlaceholder("这张照片想说明什么？")).toHaveCount(0);
  await expect(page.getByText(/已保存的照片引用/)).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => window.photoCleanup.removed.length))
    .toBeGreaterThan(0);
  const device = await page.evaluate(
    async ({ base }) => {
      const originals = Object.entries(localStorage)
        .filter(([key]) => key.startsWith("timenook.photos.v1:"))
        .flatMap(([, value]) => JSON.parse(value));
      const db = await new Promise((resolve, reject) => {
        const open = indexedDB.open("timenook-media", 1);
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      const originalsExist = await Promise.all(
        originals.map(
          ({ path }) =>
            new Promise((resolve) => {
              const get = db
                .transaction("files")
                .objectStore("files")
                .get(path);
              get.onsuccess = () => resolve(get.result instanceof Blob);
              get.onerror = () => resolve(false);
            }),
        ),
      );
      db.close();
      return {
        sessionPersisted: !!localStorage.getItem(
          `timenook.session.v1:${base}/api/v1`,
        ),
        allDeniedPathsRemoved: window.photoCleanup.downloaded.every((path) =>
          window.photoCleanup.removed.includes(path),
        ),
        pendingOriginalCount: originals.length,
        originalsExist,
      };
    },
    { base },
  );
  expect(device).toEqual({
    sessionPersisted: true,
    allDeniedPathsRemoved: true,
    pendingOriginalCount: 1,
    originalsExist: [true],
  });
  expect(errors).toEqual([]);
  await page.context().close();
});

for (const direction of ["interview-to-photo", "photo-to-interview"]) {
  test(`shared-session invalidation clears the active page across ${direction} navigation`, async ({
    browser,
  }) => {
    const current = await login("synthetic-plan-narrator"),
      i = data(
        await request("GET", `/v1/projects/${projectId}/interviews`, current),
        200,
      ).interviews[0],
      page = await openPage(browser, current),
      fromInterview = direction === "interview-to-photo";
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const pattern = fromInterview ? "**/tasks/status" : "**/assets/*/content";
    await page.route(pattern, async (route) => {
      await gate;
      await route.continue();
    });
    try {
      if (fromInterview) {
        const pending = page.waitForRequest((r) =>
          r.url().endsWith("/tasks/status"),
        );
        await page.goto(`${base}/#/interview?projectId=${projectId}`);
        await pending;
        await page
          .getByRole("button", { name: "查看照片或事后补图", exact: true })
          .click();
      } else {
        await page.goto(`${base}/#/interview?projectId=${projectId}`);
        await expect(
          page.getByText("转写完成；原声与正式转录已保存。", { exact: true }),
        ).toBeVisible();
        await page
          .getByRole("button", { name: "查看照片或事后补图", exact: true })
          .click();
      }
      await expect(page.getByText(/已保存的照片引用 · 版本 4/)).toBeVisible();
      const chooser = page.waitForEvent("filechooser");
      await page
        .getByRole("button", { name: "选择原照片", exact: true })
        .click();
      await (await chooser).setFiles(photoPaths[0]);
      await expect(
        page.getByText("本机原文件和清单已保存，尚未封存", { exact: true }),
      ).toHaveCount(1);
      await page
        .getByPlaceholder("这张照片想说明什么？")
        .first()
        .fill("跨页私人照片草稿");
      await page.evaluate(() => {
        window.crossPageRemoved = [];
        const fileSystem = window.wx.getFileSystemManager.bind(window.wx);
        window.wx.getFileSystemManager = () => {
          const fs = fileSystem();
          return {
            ...fs,
            unlink(options) {
              fs.unlink({
                ...options,
                success(result) {
                  window.crossPageRemoved.push(options.filePath);
                  options.success?.(result);
                },
              });
            },
          };
        };
      });
      const pendingImage = fromInterview
        ? null
        : page.waitForRequest((r) => /\/assets\/[^/]+\/content$/.test(r.url()));
      await page
        .getByRole("button", { name: "安全查看这张照片", exact: true })
        .first()
        .click();
      if (pendingImage) {
        await pendingImage;
        await page
          .getByRole("button", { name: "返回采访，开始说", exact: true })
          .click();
        await expect(
          page.getByText("转写完成；原声与正式转录已保存。", { exact: true }),
        ).toBeVisible();
        await page.getByRole("button", { name: "开始说", exact: true }).click();
        await page
          .getByRole("button", { name: "说完了，停止录音", exact: true })
          .click();
        await expect(
          page.getByText("本机文件已保存，尚待封存", { exact: true }),
        ).toBeVisible();
        await page
          .getByPlaceholder("想讲的问题", { exact: true })
          .fill("跨页私人采访草稿");
      } else {
        await expect(page.locator(".photos-page > img")).toBeVisible();
      }
      expect(
        (await request("DELETE", `/v1/sessions/${current.session.id}`, current))
          .statusCode,
      ).toBe(204);
      const denied = page.waitForResponse(
        (r) =>
          (fromInterview
            ? r.url().endsWith("/tasks/status")
            : /\/assets\/[^/]+\/content$/.test(r.url())) && r.status() === 401,
      );
      await page.evaluate((expiresAt) => {
        const boundary = Date.parse(expiresAt);
        Date.now = () => boundary;
      }, current.session.expiresAt);
      release();
      await denied;
      await expect(
        page.getByText(
          fromInterview
            ? "照片权限已变化，请重新查询"
            : "当前权限已失效，请重新查询或登录；本机原文件仍保留",
          { exact: true },
        ),
      ).toBeVisible();
      await expect(page.locator(".photos-page > img")).toHaveCount(0);
      await expect(page.getByPlaceholder("这张照片想说明什么？")).toHaveCount(
        0,
      );
      await expect(
        page.getByPlaceholder("想讲的问题", { exact: true }),
      ).toHaveCount(0);
      await expect
        .poll(() => page.evaluate(() => window.crossPageRemoved.length))
        .toBeGreaterThan(0);
      const retained = await page.evaluate(
        ({ base }) => {
          const pending = (prefix) =>
            Object.entries(localStorage)
              .filter(
                ([key, value]) =>
                  key.startsWith(prefix) && Array.isArray(JSON.parse(value)),
              )
              .flatMap(([, value]) => JSON.parse(value))
              .filter((file) => !file.sealed && file.path);
          const photos = pending("timenook.photos.v1:");
          return {
            session: !!localStorage.getItem(
              `timenook.session.v1:${base}/api/v1`,
            ),
            pendingPhotos: photos.length,
            pendingRecordings: pending("timenook.recording.v1:").length,
            originalRemoved: photos.some((photo) =>
              window.crossPageRemoved.includes(photo.path),
            ),
            previews: JSON.parse(
              localStorage.getItem(
                `timenook.photo-previews.v1:${base}/api/v1`,
              ) || "[]",
            ).length,
          };
        },
        { base },
      );
      expect(retained).toEqual({
        session: false,
        pendingPhotos: 1,
        pendingRecordings: fromInterview ? 0 : 1,
        originalRemoved: false,
        previews: 0,
      });
      expect(errors).toEqual([]);
    } finally {
      release();
      await page.context().close();
    }
  });
}

test("unsupported photo recovery retains the local original and permission changes clear private previews", async ({
  browser,
}) => {
  const i = data(
      await request("GET", `/v1/projects/${projectId}/interviews`, narrator),
      200,
    ).interviews[0],
    photosBase = `/v1/projects/${projectId}/interviews/${i.id}/photos`;
  const invalidPath = join(root, "synthetic-unverified.webp");
  await sharp({
    create: { width: 80, height: 60, channels: 3, background: "#247b93" },
  })
    .webp()
    .toFile(invalidPath);
  const page = await openPage(browser, narrator);
  await page.goto(
    `${base}/#/photos?projectId=${projectId}&interviewId=${i.id}`,
  );
  await expect(
    page.getByText("每张照片分别保存和上传；原文件会保留", { exact: true }),
  ).toBeVisible();
  let chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "选择原照片", exact: true }).click();
  await (await chooser).setFiles(invalidPath);
  await expect(
    page.getByText("本机原文件和清单已保存，尚未封存", { exact: true }),
  ).toHaveCount(1);
  const rejected = page.waitForResponse(
    (r) => r.url().endsWith("/seal") && r.status() === 422,
  );
  await page
    .getByRole("button", { name: "单独上传或重试", exact: true })
    .click();
  await rejected;
  await expect(page.getByText(/封存未确认，原文件仍在/)).toBeVisible();
  await page
    .getByRole("button", { name: "取消预留，保留原文件", exact: true })
    .click();
  await expect(
    page.getByText("预留已取消；本机原文件仍保留，请另选支持的照片", {
      exact: true,
    }),
  ).toBeVisible();
  chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "选择原照片", exact: true }).click();
  await (await chooser).setFiles(photoPaths[0]);
  await expect(
    page.getByText("本机原文件和清单已保存，尚未封存", { exact: true }),
  ).toHaveCount(1);
  await page
    .getByRole("button", { name: "单独上传或重试", exact: true })
    .click();
  await expect(
    page.getByText("已封存；清晰度较低，只作提示，不会编造图像", {
      exact: true,
    }),
  ).toHaveCount(1);
  const state = data(await request("GET", photosBase, narrator), 200);
  expect(state.usage).toEqual({ reservedCount: 0, consumedCount: 3 });
  expect(state.snapshot.revision).toBe(5);
  await page.screenshot({ path: "/tmp/timenook-t16-unsupported-recovery.png" });
  await page
    .getByRole("button", { name: "安全查看这张照片", exact: true })
    .first()
    .click();
  await expect(page.locator(".photos-page > img")).toBeVisible();
  const participation = data(
    await request("GET", `/v1/projects/${projectId}/participation`, narrator),
    200,
  );
  data(
    await request("POST", `/v1/projects/${projectId}/consents`, narrator, {
      purpose: "collection",
      granted: false,
      noticeVersion: "synthetic-d08-v1",
      evidenceRef: "synthetic:browser本人撤回",
      expectedBindingVersion: participation.bindingVersion,
      expectedAccessEpoch: participation.accessEpoch,
    }),
  );
  await page
    .getByRole("button", { name: "安全查看这张照片", exact: true })
    .first()
    .click();
  await expect(
    page.getByText("照片权限已变化，请重新查询", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".photos-page > img")).toHaveCount(0);
  const cacheKey = `timenook.photo-previews.v1:${base}/api/v1`;
  await expect
    .poll(() =>
      page.evaluate(
        (key) => JSON.parse(localStorage.getItem(key) || "[]").length,
        cacheKey,
      ),
    )
    .toBe(0);
  const originals = await page.evaluate(() =>
    Object.entries(localStorage)
      .filter(([key]) => key.startsWith("timenook.photos.v1:"))
      .flatMap(([, value]) => JSON.parse(value)),
  );
  expect(originals).toHaveLength(2);
  expect(originals.every((p) => p.path)).toBe(true);
  expect(
    (
      await request(
        "GET",
        `${photosBase}/${state.photos.find((p) => p.state === "sealed").id}/content/preview`,
        narrator,
      )
    ).statusCode,
  ).toBe(403);
  expect(errors).toEqual([]);
  await page.context().close();
});
