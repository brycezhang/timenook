import assert from "node:assert/strict";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generate } from "otplib";
import { after, before, test } from "node:test";
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import { createApplication } from "../src/application";
import type { ApiConfig } from "../src/config";

const origin = "https://localhost:3443";
const key = randomBytes(32).toString("base64");
const privateDir = mkdtempSync(join(tmpdir(), "t07-admin-"));
const schema = `t07_${randomUUID().replaceAll("-", "")}`;
let config: ApiConfig;
let app: Awaited<ReturnType<typeof createApplication>>;
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
      origin,
      encryptionKey: key,
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
  assert.equal(migrated.status, 0, "Isolated migration failed");
  app = await createApplication(config);
});
after(async () => {
  await app?.close();
  rmSync(privateDir, { recursive: true, force: true });
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

test("anonymous and product bearer cannot access the independent admin runtime API", async () => {
  for (const authorization of [
    undefined,
    `Bearer ${randomBytes(32).toString("base64url")}`,
  ]) {
    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/runtime",
      headers: authorization ? { authorization } : {},
    });
    assert.equal(response.statusCode, 401);
  }
});

function createAccount(permissions = ["ops:read", "audit:read"]) {
  const username = `operator-${randomUUID()}`;
  const password = randomBytes(24).toString("base64url");
  const input = join(privateDir, `${randomUUID()}.json`);
  writeFileSync(
    input,
    JSON.stringify({ username, password, permissions, realm: "local" }),
    { mode: 0o600 },
  );
  const result = spawnSync(
    process.execPath,
    ["dist-test/src/admin/admin-cli.js", "create", "--input-file", input],
    {
      env: {
        ...process.env,
        NODE_ENV: "test",
        DATABASE_URL: config.databaseUrl,
        ADMIN_ORIGIN: origin,
        ADMIN_ENCRYPTION_KEY: key,
      },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, `CLI failed: ${result.stderr}`);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(password));
  return { username, password, id: JSON.parse(result.stdout).id };
}
function cookie(response: { headers: Record<string, unknown> }): string {
  const value = response.headers["set-cookie"];
  return String(Array.isArray(value) ? value[0] : value).split(";")[0];
}
async function begin(account: ReturnType<typeof createAccount>, target = app) {
  const bootstrap = await target.inject({
    method: "GET",
    url: "/v1/admin/session",
  });
  assert.equal(bootstrap.statusCode, 200);
  const response = await target.inject({
    method: "POST",
    url: "/v1/admin/login",
    headers: {
      origin,
      cookie: cookie(bootstrap),
      "x-csrf-token": bootstrap.json().data.csrfToken,
    },
    payload: account.username
      ? { username: account.username, password: account.password }
      : {},
  });
  assert.equal(response.statusCode, 200);
  return {
    cookie: cookie(response),
    csrf: response.json().data.csrfToken,
    response,
  };
}
async function authenticate(account = createAccount(), target = app) {
  const challenge = await begin(account, target);
  const enrollment = await target.inject({
    method: "GET",
    url: "/v1/admin/mfa/enrollment",
    headers: { cookie: challenge.cookie },
  });
  assert.equal(enrollment.statusCode, 200);
  const secret = enrollment.json().data.secret;
  const code = await generate({ secret });
  const response = await target.inject({
    method: "POST",
    url: "/v1/admin/mfa",
    headers: {
      cookie: challenge.cookie,
      origin,
      "x-csrf-token": challenge.csrf,
    },
    payload: { code },
  });
  assert.equal(response.statusCode, 200);
  return {
    account,
    secret,
    code,
    cookie: cookie(response),
    csrf: response.json().data.csrfToken,
    response,
    challenge,
  };
}
test("a controlled CLI account completes password and MFA before receiving a full admin session", async () => {
  const auth = await authenticate();
  assert.equal(auth.challenge.response.json().data.authenticated, false);
  assert.equal(auth.response.json().data.authenticated, true);
  assert.ok(
    auth.cookie !== auth.challenge.cookie,
    "session token rotates after MFA",
  );
  const current = await app.inject({
    method: "GET",
    url: "/v1/admin/runtime",
    headers: { cookie: auth.cookie },
  });
  assert.equal(current.statusCode, 200);
  assert.equal(current.json().data.status, "ready");
});

