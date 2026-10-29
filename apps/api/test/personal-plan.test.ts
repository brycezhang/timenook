import { bootPrivacyFixture, closePrivacyFixture } from "./privacy-fixture";
import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { before, after, test } from "node:test";
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import { ProjectPlans } from "../src/projects/project-plans";
import { Participation } from "../src/identity/participation";
import { createOpenApiDocument } from "../src/application";
import { createAdminApplication as createApplication } from "./admin-feishu-fixture";
import type { ApiConfig } from "../src/config";
import { paymentConfig, paymentFetch, paid, callback } from "./payment-fixture";
import { paymentAdmin } from "./payment-admin-fixture";
const schema = `t13_${randomUUID().replaceAll("-", "")}`;
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
    port: 3420,
    databaseUrl: url.toString(),
    redisUrl: process.env.REDIS_URL,
    redisKeyPrefix: schema,
    admin: {
      origin: "https://localhost:3443",
      sessionKey: randomBytes(32).toString("base64"),
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
  await bootPrivacyFixture(config);
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
const notice = () => ({
  noticeVersion: "synthetic-d08-v1",
  evidenceRef: "synthetic:本人已阅读并申请",
});
const approval = () => ({
  expectedBindingVersion: 0,
  evidenceRef: "synthetic:发起人核验申请者",
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

test("personal plan is private to currently authorized participants and supports an independent blank plan", async () => {
  const p = await bound();
  const stranger = await login();
  const url = `/v1/projects/${p.projectId}/plan`;
  assert.equal((await request("GET", url)).statusCode, 401);
  assert.equal((await request("GET", url, stranger.token)).statusCode, 403);
  assert.equal((await request("GET", url, p.buyer.token)).statusCode, 403);
  assert.equal((await request("GET", url, p.narrator.token)).statusCode, 403);
  data((await choose(p, p.narrator.token, "collection", true)).response);
  const original = data(await request("GET", url, p.narrator.token), 200);
  assert.equal(original.revision, 1);
  assert.equal(
    original.chapters[0].questions[0].text,
    "有没有一个地方，你现在还想说说它的样子？",
  );
  data((await choose(p, p.narrator.token, "sharing", true)).response);
  const blank = data(
    await request("POST", url, p.buyer.token, {
      expectedVersion: original.revision,
      content: { chapters: [], starters: original.starters },
    }),
    201,
  );
  assert.equal(blank.createdBy, p.buyer.id);
  assert.deepEqual(blank.chapters, []);
  assert.deepEqual(
    blank.starters.map((s: any) => s.kind),
    ["photo", "free-narration"],
  );
  assert.equal(
    data(await request("GET", url, p.narrator.token), 200).revision,
    2,
  );
});

test("two authorized roles atomically conflict while chapter and question edits preserve their own ordered content", async () => {
  const p = await bound();
  data((await choose(p, p.narrator.token, "collection", true)).response);
  data((await choose(p, p.narrator.token, "sharing", true)).response);
  const url = `/v1/projects/${p.projectId}/plan`;
  const original = data(await request("GET", url, p.buyer.token), 200);
  const custom = {
    ...original.chapters[0].questions[0],
    key: "custom",
    text: "那间小屋是什么样的？",
  };
  const content = {
    chapters: [
      { key: "my-place", title: "我的小屋", questions: [custom] },
      ...original.chapters.slice(0, 2).reverse(),
    ],
    starters: original.starters,
  };
  const outcomes = await Promise.all(
    [p.buyer.token, p.narrator.token].map((token) =>
      request("POST", url, token, { expectedVersion: 1, content }),
    ),
  );
  assert.deepEqual(outcomes.map((r) => r.statusCode).sort(), [201, 409]);
  assert.equal(
    outcomes.find((r) => r.statusCode === 409)!.json().error.code,
    "CONFLICT",
  );
  const current = data(await request("GET", url, p.narrator.token), 200);
  assert.deepEqual(
    current.chapters.map((c: any) => c.title),
    ["我的小屋", "生活里的片段", "记得的地方"],
  );
  assert.equal(current.chapters[0].questions[0].text, "那间小屋是什么样的？");
  assert.equal(current.revision, 2);
  const invalid = await request("POST", url, p.buyer.token, {
    expectedVersion: 2,
    content,
    createdBy: p.narrator.id,
  });
  assert.equal(invalid.statusCode, 400);
});

test("subject decisions separately persist later, skipped, not-applicable and blocked topics and ordinary edits cannot reset them", async () => {
  const p = await bound();
  data((await choose(p, p.narrator.token, "collection", true)).response);
  data((await choose(p, p.narrator.token, "sharing", true)).response);
  const url = `/v1/projects/${p.projectId}/plan`;
  const original = data(await request("GET", url, p.narrator.token), 200);
  const keys = original.chapters.flatMap((c: any) =>
    c.questions.map((q: any) => q.key),
  );
  const body = {
    expectedVersion: 1,
    questionStates: [
      { questionKey: keys[0], state: "later" },
      { questionKey: keys[1], state: "skipped" },
      { questionKey: keys[2], state: "not-applicable" },
    ],
    blockedTopics: ["work"],
  };
  assert.equal(
    (await request("POST", `${url}/preferences`, p.buyer.token, body))
      .statusCode,
    403,
  );
  const saved = data(
    await request("POST", `${url}/preferences`, p.narrator.token, body),
  );
  assert.deepEqual(saved.questionStates, body.questionStates);
  assert.deepEqual(saved.preferences, { version: 2, blockedTopics: ["work"] });
  const edited = data(
    await request("POST", url, p.buyer.token, {
      expectedVersion: 1,
      content: { chapters: [], starters: original.starters },
    }),
  );
  assert.deepEqual(edited.questionStates, body.questionStates);
  assert.deepEqual(edited.preferences, { version: 2, blockedTopics: ["work"] });
  assert.equal(
    (await request("POST", `${url}/preferences`, p.narrator.token, body))
      .statusCode,
    409,
  );
  const unblocked = data(
    await request("POST", `${url}/preferences`, p.narrator.token, {
      ...body,
      expectedVersion: 2,
      blockedTopics: [],
    }),
  );
  assert.deepEqual(unblocked.preferences, { version: 3, blockedTopics: [] });
  assert.deepEqual(
    unblocked.preferenceHistory.map((h: any) => ({
      actor: h.operatorUserId,
      method: h.method,
      topics: h.blockedTopics,
    })),
    [
      { actor: p.narrator.id, method: "self_wechat", topics: ["work"] },
      { actor: p.narrator.id, method: "self_wechat", topics: [] },
    ],
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

test("only latest live assisted collection evidence can express subject preferences and expiry or Care withdrawal closes plan access", async () => {
  const p = await project();
  const collection = data(await assist(p));
  data(await assist(p, "sharing"));
  const url = `/v1/projects/${p.projectId}/plan`;
  const original = data(await request("GET", url, p.buyer.token), 200);
  const body = {
    expectedVersion: 1,
    questionStates: [],
    blockedTopics: ["work"],
    assistedSessionId: collection.id,
  };
  const blocked = data(
    await request("POST", `${url}/preferences`, p.buyer.token, body),
  );
  assert.equal(blocked.preferenceHistory[0].operatorUserId, p.buyer.id);
  assert.equal(blocked.preferenceHistory[0].subjectId, p.subjectId);
  assert.equal(blocked.preferenceHistory[0].method, "assisted");
  assert.equal(blocked.preferenceHistory[0].assistedSessionId, collection.id);
  assert.equal(
    (
      await request("POST", `${url}/preferences`, p.buyer.token, {
        ...body,
        assistedSessionId: undefined,
        expectedVersion: 2,
        blockedTopics: [],
      })
    ).statusCode,
    403,
  );
  const fresh = data(await assist(p));
  assert.equal(
    (
      await request("POST", `${url}/preferences`, p.buyer.token, {
        ...body,
        expectedVersion: 2,
        blockedTopics: [],
      })
    ).statusCode,
    403,
  );
  // Controlled expiry fixture, no short TTL or natural sleep.
  const source = await db.assistedSession.findUniqueOrThrow({
    where: { id: fresh.id },
  });
  const expired = await db.assistedSession.create({
    data: {
      ...source,
      sequence: undefined,
      id: randomUUID(),
      idempotencyKey: randomUUID(),
      evidenceRef: `synthetic:expired-${randomUUID()}`,
      createdAt: new Date(Date.now() - 1200000),
      expiresAt: new Date(Date.now() - 1000),
    },
  });
  assert.equal((await request("GET", url, p.buyer.token)).statusCode, 403);
  assert.equal(
    (
      await request("POST", `${url}/preferences`, p.buyer.token, {
        ...body,
        assistedSessionId: expired.id,
        expectedVersion: 2,
        blockedTopics: [],
      })
    ).statusCode,
    403,
  );
  const renewed = data(await assist(p));
  const restarted = await createApplication(config, {
    wechatFetch,
    paymentFetch,
  });
  try {
    const restored = data(
      await request(
        "GET",
        url,
        p.buyer.token,
        undefined,
        randomUUID(),
        restarted,
      ),
      200,
    );
    assert.deepEqual(restored.preferences.blockedTopics, ["work"]);
    assert.ok(Date.parse(restored.accessExpiresAt) > Date.now());
  } finally {
    await restarted.close();
  }
  const unblocked = data(
    await request("POST", `${url}/preferences`, p.buyer.token, {
      ...body,
      expectedVersion: 2,
      blockedTopics: [],
      assistedSessionId: renewed.id,
    }),
  );
  assert.deepEqual(unblocked.preferences.blockedTopics, []);
  const current = await state(p, p.buyer.token);
  const care = data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/care-requests`,
      p.buyer.token,
      { kind: "withdraw", expectedBindingVersion: current.bindingVersion },
    ),
  );
  const admin = await paymentAdmin(config, app, ["care:write"]);
  data(
    await app.inject({
      method: "POST",
      url: `/v1/admin/care-requests/${care.id}/verify`,
      headers: { ...admin, "idempotency-key": randomUUID() },
      payload: {
        ...notice(),
        expectedBindingVersion: current.bindingVersion,
        expectedAccessEpoch: current.accessEpoch,
      },
    }),
  );
  assert.equal((await request("GET", url, p.buyer.token)).statusCode, 403);
  assert.equal(
    (
      await request("POST", url, p.buyer.token, {
        expectedVersion: original.revision,
        content: { chapters: [], starters: original.starters },
      })
    ).statusCode,
    403,
  );
});

test("actual questions and answered associations survive later wording, chapter removal and a process restart", async () => {
  const p = await bound();
  data((await choose(p, p.narrator.token, "collection", true)).response);
  const plans = new ProjectPlans(config.databaseUrl);
  const url = `/v1/projects/${p.projectId}/plan`;
  const original = data(await request("GET", url, p.narrator.token), 200);
  const command = {
    id: randomUUID(),
    projectId: p.projectId,
    expectedPlanRevision: 1,
    capturedBy: p.narrator.id,
    questionKey: original.chapters[0].questions[0].key,
  };
  try {
    const actual = await app
      .get(Participation)
      .withPlanAccess(
        p.projectId,
        `Bearer ${p.narrator.token}`,
        undefined,
        (tx) => plans.captureActualQuestion(command, tx),
      );
    const linked = await app
      .get(Participation)
      .withPlanAccess(
        p.projectId,
        `Bearer ${p.narrator.token}`,
        undefined,
        (tx) =>
          plans.linkActualAnswer(
            {
              projectId: p.projectId,
              actualQuestionId: actual.id,
              answerRef: "synthetic-answer:recording-1",
            },
            tx,
          ),
      );
    assert.equal(
      linked.snapshot.text,
      "有没有一个地方，你现在还想说说它的样子？",
    );
    const changed = structuredClone(original.chapters);
    changed[0].questions[0].text = "以后换一个问法";
    data(
      await request("POST", url, p.narrator.token, {
        expectedVersion: 1,
        content: { chapters: changed, starters: original.starters },
      }),
    );
    data(
      await request("POST", url, p.narrator.token, {
        expectedVersion: 2,
        content: { chapters: [], starters: original.starters },
      }),
    );
    const restarted = await createApplication(config, {
      wechatFetch,
      paymentFetch,
    });
    try {
      const restored = data(
        await request(
          "GET",
          url,
          p.narrator.token,
          undefined,
          randomUUID(),
          restarted,
        ),
        200,
      );
      assert.equal(restored.actualQuestions.length, 1);
      assert.equal(
        restored.actualQuestions[0].snapshot.text,
        "有没有一个地方，你现在还想说说它的样子？",
      );
      assert.equal(
        restored.actualQuestions[0].answerRef,
        "synthetic-answer:recording-1",
      );
      assert.equal(restored.actualQuestions[0].planRevision, 1);
    } finally {
      await restarted.close();
    }
  } finally {
    await plans.close();
  }
});

test("future-question edits leave the actual directory token valid and only actual directory changes fence a future Book consumer", async () => {
  const p = await bound();
  data((await choose(p, p.narrator.token, "collection", true)).response);
  const plans = new ProjectPlans(config.databaseUrl);
  const access = <T>(
    work: (tx: import("@prisma/client").Prisma.TransactionClient) => Promise<T>,
  ) =>
    app
      .get(Participation)
      .withPlanAccess(
        p.projectId,
        `Bearer ${p.narrator.token}`,
        undefined,
        work,
      );
  try {
    const original = await access((tx) => plans.directory(p.projectId, tx));
    assert.deepEqual(original.chapters, []);
    const first = await access((tx) =>
      plans.reviseDirectory(
        {
          projectId: p.projectId,
          expectedVersion: original.version,
          createdBy: p.narrator.id,
          chapters: [
            {
              key: "places",
              title: "实际入书章节",
              storyRefs: ["synthetic-story:confirmed-version-1"],
            },
          ],
        },
        tx,
      ),
    );
    const url = `/v1/projects/${p.projectId}/plan`;
    const plan = data(await request("GET", url, p.narrator.token), 200);
    plan.chapters[0].questions[0].text = "仅修改未来问题";
    data(
      await request("POST", url, p.narrator.token, {
        expectedVersion: plan.revision,
        content: { chapters: plan.chapters, starters: plan.starters },
      }),
    );
    await access((tx) =>
      plans.assertDirectoryVersion(p.projectId, first.version, tx),
    );
    assert.deepEqual(
      await access((tx) => plans.directory(p.projectId, tx)),
      first,
    );
    const changed = await access((tx) =>
      plans.reviseDirectory(
        {
          projectId: p.projectId,
          expectedVersion: first.version,
          createdBy: p.narrator.id,
          chapters: [
            {
              key: "places",
              title: "新的实际目录标题",
              storyRefs: ["synthetic-story:confirmed-version-1"],
            },
          ],
        },
        tx,
      ),
    );
    assert.equal(changed.version, first.version + 1);
    await assert.rejects(
      access((tx) =>
        plans.assertDirectoryVersion(p.projectId, first.version, tx),
      ),
      { code: "VERSION_CONFLICT" },
    );
    await assert.rejects(
      access(async (tx) => {
        await plans.reviseDirectory(
          {
            projectId: p.projectId,
            expectedVersion: changed.version,
            createdBy: p.narrator.id,
            chapters: [],
          },
          tx,
        );
        throw new Error("Synthetic Book consumer rolled back");
      }),
      /Synthetic Book consumer rolled back/,
    );
    assert.deepEqual(
      await access((tx) => plans.directory(p.projectId, tx)),
      changed,
    );
  } finally {
    await plans.close();
  }
});

test("future actual-question capture honors a subject's blocked question key without removing its historical snapshot", async () => {
  const p = await bound();
  data((await choose(p, p.narrator.token, "collection", true)).response);
  const url = `/v1/projects/${p.projectId}/plan`;
  const plan = data(await request("GET", url, p.narrator.token), 200);
  const questionKey = plan.chapters[0].questions[0].key;
  const plans = new ProjectPlans(config.databaseUrl);
  const access = <T>(
    work: (tx: import("@prisma/client").Prisma.TransactionClient) => Promise<T>,
  ) =>
    app
      .get(Participation)
      .withPlanAccess(
        p.projectId,
        `Bearer ${p.narrator.token}`,
        undefined,
        work,
      );
  try {
    const first = await access((tx) =>
      plans.captureActualQuestion(
        {
          id: randomUUID(),
          projectId: p.projectId,
          expectedPlanRevision: 1,
          capturedBy: p.narrator.id,
          questionKey,
        },
        tx,
      ),
    );
    data(
      await request("POST", `${url}/preferences`, p.narrator.token, {
        expectedVersion: 1,
        blockedTopics: [questionKey],
        questionStates: [],
      }),
    );
    await assert.rejects(
      access((tx) =>
        plans.captureActualQuestion(
          {
            id: randomUUID(),
            projectId: p.projectId,
            expectedPlanRevision: 1,
            capturedBy: p.narrator.id,
            questionKey,
          },
          tx,
        ),
      ),
      { code: "INVALID_COMMAND" },
    );
    assert.equal(
      data(await request("GET", url, p.narrator.token), 200).actualQuestions[0]
        .id,
      first.id,
    );
  } finally {
    await plans.close();
  }
});

test("synthetic OpenAPI describes authenticated personal-plan commands and their separate conflict contract", () => {
  const doc = createOpenApiDocument(app);
  const path = doc.paths["/v1/projects/{id}/plan"];
  assert.ok(path.get?.security?.length);
  assert.ok(path.post?.responses?.["409"]);
  const preferences = doc.paths["/v1/projects/{id}/plan/preferences"];
  assert.ok(preferences.post?.security?.length);
  const dto = doc.components?.schemas?.PreferencesDto;
  assert.ok(dto && "properties" in dto && dto.properties?.assistedSessionId);
});

test("authorized plan edits and subject decisions roll back with their actual caller transaction", async () => {
  const p = await bound();
  data((await choose(p, p.narrator.token, "collection", true)).response);
  const plans = new ProjectPlans(config.databaseUrl);
  const url = `/v1/projects/${p.projectId}/plan`;
  const original = data(await request("GET", url, p.narrator.token), 200);
  try {
    await assert.rejects(
      app
        .get(Participation)
        .withPlanAccess(
          p.projectId,
          `Bearer ${p.narrator.token}`,
          {},
          async (tx, actor) => {
            if (actor.method === "participant")
              throw new Error("Subject decision required");
            await plans.revisePlan(
              {
                projectId: p.projectId,
                expectedVersion: 1,
                createdBy: actor.userId,
                content: { chapters: [], starters: original.starters },
              },
              tx,
            );
            await plans.decidePreferences(
              {
                projectId: p.projectId,
                expectedVersion: 1,
                subjectId: actor.subjectId,
                operatorUserId: actor.userId,
                method: actor.method,
                questionStates: [],
                blockedTopics: ["work"],
              },
              tx,
            );
            throw new Error("Synthetic downstream failure");
          },
        ),
      /Synthetic downstream failure/,
    );
    const unchanged = data(await request("GET", url, p.narrator.token), 200);
    assert.equal(unchanged.revision, 1);
    assert.deepEqual(unchanged.preferences, { version: 1, blockedTopics: [] });
    assert.deepEqual(unchanged.preferenceHistory, []);
  } finally {
    await plans.close();
  }
});

after(async () => {
  await closePrivacyFixture(config);
});
