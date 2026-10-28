import { bootPrivacyFixture, closePrivacyFixture } from "./privacy-fixture";
import { WechatPay } from "../src/payments/wechat-pay";
import { paymentAdmin } from "./payment-admin-fixture";
import { ProjectServiceTerms } from "../src/projects/service-terms";
import {
  paymentConfig,
  paymentFetch,
  paymentRequests,
  verifyMini,
  fault,
  supplierOrders,
  paid,
  callback,
  signed,
} from "./payment-fixture";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { before, after, test } from "node:test";
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import { createApplication } from "../src/application";
import type { ApiConfig } from "../src/config";
const schema = `t10_${randomUUID().replaceAll("-", "")}`;
let config: ApiConfig;
let app: Awaited<ReturnType<typeof createApplication>>;
let db: PrismaClient;
const packageId = randomUUID();
const wechatFetch: typeof fetch = async (input) =>
  new Response(
    JSON.stringify({
      openid: new URL(String(input)).searchParams.get("js_code")!.split(":")[0],
      session_key: "synthetic",
    }),
  );

before(async () => {
  assert.ok(process.env.DATABASE_URL);
  assert.ok(process.env.REDIS_URL);
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set("schema", schema);
  config = {
    environment: "test",
    host: "127.0.0.1",
    port: 3417,
    databaseUrl: url.toString(),
    redisUrl: process.env.REDIS_URL,
    redisKeyPrefix: schema,
    admin: {
      origin: "https://localhost:3443",
      encryptionKey: randomBytes(32).toString("base64"),
      sessionTtlSeconds: 28800,
      challengeTtlSeconds: 300,
    },
    wechat: { appId: "synthetic-timenook", secret: "synthetic-secret" },
    ...{ payments: paymentConfig },
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
  db = new PrismaClient({ datasourceUrl: config.databaseUrl });
  // Synthetic immutable catalog fixture: no commercial or editorial approval.
  const snapshot = JSON.parse(
    readFileSync("test/fixtures/catalog-synthetic.json", "utf8"),
  );
  const draftId = randomUUID();
  await db.packageDraft.create({
    data: { id: draftId, realm: "local", ...snapshot },
  });
  await db.packageVersion.create({
    data: {
      id: packageId,
      realm: "local",
      purpose: "local_preview",
      draftId,
      draftRevision: 1,
      snapshot,
      publicOffer: {
        title: "合成套餐",
        price: { value: 99900, unit: "fen", currency: "CNY" },
      },
    },
  });
  await db.recipientType.create({
    data: {
      realm: "local",
      code: "mentor",
      label: "恩师",
      revision: 1,
      sortOrder: 0,
      active: true,
    },
  });
  await bootPrivacyFixture(config);
  app = await createApplication(config, { wechatFetch, ...{ paymentFetch } });
});
after(async () => {
  await app?.close();
  if (!db) return;
  await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await db.$disconnect();
  const redis = new Redis(config.redisUrl);
  const keys = await redis.keys(`${schema}:*`);
  if (keys.length) await redis.del(...keys);
  redis.disconnect();
});
async function login(who = "buyer", target = app) {
  const r = await target.inject({
    method: "POST",
    url: "/v1/sessions/wechat",
    payload: { code: `${who}:${randomUUID()}` },
  });
  assert.equal(r.statusCode, 201);
  return r.json().data.session.token as string;
}
const command = () => ({
  packageVersionId: packageId,
  recipient: { typeCode: "mentor", relationshipLabel: "恩师" },
  shippingRegionCode: "CN-110000",
});
function create(
  token: string,
  key = randomUUID(),
  body = command(),
  target = app,
) {
  return target.inject({
    method: "POST",
    url: "/v1/orders",
    headers: { authorization: `Bearer ${token}`, "idempotency-key": key },
    payload: body,
  });
}
test("buyer creates one frozen local order, replays it across restart, and cannot choose price or inspect another buyer", async () => {
  const token = await login();
  const key = randomUUID();
  const first = await create(token, key);
  assert.equal(first.statusCode, 201, first.body);
  const order = first.json().data;
  assert.equal(order.amount, 99900);
  assert.equal(order.currency, "CNY");
  assert.equal(order.mode, "local-verification");
  assert.equal(order.state, "pending");
  assert.equal(order.project, null);
  assert.match(order.outTradeNo, /^TN[a-f0-9]{30}$/);
  assert.deepEqual(order.recipient, {
    typeCode: "mentor",
    relationshipLabel: "恩师",
  });
  assert.equal(order.template.reviewStatus, "unreviewed-test-only");
  assert.equal(order.bookTitle, "我的时光手记");
  assert.deepEqual((await create(token, key)).json().data, order);
  const conflict = await create(token, key, {
    ...command(),
    recipient: { typeCode: "mentor", relationshipLabel: "老师" },
  });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().error.code, "IDEMPOTENCY_CONFLICT");
  assert.equal(
    (
      await create(token, randomUUID(), {
        ...command(),
        amount: 1,
      } as ReturnType<typeof command>)
    ).statusCode,
    400,
  );
  const stranger = await login("stranger");
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: `/v1/orders/${order.id}`,
        headers: { authorization: `Bearer ${stranger}` },
      })
    ).statusCode,
    404,
  );
  const restarted = await createApplication(config, {
    wechatFetch,
    ...{ paymentFetch },
  });
  try {
    assert.deepEqual(
      (await create(token, key, command(), restarted)).json().data,
      order,
    );
    const list = await restarted.inject({
      method: "GET",
      url: "/v1/orders",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(list.json().data.orders[0].id, order.id);
  } finally {
    await restarted.close();
  }
});

