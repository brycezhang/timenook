import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { after, before, test } from "node:test";
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import { createApplication } from "../src/application";
import type { ApiConfig } from "../src/config";

const schema = `t06_${randomUUID().replaceAll("-", "")}`;
let config: ApiConfig;
let app: Awaited<ReturnType<typeof createApplication>>;
const requests: URL[] = [];
const supplierReplies = new Map<string, () => Response>();
// Only the external WeChat network is substituted. No real code or credentials.
const wechatFetch: typeof fetch = async (input) => {
  const url = new URL(String(input));
  requests.push(url);
  const code = url.searchParams.get("js_code") ?? "";
  const reply = supplierReplies.get(code);
  if (reply) return reply();
  const openid = code.startsWith("concurrent-")
    ? "synthetic-concurrent"
    : code.startsWith("other-")
      ? "synthetic-open-b"
      : "synthetic-open-a";
  return new Response(JSON.stringify({ openid, session_key: "synthetic-key" }));
};

before(async () => {
  assert.ok(process.env.DATABASE_URL, "Real PostgreSQL is required");
  assert.ok(process.env.REDIS_URL, "Real Redis is required");
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set("schema", schema);
  config = {
    environment: "test",
    host: "127.0.0.1",
    port: 3417,
    databaseUrl: url.toString(),
    redisUrl: process.env.REDIS_URL,
    redisKeyPrefix: schema,
    wechat: { appId: "synthetic-app-a", secret: "synthetic-secret" },
  };
  const migrated = spawnSync(
    process.execPath,
    ["node_modules/prisma/build/index.js", "migrate", "deploy"],
    {
      env: { ...process.env, DATABASE_URL: config.databaseUrl },
      encoding: "utf8",
    },
  );
  assert.equal(
    migrated.status,
    0,
    "Isolated integration schema migration failed",
  );
  app = await createApplication(config, { wechatFetch });
});

after(async () => {
  await app?.close();
  if (!config) return;
  const database = new PrismaClient({ datasourceUrl: config.databaseUrl });
  const redis = new Redis(config.redisUrl);
  try {
    await database.$executeRawUnsafe(
      `DROP SCHEMA IF EXISTS "${schema}" CASCADE`,
    );
    const keys = await redis.keys(`${schema}:*`);
    if (keys.length) await redis.del(...keys);
  } finally {
    await database.$disconnect();
    redis.disconnect();
  }
});

function login(code: string = randomUUID(), target = app) {
  return target.inject({
    method: "POST",
    url: "/v1/sessions/wechat",
    payload: { code },
  });
}
function me(token: string, target = app) {
  return target.inject({
    method: "GET",
    url: "/v1/users/me",
    headers: { authorization: `Bearer ${token}` },
  });
}

