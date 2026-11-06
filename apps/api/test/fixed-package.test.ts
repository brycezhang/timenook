import { withWechatProfile, phoneLogin } from "./wechat-profile-fixture";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { before, after, test } from "node:test";
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import { createAdminApplication } from "./admin-feishu-fixture";
import { paymentAdmin } from "./payment-admin-fixture";
import { bootPrivacyFixture, closePrivacyFixture } from "./privacy-fixture";
import {
  paymentConfig,
  paymentFetch,
  paymentRequests,
  paid,
  callback,
} from "./payment-fixture";
import type { ApiConfig } from "../src/config";
const schema = `fixed_${randomUUID().replaceAll("-", "")}`;
let config: ApiConfig;
let app: Awaited<ReturnType<typeof createAdminApplication>>;
let db: PrismaClient;
let operator: Awaited<ReturnType<typeof paymentAdmin>>;
const allowed: string[] = [];
before(async () => {
  Object.assign(paymentConfig, {
    appId: "wx0123456789abcdef",
    merchantId: "1900000001",
    merchantSerial: "ABC123",
    platformKeyId: "PUB_KEY_ID_12345",
  });
  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.set("schema", schema);
  config = {
    environment: "test",
    host: "127.0.0.1",
    port: 3417,
    databaseUrl: url.toString(),
    redisUrl: process.env.REDIS_URL!,
    redisKeyPrefix: schema,
    wechat: { appId: paymentConfig.appId, secret: "synthetic-secret" },
    admin: {
      origin: "https://localhost:3443",
      sessionKey: randomBytes(32).toString("base64"),
      sessionTtlSeconds: 28800,
      challengeTtlSeconds: 300,
    },
    web: {
      origin: "https://localhost:3443",
      sessionKey: randomBytes(32).toString("base64"),
      loginTtlSeconds: 300,
      sessionTtlSeconds: 3600,
    },
    acceptance: {
      mode: "internal-acceptance",
      profileVersion: "internal-acceptance-v1",
    },
    payments: { ...paymentConfig, mode: "ordinary-merchant" },
    ...{ checkoutE2e: { enabled: true, userIds: allowed } },
  };
  const migration = spawnSync(
    process.execPath,
    ["node_modules/prisma/build/index.js", "migrate", "deploy"],
    {
      env: { ...process.env, DATABASE_URL: config.databaseUrl },
      encoding: "utf8",
    },
  );
  assert.equal(migration.status, 0, migration.stderr);
  db = new PrismaClient({ datasourceUrl: config.databaseUrl });
  await bootPrivacyFixture(config);
  app = await createAdminApplication(config, {
    paymentFetch,
    wechatFetch: withWechatProfile(
      async (input) =>
        new Response(
          JSON.stringify({
            openid: new URL(String(input)).searchParams.get("js_code"),
            session_key: "synthetic",
          }),
        ),
    ),
  });
  operator = await paymentAdmin(config, app, [
    "catalog:read",
    "catalog:write",
    "catalog:freeze",
    "audit:read",
  ]);
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
  await closePrivacyFixture(config);
});
async function login() {
  const response = await app.inject({
    method: "POST",
    url: "/v1/sessions/wechat",
    payload: { ...phoneLogin(), code: randomUUID() },
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json().data;
}
function current(token?: string) {
  return app.inject({
    method: "GET",
    url: "/v1/packages/current",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}
test("operator publishes the fixed E2E version, while only server-allowed buyers see the one-fen checkout", async () => {
  const published = await app.inject({
    method: "POST",
    url: "/v1/admin/catalog/e2e-versions",
    headers: operator,
    payload: {},
  });
  assert.equal(published.statusCode, 201, published.body);
  const version = published.json().data;
  assert.equal(version.purpose, "e2e");
  assert.equal(version.price.value, 99900);
  assert.ok(
    version.terms.some((t: { text: string }) => t.text.includes("0.01")),
  );
  const anonymous = (await current()).json().data;
  assert.equal(anonymous.version, null);
  assert.ok(!JSON.stringify(anonymous).includes("受控"));
  assert.equal(anonymous.purchasable, false);
  assert.equal(anonymous.checkout, null);
  const buyer = await login();
  assert.equal(
    (await current(buyer.session.token)).json().data.purchasable,
    false,
  );
  allowed.push(buyer.user.id);
  const offer = (await current(buyer.session.token)).json().data;
  assert.equal(offer.purchasable, true);
  assert.deepEqual(offer.checkout, {
    listAmount: 99900,
    amount: 1,
    currency: "CNY",
    isE2e: true,
  });
  assert.deepEqual(offer.version.shippingRegions, [
    { code: "CN-110000", label: "北京市（验收地址选择，不承诺实物配送）" },
  ]);
  assert.equal((await current("invalid")).statusCode, 401);
  const replay = await app.inject({
    method: "POST",
    url: "/v1/admin/catalog/e2e-versions",
    headers: operator,
    payload: {},
  });
  assert.equal(replay.json().data.id, version.id);
});
test("one-fen checkout is server-priced and cannot be obtained by another buyer or client price fields", async () => {
  const buyer = await login();
  allowed.push(buyer.user.id);
  const offer = (await current(buyer.session.token)).json().data;
  const body = {
    packageVersionId: offer.version.id,
    recipient: { relationshipLabel: "本人" },
    shippingRegionCode: "CN-110000",
  };
  const key = randomUUID();
  const headers = {
    authorization: `Bearer ${buyer.session.token}`,
    "idempotency-key": key,
  };
  const created = await app.inject({
    method: "POST",
    url: "/v1/orders",
    headers,
    payload: body,
  });
  assert.equal(created.statusCode, 201, created.body);
  const order = created.json().data;
  assert.equal(order.listAmount, 99900);
  assert.equal(order.amount, 1);
  assert.equal(order.isE2e, true);
  assert.equal(order.mode, "wechat");
  assert.equal(order.state, "pending");
  assert.equal(order.project, null);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/orders",
        headers,
        payload: body,
      })
    ).json().data.id,
    order.id,
  );
  for (const extra of [{ amount: 1 }, { listAmount: 1 }, { isE2e: true }]) {
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/v1/orders",
          headers: { ...headers, "idempotency-key": randomUUID() },
          payload: { ...body, ...extra },
        })
      ).statusCode,
      400,
    );
  }
  const stranger = await login();
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/orders",
        headers: {
          authorization: `Bearer ${stranger.session.token}`,
          "idempotency-key": randomUUID(),
        },
        payload: body,
      })
    ).statusCode,
    403,
  );
  const disabled = await createAdminApplication(
    { ...config, checkoutE2e: undefined } as ApiConfig,
    {
      paymentFetch,
      wechatFetch: withWechatProfile(async () => new Response("{}")),
    },
  );
  try {
    assert.equal(
      (
        await disabled.inject({
          method: "POST",
          url: "/v1/orders",
          headers: { ...headers, "idempotency-key": randomUUID() },
          payload: body,
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await disabled.inject({
          method: "POST",
          url: `/v1/orders/${order.id}/payment`,
          headers,
          payload: {},
        })
      ).statusCode,
      403,
    );
  } finally {
    await disabled.close();
  }
});

