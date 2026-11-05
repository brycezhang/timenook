import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, before, test } from "node:test";
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import { createApplication } from "../src/application";
import type { ApiConfig } from "../src/config";
import { bootPrivacyFixture, closePrivacyFixture } from "./privacy-fixture";
import { ProjectPlans } from "../src/projects/project-plans";

const schema = `link_${randomUUID().replaceAll("-", "")}`;
const origin = "https://localhost:3447";
const headers = { origin, "x-timenook-web": "1" };
let root: string;
let config: ApiConfig;
let app: Awaited<ReturnType<typeof createApplication>>;
let disabled: Awaited<ReturnType<typeof createApplication>>;
const codeIdentities = new Map<string, string>();
function code(openId: string) {
  const value = `synthetic-${randomUUID()}`;
  codeIdentities.set(value, openId);
  return value;
}
before(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(url.hostname));
  url.searchParams.set("schema", schema);
  root = await mkdtemp(join(tmpdir(), "timenook-wechat-link-"));
  config = {
    environment: "test",
    host: "127.0.0.1",
    port: 3419,
    databaseUrl: url.toString(),
    redisUrl: process.env.REDIS_URL!,
    redisKeyPrefix: schema,
    web: {
      origin,
      sessionKey: randomBytes(32).toString("base64"),
      loginTtlSeconds: 900,
      sessionTtlSeconds: 43200,
    },
    wechat: { appId: "synthetic-link-app", secret: "synthetic-secret" },
  };
  const migrated = spawnSync(
    process.execPath,
    ["node_modules/prisma/build/index.js", "migrate", "deploy"],
    {
      env: { ...process.env, DATABASE_URL: config.databaseUrl },
      encoding: "utf8",
    },
  );
  assert.equal(migrated.status, 0, "isolated migrations");
  await bootPrivacyFixture(config);
  app = await createApplication(config, {
    wechatFetch: async (input) => {
      const identity = codeIdentities.get(
        new URL(String(input)).searchParams.get("js_code") ?? "",
      );
      return new Response(
        JSON.stringify(
          identity
            ? { openid: identity, session_key: "synthetic" }
            : { errcode: 40029 },
        ),
      );
    },
  });
  disabled = await createApplication({ ...config, wechat: undefined });
});
after(async () => {
  await app?.close();
  await disabled?.close();
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
    await closePrivacyFixture(config);
    await rm(root, { recursive: true, force: true });
  }
});
async function cli(command: string, input: unknown) {
  const id = randomUUID(),
    inputFile = join(root, `${id}.input`),
    outputFile = join(root, `${id}.output`);
  await writeFile(inputFile, JSON.stringify(input), { mode: 0o600 });
  const result = spawnSync(
    process.execPath,
    [
      join(__dirname, "../src/web/web-cli.js"),
      command,
      "--input-file",
      inputFile,
      "--output-file",
      outputFile,
    ],
    {
      env: {
        ...process.env,
        NODE_ENV: "test",
        DATABASE_URL: config.databaseUrl,
        REDIS_URL: config.redisUrl,
        WEB_ORIGIN: origin,
        WEB_SESSION_KEY: config.web!.sessionKey,
        PRIVACY_JOURNAL_ROOT: config.privacyJournal!.root,
        PRIVACY_JOURNAL_KEY: config.privacyJournal!.key,
      },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, `controlled ${command}`);
  return JSON.parse(await readFile(outputFile, "utf8"));
}
async function signedIn() {
  const account = await cli("create", {}),
    issued = await cli("issue", { userId: account.user.id });
  const login = await app.inject({
    method: "POST",
    url: "/v1/web/session",
    headers,
    payload: {
      ticket: new URLSearchParams(new URL(issued.url).hash.slice(1)).get(
        "ticket",
      ),
    },
  });
  assert.equal(login.statusCode, 201);
  return {
    user: account.user,
    cookie: String(login.headers["set-cookie"]).split(";")[0],
    csrf: login.json().data.csrfToken,
  };
}
type Web = Awaited<ReturnType<typeof signedIn>>;
function web(
  w: Web,
  path = "",
  method: "GET" | "POST" | "DELETE" = "GET",
  payload?: unknown,
  server = app,
) {
  return server.inject({
    method,
    url: `/v1/web/wechat-link${path}`,
    headers: { ...headers, cookie: w.cookie, "x-csrf-token": w.csrf },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
}
test("unconfigured WeChat explicitly disables association without placeholder credentials", async () => {
  const w = await signedIn();
  const availability = await web(w, "", "GET", undefined, disabled);
  assert.equal(availability.statusCode, 200);
  assert.deepEqual(availability.json().data, { available: false });
  assert.equal((await web(w, "", "POST", {}, disabled)).statusCode, 503);
  const claim = await disabled.inject({
    method: "POST",
    url: "/v1/wechat-links/claim",
    payload: { linkCode: "12345678", code: code("unused") },
  });
  assert.equal(claim.statusCode, 503);
});
async function create(w: Web) {
  const response = await web(w, "", "POST", {});
  assert.equal(response.statusCode, 201);
  return response.json().data.challenge;
}
function native(action: string, payload: object) {
  return app.inject({
    method: "POST",
    url: `/v1/wechat-links/${action}`,
    payload,
  });
}
test("CLI account and two explicit confirmations attach a new WeChat identity to the same User", async () => {
  const w = await signedIn(),
    challenge = await create(w);
  const plans = new ProjectPlans(config.databaseUrl),
    projectId = randomUUID();
  try {
    await plans.createProject({ projectId, createdBy: w.user.id });
  } finally {
    await plans.close();
  }
  const projects = () =>
    app.inject({
      method: "GET",
      url: "/v1/web/projects",
      headers: { cookie: w.cookie },
    });
  assert.equal((await projects()).json().data.projects[0].id, projectId);
  assert.match(challenge.code, /^\d{8}$/);
  assert.equal(challenge.state, "waiting");
  const claimed = await native("claim", {
    linkCode: challenge.code,
    code: code("first-pair"),
  });
  assert.equal(claimed.statusCode, 201);
  const pair = claimed.json().data;
  assert.match(pair.proof, /^[A-Za-z0-9_-]{43}$/);
  assert.match(pair.challenge.verificationCode, /^\d{6}$/);
  assert.equal(pair.challenge.targetUser.id, w.user.id);
  const webView = await web(w, `/${challenge.id}`);
  assert.equal(
    webView.json().data.challenge.verificationCode,
    pair.challenge.verificationCode,
  );
  const confirmed = await native("confirm", {
    proof: pair.proof,
    code: code("first-pair"),
    verificationCode: pair.challenge.verificationCode,
  });
  assert.equal(confirmed.statusCode, 201);
  assert.equal(confirmed.json().data.challenge.state, "paired");
  const linked = await web(w, `/${challenge.id}/confirm`, "POST", {
    verificationCode: pair.challenge.verificationCode,
  });
  assert.equal(linked.statusCode, 201);
  assert.equal(linked.json().data.challenge.state, "linked");
  const login = await app.inject({
    method: "POST",
    url: "/v1/sessions/wechat",
    payload: { code: code("first-pair") },
  });
  assert.equal(login.statusCode, 201);
  assert.deepEqual(login.json().data.user, w.user);
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: "/v1/users/me",
        headers: { authorization: `Bearer ${login.json().data.session.token}` },
      })
    ).json().data.id,
    w.user.id,
  );
  assert.deepEqual(
    (await projects())
      .json()
      .data.projects.map((project: { id: string }) => project.id),
    [projectId],
  );
  assert.doesNotMatch(
    linked.body,
    /openId|session_key|secret|tokenHash|codeHash/,
  );
  assert.equal(linked.headers["cache-control"], "no-store");
});
async function pair(openId = randomUUID()) {
  const w = await signedIn(),
    challenge = await create(w);
  const claimed = await native("claim", {
    linkCode: challenge.code,
    code: code(openId),
  });
  assert.equal(claimed.statusCode, 201);
  return { w, challenge, openId, ...claimed.json().data };
}
test("claim is exclusive, never signs in early, and all WeChat codes are single-use across purposes", async () => {
  const w = await signedIn(),
    challenge = await create(w),
    openId = randomUUID();
  const firstCode = code(openId),
    secondCode = code(randomUUID());
  const results = await Promise.all(
    [firstCode, secondCode].map((c) =>
      native("claim", { linkCode: challenge.code, code: c }),
    ),
  );
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [201, 409]);
  const winner = results.find((r) => r.statusCode === 201)!.json().data;
  const winnerCode = results[0].statusCode === 201 ? firstCode : secondCode;
  const winnerIdentity = codeIdentities.get(winnerCode)!;
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/sessions/wechat",
        payload: { code: winnerCode },
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/sessions/wechat",
        payload: { code: code(winnerIdentity) },
      })
    ).statusCode,
    409,
    "claim must not auto-create a competing User",
  );
  const nativeCode = code(winnerIdentity);
  const confirms = await Promise.all(
    [nativeCode, code(winnerIdentity)].map((c) =>
      native("confirm", {
        proof: winner.proof,
        code: c,
        verificationCode: winner.challenge.verificationCode,
      }),
    ),
  );
  assert.deepEqual(confirms.map((r) => r.statusCode).sort(), [201, 409]);
  const webConfirms = await Promise.all(
    [1, 2].map(() =>
      web(w, `/${challenge.id}/confirm`, "POST", {
        verificationCode: winner.challenge.verificationCode,
      }),
    ),
  );
  assert.deepEqual(webConfirms.map((r) => r.statusCode).sort(), [201, 409]);
  assert.equal(
    (
      await native("confirm", {
        proof: winner.proof,
        code: code(winnerIdentity),
        verificationCode: winner.challenge.verificationCode,
      })
    ).statusCode,
    409,
  );
  const login = await app.inject({
    method: "POST",
    url: "/v1/sessions/wechat",
    payload: { code: code(winnerIdentity) },
  });
  assert.deepEqual(login.json().data.user, w.user);
});
test("an identity owned by another User conflicts without merging either account", async () => {
  const identity = randomUUID();
  const existing = await app.inject({
    method: "POST",
    url: "/v1/sessions/wechat",
    payload: { code: code(identity) },
  });
  const w = await signedIn(),
    challenge = await create(w);
  assert.equal(
    (await native("claim", { linkCode: challenge.code, code: code(identity) }))
      .statusCode,
    409,
  );
  const recovered = await app.inject({
    method: "POST",
    url: "/v1/sessions/wechat",
    payload: { code: code(identity) },
  });
  assert.deepEqual(recovered.json().data.user, existing.json().data.user);
  assert.notEqual(recovered.json().data.user.id, w.user.id);
});
test("foreign sessions, CSRF, forged identities and incorrect proof cannot confirm or inspect a pairing", async () => {
  const p = await pair(),
    outsider = await signedIn();
  assert.equal((await web(outsider, `/${p.challenge.id}`)).statusCode, 404);
  assert.equal(
    (
      await web(outsider, `/${p.challenge.id}/confirm`, "POST", {
        verificationCode: p.challenge.verificationCode,
      })
    ).statusCode,
    404,
  );
  const wrongCsrf = await app.inject({
    method: "POST",
    url: `/v1/web/wechat-link/${p.challenge.id}/confirm`,
    headers: { ...headers, cookie: p.w.cookie },
    payload: { verificationCode: p.challenge.verificationCode },
  });
  assert.equal(wrongCsrf.statusCode, 403);
  assert.equal(
    (await native("status", { proof: "A".repeat(43) })).statusCode,
    401,
  );
  assert.equal(
    (
      await native("claim", {
        linkCode: p.challenge.code,
        code: code("forged"),
        openId: "client-selected",
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await native("confirm", {
        proof: p.proof,
        code: "invalid-code",
        verificationCode: p.challenge.verificationCode,
      })
    ).statusCode,
    401,
  );
});
test("wrong verification attempts are bounded and a changed native account cancels the pairing", async () => {
  const p = await pair();
  const wrong = p.challenge.verificationCode === "000000" ? "111111" : "000000";
  for (let n = 0; n < 5; n++)
    assert.equal(
      (
        await web(p.w, `/${p.challenge.id}/confirm`, "POST", {
          verificationCode: wrong,
        })
      ).statusCode,
      409,
    );
  assert.equal(
    (await web(p.w, `/${p.challenge.id}`)).json().data.challenge.state,
    "cancelled",
  );
  const changed = await pair();
  assert.equal(
    (
      await native("confirm", {
        proof: changed.proof,
        code: code("different-native-account"),
        verificationCode: changed.challenge.verificationCode,
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (await web(changed.w, `/${changed.challenge.id}`)).json().data.challenge
      .state,
    "cancelled",
  );
});
test("web or native cancellation, replacement and expired pairing reject all late confirmations", async (t) => {
  for (const side of ["web", "native", "replacement"]) {
    const p = await pair();
    if (side === "web")
      assert.equal(
        (await web(p.w, `/${p.challenge.id}`, "DELETE")).statusCode,
        200,
      );
    if (side === "native")
      assert.equal(
        (await native("cancel", { proof: p.proof })).statusCode,
        201,
      );
    if (side === "replacement") await create(p.w);
    assert.equal(
      (
        await native("confirm", {
          proof: p.proof,
          code: code(p.openId),
          verificationCode: p.challenge.verificationCode,
        })
      ).statusCode,
      409,
    );
    assert.equal(
      (
        await web(p.w, `/${p.challenge.id}/confirm`, "POST", {
          verificationCode: p.challenge.verificationCode,
        })
      ).statusCode,
      409,
    );
  }
  const expired = await pair();
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  t.mock.timers.tick(300001);
  assert.equal(
    (await native("status", { proof: expired.proof })).json().data.challenge
      .state,
    "expired",
  );
  assert.equal(
    (
      await native("confirm", {
        proof: expired.proof,
        code: code(expired.openId),
        verificationCode: expired.challenge.verificationCode,
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await web(expired.w, `/${expired.challenge.id}/confirm`, "POST", {
        verificationCode: expired.challenge.verificationCode,
      })
    ).statusCode,
    409,
  );
});
test("logout, session revocation and browser account replacement invalidate previously claimed proofs", async () => {
  for (const action of ["logout", "revoke", "replace"]) {
    const p = await pair();
    assert.equal(
      (
        await web(p.w, `/${p.challenge.id}/confirm`, "POST", {
          verificationCode: p.challenge.verificationCode,
        })
      ).statusCode,
      201,
    );
    if (action === "logout") {
      assert.equal(
        (
          await app.inject({
            method: "DELETE",
            url: "/v1/web/session",
            headers: {
              ...headers,
              cookie: p.w.cookie,
              "x-csrf-token": p.w.csrf,
            },
          })
        ).statusCode,
        204,
      );
    } else if (action === "revoke") {
      const current = await app.inject({
        method: "GET",
        url: "/v1/web/session",
        headers: { cookie: p.w.cookie },
      });
      assert.equal(
        (
          await app.inject({
            method: "DELETE",
            url: `/v1/sessions/${current.json().data.session.id}`,
            headers: {
              ...headers,
              cookie: p.w.cookie,
              "x-csrf-token": p.w.csrf,
            },
          })
        ).statusCode,
        204,
      );
    } else {
      const account = await cli("create", {}),
        issued = await cli("issue", { userId: account.user.id });
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/v1/web/session",
            headers: { ...headers, cookie: p.w.cookie },
            payload: {
              ticket: new URLSearchParams(
                new URL(issued.url).hash.slice(1),
              ).get("ticket"),
            },
          })
        ).statusCode,
        201,
      );
    }
    assert.equal(
      (
        await native("confirm", {
          proof: p.proof,
          code: code(p.openId),
          verificationCode: p.challenge.verificationCode,
        })
      ).statusCode,
      401,
    );
    assert.equal((await native("status", { proof: p.proof })).statusCode, 401);
  }
});
test("two accounts racing to attach one proven identity have exactly one owner", async () => {
  const identity = randomUUID(),
    first = await pair(identity),
    second = await pair(identity);
  for (const p of [first, second])
    assert.equal(
      (
        await web(p.w, `/${p.challenge.id}/confirm`, "POST", {
          verificationCode: p.challenge.verificationCode,
        })
      ).statusCode,
      201,
    );
  const results = await Promise.all(
    [first, second].map((p) =>
      native("confirm", {
        proof: p.proof,
        code: code(identity),
        verificationCode: p.challenge.verificationCode,
      }),
    ),
  );
  assert.deepEqual(
    results.map((result) => result.statusCode).sort(),
    [201, 409],
  );
  const winner = results[0].statusCode === 201 ? first : second;
  const restored = await app.inject({
    method: "POST",
    url: "/v1/sessions/wechat",
    payload: { code: code(identity) },
  });
  assert.deepEqual(restored.json().data.user, winner.w.user);
});
test("short-code enumeration and state polling use shared Redis rate limits", async () => {
  const attempts = await Promise.all(
    Array.from({ length: 21 }, () =>
      native("claim", { linkCode: "99999999", code: code("rate") }),
    ),
  );
  assert.ok(attempts.some((r) => r.statusCode === 429));
  const w = await signedIn();
  const responses = await Promise.all(
    Array.from({ length: 121 }, () => web(w, `/${randomUUID()}`)),
  );
  assert.equal(responses.filter((r) => r.statusCode === 429).length, 1);
});
test("post-association login requires the intended User and cannot create an account after a WeChat switch", async () => {
  const w = await signedIn();
  const rejected = await app.inject({
    method: "POST",
    url: "/v1/sessions/wechat",
    payload: { code: code("switched-before-login"), expectedUserId: w.user.id },
  });
  assert.equal(rejected.statusCode, 409);
});
