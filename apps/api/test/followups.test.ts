import { bootPrivacyFixture, closePrivacyFixture } from "./privacy-fixture";
import { paymentAdmin } from "./payment-admin-fixture";
import { once } from "node:events";
import { ProductionTasks } from "../src/tasks/tasks";
import { startProductionWorker } from "../src/tasks/worker";
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
const schema = `t17_${randomUUID().replaceAll("-", "")}`;
let config: ApiConfig;
let root: string;
let app: Awaited<ReturnType<typeof createApplication>>;
let db: PrismaClient;
const packageId = randomUUID();
let sourceGate: (key: string) => Promise<void> = async () => {};
const textRequests: any[] = [];
const providerRequests: { action: string; id: string; audioUrl?: string }[] =
  [];
let providerTransport: typeof fetch = async (input, init) => {
  if (String(input).includes("deepseek.com")) {
    const payload = JSON.parse(String(init?.body));
    const source = JSON.parse(payload.messages[1].content);
    textRequests.push(source);
    return new Response(
      JSON.stringify({
        model: "synthetic-story",
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: JSON.stringify({
                action: "ask",
                question: "关于那一年的经历，您最记得哪个场景？",
                intent: "scene",
                sourceRefs: source.sourceRefs,
                reasonCode: "SCENE_AVAILABLE",
              }),
            },
          },
        ],
      }),
    );
  }
  const action = String(input).endsWith("/submit") ? "submit" : "query";
  const id = new Headers(init?.headers).get("X-Api-Request-Id")!;
  providerRequests.push({
    action,
    id,
    audioUrl: JSON.parse(String(init?.body)).audio?.url,
  });
  return new Response(
    action === "submit"
      ? "{}"
      : JSON.stringify({
          task_id: id,
          result: { text: "那一年大概是八十年代。\n也可能更早。" },
        }),
    { headers: { "X-Api-Status-Code": "20000000" } },
  );
};
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
  root = await mkdtemp(join(tmpdir(), "timenook-followup-"));
  config = {
    ...{ recording: { mode: "synthetic-local" as const, storageRoot: root } },
    environment: "test",
    host: "127.0.0.1",
    port: 3429,
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
  config.transcription = {
    mode: "synthetic-local",
    configVersion: "synthetic-t15-v1",
    doubao: {
      apiKey: "synthetic-t15-key",
      resourceId: "synthetic-t15-resource",
      fetchWindowSeconds: 60,
    },
    pollIntervalMs: 0,
    submissionReservationFen: 1,
    deadlineMs: 60000,
  };
  Object.assign(config, {
    generation: {
      mode: "synthetic-local",
      configVersion: "synthetic-t18-v1",
      deepseek: {
        apiKey: "synthetic-key",
        model: "synthetic-story",
        maxTokens: 3000,
      },
      submissionReservationFen: 1,
      maxSubmissions: 100,
      deadlineMs: 600000,
    },
  });
  class Objects extends LocalProbeObjects {
    async asrSource(key: string, _seconds: number) {
      await sourceGate(key);
      return {
        url: `https://synthetic.oss-cn-shanghai.aliyuncs.com/${key}?signature=private`,
        expiresAt: new Date(Date.now() + 120000).toISOString(),
        credentialsExpireAt: new Date(Date.now() + 180000).toISOString(),
      };
    }
  }
  const aiFetch: typeof fetch = (...args) => providerTransport(...args);
  await bootPrivacyFixture(config);
  app = await createApplication(config, {
    wechatFetch,
    paymentFetch,
    aiFetch,
    recordingObjects: new Objects(root),
  });
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
async function interview(
  p: Awaited<ReturnType<typeof bound>>,
  ai = true,
  question?: { questionKey: string },
) {
  if (ai) data((await choose(p, p.narrator.token, "ai", true)).response);
  data((await choose(p, p.narrator.token, "collection", true)).response);
  return data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/interviews`,
      p.narrator.token,
      {
        clientInterviewId: randomUUID(),
        expectedPlanRevision: 1,
        ...(question ?? { starterKind: "free-narration" }),
      },
    ),
  );
}

async function sealedClip(
  p: Awaited<ReturnType<typeof bound>>,
  interviewId: string,
) {
  const audio = syntheticAudio();
  const base = `/v1/projects/${p.projectId}/interviews/${interviewId}/clips`;
  const clip = data(
    await request("POST", base, p.narrator.token, {
      clientClipId: randomUUID(),
      bytes: audio.length,
      sha256: createHash("sha256").update(audio).digest("hex"),
    }),
  );
  const form = data(
    await request("POST", `${base}/${clip.id}/upload`, p.narrator.token, {}),
  );
  assert.equal(
    (await formUpload(app, form, audio, {}, p.narrator.token)).statusCode,
    204,
  );
  const sealed = data(
    await request("POST", `${base}/${clip.id}/seal`, p.narrator.token, {}),
  );
  return { ...p, interviewId, base, clip, sealed };
}
test(
  "one optional follow-up freezes the current interview sources and runs through the existing Worker once",
  { timeout: 30000 },
  async () => {
    const p = await bound(),
      i = await interview(p);
    await sealedClip(p, i.id);
    await sealedClip(p, i.id);
    const tasks = data(
      await request(
        "GET",
        `/v1/projects/${p.projectId}/tasks`,
        p.narrator.token,
      ),
      200,
    );
    for (const task of tasks) {
      await app.get(ProductionTasks).run(task.id);
      await app.get(ProductionTasks).run(task.id);
    }
    const url = `/v1/projects/${p.projectId}/interviews/${i.id}/follow-up`;
    const key = randomUUID(),
      command = {
        clientRequestId: randomUUID(),
        actualQuestionId: i.actualQuestion.id,
        expectedQuestionVersion: 1,
      };
    const created = data(
      await request("POST", url, p.narrator.token, command, key),
      202,
    );
    assert.equal(created.task.kind, "ask_followup");
    assert.equal(created.task.state, "queued");
    assert.equal(
      data(await request("POST", url, p.narrator.token, command, key), 202).task
        .id,
      created.task.id,
    );
    const before = textRequests.length,
      runtime = await startProductionWorker(app);
    try {
      const finished = once(runtime.worker, "completed");
      await runtime.recoverDue();
      await finished;
    } finally {
      await runtime.close();
    }
    const current = data(
      await request("POST", `${url}/status`, p.narrator.token, {}),
    );
    assert.equal(current.task.state, "succeeded");
    assert.equal(current.result.action, "ask");
    assert.equal(
      current.result.question,
      "关于那一年的经历，您最记得哪个场景？",
    );
    assert.equal(current.usage, 1);
    assert.equal(textRequests.length, before + 1);
    assert.equal(textRequests.at(-1).transcripts.length, 2);
    assert.equal(textRequests.at(-1).currentQuestion.id, i.actualQuestion.id);
    assert.equal(textRequests.at(-1).history.length, 1);
    assert.deepEqual(textRequests.at(-1).relatedChapters, []);
    assert.ok(current.latencyMs >= 0);
    assert.equal(current.task.attempts.length, 1);
  },
);

async function readyInput(p: Awaited<ReturnType<typeof bound>>, i: any) {
  await sealedClip(p, i.id);
  const tasks = data(
    await request("GET", `/v1/projects/${p.projectId}/tasks`, p.narrator.token),
    200,
  );
  for (const task of tasks.filter((t: any) => t.kind === "transcribe_audio")) {
    await app.get(ProductionTasks).run(task.id);
    await app.get(ProductionTasks).run(task.id);
  }
}
test("an explicitly skipped current question finishes before a model call or active quota charge", async () => {
  const p = await bound();
  data((await choose(p, p.narrator.token, "collection", true)).response);
  const plan = data(
    await request("GET", `/v1/projects/${p.projectId}/plan`, p.narrator.token),
    200,
  );
  const questionKey = plan.chapters[0].questions[0].key;
  const i = await interview(p, true, { questionKey });
  await readyInput(p, i);
  data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/plan/preferences`,
      p.narrator.token,
      {
        expectedVersion: 1,
        blockedTopics: [],
        questionStates: [{ questionKey, state: "skipped" }],
      },
    ),
  );
  const before = textRequests.length;
  const result = data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/interviews/${i.id}/follow-up`,
      p.narrator.token,
      {
        clientRequestId: randomUUID(),
        actualQuestionId: i.actualQuestion.id,
        expectedQuestionVersion: 1,
      },
    ),
    202,
  );
  assert.equal(result.task, null);
  assert.equal(result.finishReason, "DECLINED");
  assert.equal(result.canFinish, true);
  assert.equal(result.usage, 0);
  assert.equal(textRequests.length, before);
});

test("a structurally valid but leading question is rejected and a confirmed failure can retry the same intent once", async () => {
  const p = await bound(),
    i = await interview(p);
  await readyInput(p, i);
  const url = `/v1/projects/${p.projectId}/interviews/${i.id}/follow-up`;
  const created = data(
    await request("POST", url, p.narrator.token, {
      clientRequestId: randomUUID(),
      actualQuestionId: i.actualQuestion.id,
      expectedQuestionVersion: 1,
    }),
    202,
  );
  const transport = providerTransport;
  providerTransport = async (input, init) => {
    const response = await transport(input, init);
    const json = (await response.json()) as any;
    const output = JSON.parse(json.choices[0].message.content);
    output.question = "那一年是不是每天都很幸福？";
    json.choices[0].message.content = JSON.stringify(output);
    return Response.json(json);
  };
  try {
    await app.get(ProductionTasks).run(created.task.id);
  } finally {
    providerTransport = transport;
  }
  const failed = data(
    await request("POST", `${url}/status`, p.narrator.token, {}),
  );
  assert.equal(failed.task.state, "failed");
  assert.equal(failed.task.errorCode, "INVALID_OUTPUT");
  assert.equal(failed.result, null);
  assert.equal(failed.canFinish, true);
  assert.equal(failed.usage, 1);
  assert.equal(failed.task.attempts[0].usage.total_tokens, 30);
  const retryKey = randomUUID();
  data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/tasks/${created.task.id}/retry`,
      p.narrator.token,
      {},
      retryKey,
    ),
    202,
  );
  data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/tasks/${created.task.id}/retry`,
      p.narrator.token,
      {},
      retryKey,
    ),
    202,
  );
  await app.get(ProductionTasks).run(created.task.id);
  const retried = data(
    await request("POST", `${url}/status`, p.narrator.token, {}),
  );
  assert.equal(retried.task.state, "succeeded");
  assert.equal(retried.usage, 1);
  assert.equal(retried.task.attempts.length, 2);
});

test("unknown text submission is retained and cannot be polled, retried, or replaced by another request for the same input", async () => {
  const p = await bound(),
    i = await interview(p);
  await readyInput(p, i);
  const url = `/v1/projects/${p.projectId}/interviews/${i.id}/follow-up`;
  const command = {
    clientRequestId: randomUUID(),
    actualQuestionId: i.actualQuestion.id,
    expectedQuestionVersion: 1,
  };
  const created = data(
    await request("POST", url, p.narrator.token, command),
    202,
  );
  const transport = providerTransport;
  let submissions = 0;
  providerTransport = async () => {
    submissions++;
    throw new Error("synthetic lost response");
  };
  try {
    await app.get(ProductionTasks).run(created.task.id);
    await app.get(ProductionTasks).run(created.task.id);
    const unknown = data(
      await request("POST", `${url}/status`, p.narrator.token, {}),
    );
    assert.equal(unknown.task.state, "manual_review");
    assert.equal(unknown.task.errorCode, "PROVIDER_UNKNOWN");
    assert.equal(
      (
        await request(
          "POST",
          `/v1/projects/${p.projectId}/tasks/${created.task.id}/retry`,
          p.narrator.token,
          {},
        )
      ).statusCode,
      409,
    );
    const replay = data(
      await request("POST", url, p.narrator.token, {
        ...command,
        clientRequestId: randomUUID(),
      }),
      202,
    );
    assert.equal(replay.task.id, created.task.id);
    assert.equal(replay.usage, 1);
    await app.get(ProductionTasks).run(replay.task.id);
    assert.equal(submissions, 1);
    assert.equal(replay.task.attempts[0].reservedCostFen, 1);
  } finally {
    providerTransport = transport;
  }
});

test("collection preflight preserves an in-flight suggestion but real recording-start immediately obsoletes a late result", async () => {
  const p = await bound(),
    i = await interview(p);
  await readyInput(p, i);
  const base = `/v1/projects/${p.projectId}/interviews/${i.id}`,
    url = `${base}/follow-up`;
  const created = data(
    await request("POST", url, p.narrator.token, {
      clientRequestId: randomUUID(),
      actualQuestionId: i.actualQuestion.id,
      expectedQuestionVersion: 1,
    }),
    202,
  );
  const transport = providerTransport;
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => {
      release = r;
    }),
    sent = new Promise<void>((r) => {
      entered = r;
    });
  providerTransport = async (input, init) => {
    entered();
    await gate;
    return transport(input, init);
  };
  const running = app.get(ProductionTasks).run(created.task.id);
  try {
    await sent;
    data(
      await request("POST", `${base}/collection-check`, p.narrator.token, {}),
    );
    assert.equal(
      data(await request("POST", `${url}/status`, p.narrator.token, {})).task
        .state,
      "submitting",
    );
    data(
      await request("POST", `${base}/recording-start`, p.narrator.token, {
        actualQuestionId: i.actualQuestion.id,
        expectedQuestionVersion: 1,
      }),
    );
    assert.equal(
      data(await request("POST", `${url}/status`, p.narrator.token, {})).task
        .state,
      "obsolete",
    );
  } finally {
    release();
    await running;
    providerTransport = transport;
  }
  const late = data(
    await request("POST", `${url}/status`, p.narrator.token, {}),
  );
  assert.equal(late.result, null);
  assert.equal(late.task.state, "obsolete");
  assert.equal(late.task.attempts[0].usage.total_tokens, 30);
  assert.equal(
    (
      await db.taskAttemptObservation.findFirstOrThrow({
        where: { requestId: late.task.attempts[0].requestId },
      })
    ).superseded,
    true,
  );
});

test("displaying and rewriting one generated follow-up preserves its source and records the answer against the actual displayed snapshot", async () => {
  const p = await bound(),
    i = await interview(p);
  await readyInput(p, i);
  const base = `/v1/projects/${p.projectId}/interviews/${i.id}`,
    url = `${base}/follow-up`;
  const task = data(
    await request("POST", url, p.narrator.token, {
      clientRequestId: randomUUID(),
      actualQuestionId: i.actualQuestion.id,
      expectedQuestionVersion: 1,
    }),
    202,
  ).task;
  await app.get(ProductionTasks).run(task.id);
  const key = randomUUID(),
    command = {
      clientQuestionId: randomUUID(),
      expectedVersion: 1,
      expectedActualQuestionId: i.actualQuestion.id,
      expectedPlanRevision: 1,
      followupTaskId: task.id,
      selfWritten: { text: "那一年您最记得哪件事？", intent: "scene" },
    };
  const displayed = data(
    await request(
      "POST",
      `${base}/actual-question`,
      p.narrator.token,
      command,
      key,
    ),
  );
  assert.equal(displayed.actualQuestion.id, i.actualQuestion.id);
  assert.equal(displayed.currentQuestion.id, command.clientQuestionId);
  assert.equal(
    displayed.currentQuestion.snapshot.text,
    command.selfWritten.text,
  );
  assert.equal(displayed.currentQuestion.planRevision, 1);
  assert.equal(displayed.currentQuestion.source.kind, "follow-up");
  assert.equal(displayed.currentQuestion.source.generationTaskId, task.id);
  assert.equal(
    displayed.currentQuestion.source.original.question,
    "关于那一年的经历，您最记得哪个场景？",
  );
  assert.equal(displayed.questionHistory.length, 2);
  assert.equal(
    data(
      await request(
        "POST",
        `${base}/actual-question`,
        p.narrator.token,
        command,
        key,
      ),
    ).questionHistory.length,
    2,
  );
  assert.equal(
    data(await request("POST", `${url}/status`, p.narrator.token, {})).result,
    null,
  );
  const start = data(
    await request("POST", `${base}/recording-start`, p.narrator.token, {
      actualQuestionId: command.clientQuestionId,
      expectedQuestionVersion: 2,
    }),
  );
  assert.equal(start.actualQuestionId, command.clientQuestionId);
  const audio = syntheticAudio(),
    clip = data(
      await request("POST", `${base}/clips`, p.narrator.token, {
        clientClipId: randomUUID(),
        actualQuestionId: start.actualQuestionId,
        bytes: audio.length,
        sha256: createHash("sha256").update(audio).digest("hex"),
      }),
    );
  const form = data(
    await request(
      "POST",
      `${base}/clips/${clip.id}/upload`,
      p.narrator.token,
      {},
    ),
  );
  assert.equal(
    (await formUpload(app, form, audio, {}, p.narrator.token)).statusCode,
    204,
  );
  const sealed = data(
    await request(
      "POST",
      `${base}/clips/${clip.id}/seal`,
      p.narrator.token,
      {},
    ),
  );
  assert.equal(sealed.actualQuestionId, command.clientQuestionId);
  const linked = await db.recordingClip.findUniqueOrThrow({
    where: { intentId: clip.id },
  });
  assert.equal(linked.actualQuestionId, command.clientQuestionId);
  assert.equal(
    (await db.interview.findUniqueOrThrow({ where: { id: i.id } }))
      .actualQuestionId,
    i.actualQuestion.id,
  );
});

test("finishing is idempotent, makes a queued suggestion obsolete, and never blocks saved recordings or later supplement", async () => {
  const p = await bound(),
    i = await interview(p);
  await readyInput(p, i);
  const base = `/v1/projects/${p.projectId}/interviews/${i.id}`,
    url = `${base}/follow-up`;
  const task = data(
    await request("POST", url, p.narrator.token, {
      clientRequestId: randomUUID(),
      actualQuestionId: i.actualQuestion.id,
      expectedQuestionVersion: 1,
    }),
    202,
  ).task;
  const before = textRequests.length,
    key = randomUUID(),
    body = {
      actualQuestionId: i.actualQuestion.id,
      expectedQuestionVersion: 1,
    };
  const finished = data(
    await request("POST", `${url}/finish`, p.narrator.token, body, key),
  );
  assert.equal(finished.finishReason, "USER_FINISHED");
  assert.equal(finished.result, null);
  await app.get(ProductionTasks).run(task.id);
  assert.equal(textRequests.length, before);
  assert.equal(
    data(await request("POST", `${url}/status`, p.narrator.token, {})).task
      .state,
    "obsolete",
  );
  assert.equal(
    await db.recordingClip.count({
      where: { projectId: p.projectId, interviewId: i.id },
    }),
    1,
  );
  data(
    await request("POST", `${base}/recording-start`, p.narrator.token, body),
  );
  data(await request("POST", `${url}/finish`, p.narrator.token, body, key));
  assert.equal(
    (
      await db.followupSession.findUniqueOrThrow({
        where: {
          projectId_interviewId: { projectId: p.projectId, interviewId: i.id },
        },
      })
    ).ended,
    false,
  );
});

test("an unanswered actual question cannot reuse only older-question recordings as if its answer were ready", async () => {
  const p = await bound(),
    i = await interview(p);
  await readyInput(p, i);
  const base = `/v1/projects/${p.projectId}/interviews/${i.id}`;
  const next = data(
    await request("POST", `${base}/actual-question`, p.narrator.token, {
      clientQuestionId: randomUUID(),
      expectedVersion: 1,
      expectedActualQuestionId: i.actualQuestion.id,
      expectedPlanRevision: 1,
      selfWritten: { text: "那时您通常看到什么？", intent: "scene" },
    }),
  );
  const before = textRequests.length;
  assert.equal(
    (
      await request("POST", `${base}/follow-up`, p.narrator.token, {
        clientRequestId: randomUUID(),
        actualQuestionId: next.currentQuestion.id,
        expectedQuestionVersion: 2,
      })
    ).statusCode,
    409,
  );
  assert.equal(textRequests.length, before);
});

test("starting another question closes the prior interview suggestion and cannot revive it by returning later", async () => {
  const p = await bound(),
    i = await interview(p);
  await readyInput(p, i);
  const url = `/v1/projects/${p.projectId}/interviews/${i.id}/follow-up`;
  const task = data(
    await request("POST", url, p.narrator.token, {
      clientRequestId: randomUUID(),
      actualQuestionId: i.actualQuestion.id,
      expectedQuestionVersion: 1,
    }),
    202,
  ).task;
  data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/interviews`,
      p.narrator.token,
      {
        clientInterviewId: randomUUID(),
        expectedPlanRevision: 1,
        selfWritten: { text: "今天想留下什么？", intent: "meaning" },
      },
    ),
  );
  assert.equal(
    data(await request("POST", `${url}/status`, p.narrator.token, {})).task
      .state,
    "obsolete",
  );
  const before = textRequests.length;
  await app.get(ProductionTasks).run(task.id);
  assert.equal(textRequests.length, before);
});

