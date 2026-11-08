import { fixtureWebSession } from "./web-session-fixture";
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { after, before, test } from "node:test";
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import {
  createAdminApplication,
  syntheticFeishu,
} from "./admin-feishu-fixture";
import { paymentAdmin } from "./payment-admin-fixture";
import { createApplication } from "../src/application";
import { readConfig, type ApiConfig } from "../src/config";
import { createInternalProject } from "../src/projects/internal-project";
import { provisionWebAccount } from "../src/web/web-provisioning";
import { LocalProbeObjects } from "../src/probe/local-objects";
import { ProductionTasks } from "../src/tasks/tasks";
import { startProductionWorker } from "../src/tasks/worker";
import { waitForWorkerJobs } from "./worker-completion";
import { bootPrivacyFixture, closePrivacyFixture } from "./privacy-fixture";
const schema = `internal_media_${randomUUID().replaceAll("-", "")}`,
  origin = "https://localhost:3447";
let root: string,
  config: ApiConfig,
  db: PrismaClient,
  app: Awaited<ReturnType<typeof createApplication>>,
  objects: Objects;
const sent: { kind: string; value: unknown }[] = [];
class Objects extends LocalProbeObjects {
  async uploadForm(key: string, _bytes: number, expiresAt: Date) {
    return {
      storage: "oss" as const,
      url: "https://timenook.oss-cn-shanghai.aliyuncs.com",
      expiresAt: expiresAt.toISOString(),
      fields: { key },
    };
  }
  async asrSource(key: string, seconds: number) {
    return {
      url: `https://timenook.oss-cn-shanghai.aliyuncs.com/timenook/product/internal/${key}?controlled-source`,
      expiresAt: new Date(Date.now() + (seconds + 5) * 1000).toISOString(),
      credentialMode: "static" as const,
      credentialsExpireAt: null,
    };
  }
}
const aiFetch: typeof fetch = async (url, init) => {
  if (String(url).includes("/chat/completions")) {
    const body = JSON.parse(String(init?.body)),
      input = JSON.parse(body.messages[1].content);
    sent.push({ kind: "story", value: input });
    return new Response(
      JSON.stringify({
        model: "deepseek-flash",
        usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 },
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: JSON.stringify({
                title: "我记得的童年",
                theme: "家乡",
                paragraphs: [
                  {
                    text: "小时候，我在村口的大树下和同伴玩耍。",
                    sourceRefs: input.sourceRefs,
                  },
                ],
                reviewItems: [],
              }),
            },
          },
        ],
      }),
    );
  }
  const id = new Headers(init?.headers).get("X-Api-Request-Id")!,
    action = String(url).endsWith("/submit") ? "submit" : "query";
  sent.push({ kind: action, value: JSON.parse(String(init?.body)) });
  return new Response(
    action === "submit"
      ? "{}"
      : JSON.stringify({
          task_id: id,
          result: { text: "小时候，我在村口的大树下和同伴玩耍。" },
        }),
    { headers: { "X-Api-Status-Code": "20000000" } },
  );
};
before(async () => {
  const database = new URL(process.env.DATABASE_URL!);
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(database.hostname));
  database.searchParams.set("schema", schema);
  root = await mkdtemp(join(tmpdir(), "timenook-internal-media-"));
  config = readConfig({
    ...process.env,
    NODE_ENV: "development",
    DATABASE_URL: database.toString(),
    REDIS_KEY_PREFIX: schema,
    INTERNAL_ACCEPTANCE_ENABLED: "1",
    WEB_ORIGIN: origin,
    WEB_SESSION_KEY: randomBytes(32).toString("base64"),
    TIMENOOK_PRODUCT_STORAGE_ROOT: root,
    TIMENOOK_PRODUCT_OSS_BUCKET: "timenook",
    TIMENOOK_PRODUCT_OSS_REGION: "cn-shanghai",
    TIMENOOK_PRODUCT_OSS_KEY_PREFIX: "timenook/product/internal",
    TIMENOOK_PRODUCT_OSS_ACCESS_KEY_ID: "controlled-id",
    TIMENOOK_PRODUCT_OSS_ACCESS_KEY_SECRET: "controlled-secret",
    TIMENOOK_PRODUCT_DOUBAO_API_KEY: "controlled-asr",
    TIMENOOK_PRODUCT_DOUBAO_RESOURCE_ID: "volc.seedasr.auc",
    TIMENOOK_PRODUCT_DEEPSEEK_API_KEY: "controlled-text",
    TIMENOOK_PRODUCT_DEEPSEEK_BASE_URL: "https://cf.api.fan/v1",
    TIMENOOK_PRODUCT_DEEPSEEK_MODEL: "deepseek-flash",
  });
  config.admin = {
    origin,
    sessionKey: randomBytes(32).toString("base64"),
    sessionTtlSeconds: 28800,
    challengeTtlSeconds: 300,
    feishu: { ...syntheticFeishu },
  };
  const migrated = spawnSync(
    process.execPath,
    ["node_modules/prisma/build/index.js", "migrate", "deploy"],
    {
      env: { ...process.env, DATABASE_URL: config.databaseUrl },
      encoding: "utf8",
    },
  );
  assert.equal(migrated.status, 0, "isolated migrations");
  await bootPrivacyFixture(config);
  // Non-test composition must boot with native adapters before replacing only the two external boundaries.
  const realComposition = await createApplication(config);
  assert.equal(
    (
      await realComposition.inject({
        method: "GET",
        url: `/v1/projects/${randomUUID()}/exports`,
      })
    ).statusCode,
    401,
    "controlled internal export route is assembled",
  );
  assert.equal(
    (
      await realComposition.inject({
        method: "GET",
        url: "/v1/admin/fulfillment",
      })
    ).statusCode,
    401,
    "controlled internal admin fulfillment route is assembled",
  );
  assert.equal(
    (
      await realComposition.inject({
        method: "GET",
        url: `/v1/projects/${randomUUID()}/fulfillment`,
      })
    ).statusCode,
    401,
    "controlled internal user fulfillment route is assembled",
  );
  await realComposition.close();
  config.environment = "test";
  config.transcription!.pollIntervalMs = 0;
  objects = new Objects(root);
  app = await createAdminApplication(config, {
    recordingObjects: objects,
    aiFetch,
  });
  db = new PrismaClient({ datasourceUrl: config.databaseUrl });
});
after(async () => {
  await app?.close();
  if (!config) return;
  const redis = new Redis(config.redisUrl);
  try {
    await db?.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    const keys = await redis.keys(`${schema}:*`);
    if (keys.length) await redis.del(...keys);
  } finally {
    await db?.$disconnect();
    redis.disconnect();
    await closePrivacyFixture(config);
    await rm(root, { recursive: true, force: true });
  }
});
type Actor = { id: string; cookie: string; csrf: string };
function data(
  r: { statusCode: number; body: string; json(): any },
  status = 201,
) {
  assert.equal(r.statusCode, status, r.body);
  return r.json().data;
}
async function login(): Promise<Actor> {
  const session = await fixtureWebSession(app, config);
  return {
    id: session.user.id,
    cookie: session.cookie,
    csrf: session.csrfToken,
  };
}

