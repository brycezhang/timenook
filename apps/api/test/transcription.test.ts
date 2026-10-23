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
import { fork, spawnSync } from "node:child_process";
import { before, after, test } from "node:test";
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import nock from "nock";
import { LocalProbeObjects } from "../src/probe/local-objects";
import { createApplication, createOpenApiDocument } from "../src/application";
import type { ApiConfig } from "../src/config";
import { paymentConfig, paymentFetch, paid, callback } from "./payment-fixture";
const schema = `t15_${randomUUID().replaceAll("-", "")}`;
let config: ApiConfig;
let root: string;
let app: Awaited<ReturnType<typeof createApplication>>;
let db: PrismaClient;
const packageId = randomUUID();
let sourceGate: (key: string) => Promise<void> = async () => {};
const providerRequests: { action: string; id: string; audioUrl?: string }[] =
  [];
let providerTransport: typeof fetch = async (input, init) => {
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
  root = await mkdtemp(join(tmpdir(), "timenook-transcription-"));
  config = {
    ...{ recording: { mode: "synthetic-local" as const, storageRoot: root } },
    environment: "test",
    host: "127.0.0.1",
    port: 3425,
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
async function interview(p: Awaited<ReturnType<typeof bound>>, ai = true) {
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
        starterKind: "free-narration",
      },
    ),
  );
}

async function sealedInput(ai = true, versionId = packageId) {
  const p = await bound(versionId),
    i = await interview(p, ai),
    audio = syntheticAudio();
  const base = `/v1/projects/${p.projectId}/interviews/${i.id}/clips`;
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
  return { ...p, interviewId: i.id, base, clip, sealed };
}
test("a sealed recording restores one durable transcription task across replay without another user charge", async () => {
  const p = await sealedInput();
  const first = data(
    await request("GET", `/v1/projects/${p.projectId}/tasks`, p.narrator.token),
    200,
  );
  assert.equal(first.length, 1);
  assert.equal(first[0].kind, "transcribe_audio");
  assert.equal(first[0].state, "queued");
  assert.equal(first[0].inputHash, p.sealed.sha256);
  data(
    await request("POST", `${p.base}/${p.clip.id}/seal`, p.narrator.token, {}),
  );
  const replay = data(
    await request("GET", `/v1/projects/${p.projectId}/tasks`, p.narrator.token),
    200,
  );
  assert.equal(replay.length, 1);
  assert.equal(replay[0].id, first[0].id);
  assert.equal(replay[0].recordingUsageMs, 1080);
  assert.equal(
    (await request("GET", `/v1/projects/${p.projectId}/tasks`)).statusCode,
    401,
  );
});

test("an actual Redis Worker submits saved audio and releases while the provider processes", async () => {
  const p = await sealedInput();
  const runtime = await startProductionWorker(app);
  try {
    const completed = once(runtime.worker, "completed");
    await runtime.recoverDue();
    await completed;
    const tasks = data(
      await request(
        "GET",
        `/v1/projects/${p.projectId}/tasks`,
        p.narrator.token,
      ),
      200,
    );
    assert.equal(tasks[0].state, "waiting_provider");
  } finally {
    await runtime.close();
  }
});

async function wake(
  runtime: Awaited<ReturnType<typeof startProductionWorker>>,
  id: string,
  event: "completed" | "failed" = "completed",
) {
  const completed = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      runtime.worker.off(event, onComplete);
      reject(new Error("Worker did not complete the scheduled delivery"));
    }, 4000);
    const onComplete = (job: { id?: string }) => {
      if (job.id === id) {
        clearTimeout(timer);
        runtime.worker.off(event, onComplete);
        resolve();
      }
    };
    runtime.worker.on(event, onComplete);
  });
  await runtime.recoverDue();
  await completed;
}
async function task(p: Awaited<ReturnType<typeof sealedInput>>) {
  return data(
    await request("GET", `/v1/projects/${p.projectId}/tasks`, p.narrator.token),
    200,
  )[0];
}
test("granting AI after cloud save processes the same task without invalidating saved audio", async () => {
  const p = await sealedInput(false),
    original = await task(p);
  const runtime = await startProductionWorker(app);
  try {
    await wake(runtime, original.id);
    assert.equal((await task(p)).state, "queued");
    assert.equal((await task(p)).errorCode, "AI_AUTHORIZATION_REQUIRED");
    data((await choose(p, p.narrator.token, "ai", true)).response);
    await wake(runtime, original.id);
    const ready = await task(p);
    assert.equal(ready.id, original.id);
    assert.equal(ready.state, "waiting_provider");
  } finally {
    await runtime.close();
  }
});