test("failed audit persistence cannot issue a password cookie or consume the challenge", async () => {
  const account = createAccount();
  const bootstrap = await app.inject({
    method: "GET",
    url: "/v1/admin/session",
  });
  const headers = {
    origin,
    cookie: cookie(bootstrap),
    "x-csrf-token": bootstrap.json().data.csrfToken,
  };
  const database = new PrismaClient({ datasourceUrl: config.databaseUrl });
  try {
    await database.$executeRawUnsafe(
      "ALTER TABLE admin_audit RENAME TO unavailable_audit",
    );
    const failed = await app.inject({
      method: "POST",
      url: "/v1/admin/login",
      headers,
      payload: { username: account.username, password: account.password },
    });
    assert.equal(failed.statusCode, 500);
    assert.ok(
      failed.headers["set-cookie"] === undefined,
      "failure must not emit credentials",
    );
  } finally {
    await database.$executeRawUnsafe(
      "ALTER TABLE unavailable_audit RENAME TO admin_audit",
    );
    await database.$disconnect();
  }
  const retry = await app.inject({
    method: "POST",
    url: "/v1/admin/login",
    headers,
    payload: { username: account.username, password: account.password },
  });
  assert.equal(retry.statusCode, 200);
});

test("rejected malformed operations are audited without copying input or secrets", async () => {
  const auth = await authenticate();
  const marker = randomBytes(24).toString("hex");
  const denied = await app.inject({
    method: "POST",
    url: "/v1/admin/login",
    payload: {
      username: marker,
      password: auth.account.password,
      unexpected: marker,
    },
  });
  assert.equal(denied.statusCode, 400);
  const audits = await app.inject({
    method: "GET",
    url: "/v1/admin/audit",
    headers: { cookie: auth.cookie },
  });
  assert.equal(audits.statusCode, 200);
  const record = audits
    .json()
    .data.find(
      (entry: { requestId: string }) =>
        entry.requestId === denied.headers["x-request-id"],
    );
  assert.ok(record, "validation rejection must be auditable");
  assert.equal(record.result, "denied:400");
  assert.ok(Object.hasOwn(record, "operatorId"));
  assert.equal(typeof record.action, "string");
  for (const secret of [
    marker,
    auth.account.password,
    auth.secret,
    auth.cookie.split("=")[1],
    auth.csrf,
  ])
    assert.equal(audits.body.includes(secret), false);
});

test("validation rejection keeps its safe HTTP response when the audit database is unavailable", async () => {
  const auth = await authenticate();
  const database = new PrismaClient({ datasourceUrl: config.databaseUrl });
  try {
    await database.$executeRawUnsafe(
      "ALTER TABLE admin_audit RENAME TO unavailable_audit",
    );
    const rejected = await app.inject({
      method: "POST",
      url: "/v1/admin/mfa",
      headers: { cookie: auth.cookie, origin, "x-csrf-token": auth.csrf },
      payload: { code: "malformed-sensitive-input" },
    });
    assert.equal(rejected.statusCode, 400);
    assert.deepEqual(rejected.json(), {
      error: {
        code: "INVALID_REQUEST",
        message: "Invalid request",
        retryable: false,
      },
      meta: { requestId: rejected.headers["x-request-id"] },
    });
    assert.ok(!rejected.headers["set-cookie"]);
  } finally {
    await database.$executeRawUnsafe(
      "ALTER TABLE unavailable_audit RENAME TO admin_audit",
    );
    await database.$disconnect();
  }
});

