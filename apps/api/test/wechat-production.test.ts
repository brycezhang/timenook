import { TERMS_VERSION } from "../src/identity/project-members";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  verify,
  X509Certificate,
  type KeyObject,
} from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { readConfig } from "../src/config";
import { createApplication } from "../src/application";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { bootPrivacyFixture, closePrivacyFixture } from "./privacy-fixture";
import Redis from "ioredis";
import { BUILTIN_TEMPLATE } from "../src/projects/builtin-template";
import { createAdminApplication } from "./admin-feishu-fixture";
import { paymentAdmin } from "./payment-admin-fixture";
import {
  encryptedPaymentNotification,
  signedPaymentHeaders,
} from "./wechat-payment-envelope-fixture";

const base: NodeJS.ProcessEnv = {
  NODE_ENV: "development",
  DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/unused",
  REDIS_URL: "redis://127.0.0.1:1",
};
let root: string;
let ordinary: NodeJS.ProcessEnv;
let platformPrivateKey: KeyObject;
before(() => {
  root = mkdtempSync(join(tmpdir(), "t29-pay-"));
  const merchant = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const platform = generateKeyPairSync("rsa", { modulusLength: 2048 });
  platformPrivateKey = platform.privateKey;
  writeFileSync(
    join(root, "merchant.key"),
    merchant.privateKey.export({ type: "pkcs8", format: "pem" }),
    { mode: 0o600 },
  );
  writeFileSync(
    join(root, "platform.pub"),
    platform.publicKey.export({ type: "spki", format: "pem" }),
    { mode: 0o600 },
  );
  const certificate = spawnSync(
    "openssl",
    [
      "req",
      "-new",
      "-x509",
      "-key",
      join(root, "merchant.key"),
      "-out",
      join(root, "merchant.crt"),
      "-days",
      "1",
      "-subj",
      "/CN=t29-test",
    ],
    { encoding: "utf8" },
  );
  assert.equal(certificate.status, 0, "local generated merchant certificate");
  ordinary = {
    ...base,
    TIMENOOK_WECHAT_APP_ID: "wx1234567890abcdef",
    TIMENOOK_WECHAT_APP_SECRET: "1234567890abcdef1234567890abcdef",
    TIMENOOK_WECHAT_PAY_MODE: "ordinary-merchant",
    TIMENOOK_WECHAT_PAY_MERCHANT_ID: "1900000001",
    TIMENOOK_WECHAT_PAY_API_V3_KEY: "1234567890abcdef1234567890abcdef",
    TIMENOOK_WECHAT_PAY_MERCHANT_PRIVATE_KEY_PATH: join(root, "merchant.key"),
    TIMENOOK_WECHAT_PAY_MERCHANT_CERT_PATH: join(root, "merchant.crt"),
    TIMENOOK_WECHAT_PAY_PLATFORM_KEY_ID:
      "PUB_KEY_ID_01123456789012345678901234567890",
    TIMENOOK_WECHAT_PAY_PLATFORM_PUBLIC_KEY_PATH: join(root, "platform.pub"),
    TIMENOOK_WECHAT_PAY_NOTIFY_URL:
      "https://timenookapi.threeminreading.com/api/v1/webhooks/wechat-pay/payments",
  };
});
after(() => rmSync(root, { recursive: true, force: true }));

test("ordinary merchant configuration cannot be partially or implicitly enabled", () => {
  for (const payment of [
    { TIMENOOK_WECHAT_PAY_MODE: "ordinary-merchant" },
    { TIMENOOK_WECHAT_PAY_MERCHANT_ID: "1900000001" },
    { TIMENOOK_WECHAT_PAY_MODE: "local-verification" },
  ]) {
    assert.throws(() => readConfig({ ...base, ...payment }), /payment/i);
  }
});

