import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, before, test } from "node:test";
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import { createApplication } from "../src/application";
import type { ApiConfig } from "../src/config";
import { bootPrivacyFixture, closePrivacyFixture } from "./privacy-fixture";
import { ProjectPlans } from "../src/projects/project-plans";
import { ProjectServiceTerms } from "../src/projects/service-terms";
import { Deletions } from "../src/care/deletions";

const schema = `web_${randomUUID().replaceAll("-", "")}`;
const origin = "https://localhost:3447";
let root: string;
let config: ApiConfig & {
  web: {
    origin: string;
    sessionKey: string;
    loginTtlSeconds: number;
    sessionTtlSeconds: number;
  };
};
let app: Awaited<ReturnType<typeof createApplication>>;
const headers = { origin, "x-timenook-web": "1" };

before(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(url.hostname));
  url.searchParams.set("schema", schema);
  root = await mkdtemp(join(tmpdir(), "timenook-web-account-"));
  config = {
    environment: "test",
    host: "127.0.0.1",
    port: 3417,
    databaseUrl: url.toString(),
    redisUrl: process.env.REDIS_URL!,
    redisKeyPrefix: schema,
    web: {
      origin,
      sessionKey: randomBytes(32).toString("base64"),
      loginTtlSeconds: 900,
      sessionTtlSeconds: 43200,
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
  assert.equal(migrated.status, 0, "isolated migrations");
  await bootPrivacyFixture(config);
  app = await createApplication(config);
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
    await closePrivacyFixture(config);
    await rm(root, { recursive: true, force: true });
  }
});

test("an unusable web login link is rejected without issuing a session", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/v1/web/session",
    headers,
    payload: { ticket: "A".repeat(43) },
  });
  assert.equal(response.statusCode, 401);
  assert.equal(response.headers["set-cookie"], undefined);
  assert.equal(response.headers["cache-control"], "no-store");
});

async function cli(command: string, input: unknown) {
  const id = randomUUID(),
    inputFile = join(root, `${id}.input.json`),
    outputFile = join(root, `${id}.output.json`);
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
        WEB_SESSION_KEY: config.web.sessionKey,
        PRIVACY_JOURNAL_ROOT: config.privacyJournal!.root,
        PRIVACY_JOURNAL_KEY: config.privacyJournal!.key,
      },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, `controlled ${command} command`);
  assert.equal(result.stdout, "", "credentials stay in owner-only output");
  return JSON.parse(await readFile(outputFile, "utf8"));
}

test("a provisioned account signs in without WeChat and restores the same user", async () => {
  const account = await cli("create", {});
  const issued = await cli("issue", { userId: account.user.id });
  const link = new URL(issued.url);
  assert.equal(link.origin, origin);
  assert.equal(link.pathname, "/app/login");
  assert.equal(link.search, "");
  const ticket = new URLSearchParams(link.hash.slice(1)).get("ticket");
  assert.match(ticket!, /^[A-Za-z0-9_-]{43}$/);
  const response = await app.inject({
    method: "POST",
    url: "/v1/web/session",
    headers,
    payload: { ticket },
  });
  assert.equal(response.statusCode, 201);
  assert.deepEqual(response.json().data.user, account.user);
  assert.equal(response.json().data.session.token, undefined);
  assert.doesNotMatch(response.body, new RegExp(ticket!));
  const cookie = String(response.headers["set-cookie"]);
  assert.match(cookie, /__Secure-timenook_web=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Path=\/api\/v1/);
  const current = await app.inject({
    method: "GET",
    url: "/v1/web/session",
    headers: { cookie: cookie.split(";")[0] },
  });
  assert.equal(current.statusCode, 200);
  assert.deepEqual(current.json().data, response.json().data);
  const projects = await app.inject({
    method: "GET",
    url: "/v1/web/projects",
    headers: { cookie: cookie.split(";")[0] },
  });
  assert.equal(projects.statusCode, 200);
  assert.deepEqual(projects.json().data, { projects: [] });
});

test("cross-origin and non-explicit login requests cannot consume a valid link", async () => {
  const account = await cli("create", {}),
    issued = await cli("issue", { userId: account.user.id });
  const ticket = new URLSearchParams(new URL(issued.url).hash.slice(1)).get(
    "ticket",
  );
  for (const attemptedHeaders of [
    {},
    { ...headers, origin: "https://other.example" },
    { origin },
  ]) {
    const rejected = await app.inject({
      method: "POST",
      url: "/v1/web/session",
      headers: attemptedHeaders,
      payload: { ticket },
    });
    assert.equal(rejected.statusCode, 403);
    assert.equal(rejected.headers["set-cookie"], undefined);
  }
  const accepted = await app.inject({
    method: "POST",
    url: "/v1/web/session",
    headers,
    payload: { ticket },
  });
  assert.equal(accepted.statusCode, 201);
});

