import { bootPrivacyFixture, closePrivacyFixture } from "./privacy-fixture";
import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { before, after, test } from "node:test";
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import nock from "nock";
import { LocalProbeObjects } from "../src/probe/local-objects";
import { createOpenApiDocument } from "../src/application";
import { createAdminApplication as createApplication } from "./admin-feishu-fixture";
import type { ApiConfig } from "../src/config";
import { paymentConfig, paymentFetch, paid, callback } from "./payment-fixture";
const schema = `t14_${randomUUID().replaceAll("-", "")}`;
let config: ApiConfig;
let root: string;
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
  root = await mkdtemp(join(tmpdir(), "timenook-recording-"));
  config = {
    ...{ recording: { mode: "synthetic-local" as const, storageRoot: root } },
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
  snapshot.admission.d02.duration.value = 1;
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
  if (root) await rm(root, { recursive: true, force: true });
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
async function project(versionId = packageId) {
  const buyer = await login();
  const order = data(
    await request("POST", "/v1/orders", buyer.token, {
      packageVersionId: versionId,
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
async function bound(versionId = packageId) {
  const p = await project(versionId);
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

test("a currently authorized narrator captures a stable actual plan question in an interview", async () => {
  const p = await bound();
  data((await choose(p, p.narrator.token, "collection", true)).response);
  const plan = data(
    await request("GET", `/v1/projects/${p.projectId}/plan`, p.narrator.token),
    200,
  );
  const command = {
    clientInterviewId: randomUUID(),
    expectedPlanRevision: plan.revision,
    questionKey: plan.chapters[0].questions[0].key,
  };
  const url = `/v1/projects/${p.projectId}/interviews`;
  const created = data(await request("POST", url, p.narrator.token, command));
  assert.equal(
    created.actualQuestion.snapshot.text,
    "有没有一个地方，你现在还想说说它的样子？",
  );
  assert.equal(created.actualQuestion.planRevision, 1);
  assert.equal(created.actualQuestion.answerRef, created.id);
  assert.equal(created.subjectId, p.subjectId);
  const replay = data(await request("POST", url, p.narrator.token, command));
  assert.equal(replay.id, created.id);
  assert.equal(
    (
      await request("POST", url, p.buyer.token, {
        ...command,
        clientInterviewId: randomUUID(),
      })
    ).statusCode,
    403,
  );
  const restored = data(
    await request("GET", `${url}/${created.id}`, p.narrator.token),
    200,
  );
  assert.equal(restored.actualQuestion.id, created.actualQuestion.id);
});

test("self-written and rewritten questions preserve their actual source without letting clients replace a plan question", async () => {
  const p = await bound();
  data((await choose(p, p.narrator.token, "collection", true)).response);
  const url = `/v1/projects/${p.projectId}/interviews`;
  const command = {
    clientInterviewId: randomUUID(),
    expectedPlanRevision: 1,
    selfWritten: { text: "我想讲第一次离家", intent: "记录当时的选择" },
  };
  const written = data(await request("POST", url, p.narrator.token, command));
  assert.equal(written.actualQuestion.snapshot.text, "我想讲第一次离家");
  assert.equal(written.actualQuestion.snapshot.intent, "记录当时的选择");
  assert.equal(written.actualQuestion.source.kind, "self-written");
  assert.equal(
    data(await request("POST", url, p.narrator.token, command)).id,
    written.id,
  );
  assert.equal(
    data(
      await request("POST", url, p.narrator.token, {
        ...command,
        selfWritten: {
          intent: command.selfWritten.intent,
          text: command.selfWritten.text,
        },
      }),
    ).id,
    written.id,
  );
  assert.equal(
    (
      await request("POST", url, p.narrator.token, {
        ...command,
        selfWritten: { ...command.selfWritten, text: "另一句话" },
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await request("POST", url, p.narrator.token, {
        ...command,
        clientInterviewId: randomUUID(),
        questionKey: "place-memory",
      })
    ).statusCode,
    400,
  );
  const plan = data(
    await request("GET", `/v1/projects/${p.projectId}/plan`, p.narrator.token),
    200,
  );
  const questionKey = plan.chapters[0].questions[0].key;
  const rewritten = data(
    await request("POST", url, p.narrator.token, {
      ...command,
      clientInterviewId: randomUUID(),
      selfWritten: { ...command.selfWritten, rewritesQuestionKey: questionKey },
    }),
  );
  assert.equal(
    rewritten.actualQuestion.source.rewritesQuestionKey,
    questionKey,
  );
  assert.equal(
    rewritten.actualQuestion.source.original.text,
    "有没有一个地方，你现在还想说说它的样子？",
  );
  const current = data(
    await request("GET", `${url}/${written.id}`, p.narrator.token),
    200,
  );
  assert.equal(current.actualQuestion.snapshot.text, "我想讲第一次离家");
});

function formUpload(
  app: Awaited<ReturnType<typeof createApplication>>,
  form: { url: string; fields: Record<string, string> },
  bytes: Buffer,
  overrides: Record<string, string> = {},
  token?: string,
) {
  const boundary = `probe-${randomUUID()}`;
  const fields = Object.entries({ ...form.fields, ...overrides }).map(
    ([key, value]) =>
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`,
      ),
  );
  const payload = Buffer.concat([
    ...fields,
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="synthetic.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`,
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return app.inject({
    method: "POST",
    url: form.url,
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    payload,
  });
}

function syntheticAudio(seconds: 1 | 0.5 = 1) {
  return readFileSync(
    seconds === 1
      ? "test/fixtures/synthetic-1s.mp3"
      : "test/fixtures/synthetic-576ms.mp3",
  );
}
test("displaying a rewritten question appends actual history within the same interview and preserves its starting question", async () => {
  const p = await bound();
  const started = await interview(p);
  const base = `/v1/projects/${p.projectId}/interviews/${started.id}`;
  const command = {
    clientQuestionId: randomUUID(),
    expectedVersion: 1,
    expectedActualQuestionId: started.actualQuestion.id,
    expectedPlanRevision: 1,
    selfWritten: {
      text: "那条小路上，您想再说说什么？",
      intent: "本人改写的补充问题",
    },
  };
  const displayed = data(
    await request("POST", `${base}/actual-question`, p.narrator.token, command),
  );
  assert.equal(displayed.id, started.id);
  assert.equal(displayed.actualQuestion.id, started.actualQuestion.id);
  assert.equal(displayed.questionVersion, 2);
  assert.equal(
    displayed.currentQuestion.snapshot.text,
    command.selfWritten.text,
  );
  assert.equal(displayed.currentQuestion.planRevision, 1);
  assert.equal(displayed.currentQuestion.source.kind, "self-written");
  assert.equal(displayed.currentQuestion.answerRef, started.id);
  const restored = data(await request("GET", base, p.narrator.token), 200);
  assert.deepEqual(
    restored.questionHistory.map((q: any) => ({
      id: q.question.id,
      parent: q.parentActualQuestionId,
      sequence: q.sequence,
    })),
    [
      { id: started.actualQuestion.id, parent: null, sequence: 1 },
      {
        id: displayed.currentQuestion.id,
        parent: started.actualQuestion.id,
        sequence: 2,
      },
    ],
  );
  assert.equal(
    data(
      await request(
        "POST",
        `${base}/actual-question`,
        p.narrator.token,
        command,
      ),
    ).currentQuestion.id,
    displayed.currentQuestion.id,
  );
});
test("recording permission pins the displayed question while later sealing preserves each original answer source", async () => {
  const p = await bound();
  const started = await interview(p);
  const base = `/v1/projects/${p.projectId}/interviews/${started.id}`;
  const permission = data(
    await request("POST", `${base}/recording-start`, p.narrator.token, {
      actualQuestionId: started.actualQuestion.id,
      expectedQuestionVersion: 1,
    }),
  );
  assert.equal(permission.actualQuestionId, started.actualQuestion.id);
  const displayed = data(
    await request("POST", `${base}/actual-question`, p.narrator.token, {
      clientQuestionId: randomUUID(),
      expectedVersion: 1,
      expectedActualQuestionId: started.actualQuestion.id,
      expectedPlanRevision: 1,
      selfWritten: { text: "当时您还留意到了什么？", intent: "本人选择的细节" },
    }),
  );
  assert.equal(
    (
      await request("POST", `${base}/recording-start`, p.narrator.token, {
        actualQuestionId: started.actualQuestion.id,
        expectedQuestionVersion: 1,
      })
    ).statusCode,
    409,
  );
  const bytes = syntheticAudio();
  const source = {
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  for (const actualQuestionId of [
    permission.actualQuestionId,
    displayed.currentQuestion.id,
  ]) {
    const clip = data(
      await request("POST", `${base}/clips`, p.narrator.token, {
        clientClipId: randomUUID(),
        actualQuestionId,
        ...source,
      }),
    );
    assert.equal(clip.actualQuestionId, actualQuestionId);
    const form = data(
      await request(
        "POST",
        `${base}/clips/${clip.id}/upload`,
        p.narrator.token,
      ),
    );
    assert.equal(
      (await formUpload(app, form, bytes, {}, p.narrator.token)).statusCode,
      204,
    );
    const sealed = data(
      await request("POST", `${base}/clips/${clip.id}/seal`, p.narrator.token),
    );
    assert.equal(sealed.state, "sealed");
    assert.equal(sealed.actualQuestionId, actualQuestionId);
  }
  const restored = data(await request("GET", base, p.narrator.token), 200);
  assert.deepEqual(
    restored.clips.map((clip: any) => clip.actualQuestionId).sort(),
    [permission.actualQuestionId, displayed.currentQuestion.id].sort(),
  );
});
test("actual-question display serializes the current version and requires live collection permission", async () => {
  const p = await bound(),
    started = await interview(p);
  const base = `/v1/projects/${p.projectId}/interviews/${started.id}`;
  const command = {
    expectedVersion: 1,
    expectedActualQuestionId: started.actualQuestion.id,
    expectedPlanRevision: 1,
    selfWritten: { text: "这件事您还想补充什么？", intent: "本人补充" },
  };
  const responses = await Promise.all(
    [1, 2].map(() =>
      request("POST", `${base}/actual-question`, p.narrator.token, {
        ...command,
        clientQuestionId: randomUUID(),
      }),
    ),
  );
  assert.deepEqual(responses.map((r) => r.statusCode).sort(), [201, 409]);
  const current = data(await request("GET", base, p.narrator.token), 200);
  assert.equal(current.questionHistory.length, 2);
  assert.equal(
    (
      await request("POST", `${base}/actual-question`, p.narrator.token, {
        ...command,
        clientQuestionId: randomUUID(),
        expectedPlanRevision: 999,
        expectedVersion: 2,
        expectedActualQuestionId: current.currentQuestion.id,
      })
    ).statusCode,
    409,
  );
  data((await choose(p, p.narrator.token, "collection", false)).response);
  assert.equal(
    (
      await request("POST", `${base}/actual-question`, p.narrator.token, {
        ...command,
        clientQuestionId: randomUUID(),
        expectedVersion: 2,
        expectedActualQuestionId: current.currentQuestion.id,
      })
    ).statusCode,
    403,
  );
});
test("an original upload with an unknown response replays its old command when the restored manifest includes its question", async () => {
  const p = await bound(),
    started = await interview(p);
  const base = `/v1/projects/${p.projectId}/interviews/${started.id}/clips`;
  const bytes = syntheticAudio(),
    key = randomUUID();
  const command = {
    clientClipId: randomUUID(),
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const original = data(
    await request("POST", base, p.narrator.token, command, key),
  );
  const restored = data(
    await request(
      "POST",
      base,
      p.narrator.token,
      { ...command, actualQuestionId: started.actualQuestion.id },
      key,
    ),
  );
  assert.equal(restored.id, original.id);
  assert.equal(restored.actualQuestionId, started.actualQuestion.id);
});
async function interview(p: Awaited<ReturnType<typeof bound>>) {
  data((await choose(p, p.narrator.token, "collection", true)).response);
  return data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/interviews`,
      p.narrator.token,
      {
        clientInterviewId: randomUUID(),
        expectedPlanRevision: 1,
        starterKind: "free-narration",
      },
    ),
  );
}
test("a stable upload intent seals a real verified MP3 once and restores asset, usage and durable input event together", async () => {
  const p = await bound(),
    i = await interview(p),
    audio = syntheticAudio();
  const base = `/v1/projects/${p.projectId}/interviews/${i.id}/clips`;
  const command = {
    clientClipId: randomUUID(),
    bytes: audio.length,
    sha256: createHash("sha256").update(audio).digest("hex"),
  };
  const created = data(await request("POST", base, p.narrator.token, command));
  assert.equal(created.state, "pending");
  const replays = await Promise.all([
    request("POST", base, p.narrator.token, command),
    request("POST", base, p.narrator.token, command),
  ]);
  for (const response of replays) assert.equal(data(response).id, created.id);
  const form = data(
    await request("POST", `${base}/${created.id}/upload`, p.narrator.token, {}),
  );
  assert.equal(form.storage, "local-simulator");
  assert.equal(
    (await formUpload(app, form, audio, {}, p.narrator.token)).statusCode,
    204,
  );
  const before = data(
    await request("GET", `${base}/${created.id}`, p.narrator.token),
    200,
  );
  assert.equal(before.state, "pending");
  const sealed = data(
    await request("POST", `${base}/${created.id}/seal`, p.narrator.token, {}),
  );
  assert.equal(sealed.state, "sealed");
  assert.equal(sealed.asset.sha256, command.sha256);
  assert.equal(sealed.durationMs, 1080);
  assert.equal(sealed.sealedInput.kind, "sealed-input");
  const replay = data(
    await request("POST", `${base}/${created.id}/seal`, p.narrator.token, {}),
  );
  assert.equal(replay.asset.id, sealed.asset.id);
  assert.equal(replay.sealedInput.id, sealed.sealedInput.id);
  const restored = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/interviews/${i.id}`,
      p.narrator.token,
    ),
    200,
  );
  assert.equal(restored.clips.length, 1);
  assert.equal(restored.usage.consumedMs, 1080);
  assert.equal(restored.usage.reservedMs, 0);
});

test("HTTP keys reject different commands while a released reservation cannot double count or admit another interview's clip", async () => {
  const p = await bound(),
    i = await interview(p),
    audio = syntheticAudio();
  const base = `/v1/projects/${p.projectId}/interviews/${i.id}/clips`;
  const command = {
      clientClipId: randomUUID(),
      bytes: audio.length,
      sha256: createHash("sha256").update(audio).digest("hex"),
    },
    key = randomUUID();
  const pending = data(
    await request("POST", base, p.narrator.token, command, key),
  );
  assert.equal(
    (
      await request(
        "POST",
        base,
        p.narrator.token,
        { ...command, clientClipId: randomUUID() },
        key,
      )
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await request("POST", base, p.narrator.token, {
        ...command,
        bytes: audio.length + 1,
      })
    ).statusCode,
    409,
  );
  const other = data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/interviews`,
      p.narrator.token,
      {
        clientInterviewId: randomUUID(),
        expectedPlanRevision: 1,
        starterKind: "photo",
      },
    ),
  );
  assert.equal(
    (
      await request(
        "POST",
        `/v1/projects/${p.projectId}/interviews/${other.id}/clips`,
        p.narrator.token,
        command,
      )
    ).statusCode,
    409,
  );
  const released = data(
    await request(
      "POST",
      `${base}/${pending.id}/release`,
      p.narrator.token,
      {},
    ),
  );
  assert.equal(released.state, "released");
  data(
    await request(
      "POST",
      `${base}/${pending.id}/release`,
      p.narrator.token,
      {},
    ),
  );
  const restored = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/interviews/${i.id}`,
      p.narrator.token,
    ),
    200,
  );
  assert.equal(restored.usage.reservedMs, 0);
  assert.equal(restored.usage.consumedMs, 0);
  assert.equal(
    (await request("POST", `${base}/${pending.id}/seal`, p.narrator.token, {}))
      .statusCode,
    409,
  );
});

test("exact creation expiry rejects new collection but preserves existing sealed recovery and pending local retry intent", async (t) => {
  const p = await bound(),
    i = await interview(p),
    audio = syntheticAudio(),
    base = `/v1/projects/${p.projectId}/interviews/${i.id}/clips`;
  const expires = Date.parse(
    data(await request("GET", `/v1/orders/${p.orderId}`, p.buyer.token), 200)
      .project.terms.creation.expiresAt,
  );
  t.mock.timers.enable({ apis: ["Date"], now: expires - 1 });
  const command = () => ({
    clientClipId: randomUUID(),
    bytes: audio.length,
    sha256: createHash("sha256").update(audio).digest("hex"),
  });
  const ready = data(await request("POST", base, p.narrator.token, command()));
  const form = data(
    await request("POST", `${base}/${ready.id}/upload`, p.narrator.token, {}),
  );
  assert.equal(
    (await formUpload(app, form, audio, {}, p.narrator.token)).statusCode,
    204,
  );
  data(await request("POST", `${base}/${ready.id}/seal`, p.narrator.token, {}));
  const pending = data(
    await request("POST", base, p.narrator.token, command()),
  );
  t.mock.timers.setTime(expires);
  assert.equal(
    (await request("POST", base, p.narrator.token, command())).statusCode,
    403,
  );
  assert.equal(
    (await request("POST", `${base}/${pending.id}/seal`, p.narrator.token, {}))
      .statusCode,
    403,
  );
  assert.equal(
    data(await request("GET", `${base}/${pending.id}`, p.narrator.token), 200)
      .state,
    "pending",
  );
  assert.equal(
    data(
      await request("POST", `${base}/${ready.id}/seal`, p.narrator.token, {}),
    ).state,
    "sealed",
  );
  t.mock.timers.setTime(expires + 1);
  assert.equal(
    (await request("POST", base, p.narrator.token, command())).statusCode,
    403,
  );
  assert.equal(
    data(
      await request(
        "GET",
        `/v1/projects/${p.projectId}/interviews/${i.id}`,
        p.narrator.token,
      ),
      200,
    ).clips.length,
    1,
  );
});

test("copy followed by database failure remains pending and recovers the same file, quota and unique event", async () => {
  const p = await bound(),
    i = await interview(p),
    audio = syntheticAudio(),
    base = `/v1/projects/${p.projectId}/interviews/${i.id}/clips`;
  const intent = data(
    await request("POST", base, p.narrator.token, {
      clientClipId: randomUUID(),
      bytes: audio.length,
      sha256: createHash("sha256").update(audio).digest("hex"),
    }),
  );
  const form = data(
    await request("POST", `${base}/${intent.id}/upload`, p.narrator.token, {}),
  );
  assert.equal(
    (await formUpload(app, form, audio, {}, p.narrator.token)).statusCode,
    204,
  );
  await db.$executeRawUnsafe(
    `CREATE FUNCTION reject_t14_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic commit fault'; END $$`,
  );
  await db.$executeRawUnsafe(
    `CREATE TRIGGER reject_t14_event BEFORE INSERT ON sealed_inputs FOR EACH ROW EXECUTE FUNCTION reject_t14_event()`,
  );
  try {
    assert.equal(
      (await request("POST", `${base}/${intent.id}/seal`, p.narrator.token, {}))
        .statusCode,
      500,
    );
  } finally {
    await db.$executeRawUnsafe(
      `DROP TRIGGER reject_t14_event ON sealed_inputs`,
    );
    await db.$executeRawUnsafe(`DROP FUNCTION reject_t14_event()`);
  }
  const pending = data(
    await request("GET", `${base}/${intent.id}`, p.narrator.token),
    200,
  );
  assert.equal(pending.state, "pending");
  assert.equal(pending.asset, null);
  assert.equal(pending.sealedInput, null);
  const restored = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/interviews/${i.id}`,
      p.narrator.token,
    ),
    200,
  );
  assert.equal(restored.clips.length, 0);
  assert.equal(restored.usage.consumedMs, 0);
  assert.equal(restored.usage.reservedMs, 300000);
  const responses = await Promise.all([
    request("POST", `${base}/${intent.id}/seal`, p.narrator.token, {}),
    request("POST", `${base}/${intent.id}/seal`, p.narrator.token, {}),
  ]);
  assert.equal(
    data(responses[0]).sealedInput.id,
    data(responses[1]).sealedInput.id,
  );
  assert.equal(
    data(
      await request(
        "GET",
        `/v1/projects/${p.projectId}/interviews/${i.id}`,
        p.narrator.token,
      ),
      200,
    ).clips.length,
    1,
  );
});

test("withdrawal during object copying fences the final transaction and retains the pending intent", async () => {
  const p = await bound(),
    i = await interview(p),
    audio = syntheticAudio(),
    base = `/v1/projects/${p.projectId}/interviews/${i.id}/clips`;
  const intent = data(
    await request("POST", base, p.narrator.token, {
      clientClipId: randomUUID(),
      bytes: audio.length,
      sha256: createHash("sha256").update(audio).digest("hex"),
    }),
  );
  const form = data(
    await request("POST", `${base}/${intent.id}/upload`, p.narrator.token, {}),
  );
  assert.equal(
    (await formUpload(app, form, audio, {}, p.narrator.token)).statusCode,
    204,
  );
  class RevokingObjects extends LocalProbeObjects {
    override async copy(source: string, target: string) {
      await super.copy(source, target);
      data((await choose(p, p.narrator.token, "collection", false)).response);
    }
  }
  const isolated = await createApplication(config, {
    wechatFetch,
    paymentFetch,
    recordingObjects: new RevokingObjects(root),
  });
  try {
    assert.equal(
      (
        await request(
          "POST",
          `${base}/${intent.id}/seal`,
          p.narrator.token,
          {},
          randomUUID(),
          isolated,
        )
      ).statusCode,
      403,
    );
  } finally {
    await isolated.close();
  }
  assert.equal(
    (await request("GET", `${base}/${intent.id}`, p.narrator.token)).statusCode,
    403,
  );
  data((await choose(p, p.narrator.token, "collection", true)).response);
  const restored = data(
    await request("GET", `${base}/${intent.id}`, p.narrator.token),
    200,
  );
  assert.equal(restored.state, "pending");
  assert.equal(restored.asset, null);
  assert.equal(
    (await request("POST", `${base}/${intent.id}/seal`, p.narrator.token, {}))
      .statusCode,
    403,
  );
});

test("collection-only actual-question commands return the current recording context without private question history", async () => {
  const p = await project(),
    current = await state(p, p.buyer.token);
  const session = data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/assisted-sessions`,
      p.buyer.token,
      {
        ...notice(),
        purpose: "collection",
        granted: true,
        expectedBindingVersion: 0,
        expectedAccessEpoch: current.accessEpoch,
      },
    ),
  );
  const collection = { assistedSessionId: session.id };
  const startCommand = {
    ...collection,
    clientInterviewId: randomUUID(),
    expectedPlanRevision: 1,
    starterKind: "free-narration",
  };
  const base = `/v1/projects/${p.projectId}/interviews`;
  const started = data(
    await request("POST", base, p.buyer.token, startCommand),
  );
  assert.equal(started.questionHistory, undefined);
  const displayed = data(
    await request(
      "POST",
      `${base}/${started.id}/actual-question`,
      p.buyer.token,
      {
        ...collection,
        clientQuestionId: randomUUID(),
        expectedVersion: 1,
        expectedActualQuestionId: started.actualQuestion.id,
        expectedPlanRevision: 1,
        selfWritten: {
          text: "您想补充哪个细节？",
          intent: "本人选择的补充问题",
        },
      },
    ),
  );
  assert.equal(displayed.currentQuestion.snapshot.text, "您想补充哪个细节？");
  assert.equal(displayed.questionHistory, undefined);
  const replay = data(await request("POST", base, p.buyer.token, startCommand));
  assert.equal(replay.questionHistory, undefined);
  assert.equal(replay.currentQuestion.id, displayed.currentQuestion.id);
});

test("collection-only assisted operators start and resume their own pending intent without gaining private history or original audio", async () => {
  const p = await project(),
    current = await state(p, p.buyer.token);
  const session = data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/assisted-sessions`,
      p.buyer.token,
      {
        ...notice(),
        purpose: "collection",
        granted: true,
        expectedBindingVersion: 0,
        expectedAccessEpoch: current.accessEpoch,
      },
    ),
  );
  const collection = { assistedSessionId: session.id };
  assert.equal(
    (
      await request(
        "GET",
        `/v1/projects/${p.projectId}/interviews`,
        p.buyer.token,
      )
    ).statusCode,
    403,
  );
  const context = data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/interviews/context`,
      p.buyer.token,
      collection,
    ),
  );
  assert.equal(context.interviews.length, 0);
  assert.equal(context.canRecord, true);
  const i = data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/interviews`,
      p.buyer.token,
      {
        ...collection,
        clientInterviewId: randomUUID(),
        expectedPlanRevision: context.plan.revision,
        starterKind: "free-narration",
      },
    ),
  );
  const base = `/v1/projects/${p.projectId}/interviews/${i.id}/clips`,
    audio = syntheticAudio();
  const pending = data(
    await request("POST", base, p.buyer.token, {
      ...collection,
      clientClipId: randomUUID(),
      bytes: audio.length,
      sha256: createHash("sha256").update(audio).digest("hex"),
    }),
  );
  assert.equal(
    data(
      await request(
        "POST",
        `/v1/projects/${p.projectId}/interviews/${i.id}/resume`,
        p.buyer.token,
        collection,
      ),
    ).clips[0].id,
    pending.id,
  );
  assert.equal(
    data(
      await request(
        "POST",
        `${base}/${pending.id}/status`,
        p.buyer.token,
        collection,
      ),
    ).state,
    "pending",
  );
  assert.equal(
    (await request("GET", `${base}/${pending.id}`, p.buyer.token)).statusCode,
    403,
  );
  const form = data(
    await request(
      "POST",
      `${base}/${pending.id}/upload`,
      p.buyer.token,
      collection,
    ),
  );
  assert.equal(
    (await formUpload(app, form, audio, {}, p.buyer.token)).statusCode,
    204,
  );
  const sealed = data(
    await request(
      "POST",
      `${base}/${pending.id}/seal`,
      p.buyer.token,
      collection,
    ),
  );
  assert.equal(sealed.state, "sealed");
  assert.equal(
    data(
      await request(
        "POST",
        `${base}/${pending.id}/seal`,
        p.buyer.token,
        collection,
      ),
    ).sealedInput.id,
    sealed.sealedInput.id,
  );
  assert.equal(
    (await request("GET", `${base}/${pending.id}/content`, p.buyer.token))
      .statusCode,
    403,
  );
  assert.equal((await state(p, p.buyer.token)).canProcessAi, false);
});

test("a late seal cannot overwrite an already verified final object through a concurrently replaced staging file", async () => {
  const p = await bound(),
    i = await interview(p),
    audio = syntheticAudio(),
    base = `/v1/projects/${p.projectId}/interviews/${i.id}/clips`;
  const intent = data(
    await request("POST", base, p.narrator.token, {
      clientClipId: randomUUID(),
      bytes: audio.length,
      sha256: createHash("sha256").update(audio).digest("hex"),
    }),
  );
  const form = data(
    await request("POST", `${base}/${intent.id}/upload`, p.narrator.token, {}),
  );
  assert.equal(
    (await formUpload(app, form, audio, {}, p.narrator.token)).statusCode,
    204,
  );
  let reached!: () => void,
    release!: () => void,
    copies = 0;
  const waiting = new Promise<void>((r) => (reached = r)),
    gate = new Promise<void>((r) => (release = r));
  class RacingObjects extends LocalProbeObjects {
    override async copy(source: string, target: string) {
      if (++copies === 1) {
        reached();
        await gate;
        await super.copy(source, target);
      } else {
        await super.copy(source, target);
        assert.equal(
          (
            await formUpload(
              app,
              form,
              Buffer.alloc(audio.length),
              {},
              p.narrator.token,
            )
          ).statusCode,
          204,
        );
      }
    }
  }
  const isolated = await createApplication(config, {
    wechatFetch,
    paymentFetch,
    recordingObjects: new RacingObjects(root),
  });
  try {
    const first = request(
      "POST",
      `${base}/${intent.id}/seal`,
      p.narrator.token,
      {},
      randomUUID(),
      isolated,
    );
    await waiting;
    data(
      await request(
        "POST",
        `${base}/${intent.id}/seal`,
        p.narrator.token,
        {},
        randomUUID(),
        isolated,
      ),
    );
    release();
    await first;
    const content = await request(
      "GET",
      `${base}/${intent.id}/content`,
      p.narrator.token,
    );
    assert.equal(content.statusCode, 200, content.body);
    assert.deepEqual(content.rawPayload, audio);
  } finally {
    release();
    await isolated.close();
  }
});

test("a legitimate short clip can use the remaining frozen quota and concurrent reservations cannot exceed it", async () => {
  const snapshot = JSON.parse(
    readFileSync("test/fixtures/catalog-synthetic.json", "utf8"),
  );
  snapshot.admission.d04.userQuotas.recordingPerClip.value = 2;
  snapshot.admission.d04.userQuotas.recordingTotal.value = 2;
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
      publicOffer: {
        title: "合成短额度",
        price: { value: 99900, unit: "fen", currency: "CNY" },
      },
    },
  });
  const p = await bound(versionId),
    i = await interview(p),
    base = `/v1/projects/${p.projectId}/interviews/${i.id}/clips`;
  async function intent(seconds: 1 | 0.5) {
    const audio = syntheticAudio(seconds),
      command = {
        clientClipId: randomUUID(),
        bytes: audio.length,
        sha256: createHash("sha256").update(audio).digest("hex"),
      };
    return { audio, command };
  }
  async function finish(pending: any, audio: Buffer) {
    const form = data(
      await request(
        "POST",
        `${base}/${pending.id}/upload`,
        p.narrator.token,
        {},
      ),
    );
    assert.equal(
      (await formUpload(app, form, audio, {}, p.narrator.token)).statusCode,
      204,
    );
    return data(
      await request("POST", `${base}/${pending.id}/seal`, p.narrator.token, {}),
    );
  }
  const first = await intent(1);
  await finish(
    data(await request("POST", base, p.narrator.token, first.command)),
    first.audio,
  );
  const short = await intent(0.5),
    extra = await intent(0.5);
  const reservations = await Promise.all([
    request("POST", base, p.narrator.token, short.command),
    request("POST", base, p.narrator.token, extra.command),
  ]);
  assert.deepEqual(reservations.map((r) => r.statusCode).sort(), [201, 409]);
  const winner = reservations[0].statusCode === 201 ? 0 : 1;
  const second = await finish(
    data(reservations[winner]),
    winner === 0 ? short.audio : extra.audio,
  );
  assert.equal(second.durationMs, 576);
  const restored = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/interviews/${i.id}`,
      p.narrator.token,
    ),
    200,
  );
  assert.equal(restored.usage.consumedMs, 1656);
});

