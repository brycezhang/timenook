import { test, expect } from "@playwright/test";
import { prepareRecordingStep } from "./recording-step-helper.mjs";
import {
  createPrivacyFixtureApplication,
  closePrivacyFixtureApplication,
} from "./privacy-fixture.mjs";
import { createRequire } from "node:module";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { get as httpsGet } from "node:https";
import { createServer, request as forwardRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const apiRequire = createRequire(resolve("apps/api/package.json"));
const { PrismaClient } = apiRequire("@prisma/client");
const Redis = apiRequire("ioredis");
const schema = `w02b_browser_${randomUUID().replaceAll("-", "")}`;
const origin = "https://127.0.0.1:4335";
let app, server, config, root, relay;
let delayedPrivate;
let rejectLogout = false;
let projectAccount, projectId, webEnv;

async function stopWebServer() {
  const active = server;
  server = undefined;
  if (active && active.exitCode === null)
    await new Promise((resolve) => {
      active.once("exit", resolve);
      active.kill("SIGTERM");
    });
}
async function startWebServer(production) {
  server = spawn(
    process.execPath,
    [
      resolve("node_modules/vite/bin/vite.js"),
      ...(production ? ["preview"] : []),
      "--port",
      "4335",
      "--strictPort",
    ],
    { cwd: resolve("apps/web"), stdio: "ignore", env: webEnv },
  );
  await expect
    .poll(
      () =>
        new Promise((resolveStatus) => {
          httpsGet(
            `${origin}/app/`,
            { rejectUnauthorized: false },
            (response) => {
              response.resume();
              resolveStatus(response.statusCode);
            },
          ).on("error", () => resolveStatus(0));
        }),
    )
    .toBe(200);
}

function data(response, status = 201) {
  expect(response.statusCode, "public fixture request status").toBe(status);
  return response.json().data;
}
async function prepareExistingProject() {
  const { paid } = apiRequire("./dist-test/test/payment-fixture.js");
  const snapshot = JSON.parse(
    await readFile(
      resolve("apps/api/test/fixtures/catalog-synthetic.json"),
      "utf8",
    ),
  );
  const db = new PrismaClient({ datasourceUrl: config.databaseUrl });
  const draftId = randomUUID(),
    versionId = randomUUID();
  try {
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
  } finally {
    await db.$disconnect();
  }
  const login = async () =>
    data(
      await app.inject({
        method: "POST",
        url: "/v1/sessions/wechat",
        payload: { code: randomUUID() },
      }),
    );
  const buyer = await login(),
    narrator = await login();
  const request = (method, url, actor, payload) =>
    app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${actor.session.token}`,
        "idempotency-key": randomUUID(),
      },
      ...(payload ? { payload } : {}),
    });
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
  const invite = data(
    await request("POST", `/v1/projects/${projectId}/invitations`, buyer, {}),
  );
  const application = data(
    await request(
      "POST",
      `/v1/invitations/${invite.token}/requests`,
      narrator,
      {
        noticeVersion: "synthetic-d08-v1",
        evidenceRef: "synthetic:cookie fixture narrator applies",
      },
    ),
  );
  data(
    await request(
      "POST",
      `/v1/binding-requests/${application.id}/approve`,
      buyer,
      {
        expectedBindingVersion: 0,
        evidenceRef: "synthetic:cookie fixture initiator approves",
      },
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
        expectedBindingVersion: state.bindingVersion,
        expectedAccessEpoch: state.accessEpoch,
        noticeVersion: "synthetic-d08-v1",
        evidenceRef: "synthetic:cookie fixture native consent",
      }),
    );
  }
  projectAccount = narrator.user.id;
}

async function cli(command, input) {
  const id = randomUUID();
  const inputFile = join(root, `${id}-input.json`);
  const outputFile = join(root, `${id}-output.json`);
  await writeFile(inputFile, JSON.stringify(input), {
    mode: 0o600,
    flag: "wx",
  });
  const result = spawnSync(
    process.execPath,
    [
      resolve("apps/api/dist/web/web-cli.js"),
      command,
      "--input-file",
      inputFile,
      "--output-file",
      outputFile,
    ],
    {
      cwd: resolve("apps/api"),
      env: {
        PATH: process.env.PATH,
        NODE_ENV: "test",
        DATABASE_URL: config.databaseUrl,
        REDIS_URL: config.redisUrl,
        WEB_ORIGIN: origin,
        WEB_SESSION_KEY: config.web.sessionKey,
        PRIVACY_JOURNAL_ROOT: config.privacyJournal.root,
        PRIVACY_JOURNAL_KEY: config.privacyJournal.key,
      },
      stdio: "pipe",
      timeout: 15000,
    },
  );
  expect(result.status, `controlled CLI ${command} completed`).toBe(0);
  return JSON.parse(await readFile(outputFile, "utf8"));
}
async function loginLink() {
  const account = await cli("create", {});
  const issued = await cli("issue", { userId: account.user.id });
  return { ...issued, userId: account.user.id };
}
async function openLink(page, url) {
  // Keep a live one-time ticket out of navigation failure messages and traces.
  await page.goto(`${origin}/app/login`);
  await page.evaluate((value) => location.replace(value), url);
  await expect(
    page.getByRole("button", { name: "进入我的故事书" }),
  ).toBeVisible();
}

test.beforeAll(async () => {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set("schema", schema);
  root = await mkdtemp(join(tmpdir(), "timenook-web-browser-"));
  await chmod(root, 0o700);
  const migrated = spawnSync(
    process.execPath,
    ["node_modules/prisma/build/index.js", "migrate", "deploy"],
    {
      cwd: resolve("apps/api"),
      env: { ...process.env, DATABASE_URL: url.toString() },
      stdio: "pipe",
    },
  );
  expect(migrated.status, "isolated database migrations").toBe(0);
  config = {
    environment: "test",
    host: "127.0.0.1",
    port: 3455,
    databaseUrl: url.toString(),
    redisUrl: process.env.REDIS_URL,
    redisKeyPrefix: schema,
    web: {
      origin,
      sessionKey: randomBytes(32).toString("base64"),
      loginTtlSeconds: 900,
      sessionTtlSeconds: 43200,
    },
  };
  const { paymentConfig, paymentFetch } = apiRequire(
    "./dist-test/test/payment-fixture.js",
  );
  Object.assign(config, {
    wechat: { appId: paymentConfig.appId, secret: "synthetic" },
    payments: paymentConfig,
    participation: { mode: "synthetic-d08" },
    recording: {
      mode: "synthetic-local",
      storageRoot: join(root, "recordings"),
    },
  });
  app = await createPrivacyFixtureApplication(config, {
    paymentFetch,
    wechatFetch: async (input) =>
      new Response(
        JSON.stringify({
          openid: new URL(String(input)).searchParams.get("js_code"),
          session_key: "synthetic",
        }),
      ),
  });
  await prepareExistingProject();
  await app.listen(3455, "127.0.0.1");
  // Transparent HTTP transport fault injection; application responses are real.
  relay = createServer((request, response) => {
    if (
      rejectLogout &&
      request.method === "DELETE" &&
      request.url === "/v1/web/session"
    ) {
      rejectLogout = false;
      response.writeHead(503, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          error: { code: "UNAVAILABLE" },
          meta: { requestId: randomUUID() },
        }),
      );
      return;
    }
    const held =
      request.method === "GET" && request.url === "/v1/users/me"
        ? delayedPrivate
        : undefined;
    if (held) delayedPrivate = undefined;
    const upstream = forwardRequest(
      {
        host: "127.0.0.1",
        port: 3455,
        path: request.url,
        method: request.method,
        headers: request.headers,
      },
      (result) => {
        const chunks = [];
        let size = 0;
        result.on("data", (chunk) => {
          size += chunk.length;
          if (size > 1048576) result.destroy();
          else chunks.push(chunk);
        });
        result.on("end", async () => {
          if (held) {
            held.started();
            await held.release;
          }
          if (!response.destroyed) {
            response.writeHead(result.statusCode, result.headers);
            response.end(Buffer.concat(chunks));
          }
        });
        result.on("error", () => response.destroy());
      },
    );
    upstream.on("error", () => {
      response.writeHead(502);
      response.end();
    });
    request.pipe(upstream);
  });
  await new Promise((resolveReady) =>
    relay.listen(3456, "127.0.0.1", resolveReady),
  );
  const cert = join(root, "localhost.crt"),
    key = join(root, "localhost.key");
  const certificate = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-keyout",
      key,
      "-out",
      cert,
    ],
    { stdio: "pipe" },
  );
  expect(certificate.status, "local HTTPS certificate").toBe(0);
  const build = spawnSync(
    process.execPath,
    [resolve("node_modules/vite/bin/vite.js"), "build"],
    { cwd: resolve("apps/web"), stdio: "pipe" },
  );
  expect(build.status, "production web build").toBe(0);
  webEnv = {
    ...process.env,
    TIMENOOK_WEB_TLS_CERT: cert,
    TIMENOOK_WEB_TLS_KEY: key,
    TIMENOOK_WEB_API_TARGET: "http://127.0.0.1:3456",
  };
  await startWebServer(false);
});
test.afterAll(async () => {
  server?.kill();
  if (relay) {
    relay.closeAllConnections();
    await new Promise((resolveClosed) => relay.close(resolveClosed));
  }
  await closePrivacyFixtureApplication(app);
  if (config) {
    const db = new PrismaClient({ datasourceUrl: config.databaseUrl });
    const redis = new Redis(config.redisUrl);
    try {
      await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      const keys = await redis.keys(`${schema}:*`);
      if (keys.length) await redis.del(...keys);
    } finally {
      await db.$disconnect();
      redis.disconnect();
    }
  }
  if (root) await rm(root, { recursive: true, force: true });
});

test("shared product session uses the real cookie without exposing a bearer credential", async ({
  page,
}) => {
  const account = await loginLink();
  await openLink(page, account.url);
  await page.getByRole("button", { name: "进入我的故事书" }).click();
  await expect(page.getByRole("heading", { name: "我的故事书" })).toBeVisible();
  const requests = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/v1/users/me")) requests.push(request);
  });
  const result = await page.evaluate(async () => {
    const { webApi } = await import("/app/src/api.ts");
    const { installCookieProductSession } =
      await import("/app/src/product-session.ts");
    const client = installCookieProductSession(await webApi.restore());
    return {
      user: await client.request("/users/me"),
      owner: client.context(),
      persisted: localStorage.length + sessionStorage.length,
    };
  });
  expect(result.user.id).toBe(account.userId);
  expect(result.owner.split(":")[0]).toBe(account.userId);
  expect(result.persisted).toBe(0);
  expect(requests).toHaveLength(1);
  expect(Boolean(requests[0].headers().authorization)).toBe(false);
  expect(requests[0].headers()["x-timenook-web"]).toBe("1");
});

test("shared pages restore and end the cookie session without calling native login", async ({
  page,
}) => {
  const account = await loginLink();
  await openLink(page, account.url);
  await page.getByRole("button", { name: "进入我的故事书" }).click();
  await expect(page.getByRole("heading", { name: "我的故事书" })).toBeVisible();
  const result = await page.evaluate(async () => {
    const { webApi } = await import("/app/src/api.ts");
    const { installCookieProductSession } =
      await import("/app/src/product-session.ts");
    const client = installCookieProductSession(await webApi.restore());
    const invalidated = [];
    client.onInvalidated((owner) => invalidated.push(owner));
    const user = await client.restore();
    await client.logout();
    return {
      user,
      owner: client.context(),
      restored: await client.restore(),
      invalidated,
    };
  });
  expect(result.user.id).toBe(account.userId);
  expect(result.owner).toBe("");
  expect(result.restored).toBeNull();
  expect(result.invalidated).toHaveLength(1);
  expect(result.invalidated[0].split(":")[0]).toBe(account.userId);
  expect(
    (await page.request.get(`${origin}/api/v1/web/session`)).status(),
  ).toBe(401);
});

test("an unconfirmed shared logout retains a retry without announcing completion", async ({
  page,
}) => {
  const link = await loginLink();
  await openLink(page, link.url);
  await page.getByRole("button", { name: "进入我的故事书" }).click();
  await expect(page.getByRole("heading", { name: "我的故事书" })).toBeVisible();
  await page.evaluate(async () => {
    const { webApi } = await import("/app/src/api.ts");
    const { installCookieProductSession } =
      await import("/app/src/product-session.ts");
    window.sharedClient = installCookieProductSession(await webApi.restore());
    window.invalidations = [];
    window.sharedClient.onInvalidated((owner) =>
      window.invalidations.push(owner),
    );
  });
  rejectLogout = true;
  try {
    const result = await page.evaluate(async () => {
      let status;
      try {
        await window.sharedClient.logout();
      } catch (error) {
        status = error.status;
      }
      return {
        status,
        owner: window.sharedClient.context(),
        pending: window.sharedClient.sessionCleanupPending(),
        completed: window.invalidations.length,
      };
    });
    expect(result).toEqual({
      status: 503,
      owner: "",
      pending: true,
      completed: 0,
    });
    expect(
      (await page.request.get(`${origin}/api/v1/web/session`)).status(),
    ).toBe(200);
    await page.evaluate(() => window.sharedClient.logout());
    expect(
      await page.evaluate(() => ({
        pending: window.sharedClient.sessionCleanupPending(),
        completed: window.invalidations.length,
      })),
    ).toEqual({ pending: false, completed: 1 });
    expect(
      (await page.request.get(`${origin}/api/v1/web/session`)).status(),
    ).toBe(401);
  } finally {
    rejectLogout = false;
  }
});

test("another tab changing accounts clears the shared page owner before another private request", async ({
  page,
  context,
}) => {
  const first = await loginLink(),
    second = await loginLink();
  await openLink(page, first.url);
  await page.getByRole("button", { name: "进入我的故事书" }).click();
  await expect(page.getByRole("heading", { name: "我的故事书" })).toBeVisible();
  await page.evaluate(async () => {
    const { webApi } = await import("/app/src/api.ts");
    const { installCookieProductSession } =
      await import("/app/src/product-session.ts");
    window.sharedClient = installCookieProductSession(await webApi.restore());
    window.invalidations = [];
    window.sharedClient.onInvalidated((owner) =>
      window.invalidations.push(owner),
    );
  });
  const other = await context.newPage();
  try {
    await openLink(other, second.url);
    await other.getByRole("button", { name: "进入我的故事书" }).click();
    await expect(
      other.getByRole("heading", { name: "我的故事书" }),
    ).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => window.sharedClient.context()))
      .toBe("");
    expect(await page.evaluate(() => window.invalidations.length)).toBe(1);
    const same = await other.evaluate(
      async (userId) =>
        (await (await fetch("/api/v1/web/session")).json()).data.user.id ===
        userId,
      second.userId,
    );
    expect(same).toBe(true);
  } finally {
    await other.close();
  }
});

test("another tab changing accounts removes the previous project list", async ({
  page,
  context,
}) => {
  const first = await cli("issue", { userId: projectAccount }),
    second = await loginLink();
  await openLink(page, first.url);
  await page.getByRole("button", { name: "进入我的故事书" }).click();
  await expect(
    page.getByRole("link", { name: "打开故事书", exact: true }),
  ).toBeVisible();
  const other = await context.newPage();
  try {
    await openLink(other, second.url);
    await other.getByRole("button", { name: "进入我的故事书" }).click();
    await expect(
      other.getByRole("heading", { name: "我的故事书" }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "打开故事书", exact: true }),
    ).toHaveCount(0);
    await expect(
      other.getByRole("heading", { name: "我的故事书" }),
    ).toBeVisible();
    expect(
      await other.evaluate(
        async (userId) =>
          (await (await fetch("/api/v1/web/session")).json()).data.user.id ===
          userId,
        second.userId,
      ),
    ).toBe(true);
  } finally {
    await other.close();
  }
});

test("leaving the shared page rejects a late private response while retaining the browser login", async ({
  page,
}) => {
  const link = await loginLink();
  await openLink(page, link.url);
  await page.getByRole("button", { name: "进入我的故事书" }).click();
  await expect(page.getByRole("heading", { name: "我的故事书" })).toBeVisible();
  await page.evaluate(async () => {
    const { webApi } = await import("/app/src/api.ts");
    const { installCookieProductSession } =
      await import("/app/src/product-session.ts");
    window.sharedClient = installCookieProductSession(await webApi.restore());
  });
  let release, started;
  const began = new Promise((resolve) => {
    started = resolve;
  });
  delayedPrivate = {
    started,
    release: new Promise((resolve) => {
      release = resolve;
    }),
  };
  try {
    await page.evaluate(() => {
      window.latePrivate = window.sharedClient.request("/users/me").then(
        () => ({ consumed: true }),
        () => ({ consumed: false }),
      );
    });
    await began;
    await page.evaluate(() => window.sharedClient.closeCookieSession());
    release();
    expect(await page.evaluate(() => window.latePrivate)).toEqual({
      consumed: false,
    });
    expect(await page.evaluate(() => window.sharedClient.context())).toBe("");
    expect(
      (await page.request.get(`${origin}/api/v1/web/session`)).status(),
    ).toBe(200);
  } finally {
    release?.();
    delayedPrivate = undefined;
  }
});

test.describe("production shared pages", () => {
  test.beforeAll(async () => {
    await stopWebServer();
    await startWebServer(true);
  });
  test.afterAll(async () => {
    await stopWebServer();
    await startWebServer(false);
  });
  test("a signed-in participant opens the shared project page and continues to the recording steps", async ({
    page,
  }) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width: 390, height: 844 });
    const link = await cli("issue", { userId: projectAccount });
    await openLink(page, link.url);
    await page.getByRole("button", { name: "进入我的故事书" }).click();
    await page.getByRole("link", { name: "打开故事书", exact: true }).click();
    await expect(page.locator(".live-project > .title")).toHaveText(
      "我的时光手记",
    );
    await page.reload();
    await expect(page.locator(".live-project > .title")).toHaveText(
      "我的时光手记",
    );
    await page
      .getByRole("button", { name: "开始一段讲述", exact: true })
      .click();
    await page
      .getByRole("button", { name: "就从这个问题开始", exact: true })
      .click();
    await expect(page.locator(".step-title")).toHaveText("准备开讲");
    await expect(
      page.getByRole("button", { name: "开始说", exact: true }),
    ).toBeVisible();
    await expect(page.locator("#preview-label")).toHaveCount(0);
    await expect(page).toHaveTitle(/岁月成书/);
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
    expect(
      await page
        .locator("#page img")
        .evaluateAll((images) =>
          images.every((image) => image.complete && image.naturalWidth > 0),
        ),
    ).toBe(true);
    await page.screenshot({
      path: "/Users/bryce/.codex/outputs/timenook-unified-web-2026-10-29/w02b-prepare-390.png",
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(
      page.getByRole("button", { name: "开始说", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: "/Users/bryce/.codex/outputs/timenook-unified-web-2026-10-29/w02b-prepare-desktop.png",
    });
    expect(errors).toEqual([]);
  });
});

test("shared recording submits its saved original through cookie and CSRF", async ({
  page,
}) => {
  const link = await cli("issue", { userId: projectAccount });
  await openLink(page, link.url);
  await page.getByRole("button", { name: "进入我的故事书" }).click();
  await page.getByRole("link", { name: "打开故事书", exact: true }).click();
  await expect(page.locator(".live-project > .title")).toBeVisible();
  const bytes = await readFile(
    resolve("apps/api/test/fixtures/synthetic-1s.mp3"),
  );
  await page.evaluate(
    async ({ source, mediaModule }) => {
      const { temporaryFile } = await import(mediaModule);
      const original = await (await fetch(source)).blob();
      const handlers = {};
      const emit = (name, value) => handlers[name]?.forEach((fn) => fn(value));
      window.wx.getRecorderManager = () => ({
        onStart: (fn) => (handlers.start ??= []).push(fn),
        onStop: (fn) => (handlers.stop ??= []).push(fn),
        onPause: (fn) => (handlers.pause ??= []).push(fn),
        onResume: (fn) => (handlers.resume ??= []).push(fn),
        onError: (fn) => (handlers.error ??= []).push(fn),
        onInterruptionBegin: (fn) => (handlers.interrupt ??= []).push(fn),
        start: () => emit("start"),
        pause: () => emit("pause"),
        resume: () => emit("resume"),
        stop: () =>
          emit("stop", {
            tempFilePath: temporaryFile(original),
            duration: 1080,
          }),
      });
    },
    {
      source: `data:audio/mpeg;base64,${bytes.toString("base64")}`,
      mediaModule: `/app/@fs${resolve("preview/media.ts")}`,
    },
  );
  await page.getByRole("button", { name: "开始一段讲述", exact: true }).click();
  const choose = page.getByRole("button", {
    name: "就从这个问题开始",
    exact: true,
  });
  await expect
    .poll(
      async () =>
        (await choose.isVisible()) ||
        (await page
          .getByRole("button", { name: "开始说", exact: true })
          .isVisible()) ||
        (await page
          .getByRole("button", { name: "再说一小段", exact: true })
          .isVisible()),
    )
    .toBe(true);
  if (await choose.isVisible()) await choose.click();
  await prepareRecordingStep(page);
  await page.getByRole("button", { name: "开始说", exact: true }).click();
  await page
    .getByRole("button", { name: "说完了，停止录音", exact: true })
    .click();
  await expect(page.locator(".step-title")).toHaveText(
    "听一听，再留下这段讲述",
  );
  await page.reload();
  await expect(page.locator(".step-title")).toHaveText(
    "听一听，再留下这段讲述",
  );
  await page.getByRole("button", { name: "提交这段讲述", exact: true }).click();
  await expect(
    page.getByText("已在测试环境保存，真实云端保存仍待验证", { exact: true }),
  ).toBeVisible();
  const downloaded = await page.evaluate(
    async ({ projectId, sessionModule }) => {
      const { sessionClient } = await import(sessionModule);
      const context = await sessionClient.request(
        `/projects/${projectId}/interviews`,
      );
      const interview = context.interviews.find((row) =>
        row.clips.some((clip) => clip.state === "sealed"),
      );
      const clip = interview.clips.find((row) => row.state === "sealed");
      const file = await sessionClient.downloadRecording(
        projectId,
        interview.id,
        clip.id,
      );
      const info = await new Promise((resolve, reject) =>
        window.wx.getFileSystemManager().getFileInfo({
          filePath: file.tempFilePath,
          digestAlgorithm: "sha256",
          success: resolve,
          fail: reject,
        }),
      );
      const mime = (await fetch(file.tempFilePath)).headers.get("content-type");
      await new Promise((resolve, reject) =>
        window.wx.getFileSystemManager().unlink({
          filePath: file.tempFilePath,
          success: resolve,
          fail: reject,
        }),
      );
      return { status: file.statusCode, ...info, mime };
    },
    {
      projectId,
      sessionModule: `/app/@fs${resolve("miniprogram/services/session.ts")}`,
    },
  );
  expect(downloaded.status).toBe(200);
  expect(downloaded.digest).toBe(
    createHash("sha256").update(bytes).digest("hex"),
  );
  expect(downloaded.size).toBe(bytes.length);
  expect(downloaded.mime).toBe("audio/mpeg");
});