async function signedIn() {
  const account = await cli("create", {}),
    issued = await cli("issue", { userId: account.user.id });
  const ticket = new URLSearchParams(new URL(issued.url).hash.slice(1)).get(
    "ticket",
  );
  const login = await app.inject({
    method: "POST",
    url: "/v1/web/session",
    headers,
    payload: { ticket },
  });
  assert.equal(login.statusCode, 201);
  return {
    account,
    ticket,
    cookie: String(login.headers["set-cookie"]).split(";")[0],
    data: login.json().data,
  };
}

test("web sessions authorize existing user APIs but require CSRF for state changes and logout", async () => {
  const { account, cookie, data } = await signedIn();
  const me = await app.inject({
    method: "GET",
    url: "/v1/users/me",
    headers: { cookie },
  });
  assert.equal(me.statusCode, 200);
  assert.deepEqual(me.json().data, account.user);
  const rejected = await app.inject({
    method: "DELETE",
    url: `/v1/sessions/${data.session.id}`,
    headers: { ...headers, cookie },
  });
  assert.equal(rejected.statusCode, 403);
  const stillCurrent = await app.inject({
    method: "GET",
    url: "/v1/web/session",
    headers: { cookie },
  });
  assert.equal(stillCurrent.statusCode, 200);
  const logout = await app.inject({
    method: "DELETE",
    url: "/v1/web/session",
    headers: { ...headers, cookie, "x-csrf-token": data.csrfToken },
  });
  assert.equal(logout.statusCode, 204);
  assert.match(
    String(logout.headers["set-cookie"]),
    /Expires=Thu, 01 Jan 1970/,
  );
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: "/v1/users/me",
        headers: { cookie },
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: "/v1/web/session",
        headers: { cookie },
      })
    ).statusCode,
    401,
  );
});

test("operator revocation prevents an unused link from signing in", async () => {
  const account = await cli("create", {}),
    issued = await cli("issue", { userId: account.user.id });
  assert.deepEqual(await cli("revoke", { ticketId: issued.ticket.id }), {
    revoked: true,
  });
  const ticket = new URLSearchParams(new URL(issued.url).hash.slice(1)).get(
    "ticket",
  );
  const rejected = await app.inject({
    method: "POST",
    url: "/v1/web/session",
    headers,
    payload: { ticket },
  });
  assert.equal(rejected.statusCode, 401);
  assert.equal(rejected.headers["set-cookie"], undefined);
});

test("a login link has exactly one winner across concurrent requests and remains consumed after restart", async () => {
  const account = await cli("create", {}),
    issued = await cli("issue", { userId: account.user.id });
  const ticket = new URLSearchParams(new URL(issued.url).hash.slice(1)).get(
    "ticket",
  );
  const attempts = await Promise.all(
    Array.from({ length: 8 }, () =>
      app.inject({
        method: "POST",
        url: "/v1/web/session",
        headers,
        payload: { ticket },
      }),
    ),
  );
  assert.equal(attempts.filter((r) => r.statusCode === 201).length, 1);
  assert.equal(attempts.filter((r) => r.statusCode === 401).length, 7);
  const restarted = await createApplication(config);
  try {
    const replay = await restarted.inject({
      method: "POST",
      url: "/v1/web/session",
      headers,
      payload: { ticket },
    });
    assert.equal(replay.statusCode, 401);
    const winner = attempts.find((r) => r.statusCode === 201)!;
    const current = await restarted.inject({
      method: "GET",
      url: "/v1/web/session",
      headers: { cookie: String(winner.headers["set-cookie"]).split(";")[0] },
    });
    assert.equal(current.statusCode, 200);
    assert.deepEqual(current.json().data.user, account.user);
  } finally {
    await restarted.close();
  }
});