test("ordinary merchant reads independent identity and matched certificate material from server files", () => {
  const cfg = readConfig(ordinary);
  assert.equal(cfg.payments?.mode, "ordinary-merchant");
  assert.equal(cfg.payments?.appId, ordinary.TIMENOOK_WECHAT_APP_ID);
  assert.equal(
    cfg.payments?.merchantSerial,
    new X509Certificate(readFileSync(join(root, "merchant.crt"))).serialNumber,
  );
  assert.equal(
    cfg.payments?.merchantPrivateKey,
    readFileSync(join(root, "merchant.key"), "utf8"),
  );
});

test("ordinary merchant configuration rejects synthetic identity secrets and private-material errors without exposing them", () => {
  const wrong = generateKeyPairSync("rsa", { modulusLength: 2048 });
  writeFileSync(
    join(root, "wrong.key"),
    wrong.privateKey.export({ type: "pkcs8", format: "pem" }),
    { mode: 0o600 },
  );
  for (const override of [
    { TIMENOOK_WECHAT_APP_SECRET: "synthetic-secret" },
    { TIMENOOK_WECHAT_APP_ID: "", TIMENOOK_WECHAT_APP_SECRET: "" },
    { TIMENOOK_WECHAT_PAY_MERCHANT_PRIVATE_KEY_PATH: join(root, "wrong.key") },
    { TIMENOOK_WECHAT_PAY_MERCHANT_PRIVATE_KEY_PATH: "relative-private.key" },
    { TIMENOOK_WECHAT_PAY_API_V3_KEY: "private-invalid-short" },
    { TIMENOOK_WECHAT_PAY_PLATFORM_KEY_ID: "AB12" },
    {
      TIMENOOK_WECHAT_PAY_NOTIFY_URL:
        "https://example.com/timenook/v1/webhooks/wechat-pay/payments",
    },
  ]) {
    assert.throws(
      () => readConfig({ ...ordinary, ...override }),
      (error: unknown) => {
        assert.match(String(error), /payment configuration/);
        assert.doesNotMatch(
          String(error),
          /synthetic-secret|relative-private|BEGIN|private-invalid-short/,
        );
        return true;
      },
    );
  }
});

test("ordinary merchant runtime reaches the privacy gate with native transport and rejects transport substitution", async () => {
  const cfg = readConfig(ordinary);
  await assert.rejects(createApplication(cfg), /independent privacy journal/);
  await assert.rejects(
    createApplication(cfg, { paymentFetch: async () => new Response("{}") }),
    /payment.*transport|ordinary merchant/i,
  );
  await assert.rejects(
    createApplication({ ...cfg, environment: "test" }),
    /payment|ordinary merchant/i,
  );
});

test("ordinary merchant isolated tests require explicit external transport and never default to the native network", async () => {
  const cfg = readConfig({ ...ordinary, NODE_ENV: "test" });
  await assert.rejects(createApplication(cfg), /payment.*transport/i);
  await assert.rejects(
    createApplication(cfg, { paymentFetch: fetch }),
    /payment.*transport/i,
  );
  await assert.rejects(
    createApplication(cfg, { paymentFetch: async () => new Response("{}") }),
    /independent privacy journal/,
  );
});

test("disabled payment callbacks return a retryable refusal without consuming any notice", async () => {
  const app = await createApplication(readConfig(base));
  try {
    for (const kind of ["payments", "refunds"]) {
      const response = await app.inject({
        method: "POST",
        url: `/v1/webhooks/wechat-pay/${kind}`,
        payload: {},
      });
      assert.equal(response.statusCode, 503);
      assert.equal(response.json().error.code, "SERVICE_UNAVAILABLE");
    }
  } finally {
    await app.close();
  }
});

