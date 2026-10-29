import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { after, before, test } from "node:test";
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import { createApplication } from "../src/application";
import type { ApiConfig } from "../src/config";

const schema = `feishu_${randomUUID().replaceAll("-", "")}`;
let config: ApiConfig;
let app: Awaited<ReturnType<typeof createApplication>>;
before(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.set("schema", schema);
  config = {
    environment: "test",
    host: "127.0.0.1",
    port: 3417,
    databaseUrl: url.toString(),
    redisUrl: process.env.REDIS_URL!,
    redisKeyPrefix: schema,
    admin: {
      origin: "https://localhost:3443",
      sessionKey: randomBytes(32).toString("base64"),
      sessionTtlSeconds: 28800,
      challengeTtlSeconds: 300,
    },
  };
  const migrated = spawnSync(
    process.execPath,
    ["node_modules/prisma/build/index.js", "migrate", "deploy"],
    {
      env: { ...process.env, DATABASE_URL: config.databaseUrl },
      encoding: "utf8",
    },
  );
  assert.equal(migrated.status, 0, "isolated migration");
  app = await createApplication(config);
});
after(async () => {
  await app?.close();
  if (!config) return;
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
});

test("unconfigured Feishu login is explicitly unavailable and exposes no password or MFA challenge", async () => {
  const response = await app.inject({
    method: "GET",
    url: "/v1/admin/session",
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().data.loginAvailable, false);
  assert.equal(response.json().data.mfaRequired, undefined);
  assert.equal(response.json().data.enrollmentRequired, undefined);
});

test("unconfigured Feishu start fails closed", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/v1/admin/feishu/login",
  });
  assert.equal(response.statusCode, 503);
});