test("a sharing grant during ASR preserves the same original transcript and first queue time", async () => {
  const p = await sealedInput(),
    original = await task(p);
  const runtime = await startProductionWorker(app);
  try {
    await wake(runtime, original.id);
    data((await choose(p, p.narrator.token, "sharing", true)).response);
    await wake(runtime, original.id);
    const ready = await task(p);
    assert.equal(ready.state, "succeeded");
    assert.equal(
      ready.originalTranscript.text,
      "那一年大概是八十年代。\n也可能更早。",
    );
    assert.equal(ready.originalTranscript.inputHash, p.sealed.sha256);
    assert.equal(ready.queuedAt, original.queuedAt);
    assert.equal(ready.recordingUsageMs, 1080);
    const submit = providerRequests.find(
      (r) => r.action === "submit" && r.audioUrl?.includes(p.clip.id),
    );
    assert.ok(submit);
    assert.equal(
      providerRequests.filter(
        (r) => r.id === submit.id && r.action === "submit",
      ).length,
      1,
    );
    assert.equal(
      providerRequests.filter((r) => r.id === submit.id && r.action === "query")
        .length,
      1,
    );
  } finally {
    await runtime.close();
  }
});

test("withdrawal during a supplier response invalidates the task and renewed permission cannot revive the late result", async () => {
  const p = await sealedInput(),
    original = await task(p);
  const runtime = await startProductionWorker(app);
  const previous = providerTransport;
  try {
    await wake(runtime, original.id);
    let entered!: () => void, release!: () => void;
    const atProvider = new Promise<void>((resolve) => (entered = resolve)),
      responseGate = new Promise<void>((resolve) => (release = resolve));
    providerTransport = async (input, init) => {
      if (String(input).endsWith("/query")) {
        entered();
        await responseGate;
      }
      return previous(input, init);
    };
    const delivery = wake(runtime, original.id);
    await atProvider;
    data((await choose(p, p.narrator.token, "ai", false)).response);
    release();
    await delivery;
    let current = await task(p);
    assert.equal(current.state, "invalidated");
    assert.equal(current.originalTranscript, null);
    assert.equal(current.attempts[0].observations.at(-1).state, "succeeded");
    assert.equal(current.attempts[0].observations.at(-1).superseded, true);
    assert.equal(current.attempts[0].actualCostFen, null);
    data((await choose(p, p.narrator.token, "ai", true)).response);
    await runtime.recoverDue();
    current = await task(p);
    assert.equal(current.state, "invalidated");
    assert.equal(current.originalTranscript, null);
  } finally {
    providerTransport = previous;
    await runtime.close();
  }
});

test("a transport-unknown submission queries its original UUID and no speech asks for a new recording", async () => {
  const p = await sealedInput(),
    original = await task(p),
    previous = providerTransport;
  let requestId: string | undefined;
  providerTransport = async (input, init) => {
    const id = new Headers(init?.headers).get("X-Api-Request-Id")!;
    if (String(input).endsWith("/submit")) {
      requestId = id;
      throw new Error("private provider response must never be returned");
    }
    assert.equal(id, requestId);
    return new Response("", { headers: { "X-Api-Status-Code": "20000003" } });
  };
  const runtime = await startProductionWorker(app);
  try {
    await wake(runtime, original.id);
    assert.equal((await task(p)).state, "waiting_provider");
    await wake(runtime, original.id);
    const final = await task(p);
    assert.equal(final.state, "no_speech");
    assert.equal(final.originalTranscript, null);
    assert.equal(final.nextAction, "record_again");
    assert.equal(final.providerCode, "20000003");
    assert.equal(final.recordingUsageMs, 1080);
    assert.ok(!JSON.stringify(final).includes("private provider"));
  } finally {
    providerTransport = previous;
    await runtime.close();
  }
});

test("a superseded Worker cannot submit after its source operation outlives the database lease", async () => {
  const p = await sealedInput(),
    original = await task(p),
    tasks = app.get(ProductionTasks);
  let entered!: () => void,
    release!: () => void,
    blocked = false;
  const atSource = new Promise<void>((resolve) => (entered = resolve)),
    gate = new Promise<void>((resolve) => (release = resolve));
  sourceGate = async (key) => {
    if (key.includes(p.clip.id) && !blocked) {
      blocked = true;
      entered();
      await gate;
    }
  };
  const old = tasks.run(original.id);
  try {
    await atSource;
    await db.productionTask.update({
      where: { id: original.id },
      data: { leaseUntil: new Date("2000-01-01T00:00:00Z") },
    });
    await tasks.run(original.id);
    release();
    await old;
    assert.equal((await task(p)).state, "succeeded");
    assert.equal(
      providerRequests.filter(
        (r) => r.action === "submit" && r.audioUrl?.includes(p.clip.id),
      ).length,
      0,
    );
  } finally {
    release();
    sourceGate = async () => {};
    await old;
  }
});