test("ordinary merchant and controlled acceptance retain internal projects and native orders while preview purchases stay closed", async () => {
  assert.ok(process.env.DATABASE_URL);
  assert.ok(process.env.REDIS_URL);
  const schema = `t29_pay_${randomUUID().replaceAll("-", "")}`;
  const databaseUrl = new URL(process.env.DATABASE_URL);
  databaseUrl.searchParams.set("schema", schema);
  const cfg = readConfig({
    ...ordinary,
    DATABASE_URL: databaseUrl.toString(),
    REDIS_URL: process.env.REDIS_URL,
    REDIS_KEY_PREFIX: schema,
    INTERNAL_ACCEPTANCE_ENABLED: "1",
    WEB_ORIGIN: "https://localhost:3447",
    WEB_SESSION_KEY: randomBytes(32).toString("base64"),
  });
  const migration = spawnSync(
    process.execPath,
    ["node_modules/prisma/build/index.js", "migrate", "deploy"],
    {
      env: { ...process.env, DATABASE_URL: cfg.databaseUrl },
      encoding: "utf8",
    },
  );
  assert.equal(migration.status, 0, "isolated payment runtime migrations");
  await bootPrivacyFixture(cfg);
  const db = new PrismaClient({ datasourceUrl: cfg.databaseUrl });
  let app: Awaited<ReturnType<typeof createApplication>> | undefined;
  try {
    app = await createApplication(cfg);
    const origin = { origin: cfg.web!.origin, "x-timenook-web": "1" };
    assert.equal(
      (await app.inject({ method: "GET", url: "/v1/orders" })).statusCode,
      401,
    );
    const login = await app.inject({
      method: "POST",
      url: "/v1/web/mock-session",
      headers: origin,
      payload: {},
    });
    assert.equal(login.statusCode, 201, login.body);
    const actor = login.json().data;
    const cookie = (login.headers["set-cookie"] as string[])
      .map((value) => value.split(";")[0])
      .join("; ");
    const internal = await app.inject({
      method: "POST",
      url: "/v1/web/mock-purchases",
      headers: { ...origin, cookie, "x-csrf-token": actor.csrfToken },
      payload: {
        purchaseKey: randomUUID(),
        bookTitle: "内部故事书",
        subjectName: "讲述者",
      },
    });
    assert.equal(internal.statusCode, 201, internal.body);
    assert.equal(internal.json().data.source, "internal-acceptance");
    const projectId = internal.json().data.projectId;
    const projects = await app.inject({
      method: "GET",
      url: "/v1/web/projects",
      headers: { cookie },
    });
    assert.deepEqual(
      projects.json().data.projects.map((p: { id: string }) => p.id),
      [projectId],
    );
    const participation = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/participation`,
      headers: { cookie },
    });
    assert.equal(participation.statusCode, 200, participation.body);
    assert.equal(participation.json().data.noticeVersion, TERMS_VERSION);
    assert.equal(participation.json().data.canCollect, true);
    for (const kind of ["payments", "refunds"]) {
      const response: { statusCode: number } = await app.inject({
        method: "POST",
        url: `/v1/webhooks/wechat-pay/${kind}`,
        payload: {},
      });
      assert.equal(
        response.statusCode,
        400,
        "forged callbacks reach validation and never ACK",
      );
    }
    const purchase = await app.inject({
      method: "POST",
      url: "/v1/orders",
      headers: { "idempotency-key": "t29-purchase-preview" },
      payload: {
        packageVersionId: randomUUID(),
        recipient: {},
        shippingRegionCode: "CN-SH",
      },
    });
    assert.equal(
      purchase.statusCode,
      401,
      "ordinary checkout still requires the actual authenticated buyer",
    );
    assert.equal(await db.paymentOrder.count(), 0);
    assert.equal(await db.paymentInbox.count(), 0);
    assert.equal(await db.refundInbox.count(), 0);
    assert.equal(await db.firstCopyEntitlement.count(), 0);
    assert.equal(await db.wechatIdentity.count(), 0);
  } finally {
    await app?.close();
    await db.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    await db.$disconnect();
    const redis = new Redis(cfg.redisUrl),
      keys = await redis.keys(`${schema}:*`);
    if (keys.length) await redis.del(...keys);
    redis.disconnect();
    await closePrivacyFixture(cfg);
  }
});

test("ordinary merchant signed notifications and active queries share durable payment and refund accounting in the controlled app", async () => {
  const schema = `t129_pay_${randomUUID().replaceAll("-", "")}`;
  const databaseUrl = new URL(process.env.DATABASE_URL!);
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(databaseUrl.hostname));
  databaseUrl.searchParams.set("schema", schema);
  const cfg = readConfig({
    ...ordinary,
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl.toString(),
    REDIS_URL: process.env.REDIS_URL,
    REDIS_KEY_PREFIX: schema,
    INTERNAL_ACCEPTANCE_ENABLED: "1",
    WEB_ORIGIN: "https://localhost:3447",
    WEB_SESSION_KEY: randomBytes(32).toString("base64"),
    ADMIN_ORIGIN: "https://localhost:3443",
    ADMIN_SESSION_KEY: randomBytes(32).toString("base64"),
  });
  const migration = spawnSync(
    process.execPath,
    ["node_modules/prisma/build/index.js", "migrate", "deploy"],
    {
      env: { ...process.env, DATABASE_URL: cfg.databaseUrl },
      encoding: "utf8",
    },
  );
  assert.equal(migration.status, 0, "isolated ordinary merchant migrations");
  await bootPrivacyFixture(cfg);
  const db = new PrismaClient({ datasourceUrl: cfg.databaseUrl });
  const cfgPay = cfg.payments!;
  const signed = (body: string) =>
    signedPaymentHeaders(body, cfgPay.platformKeyId, platformPrivateKey);
  const providerOrders = new Map<string, Record<string, unknown>>();
  const providerRefunds = new Map<string, Record<string, unknown>>();
  let queryStarted: (() => void) | undefined;
  const paymentFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input)),
      method = init?.method ?? "GET",
      body = String(init?.body ?? "");
    assert.equal(url.origin, "https://api.mch.weixin.qq.com");
    const auth = Object.fromEntries(
      [
        ...String(new Headers(init?.headers).get("authorization")).matchAll(
          /(\w+)="([^"]+)"/g,
        ),
      ].map((match) => [match[1], match[2]]),
    );
    assert.equal(auth.mchid, cfgPay.merchantId);
    assert.equal(auth.serial_no, cfgPay.merchantSerial);
    assert.ok(
      verify(
        "RSA-SHA256",
        Buffer.from(
          `${method}\n${url.pathname + url.search}\n${auth.timestamp}\n${auth.nonce_str}\n${body}\n`,
        ),
        createPublicKey(cfgPay.merchantPrivateKey),
        Buffer.from(auth.signature, "base64"),
      ),
    );
    const payload = body ? JSON.parse(body) : {};
    let result: Record<string, unknown> | undefined;
    if (url.pathname === "/v3/pay/transactions/jsapi" && method === "POST") {
      assert.equal(payload.appid, cfgPay.appId);
      assert.equal(payload.notify_url, cfgPay.notifyUrl);
      providerOrders.set(payload.out_trade_no, {
        ...payload,
        trade_state: "NOTPAY",
      });
      result = { prepay_id: `isolated-${payload.out_trade_no}` };
    } else if (
      url.pathname === "/v3/refund/domestic/refunds" &&
      method === "POST"
    ) {
      assert.equal(
        payload.notify_url,
        "https://timenookapi.threeminreading.com/api/v1/webhooks/wechat-pay/refunds",
      );
      const refundResult = {
        ...payload,
        transaction_id: providerOrders.get(payload.out_trade_no)!
          .transaction_id,
        refund_id: `isolated-${payload.out_refund_no}`,
        status: "PROCESSING",
      };
      providerRefunds.set(payload.out_refund_no, refundResult);
      result = refundResult;
    } else if (
      url.pathname.startsWith("/v3/refund/domestic/refunds/") &&
      method === "GET"
    ) {
      result = providerRefunds.get(url.pathname.split("/").at(-1)!);
    } else if (
      url.pathname.startsWith("/v3/pay/transactions/out-trade-no/") &&
      method === "GET"
    ) {
      assert.equal(url.searchParams.get("mchid"), cfgPay.merchantId);
      result = providerOrders.get(url.pathname.split("/").at(-1)!);
    }
    assert.ok(
      result,
      "only isolated provider requests explicitly prepared by this test are allowed",
    );
    if (method === "GET") queryStarted?.();
    const raw = JSON.stringify(result);
    return new Response(raw, { status: 200, headers: signed(raw) });
  };
  const wechatCodes = new Map<string, string>();
  const code = (openId: string) => {
    const value = randomUUID();
    wechatCodes.set(value, openId);
    return value;
  };
  const wechatFetch: typeof fetch = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://api.weixin.qq.com");
    assert.equal(url.searchParams.get("appid"), cfgPay.appId);
    return new Response(
      JSON.stringify({
        openid: wechatCodes.get(url.searchParams.get("js_code") ?? ""),
        session_key: "isolated",
      }),
    );
  };
  let app: Awaited<ReturnType<typeof createApplication>> | undefined;
  try {
    app = await createAdminApplication(cfg, { paymentFetch, wechatFetch });
    const origin = { origin: cfg.web!.origin, "x-timenook-web": "1" };
    const webLogin = await app.inject({
      method: "POST",
      url: "/v1/web/mock-session",
      headers: origin,
      payload: {},
    });
    assert.equal(webLogin.statusCode, 201, webLogin.body);
    const webActor = webLogin.json().data;
    const cookie = String(webLogin.headers["set-cookie"]).split(";")[0];
    const webHeaders = {
      ...origin,
      cookie,
      "x-csrf-token": webActor.csrfToken,
    };
    const challenge = await app.inject({
      method: "POST",
      url: "/v1/web/wechat-link",
      headers: webHeaders,
      payload: {},
    });
    assert.equal(challenge.statusCode, 201, challenge.body);
    const claimed = await app.inject({
      method: "POST",
      url: "/v1/wechat-links/claim",
      payload: {
        linkCode: challenge.json().data.challenge.code,
        code: code("isolated-buyer"),
      },
    });
    assert.equal(claimed.statusCode, 201, claimed.body);
    const pair = claimed.json().data;
    const nativeConfirmed = await app.inject({
      method: "POST",
      url: "/v1/wechat-links/confirm",
      payload: {
        proof: pair.proof,
        verificationCode: pair.challenge.verificationCode,
        code: code("isolated-buyer"),
      },
    });
    assert.equal(nativeConfirmed.statusCode, 201, nativeConfirmed.body);
    const linked = await app.inject({
      method: "POST",
      url: `/v1/web/wechat-link/${pair.challenge.id}/confirm`,
      headers: webHeaders,
      payload: { verificationCode: pair.challenge.verificationCode },
    });
    assert.equal(linked.statusCode, 201, linked.body);
    assert.equal(linked.json().data.challenge.state, "linked");
    const login = async (openId: string) => {
      const response = await app!.inject({
        method: "POST",
        url: "/v1/sessions/wechat",
        payload: { code: code(openId) },
      });
      assert.equal(response.statusCode, 201, response.body);
      return response.json().data;
    };
    const buyer = await login("isolated-buyer"),
      stranger = await login("isolated-stranger");
    assert.deepEqual(buyer.user, webActor.user);
    const auth = { authorization: `Bearer ${buyer.session.token}` };
    const snapshot = JSON.parse(
      readFileSync("test/fixtures/catalog-synthetic.json", "utf8"),
    );
    const draftId = randomUUID(),
      versionId = randomUUID();
    await db.packageDraft.create({
      data: { id: draftId, realm: "local", ...snapshot },
    });
    await db.packageVersion.create({
      data: {
        id: versionId,
        realm: "local",
        purpose: "local_preview",
        draftId,
        draftRevision: 1,
        snapshot,
        publicOffer: {},
      },
    });
    // Existing order fixture only: ordinary merchant creation stays publicly blocked.
    const fixtureOrder = async (
      appId = cfgPay.appId,
      merchantId = cfgPay.merchantId,
    ) =>
      db.paymentOrder.create({
        data: {
          id: randomUUID(),
          buyerId: buyer.user.id,
          appId,
          openId: "isolated-buyer",
          merchantId,
          outTradeNo: "TN" + randomUUID().replaceAll("-", "").slice(0, 30),
          idempotencyKey: randomUUID(),
          requestHash: "a".repeat(64),
          amount: 99900,
          currency: "CNY",
          mode: "wechat",
          packageVersionId: versionId,
          packageSnapshot: snapshot,
          recipient: { typeCode: null, relationshipLabel: "讲述者" },
          template: JSON.parse(JSON.stringify(BUILTIN_TEMPLATE)),
          shippingRegionCode: "CN-110000",
          bookTitle: "隔离协议验证",
        },
      });
    const order = await fixtureOrder();
    await db.wechatIdentity.create({
      data: {
        appId: "wx0000000000000000",
        openId: "isolated-buyer",
        userId: buyer.user.id,
      },
    });
    await fixtureOrder("wx0000000000000000");
    await fixtureOrder(cfgPay.appId, "1900000002");
    const list = await app.inject({
      method: "GET",
      url: "/v1/orders",
      headers: auth,
    });
    assert.equal(list.statusCode, 200, list.body);
    assert.deepEqual(
      list.json().data.orders.map((row: { id: string }) => row.id),
      [order.id],
    );
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: `/v1/orders/${order.id}`,
          headers: { authorization: `Bearer ${stranger.session.token}` },
        })
      ).statusCode,
      404,
    );
    const webPrepare = await app.inject({
      method: "POST",
      url: `/v1/orders/${order.id}/payment`,
      headers: { ...webHeaders, "idempotency-key": randomUUID() },
      payload: {},
    });
    assert.equal(
      webPrepare.statusCode,
      403,
      "a linked web account cannot request real JSAPI checkout parameters",
    );
    const prepare = await app.inject({
      method: "POST",
      url: `/v1/orders/${order.id}/payment`,
      headers: { ...auth, "idempotency-key": randomUUID() },
      payload: {},
    });
    assert.equal(prepare.statusCode, 201, prepare.body);
    assert.equal(prepare.json().data.mode, "wechat");
    assert.equal(prepare.json().data.status, "prepared");
    assert.match(
      prepare.json().data.parameters.package,
      /^prepay_id=isolated-/,
    );
    const webOrders = await app.inject({
      method: "GET",
      url: "/v1/orders",
      headers: { cookie },
    });
    assert.equal(webOrders.statusCode, 200, webOrders.body);
    assert.deepEqual(
      webOrders.json().data.orders.map((row: { id: string }) => row.id),
      [order.id],
    );
    for (const headers of [auth, { cookie }]) {
      const ownOrder: Awaited<ReturnType<typeof app.inject>> = await app.inject(
        {
          method: "GET",
          url: `/v1/orders/${order.id}`,
          headers,
        },
      );
      assert.equal(ownOrder.statusCode, 200, ownOrder.body);
      assert.equal(ownOrder.json().data.id, order.id);
      assert.equal(ownOrder.json().data.state, "pending");
    }
    const transaction = {
      ...providerOrders.get(order.outTradeNo)!,
      trade_state: "SUCCESS",
      transaction_id: "isolated-transaction",
      success_time: new Date().toISOString(),
    };
    providerOrders.set(order.outTradeNo, transaction);
    const notify = (
      kind: "payments" | "refunds",
      value: Record<string, unknown>,
      id: string,
      badSignature = false,
    ) => {
      const raw = encryptedPaymentNotification(
        value,
        cfgPay.apiV3Key,
        id,
        kind === "payments" ? "transaction" : "refund",
        kind === "payments" ? "TRANSACTION.SUCCESS" : "REFUND.SUCCESS",
      );
      return app!.inject({
        method: "POST",
        url: `/v1/webhooks/wechat-pay/${kind}`,
        headers: {
          ...signed(raw),
          ...(badSignature ? { "Wechatpay-Signature": "invalid" } : {}),
          "content-type": "application/json",
        },
        payload: raw,
      });
    };
    assert.equal(
      (await notify("payments", transaction, "forged-payment", true))
        .statusCode,
      400,
    );
    for (const overrides of [
      { appid: "wx0000000000000000" },
      { mchid: "1900000002" },
      { out_trade_no: "TNunknown" },
      { amount: { total: 1, currency: "CNY" } },
      { payer: { openid: "isolated-stranger" } },
    ])
      assert.equal(
        (
          await notify(
            "payments",
            { ...transaction, ...overrides },
            randomUUID(),
          )
        ).statusCode,
        400,
      );
    assert.equal(await db.paymentInbox.count(), 0);
    const paymentQueryStarted = new Promise<void>((resolve) => {
      queryStarted = resolve;
    });
    const paymentQuery = app.inject({
      method: "GET",
      url: `/v1/orders/${order.id}`,
      headers: auth,
    });
    await paymentQueryStarted;
    const results = await Promise.all([
      notify("payments", transaction, "ordinary-payment"),
      notify("payments", transaction, "ordinary-payment"),
      paymentQuery,
    ]);
    assert.equal(results[0].statusCode, 204, results[0].body);
    assert.equal(results[1].statusCode, 204, results[1].body);
    const paid = results[2].json().data;
    assert.equal(paid.state, "paid");
    assert.equal(paid.project.entitlement.state, "available");
    assert.equal(await db.paymentInbox.count(), 1);
    assert.equal(await db.paymentTransaction.count(), 1);
    assert.equal(await db.firstCopyEntitlement.count(), 1);
    assert.equal(await db.internalProjectAdmission.count(), 0);
    assert.equal(
      (
        await notify(
          "payments",
          {
            ...transaction,
            success_time: new Date(Date.now() - 1000).toISOString(),
          },
          "ordinary-payment",
        )
      ).statusCode,
      409,
    );
    const admin = await paymentAdmin(cfg, app, ["care:write"]);
    const requested = await app.inject({
      method: "POST",
      url: `/v1/orders/${order.id}/refunds`,
      headers: { ...auth, "idempotency-key": randomUUID() },
      payload: {
        reason: "notParticipated",
        evidenceRef: "synthetic:isolated-protocol-request",
      },
    });
    assert.equal(requested.statusCode, 201, requested.body);
    const refund = requested.json().data;
    const adminCommand = (action: string, payload: object = {}) =>
      app!.inject({
        method: "POST",
        url: `/v1/admin/refunds/${refund.id}/${action}`,
        headers: { ...admin, "idempotency-key": randomUUID() },
        payload,
      });
    const approved = await adminCommand("approve", {
      amountFen: 99900,
      evidenceRef: "synthetic:isolated-protocol-review",
    });
    assert.equal(approved.statusCode, 201, approved.body);
    const submitted = await adminCommand("submit");
    assert.equal(submitted.statusCode, 201, submitted.body);
    assert.equal(submitted.json().data.state, "processing");
    const refundResult = {
      ...providerRefunds.get(refund.outRefundNo)!,
      status: "SUCCESS",
      mchid: cfgPay.merchantId,
      refund_status: "SUCCESS",
      success_time: new Date().toISOString(),
    };
    providerRefunds.set(refund.outRefundNo, refundResult);
    assert.equal(
      (await notify("refunds", refundResult, "forged-refund", true)).statusCode,
      400,
    );
    for (const overrides of [
      { mchid: "1900000002" },
      { out_trade_no: "TNunknown" },
      { amount: { total: 99900, refund: 1, currency: "CNY" } },
    ])
      assert.equal(
        (
          await notify(
            "refunds",
            { ...refundResult, ...overrides },
            randomUUID(),
          )
        ).statusCode,
        400,
      );
    assert.equal(await db.refundInbox.count(), 0);
    const refundQueryStarted = new Promise<void>((resolve) => {
      queryStarted = resolve;
    });
    const refundQuery = adminCommand("reconcile");
    await refundQueryStarted;
    const refundResults = await Promise.all([
      notify("refunds", refundResult, "ordinary-refund"),
      notify("refunds", refundResult, "ordinary-refund"),
      refundQuery,
    ]);
    assert.equal(refundResults[0].statusCode, 204, refundResults[0].body);
    assert.equal(refundResults[1].statusCode, 204, refundResults[1].body);
    assert.equal(
      refundResults[2].json().data.state,
      "succeeded",
      refundResults[2].body,
    );
    assert.equal(
      (
        await notify(
          "refunds",
          {
            ...refundResult,
            success_time: new Date(Date.now() - 1000).toISOString(),
          },
          "ordinary-refund",
        )
      ).statusCode,
      409,
    );
    assert.equal(await db.refundInbox.count(), 1);
    await app.close();
    app = await createAdminApplication(cfg, { paymentFetch, wechatFetch });
    assert.equal(
      (await notify("payments", transaction, "ordinary-payment")).statusCode,
      204,
    );
    assert.equal(
      (await notify("refunds", refundResult, "ordinary-refund")).statusCode,
      204,
    );
    assert.equal(await db.paymentInbox.count(), 1);
    assert.equal(await db.refundInbox.count(), 1);
    const balance = await app.inject({
      method: "GET",
      url: `/v1/orders/${order.id}/refunds`,
      headers: auth,
    });
    assert.equal(balance.statusCode, 200, balance.body);
    assert.equal(balance.json().data.refundedAmountFen, 99900);
    assert.equal(balance.json().data.reservedAmountFen, 0);
    const final = await app.inject({
      method: "GET",
      url: `/v1/orders/${order.id}`,
      headers: auth,
    });
    assert.equal(final.json().data.project.entitlement.state, "revoked");
    assert.equal(final.json().data.state, "paid");
  } finally {
    await app?.close();
    await db.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    await db.$disconnect();
    const redis = new Redis(cfg.redisUrl),
      keys = await redis.keys(`${schema}:*`);
    if (keys.length) await redis.del(...keys);
    redis.disconnect();
    await closePrivacyFixture(cfg);
  }
});

test("one-fen checkout requires an explicit switch, ordinary merchant and product user UUID allowlist", () => {
  const userId = randomUUID();
  const enabled = {
    ...ordinary,
    INTERNAL_ACCEPTANCE_ENABLED: "1",
    TIMENOOK_CHECKOUT_E2E_ENABLED: "1",
    TIMENOOK_CHECKOUT_E2E_USER_IDS: userId,
  };
  assert.deepEqual(readConfig(enabled).checkoutE2e, {
    enabled: true,
    userIds: [userId],
  });
  for (const override of [
    { TIMENOOK_CHECKOUT_E2E_ENABLED: undefined },
    { TIMENOOK_CHECKOUT_E2E_ENABLED: "true" },
    { TIMENOOK_CHECKOUT_E2E_USER_IDS: "" },
    { TIMENOOK_CHECKOUT_E2E_USER_IDS: "openid-is-not-user-id" },
    { INTERNAL_ACCEPTANCE_ENABLED: undefined },
    { TIMENOOK_WECHAT_PAY_MODE: "" },
  ])
    assert.throws(
      () => readConfig({ ...enabled, ...override }),
      /E2E|payment/i,
    );
  assert.equal(readConfig(ordinary).checkoutE2e, undefined);
});