async function paidE2eProject() {
  const buyer = await login();
  allowed.push(buyer.user.id);
  const offer = (await current(buyer.session.token)).json().data;
  const headers = {
    authorization: `Bearer ${buyer.session.token}`,
    "idempotency-key": randomUUID(),
  };
  const created = await app.inject({
    method: "POST",
    url: "/v1/orders",
    headers,
    payload: {
      packageVersionId: offer.version.id,
      recipient: { relationshipLabel: "本人" },
      shippingRegionCode: "CN-110000",
    },
  });
  assert.equal(created.statusCode, 201, created.body);
  const order = created.json().data;
  const prepare = await app.inject({
    method: "POST",
    url: `/v1/orders/${order.id}/payment`,
    headers,
    payload: {},
  });
  assert.equal(prepare.json().data.status, "prepared", prepare.body);
  assert.deepEqual(
    paymentRequests.find((r) => r.body.out_trade_no === order.outTradeNo)!.body
      .amount,
    { total: 1, currency: "CNY" },
  );
  const mismatched = await callback(
    paid(order.outTradeNo, { amount: { total: 99900, currency: "CNY" } }),
    `wrong-${randomUUID()}`,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/webhooks/wechat-pay/payments",
        headers: { ...mismatched.headers, "content-type": "application/json" },
        payload: mismatched.body,
      })
    ).statusCode,
    400,
  );
  const transaction = paid(order.outTradeNo, {
    amount: { total: 1, currency: "CNY" },
  });
  const event = await callback(transaction);
  const notification = () =>
    app.inject({
      method: "POST",
      url: "/v1/webhooks/wechat-pay/payments",
      headers: { ...event.headers, "content-type": "application/json" },
      payload: event.body,
    });
  assert.equal((await notification()).statusCode, 204);
  const read = () =>
    app.inject({ method: "GET", url: `/v1/orders/${order.id}`, headers });
  const results = await Promise.all([read(), read(), notification()]);
  assert.equal(results[0].statusCode, 200, results[0].body);
  const activated = (await read()).json().data;
  assert.equal(activated.state, "paid");
  assert.equal(activated.amount, 1);
  assert.equal(activated.project.terms.policyStatus, "lifetime");
  assert.equal(activated.project.entitlement.state, "available");
  assert.equal(results[0].json().data.project.id, activated.project.id);
  assert.equal(results[1].json().data.project.id, activated.project.id);
  return { buyer, headers, order: activated, project: activated.project };
}