test("payment prepare sends server frozen JSAPI fields and returns correctly signed mini-program parameters, with unknown submission recovered by original order query", async () => {
  const token = await login("prepare");
  const order = (await create(token)).json().data;
  const headers = {
    authorization: `Bearer ${token}`,
    "idempotency-key": randomUUID(),
  };
  const response = await app.inject({
    method: "POST",
    url: `/v1/orders/${order.id}/payment`,
    headers,
    payload: {},
  });
  assert.equal(response.statusCode, 201, response.body);
  const prepared = response.json().data;
  assert.equal(prepared.mode, "local-verification");
  verifyMini(prepared.parameters);
  const request = paymentRequests.find(
    (r) => r.body.out_trade_no === order.outTradeNo,
  )!;
  assert.deepEqual(request.body.amount, { total: 99900, currency: "CNY" });
  assert.deepEqual(request.body.payer, { openid: "prepare" });
  assert.equal(request.body.appid, "synthetic-timenook");
  assert.deepEqual(
    (
      await app.inject({
        method: "POST",
        url: `/v1/orders/${order.id}/payment`,
        headers,
        payload: {},
      })
    ).json().data,
    prepared,
  );
  const uncertain = (await create(token)).json().data;
  fault("timeout");
  const unknown = await app.inject({
    method: "POST",
    url: `/v1/orders/${uncertain.id}/payment`,
    headers,
    payload: {},
  });
  assert.equal(unknown.statusCode, 201);
  assert.equal(unknown.json().data.status, "unknown");
  const recovered = await app.inject({
    method: "POST",
    url: `/v1/orders/${uncertain.id}/payment`,
    headers: { ...headers, "idempotency-key": randomUUID() },
    payload: {},
  });
  assert.equal(recovered.statusCode, 201);
  assert.equal(recovered.json().data.status, "pending");
  assert.equal(
    paymentRequests.filter(
      (r) =>
        r.method === "POST" && r.body.out_trade_no === uncertain.outTradeNo,
    ).length,
    1,
    "never blindly resubmit an unknown order",
  );
  assert.ok(
    paymentRequests.some(
      (r) => r.method === "GET" && r.path.includes(uncertain.outTradeNo),
    ),
  );
});
async function prepareOrder(token: string) {
  const order = (await create(token)).json().data;
  const response = await app.inject({
    method: "POST",
    url: `/v1/orders/${order.id}/payment`,
    headers: {
      authorization: `Bearer ${token}`,
      "idempotency-key": randomUUID(),
    },
    payload: {},
  });
  assert.equal(response.json().data.status, "prepared");
  return order;
}
function readOrder(token: string, id: string, target = app) {
  return target.inject({
    method: "GET",
    url: `/v1/orders/${id}`,
    headers: { authorization: `Bearer ${token}` },
  });
}
async function notify(
  transaction: Record<string, unknown>,
  id?: string,
  target = app,
) {
  const event = await callback(transaction, id);
  return target.inject({
    method: "POST",
    url: "/v1/webhooks/wechat-pay/payments",
    headers: { ...event.headers, "content-type": "application/json" },
    payload: event.body,
  });
}
test("verified notification and active query concurrently activate exactly one project, subject, frozen plan and first-copy entitlement", async () => {
  const token = await login("activation");
  const order = await prepareOrder(token);
  await db.recipientType.update({
    where: { realm_code: { realm: "local", code: "mentor" } },
    data: { label: "后来称呼", active: false },
  });
  const transaction = paid(order.outTradeNo, {
    amount: { total: 99900, currency: "CNY", payer_total: 99800 },
  });
  const results = await Promise.all([
    notify(transaction),
    notify(transaction),
    readOrder(token, order.id),
    readOrder(token, order.id),
  ]);
  assert.equal(results[0].statusCode, 204, results[0].body);
  assert.equal(results[1].statusCode, 204, results[1].body);
  const result = (await readOrder(token, order.id)).json().data;
  assert.equal(result.state, "paid");
  assert.match(result.project.id, /^[a-f0-9-]{36}$/);
  assert.match(result.project.subject.id, /^[a-f0-9-]{36}$/);
  assert.equal(result.project.subject.name, null);
  assert.equal(result.project.subject.consent, "not_granted");
  assert.equal(result.project.bookTitle, "我的时光手记");
  assert.equal(result.project.recipient.relationshipLabel, "恩师");
  assert.equal(result.project.entitlement.state, "available");
  assert.equal(result.project.entitlement.copies, 1);
  assert.equal(result.project.plan.revision, 1);
  assert.equal(
    result.project.plan.chapters[0].questions[0].text,
    "有没有一个地方，你现在还想说说它的样子？",
  );
  for (const response of results.slice(2))
    assert.equal(response.json().data.project.id, result.project.id);
  const restarted = await createApplication(config, {
    wechatFetch,
    paymentFetch,
  });
  try {
    assert.deepEqual(
      (await readOrder(token, order.id, restarted)).json().data,
      result,
    );
  } finally {
    await restarted.close();
  }
  await db.recipientType.update({
    where: { realm_code: { realm: "local", code: "mentor" } },
    data: { label: "恩师", active: true },
  });
  const second = await prepareOrder(token);
  paid(second.outTradeNo);
  const next = (await readOrder(token, second.id)).json().data;
  assert.equal(next.state, "paid");
  assert.notEqual(next.project.id, result.project.id);
});
test("close reconciles the provider and preserves a racing payment; unpaid closed orders never get entitlement or another payment attempt", async () => {
  const token = await login("closing");
  const order = await prepareOrder(token);
  fault("close-race");
  const headers = {
    authorization: `Bearer ${token}`,
    "idempotency-key": randomUUID(),
  };
  const response = await app.inject({
    method: "POST",
    url: `/v1/orders/${order.id}/close`,
    headers,
    payload: {},
  });
  assert.equal(response.statusCode, 201, response.body);
  assert.equal(response.json().data.state, "paid");
  assert.ok(response.json().data.project.entitlement.id);
  const unpaid = await prepareOrder(token);
  const closed = await app.inject({
    method: "POST",
    url: `/v1/orders/${unpaid.id}/close`,
    headers,
    payload: {},
  });
  assert.equal(closed.statusCode, 201);
  assert.equal(closed.json().data.state, "closed");
  assert.equal(closed.json().data.project, null);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/v1/orders/${unpaid.id}/payment`,
        headers,
        payload: {},
      })
    ).statusCode,
    409,
  );
  // A delayed authenticated paid fact still wins even after a local close.
  const confirmed = paid(unpaid.outTradeNo);
  assert.equal((await notify(confirmed)).statusCode, 204);
  const recovered = (await readOrder(token, unpaid.id)).json().data;
  assert.equal(recovered.state, "paid");
  assert.ok(recovered.project.entitlement.id);
});

test("only the canonical callback path accepts authenticated raw bodies; forged signatures, keys, ciphertext and mismatched payment facts create no entitlement", async () => {
  const token = await login("verification");
  const order = await prepareOrder(token);
  const transaction = paid(order.outTradeNo);
  const event = await callback(transaction);
  const url = "/v1/webhooks/wechat-pay/payments";
  for (const payload of [
    event.body + " ",
    event.body.replace("AEAD_AES_256_GCM", "AES"),
  ])
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url,
          headers: { ...event.headers, "content-type": "application/json" },
          payload,
        })
      ).statusCode,
      400,
    );
  for (const headers of [
    { ...event.headers, "wechatpay-serial": "PUB_KEY_ID_UNKNOWN" },
    { ...event.headers, "wechatpay-timestamp": "1000000000" },
  ])
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url,
          headers: { ...headers, "content-type": "application/json" },
          payload: event.body,
        })
      ).statusCode,
      400,
    );
  for (const overrides of [
    { appid: "another-app" },
    { mchid: "another-merchant" },
    { amount: { total: 1, currency: "CNY" } },
    { amount: { total: 99900, currency: "USD" } },
    { trade_state: "NOTPAY" },
    { payer: { openid: "another-user" } },
  ])
    assert.equal(
      (await notify({ ...transaction, ...overrides }, "bad-" + randomUUID()))
        .statusCode,
      400,
    );
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: "/v1/orders",
        headers: { authorization: `Bearer ${token}` },
      })
    ).json().data.orders[0].project,
    null,
  );
  assert.equal((await notify(transaction)).statusCode, 204);
  assert.equal(
    (
      await notify({
        ...transaction,
        transaction_id: "conflicting-transaction",
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/webhooks/v1/wechat-pay/payments",
        headers: { ...event.headers, "content-type": "application/json" },
        payload: event.body,
      })
    ).statusCode,
    404,
  );
  assert.equal((await readOrder(token, order.id)).json().data.state, "paid");
});
test("local payment configuration rejects production, default-off reads, real transport and missing or repeated public callback prefix", async () => {
  const token = await login("gates");
  const order = await prepareOrder(token);
  const disabled = await createApplication(
    { ...config, payments: undefined },
    { wechatFetch },
  );
  try {
    assert.equal(
      (await disabled.inject({ method: "GET", url: "/health/live" }))
        .statusCode,
      200,
    );
    for (const [route, url] of [
      ["/v1/orders", "/v1/orders"],
      ["/v1/orders/:id", `/v1/orders/${order.id}`],
    ] as const) {
      assert.equal(
        disabled
          .getHttpAdapter()
          .getInstance()
          .hasRoute({ method: "GET", url: route }),
        false,
      );
      const response = await disabled.inject({
        method: "GET",
        url,
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(response.statusCode, 404);
      assert.equal(response.json().error.code, "NOT_FOUND");
    }
  } finally {
    await disabled.close();
  }
  await assert.rejects(() =>
    createApplication(
      { ...config, environment: "production" },
      { paymentFetch },
    ),
  );
  await assert.rejects(() =>
    createApplication(config, { wechatFetch, paymentFetch: fetch }),
  );
  for (const path of [
    "/v1/webhooks/wechat-pay/payments",
    "/timenook/timenook/v1/webhooks/wechat-pay/payments",
    "/timenook/webhooks/v1/wechat-pay/payments",
  ])
    await assert.rejects(() =>
      createApplication(
        {
          ...config,
          payments: {
            ...paymentConfig,
            notifyUrl: "https://synthetic.invalid" + path,
          },
        },
        { wechatFetch, paymentFetch },
      ),
    );
  const post = paymentRequests.find(
    (r) => r.body.out_trade_no === order.outTradeNo,
  )!;
  assert.equal(
    post.body.notify_url,
    "https://synthetic.invalid/timenook/v1/webhooks/wechat-pay/payments",
  );
});
test("durable Inbox survives a failed activation transaction and restart without provider access; failed persistence never ACKs", async () => {
  const token = await login("recovery");
  const order = await prepareOrder(token);
  const transaction = paid(order.outTradeNo);
  await db.$executeRawUnsafe(
    `CREATE FUNCTION fail_entitlement() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic transaction fault'; END $$`,
  );
  await db.$executeRawUnsafe(
    `CREATE TRIGGER fail_entitlement BEFORE INSERT ON first_copy_entitlements FOR EACH ROW EXECUTE FUNCTION fail_entitlement()`,
  );
  try {
    assert.equal((await notify(transaction)).statusCode, 204);
    assert.equal((await readOrder(token, order.id)).statusCode, 500);
    const list = await app.inject({
      method: "GET",
      url: "/v1/orders",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(list.json().data.orders[0].state, "pending");
    assert.equal(list.json().data.orders[0].project, null);
    await app.close();
  } finally {
    await db.$executeRawUnsafe(
      "DROP TRIGGER fail_entitlement ON first_copy_entitlements",
    );
    await db.$executeRawUnsafe("DROP FUNCTION fail_entitlement()");
  }
  const offline: typeof fetch = async () => {
    throw new Error("synthetic offline");
  };
  app = await createApplication(config, { wechatFetch, paymentFetch: offline });
  const restored = (await readOrder(token, order.id)).json().data;
  assert.equal(restored.state, "paid");
  assert.ok(restored.project.entitlement.id);
  await app.close();
  app = await createApplication(config, { wechatFetch, paymentFetch });
  const next = await prepareOrder(token);
  const nextPayment = paid(next.outTradeNo);
  await db.$executeRawUnsafe(
    `CREATE FUNCTION fail_inbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic durable store fault'; END $$`,
  );
  await db.$executeRawUnsafe(
    `CREATE TRIGGER fail_inbox BEFORE INSERT ON payment_inbox FOR EACH ROW EXECUTE FUNCTION fail_inbox()`,
  );
  try {
    assert.equal((await notify(nextPayment)).statusCode, 500);
  } finally {
    await db.$executeRawUnsafe("DROP TRIGGER fail_inbox ON payment_inbox");
    await db.$executeRawUnsafe("DROP FUNCTION fail_inbox()");
  }
  assert.equal((await notify(nextPayment)).statusCode, 204);
  assert.equal((await readOrder(token, next.id)).json().data.state, "paid");
});
test("invalid provider response signature remains unknown and concurrent prepare uses one original submission", async () => {
  const token = await login("response-signature");
  const order = (await create(token)).json().data;
  fault("signature");
  const headers = {
    authorization: `Bearer ${token}`,
    "idempotency-key": randomUUID(),
  };
  const result = await app.inject({
    method: "POST",
    url: `/v1/orders/${order.id}/payment`,
    headers,
    payload: {},
  });
  assert.equal(result.json().data.status, "unknown");
  assert.equal((await readOrder(token, order.id)).json().data.project, null);
  const key = randomUUID();
  const concurrent = await Promise.all(
    Array.from({ length: 8 }, () => create(token, key)),
  );
  assert.deepEqual(
    concurrent.map((r) => ({
      status: r.statusCode,
      error: r.json().error?.code,
    })),
    Array.from({ length: 8 }, () => ({ status: 201, error: undefined })),
    "every concurrent create must succeed before comparing order identities",
  );
  assert.equal(new Set(concurrent.map((r) => r.json().data.id)).size, 1);
  const id = concurrent[0].json().data.id;
  const no = concurrent[0].json().data.outTradeNo;
  const prepared = await Promise.all(
    Array.from({ length: 8 }, () =>
      app.inject({
        method: "POST",
        url: `/v1/orders/${id}/payment`,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {},
      }),
    ),
  );
  assert.deepEqual(
    prepared.map((r) => ({
      status: r.statusCode,
      error: r.json().error?.code,
    })),
    Array.from({ length: 8 }, () => ({ status: 201, error: undefined })),
    "every concurrent prepare must return a verified or explicitly unknown result",
  );
  assert.equal(
    paymentRequests.filter(
      (r) => r.method === "POST" && r.body.out_trade_no === no,
    ).length,
    1,
  );
});
test("a buyer can create and replay an order with a single database connection", async () => {
  const url = new URL(config.databaseUrl);
  url.searchParams.set("connection_limit", "1");
  url.searchParams.set("pool_timeout", "2");
  const limited = await createApplication(
    { ...config, databaseUrl: url.toString() },
    { wechatFetch, paymentFetch },
  );
  try {
    const token = await login("single-connection", limited);
    const key = randomUUID();
    const first = await create(token, key, command(), limited);
    assert.equal(
      first.statusCode,
      201,
      JSON.stringify({
        status: first.statusCode,
        error: first.json().error?.code,
      }),
    );
    const replay = await create(token, key, command(), limited);
    assert.equal(replay.statusCode, 201, replay.body);
    assert.equal(replay.json().data.id, first.json().data.id);
  } finally {
    await limited.close();
  }
});
test("payment activation freezes independent service terms while participation and delivery clocks remain unstarted", async () => {
  const token = await login("terms");
  const order = await prepareOrder(token);
  paid(order.outTradeNo);
  const result = (await readOrder(token, order.id)).json().data;
  assert.equal(result.project.terms.policyStatus, "synthetic-fixed-policy");
  assert.equal(result.project.terms.creation.state, "not_started");
  assert.equal(result.project.terms.creation.expiresAt, null);
  assert.equal(result.project.terms.playback.state, "not_started");
  assert.equal(result.project.terms.exportRequests.state, "not_started");
  assert.equal(result.project.terms.retention.originalAudio.expiresAt, null);
  assert.equal(result.project.terms.deleteData, false);
  assert.match(result.project.terms.notStarted.reviewAt, /Z$/);
});
test("trusted participation and delivery facts start frozen clocks once across concurrent replay, restart and exact expiry boundaries", async () => {
  const token = await login("term-facts");
  const order = await prepareOrder(token);
  paid(order.outTradeNo, { success_time: "2026-01-01T00:00:00.000Z" });
  const project = (await readOrder(token, order.id)).json().data.project;
  const terms = new ProjectServiceTerms(
    config.databaseUrl,
    () => new Date("2027-01-01T00:00:00.000Z"),
  );
  try {
    const fact = {
      projectId: project.id,
      eventId: "participation-fact",
      kind: "subject_participation" as const,
      occurredAt: new Date("2026-01-02T00:00:00.000Z"),
    };
    await Promise.all(Array.from({ length: 6 }, () => terms.recordFact(fact)));
    await assert.rejects(() =>
      terms.recordFact({
        ...fact,
        occurredAt: new Date("2026-01-03T00:00:00.000Z"),
      }),
    );
    assert.equal(
      (await terms.read(project.id, new Date("2026-06-30T23:59:59.999Z")))
        .creation?.state,
      "active",
    );
    const exact = await terms.read(
      project.id,
      new Date("2026-07-01T00:00:00.000Z"),
    );
    assert.equal(exact.creation?.state, "expired");
    assert.equal(exact.canRecord, false);
    assert.equal(exact.deleteData, false);
    assert.equal(
      (await terms.read(project.id, new Date("2026-07-01T00:00:00.001Z")))
        .creation?.state,
      "expired",
    );
    await terms.recordFact({
      projectId: project.id,
      eventId: "delivery-fact",
      kind: "delivery_completed",
      occurredAt: new Date("2026-06-01T00:00:00.000Z"),
    });
    const delivered = await terms.read(
      project.id,
      new Date("2027-06-01T00:00:00.000Z"),
    );
    assert.equal(delivered.playback?.state, "expired");
    assert.equal(delivered.exportRequests?.state, "expired");
    assert.equal(delivered.retention?.originalAudio.state, "active");
    assert.equal(delivered.deleteData, false);
    const restarted = new ProjectServiceTerms(config.databaseUrl);
    try {
      assert.deepEqual(
        await restarted.read(project.id, new Date("2027-06-01T00:00:00.000Z")),
        delivered,
      );
    } finally {
      await restarted.close();
    }
  } finally {
    await terms.close();
  }
});
test("the fixed pause policy stops creation only up to its frozen cumulative cap and preserves clock history on replay", async () => {
  const token = await login("pauses");
  const order = await prepareOrder(token);
  paid(order.outTradeNo, { success_time: "2026-01-01T00:00:00.000Z" });
  const id = (await readOrder(token, order.id)).json().data.project.id;
  let now = new Date("2026-02-01T00:00:00.000Z");
  const terms = new ProjectServiceTerms(config.databaseUrl, () => now);
  const operatorId = randomUUID();
  try {
    await terms.recordFact({
      projectId: id,
      eventId: "subject-joined",
      kind: "subject_participation",
      occurredAt: new Date("2026-01-02T00:00:00.000Z"),
    });
    const command = {
      projectId: id,
      eventId: "pause-case-1",
      kind: "pause" as const,
      operatorId,
      supportCaseRef: "record:synthetic-shared-case",
    };
    await terms.changePause(command);
    assert.equal((await terms.read(id)).creation?.state, "paused");
    now = new Date("2026-02-11T00:00:00.000Z");
    await terms.changePause({
      ...command,
      eventId: "resume-case-1",
      kind: "resume",
    });
    await terms.changePause(command);
    assert.equal(
      (await terms.read(id)).creation?.expiresAt,
      "2026-07-11T00:00:00.000Z",
    );
    now = new Date("2026-02-12T00:00:00.000Z");
    await terms.changePause({ ...command, eventId: "pause-case-2" });
    assert.equal(
      (await terms.read(id, new Date("2026-03-03T23:59:59.999Z"))).creation
        ?.state,
      "paused",
    );
    assert.equal(
      (await terms.read(id, new Date("2026-03-04T00:00:00.000Z"))).creation
        ?.state,
      "active",
    );
    assert.equal(
      (await terms.read(id, new Date("2026-08-01T00:00:00.000Z"))).creation
        ?.expiresAt,
      "2026-07-31T00:00:00.000Z",
    );
    now = new Date("2026-03-05T00:00:00.000Z");
    await assert.rejects(() =>
      terms.changePause({ ...command, eventId: "pause-over-cap" }),
    );
  } finally {
    await terms.close();
  }
});

test("support pauses require admin permission, CSRF and a shared case; mutation and audit commit together", async () => {
  const token = await login("support");
  const order = await prepareOrder(token);
  const supportStart = Date.now() - 2 * 86400000;
  paid(order.outTradeNo, {
    success_time: new Date(supportStart).toISOString(),
  });
  const project = (await readOrder(token, order.id)).json().data.project;
  const terms = new ProjectServiceTerms(config.databaseUrl);
  try {
    await terms.recordFact({
      projectId: project.id,
      eventId: "support-participation",
      kind: "subject_participation",
      occurredAt: new Date(supportStart + 86400000),
    });
  } finally {
    await terms.close();
  }
  const url = `/v1/admin/service-terms/${project.id}/pause`;
  const payload = {
    action: "pause",
    supportCaseRef: "record:synthetic-shared-case",
  };
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url,
        headers: {
          authorization: `Bearer ${token}`,
          "idempotency-key": randomUUID(),
        },
        payload,
      })
    ).statusCode,
    401,
  );
  const headers = {
    ...(await paymentAdmin(config, app)),
    "idempotency-key": randomUUID(),
  };
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url,
        headers: { ...headers, "x-csrf-token": "" },
        payload,
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url,
        headers,
        payload: { action: "pause" },
      })
    ).statusCode,
    400,
  );
  const changed = await app.inject({ method: "POST", url, headers, payload });
  assert.equal(changed.statusCode, 201, changed.body);
  assert.equal(changed.json().data.creation.state, "paused");
  assert.equal(
    (await app.inject({ method: "POST", url, headers, payload })).statusCode,
    201,
  );
  for (const conflicting of [
    { ...payload, action: "resume" },
    { ...payload, supportCaseRef: "record:different-shared-case" },
  ]) {
    const conflict = await app.inject({
      method: "POST",
      url,
      headers,
      payload: conflicting,
    });
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.json().error.code, "IDEMPOTENCY_CONFLICT");
  }
  const audits = await app.inject({
    method: "GET",
    url: "/v1/admin/audit",
    headers: { cookie: headers.cookie },
  });
  assert.ok(
    audits
      .json()
      .data.some(
        (a: { action: string; result: string }) =>
          a.action === "service-terms.pause" && a.result === "success",
      ),
  );
  const denied = {
    ...(await paymentAdmin(config, app, ["audit:read"])),
    "idempotency-key": randomUUID(),
  };
  assert.equal(
    (await app.inject({ method: "POST", url, headers: denied, payload }))
      .statusCode,
    403,
  );
});
test("prepare reconciles a successful unknown submission and refreshes expired prepay parameters only after querying the original unpaid order", async () => {
  const token = await login("prepare-recovery");
  const unknown = (await create(token)).json().data;
  const headers = {
    authorization: `Bearer ${token}`,
    "idempotency-key": randomUUID(),
  };
  fault("timeout");
  await app.inject({
    method: "POST",
    url: `/v1/orders/${unknown.id}/payment`,
    headers,
    payload: {},
  });
  paid(unknown.outTradeNo);
  const recovered = await app.inject({
    method: "POST",
    url: `/v1/orders/${unknown.id}/payment`,
    headers: { ...headers, "idempotency-key": randomUUID() },
    payload: {},
  });
  assert.equal(recovered.json().data.status, "paid");
  const list = await app.inject({
    method: "GET",
    url: "/v1/orders",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(
    list.json().data.orders.find((o: { id: string }) => o.id === unknown.id)
      .state,
    "paid",
  );
  const order = await prepareOrder(token);
  // Public wall-clock boundary simulated using an aged provider submission fixture.
  await db.paymentSubmission.update({
    where: { orderId: order.id },
    data: { submittedAt: new Date(Date.now() - 7200001) },
  });
  const before = paymentRequests.length;
  const refreshed = await app.inject({
    method: "POST",
    url: `/v1/orders/${order.id}/payment`,
    headers,
    payload: {},
  });
  assert.equal(refreshed.json().data.status, "prepared");
  const trace = paymentRequests.slice(before);
  assert.equal(trace[0].method, "GET");
  assert.ok(trace[0].path.includes(order.outTradeNo));
  assert.equal(trace[1].body.out_trade_no, order.outTradeNo);
  assert.deepEqual(trace[1].body.amount, { total: 99900, currency: "CNY" });
});

test("provider empty 204 and encrypted callback bytes must independently authenticate", async () => {
  const transport: typeof fetch = async () => {
    const response = signed("", 204);
    response.headers.set("Wechatpay-Signature", "invalid");
    return response;
  };
  await assert.rejects(() =>
    new WechatPay(paymentConfig, transport).close("TN" + "a".repeat(30)),
  );
  const token = await login("ciphertext");
  const order = await prepareOrder(token);
  const event = await callback(paid(order.outTradeNo));
  const value = JSON.parse(event.body);
  value.resource.ciphertext = "AAAA" + value.resource.ciphertext.slice(4);
  const body = JSON.stringify(value);
  const response = await app.inject({
    method: "POST",
    url: "/v1/webhooks/wechat-pay/payments",
    headers: {
      ...Object.fromEntries(signed(body).headers),
      "content-type": "application/json",
    },
    payload: body,
  });
  assert.equal(response.statusCode, 400);
});

after(async () => {
  await closePrivacyFixture(config);
});
