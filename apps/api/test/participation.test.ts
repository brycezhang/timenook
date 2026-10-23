import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { before, after, test } from "node:test";
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import { Participation } from "../src/identity/participation";
import { createApplication } from "../src/application";
import type { ApiConfig } from "../src/config";
import { paymentConfig, paymentFetch, paid, callback } from "./payment-fixture";
import { paymentAdmin } from "./payment-admin-fixture";
const schema = `t11_${randomUUID().replaceAll("-", "")}`;
let config: ApiConfig;
let app: Awaited<ReturnType<typeof createApplication>>;
let db: PrismaClient;
const packageId = randomUUID();
const wechatFetch: typeof fetch = async (input) =>
  new Response(
    JSON.stringify({
      openid: new URL(String(input)).searchParams.get("js_code")!.split(":")[0],
      session_key: "synthetic",
    }),
  );
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
      origin: "https://localhost:3443",
      encryptionKey: randomBytes(32).toString("base64"),
      sessionTtlSeconds: 28800,
      challengeTtlSeconds: 300,
    },
    wechat: { appId: "synthetic-timenook", secret: "synthetic-secret" },
    payments: paymentConfig,
    participation: { mode: "synthetic-d08" },
  };
  for (const label of ["fresh", "replay"]) {
    const migrated = spawnSync(
      process.execPath,
      ["node_modules/prisma/build/index.js", "migrate", "deploy"],
      {
        env: { ...process.env, DATABASE_URL: config.databaseUrl },
        encoding: "utf8",
      },
    );
    assert.equal(migrated.status, 0, `isolated migration ${label}`);
  }
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
      purpose: "local_preview",
      draftId,
      draftRevision: 1,
      snapshot,
      publicOffer: {
        title: "合成套餐",
        price: { value: 99900, unit: "fen", currency: "CNY" },
      },
    },
  });
  await db.recipientType.create({
    data: {
      realm: "local",
      code: "mentor",
      label: "恩师",
      revision: 1,
      sortOrder: 0,
      active: true,
    },
  });
  app = await createApplication(config, { wechatFetch, paymentFetch });
});
after(async () => {
  await app?.close();
  if (db) {
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.$disconnect();
  }
  if (config) {
    const redis = new Redis(config.redisUrl, {
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    redis.on("error", () => {});
    try {
      const keys = await redis.keys(`${schema}:*`);
      if (keys.length) await redis.del(...keys);
    } finally {
      redis.disconnect();
    }
  }
});
async function login(who = randomUUID(), target = app) {
  const r = await target.inject({
    method: "POST",
    url: "/v1/sessions/wechat",
    payload: { code: `${who}:${randomUUID()}` },
  });
  assert.equal(r.statusCode, 201, r.body);
  return {
    token: r.json().data.session.token as string,
    id: r.json().data.user.id as string,
    who,
  };
}
function request(
  method: "GET" | "POST",
  url: string,
  token?: string,
  payload?: object,
  key = randomUUID(),
  target = app,
) {
  return target.inject({
    method,
    url,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "idempotency-key": key,
    },
    ...(payload ? { payload } : {}),
  });
}
function data(
  r: { statusCode: number; body: string; json(): any },
  status = 201,
) {
  assert.equal(r.statusCode, status, r.body);
  assert.equal(r.json().error, undefined);
  return r.json().data;
}
async function project() {
  const buyer = await login();
  const order = data(
    await request("POST", "/v1/orders", buyer.token, {
      packageVersionId: packageId,
      recipient: { typeCode: "mentor", relationshipLabel: "恩师" },
      shippingRegionCode: "CN-110000",
      bookTitle: "私人标题不能泄露",
    }),
  );
  data(await request("POST", `/v1/orders/${order.id}/payment`, buyer.token));
  const event = await callback(paid(order.outTradeNo));
  const received = await app.inject({
    method: "POST",
    url: "/v1/webhooks/wechat-pay/payments",
    headers: { ...event.headers, "content-type": "application/json" },
    payload: event.body,
  });
  assert.equal(received.statusCode, 204, received.body);
  const activated = data(
    await request("GET", `/v1/orders/${order.id}`, buyer.token),
    200,
  );
  return {
    buyer,
    orderId: order.id,
    projectId: activated.project.id as string,
    subjectId: activated.project.subject.id as string,
  };
}
test("forwarded invitation exposes only participation information, stores a digest, and an application grants no project access", async () => {
  const p = await project();
  const stranger = await login();
  const invite = data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/invitations`,
      p.buyer.token,
    ),
  );
  assert.match(invite.token, /^[A-Za-z0-9_-]{43}$/);
  const publicView = data(
    await request("GET", `/v1/invitations/${invite.token}`),
    200,
  );
  assert.equal(publicView.title, undefined);
  assert.equal(publicView.subject, undefined);
  assert.deepEqual(publicView.purposes, ["collection", "ai", "sharing"]);
  assert.ok(!JSON.stringify(publicView).includes("私人标题"));
  // Storage inspection is limited to the explicit at-rest secret constraint.
  const rows = await db.$queryRawUnsafe<Array<{ token_hash: string }>>(
    "SELECT token_hash FROM invitations",
  );
  assert.equal(
    rows[0].token_hash,
    createHash("sha256").update(invite.token).digest("hex"),
  );
  const apply = data(
    await request(
      "POST",
      `/v1/invitations/${invite.token}/requests`,
      stranger.token,
      notice(),
    ),
  );
  assert.equal(apply.state, "pending");
  assert.equal(
    (await request("GET", `/v1/projects/${p.projectId}`, stranger.token))
      .statusCode,
    403,
  );
});
const notice = () => ({
  noticeVersion: "synthetic-d08-v1",
  evidenceRef: "synthetic:本人已阅读并申请",
});
const approval = () => ({
  expectedBindingVersion: 0,
  evidenceRef: "synthetic:发起人核验申请者",
});
test("initiator approval binds only one applicant under concurrency, invalidates invitations and starts service terms once", async () => {
  const p = await project();
  const a = await login();
  const b = await login();
  const invite = data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/invitations`,
      p.buyer.token,
    ),
  );
  assert.equal(
    (
      await request(
        "POST",
        `/v1/invitations/${invite.token}/requests`,
        p.buyer.token,
        notice(),
      )
    ).statusCode,
    403,
  );
  const attempts = await Promise.all(
    [a, b].map(async (user) => ({
      user,
      application: data(
        await request(
          "POST",
          `/v1/invitations/${invite.token}/requests`,
          user.token,
          notice(),
        ),
      ),
    })),
  );
  const pending = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/binding-requests`,
      p.buyer.token,
    ),
    200,
  );
  assert.equal(pending.requests.length, 2);
  assert.equal(
    (
      await request(
        "GET",
        `/v1/projects/${p.projectId}/binding-requests`,
        a.token,
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await request(
        "POST",
        `/v1/binding-requests/${attempts[0].application.id}/approve`,
        a.token,
        approval(),
      )
    ).statusCode,
    403,
  );
  const keys = [randomUUID(), randomUUID()];
  const outcomes = await Promise.all(
    attempts.map((attempt, index) =>
      request(
        "POST",
        `/v1/binding-requests/${attempt.application.id}/approve`,
        p.buyer.token,
        approval(),
        keys[index],
      ),
    ),
  );
  assert.deepEqual(outcomes.map((r) => r.statusCode).sort(), [201, 409]);
  const winner = outcomes.findIndex((r) => r.statusCode === 201);
  const state = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/participation`,
      attempts[winner].user.token,
    ),
    200,
  );
  assert.equal(state.subjectId, p.subjectId);
  assert.equal(state.bindingVersion, 1);
  assert.equal(state.accessEpoch, 1);
  const before = data(
    await request("GET", `/v1/orders/${p.orderId}`, p.buyer.token),
    200,
  ).project.terms.creation.startsAt;
  assert.ok(before);
  assert.equal(
    (await request("GET", `/v1/invitations/${invite.token}`)).statusCode,
    404,
  );
  const replay = data(
    await request(
      "POST",
      `/v1/binding-requests/${attempts[winner].application.id}/approve`,
      p.buyer.token,
      approval(),
      keys[winner],
    ),
  );
  assert.equal(replay.bindingVersion, 1);
  assert.equal(
    data(await request("GET", `/v1/orders/${p.orderId}`, p.buyer.token), 200)
      .project.terms.creation.startsAt,
    before,
  );
  assert.equal(
    (
      await request(
        "POST",
        `/v1/projects/${p.projectId}/invitations`,
        p.buyer.token,
      )
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await request(
        "GET",
        `/v1/projects/${p.projectId}`,
        attempts[winner].user.token,
      )
    ).statusCode,
    403,
  );
});
async function bound() {
  const p = await project();
  const narrator = await login();
  const invite = data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/invitations`,
      p.buyer.token,
    ),
  );
  const application = data(
    await request(
      "POST",
      `/v1/invitations/${invite.token}/requests`,
      narrator.token,
      notice(),
    ),
  );
  data(
    await request(
      "POST",
      `/v1/binding-requests/${application.id}/approve`,
      p.buyer.token,
      approval(),
    ),
  );
  return { ...p, narrator };
}
async function state(p: { projectId: string }, token: string) {
  return data(
    await request("GET", `/v1/projects/${p.projectId}/participation`, token),
    200,
  );
}
async function choose(
  p: { projectId: string },
  token: string,
  purpose: string,
  granted: boolean,
  key = randomUUID(),
) {
  const current = await state(p, token);
  const body = {
    ...notice(),
    purpose,
    granted,
    expectedBindingVersion: current.bindingVersion,
    expectedAccessEpoch: current.accessEpoch,
  };
  return {
    body,
    key,
    response: await request(
      "POST",
      `/v1/projects/${p.projectId}/consents`,
      token,
      body,
      key,
    ),
  };
}
test("three purpose decisions stay separate; rejection keeps care and orders, sharing and AI require explicit consent and revocation fences old commands", async () => {
  const p = await bound();
  assert.equal(
    (await request("GET", `/v1/projects/${p.projectId}`, p.narrator.token))
      .statusCode,
    403,
  );
  const denied = data(
    (await choose(p, p.narrator.token, "collection", false)).response,
  );
  assert.equal(denied.canCollect, false);
  assert.equal(denied.careAvailable, true);
  assert.equal(
    data(await request("GET", `/v1/orders/${p.orderId}`, p.buyer.token), 200)
      .state,
    "paid",
  );
  data((await choose(p, p.narrator.token, "ai", true)).response);
  assert.equal((await state(p, p.narrator.token)).canProcessAi, false);
  const accepted = await choose(p, p.narrator.token, "collection", true);
  const active = data(accepted.response);
  assert.equal(active.canCollect, true);
  assert.equal(active.canProcessAi, true);
  const restarted = await createApplication(config, {
    wechatFetch,
    paymentFetch,
  });
  try {
    const replayed = data(
      await request(
        "POST",
        `/v1/projects/${p.projectId}/consents`,
        p.narrator.token,
        accepted.body,
        accepted.key,
        restarted,
      ),
    );
    assert.equal(replayed.accessEpoch, active.accessEpoch);
    assert.equal(replayed.consent.length, active.consent.length);
  } finally {
    await restarted.close();
  }
  assert.equal(
    (await request("GET", `/v1/projects/${p.projectId}`, p.buyer.token))
      .statusCode,
    403,
  );
  data((await choose(p, p.narrator.token, "sharing", true)).response);
  const shared = data(
    await request("GET", `/v1/projects/${p.projectId}`, p.buyer.token),
    200,
  );
  assert.equal(shared.bookTitle, "私人标题不能泄露");
  assert.equal(shared.canCollect, false);
  const own = data(
    await request("GET", `/v1/projects/${p.projectId}`, p.narrator.token),
    200,
  );
  assert.equal(own.canCollect, true);
  const s = await state(p, p.narrator.token);
  const revoked = data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/consents/revoke`,
      p.narrator.token,
      {
        ...notice(),
        purpose: "sharing",
        expectedBindingVersion: s.bindingVersion,
        expectedAccessEpoch: s.accessEpoch,
      },
    ),
  );
  assert.equal(revoked.accessEpoch, s.accessEpoch + 1);
  assert.equal(
    (await request("GET", `/v1/projects/${p.projectId}`, p.buyer.token))
      .statusCode,
    403,
  );
  assert.equal(
    (
      await request(
        "POST",
        `/v1/projects/${p.projectId}/consents`,
        p.narrator.token,
        accepted.body,
        accepted.key,
      )
    ).statusCode,
    403,
  );
  const history = await state(p, p.narrator.token);
  assert.deepEqual(
    Object.keys(history.consent[0]).sort(),
    [
      "subjectId",
      "operatorUserId",
      "purpose",
      "granted",
      "noticeVersion",
      "method",
      "evidenceRef",
      "bindingVersion",
      "accessEpoch",
      "createdAt",
    ].sort(),
    "public consent history exposes only its declared product and audit fields",
  );
  assert.ok(
    history.consent.every(
      (c: any) =>
        c.subjectId === p.subjectId &&
        c.operatorUserId === p.narrator.id &&
        c.noticeVersion === "synthetic-d08-v1" &&
        c.method === "self_wechat" &&
        c.evidenceRef.startsWith("synthetic:"),
    ),
  );
  assert.equal(
    history.consent.filter((c: any) => c.purpose === "sharing").length,
    2,
  );
  const current = await state(p, p.narrator.token);
  assert.equal(
    (
      await request(
        "POST",
        `/v1/projects/${p.projectId}/consents`,
        p.buyer.token,
        {
          ...notice(),
          purpose: "collection",
          granted: true,
          expectedBindingVersion: current.bindingVersion,
          expectedAccessEpoch: current.accessEpoch,
        },
      )
    ).statusCode,
    403,
  );
});
test("care rebinding requires a tracked case, D08 evidence and admin authority, changes one binding once, and denies the old account immediately", async () => {
  const p = await bound();
  const replacement = await login();
  const unrelated = await project();
  const unrelatedInvite = data(
    await request(
      "POST",
      `/v1/projects/${unrelated.projectId}/invitations`,
      unrelated.buyer.token,
    ),
  );
  const unrelatedApply = data(
    await request(
      "POST",
      `/v1/invitations/${unrelatedInvite.token}/requests`,
      p.narrator.token,
      notice(),
    ),
  );
  data(
    await request(
      "POST",
      `/v1/binding-requests/${unrelatedApply.id}/approve`,
      unrelated.buyer.token,
      approval(),
    ),
  );
  data(
    (await choose(unrelated, p.narrator.token, "collection", true)).response,
  );
  const priorConsent = await choose(p, p.narrator.token, "collection", true);
  data(priorConsent.response);
  data((await choose(p, p.narrator.token, "sharing", true)).response);
  const before = data(
    await request("GET", `/v1/orders/${p.orderId}`, p.buyer.token),
    200,
  ).project.terms.creation.startsAt;
  const old = await state(p, p.narrator.token);
  const careKey = randomUUID();
  const careBody = {
    kind: "rebind",
    targetUserId: replacement.id,
    expectedBindingVersion: old.bindingVersion,
  };
  const care = data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/care-requests`,
      p.narrator.token,
      careBody,
      careKey,
    ),
  );
  assert.equal(
    data(
      await request(
        "POST",
        `/v1/projects/${p.projectId}/care-requests`,
        p.narrator.token,
        careBody,
        careKey,
      ),
    ).id,
    care.id,
  );
  assert.equal(
    (
      await request(
        "POST",
        `/v1/projects/${p.projectId}/care-requests`,
        p.narrator.token,
        { ...careBody, targetUserId: (await login()).id },
        careKey,
      )
    ).statusCode,
    409,
  );
  const supportCaseRef = care.supportCaseRef;
  assert.match(supportCaseRef, /^record:/);
  const operator = await paymentAdmin(config, app, [
    "care:write",
    "audit:read",
  ]);
  const observer = await paymentAdmin(config, app, ["ops:read"]);
  const body = {
    supportCaseRef,
    targetUserId: replacement.id,
    expectedBindingVersion: old.bindingVersion,
    ...notice(),
  };
  const change = (
    payload: object,
    headers: Record<string, string> = operator,
    key = randomUUID(),
  ) =>
    app.inject({
      method: "POST",
      url: `/v1/admin/projects/${p.projectId}/rebind`,
      headers: { ...headers, "idempotency-key": key },
      payload,
    });
  assert.equal((await change(body, {})).statusCode, 401);
  assert.equal((await change(body, observer)).statusCode, 403);
  const { "x-csrf-token": ignored, ...noCsrf } = operator;
  assert.equal((await change(body, noCsrf)).statusCode, 403);
  const { evidenceRef: evidence, ...withoutEvidence } = body;
  assert.equal((await change(withoutEvidence)).statusCode, 400);
  const { supportCaseRef: support, ...withoutCase } = body;
  assert.equal((await change(withoutCase)).statusCode, 400);
  assert.equal(
    (await change({ ...body, supportCaseRef: `record:${randomUUID()}` }))
      .statusCode,
    404,
  );
  assert.equal(
    (await change({ ...body, targetUserId: p.buyer.id })).statusCode,
    403,
  );
  const failed = data(
    await app.inject({
      method: "GET",
      url: `/v1/admin/care-requests/${care.id}`,
      headers: operator,
    }),
    200,
  );
  assert.equal(failed.state, "open");
  assert.equal(failed.changes.length, 0);
  assert.equal((await state(p, p.narrator.token)).bindingVersion, 1);
  // Inject a persistence failure after the binding write; the public command
  // must roll back binding, epoch, case completion and success auditing.
  await db.$executeRawUnsafe(
    "CREATE FUNCTION reject_t11_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic T11 persistence fault'; END $$",
  );
  await db.$executeRawUnsafe(
    "CREATE TRIGGER t11_binding_fault AFTER INSERT ON binding_changes FOR EACH ROW WHEN (NEW.method='care_verified') EXECUTE FUNCTION reject_t11_change()",
  );
  try {
    const failedChange = await change(body);
    assert.equal(failedChange.statusCode, 500);
    const afterFailure = await state(p, p.narrator.token);
    assert.equal(afterFailure.bindingVersion, 1);
    assert.equal(afterFailure.accessEpoch, old.accessEpoch);
    const unchanged = data(
      await app.inject({
        method: "GET",
        url: `/v1/admin/care-requests/${care.id}`,
        headers: operator,
      }),
      200,
    );
    assert.equal(unchanged.state, "open");
    assert.deepEqual(unchanged.changes, []);
    const failureAudit = data(
      await app.inject({
        method: "GET",
        url: "/v1/admin/audit",
        headers: operator,
      }),
      200,
    );
    assert.equal(
      failureAudit.some(
        (entry: any) =>
          entry.requestId === failedChange.headers["x-request-id"] &&
          entry.result === "success",
      ),
      false,
    );
  } finally {
    await db.$executeRawUnsafe(
      "DROP TRIGGER t11_binding_fault ON binding_changes",
    );
    await db.$executeRawUnsafe("DROP FUNCTION reject_t11_change()");
  }
  const keys = [randomUUID(), randomUUID()];
  const results = await Promise.all(
    keys.map((key) => change(body, operator, key)),
  );
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [201, 409]);
  const won = results.findIndex((r) => r.statusCode === 201);
  const rebound = data(results[won]);
  assert.equal(rebound.subjectId, p.subjectId);
  assert.equal(rebound.bindingVersion, 2);
  assert.equal(rebound.accessEpoch, old.accessEpoch + 1);
  const replay = data(await change(body, operator, keys[won]));
  assert.equal(replay.bindingVersion, 2);
  assert.equal(replay.accessEpoch, rebound.accessEpoch);
  assert.equal(
    (
      await change(
        { ...body, evidenceRef: "synthetic:不同意图证据" },
        operator,
        keys[won],
      )
    ).statusCode,
    409,
  );
  assert.equal(
    (await request("GET", `/v1/projects/${p.projectId}`, p.narrator.token))
      .statusCode,
    403,
  );
  assert.equal(
    (
      await request(
        "GET",
        `/v1/projects/${p.projectId}/participation`,
        p.narrator.token,
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await request(
        "POST",
        `/v1/projects/${p.projectId}/consents`,
        p.narrator.token,
        priorConsent.body,
        priorConsent.key,
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (await request("GET", `/v1/projects/${p.projectId}`, replacement.token))
      .statusCode,
    403,
  );
  assert.equal(
    (await request("GET", `/v1/projects/${p.projectId}`, p.buyer.token))
      .statusCode,
    403,
  );
  const newState = await state(p, replacement.token);
  assert.equal(
    (
      await request(
        "GET",
        `/v1/projects/${p.projectId}/care-requests`,
        p.narrator.token,
      )
    ).statusCode,
    403,
  );
  assert.equal(newState.canRead, false);
  assert.deepEqual(newState.consent, []);
  const oldRelogin = await login(p.narrator.who);
  assert.equal(
    (await request("GET", `/v1/projects/${p.projectId}`, oldRelogin.token))
      .statusCode,
    403,
  );
  assert.equal(
    data(
      await request(
        "GET",
        `/v1/projects/${unrelated.projectId}`,
        p.narrator.token,
      ),
      200,
    ).canRead,
    true,
  );
  assert.equal(
    data(await request("GET", `/v1/orders/${p.orderId}`, p.buyer.token), 200)
      .project.terms.creation.startsAt,
    before,
  );
  const listed = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/care-requests`,
      p.buyer.token,
    ),
    200,
  );
  assert.equal(listed.requests[0].state, "completed");
  const caseView = data(
    await app.inject({
      method: "GET",
      url: `/v1/admin/care-requests/${care.id}`,
      headers: operator,
    }),
    200,
  );
  assert.deepEqual(
    Object.keys(caseView.changes[0]).sort(),
    [
      "subjectId",
      "sourceBindingVersion",
      "bindingVersion",
      "accessEpoch",
      "operatorId",
      "supportCaseId",
      "noticeVersion",
      "method",
      "evidenceRef",
      "requestId",
      "createdAt",
    ].sort(),
    "care history exposes only its declared traceability fields",
  );
  assert.equal(caseView.changes[0].sourceBindingVersion, 1);
  assert.equal(caseView.changes[0].operatorId, caseView.completedBy);
  assert.equal(caseView.changes[0].evidenceRef, evidence);
  assert.equal(caseView.changes[0].supportCaseId, care.id);
  assert.equal(caseView.changes.length, 1);
  const audit = data(
    await app.inject({
      method: "GET",
      url: "/v1/admin/audit",
      headers: operator,
    }),
    200,
  );
  assert.ok(
    audit.some(
      (entry: any) =>
        entry.action === "care.rebind" && entry.result === "success",
    ),
  );
  data((await choose(p, replacement.token, "collection", true)).response);
  assert.equal(
    data(
      await request("GET", `/v1/projects/${p.projectId}`, replacement.token),
      200,
    ).canRead,
    true,
  );
});
test("expired or superseded invitations cannot apply or approve, and D08 is fail-closed outside isolated tests", async () => {
  const p = await project();
  const narrator = await login();
  const first = data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/invitations`,
      p.buyer.token,
    ),
  );
  const invite = data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/invitations`,
      p.buyer.token,
    ),
  );
  assert.equal(
    (
      await request(
        "POST",
        `/v1/invitations/${first.token}/requests`,
        narrator.token,
        notice(),
      )
    ).statusCode,
    404,
  );
  const application = data(
    await request(
      "POST",
      `/v1/invitations/${invite.token}/requests`,
      narrator.token,
      notice(),
    ),
  );
  // Expire the exact fixture rather than rely on sleeps or a short natural TTL.
  await db.invitation.update({
    where: {
      tokenHash: createHash("sha256").update(invite.token).digest("hex"),
    },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  assert.equal(
    (await request("GET", `/v1/invitations/${invite.token}`)).statusCode,
    404,
  );
  assert.equal(
    (
      await request(
        "POST",
        `/v1/invitations/${invite.token}/requests`,
        narrator.token,
        notice(),
      )
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await request(
        "POST",
        `/v1/binding-requests/${application.id}/approve`,
        p.buyer.token,
        approval(),
      )
    ).statusCode,
    409,
  );
  assert.equal((await state(p, p.buyer.token)).bindingVersion, 0);
  assert.equal(
    data(await request("GET", `/v1/orders/${p.orderId}`, p.buyer.token), 200)
      .project.terms.creation.startsAt,
    null,
  );
  const unconfigured = await createApplication(
    { ...config, participation: undefined },
    { wechatFetch, paymentFetch },
  );
  try {
    assert.equal(
      (
        await request(
          "POST",
          `/v1/projects/${p.projectId}/invitations`,
          p.buyer.token,
          {},
          randomUUID(),
          unconfigured,
        )
      ).statusCode,
      503,
    );
  } finally {
    await unconfigured.close();
  }
  await assert.rejects(
    createApplication(
      { ...config, environment: "production", payments: undefined },
      {},
    ),
    /D08 synthetic participation/,
  );
});