test("a PostgreSQL failure after supplier response recovers by querying the original request", async () => {
  const p = await sealedInput(),
    original = await task(p),
    runtime = await startProductionWorker(app);
  await db.$executeRawUnsafe(
    `CREATE FUNCTION reject_t15_result() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${original.id}'::uuid AND NEW.state='waiting_provider' THEN RAISE EXCEPTION 'synthetic result commit crash'; END IF; RETURN NEW; END $$`,
  );
  await db.$executeRawUnsafe(
    `CREATE TRIGGER reject_t15_result BEFORE UPDATE ON production_tasks FOR EACH ROW EXECUTE FUNCTION reject_t15_result()`,
  );
  try {
    await wake(runtime, original.id, "failed");
    assert.equal((await task(p)).state, "submitting");
    await db.$executeRawUnsafe(
      "DROP TRIGGER reject_t15_result ON production_tasks",
    );
    await db.productionTask.update({
      where: { id: original.id },
      data: { leaseUntil: new Date("2000-01-01T00:00:00Z") },
    });
    await wake(runtime, original.id);
    const final = await task(p);
    assert.equal(final.state, "succeeded");
    assert.equal(final.queuedAt, original.queuedAt);
    assert.equal(final.recordingUsageMs, 1080);
    const submit = providerRequests.find(
      (r) => r.action === "submit" && r.audioUrl?.includes(p.clip.id),
    );
    assert.ok(submit);
    assert.deepEqual(
      providerRequests.filter((r) => r.id === submit.id).map((r) => r.action),
      ["submit", "query"],
    );
  } finally {
    await db.$executeRawUnsafe(
      "DROP TRIGGER IF EXISTS reject_t15_result ON production_tasks",
    );
    await db.$executeRawUnsafe("DROP FUNCTION IF EXISTS reject_t15_result()");
    await runtime.close();
  }
});
test("Redis queue loss rebuilds due work from PostgreSQL without resetting the input or queue clock", async () => {
  const p = await sealedInput(),
    original = await task(p);
  let runtime = await startProductionWorker(app);
  await wake(runtime, original.id);
  await runtime.close();
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 0 });
  redis.on("error", () => {});
  try {
    const keys = await redis.keys(`${schema}:production:*`);
    if (keys.length) await redis.del(...keys);
  } finally {
    redis.disconnect();
  }
  runtime = await startProductionWorker(app);
  try {
    await wake(runtime, original.id);
    const restored = await task(p);
    assert.equal(restored.id, original.id);
    assert.equal(restored.state, "succeeded");
    assert.equal(restored.queuedAt, original.queuedAt);
    assert.equal(restored.recordingUsageMs, 1080);
  } finally {
    await runtime.close();
  }
});

test("a confirmed supplier failure retries the same business intent once with a new bounded attempt and no recording charge", async () => {
  const p = await sealedInput(),
    original = await task(p),
    previous = providerTransport,
    runtime = await startProductionWorker(app);
  providerTransport = async (input, init) =>
    String(input).endsWith("/query")
      ? new Response("", { headers: { "X-Api-Status-Code": "45000132" } })
      : previous(input, init);
  try {
    await wake(runtime, original.id);
    await wake(runtime, original.id);
    const failed = await task(p);
    assert.equal(failed.state, "failed");
    const key = randomUUID(),
      url = `/v1/projects/${p.projectId}/tasks/${original.id}/retry`;
    const retried = data(
      await request("POST", url, p.narrator.token, {}, key),
      202,
    );
    assert.equal(retried.id, original.id);
    assert.equal(retried.state, "queued");
    assert.equal(
      data(await request("POST", url, p.narrator.token, {}, key), 202).id,
      original.id,
    );
    providerTransport = previous;
    await wake(runtime, original.id);
    await wake(runtime, original.id);
    const finished = await task(p);
    assert.equal(finished.state, "succeeded");
    assert.equal(finished.recordingUsageMs, 1080);
    assert.equal(finished.attempts.length, 2);
    assert.equal(finished.attempts[0].state, "failed");
    assert.equal(finished.queuedAt, original.queuedAt);
    assert.notEqual(
      finished.attempts[0].requestId,
      finished.attempts[1].requestId,
    );
  } finally {
    providerTransport = previous;
    await runtime.close();
  }
});

