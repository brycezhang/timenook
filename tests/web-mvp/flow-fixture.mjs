import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const root = resolve(import.meta.dirname, "../..");
const apiRequire = createRequire(join(root, "apps/api/package.json"));
export const books = apiRequire("./dist-test/test/book-fixture.js");
const { verifiedPhone } = apiRequire(
  "./dist-test/test/wechat-profile-fixture.js",
);
const { startProductionWorker } = apiRequire("./dist-test/src/tasks/worker.js");

export async function storyBrowser(engine) {
  for (const key of ["DATABASE_URL", "REDIS_URL"])
    assert.ok(
      ["localhost", "127.0.0.1", "::1"].includes(
        new URL(process.env[key]).hostname,
      ),
    );
  const previousCwd = process.cwd();
  process.chdir(join(root, "apps/api"));
  const dir = await mkdtemp(join(tmpdir(), "timenook-flow-browser-"));
  const origin = "https://127.0.0.1:4444";
  const messages = [],
    errors = [];
  let server,
    browser,
    worker,
    runningTask = false;
  let timer;
  async function close() {
    clearInterval(timer);
    await browser?.close();
    if (server && server.exitCode === null) {
      const stopped = new Promise((done) => server.once("exit", done));
      server.kill("SIGTERM");
      await stopped;
    }
    while (runningTask) await new Promise((done) => setTimeout(done, 20));
    await worker?.close();
    await books.stopBookFixture();
    await rm(dir, { force: true, recursive: true });
    process.chdir(previousCwd);
  }
  try {
    await books.startBookFixture();
    await books.enableBookBrowser(origin, {
      async sendOtp(message) {
        messages.push(message);
      },
    });
    await books.app.listen(0, "127.0.0.1");
    const port = books.app.getHttpServer().address().port;
    const key = join(dir, "key.pem"),
      cert = join(dir, "cert.pem");
    assert.equal(
      spawnSync(
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
      ).status,
      0,
    );
    server = spawn(
      process.execPath,
      ["node_modules/vite/bin/vite.js", "preview", "--port", "4444"],
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
    await new Promise((done, fail) => {
      const timeout = setTimeout(
        () => fail(Error("preview start timeout")),
        15000,
      );
      server.once("exit", () => {
        clearTimeout(timeout);
        fail(Error("preview exited"));
      });
      server.stdout.on("data", (data) => {
        if (String(data).includes("4444")) {
          clearTimeout(timeout);
          done();
        }
      });
    });
    browser = await engine.launch({ headless: true });
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 390, height: 844 },
    });
    context.on("page", (page) =>
      page.on("pageerror", (error) => errors.push(error.message)),
    );
    worker = await startProductionWorker(books.app);
    timer = setInterval(async () => {
      if (runningTask) return;
      runningTask = true;
      try {
        await worker.recoverDue();
      } catch (error) {
        errors.push(`worker: ${error.message}`);
      } finally {
        runningTask = false;
      }
    }, 250);
    await mkdir(join(root, "output/playwright"), { recursive: true });
    return {
      context,
      origin,
      close,
      errors,
      messages,
      phoneFor(user) {
        return verifiedPhone(books.config.wechat.appId, user.who);
      },
      async signIn(page, phone) {
        await page.getByLabel("手机号", { exact: true }).fill(phone);
        await page.getByRole("checkbox").check();
        await page
          .getByRole("button", { name: "获取验证码", exact: true })
          .click();
        await page
          .getByRole("status")
          .filter({ hasText: "验证码已发送" })
          .waitFor();
        await page
          .getByLabel("短信验证码", { exact: true })
          .fill(messages.at(-1).code);
        await page
          .getByRole("button", { name: "登录并继续", exact: true })
          .click();
        await page.getByRole("dialog").waitFor({ state: "hidden" });
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