test("assisted collection binds the real unbound subject and logged-in operator, never creates a narrator account", async () => {
  const p = await project();
  const current = await state(p, p.buyer.token);
  const session = data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/assisted-sessions`,
      p.buyer.token,
      {
        ...notice(),
        purpose: "collection",
        granted: true,
        expectedBindingVersion: current.bindingVersion,
        expectedAccessEpoch: current.accessEpoch,
      },
    ),
  );
  assert.equal(session.subjectId, p.subjectId);
  assert.equal(session.operatorUserId, p.buyer.id);
  assert.equal(session.purpose, "collection");
  assert.equal(session.state, "active");
  assert.equal(session.bindingVersion, 0);
  assert.ok(Date.parse(session.expiresAt) > Date.now());
  const result = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/assisted-sessions`,
      p.buyer.token,
    ),
    200,
  );
  assert.equal(result.sessions[0].id, session.id);
  const after = await state(p, p.buyer.token);
  assert.deepEqual(after.choices, [
    { purpose: "collection", granted: true },
    { purpose: "ai", granted: null },
    { purpose: "sharing", granted: null },
  ]);
  assert.equal(after.role, "initiator");
  assert.equal(after.bindingVersion, 0);
  assert.equal(after.canRead, false);
  const terms = data(
    await request("GET", `/v1/orders/${p.orderId}`, p.buyer.token),
    200,
  ).project.terms;
  assert.ok(terms.creation.startsAt);
});