test("private original audio rechecks sharing after I/O and applies bounded Range without requiring a new recording term", async () => {
  const p = await bound(),
    i = await interview(p),
    audio = syntheticAudio(),
    base = `/v1/projects/${p.projectId}/interviews/${i.id}/clips`;
  const intent = data(
    await request("POST", base, p.narrator.token, {
      clientClipId: randomUUID(),
      bytes: audio.length,
      sha256: createHash("sha256").update(audio).digest("hex"),
    }),
  );
  const form = data(
    await request("POST", `${base}/${intent.id}/upload`, p.narrator.token, {}),
  );
  assert.equal(
    (await formUpload(app, form, audio, {}, p.narrator.token)).statusCode,
    204,
  );
  data(
    await request("POST", `${base}/${intent.id}/seal`, p.narrator.token, {}),
  );
  data((await choose(p, p.narrator.token, "sharing", true)).response);
  const content = await request(
    "GET",
    `${base}/${intent.id}/content`,
    p.buyer.token,
  );
  assert.equal(content.statusCode, 200);
  assert.equal(content.headers["cache-control"], "private, no-store");
  assert.deepEqual(content.rawPayload, audio);
  const range = await app.inject({
    method: "GET",
    url: `${base}/${intent.id}/content`,
    headers: { authorization: `Bearer ${p.buyer.token}`, range: "bytes=0-9" },
  });
  assert.equal(range.statusCode, 206);
  assert.deepEqual(range.rawPayload, audio.subarray(0, 10));
  class RevokingRead extends LocalProbeObjects {
    override async read(key: string) {
      const bytes = await super.read(key);
      if (key.startsWith("sealed/"))
        data((await choose(p, p.narrator.token, "sharing", false)).response);
      return bytes;
    }
  }
  const isolated = await createApplication(config, {
    wechatFetch,
    paymentFetch,
    recordingObjects: new RevokingRead(root),
  });
  try {
    assert.equal(
      (
        await request(
          "GET",
          `${base}/${intent.id}/content`,
          p.buyer.token,
          undefined,
          randomUUID(),
          isolated,
        )
      ).statusCode,
      403,
    );
  } finally {
    await isolated.close();
  }
  assert.equal(
    (await request("GET", `${base}/${intent.id}/content`, p.narrator.token))
      .statusCode,
    200,
  );
});