test("a displayed optional suggestion can be rewritten with its original generation and actual parent question preserved", async () => {
  const p = await bound(),
    i = await interview(p);
  await readyInput(p, i);
  const base = `/v1/projects/${p.projectId}/interviews/${i.id}`,
    url = `${base}/follow-up`;
  const task = data(
    await request("POST", url, p.narrator.token, {
      clientRequestId: randomUUID(),
      actualQuestionId: i.actualQuestion.id,
      expectedQuestionVersion: 1,
    }),
    202,
  ).task;
  await app.get(ProductionTasks).run(task.id);
  const displayed = data(
    await request("POST", `${base}/actual-question`, p.narrator.token, {
      clientQuestionId: randomUUID(),
      expectedVersion: 1,
      expectedActualQuestionId: i.actualQuestion.id,
      expectedPlanRevision: 1,
      followupTaskId: task.id,
    }),
  );
  data(
    await request("POST", `${base}/recording-start`, p.narrator.token, {
      actualQuestionId: displayed.currentQuestion.id,
      expectedQuestionVersion: 2,
    }),
  );
  const rewritten = data(
    await request("POST", `${base}/actual-question`, p.narrator.token, {
      clientQuestionId: randomUUID(),
      expectedVersion: 2,
      expectedActualQuestionId: displayed.currentQuestion.id,
      expectedPlanRevision: 1,
      followupTaskId: task.id,
      selfWritten: { text: "那一年您最记得哪件事？", intent: "scene" },
    }),
  );
  assert.equal(rewritten.currentQuestion.source.generationTaskId, task.id);
  assert.equal(
    rewritten.questionHistory[2].parentActualQuestionId,
    displayed.currentQuestion.id,
  );
});