test("assisted authorization rejects payment-only, wrong-purpose, missing evidence and exact server expiry", async (t) => {
  const p = await project();
  const outsider = await login();
  const current = await state(p, p.buyer.token);
  const body = {
    ...notice(),
    purpose: "collection",
    granted: true,
    expectedBindingVersion: 0,
    expectedAccessEpoch: current.accessEpoch,
  };
  const { evidenceRef, ...missing } = body;
  assert.equal(
    (
      await request(
        "POST",
        `/v1/projects/${p.projectId}/assisted-sessions`,
        p.buyer.token,
        missing,
      )
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await request(
        "POST",
        `/v1/projects/${p.projectId}/assisted-sessions`,
        outsider.token,
        body,
      )
    ).statusCode,
    403,
  );
  const session = data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/assisted-sessions`,
      p.buyer.token,
      body,
    ),
  );
  const authorize = (
    id: string,
    purpose: "collection" | "ai" | "story_confirmation",
    operatorUserId = p.buyer.id,
  ) =>
    db.$transaction((tx) =>
      app.get(Participation).authorizeAssisted(tx, {
        projectId: p.projectId,
        sessionId: id,
        operatorUserId,
        purpose,
      }),
    );
  await assert.rejects(authorize(randomUUID(), "collection"), { status: 403 });
  await assert.rejects(authorize(session.id, "ai"), { status: 403 });
  await assert.rejects(authorize(session.id, "story_confirmation"), {
    status: 403,
  });
  await assert.rejects(authorize(session.id, "collection", outsider.id), {
    status: 403,
  });
  assert.equal(
    (await authorize(session.id, "collection")).subjectId,
    p.subjectId,
  );
  t.mock.method(Date, "now", () => Date.parse(session.expiresAt));
  await assert.rejects(authorize(session.id, "collection"), { status: 403 });
  assert.equal(
    data(
      await request(
        "GET",
        `/v1/projects/${p.projectId}/assisted-sessions`,
        p.buyer.token,
      ),
      200,
    ).sessions[0].state,
    "expired",
  );
});

async function assist(
  p: Awaited<ReturnType<typeof project>>,
  purpose = "collection",
  granted = true,
  evidenceRef = `synthetic:${randomUUID()}`,
  key = randomUUID(),
  target = app,
) {
  const current = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/participation`,
      p.buyer.token,
      undefined,
      randomUUID(),
      target,
    ),
    200,
  );
  const sessions = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/assisted-sessions`,
      p.buyer.token,
      undefined,
      randomUUID(),
      target,
    ),
    200,
  ).sessions;
  const expectedSessionId = sessions.find(
    (row: any) => row.purpose === purpose,
  )?.id;
  return request(
    "POST",
    `/v1/projects/${p.projectId}/assisted-sessions`,
    p.buyer.token,
    {
      noticeVersion: "synthetic-d08-v1",
      evidenceRef,
      purpose,
      granted,
      ...(expectedSessionId ? { expectedSessionId } : {}),
      expectedBindingVersion: current.bindingVersion,
      expectedAccessEpoch: current.accessEpoch,
    },
    key,
    target,
  );
}
test("assisted renewal requires new evidence, refusal invalidates prior sessions and later WeChat binding preserves the first participation clock", async () => {
  const p = await project();
  const first = data(await assist(p));
  const start = data(
    await request("GET", `/v1/orders/${p.orderId}`, p.buyer.token),
    200,
  ).project.terms.creation.startsAt;
  assert.equal(
    (await assist(p, "collection", true, first.evidenceRef)).statusCode,
    409,
  );
  const renewed = data(await assist(p));
  assert.notEqual(renewed.id, first.id);
  assert.equal(
    data(await request("GET", `/v1/orders/${p.orderId}`, p.buyer.token), 200)
      .project.terms.creation.startsAt,
    start,
  );
  const refused = data(await assist(p, "collection", false));
  assert.equal(refused.state, "rejected");
  await assert.rejects(
    db.$transaction((tx) =>
      app.get(Participation).authorizeAssisted(tx, {
        projectId: p.projectId,
        sessionId: renewed.id,
        operatorUserId: p.buyer.id,
        purpose: "collection",
      }),
    ),
    { status: 403 },
  );
  const narrator = await login();
  const invite = data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/invitations`,
      p.buyer.token,
    ),
  );
  const application = data(
    await request(
      "POST",
      `/v1/invitations/${invite.token}/requests`,
      narrator.token,
      notice(),
    ),
  );
  data(
    await request(
      "POST",
      `/v1/binding-requests/${application.id}/approve`,
      p.buyer.token,
      approval(),
    ),
  );
  assert.equal(
    data(await request("GET", `/v1/orders/${p.orderId}`, p.buyer.token), 200)
      .project.terms.creation.startsAt,
    start,
  );
  assert.equal((await state(p, narrator.token)).subjectId, p.subjectId);
  const restarted = await createApplication(config, {
    wechatFetch,
    paymentFetch,
  });
  try {
    assert.equal(
      data(
        await request(
          "GET",
          `/v1/projects/${p.projectId}/assisted-sessions`,
          p.buyer.token,
          undefined,
          randomUUID(),
          restarted,
        ),
        200,
      ).sessions.find((row: any) => row.id === first.id).state,
      "revoked",
    );
  } finally {
    await restarted.close();
  }
});