test("project supplier budgets bound unknown polling and expose manual takeover without a second user charge", async () => {
  const draftId = randomUUID(),
    versionId = randomUUID(),
    snapshot = JSON.parse(
      readFileSync("test/fixtures/catalog-synthetic.json", "utf8"),
    );
  snapshot.admission.d04.providerBudget.asrSubmissions.value = 1;
  snapshot.admission.d04.providerBudget.asrPolls.value = 1;
  snapshot.admission.d04.providerBudget.systemRetries.value = 1;
  snapshot.admission.d04.providerBudget.costCap.value = 1;
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
        title: "合成限额套餐",
        price: { value: 99900, unit: "fen", currency: "CNY" },
      },
    },
  });
  const p = await sealedInput(true, versionId),
    original = await task(p),
    previous = providerTransport;
  let calls = 0;
  providerTransport = async () => {
    calls++;
    throw new Error("synthetic unknown");
  };
  const runtime = await startProductionWorker(app);
  try {
    await wake(runtime, original.id);
    await wake(runtime, original.id);
    await wake(runtime, original.id);
    const exhausted = await task(p);
    assert.equal(exhausted.state, "manual_review");
    assert.equal(exhausted.errorCode, "PROVIDER_BUDGET_EXHAUSTED");
    assert.equal(exhausted.retryable, false);
    assert.equal(exhausted.nextAction, "contact_support");
    assert.equal(calls, 2);
    assert.equal(exhausted.attempts[0].reservedCostFen, 1);
    assert.equal(exhausted.attempts[0].actualCostFen, null);
    assert.equal(
      (
        await request(
          "POST",
          `/v1/projects/${p.projectId}/tasks/${original.id}/retry`,
          p.narrator.token,
          {},
        )
      ).statusCode,
      409,
    );
    assert.equal(exhausted.recordingUsageMs, 1080);
    providerTransport = async (input) =>
      new Response("{}", {
        headers: {
          "X-Api-Status-Code": String(input).endsWith("/submit")
            ? "20000000"
            : "45000132",
        },
      });
    const capped = await sealedInput(true, versionId),
      cappedTask = await task(capped),
      processor = app.get(ProductionTasks);
    await processor.run(cappedTask.id);
    await processor.run(cappedTask.id);
    const confirmedFailure = await task(capped);
    assert.equal(confirmedFailure.state, "failed");
    assert.equal(confirmedFailure.retryable, false);
    assert.equal(confirmedFailure.nextAction, "contact_support");
    assert.equal(
      (
        await request(
          "POST",
          `/v1/projects/${capped.projectId}/tasks/${cappedTask.id}/retry`,
          capped.narrator.token,
          {},
        )
      ).statusCode,
      409,
    );
  } finally {
    providerTransport = previous;
    await runtime.close();
  }
});

test("operators see sanitized task failures and retry through the same audited use case", async () => {
  const p = await sealedInput(),
    original = await task(p),
    previous = providerTransport,
    runtime = await startProductionWorker(app);
  providerTransport = async (input, init) =>
    String(input).endsWith("/query")
      ? new Response("secret raw provider body", {
          headers: { "X-Api-Status-Code": "45000132" },
        })
      : previous(input, init);
  try {
    await wake(runtime, original.id);
    await wake(runtime, original.id);
    const headers = await paymentAdmin(config, app, [
      "ops:read",
      "tasks:retry",
      "audit:read",
    ]);
    const listed = data(
      await app.inject({ method: "GET", url: "/v1/admin/tasks", headers }),
      200,
    );
    const row = listed.find((r: { id: string }) => r.id === original.id);
    assert.ok(row);
    assert.equal(row.errorCode, "PROVIDER_FAILED");
    assert.equal(row.originalTranscript, undefined);
    const serialized = JSON.stringify(listed);
    for (const secret of [
      "secret raw provider body",
      "signature=",
      "synthetic-t15-key",
      "那一年",
    ])
      assert.ok(!serialized.includes(secret));
    const key = randomUUID(),
      url = `/v1/admin/projects/${p.projectId}/tasks/${original.id}/retry`;
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url,
          headers: { cookie: headers.cookie },
          payload: {},
        })
      ).statusCode,
      403,
    );
    const retry = await app.inject({
      method: "POST",
      url,
      headers: { ...headers, "idempotency-key": key },
      payload: {},
    });
    assert.equal(data(retry, 202).id, original.id);
    assert.equal(
      data(
        await app.inject({
          method: "POST",
          url,
          headers: { ...headers, "idempotency-key": key },
          payload: {},
        }),
        202,
      ).id,
      original.id,
    );
    const audits = data(
      await app.inject({ method: "GET", url: "/v1/admin/audit", headers }),
      200,
    );
    assert.ok(
      audits.some(
        (a: { action: string; result: string }) =>
          a.action === "tasks.retry" && a.result === "success",
      ),
    );
    assert.ok(
      audits.some(
        (a: { action: string; result: string }) =>
          a.action === "tasks.retry" && a.result === "denied:403",
      ),
    );
  } finally {
    providerTransport = previous;
    await runtime.close();
  }
});

