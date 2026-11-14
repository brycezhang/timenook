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
  withWechatProfile,
  phoneLogin,
  verifiedPhone,
} from "./wechat-profile-fixture";
import type { ApiConfig } from "../src/config";
const schema = `cg01_${randomUUID().replaceAll("-", "")}`;
let db: PrismaClient,
  app: Awaited<ReturnType<typeof createAdminApplication>>,
  config: ApiConfig;
let auth: Awaited<ReturnType<typeof authenticateFeishu>>;
const appId = "synthetic-cg01";
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
    wechat: { appId, secret: "synthetic-secret" },
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
  app = await createAdminApplication(config, {
    wechatFetch: withWechatProfile(async (input) => {
      const openid = new URL(String(input)).searchParams
        .get("js_code")!
        .split(":")[0];
      return new Response(JSON.stringify({ openid, session_key: "synthetic" }));
    }),
  });
  auth = await authenticateFeishu(
    config,
    app,
    createFeishuAccount(config, ["orders:read", "orders:write"]),
  );
  const draftId = randomUUID();
  await db.packageDraft.create({
    data: {
      id: draftId,
      realm: "local",
      title: "时光故事书",
      d01: {},
      admission: {},
      shippingRegionLabels: {},
    },
  });
  await db.packageVersion.create({
    data: {
      id: randomUUID(),
      realm: "local",
      purpose: "local_preview",
      draftId,
      draftRevision: 1,
      snapshot: { title: "时光故事书", scope: "synthetic" },
      publicOffer: { title: "时光故事书", price: { value: 99900 } },
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
function create(buyerPhone: string, key = randomUUID(), extra = {}) {
  return app.inject({
    method: "POST",
    url: "/v1/admin/channel-gifts",
    headers: {
      cookie: auth.cookie,
      origin: config.admin!.origin,
      "x-csrf-token": auth.csrf,
      "idempotency-key": key,
    },
    payload: { buyerPhone, ...extra },
  });
}
async function login(name: string) {
  const r = await app.inject({
    method: "POST",
    url: "/v1/sessions/wechat",
    payload: { code: `${name}:${randomUUID()}`, ...phoneLogin() },
  });
  assert.equal(r.statusCode, 201, r.body);
  return r.json().data;
}
function list(token: string) {
  return app.inject({
    method: "GET",
    url: "/v1/channel-gifts",
    headers: { authorization: `Bearer ${token}` },
  });
}

test("phone-only purchase is visible to the verified existing buyer, repeat submit returns one gift and a new key allows another", async () => {
  const user = await login("existing");
  const phone = verifiedPhone(appId, "existing"),
    key = randomUUID();
  const responses = await Promise.all([create(phone, key), create(phone, key)]);
  for (const r of responses) assert.equal(r.statusCode, 201, r.body);
  const gift = responses[0].json().data;
  assert.equal(gift.id, responses[1].json().data.id);
  assert.equal(gift.buyerId, user.user.id);
  assert.equal(gift.paidAmount, null);
  assert.equal(gift.paidAt, null);
  assert.equal(gift.listAmount, 99900);
  assert.equal(gift.packageTitle, "时光故事书");
  assert.equal(gift.projectId, null);
  assert.equal(gift.orderId, null);
  assert.equal((await create(phone, key, { paidAmount: 100 })).statusCode, 409);
  assert.equal((await create(phone)).statusCode, 201);
  const own = await list(user.session.token);
  assert.equal(own.statusCode, 200);
  assert.equal(own.json().data.length, 2);
  assert.equal(own.json().data[0].buyerPhone, undefined);
  const stranger = await login("stranger");
  assert.equal((await list(stranger.session.token)).json().data.length, 0);
  const admin = await app.inject({
    method: "GET",
    url: "/v1/admin/channel-gifts",
    headers: { cookie: auth.cookie },
  });
  assert.equal(admin.statusCode, 200);
  assert.ok(
    admin
      .json()
      .data.some(
        (g: any) => g.id === gift.id && g.operatorId === auth.account.id,
      ),
  );
});

test("unregistered purchase waits for verified same-phone login; concurrent first login and creation yields one buyer", async () => {
  const phone = verifiedPhone(appId, "future");
  const entry = await create(phone, randomUUID(), {
    externalOrderNo: "  外部 A-001  ",
    paidAmount: 88800,
    paidAt: "2026-11-14T01:00:00Z",
  });
  assert.equal(entry.statusCode, 201, entry.body);
  assert.equal(entry.json().data.buyerId, null);
  assert.equal(entry.json().data.externalOrderNo, "  外部 A-001  ");
  const [first, second, additional] = await Promise.all([
    login("future"),
    login("future"),
    create(phone),
  ]);
  assert.equal(first.user.id, second.user.id);
  assert.equal(additional.statusCode, 201, additional.body);
  const gifts = (await list(first.session.token)).json().data;
  assert.equal(gifts.length, 2);
  assert.ok(gifts.every((g: any) => g.projectId === null));
  assert.equal(
    gifts.find((g: any) => g.id === entry.json().data.id).paidAmount,
    88800,
  );
});

test("invalid inputs and unauthenticated/cross-site writes cannot issue gifts", async () => {
  assert.equal((await create("wrong")).statusCode, 400);
  assert.equal(
    (await create("13800001234", randomUUID(), { paidAmount: -1 })).statusCode,
    400,
  );
  assert.equal(
    (await create("13800001234", randomUUID(), { paidAt: "yesterday" }))
      .statusCode,
    400,
  );
  assert.equal(
    (await create("13800001234", randomUUID(), { buyerId: randomUUID() }))
      .statusCode,
    400,
  );
  assert.equal(
    (await app.inject({ method: "GET", url: "/v1/channel-gifts" })).statusCode,
    401,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/admin/channel-gifts",
        payload: { buyerPhone: "13800001234" },
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/admin/channel-gifts",
        headers: {
          cookie: auth.cookie,
          origin: "https://evil.invalid",
          "x-csrf-token": auth.csrf,
          "idempotency-key": randomUUID(),
        },
        payload: { buyerPhone: "13800001234" },
      })
    ).statusCode,
    403,
  );
});