test("trusted content owners record independent evidence for their actual immutable versions in the same transaction", async () => {
  // These are explicit synthetic content-owner fixtures, not a story/book product registry.
  const p = await project();
  const service = app.get(Participation);
  const recording = data(await assist(p));
  const story = {
    kind: "story" as const,
    versionId: randomUUID(),
    hash: "a".repeat(64),
  };
  const command = {
    projectId: p.projectId,
    operatorUserId: p.buyer.id,
    sessionId: recording.id,
    content: story,
    ...notice(),
    evidenceRef: `synthetic:${randomUUID()}`,
    idempotencyKey: randomUUID(),
  };
  await assert.rejects(
    db.$transaction((tx) => service.recordAssistedVersionEvidence(tx, command)),
    { status: 403 },
  );
  const session = data(await assist(p, "story_confirmation"));
  const valid = { ...command, sessionId: session.id };
  await assert.rejects(
    db.$transaction((tx) =>
      service.recordAssistedVersionEvidence(tx, {
        ...valid,
        evidenceRef: session.evidenceRef,
      }),
    ),
    { status: 409 },
  );
  const confirmed = await db.$transaction((tx) =>
    service.recordAssistedVersionEvidence(tx, valid),
  );
  assert.equal(confirmed.subjectId, p.subjectId);
  assert.equal(confirmed.operatorUserId, p.buyer.id);
  assert.deepEqual(confirmed.content, story);
  assert.equal(confirmed.evidenceRef, valid.evidenceRef);
  assert.equal(
    (
      await db.$transaction((tx) =>
        service.recordAssistedVersionEvidence(tx, valid),
      )
    ).id,
    confirmed.id,
  );
  await assert.rejects(
    db.$transaction((tx) =>
      service.recordAssistedVersionEvidence(tx, {
        ...valid,
        content: { ...story, hash: "b".repeat(64) },
      }),
    ),
    { status: 409 },
  );
  await assert.rejects(
    db.$transaction((tx) =>
      service.recordAssistedVersionEvidence(tx, {
        ...valid,
        idempotencyKey: randomUUID(),
      }),
    ),
    { status: 409 },
  );
  const next = {
    ...valid,
    content: { ...story, versionId: randomUUID(), hash: "c".repeat(64) },
    idempotencyKey: randomUUID(),
    evidenceRef: `synthetic:${randomUUID()}`,
  };
  await assert.rejects(
    db.$transaction(async (tx) => {
      await service.recordAssistedVersionEvidence(tx, next);
      throw new Error("synthetic owner rollback");
    }),
    /owner rollback/,
  );
  const afterRollback = await db.$transaction((tx) =>
    service.recordAssistedVersionEvidence(tx, {
      ...next,
      content: { ...next.content, hash: "d".repeat(64) },
    }),
  );
  assert.equal(afterRollback.content.hash, "d".repeat(64));
  await assert.rejects(
    db.$transaction((tx) =>
      service.recordAssistedVersionEvidence(tx, {
        ...next,
        idempotencyKey: randomUUID(),
        content: {
          kind: "book",
          versionId: randomUUID(),
          hash: "e".repeat(64),
        },
        evidenceRef: `synthetic:${randomUUID()}`,
      }),
    ),
    { status: 403 },
  );
});

