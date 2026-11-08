import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, webkit, expect } from "@playwright/test";
const root = resolve(import.meta.dirname, "../..");
const requireApi = createRequire(join(root, "apps/api/package.json"));
const { PrismaClient } = requireApi("@prisma/client");
const Redis = requireApi("ioredis");
const { createApplication } = requireApi("./dist-test/src/application.js");
const { startProductionWorker } = requireApi("./dist-test/src/tasks/worker.js");
const { LocalProbeObjects } = requireApi(
  "./dist-test/src/probe/local-objects.js",
);
const { bootPrivacyFixture, closePrivacyFixture } = requireApi(
  "./dist-test/test/privacy-fixture.js",
);
const { createInternalProject } = requireApi(
  "./dist-test/src/projects/internal-project.js",
);
const { paymentConfig, paymentFetch } = requireApi(
  "./dist-test/test/payment-fixture.js",
);

for (const engine of [chromium, webkit])
  test(
    `${engine.name()}: Vue recording saves real MP3, recovers an interrupted upload and follows real transcription/story tasks`,
    { timeout: 120000 },
    async () => {
      const schema = `browser_recording_${randomUUID().replaceAll("-", "")}`;
      const dbUrl = new URL(process.env.DATABASE_URL);
      for (const url of [dbUrl, new URL(process.env.REDIS_URL)])
        assert.ok(["127.0.0.1", "localhost", "::1"].includes(url.hostname));
      dbUrl.searchParams.set("schema", schema);
      const dir = await mkdtemp(join(tmpdir(), "timenook-vue-recording-"));
      const origin = "https://127.0.0.1:4446";
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
        participation: { mode: "synthetic-d08" },
        payments: paymentConfig,
        wechat: { appId: "synthetic-timenook", secret: "synthetic-secret" },
        recording: {
          mode: "synthetic-local",
          storageRoot: join(dir, "objects"),
        },
        transcription: {
          mode: "synthetic-local",
          configVersion: "synthetic-t15-v1",
          doubao: {
            apiKey: "synthetic-key",
            resourceId: "synthetic-resource",
            fetchWindowSeconds: 60,
          },
          pollIntervalMs: 0,
          submissionReservationFen: 1,
          deadlineMs: 60000,
        },
        generation: {
          mode: "synthetic-local",
          configVersion: "synthetic-t18-v1",
          deepseek: {
            apiKey: "synthetic-key",
            model: "synthetic-story",
            maxTokens: 3000,
          },
          submissionReservationFen: 1,
          maxSubmissions: 100,
          deadlineMs: 60000,
        },
      };
      class Objects extends LocalProbeObjects {
        async asrSource(key) {
          return {
            url: `https://synthetic.oss-cn-shanghai.aliyuncs.com/${key}`,
            expiresAt: new Date(Date.now() + 120000).toISOString(),
            credentialsExpireAt: new Date(Date.now() + 180000).toISOString(),
          };
        }
      }
      const sms = [],
        errors = [];
      let app, worker, scheduler, server, browser;
      let failTranscript = true;
      try {
        const migrated = spawnSync(
          process.execPath,
          ["node_modules/prisma/build/index.js", "migrate", "deploy"],
          {
            cwd: join(root, "apps/api"),
            env: {
              ...process.env,
              DATABASE_URL: config.databaseUrl,
              PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK: "1",
            },
            encoding: "utf8",
          },
        );
        assert.equal(migrated.status, 0, migrated.stderr);
        await bootPrivacyFixture(config);
        app = await createApplication(config, {
          paymentFetch,
          smsSender: {
            async sendOtp(message) {
              sms.push(message);
            },
          },
          recordingObjects: new Objects(config.recording.storageRoot),
          aiFetch: async (input, init) => {
            if (String(input).includes("deepseek.com")) {
              const source = JSON.parse(
                JSON.parse(init.body).messages[1].content,
              );
              return Response.json({
                model: "synthetic-story",
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
                        title: "河边的童年",
                        theme: "童年",
                        paragraphs: [
                          {
                            text: "我在河边长大。",
                            sourceRefs: source.sourceRefs,
                          },
                        ],
                        reviewItems: [],
                      }),
                    },
                  },
                ],
              });
            }
            if (String(input).endsWith("/query") && failTranscript)
              return new Response("", {
                headers: { "X-Api-Status-Code": "45000132" },
              });
            return new Response(
              String(input).endsWith("/submit")
                ? "{}"
                : JSON.stringify({
                    task_id: new Headers(init.headers).get("X-Api-Request-Id"),
                    result: { text: "我在河边长大。" },
                  }),
              { headers: { "X-Api-Status-Code": "20000000" } },
            );
          },
        });
        await app.listen(0, "127.0.0.1");
        worker = await startProductionWorker(app);
        let scheduling = false;
        scheduler = setInterval(async () => {
          if (scheduling) return;
          scheduling = true;
          try {
            await worker.recoverDue();
          } catch (error) {
            errors.push(error.message);
          } finally {
            scheduling = false;
          }
        }, 100);
        const cert = join(dir, "cert.pem"),
          key = join(dir, "key.pem");
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
          ["node_modules/vite/bin/vite.js", "preview", "--port", "4446"],
          {
            cwd: join(root, "apps/web"),
            env: {
              ...process.env,
              TIMENOOK_WEB_TLS_CERT: cert,
              TIMENOOK_WEB_TLS_KEY: key,
              TIMENOOK_WEB_API_TARGET: `http://127.0.0.1:${app.getHttpServer().address().port}`,
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        await new Promise((resolveReady, reject) => {
          const timer = setTimeout(
            () => reject(Error("preview start timeout")),
            15000,
          );
          server.once("exit", (code) => {
            clearTimeout(timer);
            reject(Error(`preview exited ${code}`));
          });
          server.stdout.on("data", (data) => {
            if (String(data).includes("4446")) {
              clearTimeout(timer);
              resolveReady();
            }
          });
        });
        browser = await engine.launch({
          headless: true,
          args:
            engine === chromium
              ? [
                  "--use-fake-device-for-media-stream",
                  "--use-fake-ui-for-media-stream",
                  "--autoplay-policy=no-user-gesture-required",
                ]
              : [],
        });
        const context = await browser.newContext({
          ignoreHTTPSErrors: true,
          ...(engine === chromium ? { permissions: ["microphone"] } : {}),
          viewport: { width: 390, height: 844 },
        });
        if (engine === webkit)
          await context.addInitScript(() => {
            navigator.mediaDevices.getUserMedia = async () => {
              const input = new AudioContext();
              const oscillator = input.createOscillator();
              const output = input.createMediaStreamDestination();
              oscillator.frequency.value = 440;
              oscillator.connect(output);
              oscillator.start();
              await input.resume();
              for (const track of output.stream.getTracks()) {
                const stop = track.stop.bind(track);
                track.stop = () => {
                  stop();
                  oscillator.stop();
                  void input.close();
                };
              }
              return output.stream;
            };
          });
        const page = await context.newPage();
        page.setDefaultTimeout(10000);
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${origin}/app/`);
        await page.getByRole("button", { name: "登录 / 注册" }).click();
        await page.getByLabel("手机号", { exact: true }).fill("13800008884");
        await page.getByRole("checkbox").check();
        await page.getByRole("button", { name: "获取验证码" }).click();
        await expect(page.getByRole("status")).toContainText("验证码已发送");
        await page
          .getByLabel("短信验证码", { exact: true })
          .fill(sms.at(-1).code);
        await page.getByRole("button", { name: "登录并继续" }).click();
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await page
          .getByRole("heading", { name: "第一本故事书，从这里开始。" })
          .waitFor();
        const session = await page.evaluate(
          async () => (await (await fetch("/api/v1/web/session")).json()).data,
        );
        const project = await createInternalProject(
          {
            ...config,
            payments: undefined,
            acceptance: {
              mode: "internal-acceptance",
              profileVersion: "internal-acceptance-v1",
            },
          },
          {
            provisionKey: `recording-${randomUUID()}`,
            initiatorUserId: session.user.id,
            bookTitle: "录音合成验收项目",
          },
        );
        await page.goto(`${origin}/app/projects/${project.projectId}/record`);
        await page.getByRole("heading", { name: "从一个话题开始" }).waitFor();
        await page.getByRole("button", { name: "自己写一个话题" }).click();
        await page.getByLabel("想讲的话题").fill("小时候，您常在河边做什么？");
        await page
          .getByRole("button", { name: "开始录音", exact: true })
          .click();
        await page
          .getByRole("button", { name: "暂停录音", exact: true })
          .waitFor();
        await page.waitForTimeout(1300);
        await page
          .getByRole("button", { name: "暂停录音", exact: true })
          .click();
        await expect(
          page.getByRole("status").filter({ hasText: "已暂停" }),
        ).toBeVisible();
        await page
          .getByRole("button", { name: "继续录音", exact: true })
          .click();
        await page
          .getByRole("button", { name: "暂停录音", exact: true })
          .waitFor();
        await page.waitForTimeout(1300);
        let uploadedBytes = 0;
        await page.route("**/api/v1/recordings/objects", async (route) => {
          uploadedBytes = route.request().postDataBuffer().length;
          await route.abort("connectionreset");
        });
        await page
          .getByRole("button", { name: "结束录音", exact: true })
          .click();
        await page
          .getByRole("button", { name: "重试上传", exact: true })
          .waitFor();
        // WebKit's protocol omits binary file data from postDataBuffer().
        assert.ok(
          uploadedBytes > 0,
          "the interrupted upload reached the network",
        );
        const interviewId = new URL(page.url()).searchParams.get("interviewId");
        assert.ok(interviewId);
        await page.reload();
        await page
          .getByRole("button", { name: "重试上传", exact: true })
          .waitFor();
        await page.unroute("**/api/v1/recordings/objects");
        const secondProject = await createInternalProject(
          {
            ...config,
            payments: undefined,
            acceptance: {
              mode: "internal-acceptance",
              profileVersion: "internal-acceptance-v1",
            },
          },
          {
            provisionKey: `other-recording-${randomUUID()}`,
            initiatorUserId: session.user.id,
            bookTitle: "另一本合成验收项目",
          },
        );
        await page.goto(
          `${origin}/app/projects/${secondProject.projectId}/record`,
        );
        await page.getByRole("heading", { name: "从一个话题开始" }).waitFor();
        assert.equal(
          await page.getByRole("heading", { name: "还有录音等待上传" }).count(),
          0,
          "another project does not inherit local pending audio",
        );
        await page.goto(
          `${origin}/app/projects/${project.projectId}/record?interviewId=${interviewId}`,
        );
        await page
          .getByRole("button", { name: "重试上传", exact: true })
          .waitFor();
        await page
          .getByRole("button", { name: "重试上传", exact: true })
          .click();
        await page
          .getByRole("button", { name: "重试文字处理", exact: true })
          .waitFor();
        failTranscript = false;
        await page
          .getByRole("button", { name: "重试文字处理", exact: true })
          .click();
        await page
          .getByRole("heading", { name: "故事已整理好" })
          .waitFor({ timeout: 30000 })
          .catch(async (reason) => {
            console.log(await page.locator("main").innerText(), errors);
            throw reason;
          });
        await page
          .getByRole("button", { name: "回听原声", exact: true })
          .click();
        const audio = page.locator("audio");
        await expect
          .poll(() => audio.evaluate((node) => node.duration))
          .toBeGreaterThan(2);
        await audio.evaluate((node) => node.play());
        await expect
          .poll(() => audio.evaluate((node) => node.currentTime))
          .toBeGreaterThan(0);
        const facts = await page.evaluate(
          async ({ projectId, interviewId, csrf }) => {
            const headers = {
              "X-Timenook-Web": "1",
              "X-CSRF-Token": csrf,
              "Content-Type": "application/json",
              "Idempotency-Key": crypto.randomUUID(),
            };
            const context = (
              await (
                await fetch(`/api/v1/projects/${projectId}/stories/context`, {
                  method: "POST",
                  headers,
                  body: JSON.stringify({ interviewId }),
                })
              ).json()
            ).data;
            if (context.story)
              context.story = (
                await (
                  await fetch(
                    `/api/v1/projects/${projectId}/stories/${context.story.id}`,
                    { headers: { "X-Timenook-Web": "1" } },
                  )
                ).json()
              ).data;
            return context;
          },
          {
            projectId: project.projectId,
            interviewId,
            csrf: session.csrfToken,
          },
        );
        assert.equal(facts.clipCount, 1);
        assert.equal(facts.pendingCount, 0);
        assert.equal(facts.story.revision.title, "河边的童年");
        for (const width of [320, 1440]) {
          await page.setViewportSize({ width, height: 800 });
          assert.equal(
            await page.evaluate(
              () => document.documentElement.scrollWidth > innerWidth,
            ),
            false,
          );
        }
        await mkdir(join(root, "test-results/web-recording"), {
          recursive: true,
        });
        await page.screenshot({
          path: join(
            root,
            `test-results/web-recording/ready-${engine.name()}.png`,
          ),
          fullPage: true,
        });
        await page.goto(`${origin}/app/projects/${project.projectId}/record`);
        await page.getByRole("heading", { name: "从一个话题开始" }).waitFor();
        assert.equal(
          await page.getByRole("heading", { name: "故事已整理好" }).count(),
          0,
          "a new story never silently resumes an earlier interview",
        );
        await page.evaluate(() => {
          navigator.mediaDevices.getUserMedia = async () => {
            throw new DOMException("麦克风权限被拒绝", "NotAllowedError");
          };
        });
        await page
          .getByRole("button", { name: "开始录音", exact: true })
          .click();
        await expect(page.getByRole("alert")).toContainText("麦克风权限被拒绝");
        assert.equal(
          await page
            .getByRole("button", { name: "暂停录音", exact: true })
            .count(),
          0,
        );
        assert.equal(
          await page
            .getByRole("button", { name: "回听原声", exact: true })
            .count(),
          0,
        );
        assert.equal(
          await page.getByRole("heading", { name: "故事已整理好" }).count(),
          0,
        );
        await page.goto(
          `${origin}/app/projects/${project.projectId}/record?interviewId=${interviewId}`,
        );
        await page
          .getByRole("button", { name: "回听原声", exact: true })
          .click();
        await expect
          .poll(() => page.locator("audio").evaluate((node) => node.duration))
          .toBeGreaterThan(2);
        const other = await context.newPage();
        await other.goto(`${origin}/app/account`);
        await other
          .getByRole("button", { name: "退出登录", exact: true })
          .click();
        await page.getByRole("dialog").waitFor();
        assert.equal(await page.locator("audio").count(), 0);
        assert.equal(
          await page
            .getByText("小时候，您常在河边做什么？", { exact: true })
            .count(),
          0,
        );
        assert.deepEqual(errors, []);
      } finally {
        clearInterval(scheduler);
        await browser?.close();
        if (server) {
          server.kill("SIGTERM");
          if (server.exitCode === null)
            await new Promise((done) => server.once("exit", done));
        }
        await worker?.close();
        await app?.close();
        const db = new PrismaClient({ datasourceUrl: config.databaseUrl });
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