function request(
  method: "GET" | "POST",
  url: string,
  actor: Actor,
  payload?: object,
) {
  return app.inject({
    method,
    url,
    headers: {
      cookie: actor.cookie,
      origin,
      "x-timenook-web": "1",
      "x-csrf-token": actor.csrf,
      "idempotency-key": randomUUID(),
    },
    ...(payload ? { payload } : {}),
  });
}
const notice = () => ({
  noticeVersion: "internal-participation-v1",
  evidenceRef: `internal:${randomUUID()}`,
});
test("controlled internal books publicly registers quality handling while denying anonymous care access", async () => {
  const id = randomUUID();
  const admin = await app.inject({
    method: "GET",
    url: `/v1/admin/quality/cases/${id}`,
  });
  assert.equal(admin.statusCode, 401, admin.body);
  const actor = await login();
  const product = await request("GET", `/v1/orders/${id}/quality-care`, actor);
  assert.equal(product.statusCode, 404, product.body);
  const invalidGrant = await request(
    "POST",
    `/v1/orders/${id}/quality-care/${randomUUID()}/access`,
    actor,
    {
      expectedVersion: 1,
      scopes: ["evidence"],
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      consented: true,
      noticeVersion: "internal-participation-v1",
    },
  );
  assert.equal(invalidGrant.statusCode, 404, invalidGrant.body);
});