test("Care first WeChat binding starts from the same unbound subject and records the proxy operator without a fake requester account", async () => {
  const p = await project();
  data(await assist(p));
  const started = data(
    await request("GET", `/v1/orders/${p.orderId}`, p.buyer.token),
    200,
  ).project.terms.creation.startsAt;
  const narrator = await login();
  const operator = await paymentAdmin(config, app, ["care:write"]);
  const care = data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/care-requests`,
      p.buyer.token,
      { kind: "rebind", targetUserId: narrator.id, expectedBindingVersion: 0 },
    ),
  );
  const detail = data(
    await app.inject({
      method: "GET",
      url: `/v1/admin/care-requests/${care.id}`,
      headers: operator,
    }),
    200,
  );
  assert.equal(detail.requesterId, null);
  assert.equal(detail.requesterSubjectId, p.subjectId);
  assert.equal(detail.operatorId, p.buyer.id);
  assert.equal(detail.operatorRealm, "product");
  const body = {
    ...notice(),
    supportCaseRef: `record:${care.id}`,
    targetUserId: narrator.id,
    expectedBindingVersion: 0,
  };
  const key = randomUUID();
  const change = () =>
    app.inject({
      method: "POST",
      url: `/v1/admin/projects/${p.projectId}/rebind`,
      headers: { ...operator, "idempotency-key": key },
      payload: body,
    });
  const changed = data(await change());
  assert.equal(changed.subjectId, p.subjectId);
  assert.equal(changed.bindingVersion, 1);
  assert.deepEqual(data(await change()), changed);
  assert.equal((await state(p, narrator.token)).subjectId, p.subjectId);
  assert.equal(
    data(await request("GET", `/v1/orders/${p.orderId}`, p.buyer.token), 200)
      .project.terms.creation.startsAt,
    started,
  );
  const priorSession = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/assisted-sessions`,
      p.buyer.token,
    ),
    200,
  ).sessions[0];
  await assert.rejects(
    db.$transaction((tx) =>
      app.get(Participation).authorizeAssisted(tx, {
        projectId: p.projectId,
        sessionId: priorSession.id,
        operatorUserId: p.buyer.id,
        purpose: "collection",
      }),
    ),
    { status: 403 },
  );
});