test("product recording consumes the existing OSS form adapter and preserves its actual store identity without relabeling local assets", async () => {
  const p = await bound(),
    i = await interview(p),
    audio = syntheticAudio(),
    base = `/v1/projects/${p.projectId}/interviews/${i.id}/clips`;
  const local = data(
    await request("POST", base, p.narrator.token, {
      clientClipId: randomUUID(),
      bytes: audio.length,
      sha256: createHash("sha256").update(audio).digest("hex"),
    }),
  );
  const fakeOss = {
    bucket: "synthetic-t14",
    region: "cn-hangzhou",
    accessKeyId: "synthetic",
    accessKeySecret: "synthetic",
    securityToken: "synthetic",
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  };
  const assembly = {
    ...config,
    recording: { ...config.recording!, oss: fakeOss },
  };
  const isolated = await createApplication(assembly, {
    wechatFetch,
    paymentFetch,
  });
  try {
    const intent = data(
      await request(
        "POST",
        base,
        p.narrator.token,
        {
          clientClipId: randomUUID(),
          bytes: audio.length,
          sha256: createHash("sha256").update(audio).digest("hex"),
        },
        randomUUID(),
        isolated,
      ),
    );
    const form = data(
      await request(
        "POST",
        `${base}/${intent.id}/upload`,
        p.narrator.token,
        {},
        randomUUID(),
        isolated,
      ),
    );
    assert.equal(form.storage, "oss");
    assert.equal(
      form.url,
      "https://synthetic-t14.oss-cn-hangzhou.aliyuncs.com",
    );
    assert.equal(form.fields.key, `staging/${intent.id}.mp3`);
    nock.disableNetConnect();
    let snapshotKey = "";
    const provider = nock(
      "https://synthetic-t14.oss-cn-hangzhou.aliyuncs.com",
      {
        reqheaders: {
          authorization: (value: string) =>
            value.startsWith("OSS4-HMAC-SHA256 "),
          "x-oss-security-token": "synthetic",
        },
      },
    );
    provider
      .get(`/${form.fields.key}`)
      .reply(200, audio, { "content-length": String(audio.length) });
    provider
      .put(/^\/staging\/[0-9a-f-]{36}\.mp3$/, audio)
      .reply(
        403,
        "<Error><Code>AccessDenied</Code><Message>denied</Message></Error>",
        { "content-type": "application/xml" },
      );
    provider.delete(/^\/staging\/[0-9a-f-]{36}\.mp3$/).reply(204);
    assert.equal(
      (
        await request(
          "POST",
          `${base}/${intent.id}/seal`,
          p.narrator.token,
          {},
          randomUUID(),
          isolated,
        )
      ).statusCode,
      422,
    );
    const pending = data(
      await request(
        "GET",
        `${base}/${intent.id}`,
        p.narrator.token,
        undefined,
        randomUUID(),
        isolated,
      ),
      200,
    );
    assert.equal(pending.state, "pending");
    assert.equal(pending.asset, null);
    assert.equal(pending.sealedInput, null);
    assert.ok(nock.isDone());
    provider
      .get(`/${form.fields.key}`)
      .reply(200, audio, { "content-length": String(audio.length) });
    provider
      .put(/^\/staging\/[0-9a-f-]{36}\.mp3$/, audio)
      .matchHeader("x-oss-object-acl", "private")
      .matchHeader("cache-control", "private, no-store")
      .matchHeader("content-type", "audio/mpeg")
      .reply(function (uri) {
        snapshotKey = uri.slice(1);
        return [200, "", { etag: '"synthetic"' }];
      });
    provider
      .put(`/sealed/${intent.id}.mp3`)
      .matchHeader(
        "x-oss-copy-source",
        (value: string) =>
          snapshotKey !== "" &&
          value === `/synthetic-t14/${encodeURIComponent(snapshotKey)}`,
      )
      .reply(
        200,
        "<CopyObjectResult><LastModified>2026-10-23T00:00:00Z</LastModified><ETag>synthetic</ETag></CopyObjectResult>",
        { "content-type": "application/xml" },
      );
    provider
      .get(`/sealed/${intent.id}.mp3`)
      .reply(200, audio, { "content-length": String(audio.length) });
    provider.delete(/^\/staging\/[0-9a-f-]{36}\.mp3$/).reply(204);
    const sealed = data(
      await request(
        "POST",
        `${base}/${intent.id}/seal`,
        p.narrator.token,
        {},
        randomUUID(),
        isolated,
      ),
    );
    assert.equal(sealed.storage, "oss");
    assert.equal(sealed.asset.storage, "oss");
    assert.notEqual(snapshotKey, form.fields.key);
    assert.ok(nock.isDone());
    assert.equal(
      (
        await request(
          "GET",
          `${base}/${local.id}`,
          p.narrator.token,
          undefined,
          randomUUID(),
          isolated,
        )
      ).statusCode,
      404,
    );
  } finally {
    await isolated.close();
    nock.cleanAll();
    nock.enableNetConnect();
  }
});

