import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import { createApplication } from "../src/application";
import type { ApiConfig } from "../src/config";
import {
  syntheticFeishu,
  syntheticFeishuFetch,
  createFeishuAccount,
  adminCookie,
  beginFeishu,
  authenticateFeishu,
} from "./admin-feishu-fixture";
const origin = "https://localhost:3443";
const schema = `admin_${randomUUID().replaceAll("-", "")}`;
const privateDir = mkdtempSync(join(tmpdir(), "feishu-admin-test-"));
let config: ApiConfig,
  app: Awaited<ReturnType<typeof createApplication>>,
  db: PrismaClient,
  redis: Redis;
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
      origin,
      sessionKey: randomBytes(32).toString("base64"),
      sessionTtlSeconds: 28800,
      challengeTtlSeconds: 300,
      feishu: { ...syntheticFeishu },
    },
  };
  const migration = spawnSync(
    process.execPath,
    ["node_modules/prisma/build/index.js", "migrate", "deploy"],
    {
      env: { ...process.env, DATABASE_URL: config.databaseUrl },
      encoding: "utf8",
    },
  );
  assert.equal(migration.status, 0, "isolated migration");
  db = new PrismaClient({ datasourceUrl: config.databaseUrl });
  redis = new Redis(config.redisUrl);
  app = await createApplication(config, { feishuFetch: syntheticFeishuFetch });
});
beforeEach(async () => {
  const keys = await redis.keys(`${schema}:admin:oauth-start:*`);
  if (keys.length) await redis.del(...keys);
});
after(async () => {
  await app?.close();
  rmSync(privateDir, { recursive: true, force: true });
  if (!db) return;
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
  origin,
  "x-csrf-token": auth.csrf,
});
const code = (account: { feishuOpenId: string; tenantKey: string }) =>
  Buffer.from(JSON.stringify(account)).toString("base64url");
const callback = (
  flow: Awaited<ReturnType<typeof beginFeishu>>,
  value: string,
  cookie = flow.flowCookie,
  target = app,
) =>
  target.inject({
    method: "GET",
    url: `/v1/admin/feishu/callback?state=${flow.state}&code=${value}`,
    headers: { cookie, "sec-fetch-site": "cross-site" },
  });
const runtime = (cookie?: string, target = app) =>
  target.inject({
    method: "GET",
    url: "/v1/admin/runtime",
    headers: cookie ? { cookie } : {},
  });