test("login exchange is rate limited independently of the WeChat identity provider", async () => {
  const limited = await createApplication({
    ...config,
    loginLimitPerMinute: 2,
    redisKeyPrefix: `${schema}:limited`,
  });
  try {
    const statuses = [];
    for (let attempt = 0; attempt < 3; attempt++)
      statuses.push(
        (
          await limited.inject({
            method: "POST",
            url: "/v1/web/session",
            headers,
            payload: { ticket: "B".repeat(43) },
          })
        ).statusCode,
      );
    assert.deepEqual(statuses, [401, 401, 429]);
  } finally {
    await limited.close();
  }
});

test("expired links and expired sessions cannot be restored", async (t) => {
  const account = await cli("create", {}),
    issued = await cli("issue", { userId: account.user.id });
  const { cookie, data } = await signedIn();
  const ticket = new URLSearchParams(new URL(issued.url).hash.slice(1)).get(
    "ticket",
  );
  t.mock.timers.enable({
    apis: ["Date"],
    now: Date.parse(data.session.expiresAt) + 1,
  });
  try {
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/v1/web/session",
          headers,
          payload: { ticket },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: "/v1/web/session",
          headers: { cookie },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: "/v1/users/me",
          headers: { cookie },
        })
      ).statusCode,
      401,
    );
  } finally {
    t.mock.timers.reset();
  }
});

test("session credentials and CSRF proofs cannot be mixed between accounts", async () => {
  const first = await signedIn(),
    second = await signedIn();
  for (const wrongProof of [second.data.csrfToken, "中".repeat(43)]) {
    assert.equal(
      (
        await app.inject({
          method: "DELETE",
          url: "/v1/web/session",
          headers: {
            ...headers,
            cookie: first.cookie,
            "x-csrf-token": wrongProof,
          },
        })
      ).statusCode,
      403,
    );
  }
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: "/v1/users/me",
        headers: {
          cookie: first.cookie,
          authorization: `Bearer ${"A".repeat(43)}`,
        },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: "/v1/users/me",
        headers: { cookie: `${first.cookie}; ${second.cookie}` },
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: "/v1/web/session",
        headers: { cookie: first.cookie },
      })
    ).statusCode,
    200,
  );
});

test("web-only startup does not start legacy retention erasure while serving an existing project", async () => {
  const { account, cookie } = await signedIn();
  await app.close();
  const db = new PrismaClient({ datasourceUrl: config.databaseUrl });
  const plans = new ProjectPlans(config.databaseUrl),
    terms = new ProjectServiceTerms(config.databaseUrl);
  const projectId = randomUUID(),
    draftId = randomUUID(),
    versionId = randomUUID();
  try {
    await plans.createProject({ projectId, createdBy: account.user.id });
    const snapshot = JSON.parse(
      await readFile(
        join(__dirname, "../../test/fixtures/catalog-synthetic.json"),
        "utf8",
      ),
    );
    snapshot.admission.d03.retention.activeData.duration.value = 1;
    snapshot.admission.d03.retention = {
      activeData: snapshot.admission.d03.retention.activeData,
    };
    const anchor = new Date(Date.now() - 1000 * 86400000);
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
    await db.project.update({
      where: { id: projectId },
      data: { bookTitle: "合成内测保留书名" },
    });
    await db.$transaction((tx) =>
      terms.activate(tx, projectId, versionId, snapshot, anchor),
    );
    await terms.recordFact({
      projectId,
      eventId: `synthetic-web-delivery-${randomUUID()}`,
      kind: "delivery_completed",
      occurredAt: new Date(anchor.getTime() + 86400000),
    });
    app = await createApplication(config);
    const list = () =>
      app.inject({
        method: "GET",
        url: "/v1/web/projects",
        headers: { cookie },
      });
    assert.deepEqual((await list()).json().data.projects, [
      { id: projectId, bookTitle: "合成内测保留书名", role: "initiator" },
    ]);
    const outsider = await signedIn();
    assert.deepEqual(
      (
        await app.inject({
          method: "GET",
          url: "/v1/web/projects",
          headers: { cookie: outsider.cookie },
        })
      ).json().data,
      { projects: [] },
    );
    await new Promise((resolve) => setTimeout(resolve, 1300));
    assert.deepEqual((await list()).json().data.projects, [
      { id: projectId, bookTitle: "合成内测保留书名", role: "initiator" },
    ]);
    await app.get(Deletions).sweep();
    assert.equal(
      (await list()).json().data.projects[0]?.bookTitle,
      "人生故事书",
      "explicit maintenance still applies existing deletion rules",
    );
  } finally {
    await plans.close();
    await terms.close();
    await db.$disconnect();
  }
});
