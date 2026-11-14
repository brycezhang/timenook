import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { before, after, test } from "node:test";
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import {
  createAdminApplication,
  authenticateFeishu,
  createFeishuAccount,
} from "./admin-feishu-fixture";
import {
  internalSnapshot,
  INTERNAL_PROFILE_VERSION,
} from "../src/projects/internal-profile";
import { ProjectPlans } from "../src/projects/project-plans";
import type { ApiConfig } from "../src/config";
const schema = `users_${randomUUID().replaceAll("-", "")}`;
let db: PrismaClient,
  app: Awaited<ReturnType<typeof createAdminApplication>>,
  config: ApiConfig;
let auth: Awaited<ReturnType<typeof authenticateFeishu>>,
  restricted: typeof auth;
const userIds = Array.from({ length: 121 }, () => randomUUID());
const projectId = randomUUID(),
  subjectId = randomUUID(),
  caseId = randomUUID();
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
  assert.equal(migrated.status, 0, migrated.stderr);
  db = new PrismaClient({ datasourceUrl: config.databaseUrl });
  app = await createAdminApplication(config);
  auth = await authenticateFeishu(
    config,
    app,
    createFeishuAccount(config, ["care:write"]),
  );
  restricted = await authenticateFeishu(
    config,
    app,
    createFeishuAccount(config, ["ops:read"]),
  );
  await db.user.createMany({
    data: userIds.map((id, i) => ({
      id,
      createdAt: new Date(1700000000000 + i * 1000),
    })),
  });
  const plans = new ProjectPlans(config.databaseUrl);
  await plans.createProject({ projectId, createdBy: userIds[0] });
  await plans.close();
  await db.internalProjectAdmission.create({
    data: {
      id: randomUUID(),
      projectId,
      initiatorUserId: userIds[0],
      provisionKey: randomUUID(),
      requestHash: "a".repeat(64),
      profileVersion: INTERNAL_PROFILE_VERSION,
      snapshot: internalSnapshot(INTERNAL_PROFILE_VERSION),
    },
  });
  await db.projectSubject.create({
    data: { id: subjectId, projectId, name: "无账号合成讲述者" },
  });
  await db.careRequest.create({
    data: {
      id: caseId,
      projectId,
      requesterSubjectId: subjectId,
      operatorId: auth.account.id,
      operatorRealm: "admin",
      sourceBindingVersion: 0,
      sourceAccessEpoch: 0,
      idempotencyKey: caseId,
      requestHash: "b".repeat(64),
      kind: "delete",
      state: "open",
    },
  });
});
after(async () => {
  await app?.close();
  if (db) {
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.$disconnect();
  }
  if (config) {
    const redis = new Redis(config.redisUrl);
    const keys = await redis.keys(`${schema}:*`);
    if (keys.length) await redis.del(...keys);
    redis.disconnect();
  }
});
const get = (url: string, session = auth) =>
  app.inject({ method: "GET", url, headers: { cookie: session.cookie } });
test("operator finds historical accounts and no-account narrators with pending orderless requests through user and project details", async () => {
  const page = await get("/v1/admin/users?page=2&pageSize=100");
  assert.equal(page.statusCode, 200, page.body);
  assert.equal(page.json().data.total, 122);
  assert.equal(page.json().data.items.length, 22);
  const found = (
    await get("/v1/admin/users?q=无账号合成讲述者&pending=true")
  ).json().data;
  assert.equal(found.total, 2);
  assert.ok(
    found.items.some(
      (r: { kind: string; id: string }) =>
        r.kind === "account" && r.id === userIds[0],
    ),
  );
  assert.ok(
    found.items.some(
      (r: { kind: string; id: string }) =>
        r.kind === "narrator" && r.id === subjectId,
    ),
  );
  const user = await get(`/v1/admin/users/${userIds[0]}`);
  assert.equal(user.statusCode, 200, user.body);
  assert.equal(user.json().data.projects[0].id, projectId);
  const project = await get(`/v1/admin/users/projects/${projectId}`);
  assert.equal(project.statusCode, 200, project.body);
  assert.equal(project.json().data.orderId, null);
  assert.equal(project.json().data.source, "internal-acceptance");
  assert.equal(project.json().data.physicalProduction, false);
  assert.equal(project.json().data.requests[0].id, caseId);
  assert.equal(project.json().data.requests[0].kind, "delete");
  assert.equal((await get("/v1/admin/users", restricted)).statusCode, 200);
  assert.equal((await get("/v1/admin/users?pageSize=101")).statusCode, 400);
});
test("user notes append once, survive restart, stay on the account and reject conflicting or unauthorized submissions", async () => {
  const key = randomUUID(),
    url = `/v1/admin/users/${userIds[0]}/notes`;
  const post = (content: string, csrf = auth.csrf) =>
    app.inject({
      method: "POST",
      url,
      payload: { content },
      headers: {
        cookie: auth.cookie,
        origin: config.admin!.origin,
        "x-csrf-token": csrf,
        "idempotency-key": key,
      },
    });
  const [one, two] = await Promise.all([
    post("合成用户备注"),
    post("合成用户备注"),
  ]);
  assert.equal(one.statusCode, 201, one.body);
  assert.equal(two.statusCode, 201, two.body);
  assert.equal(one.json().data.id, two.json().data.id);
  assert.equal((await post("不同内容")).statusCode, 409);
  assert.equal((await post("合成用户备注", "wrong")).statusCode, 403);
  await app.close();
  app = await createAdminApplication(config);
  const user = (await get(`/v1/admin/users/${userIds[0]}`)).json().data;
  assert.equal(user.notes.length, 1);
  assert.equal(user.notes[0].operatorId, auth.account.id);
  assert.ok(
    user.history.some((h: { action: string }) => h.action === "users.note"),
  );
  assert.equal(
    (await get(`/v1/admin/users/${userIds[1]}`)).json().data.notes.length,
    0,
  );
  await db.adminAccount.update({
    where: { id: auth.account.id },
    data: { permissions: [] },
  });
  assert.equal((await get(`/v1/admin/users/${userIds[0]}`)).statusCode, 200);
});