test("E2E refund reserves and returns only the one fen received", async () => {
  const p = await paidE2eProject();
  const created = await app.inject({
    method: "POST",
    url: `/v1/orders/${p.order.id}/refunds`,
    headers: p.headers,
    payload: {
      reason: "notParticipated",
      evidenceRef: "internal:e2e-refund-request",
    },
  });
  assert.equal(created.statusCode, 201, created.body);
  const refund = created.json().data;
  const care = await paymentAdmin(config, app, ["care:write", "audit:read"]);
  const approve = (amountFen: number) =>
    app.inject({
      method: "POST",
      url: `/v1/admin/refunds/${refund.id}/approve`,
      headers: { ...care, "idempotency-key": randomUUID() },
      payload: { amountFen, evidenceRef: "internal:e2e-refund-review" },
    });
  assert.equal((await approve(99900)).statusCode, 409);
  const approved = await approve(1);
  assert.equal(approved.statusCode, 201, approved.body);
  assert.equal(approved.json().data.amountFen, 1);
  const submitted = await app.inject({
    method: "POST",
    url: `/v1/admin/refunds/${refund.id}/submit`,
    headers: { ...care, "idempotency-key": randomUUID() },
    payload: {},
  });
  assert.equal(submitted.statusCode, 201, submitted.body);
  assert.equal(submitted.json().data.state, "processing");
  const sent = paymentRequests.find(
    (r) =>
      r.path === "/v3/refund/domestic/refunds" &&
      r.body.out_trade_no === p.order.outTradeNo,
  )!;
  assert.deepEqual(sent.body.amount, { refund: 1, total: 1, currency: "CNY" });
  const balance = await app.inject({
    method: "GET",
    url: `/v1/orders/${p.order.id}/refunds`,
    headers: p.headers,
  });
  assert.equal(balance.json().data.paidAmountFen, 1);
  assert.equal(balance.json().data.reservedAmountFen, 1);
  assert.equal(balance.json().data.availableAmountFen, 0);
});

test("ordinary publication requires complete parameters and explicit operator confirmation before a 999-yuan checkout", async () => {
  const draft = await app.inject({
    method: "POST",
    url: "/v1/admin/catalog/package-drafts",
    headers: operator,
    payload: {
      title: "待完善",
      d01: {},
      admission: {},
      shippingRegionLabels: {},
    },
  });
  assert.equal(draft.statusCode, 201);
  const publishUrl = `/v1/admin/catalog/package-drafts/${draft.json().data.id}/publish`;
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: publishUrl,
        headers: operator,
        payload: { expectedRevision: 1, confirmRealParameters: true },
      })
    ).statusCode,
    422,
  );
  const synthetic = JSON.parse(
    readFileSync("test/fixtures/catalog-synthetic.json", "utf8"),
  );
  const saved = await app.inject({
    method: "POST",
    url: "/v1/admin/catalog/package-drafts",
    headers: operator,
    payload: synthetic,
  });
  const url = `/v1/admin/catalog/package-drafts/${saved.json().data.id}/publish`;
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url,
        headers: operator,
        payload: { expectedRevision: 1, confirmRealParameters: false },
      })
    ).statusCode,
    400,
  );
  const published = await app.inject({
    method: "POST",
    url,
    headers: operator,
    payload: { expectedRevision: 1, confirmRealParameters: true },
  });
  assert.equal(published.statusCode, 201, published.body);
  assert.equal(published.json().data.purpose, "production");
  const ordinary = await login();
  const offer = (await current(ordinary.session.token)).json().data;
  assert.equal(offer.version.id, published.json().data.id);
  assert.deepEqual(offer.checkout, {
    listAmount: 99900,
    amount: 99900,
    currency: "CNY",
    isE2e: false,
  });
  const created = await app.inject({
    method: "POST",
    url: "/v1/orders",
    headers: {
      authorization: `Bearer ${ordinary.session.token}`,
      "idempotency-key": randomUUID(),
    },
    payload: {
      packageVersionId: offer.version.id,
      recipient: { relationshipLabel: "恩师" },
      shippingRegionCode: "CN-110000",
    },
  });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().data.amount, 99900);
  assert.equal(created.json().data.isE2e, false);
  const allowedBuyer = await login();
  allowed.push(allowedBuyer.user.id);
  assert.equal(
    (await current(allowedBuyer.session.token)).json().data.version.purpose,
    "e2e",
  );
});