test("server exchanges a WeChat code and issues an opaque session for the current account", async () => {
  const response = await login("synthetic-first-code");
  assert.equal(response.statusCode, 201);
  const { data, meta } = response.json();
  assert.match(data.user.id, /^[0-9a-f-]{36}$/);
  assert.match(data.session.id, /^[0-9a-f-]{36}$/);
  assert.match(data.session.token, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(Date.parse(data.session.expiresAt) > Date.now());
  assert.equal(response.headers["x-request-id"], meta.requestId);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.doesNotMatch(
    response.body,
    /synthetic-open|synthetic-key|synthetic-secret|synthetic-first-code/,
  );
  const current = await me(data.session.token);
  assert.equal(current.statusCode, 200);
  assert.equal(current.headers["cache-control"], "no-store");
  assert.deepEqual(current.json().data, data.user);
  assert.equal(
    requests[0].origin + requests[0].pathname,
    "https://api.weixin.qq.com/sns/jscode2session",
  );
  assert.equal(
    requests[0].searchParams.get("grant_type"),
    "authorization_code",
  );
  assert.equal(requests[0].searchParams.get("appid"), "synthetic-app-a");
  assert.equal(requests[0].searchParams.get("js_code"), "synthetic-first-code");
});

test("concurrent first logins restore one account across restart and AppIDs stay independent", async () => {
  const results = await Promise.all(
    Array.from({ length: 8 }, () => login(`concurrent-${randomUUID()}`)),
  );
  for (const response of results) assert.equal(response.statusCode, 201);
  const account = results[0].json().data.user;
  for (const response of results)
    assert.deepEqual(response.json().data.user, account);
  assert.equal(
    new Set(results.map((r) => r.json().data.session.token)).size,
    8,
  );
  const restarted = await createApplication(config, { wechatFetch });
  const separateApp = await createApplication(
    {
      ...config,
      wechat: { appId: "synthetic-app-b", secret: "synthetic-secret-b" },
    },
    { wechatFetch },
  );
  try {
    assert.deepEqual(
      (await login(`concurrent-${randomUUID()}`, restarted)).json().data.user,
      account,
    );
    assert.equal(
      (await me(results[0].json().data.session.token, restarted)).statusCode,
      200,
    );
    const other = await login(`concurrent-${randomUUID()}`, separateApp);
    assert.equal(other.statusCode, 201);
    assert.notEqual(other.json().data.user.id, account.id);
  } finally {
    await restarted.close();
    await separateApp.close();
  }
});

test("one code can create only one session even during concurrent replay and restart", async () => {
  const code = `replay-${randomUUID()}`;
  const results = await Promise.all(
    Array.from({ length: 8 }, () => login(code)),
  );
  assert.equal(results.filter((r) => r.statusCode === 201).length, 1);
  assert.equal(results.filter((r) => r.statusCode === 401).length, 7);
  const restarted = await createApplication(config, { wechatFetch });
  try {
    const replay = await login(code, restarted);
    assert.equal(replay.statusCode, 401);
    assert.doesNotMatch(replay.body, new RegExp(code));
  } finally {
    await restarted.close();
  }
});

test("logout revokes replayed tokens but a new login recovers the same account", async () => {
  const first = (await login()).json().data;
  assert.equal((await me(first.session.token)).statusCode, 200);
  assert.equal((await me(first.session.token)).statusCode, 200);
  const logout = await app.inject({
    method: "DELETE",
    url: `/v1/sessions/${first.session.id}`,
    headers: { authorization: `Bearer ${first.session.token}` },
  });
  assert.equal(logout.statusCode, 204);
  assert.equal((await me(first.session.token)).statusCode, 401);
  const recovered = (await login()).json().data;
  assert.deepEqual(recovered.user, first.user);
  assert.notEqual(recovered.session.token, first.session.token);
  assert.equal((await me(recovered.session.token)).statusCode, 200);
  assert.equal((await me(first.session.token)).statusCode, 401);
  const restarted = await createApplication(config, { wechatFetch });
  try {
    assert.equal((await me(first.session.token, restarted)).statusCode, 401);
  } finally {
    await restarted.close();
  }
});

test("different accounts cannot revoke each other's sessions and missing tokens cannot read identity", async () => {
  const a = (await login()).json().data;
  const b = (await login(`other-${randomUUID()}`)).json().data;
  assert.notEqual(a.user.id, b.user.id);
  const denied = await app.inject({
    method: "DELETE",
    url: `/v1/sessions/${a.session.id}`,
    headers: { authorization: `Bearer ${b.session.token}` },
  });
  assert.equal(denied.statusCode, 404);
  assert.equal(denied.json().error.code, "NOT_FOUND");
  assert.doesNotMatch(denied.body, new RegExp(a.user.id));
  assert.deepEqual((await me(a.session.token)).json().data, a.user);
  for (const authorization of [
    undefined,
    "Bearer invalid",
    `Bearer ${"x".repeat(43)}`,
  ]) {
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: "/v1/users/me",
          headers: authorization ? { authorization } : {},
        })
      ).statusCode,
      401,
    );
  }
});

test("expired tokens remain invalid after a fresh login", async () => {
  const short = await createApplication(
    { ...config, sessionTtlSeconds: 1 },
    { wechatFetch },
  );
  try {
    const first = (await login(randomUUID(), short)).json().data;
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal((await me(first.session.token, short)).statusCode, 401);
    const next = (await login(randomUUID(), short)).json().data;
    assert.deepEqual(next.user, first.user);
    assert.equal((await me(first.session.token, short)).statusCode, 401);
    assert.equal((await me(next.session.token, short)).statusCode, 200);
  } finally {
    await short.close();
  }
});

test("clients cannot submit identity, credentials or malformed login codes", async () => {
  for (const payload of [
    { code: "valid", openid: "forged" },
    { code: "valid", appId: "forged" },
    { code: "valid", session_key: "forged" },
    {},
    { code: "" },
    { code: " " },
    { code: 1 },
    { code: "x".repeat(257) },
  ]) {
    const result = await app.inject({
      method: "POST",
      url: "/v1/sessions/wechat",
      payload,
    });
    assert.equal(result.statusCode, 400);
    assert.doesNotMatch(result.body, /forged/);
  }
});