function childWorker(kind: "start" | "publish" = "start", taskId?: string) {
  const child = fork("dist-test/test/worker-process-fixture.js", [], {
    silent: true,
  });
  const messages: any[] = [],
    listeners = new Set<() => void>();
  child.on("message", (message) => {
    messages.push(message);
    for (const listener of listeners) listener();
  });
  let output = "";
  child.stdout?.on("data", (bytes) => (output += bytes.toString()));
  child.stderr?.on("data", (bytes) => (output += bytes.toString()));
  const wait = (predicate: (message: any) => boolean) =>
    new Promise<any>((resolve, reject) => {
      const inspect = () => {
        const match = messages.find(predicate);
        if (match) {
          clearTimeout(timer);
          listeners.delete(inspect);
          resolve(match);
        }
      };
      const timer = setTimeout(() => {
        listeners.delete(inspect);
        reject(new Error("Independent Worker message timeout: " + output));
      }, 8000);
      listeners.add(inspect);
      inspect();
    });
  child.on("message", (message: any) => {
    if (message.kind === "provider")
      child.send({
        kind: "response",
        sequence: message.sequence,
        code: "20000000",
        text: "独立 Worker 恢复的原始转录。",
      });
  });
  child.send({ kind, config, taskId });
  return {
    child,
    wait,
    messages,
    async close() {
      if (child.exitCode === null && !child.killed) {
        const exited = once(child, "exit");
        child.send({ kind: "close" });
        await exited;
      }
    },
  };
}
test("an independent Worker killed after the supplier response recovers the original UUID after lease and Redis repair", async () => {
  const p = await sealedInput(),
    original = await task(p),
    advisory = 1000000 + Math.floor(Math.random() * 1000000);
  let unlock!: () => void, locked!: () => void;
  const gate = new Promise<void>((resolve) => (unlock = resolve)),
    atLock = new Promise<void>((resolve) => (locked = resolve));
  await db.$executeRawUnsafe(
    `CREATE FUNCTION block_t15_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${original.id}'::uuid AND NEW.state='waiting_provider' THEN PERFORM pg_advisory_xact_lock(${advisory}); END IF; RETURN NEW; END $$`,
  );
  await db.$executeRawUnsafe(
    "CREATE TRIGGER block_t15_commit BEFORE UPDATE ON production_tasks FOR EACH ROW EXECUTE FUNCTION block_t15_commit()",
  );
  const blocker = db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${advisory}::bigint)`;
      locked();
      await gate;
    },
    { timeout: 12000 },
  );
  await atLock;
  let first: ReturnType<typeof childWorker> | undefined,
    second: ReturnType<typeof childWorker> | undefined;
  try {
    first = childWorker();
    await first.wait((m) => m.kind === "ready");
    const submitted = await first.wait(
      (m) =>
        m.kind === "provider" &&
        m.action === "submit" &&
        m.sourceKey?.includes(p.clip.id),
    );
    let waiting = false;
    for (let n = 0; n < 100; n++) {
      const locks = await db.$queryRaw<
        { count: bigint }[]
      >`SELECT count(*) AS count FROM pg_locks WHERE locktype='advisory' AND objid=${advisory}::oid AND NOT granted`;
      if (Number(locks[0].count) > 0) {
        waiting = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(
      waiting,
      true,
      "the parsed supplier result reached a blocked PostgreSQL result write",
    );
    const exited = once(first.child, "exit");
    first.child.kill("SIGKILL");
    const [code, signal] = await exited;
    assert.equal(code, null);
    assert.equal(signal, "SIGKILL");
    unlock();
    await blocker;
    await db.$executeRawUnsafe(
      "DROP TRIGGER block_t15_commit ON production_tasks",
    );
    assert.equal((await task(p)).state, "submitting");
    await db.productionTask.update({
      where: { id: original.id },
      data: { leaseUntil: new Date("2000-01-01T00:00:00Z") },
    });
    const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 0 });
    redis.on("error", () => {});
    try {
      const keys = await redis.keys(`${schema}:production:*`);
      if (keys.length) await redis.del(...keys);
    } finally {
      redis.disconnect();
    }
    second = childWorker();
    await second.wait((m) => m.kind === "ready");
    const query = await second.wait(
      (m) => m.kind === "provider" && m.id === submitted.id,
    );
    assert.equal(query.action, "query");
    await second.wait((m) => m.kind === "completed" && m.id === original.id);
    const restored = await task(p);
    assert.equal(restored.state, "succeeded");
    assert.equal(
      restored.originalTranscript.text,
      "独立 Worker 恢复的原始转录。",
    );
    assert.equal(restored.queuedAt, original.queuedAt);
    assert.equal(restored.recordingUsageMs, 1080);
    assert.equal(restored.attempts.length, 1);
    assert.equal(restored.attempts[0].requestId, submitted.id);
  } finally {
    unlock();
    await blocker;
    await first?.close();
    await second?.close();
    await db.$executeRawUnsafe(
      "DROP TRIGGER IF EXISTS block_t15_commit ON production_tasks",
    );
    await db.$executeRawUnsafe("DROP FUNCTION IF EXISTS block_t15_commit()");
  }
});

test("a source signing error before ASR transport releases the unused reservation and safely retries the same intent", async () => {
  const p = await sealedInput(),
    original = await task(p),
    tasks = app.get(ProductionTasks);
  sourceGate = async (key) => {
    if (key.includes(p.clip.id))
      throw new Error("synthetic OSS STS source failure");
  };
  try {
    await tasks.run(original.id);
    const failed = await task(p);
    assert.equal(failed.state, "failed");
    assert.equal(failed.errorCode, "SOURCE_UNAVAILABLE");
    assert.equal(failed.attempts.length, 0);
    assert.equal(failed.recordingUsageMs, 1080);
    assert.equal(failed.providerRequestId, original.providerRequestId);
    assert.equal(failed.configurationVersion, original.configurationVersion);
    assert.equal(failed.queuedAt, original.queuedAt);
    assert.equal(
      providerRequests.filter((r) => r.audioUrl?.includes(p.clip.id)).length,
      0,
    );
    sourceGate = async () => {};
    const retried = data(
      await request(
        "POST",
        `/v1/projects/${p.projectId}/tasks/${original.id}/retry`,
        p.narrator.token,
        {},
      ),
      202,
    );
    assert.equal(retried.id, original.id);
    await tasks.run(original.id);
    await tasks.run(original.id);
    const final = await task(p);
    assert.equal(final.state, "succeeded");
    assert.equal(final.attempts.length, 1);
    assert.equal(final.attempts[0].requestId, original.providerRequestId);
    assert.equal(final.attempts[0].reservedCostFen, 1);
    assert.equal(final.attempts[0].actualCostFen, null);
    assert.equal(final.queuedAt, original.queuedAt);
    assert.equal(
      providerRequests.filter((r) => r.audioUrl?.includes(p.clip.id)).length,
      1,
    );
  } finally {
    sourceGate = async () => {};
  }
});

test("a durable task deadline moves to manual takeover without sending or resetting the queue clock", async () => {
  const p = await sealedInput(),
    original = await task(p),
    tasks = app.get(ProductionTasks);
  await db.productionTask.update({
    where: { id: original.id },
    data: { deadline: new Date("2000-01-01T00:00:00Z") },
  });
  await tasks.run(original.id);
  const expired = await task(p);
  assert.equal(expired.state, "manual_review");
  assert.equal(expired.errorCode, "DEADLINE_EXCEEDED");
  assert.equal(expired.queuedAt, original.queuedAt);
  assert.equal(expired.attempts.length, 0);
  assert.equal(
    providerRequests.filter((r) => r.audioUrl?.includes(p.clip.id)).length,
    0,
  );
  assert.equal(
    (
      await request(
        "POST",
        `/v1/projects/${p.projectId}/tasks/${original.id}/retry`,
        p.narrator.token,
        {},
      )
    ).statusCode,
    409,
  );
});

async function assisted(
  p: Awaited<ReturnType<typeof project>>,
  purpose: string,
) {
  const current = await state(p, p.buyer.token);
  const sessions = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/assisted-sessions`,
      p.buyer.token,
    ),
    200,
  ).sessions;
  const prior = sessions.find(
    (s: { purpose: string }) => s.purpose === purpose,
  );
  return data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/assisted-sessions`,
      p.buyer.token,
      {
        ...notice(),
        evidenceRef: `synthetic:${randomUUID()}`,
        purpose,
        granted: true,
        expectedBindingVersion: current.bindingVersion,
        expectedAccessEpoch: current.accessEpoch,
        ...(prior ? { expectedSessionId: prior.id } : {}),
      },
    ),
  );
}
test("expiry of the actual assisted AI grant blocks a late result and a renewed grant cannot revive that task", async (t) => {
  const p = await project(),
    realNow = Date.now;
  let controlled: number | undefined = realNow() - 890000;
  t.mock.method(Date, "now", () => controlled ?? realNow());
  const ai = await assisted(p, "ai");
  controlled = undefined;
  const collection = await assisted(p, "collection");
  await assisted(p, "sharing");
  const body = { assistedSessionId: collection.id },
    audio = syntheticAudio();
  const i = data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/interviews`,
      p.buyer.token,
      {
        ...body,
        clientInterviewId: randomUUID(),
        expectedPlanRevision: 1,
        starterKind: "free-narration",
      },
    ),
  );
  const base = `/v1/projects/${p.projectId}/interviews/${i.id}/clips`;
  const clip = data(
    await request("POST", base, p.buyer.token, {
      ...body,
      clientClipId: randomUUID(),
      bytes: audio.length,
      sha256: createHash("sha256").update(audio).digest("hex"),
    }),
  );
  const form = data(
    await request("POST", `${base}/${clip.id}/upload`, p.buyer.token, body),
  );
  assert.equal(
    (await formUpload(app, form, audio, {}, p.buyer.token)).statusCode,
    204,
  );
  data(await request("POST", `${base}/${clip.id}/seal`, p.buyer.token, body));
  const tasks = app.get(ProductionTasks),
    list = () =>
      request("GET", `/v1/projects/${p.projectId}/tasks`, p.buyer.token);
  const original = data(await list(), 200)[0];
  await tasks.run(original.id);
  assert.equal(data(await list(), 200)[0].state, "waiting_provider");
  assert.equal(data(await list(), 200)[0].attempts.length, 1);
  assert.ok(Date.parse(collection.expiresAt) > Date.parse(ai.expiresAt));
  const previous = providerTransport;
  let entered!: () => void, release!: () => void;
  const atProvider = new Promise<void>((resolve) => (entered = resolve)),
    gate = new Promise<void>((resolve) => (release = resolve));
  providerTransport = async (input, init) => {
    if (
      String(input).endsWith("/query") &&
      new Headers(init?.headers).get("X-Api-Request-Id") ===
        original.providerRequestId
    ) {
      entered();
      await gate;
    }
    return previous(input, init);
  };
  try {
    const completing = tasks.run(original.id);
    await atProvider;
    controlled = Date.parse(ai.expiresAt);
    release();
    await completing;
    let current = data(await list(), 200)[0];
    assert.equal(current.state, "invalidated");
    assert.equal(current.originalTranscript, null);
    assert.equal(current.attempts[0].observations.at(-1).superseded, true);
    await assisted(p, "ai");
    await tasks.run(original.id);
    current = data(await list(), 200)[0];
    assert.equal(current.state, "invalidated");
    assert.equal(current.originalTranscript, null);
  } finally {
    release();
    providerTransport = previous;
  }
});

