import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, webkit } from "@playwright/test";
const root = resolve(import.meta.dirname, "../..");
const requireApi = createRequire(join(root, "apps/api/package.json"));
const { PrismaClient } = requireApi("@prisma/client");
const Redis = requireApi("ioredis");
const { createApplication } = requireApi("./dist-test/src/application.js");
const { bootPrivacyFixture, closePrivacyFixture } = requireApi(
  "./dist-test/test/privacy-fixture.js",
);
const { createInternalProject } = requireApi(
  "./dist-test/src/projects/internal-project.js",
);
const { USER_TERMS_VERSION } = requireApi("@timenook/contracts");

for (const engine of [chromium, webkit])
  test(
    `${engine.name()}: built Vue entry uses SMS Cookies and the same real account/projects as the mini-program`,
    { timeout: 120000 },
    async () => {
      const schema = `browser_phone_${randomUUID().replaceAll("-", "")}`;
      const dbUrl = new URL(process.env.DATABASE_URL);
      assert.ok(["127.0.0.1", "localhost", "::1"].includes(dbUrl.hostname));
      assert.ok(
        ["127.0.0.1", "localhost", "::1"].includes(
          new URL(process.env.REDIS_URL).hostname,
        ),
      );
      dbUrl.searchParams.set("schema", schema);
      const dir = await mkdtemp(join(tmpdir(), "timenook-vue-browser-"));
      const origin = "https://127.0.0.1:4443";
      const config = {
        environment: "test",
        host: "127.0.0.1",
        port: 0,
        databaseUrl: dbUrl.toString(),
        redisUrl: process.env.REDIS_URL,
        redisKeyPrefix: schema,
        web: {
          origin,
          sessionKey: randomBytes(32).toString("base64"),
          loginTtlSeconds: 300,
          sessionTtlSeconds: 43200,
        },
        wechat: { appId: "isolated-browser-app", secret: "synthetic-secret" },
      };
      const sms = [];
      let reject = false;
      let app, server, browser, db;
      const runtimeErrors = [];
      const unblock = [];
      try {
        const migrated = spawnSync(
          process.execPath,
          ["node_modules/prisma/build/index.js", "migrate", "deploy"],
          {
            cwd: join(root, "apps/api"),
            env: { ...process.env, DATABASE_URL: config.databaseUrl },
            encoding: "utf8",
          },
        );
        assert.equal(migrated.status, 0, "isolated PostgreSQL schema");
        await bootPrivacyFixture(config);
        app = await createApplication(config, {
          smsSender: {
            async sendOtp(message) {
              if (reject) throw new Error("provider unavailable");
              sms.push(message);
            },
          },
          wechatFetch: async (input, options) => {
            const url = new URL(String(input));
            if (url.pathname === "/cgi-bin/stable_token")
              return Response.json({
                access_token: "isolated-access",
                expires_in: 7200,
              });
            if (url.pathname === "/wxa/business/getuserphonenumber")
              return Response.json({
                phone_info: {
                  phoneNumber: "13800009991",
                  purePhoneNumber: "13800009991",
                  countryCode: "86",
                  watermark: { appid: config.wechat.appId },
                },
              });
            return Response.json({
              openid: "browser-mini-user",
              session_key: "isolated-key",
            });
          },
        });
        const mini = await app.inject({
          method: "POST",
          url: "/v1/sessions/wechat",
          payload: {
            code: randomUUID(),
            phoneCode: randomUUID(),
            termsVersion: USER_TERMS_VERSION,
          },
        });
        assert.equal(mini.statusCode, 201, mini.body);
        const miniUser = mini.json().data;
        const project = await createInternalProject(
          {
            ...config,
            acceptance: {
              mode: "internal-acceptance",
              profileVersion: "internal-acceptance-v1",
            },
          },
          {
            provisionKey: `browser-${randomUUID()}`,
            initiatorUserId: miniUser.user.id,
            bookTitle: "同号项目 · 妈妈的故事",
          },
        );
        await app.listen(0, "127.0.0.1");
        const port = app.getHttpServer().address().port;
        const cert = join(dir, "cert.pem"),
          key = join(dir, "key.pem");
        const tls = spawnSync(
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
            "-keyout",
            key,
            "-out",
            cert,
          ],
          { stdio: "ignore" },
        );
        assert.equal(tls.status, 0);
        server = spawn(
          process.execPath,
          ["node_modules/vite/bin/vite.js", "preview", "--port", "4443"],
          {
            cwd: join(root, "apps/web"),
            env: {
              ...process.env,
              TIMENOOK_WEB_TLS_CERT: cert,
              TIMENOOK_WEB_TLS_KEY: key,
              TIMENOOK_WEB_API_TARGET: `http://127.0.0.1:${port}`,
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        await new Promise((resolveReady, rejectReady) => {
          const timeout = setTimeout(
            () => rejectReady(new Error("preview start timeout")),
            15000,
          );
          server.once("exit", (code) => {
            clearTimeout(timeout);
            rejectReady(new Error(`preview exited ${code}`));
          });
          server.stdout.on("data", (data) => {
            if (String(data).includes("4443")) {
              clearTimeout(timeout);
              resolveReady();
            }
          });
        });
        browser = await engine.launch({ headless: true });
        const context = await browser.newContext({
          ignoreHTTPSErrors: true,
          viewport: { width: 390, height: 844 },
        });
        const page = await context.newPage();
        page.setDefaultTimeout(10000);
        page.setDefaultNavigationTimeout(10000);
        page.on("pageerror", (error) => runtimeErrors.push(error.message));
        await page.goto(`${origin}/app/?state=member`);
        await page.getByRole("heading", { name: /有些故事/ }).waitFor();
        assert.equal(
          await page.getByText("状态预览", { exact: true }).count(),
          0,
        );
        assert.equal(
          await page
            .getByText("同号项目 · 妈妈的故事", { exact: true })
            .count(),
          0,
        );
        await page.getByRole("link", { name: "先看看样书" }).click();
        await page.getByRole("heading", { name: "院子里的那棵枣树" }).waitFor();
        await page.getByRole("link", { name: "返回首页" }).click();
        await page.getByRole("button", { name: "登录 / 注册" }).click();
        const dialog = page.getByRole("dialog");
        await dialog.waitFor();
        assert.equal(await dialog.getByRole("checkbox").isChecked(), false);
        await dialog.getByLabel("手机号", { exact: true }).fill("13800009991");
        await dialog.getByRole("button", { name: "获取验证码" }).click();
        await dialog
          .getByRole("alert")
          .filter({ hasText: "请先阅读并同意" })
          .waitFor();
        assert.equal(sms.length, 0);
        await dialog.getByRole("checkbox").check();
        await dialog.getByRole("button", { name: "获取验证码" }).click();
        await dialog
          .getByRole("status")
          .filter({ hasText: "验证码已发送" })
          .waitFor();
        assert.equal(sms.length, 1);
        assert.equal(sms[0].phone, "+8613800009991");
        await dialog
          .getByLabel("短信验证码", { exact: true })
          .fill(sms[0].code);
        await dialog.getByRole("button", { name: "登录并继续" }).click();
        await page
          .getByRole("heading", { name: "同号项目 · 妈妈的故事", exact: true })
          .first()
          .waitFor();
        assert.equal(
          await page.getByText("受邀参与", { exact: true }).count(),
          0,
        );
        const session = await page.evaluate(
          async () => (await (await fetch("/api/v1/web/session")).json()).data,
        );
        assert.equal(session.user.id, miniUser.user.id);
        const cookie = (await context.cookies()).find(
          (cookie) => cookie.name === "__Secure-timenook_web",
        );
        assert.equal(cookie.httpOnly, true);
        assert.equal(cookie.secure, true);
        assert.equal(cookie.path, "/api/v1");
        await page.reload();
        await page
          .getByRole("heading", { name: "同号项目 · 妈妈的故事", exact: true })
          .first()
          .waitFor();
        await mkdir(join(root, ".playwright-mcp"), { recursive: true });
        await page.screenshot({
          path: join(root, ".playwright-mcp/web-mvp-projects.png"),
          fullPage: true,
        });
        // Delay an actual old-account restoration response across a tab switch.
        let releaseOld;
        let restorationReady;
        let heldRequest;
        let gets = 0;
        const held = new Promise((resolve) => {
          releaseOld = resolve;
          unblock.push(resolve);
        });
        const ready = new Promise((resolve) => {
          restorationReady = resolve;
        });
        await page.route("**/api/v1/web/session", async (route) => {
          const response = await route.fetch();
          if (route.request().method() === "GET" && ++gets === 2) {
            heldRequest = route.request();
            restorationReady();
            await held;
          }
          await route.fulfill({ response }).catch(() => {});
        });
        await page.reload();
        await ready;
        const other = await context.newPage();
        other.setDefaultTimeout(10000);
        await other.goto(`${origin}/app/account`);
        await other
          .getByRole("button", { name: "退出登录", exact: true })
          .click();
        await page.getByRole("dialog").waitFor();
        assert.equal(
          await page
            .getByText("同号项目 · 妈妈的故事", { exact: true })
            .count(),
          0,
        );
        const privateResult = await context.request.get(
          `${origin}/api/v1/participations`,
        );
        assert.equal(privateResult.status(), 401);
        await other.getByRole("button", { name: "登录 / 注册" }).click();
        await other.getByLabel("手机号", { exact: true }).fill("13800009993");
        await other.getByRole("checkbox").check();
        await other.getByRole("button", { name: "获取验证码" }).click();
        await other
          .getByRole("status")
          .filter({ hasText: "验证码已发送" })
          .waitFor();
        await other
          .getByLabel("短信验证码", { exact: true })
          .fill(sms.at(-1).code);
        await other.getByRole("button", { name: "登录并继续" }).click();
        await other
          .getByRole("heading", { name: "第一本故事书，从这里开始。" })
          .waitFor();
        await page.getByRole("button", { name: "关闭登录" }).click();
        await page
          .getByRole("heading", { name: "第一本故事书，从这里开始。" })
          .waitFor();
        const oldResponse = page.waitForResponse(
          (response) => response.request() === heldRequest,
        );
        releaseOld();
        await (await oldResponse).finished();
        await page.evaluate(() => Promise.resolve());
        assert.equal(
          await page.getByRole("dialog").count(),
          0,
          "an old restoration must not clear the new account",
        );
        assert.equal(
          await page
            .getByText("同号项目 · 妈妈的故事", { exact: true })
            .count(),
          0,
        );
        await other.goto(`${origin}/app/account`);
        // A notification queued during logout may restore the still-valid old
        // Cookie before the DELETE reaches the API. Deliver it after revocation.
        let releaseDelete, releaseRestore, markDelete, markRestore;
        let deleting = false,
          heldRestoreRequest;
        const deleteHeld = new Promise((resolve) => {
          releaseDelete = resolve;
          unblock.push(resolve);
        });
        const restoreHeld = new Promise((resolve) => {
          releaseRestore = resolve;
          unblock.push(resolve);
        });
        const deleteReady = new Promise((resolve) => {
          markDelete = resolve;
        });
        const restoreReady = new Promise((resolve) => {
          markRestore = resolve;
        });
        await other.route("**/api/v1/web/session", async (route) => {
          if (route.request().method() === "DELETE") {
            deleting = true;
            markDelete();
            await deleteHeld;
            await route.continue();
            return;
          }
          const response = await route.fetch();
          if (deleting && !heldRestoreRequest) {
            heldRestoreRequest = route.request();
            markRestore();
            await restoreHeld;
          }
          await route.fulfill({ response }).catch(() => {});
        });
        await other
          .getByRole("button", { name: "退出登录", exact: true })
          .click();
        await Promise.race([
          deleteReady,
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("logout DELETE not started")),
              8000,
            ),
          ),
        ]);
        await page.evaluate(() => {
          const channel = new BroadcastChannel("timenook-web-session");
          channel.postMessage("changed");
          channel.close();
        });
        await Promise.race([
          restoreReady,
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("queued restoration not started")),
              8000,
            ),
          ),
        ]);
        let markLogoutComplete;
        const logoutComplete = new Promise((resolve) => {
          markLogoutComplete = resolve;
        });
        await page.exposeFunction("observeLogoutCompletion", () =>
          markLogoutComplete(),
        );
        await page.evaluate(() => {
          const channel = new BroadcastChannel("timenook-web-session");
          channel.onmessage = () => {
            channel.close();
            window.observeLogoutCompletion();
          };
        });
        const deleted = other.waitForResponse(
          (response) =>
            response.request().method() === "DELETE" &&
            response.url().endsWith("/web/session"),
        );
        releaseDelete();
        assert.equal((await deleted).status(), 204);
        await logoutComplete;
        const lateRestore = other.waitForResponse(
          (response) => response.request() === heldRestoreRequest,
        );
        releaseRestore();
        await (await lateRestore).json();
        await other.evaluate(
          () =>
            new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            ),
        );
        assert.equal(
          await other
            .getByRole("button", { name: "手机号登录", exact: true })
            .count(),
          1,
          "logout must invalidate restorations started during revocation",
        );
        await page.getByRole("dialog").waitFor();
        await page.getByRole("button", { name: "关闭登录" }).click();
        for (const width of [320, 390, 768, 1440]) {
          await page.setViewportSize({ width, height: 900 });
          await page.goto(`${origin}/app/`);
          await page.getByRole("heading", { name: /有些故事/ }).waitFor();
          assert.equal(
            await page.evaluate(
              () => document.documentElement.scrollWidth > innerWidth,
            ),
            false,
            `no overflow at ${width}`,
          );
        }
        await page.screenshot({
          path: join(root, ".playwright-mcp/web-mvp-home-desktop.png"),
          fullPage: true,
        });
        await page.setViewportSize({ width: 320, height: 568 });
        await page.getByRole("button", { name: "登录 / 注册" }).click();
        await page.getByLabel("手机号", { exact: true }).fill("13800009992");
        await page.getByRole("checkbox").check();
        reject = true;
        await page.getByRole("button", { name: "获取验证码" }).click();
        await page
          .getByRole("alert")
          .filter({ hasText: "服务暂不可用" })
          .waitFor();
        assert.equal(
          await page
            .getByText("验证码已发送，5 分钟内有效。", { exact: true })
            .count(),
          0,
        );
        await page.screenshot({
          path: join(root, ".playwright-mcp/web-mvp-login-mobile.png"),
        });
        assert.deepEqual(runtimeErrors, []);
        console.log(
          "Verified public home/sample, SMS delivery boundary, real Cookie login, same mini-program account/project, reload, cross-tab logout, provider failure and 320–1440px layouts.",
        );
      } finally {
        for (const resume of unblock) resume();
        await browser?.close();
        if (server) {
          server.kill("SIGTERM");
          await new Promise((resolveExit) => {
            if (server.exitCode !== null) resolveExit();
            else server.once("exit", resolveExit);
          });
        }
        await app?.close();
        db = new PrismaClient({ datasourceUrl: config.databaseUrl });
        const redis = new Redis(config.redisUrl);
        try {
          await db.$executeRawUnsafe(
            `DROP SCHEMA IF EXISTS "${schema}" CASCADE`,
          );
          const keys = await redis.keys(`${schema}:*`);
          if (keys.length) await redis.del(...keys);
        } finally {
          await db.$disconnect();
          redis.disconnect();
          await closePrivacyFixture(config);
          await rm(dir, { recursive: true, force: true });
        }
      }
    },
  );
