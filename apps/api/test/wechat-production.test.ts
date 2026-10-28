import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { generateKeyPairSync, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { readConfig } from "../src/config";
import { createApplication } from "../src/application";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { bootPrivacyFixture, closePrivacyFixture } from "./privacy-fixture";

const base: NodeJS.ProcessEnv = {
  NODE_ENV: "development",
  DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/unused",
  REDIS_URL: "redis://127.0.0.1:1",
};
let root: string;
let ordinary: NodeJS.ProcessEnv;
before(() => {
  root = mkdtempSync(join(tmpdir(), "t29-pay-"));
  const merchant = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const platform = generateKeyPairSync("rsa", { modulusLength: 2048 });
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
    { NODE_ENV: "test" },
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

test("ordinary merchant runtime exposes authenticated callback handlers while preview purchases stay closed", async () => {
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
      403,
      "merchant wiring does not authorize preview sales",
    );
    assert.equal(await db.paymentOrder.count(), 0);
    assert.equal(await db.paymentInbox.count(), 0);
    assert.equal(await db.refundInbox.count(), 0);
  } finally {
    await app?.close();
    await db.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    await db.$disconnect();
    await closePrivacyFixture(cfg);
  }
});