test("the recording usage intent cannot be moved to a different recording in the same project", async () => {
  const p = await sealedInput(),
    original = await task(p),
    audio = syntheticAudio();
  const other = data(
    await request("POST", p.base, p.narrator.token, {
      clientClipId: randomUUID(),
      bytes: audio.length,
      sha256: p.sealed.sha256,
    }),
  );
  await assert.rejects(
    db.taskQuotaIntent.update({
      where: { taskId: original.id },
      data: { recordingIntentId: other.id },
    }),
  );
  assert.equal((await task(p)).recordingUsageMs, 1080);
});

test("an Outbox write failure rolls back the clip, task and usage intent before the original seal can recover", async () => {
  const p = await bound(),
    i = await interview(p),
    audio = syntheticAudio(),
    base = `/v1/projects/${p.projectId}/interviews/${i.id}/clips`;
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
  await db.$executeRawUnsafe(
    "CREATE FUNCTION reject_t15_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic Outbox fault'; END $$",
  );
  await db.$executeRawUnsafe(
    "CREATE TRIGGER reject_t15_outbox BEFORE INSERT ON task_outbox FOR EACH ROW EXECUTE FUNCTION reject_t15_outbox()",
  );
  try {
    assert.equal(
      (await request("POST", `${base}/${clip.id}/seal`, p.narrator.token, {}))
        .statusCode,
      500,
    );
    const pending = data(
      await request("GET", `${base}/${clip.id}`, p.narrator.token),
      200,
    );
    assert.equal(pending.state, "pending");
    assert.equal(pending.asset, null);
    assert.deepEqual(
      data(
        await request(
          "GET",
          `/v1/projects/${p.projectId}/tasks`,
          p.narrator.token,
        ),
        200,
      ),
      [],
    );
  } finally {
    await db.$executeRawUnsafe("DROP TRIGGER reject_t15_outbox ON task_outbox");
    await db.$executeRawUnsafe("DROP FUNCTION reject_t15_outbox()");
  }
  data(await request("POST", `${base}/${clip.id}/seal`, p.narrator.token, {}));
  const restored = data(
    await request("GET", `/v1/projects/${p.projectId}/tasks`, p.narrator.token),
    200,
  );
  assert.equal(restored.length, 1);
  assert.equal(restored[0].recordingUsageMs, 1080);
});

