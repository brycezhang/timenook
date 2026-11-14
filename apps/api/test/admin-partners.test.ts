import {
  withWechatProfile,
  phoneLogin,
  verifiedPhone,
} from "./wechat-profile-fixture";
import {
  syntheticFeishu,
  createSyntheticFeishuFetch,
  authenticateFeishu,
  adminCookie,
} from "./admin-feishu-fixture";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { after, before, test } from "node:test";
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import { createApplication } from "../src/application";
import type { ApiConfig } from "../src/config";

const schema = `partner_${randomUUID().replaceAll("-", "")}`;
let config: ApiConfig;
let app: Awaited<ReturnType<typeof createApplication>>;
before(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.set("schema", schema);
  config = {
    environment: "test",
    wechat: { appId: "synthetic-cg02", secret: "synthetic" },
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
  config.admin!.feishu = { ...syntheticFeishu };
  app = await createApplication(config, {
    feishuFetch: createSyntheticFeishuFetch(config.admin!.origin),
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

const headers = (auth: { cookie: string; csrf: string }) => ({
  cookie: auth.cookie,
  origin: config.admin!.origin,
  "x-csrf-token": auth.csrf,
});
async function partnerLogin(username: string, password: string) {
  const initial = await app.inject({ method: "GET", url: "/v1/admin/session" });
  const auth = {
    cookie: adminCookie(initial),
    csrf: initial.json().data.csrfToken,
  };
  const response = await app.inject({
    method: "POST",
    url: "/v1/admin/partner/login",
    headers: headers(auth),
    payload: { username, password },
  });
  return {
    response,
    cookie: adminCookie(response),
    csrf: response.json().data?.csrfToken,
  };
}
test("super admin generates one-time partner credentials; password session is restricted and revocation is immediate", async () => {
  const owner = await authenticateFeishu(config, app);
  const created = await app.inject({
    method: "POST",
    url: "/v1/admin/partners",
    headers: headers(owner),
    payload: {},
  });
  assert.equal(created.statusCode, 201);
  const account = created.json().data;
  assert.ok(account.password.length >= 24);
  const partner = await partnerLogin(account.username, account.password);
  assert.equal(partner.response.statusCode, 200);
  assert.equal(partner.response.json().data.operator.role, "partner");
  assert.deepEqual(partner.response.json().data.operator.permissions.sort(), [
    "channel-gifts:read",
    "channel-gifts:write",
  ]);
  for (const url of [
    "/runtime",
    "/audit",
    "/orders",
    "/users",
    "/partners",
    "/catalog/package-versions",
  ])
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: "/v1/admin" + url,
          headers: headers(partner),
        })
      ).statusCode,
      403,
      url,
    );
  const listed = await app.inject({
    method: "GET",
    url: "/v1/admin/partners",
    headers: headers(owner),
  });
  assert.equal(listed.statusCode, 200);
  assert.ok(!listed.body.includes(account.password));
  assert.ok(!listed.body.includes("passwordHash"));
  const revoked = await app.inject({
    method: "POST",
    url: `/v1/admin/partners/${account.id}/revoke`,
    headers: headers(owner),
    payload: {},
  });
  assert.equal(revoked.statusCode, 200);
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: "/v1/admin/orders",
        headers: headers(partner),
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (await partnerLogin(account.username, account.password)).response
      .statusCode,
    401,
  );
});