test("malformed admin commands retain their known operator and fixed action without recording input", async () => {
  const auth = await authenticate();
  const marker = randomBytes(24).toString("hex");
  for (const command of [
    {
      route: "mfa",
      payload: { code: marker },
      cookie: auth.cookie,
      action: "admin.mfa",
      operatorId: auth.account.id,
    },
    {
      route: "login",
      payload: { username: marker, password: "invalid" },
      cookie: auth.cookie,
      action: "admin.password",
      operatorId: auth.account.id,
    },
    {
      route: "login",
      payload: { username: marker, password: "invalid" },
      cookie: "",
      action: "admin.password",
      operatorId: null,
    },
  ]) {
    const rejected = await app.inject({
      method: "POST",
      url: `/v1/admin/${command.route}`,
      headers: { cookie: command.cookie, origin, "x-csrf-token": auth.csrf },
      payload: command.payload,
    });
    assert.equal(rejected.statusCode, 400);
    const audits = await app.inject({
      method: "GET",
      url: "/v1/admin/audit",
      headers: { cookie: auth.cookie },
    });
    const record = audits
      .json()
      .data.find(
        (entry: { requestId: string }) =>
          entry.requestId === rejected.headers["x-request-id"],
      );
    assert.equal(record.operatorId, command.operatorId);
    assert.equal(record.action, command.action);
    assert.equal(record.result, "denied:400");
    for (const sensitive of [
      marker,
      auth.account.password,
      auth.secret,
      auth.cookie.split("=")[1],
      auth.csrf,
    ])
      assert.equal(audits.body.includes(sensitive), false);
  }
});

test("early cross-site and phase rejections audit the valid cookie operator without granting authority", async () => {
  const auth = await authenticate();
  for (const command of [
    {
      method: "GET" as const,
      route: "runtime",
      headers: { "sec-fetch-site": "cross-site" },
      payload: undefined,
      status: 403,
      action: "admin.runtime",
    },
    {
      method: "POST" as const,
      route: "mfa",
      headers: { origin, "x-csrf-token": auth.csrf },
      payload: { code: "000000" },
      status: 401,
      action: "admin.mfa",
    },
  ]) {
    const rejected = await app.inject({
      method: command.method,
      url: `/v1/admin/${command.route}`,
      headers: { cookie: auth.cookie, ...command.headers },
      payload: command.payload,
    });
    assert.equal(rejected.statusCode, command.status);
    assert.ok(!rejected.headers["set-cookie"]);
    const audits = await app.inject({
      method: "GET",
      url: "/v1/admin/audit",
      headers: { cookie: auth.cookie },
    });
    const record = audits
      .json()
      .data.find(
        (entry: { requestId: string }) =>
          entry.requestId === rejected.headers["x-request-id"],
      );
    assert.equal(record.operatorId, auth.account.id);
    assert.equal(record.action, command.action);
    assert.equal(record.result, `denied:${command.status}`);
  }
});

test("password and wrong MFA challenges have no runtime authority; code replay loses even concurrently", async () => {
  const auth = await authenticate();
  const pending = await begin(auth.account);
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: "/v1/admin/runtime",
        headers: { cookie: pending.cookie },
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: "/v1/admin/mfa/enrollment",
        headers: { cookie: pending.cookie },
      })
    ).statusCode,
    403,
  );
  const wrong = await generate({
    secret: auth.secret,
    epoch: Date.now() / 1000 - 120,
  });
  for (const code of [wrong, auth.code]) {
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/mfa",
      headers: { cookie: pending.cookie, origin, "x-csrf-token": pending.csrf },
      payload: { code },
    });
    assert.equal(response.statusCode, 401);
    assert.ok(!response.headers["set-cookie"]);
  }
  const account = createAccount();
  const first = await begin(account);
  const second = await begin(account);
  const enrollment = await app.inject({
    method: "GET",
    url: "/v1/admin/mfa/enrollment",
    headers: { cookie: first.cookie },
  });
  const code = await generate({ secret: enrollment.json().data.secret });
  const results = await Promise.all(
    [first, second].map((challenge) =>
      app.inject({
        method: "POST",
        url: "/v1/admin/mfa",
        headers: {
          cookie: challenge.cookie,
          origin,
          "x-csrf-token": challenge.csrf,
        },
        payload: { code },
      }),
    ),
  );
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 401]);
});

test("missing, wrong, foreign-session CSRF and cross-site requests cannot log out an operator", async () => {
  const auth = await authenticate();
  const other = await app.inject({ method: "GET", url: "/v1/admin/session" });
  for (const headers of [
    { origin },
    { origin, "x-csrf-token": "wrong" },
    { origin, "x-csrf-token": other.json().data.csrfToken },
    { origin: "https://untrusted.example", "x-csrf-token": auth.csrf },
    { "x-csrf-token": auth.csrf },
    { origin, "x-csrf-token": auth.csrf, "sec-fetch-site": "cross-site" },
  ]) {
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/logout",
      headers: { cookie: auth.cookie, ...headers },
    });
    assert.equal(response.statusCode, 403);
  }
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: "/v1/admin/runtime",
        headers: { cookie: auth.cookie },
      })
    ).statusCode,
    200,
  );
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
});