test("database composite constraints reject another project's subject and the wrong interview's actual question", async () => {
  const p = await bound(),
    i = await interview(p),
    q = await bound(),
    other = await interview(q);
  const actor = {
    subjectId: p.subjectId,
    operatorUserId: p.narrator.id,
    bindingVersion: 1,
    accessEpoch: 1,
    method: "self_wechat",
  };
  const command = {
    id: randomUUID(),
    projectId: p.projectId,
    interviewId: i.id,
    actualQuestionId: i.actualQuestion.id,
    clientClipId: randomUUID(),
    ...actor,
    storageScope: "synthetic-constraint",
    bytes: 100,
    sha256: "a".repeat(64),
    reservedMs: 1000,
  };
  await assert.rejects(
    db.recordingIntent.create({ data: { ...command, subjectId: q.subjectId } }),
    /Foreign key constraint/,
  );
  await assert.rejects(
    db.recordingIntent.create({
      data: { ...command, actualQuestionId: other.actualQuestion.id },
    }),
    /Foreign key constraint/,
  );
  const sameProject = data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/interviews`,
      p.narrator.token,
      {
        clientInterviewId: randomUUID(),
        expectedPlanRevision: 1,
        starterKind: "photo",
      },
    ),
  );
  await assert.rejects(
    db.recordingIntent.create({
      data: { ...command, actualQuestionId: sameProject.actualQuestion.id },
    }),
    /Foreign key constraint/,
  );
});

test("synthetic recording assembly stays absent by default and refuses production configuration", async () => {
  const { recording, ...withoutRecording } = config;
  const unconfigured = await createApplication(withoutRecording, {
    wechatFetch,
    paymentFetch,
  });
  try {
    assert.equal(
      (
        await request(
          "POST",
          `/v1/projects/${randomUUID()}/interviews/${randomUUID()}/clips`,
          undefined,
          {},
          randomUUID(),
          unconfigured,
        )
      ).statusCode,
      404,
    );
  } finally {
    await unconfigured.close();
  }
  await assert.rejects(
    createApplication(
      { ...config, environment: "production" },
      { wechatFetch, paymentFetch },
    ),
    /Recording requires isolated synthetic/,
  );
  await assert.rejects(async () => {
    const shared = await createApplication(
      { ...config, audioProbe: { storageRoot: root } },
      { wechatFetch, paymentFetch },
    );
    await shared.close();
  }, /separate object storage/);
  const document = createOpenApiDocument(app);
  assert.ok(
    document.paths[
      "/v1/projects/{id}/interviews/{interviewId}/clips/{clipId}/seal"
    ].post,
  );
  assert.ok(
    document.paths["/v1/projects/{id}/interviews/{interviewId}/recording-start"]
      .post,
  );
});

test("withdrawal and renewed collection cannot revive an interview from the previous access epoch", async () => {
  const p = await bound();
  data((await choose(p, p.narrator.token, "collection", true)).response);
  const base = `/v1/projects/${p.projectId}/interviews`,
    command = {
      clientInterviewId: randomUUID(),
      expectedPlanRevision: 1,
      starterKind: "free-narration",
    };
  const previous = data(await request("POST", base, p.narrator.token, command));
  data((await choose(p, p.narrator.token, "collection", false)).response);
  data((await choose(p, p.narrator.token, "collection", true)).response);
  assert.equal(
    (await request("POST", base, p.narrator.token, command)).statusCode,
    403,
  );
  assert.equal(
    (
      await request("POST", `${base}/${previous.id}/clips`, p.narrator.token, {
        clientClipId: randomUUID(),
        bytes: 100,
        sha256: "a".repeat(64),
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await request(
        "POST",
        `${base}/${previous.id}/recording-start`,
        p.narrator.token,
        {},
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (await request("GET", `${base}/${previous.id}`, p.narrator.token))
      .statusCode,
    200,
  );
  const fresh = data(
    await request("POST", base, p.narrator.token, {
      ...command,
      clientInterviewId: randomUUID(),
    }),
  );
  assert.notEqual(fresh.id, previous.id);
});

after(async () => {
  await closePrivacyFixture(config);
});