test("partner records are owner-scoped and redacted, remain visible to buyer after revocation, and writes require CSRF", async () => {
  const db = new PrismaClient({ datasourceUrl: config.databaseUrl });
  try {
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
        snapshot: { title: "时光故事书" },
        publicOffer: { title: "时光故事书" },
      },
    });
  } finally {
    await db.$disconnect();
  }
  const owner = await authenticateFeishu(config, app);
  const credentials = (
    await app.inject({
      method: "POST",
      url: "/v1/admin/partners",
      headers: headers(owner),
      payload: {},
    })
  ).json().data;
  const partner = await partnerLogin(
    credentials.username,
    credentials.password,
  );
  const phone = verifiedPhone("synthetic-cg02", "buyer-cg02");
  const create = (actor: { cookie: string; csrf: string }, extra = {}) =>
    app.inject({
      method: "POST",
      url: "/v1/admin/channel-gifts",
      headers: { ...headers(actor), "idempotency-key": randomUUID() },
      payload: { buyerPhone: phone, ...extra },
    });
  assert.equal((await create({ ...partner, csrf: "wrong" })).statusCode, 403);
  assert.equal(
    (await create(partner, { operatorId: owner.account.id })).statusCode,
    400,
  );
  const recorded = await create(partner);
  assert.equal(recorded.statusCode, 201, recorded.body);
  const gift = recorded.json().data;
  assert.equal(gift.operatorId, credentials.id);
  assert.equal(gift.buyerPhone, null);
  assert.equal(gift.buyerId, null);
  assert.equal(gift.usageStatus, "pending");
  const foreign = (await create(owner)).json().data;
  const own = await app.inject({
    method: "GET",
    url: `/v1/admin/channel-gifts?operatorId=${owner.account.id}`,
    headers: headers(partner),
  });
  assert.deepEqual(
    own.json().data.map((r: { id: string }) => r.id),
    [gift.id],
  );
  assert.ok(!own.body.includes(phone));
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: `/v1/admin/channel-gifts/${foreign.id}`,
        headers: headers(partner),
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/admin/partners",
        headers: headers(partner),
        payload: {},
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/v1/admin/partners/${credentials.id}/revoke`,
        headers: headers(partner),
        payload: {},
      })
    ).statusCode,
    403,
  );
  const login = await app.inject({
    method: "POST",
    url: "/v1/sessions/wechat",
    payload: { code: "buyer-cg02", ...phoneLogin() },
  });
  assert.equal(login.statusCode, 201, login.body);
  const buyerHeaders = {
    authorization: `Bearer ${login.json().data.session.token}`,
  };
  const readBuyer = () =>
    app.inject({
      method: "GET",
      url: "/v1/channel-gifts",
      headers: buyerHeaders,
    });
  const before = await readBuyer();
  assert.equal(before.statusCode, 200, before.body);
  assert.ok(before.json().data.some((r: { id: string }) => r.id === gift.id));
  await app.inject({
    method: "POST",
    url: `/v1/admin/partners/${credentials.id}/revoke`,
    headers: headers(owner),
    payload: {},
  });
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: "/v1/admin/channel-gifts",
        headers: headers(partner),
      })
    ).statusCode,
    401,
  );
  assert.ok(
    (await readBuyer())
      .json()
      .data.some((r: { id: string }) => r.id === gift.id),
  );
  const all = await app.inject({
    method: "GET",
    url: "/v1/admin/channel-gifts",
    headers: headers(owner),
  });
  assert.ok(
    all
      .json()
      .data.some(
        (r: { id: string; operatorId: string }) =>
          r.id === gift.id && r.operatorId === credentials.id,
      ),
  );
  const audit = await app.inject({
    method: "GET",
    url: "/v1/admin/audit",
    headers: headers(owner),
  });
  assert.ok(!audit.body.includes(credentials.password));
});
test("password login rejects cross-site requests, logout invalidates authority, and repeated failures are rate limited", async () => {
  const owner = await authenticateFeishu(config, app);
  const credentials = (
    await app.inject({
      method: "POST",
      url: "/v1/admin/partners",
      headers: headers(owner),
      payload: {},
    })
  ).json().data;
  const initial = await app.inject({ method: "GET", url: "/v1/admin/session" });
  const challenge = {
    cookie: adminCookie(initial),
    csrf: initial.json().data.csrfToken,
  };
  for (const overrides of [
    { origin: "https://foreign.example" },
    { "x-csrf-token": "wrong" },
    { "sec-fetch-site": "cross-site" },
  ]) {
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/v1/admin/partner/login",
          headers: { ...headers(challenge), ...overrides },
          payload: {
            username: credentials.username,
            password: credentials.password,
          },
        })
      ).statusCode,
      403,
    );
  }
  const partner = await partnerLogin(
    credentials.username,
    credentials.password,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/admin/logout",
        headers: headers(partner),
      })
    ).statusCode,
    204,
  );
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: "/v1/admin/channel-gifts",
        headers: headers(partner),
      })
    ).statusCode,
    401,
  );
  const unknown = "unknown_" + randomUUID();
  for (let n = 0; n < 10; n++)
    assert.equal(
      (await partnerLogin(unknown, "incorrect")).response.statusCode,
      401,
    );
  assert.equal(
    (await partnerLogin(unknown, "incorrect")).response.statusCode,
    429,
  );
});