test("unbound subject rights requests recover through Care and verified withdrawal revokes current access with the real admin actor", async () => {
  const p = await project();
  data(await assist(p, "collection"));
  data(await assist(p, "sharing"));
  const session = data(await assist(p));
  const operator = await paymentAdmin(config, app, [
    "care:write",
    "audit:read",
  ]);
  const observer = await paymentAdmin(config, app, ["ops:read"]);
  const current = await state(p, p.buyer.token);
  const key = randomUUID();
  const body = { kind: "withdraw", expectedBindingVersion: 0 };
  const create = () =>
    request(
      "POST",
      `/v1/projects/${p.projectId}/care-requests`,
      p.buyer.token,
      body,
      key,
    );
  const care = data(await create());
  assert.equal(data(await create()).id, care.id);
  assert.equal(care.requesterId, null);
  assert.equal(care.requesterSubjectId, p.subjectId);
  assert.equal(care.operatorId, p.buyer.id);
  assert.equal(
    data(
      await request(
        "GET",
        `/v1/projects/${p.projectId}/care-requests`,
        p.buyer.token,
      ),
      200,
    ).requests[0].state,
    "open",
  );
  const verification = {
    ...notice(),
    expectedBindingVersion: 0,
    expectedAccessEpoch: current.accessEpoch,
  };
  const verifyKey = randomUUID();
  const verify = (
    headers: Record<string, string> = operator,
    payload: object = verification,
  ) =>
    app.inject({
      method: "POST",
      url: `/v1/admin/care-requests/${care.id}/verify`,
      headers: { ...headers, "idempotency-key": verifyKey },
      payload,
    });
  assert.equal((await verify(observer)).statusCode, 403);
  const { "x-csrf-token": csrf, ...noCsrf } = operator;
  assert.equal((await verify(noCsrf)).statusCode, 403);
  const verified = data(await verify());
  assert.equal(verified.state, "verified");
  assert.equal(verified.currentAccessRevoked, true);
  assert.deepEqual(data(await verify()), verified);
  const after = await state(p, p.buyer.token);
  assert.equal(after.accessEpoch, current.accessEpoch + 1);
  assert.ok(after.choices.every((choice: any) => choice.granted === false));
  assert.equal(after.canRead, false);
  await assert.rejects(
    db.$transaction((tx) =>
      app.get(Participation).authorizeAssisted(tx, {
        projectId: p.projectId,
        sessionId: session.id,
        operatorUserId: p.buyer.id,
        purpose: "collection",
      }),
    ),
    { status: 403 },
  );
  const detail = data(
    await app.inject({
      method: "GET",
      url: `/v1/admin/care-requests/${care.id}`,
      headers: operator,
    }),
    200,
  );
  assert.equal(detail.verification.method, "care_verified");
  assert.ok(detail.verification.operatorAdminId);
  assert.equal(detail.verification.evidenceRef, verification.evidenceRef);
  assert.equal(detail.requesterSubjectId, p.subjectId);
  assert.equal(detail.requesterId, null);
  const exported = data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/care-requests`,
      p.buyer.token,
      { kind: "export", expectedBindingVersion: 0 },
    ),
  );
  const exportVerified = data(
    await app.inject({
      method: "POST",
      url: `/v1/admin/care-requests/${exported.id}/verify`,
      headers: { ...operator, "idempotency-key": randomUUID() },
      payload: {
        ...notice(),
        expectedBindingVersion: 0,
        expectedAccessEpoch: after.accessEpoch,
      },
    }),
  );
  assert.equal(exportVerified.state, "verified");
  assert.equal(exportVerified.currentAccessRevoked, false);
  assert.equal(exportVerified.fulfillment, "pending-consumer");
});

test("assisted decisions serialize on the project and persistence faults roll back sessions, participation and consent", async () => {
  const p = await project();
  const body = {
    ...notice(),
    evidenceRef: `synthetic:${randomUUID()}`,
    purpose: "collection",
    granted: true,
    expectedBindingVersion: 0,
    expectedAccessEpoch: 0,
  };
  const outcomes = await Promise.all([
    request(
      "POST",
      `/v1/projects/${p.projectId}/assisted-sessions`,
      p.buyer.token,
      body,
    ),
    request(
      "POST",
      `/v1/projects/${p.projectId}/assisted-sessions`,
      p.buyer.token,
      { ...body, evidenceRef: `synthetic:${randomUUID()}` },
    ),
  ]);
  assert.deepEqual(outcomes.map((r) => r.statusCode).sort(), [201, 409]);
  const q = await project();
  const initial = await state(q, q.buyer.token);
  const key = randomUUID();
  const command = { ...body, evidenceRef: `synthetic:${randomUUID()}` };
  await db.$executeRawUnsafe(
    "CREATE FUNCTION reject_t12_consent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic T12 consent fault'; END $$",
  );
  await db.$executeRawUnsafe(
    "CREATE TRIGGER t12_consent_fault AFTER INSERT ON consent_records FOR EACH ROW WHEN (NEW.method='assisted') EXECUTE FUNCTION reject_t12_consent()",
  );
  try {
    assert.equal(
      (
        await request(
          "POST",
          `/v1/projects/${q.projectId}/assisted-sessions`,
          q.buyer.token,
          command,
          key,
        )
      ).statusCode,
      500,
    );
    assert.equal(
      (await state(q, q.buyer.token)).accessEpoch,
      initial.accessEpoch,
    );
    assert.deepEqual(
      data(
        await request(
          "GET",
          `/v1/projects/${q.projectId}/assisted-sessions`,
          q.buyer.token,
        ),
        200,
      ).sessions,
      [],
    );
    assert.equal(
      data(await request("GET", `/v1/orders/${q.orderId}`, q.buyer.token), 200)
        .project.terms.creation.startsAt,
      null,
    );
  } finally {
    await db.$executeRawUnsafe(
      "DROP TRIGGER t12_consent_fault ON consent_records",
    );
    await db.$executeRawUnsafe("DROP FUNCTION reject_t12_consent()");
  }
  const created = data(
    await request(
      "POST",
      `/v1/projects/${q.projectId}/assisted-sessions`,
      q.buyer.token,
      command,
      key,
    ),
  );
  assert.equal(
    data(
      await request(
        "POST",
        `/v1/projects/${q.projectId}/assisted-sessions`,
        q.buyer.token,
        command,
        key,
      ),
    ).id,
    created.id,
  );
});

test("Care manual intake names the subject and admin separately; withdrawal faults roll back permission, evidence and case verification", async () => {
  const p = await project();
  data(await assist(p));
  const initial = await state(p, p.buyer.token);
  const operator = await paymentAdmin(config, app, [
    "care:write",
    "audit:read",
  ]);
  const key = randomUUID(),
    body = { kind: "withdraw", expectedBindingVersion: 0 };
  const intake = () =>
    app.inject({
      method: "POST",
      url: `/v1/admin/projects/${p.projectId}/care-requests`,
      headers: { ...operator, "idempotency-key": key },
      payload: body,
    });
  const care = data(await intake());
  assert.equal(data(await intake()).id, care.id);
  assert.equal(care.requesterId, null);
  assert.equal(care.requesterSubjectId, p.subjectId);
  assert.equal(care.operatorRealm, "admin");
  assert.notEqual(care.operatorId, p.buyer.id);
  const verificationKey = randomUUID();
  const verify = () =>
    app.inject({
      method: "POST",
      url: `/v1/admin/care-requests/${care.id}/verify`,
      headers: { ...operator, "idempotency-key": verificationKey },
      payload: {
        ...notice(),
        expectedBindingVersion: 0,
        expectedAccessEpoch: initial.accessEpoch,
      },
    });
  await db.$executeRawUnsafe(
    "CREATE FUNCTION reject_t12_verification() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic T12 verification fault'; END $$",
  );
  await db.$executeRawUnsafe(
    "CREATE TRIGGER t12_verification_fault AFTER UPDATE ON care_requests FOR EACH ROW WHEN (NEW.state='verified') EXECUTE FUNCTION reject_t12_verification()",
  );
  try {
    assert.equal((await verify()).statusCode, 500);
    assert.equal(
      (await state(p, p.buyer.token)).accessEpoch,
      initial.accessEpoch,
    );
    const detail = data(
      await app.inject({
        method: "GET",
        url: `/v1/admin/care-requests/${care.id}`,
        headers: operator,
      }),
      200,
    );
    assert.equal(detail.state, "open");
    assert.equal(detail.verification, null);
  } finally {
    await db.$executeRawUnsafe(
      "DROP TRIGGER t12_verification_fault ON care_requests",
    );
    await db.$executeRawUnsafe("DROP FUNCTION reject_t12_verification()");
  }
  assert.equal(data(await verify()).state, "verified");
});

test("assisted purposes remain independently active, same-purpose renewal replaces only itself, and refusal never changes another purpose", async () => {
  const p = await project();
  const collection = data(await assist(p, "collection"));
  const ai = data(await assist(p, "ai"));
  const sharing = data(await assist(p, "sharing"));
  const sessions = () =>
    request(
      "GET",
      `/v1/projects/${p.projectId}/assisted-sessions`,
      p.buyer.token,
    );
  assert.deepEqual(
    data(await sessions(), 200).sessions.map((row: any) => row.state),
    ["active", "active", "active"],
  );
  const authorize = (row: any) =>
    db.$transaction((tx) =>
      app
        .get(Participation)
        .authorizeAssisted(tx, {
          projectId: p.projectId,
          sessionId: row.id,
          operatorUserId: p.buyer.id,
          purpose: row.purpose,
        }),
    );
  for (const row of [collection, ai, sharing])
    assert.equal((await authorize(row)).subjectId, p.subjectId);
  assert.equal(
    data(
      await request("GET", `/v1/projects/${p.projectId}`, p.buyer.token),
      200,
    ).bookTitle,
    "私人标题不能泄露",
  );
  const originalEpoch = (await state(p, p.buyer.token)).accessEpoch;
  const rejected = data(await assist(p, "ai", false));
  assert.equal(rejected.state, "rejected");
  assert.equal((await state(p, p.buyer.token)).accessEpoch, originalEpoch);
  await assert.rejects(authorize(ai), { status: 403 });
  for (const row of [collection, sharing])
    assert.equal((await authorize(row)).subjectId, p.subjectId);
  const renewed = data(await assist(p, "collection"));
  await assert.rejects(authorize(collection), { status: 403 });
  assert.equal((await authorize(renewed)).subjectId, p.subjectId);
  assert.equal((await authorize(sharing)).subjectId, p.subjectId);
  await assert.rejects(authorize(ai), { status: 403 });
});

test("assisted sharing expiry at the exact deadline stops private project reads while collection is still active", async (t) => {
  const p = await project();
  const sharing = data(await assist(p, "sharing"));
  const collection = data(await assist(p, "collection"));
  assert.ok(Date.parse(collection.expiresAt) > Date.parse(sharing.expiresAt));
  assert.equal(
    data(
      await request("GET", `/v1/projects/${p.projectId}`, p.buyer.token),
      200,
    ).canRead,
    true,
  );
  t.mock.method(Date, "now", () => Date.parse(sharing.expiresAt));
  assert.equal(
    (await request("GET", `/v1/projects/${p.projectId}`, p.buyer.token))
      .statusCode,
    403,
  );
  const listed = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/assisted-sessions`,
      p.buyer.token,
    ),
    200,
  ).sessions;
  assert.equal(
    listed.find((row: any) => row.id === sharing.id).state,
    "expired",
  );
  assert.equal((await state(p, p.buyer.token)).canRead, false);
  assert.equal(
    (
      await db.$transaction((tx) =>
        app
          .get(Participation)
          .authorizeAssisted(tx, {
            projectId: p.projectId,
            sessionId: collection.id,
            operatorUserId: p.buyer.id,
            purpose: "collection",
          }),
      )
    ).subjectId,
    p.subjectId,
  );
});