test("preferences and AI withdrawal during transport suppress a late question while retaining its model usage", async () => {
  for (const change of ["preferences", "withdraw-ai"] as const) {
    const p = await bound(),
      i = await interview(p);
    await readyInput(p, i);
    const url = `/v1/projects/${p.projectId}/interviews/${i.id}/follow-up`;
    const task = data(
      await request("POST", url, p.narrator.token, {
        clientRequestId: randomUUID(),
        actualQuestionId: i.actualQuestion.id,
        expectedQuestionVersion: 1,
      }),
      202,
    ).task;
    const transport = providerTransport;
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((r) => {
        release = r;
      }),
      sent = new Promise<void>((r) => {
        entered = r;
      });
    providerTransport = async (input, init) => {
      entered();
      await gate;
      return transport(input, init);
    };
    const running = app.get(ProductionTasks).run(task.id);
    try {
      await sent;
      if (change === "preferences")
        data(
          await request(
            "POST",
            `/v1/projects/${p.projectId}/plan/preferences`,
            p.narrator.token,
            { expectedVersion: 1, blockedTopics: ["work"], questionStates: [] },
          ),
        );
      else data((await choose(p, p.narrator.token, "ai", false)).response);
    } finally {
      release();
      await running;
      providerTransport = transport;
    }
    const response = await request(
      "POST",
      `${url}/status`,
      p.narrator.token,
      {},
    );
    if (change === "withdraw-ai")
      assert.equal(
        response.statusCode,
        403,
        "epoch revocation must hide the old interview",
      );
    else {
      const late = data(response);
      assert.equal(late.task.state, "obsolete");
      assert.equal(late.result, null);
    }
    const stored = await db.productionTask.findUniqueOrThrow({
        where: { id: task.id },
      }),
      attempt = await db.taskAttempt.findFirstOrThrow({
        where: { taskId: task.id },
      });
    assert.equal(stored.state, "obsolete");
    assert.equal((attempt.usage as any).total_tokens, 30);
    assert.equal(
      (
        await db.taskAttemptObservation.findFirstOrThrow({
          where: { requestId: attempt.requestId },
        })
      ).superseded,
      true,
    );
  }
});