function cliInput(input: unknown, command = "create", mode = 0o600) {
  const path = join(privateDir, `${randomUUID()}.json`);
  writeFileSync(path, JSON.stringify(input), { mode });
  const env = {
    ...process.env,
    NODE_ENV: "test",
    DATABASE_URL: config.databaseUrl,
    ADMIN_ORIGIN: origin,
    ADMIN_SESSION_KEY: config.admin!.sessionKey,
    ADMIN_FEISHU_APP_ID: syntheticFeishu.appId,
    ADMIN_FEISHU_APP_SECRET: syntheticFeishu.appSecret,
    ADMIN_FEISHU_TENANT_KEY: syntheticFeishu.tenantKey,
  };
  return {
    path,
    env,
    result: spawnSync(
      process.execPath,
      ["dist-test/src/admin/admin-cli.js", command, "--input-file", path],
      { env, encoding: "utf8" },
    ),
  };
}
test("anonymous/product identities cannot access administration; password and MFA endpoints are removed", async () => {
  assert.equal((await runtime()).statusCode, 401);
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: "/v1/admin/runtime",
        headers: { authorization: "Bearer synthetic-product-token" },
      })
    ).statusCode,
    401,
  );
  for (const [method, url] of [
    ["POST", "/v1/admin/login"],
    ["POST", "/v1/admin/mfa"],
    ["GET", "/v1/admin/mfa/enrollment"],
  ] as const)
    assert.equal((await app.inject({ method, url })).statusCode, 404);
});
test("whitelisted Feishu login directly issues a rotated protected session without MFA", async () => {
  const auth = await authenticateFeishu(config, app);
  assert.notEqual(auth.cookie, auth.challenge.cookie);
  assert.equal((await runtime(auth.cookie)).statusCode, 200);
  assert.equal((await runtime(auth.challenge.cookie)).statusCode, 401);
  const cookie = String(auth.response.headers["set-cookie"]);
  for (const pattern of [
    /Path=\/api\/v1\/admin;/,
    /HttpOnly/,
    /Secure/,
    /SameSite=Strict/,
  ])
    assert.match(cookie, pattern);
  const current = await app.inject({
    method: "GET",
    url: "/v1/admin/session",
    headers: { cookie: auth.cookie },
  });
  assert.equal(current.json().data.loginAvailable, true);
  assert.equal(current.json().data.mfaRequired, undefined);
  assert.equal(current.json().data.operator.username, auth.account.username);
  assert.equal(auth.response.headers.location, "/admin/");
});
test("OAuth state binds the browser, grants no pre-callback authority, and is consumed once", async () => {
  const account = createFeishuAccount(config),
    flow = await beginFeishu(config, app);
  assert.equal(
    flow.url.origin + flow.url.pathname,
    "https://accounts.feishu.cn/open-apis/authen/v1/authorize",
  );
  assert.equal(
    flow.url.searchParams.get("redirect_uri"),
    origin + "/api/v1/admin/feishu/callback",
  );
  assert.equal(flow.url.searchParams.get("client_id"), syntheticFeishu.appId);
  for (const field of [
    "code_challenge",
    "code_challenge_method",
    "code_verifier",
    "client_secret",
  ])
    assert.equal(
      flow.url.searchParams.has(field),
      false,
      `authorization URL omits ${field}`,
    );
  assert.equal(flow.url.searchParams.get("scope"), null);
  assert.match(String(flow.response.headers["set-cookie"]), /SameSite=Lax/);
  assert.equal((await runtime(flow.cookie)).statusCode, 401);
  const wrong = await callback(
    flow,
    code(account),
    "__Secure-timenook_oauth=" + randomBytes(32).toString("base64url"),
  );
  assert.equal(wrong.headers.location, "/admin/?login_error=denied");
  assert.equal(adminCookie(wrong), "");
  const results = await Promise.all([
    callback(flow, code(account)),
    callback(flow, code(account)),
  ]);
  assert.equal(
    results.filter((r) => r.headers.location === "/admin/").length,
    1,
  );
  assert.equal(results.filter((r) => !!adminCookie(r)).length, 1);
  const replay = await callback(flow, code(account));
  assert.equal(replay.headers.location, "/admin/?login_error=denied");
  assert.equal(adminCookie(replay), "");
});
test("confidential client exchanges the code at v3 with its server secret and exact callback, without PKCE", async () => {
  let tokenRequest:
    | { url: string; body: Record<string, unknown>; init?: RequestInit }
    | undefined;
  const target = await createApplication(config, {
    feishuFetch: async (input, init) => {
      if (String(input) === "https://accounts.feishu.cn/oauth/v3/token")
        tokenRequest = {
          url: String(input),
          body: JSON.parse(String(init?.body)),
          init,
        };
      return syntheticFeishuFetch(input, init);
    },
  });
  try {
    const account = createFeishuAccount(config),
      flow = await beginFeishu(config, target);
    const result = await callback(flow, code(account), flow.flowCookie, target);
    assert.ok(tokenRequest, "the current v3 endpoint receives the exchange");
    assert.deepEqual(
      Object.keys(tokenRequest.body).sort(),
      [
        "grant_type",
        "client_id",
        "client_secret",
        "code",
        "redirect_uri",
      ].sort(),
    );
    assert.equal(tokenRequest.body.client_secret, syntheticFeishu.appSecret);
    assert.equal(
      tokenRequest.body.redirect_uri,
      flow.url.searchParams.get("redirect_uri"),
    );
    assert.equal(result.headers.location, "/admin/");
    assert.equal((await runtime(adminCookie(result), target)).statusCode, 200);
  } finally {
    await target.close();
  }
});
test("unapproved, disabled, foreign-tenant, wrong-application identities cannot sign in", async () => {
  for (const kind of ["unknown", "disabled", "tenant", "app"] as const) {
    const account = createFeishuAccount(config);
    if (kind === "disabled")
      await db.adminAccount.update({
        where: { id: account.id },
        data: { disabled: true },
      });
    if (kind === "app")
      await db.adminAccount.update({
        where: { id: account.id },
        data: { feishuAppId: "cli_other_application" },
      });
    const identity = {
      ...account,
      ...(kind === "unknown" ? { feishuOpenId: "ou_not_approved" } : {}),
      ...(kind === "tenant" ? { tenantKey: "other-company" } : {}),
    };
    const response = await callback(
      await beginFeishu(config, app),
      code(identity),
    );
    assert.equal(response.headers.location, "/admin/?login_error=denied", kind);
    assert.equal(adminCookie(response), "", kind);
  }
});
test("authorization/logout require matching Origin and CSRF; all other routes retain cross-site rejection", async () => {
  const initial = await app.inject({ method: "GET", url: "/v1/admin/session" });
  const good = {
    cookie: adminCookie(initial),
    origin,
    "x-csrf-token": initial.json().data.csrfToken,
  };
  for (const supplied of [
    { cookie: good.cookie, origin },
    { ...good, origin: "https://foreign.example" },
    { ...good, "x-csrf-token": "wrong" },
    { ...good, "sec-fetch-site": "cross-site" },
  ])
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/v1/admin/feishu/login",
          headers: supplied,
        })
      ).statusCode,
      403,
    );
  const auth = await authenticateFeishu(config, app);
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: "/v1/admin/runtime",
        headers: { cookie: auth.cookie, "sec-fetch-site": "cross-site" },
      })
    ).statusCode,
    403,
  );
  for (const supplied of [
    { cookie: auth.cookie },
    { ...headers(auth), origin: "https://foreign.example" },
    { ...headers(auth), "x-csrf-token": "wrong" },
  ])
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/v1/admin/logout",
          headers: supplied,
        })
      ).statusCode,
      403,
    );
});
test("permission removal, disable, binding and current-config changes revoke existing authority", async () => {
  for (const kind of [
    "permission",
    "disable",
    "binding",
    "config",
    "delete",
  ] as const) {
    const auth = await authenticateFeishu(config, app);
    if (kind === "permission")
      await db.adminAccount.update({
        where: { id: auth.account.id },
        data: { permissions: [] },
      });
    if (kind === "disable")
      await db.adminAccount.update({
        where: { id: auth.account.id },
        data: { disabled: true },
      });
    if (kind === "binding")
      await db.adminAccount.update({
        where: { id: auth.account.id },
        data: { feishuOpenId: "ou_changed_binding" },
      });
    if (kind === "delete")
      await db.adminAccount.delete({ where: { id: auth.account.id } });
    if (kind === "config")
      config.admin!.feishu!.appId = "cli_other_application";
    try {
      assert.equal(
        (await runtime(auth.cookie)).statusCode,
        kind === "permission" ? 403 : 401,
        kind,
      );
    } finally {
      config.admin!.feishu!.appId = syntheticFeishu.appId;
    }
  }
});
test("logout revokes persistent authority; process restart retains only valid sessions", async () => {
  const auth = await authenticateFeishu(config, app),
    second = await authenticateFeishu(config, app),
    restarted = await createApplication(config, {
      feishuFetch: syntheticFeishuFetch,
    });
  try {
    assert.equal((await runtime(auth.cookie, restarted)).statusCode, 200);
    const result = await restarted.inject({
      method: "POST",
      url: "/v1/admin/logout",
      headers: headers(auth),
    });
    assert.equal(result.statusCode, 204);
    assert.match(String(result.headers["set-cookie"]), /Max-Age=0/);
    assert.equal((await runtime(auth.cookie)).statusCode, 401);
    assert.equal((await runtime(second.cookie)).statusCode, 200);
  } finally {
    await restarted.close();
  }
});
test("anonymous logout defeats a pending callback; stale logout never clears a new authenticated cookie", async () => {
  const account = createFeishuAccount(config),
    flow = await beginFeishu(config, app);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/admin/logout",
        headers: headers(flow),
      })
    ).statusCode,
    204,
  );
  assert.equal(
    (await callback(flow, code(account))).headers.location,
    "/admin/?login_error=denied",
  );
  const auth = await authenticateFeishu(config, app),
    stale = await app.inject({
      method: "POST",
      url: "/v1/admin/logout",
      headers: headers(auth.challenge),
    });
  assert.equal(stale.statusCode, 401);
  assert.equal(stale.headers["set-cookie"], undefined);
  assert.equal((await runtime(auth.cookie)).statusCode, 200);
});
test("provider denial consumes the bound flow and only returns a fixed safe error", async () => {
  const flow = await beginFeishu(config, app);
  const denied = await app.inject({
    method: "GET",
    url: `/v1/admin/feishu/callback?state=${flow.state}&error=access_denied&error_description=PRIVATE_PROVIDER_ERROR`,
    headers: { cookie: flow.flowCookie },
  });
  assert.equal(denied.headers.location, "/admin/?login_error=denied");
  assert.equal(adminCookie(denied), "");
  assert.equal(
    (await callback(flow, code(createFeishuAccount(config)))).headers.location,
    "/admin/?login_error=denied",
  );
  assert.doesNotMatch(denied.body, /PRIVATE_PROVIDER_ERROR/);
});
test("provider failure and failed success audit cannot create authenticated cookies", async () => {
  const failing = await createApplication(config, {
    feishuFetch: async () => {
      throw new Error("PRIVATE_TRANSPORT_DETAIL");
    },
  });
  try {
    const flow = await beginFeishu(config, failing),
      result = await callback(flow, "synthetic-code", flow.flowCookie, failing);
    assert.equal(result.headers.location, "/admin/?login_error=unavailable");
    assert.equal(adminCookie(result), "");
  } finally {
    await failing.close();
  }
  const flow = await beginFeishu(config, app),
    account = createFeishuAccount(config);
  await db.$executeRawUnsafe(
    "ALTER TABLE admin_audit RENAME TO unavailable_audit",
  );
  try {
    const result = await callback(flow, code(account));
    assert.equal(adminCookie(result), "");
    assert.equal((await runtime(flow.cookie)).statusCode, 401);
  } finally {
    await db.$executeRawUnsafe(
      "ALTER TABLE unavailable_audit RENAME TO admin_audit",
    );
  }
});
test("short OAuth flows and full sessions expire without silent renewal", async () => {
  const shortConfig = {
      ...config,
      admin: { ...config.admin!, sessionTtlSeconds: 1, challengeTtlSeconds: 1 },
    },
    short = await createApplication(shortConfig, {
      feishuFetch: syntheticFeishuFetch,
    });
  try {
    const auth = await authenticateFeishu(shortConfig, short);
    await new Promise((r) => setTimeout(r, 1100));
    assert.equal((await runtime(auth.cookie, short)).statusCode, 401);
    const flow = await beginFeishu(shortConfig, short);
    await new Promise((r) => setTimeout(r, 1100));
    assert.equal(
      (await callback(flow, code(auth.account), flow.flowCookie, short)).headers
        .location,
      "/admin/?login_error=denied",
    );
  } finally {
    await short.close();
  }
});
test("whitelist CLI rejects insecure files, duplicates, unknown permissions and mismatched app/tenant", () => {
  const account = createFeishuAccount(config);
  const { id: _id, ...fields } = account;
  const input = {
    ...fields,
    username: "new-operator",
    feishuOpenId: "ou_new_operator",
  };
  for (const candidate of [
    { ...input, feishuAppId: "cli_other" },
    { ...input, tenantKey: "other-tenant" },
    { ...input, realm: "production" },
    { ...input, permissions: ["root:all"] },
    { ...input, password: "unneeded" },
  ])
    assert.equal(cliInput(candidate).result.status, 1);
  assert.equal(cliInput(fields).result.status, 1);
  assert.equal(cliInput(input, "create", 0o644).result.status, 1);
  const linked = cliInput({
    ...input,
    username: "symlink-operator",
    feishuOpenId: "ou_symlink_operator",
  });
  rmSync(linked.path);
  symlinkSync(join(privateDir, "absent"), linked.path);
  assert.equal(
    spawnSync(
      process.execPath,
      [
        "dist-test/src/admin/admin-cli.js",
        "create",
        "--input-file",
        linked.path,
      ],
      { env: linked.env, encoding: "utf8" },
    ).status,
    1,
  );
});
test("controlled disable denies every prior session and further login", async () => {
  const auth = await authenticateFeishu(config, app),
    result = cliInput(
      { username: auth.account.username, realm: "local" },
      "disable",
    ).result;
  assert.equal(result.status, 0, result.stderr);
  assert.equal((await runtime(auth.cookie)).statusCode, 401);
  assert.equal(
    (await callback(await beginFeishu(config, app), code(auth.account))).headers
      .location,
    "/admin/?login_error=denied",
  );
});
test("Redis failure has no login fallback and authorization attempts are rate limited", async () => {
  const unavailable = await createApplication(
    { ...config, redisUrl: "redis://127.0.0.1:1" },
    { feishuFetch: syntheticFeishuFetch },
  );
  try {
    const response = await unavailable.inject({
      method: "GET",
      url: "/v1/admin/session",
    });
    assert.equal(response.statusCode, 503);
    assert.equal(response.headers["set-cookie"], undefined);
  } finally {
    await unavailable.close();
  }
  const initial = await app.inject({ method: "GET", url: "/v1/admin/session" }),
    supplied = {
      cookie: adminCookie(initial),
      origin,
      "x-csrf-token": initial.json().data.csrfToken,
    };
  for (let i = 0; i < 20; i++)
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/v1/admin/feishu/login",
          headers: supplied,
        })
      ).statusCode,
      200,
    );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/admin/feishu/login",
        headers: supplied,
      })
    ).statusCode,
    429,
  );
});
test("audit facts omit OAuth state/code, provider token, CSRF and session cookie", async () => {
  const auth = await authenticateFeishu(config, app),
    records = await app.inject({
      method: "GET",
      url: "/v1/admin/audit",
      headers: { cookie: auth.cookie },
    });
  assert.equal(records.statusCode, 200);
  assert.ok(
    records
      .json()
      .data.some(
        (row: { action: string; operatorId: string }) =>
          row.action === "admin.feishu.callback" &&
          row.operatorId === auth.account.id,
      ),
  );
  for (const secret of [
    auth.challenge.state,
    code(auth.account),
    config.admin!.feishu!.appSecret,
    auth.cookie.split("=")[1],
    auth.csrf,
  ])
    assert.ok(!records.body.includes(secret));
});
test("development/production reject injected Feishu network implementations", async () => {
  for (const environment of ["development", "production"] as const)
    await assert.rejects(
      createApplication(
        { ...config, environment },
        { feishuFetch: syntheticFeishuFetch },
      ),
      /Feishu transport overrides require isolated tests/,
    );
});