test("assisted same-purpose CAS rejects concurrent and late decisions even when all session times are equal", async () => {
  const p = await project();
  await db.$executeRawUnsafe(
    "CREATE FUNCTION same_t12_session_time() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.created_at := '2000-01-01T00:00:00Z'::timestamptz; RETURN NEW; END $$",
  );
  await db.$executeRawUnsafe(
    "CREATE TRIGGER t12_same_time BEFORE INSERT ON assisted_sessions FOR EACH ROW EXECUTE FUNCTION same_t12_session_time()",
  );
  try {
    const first = data(await assist(p));
    const epoch = (await state(p, p.buyer.token)).accessEpoch;
    const body = {
      ...notice(),
      evidenceRef: `synthetic:${randomUUID()}`,
      purpose: "collection",
      granted: true,
      expectedBindingVersion: 0,
      expectedAccessEpoch: epoch,
      expectedSessionId: first.id,
    };
    const key = randomUUID();
    const outcomes = await Promise.all([
      request(
        "POST",
        `/v1/projects/${p.projectId}/assisted-sessions`,
        p.buyer.token,
        body,
        key,
      ),
      request(
        "POST",
        `/v1/projects/${p.projectId}/assisted-sessions`,
        p.buyer.token,
        { ...body, evidenceRef: `synthetic:${randomUUID()}` },
      ),
    ]);
    assert.deepEqual(outcomes.map((r) => r.statusCode).sort(), [201, 409]);
    const winner = data(outcomes.find((r) => r.statusCode === 201)!);
    const listed = data(
      await request(
        "GET",
        `/v1/projects/${p.projectId}/assisted-sessions`,
        p.buyer.token,
      ),
      200,
    ).sessions;
    assert.equal(listed[0].id, winner.id);
    assert.equal(listed[0].createdAt, first.createdAt);
    assert.equal(
      listed.find((row: any) => row.id === first.id).state,
      "revoked",
    );
    const late = await request(
      "POST",
      `/v1/projects/${p.projectId}/assisted-sessions`,
      p.buyer.token,
      { ...body, granted: false, evidenceRef: `synthetic:${randomUUID()}` },
    );
    assert.equal(late.statusCode, 409);
    const otherPurposes = await Promise.all([
      request(
        "POST",
        `/v1/projects/${p.projectId}/assisted-sessions`,
        p.buyer.token,
        {
          ...body,
          purpose: "ai",
          expectedSessionId: undefined,
          evidenceRef: `synthetic:${randomUUID()}`,
        },
      ),
      request(
        "POST",
        `/v1/projects/${p.projectId}/assisted-sessions`,
        p.buyer.token,
        {
          ...body,
          purpose: "sharing",
          expectedSessionId: undefined,
          evidenceRef: `synthetic:${randomUUID()}`,
        },
      ),
    ]);
    assert.deepEqual(
      otherPurposes.map((r) => r.statusCode),
      [201, 201],
    );
    const replay = await request(
      "POST",
      `/v1/projects/${p.projectId}/assisted-sessions`,
      p.buyer.token,
      body,
      key,
    );
    if (outcomes[0].statusCode === 201)
      assert.equal(data(replay).id, winner.id);
    else assert.equal(replay.statusCode, 409);
  } finally {
    await db.$executeRawUnsafe(
      "DROP TRIGGER t12_same_time ON assisted_sessions",
    );
    await db.$executeRawUnsafe("DROP FUNCTION same_t12_session_time()");
  }
});

