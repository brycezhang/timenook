import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { before, after, test } from "node:test";
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import { createApplication } from "../src/application";
import type { ApiConfig } from "../src/config";
import { e2eSnapshot } from "../src/catalog/e2e-package";
import { fixtureWebSession } from "./web-session-fixture";
import { bootPrivacyFixture, closePrivacyFixture } from "./privacy-fixture";
const schema = `alipay_${randomUUID().replaceAll("-", "")}`;
let config: ApiConfig,
  app: Awaited<ReturnType<typeof createApplication>>,
  db: PrismaClient;
let buyer: Awaited<ReturnType<typeof fixtureWebSession>>,
  stranger: typeof buyer;
const packageId = randomUUID(),
  remote = new Map<string, any>();
let fault = "",
  remoteCreates = 0;
const paymentFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  assert.equal(url.origin, "https://payment.test.invalid");
  assert.equal(
    new Headers(init?.headers).get("X-Internal-Service"),
    "timenook",
  );
  assert.equal(
    new Headers(init?.headers).get("X-Internal-Auth"),
    "isolated-payment-secret",
  );
  if (fault === "network") throw new Error("isolated unavailable");
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  if (url.pathname === "/v1/payments/orders") {
    remoteCreates++;
    const row = {
      ...body,
      order_no: `AP${randomUUID()}`,
      channel_preferred: body.preferred_channel,
      status: "pending",
      settled_at: null,
    };
    remote.set(row.order_no, row);
    if (fault === "create-timeout") throw new Error("isolated lost response");
    return Response.json({ data: row });
  }
  const no = decodeURIComponent(
    url.pathname
      .split("/")
      .at(
        url.pathname.endsWith("/prepare") || url.pathname.endsWith("/close")
          ? -2
          : -1,
      )!,
  );
  const row = remote.get(no);
  assert.ok(row);
  if (url.pathname.endsWith("/prepare")) {
    assert.equal(new URL(body.extra.return_url).origin, config.web!.origin);
    assert.equal(body.channel, row.channel_preferred);
    return Response.json({
      data: {
        expires_in: 600,
        channel_payload: {
          method:
            body.channel === "alipay_page" ? "page_redirect" : "wap_redirect",
          order_string: `<form method="post" action="${fault === "unsafe-form" ? "https://evil.invalid" : "https://openapi.alipay.com/gateway.do"}"><input type="hidden" name="biz_content" value="&quot;safe&quot;"></form><script>throw new Error('must not execute')</script>`,
        },
      },
    });
  }
  if (url.pathname.endsWith("/close")) {
    if (fault === "close-paid")
      Object.assign(row, {
        status: "paid",
        settled_at: "2026-11-08T01:02:03Z",
      });
    else row.status = "closed";
  }
  return Response.json({ data: row });
};
before(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.port, "54329");
  url.searchParams.set("schema", schema);
  config = {
    environment: "test",
    host: "127.0.0.1",
    port: 0,
    databaseUrl: url.toString(),
    redisUrl: process.env.REDIS_URL!,
    redisKeyPrefix: schema,
    web: {
      origin: "https://localhost:3443",
      sessionKey: randomBytes(32).toString("base64"),
      loginTtlSeconds: 300,
      sessionTtlSeconds: 3600,
    },
    ...{
      alipay: {
        baseUrl: "https://payment.test.invalid",
        internalToken: "isolated-payment-secret",
      },
    },
  };
  const result = spawnSync(
    process.execPath,
    ["node_modules/prisma/build/index.js", "migrate", "deploy"],
    {
      env: { ...process.env, DATABASE_URL: config.databaseUrl },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  db = new PrismaClient({ datasourceUrl: config.databaseUrl });
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
      purpose: "production",
      draftId,
      draftRevision: 1,
      snapshot,
      publicOffer: {
        title: "合成套餐",
        price: { value: 99900, unit: "fen", currency: "CNY" },
      },
    },
  });
  await bootPrivacyFixture(config);
  app = await createApplication(config, { paymentFetch });
  buyer = await fixtureWebSession(app, config);
  stranger = await fixtureWebSession(app, config);
});
after(async () => {
  await app?.close();
  if (db) {
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.$disconnect();
  }
  const redis = new Redis(config.redisUrl);
  const keys = await redis.keys(`${schema}:*`);
  if (keys.length) await redis.del(...keys);
  redis.disconnect();
  await closePrivacyFixture(config);
});
function call(
  method: "GET" | "POST",
  path = "",
  payload?: unknown,
  actor = buyer,
  key = randomUUID(),
) {
  return app.inject({
    method,
    url: `/v1/web/orders${path}`,
    headers: {
      cookie: actor.cookie,
      origin: config.web!.origin,
      "x-timenook-web": "1",
      "x-csrf-token": actor.csrfToken,
      "idempotency-key": key,
    },
    ...(payload === undefined ? {} : { payload: payload as any }),
  });
}
async function create(channel = "alipay_page", key = randomUUID()) {
  const r = await call(
    "POST",
    "",
    {
      packageVersionId: packageId,
      recipient: { relationshipLabel: "妈妈" },
      bookTitle: "妈妈的一生",
      channel,
    },
    buyer,
    key,
  );
  assert.equal(r.statusCode, 201, r.body);
  return r.json().data;
}
test("web buyer without WeChat can buy the canonical package and receive one real project after ledger confirmation", async () => {
  const key = randomUUID(),
    order = await create("alipay_page", key);
  assert.equal(order.amount, 99900);
  assert.equal(order.project, null);
  assert.equal(order.bookTitle, "妈妈的一生");
  assert.equal((await create("alipay_page", key)).id, order.id);
  assert.equal(
    (await call("GET", `/${order.id}`, undefined, stranger)).statusCode,
    404,
  );
  const prep = await call("POST", `/${order.id}/payment`, {});
  assert.equal(prep.statusCode, 201, prep.body);
  assert.equal(prep.json().data.status, "prepared");
  assert.equal(
    prep.json().data.form.actionUrl,
    "https://openapi.alipay.com/gateway.do",
  );
  assert.equal(prep.body.includes("<script>"), false);
  assert.equal(
    (await call("GET", `/${order.id}`)).json().data.state,
    "pending",
  );
  const row = [...remote.values()].find((row) => row.biz_ref_id === order.id)!;
  Object.assign(row, { status: "paid", settled_at: "2026-11-08T01:02:03Z" });
  const results = await Promise.all([
    call("GET", `/${order.id}`),
    call("GET", `/${order.id}`),
  ]);
  assert.equal(results[0].statusCode, 200, results[0].body);
  assert.equal(
    results[0].json().data.project.id,
    results[1].json().data.project.id,
  );
  assert.equal(results[0].json().data.project.entitlement.state, "available");
  const projects = await app.inject({
    method: "GET",
    url: "/v1/participations",
    headers: { cookie: buyer.cookie },
  });
  assert.equal(
    projects
      .json()
      .data.projects.filter((p: any) => p.bookTitle === "妈妈的一生").length,
    1,
  );
});
test("browser cannot choose the amount or bypass CSRF and desktop/mobile channels stay frozen", async () => {
  const body = {
    packageVersionId: packageId,
    recipient: {},
    channel: "alipay_wap",
  };
  assert.equal(
    (await call("POST", "", { ...body, amount: 1 })).statusCode,
    400,
  );
  const csrf = await app.inject({
    method: "POST",
    url: "/v1/web/orders",
    headers: {
      cookie: buyer.cookie,
      origin: config.web!.origin,
      "x-timenook-web": "1",
      "idempotency-key": randomUUID(),
    },
    payload: body,
  });
  assert.equal(csrf.statusCode, 403);
  const order = await create("alipay_wap");
  assert.equal(order.channel, "alipay_wap");
  assert.equal(order.amount, 99900);
  assert.equal(
    (await call("POST", `/${order.id}/payment`, {})).json().data.status,
    "prepared",
  );
  assert.equal(
    (await call("GET", `/${order.id}`, undefined, stranger)).statusCode,
    404,
  );
});
test("mismatched remote financial and business fields never deliver a project", async () => {
  const order = await create();
  await call("POST", `/${order.id}/payment`, {});
  const row = [...remote.values()].find((row) => row.biz_ref_id === order.id)!;
  Object.assign(row, { status: "paid", settled_at: "2026-11-08T01:02:03Z" });
  for (const [field, wrong] of Object.entries({
    amount: "0.01",
    currency: "USD",
    biz_type: "deed_entitlement",
    biz_ref_id: randomUUID(),
    channel_preferred: "alipay_wap",
    order_no: "foreign-order",
  })) {
    const original = row[field];
    row[field] = wrong;
    const result = await call("GET", `/${order.id}`);
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().data.project, null);
    assert.equal(result.json().data.paymentStatus, "unknown");
    row[field] = original;
  }
  const original = row.metadata.local_order_id;
  row.metadata.local_order_id = randomUUID();
  assert.equal((await call("GET", `/${order.id}`)).json().data.project, null);
  row.metadata.local_order_id = original;
  row.metadata.product_code = randomUUID();
  assert.equal((await call("GET", `/${order.id}`)).json().data.project, null);
});
test("unsafe provider forms and unknown network results never become success", async () => {
  const order = await create();
  fault = "unsafe-form";
  assert.equal(
    (await call("POST", `/${order.id}/payment`, {})).json().data.status,
    "unknown",
  );
  fault = "network";
  const unknown = (await call("GET", `/${order.id}`)).json().data;
  assert.equal(unknown.paymentStatus, "unknown");
  assert.equal(unknown.state, "pending");
  assert.equal(unknown.project, null);
  fault = "";
  assert.equal(
    (await call("POST", `/${order.id}/payment`, {})).json().data.status,
    "prepared",
  );
});
test("closing keeps a lost result pending and prefers a real payment that races the close", async () => {
  const local = await create();
  assert.equal(
    (await call("POST", `/${local.id}/close`, {})).json().data.state,
    "closed",
  );
  const order = await create();
  await call("POST", `/${order.id}/payment`, {});
  fault = "network";
  const unknown = (await call("POST", `/${order.id}/close`, {})).json().data;
  assert.equal(unknown.state, "pending");
  assert.equal(unknown.paymentStatus, "unknown");
  fault = "close-paid";
  const paid = (await call("POST", `/${order.id}/close`, {})).json().data;
  assert.equal(paid.state, "paid");
  assert.ok(paid.project);
  fault = "";
  const unpaid = await create();
  await call("POST", `/${unpaid.id}/payment`, {});
  const closed = (await call("POST", `/${unpaid.id}/close`, {})).json().data;
  assert.equal(closed.state, "closed");
  assert.equal(closed.project, null);
});
test("lost remote creation is not retried into a second payable order", async () => {
  const order = await create(),
    prior = remoteCreates;
  fault = "create-timeout";
  assert.equal(
    (await call("POST", `/${order.id}/payment`, {})).json().data.status,
    "unknown",
  );
  fault = "";
  assert.equal(
    (await call("POST", `/${order.id}/payment`, {})).json().data.status,
    "unknown",
  );
  assert.equal(remoteCreates - prior, 1);
  assert.equal((await call("GET", `/${order.id}`)).json().data.project, null);
});

