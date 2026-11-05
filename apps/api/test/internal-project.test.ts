import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, before, test } from "node:test";
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import { createApplication } from "../src/application";
import type { ApiConfig } from "../src/config";
import { bootPrivacyFixture, closePrivacyFixture } from "./privacy-fixture";
const schema = `internal_${randomUUID().replaceAll("-", "")}`,
  origin = "https://localhost:3447";
const headers = { origin, "x-timenook-web": "1" };
let root: string,
  config: ApiConfig,
  app: Awaited<ReturnType<typeof createApplication>>;
before(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(url.hostname));
  url.searchParams.set("schema", schema);
  root = await mkdtemp(join(tmpdir(), "timenook-internal-project-"));
  config = {
    environment: "test",
    host: "127.0.0.1",
    port: 3419,
    databaseUrl: url.toString(),
    redisUrl: process.env.REDIS_URL!,
    redisKeyPrefix: schema,
    acceptance: {
      mode: "internal-acceptance",
      profileVersion: "internal-acceptance-v1",
    },
    web: {
      origin,
      sessionKey: randomBytes(32).toString("base64"),
      loginTtlSeconds: 900,
      sessionTtlSeconds: 43200,
    },
  };
  const migration = spawnSync(
    process.execPath,
    ["node_modules/prisma/build/index.js", "migrate", "deploy"],
    {
      env: { ...process.env, DATABASE_URL: config.databaseUrl },
      encoding: "utf8",
    },
  );
  assert.equal(migration.status, 0, "isolated migrations");
  await bootPrivacyFixture(config);
  app = await createApplication(config);
});
after(async () => {
  await app?.close();
  if (!config) return;
  const db = new PrismaClient({ datasourceUrl: config.databaseUrl }),
    redis = new Redis(config.redisUrl);
  try {
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    const keys = await redis.keys(`${schema}:*`);
    if (keys.length) await redis.del(...keys);
  } finally {
    await db.$disconnect();
    redis.disconnect();
    await closePrivacyFixture(config);
    await rm(root, { recursive: true, force: true });
  }
});
async function cli(kind: "web" | "internal", command: string, input: object) {
  const id = randomUUID(),
    inputFile = join(root, `${id}.input`),
    outputFile = join(root, `${id}.output`);
  await writeFile(inputFile, JSON.stringify(input), { mode: 0o600 });
  const child = spawn(
    process.execPath,
    [
      join(
        __dirname,
        kind === "web"
          ? "../src/web/web-cli.js"
          : "../src/projects/internal-project-cli.js",
      ),
      command,
      "--input-file",
      inputFile,
      "--output-file",
      outputFile,
    ],
    {
      env: {
        ...process.env,
        NODE_ENV: "test",
        DATABASE_URL: config.databaseUrl,
        REDIS_URL: config.redisUrl,
        WEB_ORIGIN: origin,
        WEB_SESSION_KEY: config.web!.sessionKey,
        PRIVACY_JOURNAL_ROOT: config.privacyJournal!.root,
        PRIVACY_JOURNAL_KEY: config.privacyJournal!.key,
        INTERNAL_ACCEPTANCE_ENABLED: "1",
      },
      stdio: "ignore",
    },
  );
  assert.equal(
    await new Promise((resolve) => child.once("close", resolve)),
    0,
    `controlled ${kind} ${command}`,
  );
  return JSON.parse(await readFile(outputFile, "utf8"));
}
async function signedIn() {
  const account = await cli("web", "create", {}),
    issued = await cli("web", "issue", { userId: account.user.id });
  const response = await app.inject({
    method: "POST",
    url: "/v1/web/session",
    headers,
    payload: {
      ticket: new URLSearchParams(new URL(issued.url).hash.slice(1)).get(
        "ticket",
      ),
    },
  });
  assert.equal(response.statusCode, 201);
  return {
    user: account.user,
    cookie: String(response.headers["set-cookie"]).split(";")[0],
    csrf: response.json().data.csrfToken,
  };
}
test("controlled CLI creates one real internal project across concurrent retries without any payment identity", async () => {
  const owner = await signedIn(),
    input = {
      provisionKey: `acceptance-${randomUUID()}`,
      initiatorUserId: owner.user.id,
      bookTitle: "内部功能验收书",
    };
  const [first, second] = await Promise.all([
    cli("internal", "create", input),
    cli("internal", "create", input),
  ]);
  assert.deepEqual(first, second);
  assert.equal(first.source, "internal-acceptance");
  const response = await app.inject({
    method: "GET",
    url: "/v1/web/projects",
    headers: { cookie: owner.cookie },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(
    response.json().data.projects.map((p: { id: string }) => p.id),
    [first.projectId],
  );
  const db = new PrismaClient({ datasourceUrl: config.databaseUrl });
  try {
    assert.equal(await db.paymentOrder.count(), 0);
    assert.equal(await db.paymentTransaction.count(), 0);
    assert.equal(await db.wechatIdentity.count(), 0);
    assert.equal(await db.firstCopyEntitlement.count(), 0);
  } finally {
    await db.$disconnect();
  }
});

function request(
  user: Awaited<ReturnType<typeof signedIn>>,
  path: string,
  method: "GET" | "POST" = "GET",
  payload?: object,
) {
  return app.inject({
    method,
    url: `/v1${path}`,
    headers: {
      ...headers,
      cookie: user.cookie,
      "x-csrf-token": user.csrf,
      "idempotency-key": `internal-${randomUUID()}`,
    },
    ...(payload ? { payload } : {}),
  });
}

test("mock checkout creates an isolated account and one internal project without any real payment", async () => {
  const mode = await app.inject({ method: "GET", url: "/v1/web/experience" });
  assert.equal(mode.json().data.mockEnabled, true);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/web/mock-session",
        payload: {},
      })
    ).statusCode,
    403,
  );
  const loggedIn = await app.inject({
    method: "POST",
    url: "/v1/web/mock-session",
    headers,
    payload: {},
  });
  assert.equal(loggedIn.statusCode, 201);
  const cookies = (loggedIn.headers["set-cookie"] as string[]).map(
    (value) => value.split(";")[0],
  );
  const cookie = cookies.join("; ");
  const actor = loggedIn.json().data;
  const payload = {
    purchaseKey: randomUUID(),
    bookTitle: "妈妈的一生",
    subjectName: "妈妈",
  };
  const purchase = (body = payload) =>
    app.inject({
      method: "POST",
      url: "/v1/web/mock-purchases",
      headers: { ...headers, cookie, "x-csrf-token": actor.csrfToken },
      payload: body,
    });
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/web/mock-purchases",
        headers: { ...headers, cookie },
        payload,
      })
    ).statusCode,
    403,
  );
  const [first, replay] = await Promise.all([purchase(), purchase()]);
  assert.equal(first.statusCode, 201);
  assert.equal(replay.statusCode, 201);
  assert.deepEqual(first.json().data, replay.json().data);
  assert.equal(first.json().data.source, "internal-acceptance");
  const projectId = first.json().data.projectId;
  assert.equal(
    (await purchase({ ...payload, bookTitle: "不同的输入" })).statusCode,
    409,
  );
  const list = await app.inject({
    method: "GET",
    url: "/v1/web/projects",
    headers: { cookie },
  });
  assert.deepEqual(
    list.json().data.projects.map((p: { id: string }) => p.id),
    [projectId],
  );
  const db = new PrismaClient({ datasourceUrl: config.databaseUrl });
  try {
    assert.equal(
      (await db.project.findUniqueOrThrow({ where: { id: projectId } }))
        .createdBy,
      actor.user.id,
    );
    assert.equal(
      await db.paymentOrder.count({ where: { buyerId: actor.user.id } }),
      0,
    );
    assert.equal(
      await db.firstCopyEntitlement.count({ where: { projectId } }),
      0,
    );
    assert.equal(
      await db.wechatIdentity.count({ where: { userId: actor.user.id } }),
      0,
    );
  } finally {
    await db.$disconnect();
  }
  const logout = await app.inject({
    method: "DELETE",
    url: "/v1/web/session",
    headers: { ...headers, cookie, "x-csrf-token": actor.csrfToken },
  });
  assert.equal(logout.statusCode, 204);
  const again = await app.inject({
    method: "POST",
    url: "/v1/web/mock-session",
    headers: {
      ...headers,
      cookie: cookies.find((value) =>
        value.startsWith("__Secure-timenook_mock="),
      ),
    },
    payload: {},
  });
  assert.equal(again.statusCode, 201);
  assert.equal(again.json().data.user.id, actor.user.id);
  const other = await app.inject({
    method: "POST",
    url: "/v1/web/mock-session",
    headers,
    payload: {},
  });
  assert.notEqual(other.json().data.user.id, actor.user.id);
});

test("normal mode never offers mock login or mock payment", async () => {
  const regular = await createApplication({ ...config, acceptance: undefined });
  try {
    assert.equal(
      (
        await regular.inject({ method: "GET", url: "/v1/web/experience" })
      ).json().data.mockEnabled,
      false,
    );
    assert.equal(
      (
        await regular.inject({
          method: "POST",
          url: "/v1/web/mock-session",
          headers,
          payload: {},
        })
      ).statusCode,
      503,
    );
    assert.equal(
      (
        await regular.inject({
          method: "POST",
          url: "/v1/web/mock-purchases",
          headers,
          payload: {
            purchaseKey: randomUUID(),
            bookTitle: "测试",
            subjectName: "测试",
          },
        })
      ).statusCode,
      503,
    );
  } finally {
    await regular.close();
  }
});