test("narrator and Care global revocations keep old assisted sessions invalid after unrelated fresh grants", async () => {
  const p = await bound();
  const collection = data(await assist(p, "collection"));
  const ai = data(await assist(p, "ai"));
  const sharing = data(await assist(p, "sharing"));
  const oldEpoch = (await state(p, p.buyer.token)).accessEpoch;
  const authorize = (row: any) =>
    db.$transaction((tx) =>
      app
        .get(Participation)
        .authorizeAssisted(tx, {
          projectId: p.projectId,
          sessionId: row.id,
          operatorUserId: p.buyer.id,
          purpose: row.purpose,
        }),
    );
  data((await choose(p, p.narrator.token, "ai", false)).response);
  assert.equal((await state(p, p.buyer.token)).accessEpoch, oldEpoch + 1);
  for (const row of [collection, ai, sharing])
    await assert.rejects(authorize(row), { status: 403 });
  data(await assist(p, "ai"));
  for (const row of [collection, ai, sharing])
    await assert.rejects(authorize(row), { status: 403 });
  assert.equal(
    (await request("GET", `/v1/projects/${p.projectId}`, p.buyer.token))
      .statusCode,
    403,
  );
  const freshCollection = data(await assist(p, "collection"));
  const freshSharing = data(await assist(p, "sharing"));
  assert.equal(
    data(
      await request("GET", `/v1/projects/${p.projectId}`, p.buyer.token),
      200,
    ).canRead,
    true,
  );
  const current = await state(p, p.buyer.token),
    operator = await paymentAdmin(config, app, ["care:write"]);
  const care = data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/care-requests`,
      p.buyer.token,
      { kind: "withdraw", expectedBindingVersion: current.bindingVersion },
    ),
  );
  data(
    await app.inject({
      method: "POST",
      url: `/v1/admin/care-requests/${care.id}/verify`,
      headers: { ...operator, "idempotency-key": randomUUID() },
      payload: {
        ...notice(),
        expectedBindingVersion: current.bindingVersion,
        expectedAccessEpoch: current.accessEpoch,
      },
    }),
  );
  data(await assist(p, "ai"));
  for (const row of [freshCollection, freshSharing])
    await assert.rejects(authorize(row), { status: 403 });
  assert.equal(
    (await request("GET", `/v1/projects/${p.projectId}`, p.buyer.token))
      .statusCode,
    403,
  );
});