test("not-applicable and blocked current plan topics finish before dispatch and do not consume a follow-up allowance", async () => {
  for (const rule of ["not-applicable", "blocked"] as const) {
    const p = await bound();
    data((await choose(p, p.narrator.token, "collection", true)).response);
    const plan = data(
        await request(
          "GET",
          `/v1/projects/${p.projectId}/plan`,
          p.narrator.token,
        ),
        200,
      ),
      questionKey = plan.chapters[0].questions[0].key;
    const i = await interview(p, true, { questionKey });
    await readyInput(p, i);
    data(
      await request(
        "POST",
        `/v1/projects/${p.projectId}/plan/preferences`,
        p.narrator.token,
        {
          expectedVersion: 1,
          blockedTopics: rule === "blocked" ? [questionKey] : [],
          questionStates:
            rule === "not-applicable"
              ? [{ questionKey, state: "not-applicable" }]
              : [],
        },
      ),
    );
    const before = textRequests.length,
      view = data(
        await request(
          "POST",
          `/v1/projects/${p.projectId}/interviews/${i.id}/follow-up`,
          p.narrator.token,
          {
            clientRequestId: randomUUID(),
            actualQuestionId: i.actualQuestion.id,
            expectedQuestionVersion: 1,
          },
        ),
        202,
      );
    assert.equal(view.task, null);
    assert.equal(
      view.finishReason,
      rule === "blocked" ? "BLOCKED_TOPIC" : "NOT_APPLICABLE",
    );
    assert.equal(view.usage, 0);
    assert.equal(textRequests.length, before);
  }
});