test("admin cookies are host-only, scoped, Secure and HttpOnly; logout revokes them across application restart", async () => {
  const auth = await authenticate();
  const header = String(auth.response.headers["set-cookie"]);
  for (const attribute of [
    "Path=/timenook/v1/admin",
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
  ])
    assert.ok(header.includes(attribute));
  assert.ok(!header.includes("Domain="));
  const restarted = await createApplication(config);
  try {
    assert.equal(
      (
        await restarted.inject({
          method: "GET",
          url: "/v1/admin/runtime",
          headers: { cookie: auth.cookie },
        })
      ).statusCode,
      200,
    );
    const logout = await restarted.inject({
      method: "POST",
      url: "/v1/admin/logout",
      headers: { cookie: auth.cookie, origin, "x-csrf-token": auth.csrf },
    });
    assert.equal(logout.statusCode, 204);
    assert.ok(String(logout.headers["set-cookie"]).includes("Max-Age=0"));
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: "/v1/admin/runtime",
          headers: { cookie: auth.cookie },
        })
      ).statusCode,
      401,
    );
  } finally {
    await restarted.close();
  }
});

test("logout queued behind MFA rotation cannot report success for the consumed challenge", async () => {
  const pending = await begin(createAccount());
  const enrollment = await app.inject({
    method: "GET",
    url: "/v1/admin/mfa/enrollment",
    headers: { cookie: pending.cookie },
  });
  const code = await generate({ secret: enrollment.json().data.secret });
  const headers = {
    cookie: pending.cookie,
    origin,
    "x-csrf-token": pending.csrf,
  };
  const database = new PrismaClient({ datasourceUrl: config.databaseUrl });
  let release!: () => void;
  let acquired!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const locked = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const tokenHash = createHash("sha256")
    .update(pending.cookie.split("=")[1])
    .digest("hex");
  // Control only database scheduling; all outcome assertions use HTTP.
  const blocker = database.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id::text FROM admin_sessions WHERE token_hash = ${tokenHash} FOR UPDATE`;
      acquired();
      await released;
    },
    { timeout: 15000 },
  );
  const waitForQueuedRequests = async (count: number) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const [{ waiting }] = await database.$queryRaw<{ waiting: number }[]>`
        SELECT COUNT(*)::int AS waiting FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND query LIKE ${`%"${schema}"."admin_sessions"%`}
      `;
      if (waiting >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Concurrent HTTP requests did not reach the database lock");
  };
  let verified, logout;
  try {
    await locked;
    const verification = app
      .inject({
        method: "POST",
        url: "/v1/admin/mfa",
        headers,
        payload: { code },
      })
      .then((response) => response);
    try {
      await waitForQueuedRequests(1);
      const revocation = app
        .inject({
          method: "POST",
          url: "/v1/admin/logout",
          headers,
        })
        .then((response) => response);
      try {
        await waitForQueuedRequests(2);
      } finally {
        release();
        [verified, logout] = await Promise.all([verification, revocation]);
      }
    } finally {
      release();
      await verification;
    }
    assert.equal(verified!.statusCode, 200);
    assert.equal(logout!.statusCode, 401);
    assert.ok(
      !logout!.headers["set-cookie"],
      "stale logout must not clear the rotated browser cookie",
    );
    const currentCookie = cookie(verified!);
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: "/v1/admin/runtime",
          headers: { cookie: currentCookie },
        })
      ).statusCode,
      200,
    );
    const audits = await app.inject({
      method: "GET",
      url: "/v1/admin/audit",
      headers: { cookie: currentCookie },
    });
    const record = audits
      .json()
      .data.find(
        (entry: { requestId: string }) =>
          entry.requestId === logout!.headers["x-request-id"],
      );
    assert.equal(record.action, "admin.logout");
    assert.equal(record.result, "denied:401");
  } finally {
    release();
    await blocker;
    await database.$disconnect();
  }
});

test("an authenticated operator without explicit permissions cannot read runtime or audit data", async () => {
  const auth = await authenticate(createAccount([]));
  for (const route of ["runtime", "audit"])
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: `/v1/admin/${route}`,
          headers: { cookie: auth.cookie },
        })
      ).statusCode,
      403,
    );
});

test("product and admin credentials are not interchangeable in either direction", async () => {
  const product = await createApplication(
    { ...config, wechat: { appId: "synthetic-t07", secret: "synthetic" } },
    {
      wechatFetch: async () =>
        new Response(
          JSON.stringify({ openid: "synthetic-t07", session_key: "synthetic" }),
        ),
    },
  );
  try {
    const login = await product.inject({
      method: "POST",
      url: "/v1/sessions/wechat",
      payload: { code: randomUUID() },
    });
    assert.equal(login.statusCode, 201);
    const token = login.json().data.session.token;
    for (const headers of [
      { authorization: `Bearer ${token}` },
      { cookie: `__Secure-timenook_admin=${token}` },
    ])
      assert.equal(
        (
          await product.inject({
            method: "GET",
            url: "/v1/admin/runtime",
            headers,
          })
        ).statusCode,
        401,
      );
    const auth = await authenticate();
    assert.equal(
      (
        await product.inject({
          method: "GET",
          url: "/v1/users/me",
          headers: { authorization: `Bearer ${auth.cookie.split("=")[1]}` },
        })
      ).statusCode,
      401,
    );
  } finally {
    await product.close();
  }
});

test("expired full sessions and password challenges stay expired after restart", async () => {
  const short = await createApplication({
    ...config,
    admin: { ...config.admin!, sessionTtlSeconds: 1, challengeTtlSeconds: 1 },
  });
  try {
    const auth = await authenticate(createAccount(), short);
    const pending = await begin(createAccount(), short);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: "/v1/admin/runtime",
          headers: { cookie: auth.cookie },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: "/v1/admin/mfa/enrollment",
          headers: { cookie: pending.cookie },
        })
      ).statusCode,
      401,
    );
  } finally {
    await short.close();
  }
});

test("MFA and logout audit failures roll back authority changes and do not emit cookies", async () => {
  const account = createAccount();
  const pending = await begin(account);
  const enrollment = await app.inject({
    method: "GET",
    url: "/v1/admin/mfa/enrollment",
    headers: { cookie: pending.cookie },
  });
  const code = await generate({ secret: enrollment.json().data.secret });
  const database = new PrismaClient({ datasourceUrl: config.databaseUrl });
  const headers = {
    cookie: pending.cookie,
    origin,
    "x-csrf-token": pending.csrf,
  };
  try {
    await database.$executeRawUnsafe(
      "ALTER TABLE admin_audit RENAME TO unavailable_audit",
    );
    const failed = await app.inject({
      method: "POST",
      url: "/v1/admin/mfa",
      headers,
      payload: { code },
    });
    assert.equal(failed.statusCode, 500);
    assert.ok(!failed.headers["set-cookie"]);
  } finally {
    await database.$executeRawUnsafe(
      "ALTER TABLE unavailable_audit RENAME TO admin_audit",
    );
  }
  const verified = await app.inject({
    method: "POST",
    url: "/v1/admin/mfa",
    headers,
    payload: { code },
  });
  assert.equal(verified.statusCode, 200);
  const fullHeaders = {
    cookie: cookie(verified),
    origin,
    "x-csrf-token": verified.json().data.csrfToken,
  };
  try {
    await database.$executeRawUnsafe(
      "ALTER TABLE admin_audit RENAME TO unavailable_audit",
    );
    const failed = await app.inject({
      method: "POST",
      url: "/v1/admin/logout",
      headers: fullHeaders,
    });
    assert.equal(failed.statusCode, 500);
    assert.ok(!failed.headers["set-cookie"]);
  } finally {
    await database.$executeRawUnsafe(
      "ALTER TABLE unavailable_audit RENAME TO admin_audit",
    );
    await database.$disconnect();
  }
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: "/v1/admin/runtime",
        headers: fullHeaders,
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/admin/logout",
        headers: fullHeaders,
      })
    ).statusCode,
    204,
  );
});

test("production cannot consume local seed accounts or local admin cookies", async () => {
  const auth = await authenticate();
  const production = await createApplication({
    ...config,
    environment: "production",
  });
  try {
    assert.equal(
      (
        await production.inject({
          method: "GET",
          url: "/v1/admin/runtime",
          headers: { cookie: auth.cookie },
        })
      ).statusCode,
      401,
    );
    const bootstrap = await production.inject({
      method: "GET",
      url: "/v1/admin/session",
    });
    const response = await production.inject({
      method: "POST",
      url: "/v1/admin/login",
      headers: {
        cookie: cookie(bootstrap),
        origin,
        "x-csrf-token": bootstrap.json().data.csrfToken,
      },
      payload: {
        username: auth.account.username,
        password: auth.account.password,
      },
    });
    assert.equal(response.statusCode, 401);
  } finally {
    await production.close();
  }
});

test("wrong passwords are generic and limited by account across fresh challenges", async () => {
  const account = createAccount();
  const isolated = await createApplication({
    ...config,
    redisKeyPrefix: `${schema}:rate`,
  });
  try {
    for (let index = 0; index < 6; index++) {
      const bootstrap = await isolated.inject({
        method: "GET",
        url: "/v1/admin/session",
      });
      const response = await isolated.inject({
        method: "POST",
        url: "/v1/admin/login",
        headers: {
          cookie: cookie(bootstrap),
          origin,
          "x-csrf-token": bootstrap.json().data.csrfToken,
        },
        payload: {
          username: account.username,
          password: randomBytes(24).toString("hex"),
        },
      });
      assert.equal(response.statusCode, index < 5 ? 401 : 429);
      assert.ok(!response.headers["set-cookie"]);
      assert.ok(!response.body.includes(account.username));
    }
  } finally {
    await isolated.close();
  }
});

test("the provisioning command refuses public input files, duplicate accounts and a mismatched realm", () => {
  const account = createAccount();
  for (const [mode, realm] of [
    [0o644, "local"],
    [0o600, "production"],
    [0o600, "local"],
  ] as const) {
    const input = join(privateDir, `${randomUUID()}.json`);
    writeFileSync(
      input,
      JSON.stringify({ ...account, permissions: [], realm }),
      { mode },
    );
    const result = spawnSync(
      process.execPath,
      ["dist-test/src/admin/admin-cli.js", "create", "--input-file", input],
      {
        env: {
          ...process.env,
          NODE_ENV: "test",
          DATABASE_URL: config.databaseUrl,
          ADMIN_ORIGIN: origin,
          ADMIN_ENCRYPTION_KEY: key,
        },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 1);
    assert.ok(!(result.stdout + result.stderr).includes(account.password));
    assert.equal(result.stdout, "");
  }
});

test("password and MFA commands require CSRF before creating authority", async () => {
  const account = createAccount();
  const initial = await app.inject({ method: "GET", url: "/v1/admin/session" });
  const denied = await app.inject({
    method: "POST",
    url: "/v1/admin/login",
    headers: { cookie: cookie(initial), origin },
    payload: { username: account.username, password: account.password },
  });
  assert.equal(denied.statusCode, 403);
  assert.ok(!denied.headers["set-cookie"]);
  const pending = await begin(account);
  const response = await app.inject({
    method: "POST",
    url: "/v1/admin/mfa",
    headers: { cookie: pending.cookie, origin },
    payload: { code: "000000" },
  });
  assert.equal(response.statusCode, 403);
  assert.ok(!response.headers["set-cookie"]);
});

test("unavailable Redis rejects password and MFA verification without issuing cookies", async () => {
  const account = createAccount();
  const initial = await app.inject({ method: "GET", url: "/v1/admin/session" });
  const pending = await begin(account);
  const unavailable = await createApplication({
    ...config,
    redisUrl: "redis://127.0.0.1:1",
  });
  try {
    const password = await unavailable.inject({
      method: "POST",
      url: "/v1/admin/login",
      headers: {
        cookie: cookie(initial),
        origin,
        "x-csrf-token": initial.json().data.csrfToken,
      },
      payload: { username: account.username, password: account.password },
    });
    const mfa = await unavailable.inject({
      method: "POST",
      url: "/v1/admin/mfa",
      headers: { cookie: pending.cookie, origin, "x-csrf-token": pending.csrf },
      payload: { code: "000000" },
    });
    for (const response of [password, mfa]) {
      assert.equal(response.statusCode, 503);
      assert.ok(!response.headers["set-cookie"]);
    }
  } finally {
    await unavailable.close();
  }
});