test("only explicit server-owned Alipay acceptance config can charge one fen and it uses the non-production package", async () => {
  const e2eId = randomUUID();
  const draft = await db.packageDraft.create({
    data: {
      id: randomUUID(),
      realm: "local",
      ...JSON.parse(
        readFileSync("test/fixtures/catalog-synthetic.json", "utf8"),
      ),
    },
  });
  await db.packageVersion.create({
    data: {
      id: e2eId,
      realm: "local",
      purpose: "e2e",
      draftId: draft.id,
      draftRevision: 1,
      snapshot: e2eSnapshot(),
      publicOffer: {
        title: "合成验收套餐",
        price: { value: 99900, unit: "fen", currency: "CNY" },
      },
    },
  });
  const scoped: ApiConfig = {
    ...config,
    acceptance: {
      mode: "internal-acceptance",
      profileVersion: "internal-acceptance-v1",
    },
    alipay: { ...config.alipay!, e2eAmountFen: 1 },
  };
  const acceptance = await createApplication(scoped, { paymentFetch });
  try {
    const actor = await fixtureWebSession(acceptance, scoped);
    const headers = {
      cookie: actor.cookie,
      origin: scoped.web!.origin,
      "x-timenook-web": "1",
      "x-csrf-token": actor.csrfToken,
      "idempotency-key": randomUUID(),
    };
    const rejected = await acceptance.inject({
      method: "POST",
      url: "/v1/web/orders",
      headers,
      payload: {
        packageVersionId: packageId,
        recipient: {},
        channel: "alipay_page",
      },
    });
    assert.equal(rejected.statusCode, 400);
    const created = await acceptance.inject({
      method: "POST",
      url: "/v1/web/orders",
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: {
        packageVersionId: e2eId,
        recipient: {},
        channel: "alipay_page",
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    const order = created.json().data;
    assert.equal(order.amount, 1);
    assert.equal(order.listAmount, 99900);
    assert.equal(order.isE2e, true);
    const prepared = await acceptance.inject({
      method: "POST",
      url: `/v1/web/orders/${order.id}/payment`,
      headers,
      payload: {},
    });
    assert.equal(prepared.json().data.status, "prepared");
    const row = [...remote.values()].find(
      (row) => row.biz_ref_id === order.id,
    )!;
    assert.equal(row.amount, "0.01");
    // The original app still charges canonical 999 despite a mini-program checkout flag.
    config.checkoutE2e = { enabled: true };
    assert.equal((await create()).amount, 99900);
  } finally {
    await acceptance.close();
  }
});