test("unknown references, multiple questions, extra schema fields, and a repeated historical question are rejected without exposing a suggestion", async () => {
  for (const invalid of [
    "unknown-ref",
    "multi-question",
    "extra-field",
    "repeated",
  ] as const) {
    const p = await bound(),
      i = await interview(p);
    await readyInput(p, i);
    const url = `/v1/projects/${p.projectId}/interviews/${i.id}/follow-up`;
    const task = data(
      await request("POST", url, p.narrator.token, {
        clientRequestId: randomUUID(),
        actualQuestionId: i.actualQuestion.id,
        expectedQuestionVersion: 1,
      }),
      202,
    ).task;
    const transport = providerTransport;
    providerTransport = async (input, init) => {
      const response = await transport(input, init),
        json = (await response.json()) as any,
        output = JSON.parse(json.choices[0].message.content);
      if (invalid === "unknown-ref")
        output.sourceRefs = ["transcript:unknown:unknown"];
      if (invalid === "multi-question")
        output.question = "那时在哪里？您还记得谁？";
      if (invalid === "extra-field") output.extra = "untrusted";
      if (invalid === "repeated")
        output.question =
          i.actualQuestion.snapshot.text.replace(/[。！!？?]/g, "") + "？";
      json.choices[0].message.content = JSON.stringify(output);
      return Response.json(json);
    };
    try {
      await app.get(ProductionTasks).run(task.id);
    } finally {
      providerTransport = transport;
    }
    const view = data(
      await request("POST", `${url}/status`, p.narrator.token, {}),
    );
    assert.equal(view.task.state, "failed");
    assert.equal(view.result, null);
    assert.equal(view.canFinish, true);
    assert.equal(view.usage, 1);
  }
});