test("invalid WeChat replies fail closed with safe HTTP errors and no usable session", async () => {
  const scenarios: [unknown, number][] = [
    [{ errcode: 40029, errmsg: "sensitive-provider-detail" }, 401],
    [{ errcode: 40163 }, 401],
    [{ errcode: 40226 }, 403],
    [{ errcode: -1 }, 503],
    [{ errcode: 45011 }, 429],
    [{ errcode: 40013 }, 502],
    [{ errcode: "0", openid: "untrusted", session_key: "private" }, 502],
    [{ openid: "" }, 502],
    [{ openid: "untrusted" }, 502],
    [null, 502],
    [[], 502],
    [{ openid: 123, session_key: "private" }, 502],
  ];
  for (const [payload, status] of scenarios) {
    const code = randomUUID();
    supplierReplies.set(code, () => new Response(JSON.stringify(payload)));
    const response = await login(code);
    assert.equal(response.statusCode, status);
    assert.ok(response.json().error.code);
    assert.equal(response.json().data, undefined);
    assert.doesNotMatch(
      response.body,
      /sensitive-provider-detail|untrusted|private/,
    );
    assert.equal((await login(code)).statusCode, 401);
  }
  for (const [reply, status] of [
    [() => new Response("not-json-private"), 502],
    [() => new Response("private", { status: 503 }), 502],
    [
      () => {
        throw new Error("private-network-url-with-secret");
      },
      503,
    ],
  ] as const) {
    const code = randomUUID();
    supplierReplies.set(code, reply);
    const response = await login(code);
    assert.equal(response.statusCode, status);
    assert.doesNotMatch(response.body, /private/);
  }
});

test("production cannot inject synthetic WeChat transport and unconfigured login fails closed", async () => {
  await assert.rejects(
    createApplication(
      { ...config, environment: "production" },
      { wechatFetch },
    ),
    /only allowed in test/,
  );
  const unconfigured = await createApplication({
    ...config,
    wechat: undefined,
  });
  try {
    const response = await login(randomUUID(), unconfigured);
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().data, undefined);
  } finally {
    await unconfigured.close();
  }
});

test("login has a shared Redis limit across processes and fails closed without Redis", async () => {
  const limitedConfig = {
    ...config,
    redisKeyPrefix: `${schema}:limit`,
    loginLimitPerMinute: 2,
  };
  const a = await createApplication(limitedConfig, { wechatFetch });
  const b = await createApplication(limitedConfig, { wechatFetch });
  const unavailable = await createApplication(
    { ...config, redisUrl: "redis://127.0.0.1:1" },
    { wechatFetch },
  );
  try {
    const results = await Promise.all([
      login(randomUUID(), a),
      login(randomUUID(), b),
      login(randomUUID(), a),
    ]);
    assert.equal(results.filter((r) => r.statusCode === 201).length, 2);
    assert.equal(results.filter((r) => r.statusCode === 429).length, 1);
    assert.equal((await login(randomUUID(), unavailable)).statusCode, 503);
  } finally {
    await a.close();
    await b.close();
    await unavailable.close();
  }
});

test("only the loopback proxy can supply client addresses for login limiting", async () => {
  const limited = await createApplication(
    { ...config, redisKeyPrefix: `${schema}:proxy`, loginLimitPerMinute: 1 },
    { wechatFetch },
  );
  const attempt = (remoteAddress: string, forwarded: string) =>
    limited.inject({
      method: "POST",
      url: "/v1/sessions/wechat",
      payload: { code: randomUUID() },
      remoteAddress,
      headers: { "x-forwarded-for": forwarded },
    });
  try {
    assert.equal((await attempt("127.0.0.1", "192.0.2.1")).statusCode, 201);
    assert.equal((await attempt("127.0.0.1", "192.0.2.2")).statusCode, 201);
    assert.equal((await attempt("198.51.100.1", "192.0.2.3")).statusCode, 201);
    assert.equal((await attempt("198.51.100.1", "192.0.2.4")).statusCode, 429);
    assert.equal(
      (await attempt("127.0.0.1", "192.0.2.99, 192.0.2.1")).statusCode,
      429,
    );
  } finally {
    await limited.close();
  }
});