test("a producer killed after Redis accepts delivery leaves PostgreSQL recoverable and one supplier attempt", async () => {
  const p = await sealedInput(),
    original = await task(p),
    producer = childWorker("publish", original.id);
  let runtime: Awaited<ReturnType<typeof startProductionWorker>> | undefined;
  try {
    await producer.wait((m) => m.kind === "published" && m.id === original.id);
    const exited = once(producer.child, "exit");
    producer.child.kill("SIGKILL");
    assert.equal((await exited)[1], "SIGKILL");
    assert.equal(
      (
        await db.taskOutbox.findUniqueOrThrow({
          where: { taskId: original.id },
        })
      ).deliveredAt,
      null,
    );
    runtime = await startProductionWorker(app);
    for (
      let n = 0;
      n < 100 && (await task(p)).state !== "waiting_provider";
      n++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal((await task(p)).state, "waiting_provider");
    await wake(runtime, original.id);
    const final = await task(p);
    assert.equal(final.state, "succeeded");
    assert.equal(final.attempts.length, 1);
    assert.equal(final.queuedAt, original.queuedAt);
  } finally {
    await producer.close();
    await runtime?.close();
  }
});

test("formal transcripts are immutable in PostgreSQL and a task cannot switch to another project's asset", async () => {
  const p = await sealedInput(),
    q = await sealedInput(),
    original = await task(p),
    tasks = app.get(ProductionTasks);
  await tasks.run(original.id);
  await tasks.run(original.id);
  assert.equal(
    (await task(p)).originalTranscript.text,
    "那一年大概是八十年代。\n也可能更早。",
  );
  await assert.rejects(
    db.formalTranscript.update({
      where: { taskId: original.id },
      data: { text: "不能原地改写原始转录" },
    }),
  );
  await assert.rejects(
    db.productionTask.update({
      where: { id: original.id },
      data: { assetId: q.sealed.asset.id },
    }),
  );
  assert.equal(
    (await task(p)).originalTranscript.text,
    "那一年大概是八十年代。\n也可能更早。",
  );
});
test("transcription defaults deny production, missing synthetic transport and non-synthetic provider configuration", async () => {
  await assert.rejects(
    createApplication(config, { wechatFetch, paymentFetch }),
    /explicit isolated synthetic/,
  );
  await assert.rejects(
    createApplication(
      { ...config, environment: "production" },
      { wechatFetch, paymentFetch, aiFetch: providerTransport },
    ),
    /explicit isolated synthetic/,
  );
  await assert.rejects(
    createApplication(
      {
        ...config,
        transcription: {
          ...config.transcription!,
          doubao: {
            ...config.transcription!.doubao,
            apiKey: "not-an-approved-real-key",
          },
        },
      },
      { wechatFetch, paymentFetch, aiFetch: providerTransport },
    ),
    /explicit isolated synthetic/,
  );
  const processResult = spawnSync(
    process.execPath,
    ["dist-test/src/tasks/worker-main.js"],
    {
      env: {
        ...process.env,
        NODE_ENV: "test",
        DATABASE_URL: config.databaseUrl,
        REDIS_URL: config.redisUrl,
        TIMENOOK_WECHAT_APP_ID: "",
        TIMENOOK_WECHAT_APP_SECRET: "",
        ADMIN_ORIGIN: "",
        ADMIN_ENCRYPTION_KEY: "",
      },
      encoding: "utf8",
      timeout: 5000,
    },
  );
  assert.equal(processResult.status, 1);
  assert.match(
    processResult.stderr,
    /Worker configuration or dependencies unavailable/,
  );
  assert.ok(!processResult.stderr.includes(config.databaseUrl));
  const document = createOpenApiDocument(app);
  for (const route of [
    "/v1/projects/{id}/tasks",
    "/v1/projects/{id}/tasks/status",
    "/v1/projects/{id}/tasks/{taskId}",
    "/v1/projects/{id}/tasks/{taskId}/retry",
    "/v1/admin/tasks",
    "/v1/admin/projects/{id}/tasks/{taskId}/retry",
  ])
    assert.ok(document.paths[route]);
});

test("a Worker configured for another object storage scope cannot submit a saved project asset", async () => {
  const p = await sealedInput(),
    original = await task(p),
    otherRoot = await mkdtemp(join(tmpdir(), "timenook-t15-other-store-"));
  class Source extends LocalProbeObjects {
    async asrSource(key: string) {
      return {
        url: `https://synthetic.oss-cn-shanghai.aliyuncs.com/${key}`,
        expiresAt: new Date(Date.now() + 120000).toISOString(),
        credentialsExpireAt: new Date(Date.now() + 180000).toISOString(),
      };
    }
  }
  const other = await createApplication(
    { ...config, recording: { ...config.recording!, storageRoot: otherRoot } },
    {
      wechatFetch,
      paymentFetch,
      aiFetch: providerTransport,
      recordingObjects: new Source(root),
    },
  );
  try {
    await other.get(ProductionTasks).run(original.id);
    const blocked = await task(p);
    assert.equal(blocked.state, "invalidated");
    assert.equal(blocked.errorCode, "INPUT_CHANGED");
    assert.equal(blocked.attempts.length, 0);
    assert.equal(
      providerRequests.filter((r) => r.audioUrl?.includes(p.clip.id)).length,
      0,
    );
  } finally {
    await other.close();
    await rm(otherRoot, { recursive: true, force: true });
  }
});