async function packageWith(change: (snapshot: any) => void) {
  const snapshot = JSON.parse(
    readFileSync("test/fixtures/catalog-synthetic.json", "utf8"),
  );
  change(snapshot);
  const draftId = randomUUID(),
    id = randomUUID();
  await db.packageDraft.create({
    data: { id: draftId, realm: "local", ...snapshot },
  });
  await db.packageVersion.create({
    data: {
      id,
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
  return id;
}
test("the sold follow-up allowance charges one intent, keeps replay and confirmed system retry free, and does not limit original audio", async () => {
  const version = await packageWith((s) => {
    s.admission.d04.userQuotas.followUps.value = 1;
  });
  const p = await bound(version),
    i = await interview(p);
  await readyInput(p, i);
  const url = `/v1/projects/${p.projectId}/interviews/${i.id}/follow-up`,
    command = {
      clientRequestId: randomUUID(),
      actualQuestionId: i.actualQuestion.id,
      expectedQuestionVersion: 1,
    };
  const first = data(
    await request("POST", url, p.narrator.token, command),
    202,
  );
  assert.equal(
    data(
      await request("POST", url, p.narrator.token, {
        ...command,
        clientRequestId: randomUUID(),
      }),
      202,
    ).task.id,
    first.task.id,
  );
  const transport = providerTransport;
  providerTransport = async () =>
    Response.json({
      model: "synthetic-invalid",
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      choices: [],
    });
  try {
    await app.get(ProductionTasks).run(first.task.id);
  } finally {
    providerTransport = transport;
  }
  data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/tasks/${first.task.id}/retry`,
      p.narrator.token,
      {},
    ),
    202,
  );
  await app.get(ProductionTasks).run(first.task.id);
  const succeeded = data(
    await request("POST", `${url}/status`, p.narrator.token, {}),
  );
  assert.equal(succeeded.usage, 1);
  assert.equal(succeeded.task.attempts.length, 2);
  assert.equal(succeeded.task.state, "succeeded");
  assert.equal(
    (
      await request("POST", url, p.narrator.token, {
        ...command,
        clientRequestId: randomUUID(),
      })
    ).statusCode,
    409,
  );
  await sealedClip(p, i.id);
  assert.equal(
    await db.recordingClip.count({ where: { projectId: p.projectId } }),
    2,
  );
});

test("the text submission budget includes both green Story compositions and optional follow-ups", async () => {
  const maximum = config.generation!.maxSubmissions,
    transport = providerTransport;
  config.generation!.maxSubmissions = 1;
  providerTransport = async (input, init) => {
    if (!String(input).includes("deepseek.com")) return transport(input, init);
    const payload = JSON.parse(String(init?.body));
    if (payload.messages[0].content.includes("只提出一条中性"))
      return transport(input, init);
    const source = JSON.parse(payload.messages[1].content);
    return Response.json({
      model: "synthetic-story",
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      choices: [
        {
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: JSON.stringify({
              title: "合成故事",
              theme: "一段讲述",
              paragraphs: [
                {
                  text: "那一年大概是八十年代，也可能更早。",
                  sourceRefs: source.sourceRefs,
                },
              ],
              reviewItems: ["年份待核对"],
            }),
          },
        },
      ],
    });
  };
  try {
    for (const firstKind of ["compose_story", "ask_followup"] as const) {
      const p = await bound(),
        i = await interview(p);
      await readyInput(p, i);
      const followup = async () =>
        data(
          await request(
            "POST",
            `/v1/projects/${p.projectId}/interviews/${i.id}/follow-up`,
            p.narrator.token,
            {
              clientRequestId: randomUUID(),
              actualQuestionId: i.actualQuestion.id,
              expectedQuestionVersion: 1,
            },
          ),
          202,
        );
      const story = async () =>
        data(
          await request(
            "POST",
            `/v1/projects/${p.projectId}/stories/organize`,
            p.narrator.token,
            { interviewId: i.id, baseVersion: 0 },
          ),
          202,
        );
      const first = await (firstKind === "compose_story"
        ? story()
        : followup());
      await app.get(ProductionTasks).run(first.task.id);
      assert.equal(
        (
          await db.productionTask.findUniqueOrThrow({
            where: { id: first.task.id },
          })
        ).state,
        "succeeded",
      );
      const second = await (firstKind === "compose_story"
        ? followup()
        : story());
      await app.get(ProductionTasks).run(second.task.id);
      const task = await db.productionTask.findUniqueOrThrow({
        where: { id: second.task.id },
      });
      assert.equal(task.state, "manual_review");
      assert.equal(task.errorCode, "PROVIDER_BUDGET_EXHAUSTED");
      assert.equal(
        await db.taskAttempt.count({ where: { taskId: second.task.id } }),
        0,
      );
    }
  } finally {
    config.generation!.maxSubmissions = maximum;
    providerTransport = transport;
  }
});

test("an explicit refusal in the saved answer takes precedence before generation even when it is not the entire transcript", async () => {
  const p = await bound(),
    i = await interview(p),
    transport = providerTransport;
  providerTransport = async (input, init) => {
    const response = await transport(input, init);
    if (String(input).endsWith("/query")) {
      const body = (await response.json()) as any;
      body.result.text = "这件事说到这里，我不想再谈这段经历了。";
      return Response.json(body, {
        headers: { "X-Api-Status-Code": "20000000" },
      });
    }
    return response;
  };
  try {
    await readyInput(p, i);
  } finally {
    providerTransport = transport;
  }
  const before = textRequests.length,
    view = data(
      await request(
        "POST",
        `/v1/projects/${p.projectId}/interviews/${i.id}/follow-up`,
        p.narrator.token,
        {
          clientRequestId: randomUUID(),
          actualQuestionId: i.actualQuestion.id,
          expectedQuestionVersion: 1,
        },
      ),
      202,
    );
  assert.equal(view.task, null);
  assert.equal(view.finishReason, "DECLINED");
  assert.equal(textRequests.length, before);
  assert.equal(view.usage, 0);
});

test("a committed follow-up input and quota intent are immutable in PostgreSQL", async () => {
  const p = await bound(),
    i = await interview(p);
  await readyInput(p, i);
  const url = `/v1/projects/${p.projectId}/interviews/${i.id}/follow-up`;
  const task = data(
    await request("POST", url, p.narrator.token, {
      clientRequestId: randomUUID(),
      actualQuestionId: i.actualQuestion.id,
      expectedQuestionVersion: 1,
    }),
    202,
  ).task;
  await assert.rejects(
    db.followupGeneration.update({
      where: { taskId: task.id },
      data: { input: { transcripts: [], injected: true } },
    }),
  );
  await assert.rejects(
    db.followupGeneration.update({
      where: { taskId: task.id },
      data: { charged: false },
    }),
  );
  assert.equal(
    (
      await db.followupGeneration.findUniqueOrThrow({
        where: { taskId: task.id },
      })
    ).charged,
    true,
  );
});

test("a valid model finish has no question snapshot to display and keeps the original recording available", async () => {
  const p = await bound(),
    i = await interview(p);
  await readyInput(p, i);
  const url = `/v1/projects/${p.projectId}/interviews/${i.id}/follow-up`,
    task = data(
      await request("POST", url, p.narrator.token, {
        clientRequestId: randomUUID(),
        actualQuestionId: i.actualQuestion.id,
        expectedQuestionVersion: 1,
      }),
      202,
    ).task;
  const transport = providerTransport;
  providerTransport = async (input, init) => {
    const response = await transport(input, init),
      json = (await response.json()) as any;
    json.choices[0].message.content = JSON.stringify({
      action: "finish",
      question: null,
      intent: null,
      sourceRefs: [],
      reasonCode: "ENOUGH_DETAIL",
    });
    return Response.json(json);
  };
  try {
    await app.get(ProductionTasks).run(task.id);
  } finally {
    providerTransport = transport;
  }
  const view = data(
    await request("POST", `${url}/status`, p.narrator.token, {}),
  );
  assert.equal(view.task.state, "succeeded");
  assert.equal(view.result.action, "finish");
  assert.equal(view.result.question, null);
  assert.equal(view.canFinish, true);
  assert.ok(view.latencyMs >= 0);
  assert.equal(
    (
      await request(
        "POST",
        `/v1/projects/${p.projectId}/interviews/${i.id}/actual-question`,
        p.narrator.token,
        {
          clientQuestionId: randomUUID(),
          expectedVersion: 1,
          expectedActualQuestionId: i.actualQuestion.id,
          expectedPlanRevision: 1,
          followupTaskId: task.id,
        },
      )
    ).statusCode,
    409,
  );
  assert.equal(
    await db.recordingClip.count({ where: { projectId: p.projectId } }),
    1,
  );
  assert.equal(
    await db.interviewActualQuestion.count({
      where: { projectId: p.projectId },
    }),
    1,
  );
});

test("configured OpenAPI advertises optional follow-up as authenticated POST commands", () => {
  const doc = createOpenApiDocument(app);
  const displaySchema = doc.components!.schemas!.DisplayActualQuestionDto as {
    required?: string[];
  };
  assert.ok(
    !displaySchema.required?.includes("selfWritten"),
    "generated display is valid without a client-authored rewrite",
  );
  for (const path of [
    "/v1/projects/{id}/interviews/{interviewId}/follow-up",
    "/v1/projects/{id}/interviews/{interviewId}/follow-up/status",
    "/v1/projects/{id}/interviews/{interviewId}/follow-up/finish",
  ]) {
    assert.ok(doc.paths[path].post?.security?.length);
    assert.equal(doc.paths[path].get, undefined);
  }
});

test("a memory cue can introduce one neutral gap while two distinct questions sharing a question mark are rejected", async () => {
  for (const [question, expected] of [
    ["那一年您还记得做过什么吗？", "succeeded"],
    ["那一年住在哪里，和谁一起生活？", "failed"],
  ] as const) {
    const p = await bound(),
      i = await interview(p);
    await readyInput(p, i);
    const url = `/v1/projects/${p.projectId}/interviews/${i.id}/follow-up`,
      task = data(
        await request("POST", url, p.narrator.token, {
          clientRequestId: randomUUID(),
          actualQuestionId: i.actualQuestion.id,
          expectedQuestionVersion: 1,
        }),
        202,
      ).task;
    const transport = providerTransport;
    providerTransport = async (input, init) => {
      const response = await transport(input, init),
        json = (await response.json()) as any,
        output = JSON.parse(json.choices[0].message.content);
      output.question = question;
      json.choices[0].message.content = JSON.stringify(output);
      return Response.json(json);
    };
    try {
      await app.get(ProductionTasks).run(task.id);
    } finally {
      providerTransport = transport;
    }
    const view = data(
      await request("POST", `${url}/status`, p.narrator.token, {}),
    );
    assert.equal(view.task.state, expected);
    assert.equal(
      view.result?.question ?? null,
      expected === "succeeded" ? question : null,
    );
  }
});

test("a rule-finished intent replays its frozen decision after preferences change without becoming a new model submission", async () => {
  const p = await bound();
  data((await choose(p, p.narrator.token, "collection", true)).response);
  const plan = data(
      await request(
        "GET",
        `/v1/projects/${p.projectId}/plan`,
        p.narrator.token,
      ),
      200,
    ),
    questionKey = plan.chapters[0].questions[0].key;
  const i = await interview(p, true, { questionKey });
  await readyInput(p, i);
  const pref = `/v1/projects/${p.projectId}/plan/preferences`,
    url = `/v1/projects/${p.projectId}/interviews/${i.id}/follow-up`;
  data(
    await request("POST", pref, p.narrator.token, {
      expectedVersion: 1,
      blockedTopics: [],
      questionStates: [{ questionKey, state: "skipped" }],
    }),
  );
  const key = randomUUID(),
    command = {
      clientRequestId: randomUUID(),
      actualQuestionId: i.actualQuestion.id,
      expectedQuestionVersion: 1,
    };
  assert.equal(
    data(await request("POST", url, p.narrator.token, command, key), 202)
      .finishReason,
    "DECLINED",
  );
  data(
    await request("POST", pref, p.narrator.token, {
      expectedVersion: 2,
      blockedTopics: [],
      questionStates: [],
    }),
  );
  const replay = data(
    await request("POST", url, p.narrator.token, command, key),
    202,
  );
  assert.equal(replay.task, null);
  assert.equal(replay.finishReason, "DECLINED");
  assert.equal(replay.usage, 0);
  const intent = await db.followupGeneration.findUniqueOrThrow({
    where: { taskId: command.clientRequestId },
  });
  assert.equal(intent.charged, false);
  assert.equal(
    await db.taskAttempt.count({ where: { taskId: intent.taskId } }),
    0,
  );
  assert.equal(
    await db.taskOutbox.count({ where: { taskId: intent.taskId } }),
    0,
  );
});

for (const [stop, reason] of [
  ["这件事说到这里，我不想再谈这段经历了。", "DECLINED"],
  ["这一段讲完了，结束吧。", "USER_FINISHED"],
] as const)
  test(`an earlier same-question ${reason} is not hidden by a later water break and stays an uncharged terminal intent`, async () => {
    const p = await bound(),
      i = await interview(p),
      transport = providerTransport;
    const answers = [stop, "我先喝一口水。"];
    let query = 0;
    providerTransport = async (input, init) => {
      const response = await transport(input, init);
      if (String(input).endsWith("/query")) {
        const body = (await response.json()) as any;
        body.result.text = answers[query++];
        return Response.json(body, {
          headers: { "X-Api-Status-Code": "20000000" },
        });
      }
      return response;
    };
    try {
      await readyInput(p, i);
      await readyInput(p, i);
    } finally {
      providerTransport = transport;
    }
    assert.equal(query, 2);
    const url = `/v1/projects/${p.projectId}/interviews/${i.id}/follow-up`,
      key = randomUUID(),
      command = {
        clientRequestId: randomUUID(),
        actualQuestionId: i.actualQuestion.id,
        expectedQuestionVersion: 1,
      },
      before = textRequests.length;
    const view = data(
      await request("POST", url, p.narrator.token, command, key),
      202,
    );
    assert.equal(view.task, null);
    assert.equal(view.finishReason, reason);
    assert.equal(view.usage, 0);
    const intent = await db.followupGeneration.findUniqueOrThrow({
      where: { taskId: command.clientRequestId },
    });
    assert.deepEqual(
      (intent.input as any).transcripts.map((t: any) => t.transcript),
      answers,
    );
    assert.equal(intent.charged, false);
    assert.equal(
      (
        await db.productionTask.findUniqueOrThrow({
          where: { id: intent.taskId },
        })
      ).state,
      "succeeded",
    );
    assert.equal(
      await db.taskAttempt.count({ where: { taskId: intent.taskId } }),
      0,
    );
    assert.equal(
      await db.taskOutbox.count({ where: { taskId: intent.taskId } }),
      0,
    );
    await app.get(ProductionTasks).run(intent.taskId);
    const replay = data(
      await request("POST", url, p.narrator.token, command, key),
      202,
    );
    assert.equal(replay.task, null);
    assert.equal(replay.finishReason, reason);
    assert.equal(replay.usage, 0);
    assert.equal(textRequests.length, before);
  });

test("a follow-up relay endpoint change stops the frozen task before any provider submission", async () => {
  const p = await bound(),
    i = await interview(p);
  await readyInput(p, i);
  const path = `/v1/projects/${p.projectId}/interviews/${i.id}/follow-up`;
  const created = data(
    await request("POST", path, p.narrator.token, {
      clientRequestId: randomUUID(),
      actualQuestionId: i.actualQuestion.id,
      expectedQuestionVersion: 1,
    }),
    202,
  );
  const before = textRequests.length;
  const deepseek = config.generation!.deepseek;
  const previous = deepseek.baseUrl;
  Object.assign(deepseek, { baseUrl: "https://cf.api.fan/v1" });
  try {
    await app.get(ProductionTasks).run(created.task.id);
    const current = data(
      await request("POST", `${path}/status`, p.narrator.token, {}),
    );
    assert.equal(current.task.state, "manual_review");
    assert.equal(current.task.errorCode, "CONFIGURATION_CHANGED");
    assert.equal(textRequests.length, before);
  } finally {
    if (previous === undefined) delete deepseek.baseUrl;
    else deepseek.baseUrl = previous;
  }
});

after(async () => {
  await closePrivacyFixture(config);
});
