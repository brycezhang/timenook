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
import { ProjectPlans } from "../src/projects/project-plans";
import type { ApiConfig } from "../src/config";
const schema = `orders_${randomUUID().replaceAll("-", "")}`;
let db: PrismaClient,
  app: Awaited<ReturnType<typeof createAdminApplication>>,
  config: ApiConfig;
let auth: Awaited<ReturnType<typeof authenticateFeishu>>,
  restricted: typeof auth;
const buyerId = randomUUID(),
  packageId = randomUUID(),
  orderIds = Array.from({ length: 121 }, () => randomUUID());
const projectId = randomUUID(),
  refundId = randomUUID();
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
    createFeishuAccount(config, ["orders:read", "orders:write"]),
  );
  restricted = await authenticateFeishu(
    config,
    app,
    createFeishuAccount(config, ["ops:read"]),
  );
  await db.user.create({
    data: {
      id: buyerId,
      identities: { create: { appId: "synthetic-orders", openId: "buyer" } },
    },
  });
  const draftId = randomUUID();
  await db.packageDraft.create({
    data: {
      id: draftId,
      realm: "local",
      title: "合成套餐",
      d01: {},
      admission: {},
      shippingRegionLabels: {},
    },
  });
  await db.packageVersion.create({
    data: {
      id: packageId,
      realm: "local",
      purpose: "local_preview",
      draftId,
      draftRevision: 1,
      snapshot: {},
      publicOffer: {},
    },
  });
  await db.paymentOrder.createMany({
    data: orderIds.map((id, i) => ({
      id,
      buyerId,
      appId: "synthetic-orders",
      openId: "buyer",
      merchantId: "synthetic",
      outTradeNo: `SYNTHETIC-ORDER-${String(i).padStart(3, "0")}`,
      idempotencyKey: id,
      requestHash: "a".repeat(64),
      amount: i === 0 ? 1 : 99900,
      listAmount: 99900,
      isE2e: i === 0,
      currency: "CNY",
      mode: "wechat",
      packageVersionId: packageId,
      packageSnapshot: {},
      recipient: {},
      template: {},
      subjectName: "合成讲述者",
      bookTitle: "合成书名",
      state: i === 0 ? "paid" : "pending",
      createdAt: new Date(1700000000000 + i * 1000),
    })),
  });
  await db.paymentTransaction.create({
    data: {
      orderId: orderIds[0],
      providerTransactionId: "synthetic-paid",
      paidAt: new Date("2026-11-02T01:00:00Z"),
      amount: 1,
      currency: "CNY",
    },
  });
  const plans = new ProjectPlans(config.databaseUrl);
  await plans.createProject({ projectId, createdBy: buyerId });
  await plans.close();
  await db.project.update({
    where: { id: projectId },
    data: { orderId: orderIds[0] },
  });
  await db.projectSubject.create({
    data: {
      id: randomUUID(),
      projectId,
      name: "历史退款讲述者",
      boundUserId: buyerId,
    },
  });
  await db.firstCopyEntitlement.create({
    data: {
      id: randomUUID(),
      orderId: orderIds[0],
      projectId,
      state: "revoked",
    },
  });
  const caseId = randomUUID();
  await db.careRequest.create({
    data: {
      id: caseId,
      projectId,
      requesterId: buyerId,
      operatorId: buyerId,
      operatorRealm: "product",
      sourceBindingVersion: 0,
      sourceAccessEpoch: 0,
      idempotencyKey: caseId,
      requestHash: "b".repeat(64),
      kind: "refund",
      state: "completed",
    },
  });
  await db.refund.create({
    data: {
      id: refundId,
      caseId,
      orderId: orderIds[0],
      projectId,
      requesterId: buyerId,
      requestKey: refundId,
      requestHash: "c".repeat(64),
      reason: "notParticipated",
      state: "succeeded",
      amount: 1,
      outRefundNo: `SYNTHETIC-REFUND-${refundId}`,
      evidenceRef: "synthetic:refund",
      completedAt: new Date("2026-11-02T02:00:00Z"),
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
test("operator searches all historical orders with stable server pagination and distinct list/paid amounts", async () => {
  const first = await get("/v1/admin/orders?page=1&pageSize=20");
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().data.total, 121);
  assert.equal(first.json().data.items[0].id, orderIds[120]);
  const second = await get("/v1/admin/orders?page=2&pageSize=20");
  assert.equal(second.json().data.items[0].id, orderIds[100]);
  const found = await get("/v1/admin/orders?q=SYNTHETIC-ORDER-000");
  assert.equal(found.json().data.total, 1);
  assert.equal(found.json().data.items[0].id, orderIds[0]);
  const detail = await get(`/v1/admin/orders/${orderIds[0]}`);
  assert.equal(detail.statusCode, 200, detail.body);
  assert.deepEqual(
    [
      detail.json().data.listAmount,
      detail.json().data.payableAmount,
      detail.json().data.paidAmount,
      detail.json().data.isE2e,
    ],
    [99900, 1, 1, true],
  );
  assert.equal(detail.json().data.refundedAmount, 1);
  assert.equal(detail.json().data.state, "refunded");
  assert.equal(
    (await db.paymentOrder.findUniqueOrThrow({ where: { id: orderIds[0] } }))
      .state,
    "paid",
  );
  assert.equal(detail.json().data.refunds[0].state, "succeeded");
  assert.equal(detail.json().data.entitlement.state, "revoked");
  assert.equal(
    (await get(`/v1/admin/orders?q=${projectId}`)).json().data.total,
    1,
  );
  assert.equal(
    (await get("/v1/admin/orders?q=历史退款讲述者")).json().data.total,
    1,
  );
  assert.equal(
    (await get("/v1/admin/orders?pending=true")).json().data.total,
    0,
  );
  assert.equal((await get("/v1/admin/orders?pageSize=101")).statusCode, 400);
  const refunded = await get("/v1/admin/orders?state=refunded");
  assert.equal(refunded.statusCode, 200, refunded.body);
  assert.equal(refunded.json().data.total, 1);
  assert.equal(refunded.json().data.items[0].id, orderIds[0]);
  assert.equal((await get("/v1/admin/orders?state=paid")).json().data.total, 0);
  assert.equal((await get("/v1/admin/orders?state=invalid")).statusCode, 400);
  assert.equal((await get("/v1/admin/orders", restricted)).statusCode, 403);
});
test("linked user orders show confirmed refunds while original payment facts stay unchanged", async () => {
  const care = await authenticateFeishu(
    config,
    app,
    createFeishuAccount(config, ["care:write"]),
  );
  const user = await get(`/v1/admin/users/${buyerId}`, care);
  assert.equal(user.statusCode, 200, user.body);
  assert.equal(
    user.json().data.orders.find((o: { id: string }) => o.id === orderIds[0])
      .state,
    "refunded",
  );
  assert.equal(
    (await db.paymentOrder.findUniqueOrThrow({ where: { id: orderIds[0] } }))
      .state,
    "paid",
  );
  assert.equal(
    (
      await db.paymentTransaction.findUniqueOrThrow({
        where: { orderId: orderIds[0] },
      })
    ).amount,
    1,
  );
});
test("notes append once with operator/time and transactional audit, conflict on key reuse, and reject CSRF or revoked permissions", async () => {
  const id = orderIds[0],
    url = `/v1/admin/orders/${id}/notes`,
    key = randomUUID();
  const post = (content: string, session = auth, csrf = session.csrf) =>
    app.inject({
      method: "POST",
      url,
      payload: { content },
      headers: {
        cookie: session.cookie,
        origin: config.admin!.origin,
        "x-csrf-token": csrf,
        "idempotency-key": key,
      },
    });
  const [one, two] = await Promise.all([
    post("合成客服沟通备注"),
    post("合成客服沟通备注"),
  ]);
  assert.equal(one.statusCode, 201, one.body);
  assert.equal(two.statusCode, 201, two.body);
  assert.equal(one.json().data.id, two.json().data.id);
  assert.equal((await post("不同的备注")).statusCode, 409);
  assert.equal((await post("不应记录", auth, "wrong")).statusCode, 403);
  assert.equal((await post("越权备注", restricted)).statusCode, 403);
  await app.close();
  app = await createAdminApplication(config);
  const detail = (await get(`/v1/admin/orders/${id}`)).json().data;
  assert.equal(detail.notes.length, 1);
  assert.equal(detail.notes[0].content, "合成客服沟通备注");
  assert.equal(detail.notes[0].operatorId, auth.account.id);
  assert.ok(detail.notes[0].createdAt);
  assert.ok(
    detail.history.some(
      (h: { action: string; result: string }) =>
        h.action === "orders.note" && h.result === "success",
    ),
  );
  await db.adminAccount.update({
    where: { id: auth.account.id },
    data: { permissions: ["orders:read"] },
  });
  assert.equal((await post("权限已撤销")).statusCode, 403);
  assert.equal(
    (await get(`/v1/admin/orders/${orderIds[1]}`)).json().data.notes.length,
    0,
  );
  const logout = await app.inject({
    method: "POST",
    url: "/v1/admin/logout",
    headers: {
      cookie: auth.cookie,
      origin: config.admin!.origin,
      "x-csrf-token": auth.csrf,
    },
  });
  assert.equal(logout.statusCode, 204);
  assert.equal((await get(`/v1/admin/orders/${id}`)).statusCode, 401);
});
