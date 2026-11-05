import { bootPrivacyFixture, closePrivacyFixture } from "./privacy-fixture";
import { ProjectPlans } from "../src/projects/project-plans";
import { Stories } from "../src/stories/stories";
import { Participation } from "../src/identity/participation";
import { paymentAdmin } from "./payment-admin-fixture";
import { once } from "node:events";
import { ProductionTasks } from "../src/tasks/tasks";
import { startProductionWorker } from "../src/tasks/worker";
import { waitForWorkerJobs } from "./worker-completion";
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
import { createOpenApiDocument } from "../src/application";
import { createAdminApplication as createApplication } from "./admin-feishu-fixture";
import type { ApiConfig } from "../src/config";
import { paymentConfig, paymentFetch, paid, callback } from "./payment-fixture";
const schema = `t18_${randomUUID().replaceAll("-", "")}`;
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
                title: "我记得的那一年",
                theme: "旧时光",
                paragraphs: [
                  {
                    text: "我记得那一年大概是八十年代，也可能更早。",
                    sourceRefs: source.sourceRefs,
                  },
                ],
                reviewItems: ["确切年代待本人核对"],
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
  root = await mkdtemp(join(tmpdir(), "timenook-story-"));
  config = {
    ...{ recording: { mode: "synthetic-local" as const, storageRoot: root } },
    environment: "test",
    host: "127.0.0.1",
    port: 3428,
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
    i = await interview(p, ai);
  return sealedClip(p, i.id);
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
test("submitting a story freezes every sealed clip including the unfinished final transcript and replays one task", async () => {
  const p = await bound(),
    i = await interview(p);
  await sealedClip(p, i.id);
  await sealedClip(p, i.id);
  const key = randomUUID();
  const url = `/v1/projects/${p.projectId}/stories/organize`;
  const first = data(
    await request(
      "POST",
      url,
      p.narrator.token,
      { interviewId: i.id, baseVersion: 0 },
      key,
    ),
    202,
  );
  assert.equal(first.task.kind, "compose_story");
  assert.equal(first.task.state, "waiting_inputs");
  assert.equal(first.task.sources.length, 2);
  assert.equal(
    first.task.sources.every((s: any) => s.transcript === null),
    true,
  );
  const replay = data(
    await request(
      "POST",
      url,
      p.narrator.token,
      { interviewId: i.id, baseVersion: 0 },
      key,
    ),
    202,
  );
  assert.equal(replay.task.id, first.task.id);
  assert.deepEqual(replay.task.sources, first.task.sources);
  const restored = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/stories/${first.id}`,
      p.narrator.token,
    ),
    200,
  );
  assert.equal(restored.task.id, first.task.id);
  assert.equal(restored.version, 0);
});

async function wakeStory(
  runtime: Awaited<ReturnType<typeof startProductionWorker>>,
  id: string,
  otherId?: string,
) {
  await waitForWorkerJobs(runtime.worker, async (declareExpected) => {
    declareExpected([id, ...(otherId ? [otherId] : [])]);
    await runtime.recoverDue();
  });
}
test("the actual Worker waits for the final transcript then composes the complete sourced immutable story", async () => {
  const p = await bound(),
    i = await interview(p);
  await sealedClip(p, i.id);
  await sealedClip(p, i.id);
  const first = data(
      await request(
        "POST",
        `/v1/projects/${p.projectId}/stories/organize`,
        p.narrator.token,
        { interviewId: i.id, baseVersion: 0 },
      ),
      202,
    ),
    taskId = first.task.id;
  const before = textRequests.length;
  await app.get(ProductionTasks).run(taskId);
  const waiting = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/stories/${first.id}`,
      p.narrator.token,
    ),
    200,
  );
  assert.equal(waiting.task.state, "waiting_inputs");
  assert.equal(textRequests.length, before);
  for (const source of first.task.sources) {
    await app.get(ProductionTasks).run(source.transcriptionTaskId);
    await app.get(ProductionTasks).run(source.transcriptionTaskId);
  }
  await db.productionTask.update({
    where: { id: taskId },
    data: { nextRunAt: new Date(0) },
  }); // Exact due fixture, no short-TTL sleep.
  const runtime = await startProductionWorker(app);
  try {
    let current = waiting;
    for (let n = 0; n < 6 && current.task.state !== "succeeded"; n++) {
      await wakeStory(runtime, taskId);
      current = data(
        await request(
          "GET",
          `/v1/projects/${p.projectId}/stories/${first.id}`,
          p.narrator.token,
        ),
        200,
      );
    }
    assert.equal(current.task.state, "succeeded");
    assert.equal(current.version, 1);
    assert.equal(current.revision.origin, "ai");
    assert.equal(current.revision.sourceManifest.length, 2);
    assert.equal(current.revision.paragraphs[0].sourceRefs.length, 2);
    assert.deepEqual(current.revision.reviewItems, ["确切年代待本人核对"]);
    const sent = textRequests.find((x) =>
      x.transcripts?.every((v: any) =>
        first.task.sources.some((s: any) => s.clipId === v.clipId),
      ),
    );
    assert.equal(sent.transcripts.length, 2);
    assert.equal(sent.transcripts[0].question.id, i.actualQuestion.id);
    assert.equal(sent.preferences.version, 1);
    assert.ok(
      Date.parse(current.task.dependenciesReadyAt) >=
        Date.parse(current.task.allSavedAt),
    );
    assert.equal(current.task.userSubmittedAt, first.task.userSubmittedAt);
    assert.equal(current.task.queuedAt, first.task.queuedAt);
  } finally {
    await runtime.close();
  }
});
async function preparedStory(versionId = packageId) {
  const p = await bound(versionId),
    i = await interview(p);
  await sealedClip(p, i.id);
  await sealedClip(p, i.id);
  const tasks = data(
    await request("GET", `/v1/projects/${p.projectId}/tasks`, p.narrator.token),
    200,
  );
  for (const t of tasks) {
    await app.get(ProductionTasks).run(t.id);
    await app.get(ProductionTasks).run(t.id);
  }
  const story = data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/stories/organize`,
      p.narrator.token,
      { interviewId: i.id, baseVersion: 0 },
    ),
    202,
  );
  return { ...p, interviewId: i.id, story };
}
test("an invalid sourced output retries the same user intent with a new accounted provider attempt", async () => {
  const p = await preparedStory(),
    original = providerTransport;
  providerTransport = async (input, init) => {
    const response = await original(input, init);
    if (!String(input).includes("deepseek.com")) return response;
    const data = await response.json();
    data.choices[0].message.content = JSON.stringify({
      title: "坏稿",
      theme: "主题",
      paragraphs: [
        { text: "不允许无来源", sourceRefs: ["transcript:invented"] },
      ],
      reviewItems: [],
    });
    return new Response(JSON.stringify(data));
  };
  try {
    await app.get(ProductionTasks).run(p.story.task.id);
  } finally {
    providerTransport = original;
  }
  const failed = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/stories/${p.story.id}`,
      p.narrator.token,
    ),
    200,
  );
  assert.equal(failed.task.state, "failed");
  assert.equal(failed.revision, null);
  const retry = data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/tasks/${p.story.task.id}/retry`,
      p.narrator.token,
      {},
    ),
    202,
  );
  assert.equal(retry.id, p.story.task.id);
  await app.get(ProductionTasks).run(p.story.task.id);
  const complete = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/stories/${p.story.id}`,
      p.narrator.token,
    ),
    200,
  );
  assert.equal(complete.version, 1);
  assert.equal(complete.task.attempts.length, 2);
  assert.equal(complete.task.attempts[0].state, "failed");
  assert.equal(complete.task.attempts[0].usage.total_tokens, 30);
  assert.equal(complete.usage.organizations, 1);
  assert.equal(complete.task.attempts[1].actualCostFen, null);
});
test("a full waiting-input batch yields to a later ready story without resetting its submission clock", async (t) => {
  const waiting: string[] = [];
  for (let group = 0; group < 3; group++) {
    const p = await bound(),
      i = await interview(p);
    await sealedClip(p, i.id);
    for (let n = 0; n < 34; n++)
      waiting.push(
        data(
          await request(
            "POST",
            `/v1/projects/${p.projectId}/stories/organize`,
            p.narrator.token,
            { interviewId: i.id, baseVersion: 0 },
          ),
          202,
        ).task.id,
      );
  }
  const ready = await preparedStory(),
    runtime = await startProductionWorker(app);
  try {
    assert.equal(new Set(waiting).size, 102);
    const tasks = app.get(ProductionTasks),
      due = tasks.due.bind(tasks);
    async function scan() {
      let selected: string[] = [];
      await waitForWorkerJobs(
        runtime.worker,
        async (declareExpected) => {
          const selection = t.mock.method(tasks, "due", async () => {
            selected = await due();
            declareExpected(selected);
            return selected;
          });
          try {
            const count = await runtime.recoverDue();
            assert.equal(selected.length, count);
          } finally {
            selection.mock.restore();
          }
        },
        10000,
      );
      return selected;
    }
    assert.equal((await scan()).length, 100);
    assert.ok((await scan()).includes(ready.story.task.id));
    const completed = data(
      await request(
        "GET",
        `/v1/projects/${ready.projectId}/stories/${ready.story.id}`,
        ready.narrator.token,
      ),
      200,
    );
    assert.equal(completed.task.state, "succeeded");
    assert.equal(completed.task.queuedAt, ready.story.task.queuedAt);
  } finally {
    await runtime.close();
  }
});
test("generation admission rejects non-synthetic models and invalid budgets instead of enabling a provider", async () => {
  for (const change of [
    { maxSubmissions: 0 },
    {
      deepseek: {
        ...config.generation!.deepseek,
        model: "unreviewed-production-model",
      },
    },
  ]) {
    let other: Awaited<ReturnType<typeof createApplication>> | undefined;
    try {
      await assert.rejects(async () => {
        other = await createApplication(
          { ...config, generation: { ...config.generation!, ...change } },
          { wechatFetch, paymentFetch, aiFetch: providerTransport },
        );
      }, /Generation requires/);
    } finally {
      await other?.close();
    }
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
test("frozen user quotas count an organization or explicit regeneration once and bound later commands", async () => {
  const versionId = await packageWith((s) => {
    s.admission.d04.userQuotas.storyOrganizations.value = 1;
    s.admission.d04.userQuotas.activeRegenerations.value = 1;
  });
  const p = await preparedStory(versionId),
    url = `/v1/projects/${p.projectId}/stories/organize`;
  const duplicate = await request("POST", url, p.narrator.token, {
    interviewId: p.interviewId,
    baseVersion: 0,
  });
  assert.equal(duplicate.statusCode, 409, duplicate.body);
  await app.get(ProductionTasks).run(p.story.task.id);
  const key = randomUUID(),
    regen = data(
      await request(
        "POST",
        url,
        p.narrator.token,
        { interviewId: p.interviewId, baseVersion: 1 },
        key,
      ),
      202,
    );
  const replay = data(
    await request(
      "POST",
      url,
      p.narrator.token,
      { interviewId: p.interviewId, baseVersion: 1 },
      key,
    ),
    202,
  );
  assert.equal(replay.task.id, regen.task.id);
  assert.deepEqual(replay.usage, { organizations: 1, regenerations: 1 });
  await app.get(ProductionTasks).run(regen.task.id);
  const excess = await request("POST", url, p.narrator.token, {
    interviewId: p.interviewId,
    baseVersion: 2,
  });
  assert.equal(excess.statusCode, 409, excess.body);
});
test("a selected interview with an unfinished cloud save cannot silently organize only its sealed first half", async () => {
  const p = await bound(),
    i = await interview(p);
  await sealedClip(p, i.id);
  const audio = syntheticAudio();
  data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/interviews/${i.id}/clips`,
      p.narrator.token,
      {
        clientClipId: randomUUID(),
        bytes: audio.length,
        sha256: createHash("sha256").update(audio).digest("hex"),
      },
    ),
  );
  const result = await request(
    "POST",
    `/v1/projects/${p.projectId}/stories/organize`,
    p.narrator.token,
    { interviewId: i.id, baseVersion: 0 },
  );
  assert.equal(result.statusCode, 409, result.body);
});
test("beginning a real supplementary recording makes its in-flight story obsolete before seal while retaining provider accounting", async () => {
  const p = await preparedStory(),
    original = providerTransport;
  let release!: () => void, arrived!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    reached = new Promise<void>((r) => (arrived = r));
  providerTransport = async (input, init) => {
    if (String(input).includes("deepseek.com")) {
      arrived();
      await gate;
    }
    return original(input, init);
  };
  const running = app.get(ProductionTasks).run(p.story.task.id);
  try {
    await reached;
    data(
      await request(
        "POST",
        `/v1/projects/${p.projectId}/interviews/${p.interviewId}/recording-start`,
        p.narrator.token,
        {},
      ),
    );
    release();
    await running;
    const current = data(
      await request(
        "GET",
        `/v1/projects/${p.projectId}/stories/${p.story.id}`,
        p.narrator.token,
      ),
      200,
    );
    assert.equal(current.task.state, "obsolete");
    assert.equal(current.revision, null);
    assert.equal(current.version, 0);
    assert.equal(current.usage.organizations, 1);
    assert.equal(current.task.attempts[0].usage.total_tokens, 30);
    assert.equal(current.task.attempts[0].observations[0].superseded, true);
    assert.equal(current.task.userSubmittedAt, p.story.task.userSubmittedAt);
  } finally {
    release();
    await running;
    providerTransport = original;
  }
});
test("an unknown DeepSeek result becomes manual takeover without query or automatic resubmission and retains its uncertain charge", async () => {
  const p = await preparedStory(),
    original = providerTransport;
  let calls = 0;
  providerTransport = async (input, init) => {
    if (String(input).includes("deepseek.com")) {
      calls++;
      throw new Error("synthetic ambiguous response");
    }
    return original(input, init);
  };
  try {
    await app.get(ProductionTasks).run(p.story.task.id);
    await app.get(ProductionTasks).run(p.story.task.id);
    const current = data(
      await request(
        "GET",
        `/v1/projects/${p.projectId}/stories/${p.story.id}`,
        p.narrator.token,
      ),
      200,
    );
    assert.equal(current.task.state, "manual_review");
    assert.equal(current.task.errorCode, "PROVIDER_UNKNOWN");
    assert.equal(current.revision, null);
    assert.equal(calls, 1);
    assert.equal(current.task.attempts.length, 1);
    assert.equal(current.task.attempts[0].actualCostFen, null);
    assert.equal(current.task.attempts[0].reservedCostFen, 1);
    const retry = await request(
      "POST",
      `/v1/projects/${p.projectId}/tasks/${p.story.task.id}/retry`,
      p.narrator.token,
      {},
    );
    assert.equal(retry.statusCode, 409, retry.body);
    assert.equal(current.usage.organizations, 1);
    assert.equal(current.task.userSubmittedAt, p.story.task.userSubmittedAt);
  } finally {
    providerTransport = original;
  }
});
test("a response lost at PostgreSQL commit recovers to manual takeover with its original attempt rather than reissuing DeepSeek", async () => {
  const other = await preparedStory(),
    p = await preparedStory(),
    before = textRequests.length;
  await db.$executeRawUnsafe(
    `CREATE FUNCTION reject_story_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.generation_task_id='${p.story.task.id}'::uuid THEN RAISE EXCEPTION 'synthetic commit fault'; END IF; RETURN NEW; END $$`,
  );
  await db.$executeRawUnsafe(
    "CREATE TRIGGER reject_story_commit BEFORE INSERT ON story_revisions FOR EACH ROW EXECUTE FUNCTION reject_story_commit()",
  );
  try {
    await assert.rejects(
      app.get(ProductionTasks).run(p.story.task.id),
      /synthetic commit fault/,
    );
  } finally {
    await db.$executeRawUnsafe(
      "DROP TRIGGER reject_story_commit ON story_revisions",
    );
    await db.$executeRawUnsafe("DROP FUNCTION reject_story_commit()");
  }
  const lost = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/stories/${p.story.id}`,
      p.narrator.token,
    ),
    200,
  );
  const otherFrozen = data(
    await request(
      "GET",
      `/v1/projects/${other.projectId}/stories/${other.story.id}`,
      other.narrator.token,
    ),
    200,
  );
  await db.productionTask.update({
    where: { id: p.story.task.id },
    data: { leaseUntil: new Date(0), nextRunAt: new Date(0) },
  }); // Expire the exact crashed owner lease.
  // Keep the independent control in this scan's finite frontier; older waiting
  // fixtures must not displace it from the scheduler's first 100 due tasks.
  await db.productionTask.update({
    where: { id: other.story.task.id },
    data: { nextRunAt: new Date(0) },
  });
  const runtime = await startProductionWorker(app);
  try {
    await wakeStory(runtime, p.story.task.id, other.story.task.id);
  } finally {
    await runtime.close();
  }
  const current = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/stories/${p.story.id}`,
      p.narrator.token,
    ),
    200,
  );
  assert.equal(current.task.state, "manual_review");
  assert.equal(current.task.errorCode, "PROVIDER_UNKNOWN");
  assert.equal(current.version, 0);
  assert.equal(current.task.attempts.length, 1);
  assert.equal(
    current.task.attempts[0].requestId,
    lost.task.attempts[0].requestId,
  );
  const otherCurrent = data(
    await request(
      "GET",
      `/v1/projects/${other.projectId}/stories/${other.story.id}`,
      other.narrator.token,
    ),
    200,
  );
  assert.equal(otherCurrent.task.state, "succeeded");
  const targetRefs = lost.task.sources.map(
      (source: any) =>
        `transcript:${source.clipId}:${source.transcript.sha256}`,
    ),
    otherRefs = otherFrozen.task.sources.map(
      (source: any) =>
        `transcript:${source.clipId}:${source.transcript.sha256}`,
    );
  assert.equal(targetRefs.length, 2);
  assert.equal(otherRefs.length, 2);
  assert.equal(new Set([...targetRefs, ...otherRefs]).size, 4);
  // recoverDue also runs other projects; each frozen source set must be submitted exactly once.
  const calls = textRequests.slice(before),
    callsFor = (refs: string[]) =>
      calls.filter(
        (payload) =>
          Array.isArray(payload.sourceRefs) &&
          payload.sourceRefs.length === refs.length &&
          refs.every((ref) => payload.sourceRefs.includes(ref)),
      ).length;
  assert.equal(callsFor(targetRefs), 1);
  assert.equal(callsFor(otherRefs), 1);
  assert.equal(current.usage.organizations, 1);
  assert.equal(current.task.queuedAt, p.story.task.queuedAt);
});

test("the shared version owner rejects invented sources in a real authorization transaction", async () => {
  const p = await preparedStory();
  await app.get(ProductionTasks).run(p.story.task.id);
  await assert.rejects(
    app
      .get(Participation)
      .withPlanAccess(
        p.projectId,
        `Bearer ${p.narrator.token}`,
        undefined,
        (tx) =>
          app.get(Stories).appendIn(tx, {
            projectId: p.projectId,
            storyId: p.story.id,
            expectedVersion: 1,
            generationTaskId: p.story.task.id,
            origin: "participant",
            content: {
              title: "改稿",
              theme: "主题",
              paragraphs: [{ text: "无来源的改稿", sourceRefs: ["invented"] }],
              reviewItems: [],
            },
          }),
      ),
  );
  const current = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/stories/${p.story.id}`,
      p.narrator.token,
    ),
    200,
  );
  assert.equal(current.version, 1);
  assert.equal(current.revision.origin, "ai");
});
test("a participant revision appended through the shared authorized version owner wins over an older in-flight generation", async () => {
  const p = await preparedStory();
  await app.get(ProductionTasks).run(p.story.task.id);
  const first = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/stories/${p.story.id}`,
      p.narrator.token,
    ),
    200,
  );
  const regeneration = data(
      await request(
        "POST",
        `/v1/projects/${p.projectId}/stories/organize`,
        p.narrator.token,
        { interviewId: p.interviewId, baseVersion: 1 },
      ),
      202,
    ),
    original = providerTransport;
  let release!: () => void, arrived!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    reached = new Promise<void>((r) => (arrived = r));
  providerTransport = async (input, init) => {
    if (String(input).includes("deepseek.com")) {
      arrived();
      await gate;
    }
    return original(input, init);
  };
  const running = app.get(ProductionTasks).run(regeneration.task.id);
  try {
    await reached;
    const appended = await app
      .get(Participation)
      .withPlanAccess(
        p.projectId,
        `Bearer ${p.narrator.token}`,
        undefined,
        (tx) =>
          app.get(Stories).appendIn(tx, {
            projectId: p.projectId,
            storyId: p.story.id,
            expectedVersion: 1,
            generationTaskId: p.story.task.id,
            origin: "participant",
            content: {
              title: "本人校正的年代",
              theme: first.revision.theme,
              paragraphs: first.revision.paragraphs,
              reviewItems: first.revision.reviewItems,
            },
          }),
      );
    assert.equal(appended.version, 2);
    release();
    await running;
    const current = data(
      await request(
        "GET",
        `/v1/projects/${p.projectId}/stories/${p.story.id}`,
        p.narrator.token,
      ),
      200,
    );
    assert.equal(current.task.state, "obsolete");
    assert.equal(current.version, 2);
    assert.equal(current.revision.title, "本人校正的年代");
    assert.equal(current.revision.baseRevisionId, first.revision.id);
    assert.equal(current.revision.origin, "participant");
  } finally {
    release();
    await running;
    providerTransport = original;
  }
});
for (const status of ["not_applicable", "declined"]) {
  test(`${status} story content keeps successful transcription distinct from no speech`, async () => {
    const p = await bound(),
      i = await interview(p);
    await sealedClip(p, i.id);
    const original = providerTransport;
    providerTransport = async (input, init) => {
      if (!String(input).includes("deepseek.com")) return original(input, init);
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
                  status,
                  title: null,
                  theme: null,
                  paragraphs: [],
                  reviewItems: [],
                }),
              },
            },
          ],
        }),
      );
    };
    try {
      const audio = data(
        await request(
          "GET",
          `/v1/projects/${p.projectId}/tasks`,
          p.narrator.token,
        ),
        200,
      )[0];
      await app.get(ProductionTasks).run(audio.id);
      await app.get(ProductionTasks).run(audio.id);
      const story = data(
        await request(
          "POST",
          `/v1/projects/${p.projectId}/stories/organize`,
          p.narrator.token,
          { interviewId: i.id, baseVersion: 0 },
        ),
        202,
      );
      await app.get(ProductionTasks).run(story.task.id);
      const result = data(
        await request(
          "GET",
          `/v1/projects/${p.projectId}/stories/${story.id}`,
          p.narrator.token,
        ),
        200,
      );
      assert.equal(result.task.state, "no_content");
      assert.equal(result.task.errorCode, "NO_CONTENT");
      assert.equal(result.revision, null);
      assert.equal(result.task.sources[0].state, "succeeded");
      assert.ok(result.task.sources[0].durationMs > 0);
      assert.equal(
        result.task.sources[0].transcript.text,
        "那一年大概是八十年代。\n也可能更早。",
      );
      const task = data(
        await request(
          "GET",
          `/v1/projects/${p.projectId}/tasks/${story.task.id}`,
          p.narrator.token,
        ),
        200,
      );
      assert.equal(task.state, "no_content");
      assert.equal(task.nextAction, "continue");
      assert.equal(task.retryable, false);
      const overview = data(
        await request(
          "GET",
          `/v1/projects/${p.projectId}/overview`,
          p.narrator.token,
        ),
        200,
      );
      assert.equal(
        overview.nextStep,
        "已识别到文字，暂未形成故事，可继续补充讲述",
      );
    } finally {
      providerTransport = original;
    }
  });
}
test("no-speech audio stays in the complete manifest and cannot produce a story or a DeepSeek attempt", async () => {
  const p = await bound(),
    i = await interview(p);
  await sealedClip(p, i.id);
  const original = providerTransport,
    before = textRequests.length;
  providerTransport = async (input, init) =>
    String(input).endsWith("/query")
      ? new Response("{}", { headers: { "X-Api-Status-Code": "20000003" } })
      : original(input, init);
  try {
    const audio = data(
      await request(
        "GET",
        `/v1/projects/${p.projectId}/tasks`,
        p.narrator.token,
      ),
      200,
    )[0];
    await app.get(ProductionTasks).run(audio.id);
    await app.get(ProductionTasks).run(audio.id);
    const story = data(
      await request(
        "POST",
        `/v1/projects/${p.projectId}/stories/organize`,
        p.narrator.token,
        { interviewId: i.id, baseVersion: 0 },
      ),
      202,
    );
    await app.get(ProductionTasks).run(story.task.id);
    const result = data(
      await request(
        "GET",
        `/v1/projects/${p.projectId}/stories/${story.id}`,
        p.narrator.token,
      ),
      200,
    );
    assert.equal(result.task.state, "no_speech");
    assert.equal(result.revision, null);
    assert.equal(result.task.sources.length, 1);
    assert.equal(result.task.attempts.length, 0);
    assert.equal(textRequests.length, before);
  } finally {
    providerTransport = original;
  }
});
test("the story page context restores the existing generation for its interview without starting another intent", async () => {
  const p = await bound(),
    i = await interview(p);
  await sealedClip(p, i.id);
  const url = `/v1/projects/${p.projectId}/stories/context`,
    first = data(
      await request("POST", url, p.narrator.token, { interviewId: i.id }),
    );
  assert.equal(first.story, null);
  assert.equal(first.cloudSaved, true);
  const organized = data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/stories/organize`,
      p.narrator.token,
      { interviewId: i.id, baseVersion: 0 },
    ),
    202,
  );
  const restored = data(
    await request("POST", url, p.narrator.token, { interviewId: i.id }),
  );
  assert.equal(restored.story.task.id, organized.task.id);
  assert.equal(restored.story.usage.organizations, 1);
});

test("a preference change committed while a returning worker waits for the authorization lock makes its input obsolete", async () => {
  const p = await preparedStory(),
    original = providerTransport,
    plans = new ProjectPlans(config.databaseUrl);
  let releaseProvider!: () => void,
    arrived!: () => void,
    releaseEdit!: () => void,
    locked!: () => void,
    heldPid = 0;
  const providerGate = new Promise<void>((r) => (releaseProvider = r)),
    reached = new Promise<void>((r) => (arrived = r)),
    editGate = new Promise<void>((r) => (releaseEdit = r)),
    lockReached = new Promise<void>((r) => (locked = r));
  providerTransport = async (input, init) => {
    if (String(input).includes("deepseek.com")) {
      arrived();
      await providerGate;
    }
    return original(input, init);
  };
  const running = app.get(ProductionTasks).run(p.story.task.id);
  await reached;
  const editing = app
    .get(Participation)
    .withPlanAccess(
      p.projectId,
      `Bearer ${p.narrator.token}`,
      {},
      async (tx, actor) => {
        assert.equal(actor.method, "self_wechat");
        if (actor.method !== "self_wechat")
          throw new Error("real subject actor required");
        heldPid = (
          await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`
        )[0].pid;
        locked();
        await editGate;
        await plans.decidePreferences(
          {
            projectId: p.projectId,
            expectedVersion: 1,
            subjectId: actor.subjectId,
            operatorUserId: actor.userId,
            method: actor.method,
            blockedTopics: ["synthetic-topic"],
            questionStates: [],
          },
          tx,
        );
      },
    );
  try {
    await lockReached;
    releaseProvider();
    let waiting = false;
    for (let n = 0; n < 200; n++) {
      const rows = await db.$queryRaw<
        { count: number }[]
      >`SELECT count(*)::int AS count FROM pg_stat_activity WHERE wait_event_type='Lock' AND ${heldPid}::int=ANY(pg_blocking_pids(pid))`;
      if (rows[0].count) {
        waiting = true;
        break;
      }
    }
    assert.equal(
      waiting,
      true,
      "actual returning Worker must wait on the real authorized transaction",
    );
    releaseEdit();
    await editing;
    await running;
    const result = data(
      await request(
        "GET",
        `/v1/projects/${p.projectId}/stories/${p.story.id}`,
        p.narrator.token,
      ),
      200,
    );
    assert.equal(result.task.state, "obsolete");
    assert.equal(result.revision, null);
    assert.equal(result.task.attempts[0].observations[0].superseded, true);
  } finally {
    releaseProvider();
    releaseEdit();
    await editing;
    await running;
    providerTransport = original;
    await plans.close();
  }
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

async function assistedStory(sharing = true) {
  const p = await project(),
    collection = await assisted(p, "collection");
  await assisted(p, "ai");
  if (sharing) await assisted(p, "sharing");
  const body = { assistedSessionId: collection.id },
    audio = syntheticAudio();
  const interview = data(
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
    ),
    base = `/v1/projects/${p.projectId}/interviews/${interview.id}/clips`;
  const clip = data(
      await request("POST", base, p.buyer.token, {
        ...body,
        clientClipId: randomUUID(),
        bytes: audio.length,
        sha256: createHash("sha256").update(audio).digest("hex"),
      }),
    ),
    form = data(
      await request("POST", `${base}/${clip.id}/upload`, p.buyer.token, body),
    );
  assert.equal(
    (await formUpload(app, form, audio, {}, p.buyer.token)).statusCode,
    204,
  );
  data(await request("POST", `${base}/${clip.id}/seal`, p.buyer.token, body));
  const audioTask = data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/tasks/status`,
      p.buyer.token,
      { interviewId: interview.id, ...body },
    ),
  )[0];
  await app.get(ProductionTasks).run(audioTask.id);
  await app.get(ProductionTasks).run(audioTask.id);
  const story = data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/stories/organize`,
      p.buyer.token,
      { ...body, interviewId: interview.id, baseVersion: 0 },
    ),
    202,
  );
  return { ...p, collection, story };
}
test("an assisted operator retries a failed composition through the same source grant without a fabricated audio task", async () => {
  const p = await assistedStory(),
    original = providerTransport;
  providerTransport = async (input, init) => {
    const response = await original(input, init);
    if (!String(input).includes("deepseek.com")) return response;
    const data = await response.json();
    data.choices[0].message.content = "not JSON";
    return new Response(JSON.stringify(data));
  };
  try {
    await app.get(ProductionTasks).run(p.story.task.id);
  } finally {
    providerTransport = original;
  }
  const retry = data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/tasks/${p.story.task.id}/retry`,
      p.buyer.token,
      { assistedSessionId: p.collection.id },
    ),
    202,
  );
  assert.equal(retry.id, p.story.task.id);
  await app.get(ProductionTasks).run(p.story.task.id);
  const result = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/stories/${p.story.id}`,
      p.buyer.token,
    ),
    200,
  );
  assert.equal(result.version, 1);
  assert.equal(result.task.attempts.length, 2);
  assert.equal(result.usage.organizations, 1);
});
test("a changed preference before the first worker claim obsoletes the frozen composition without a provider attempt", async () => {
  const p = await preparedStory(),
    plans = new ProjectPlans(config.databaseUrl),
    before = textRequests.length;
  try {
    await app
      .get(Participation)
      .withPlanAccess(
        p.projectId,
        `Bearer ${p.narrator.token}`,
        {},
        async (tx, actor) => {
          if (actor.method !== "self_wechat")
            throw Error("real subject required");
          await plans.decidePreferences(
            {
              projectId: p.projectId,
              expectedVersion: 1,
              subjectId: actor.subjectId,
              operatorUserId: actor.userId,
              method: actor.method,
              blockedTopics: ["new-topic"],
              questionStates: [],
            },
            tx,
          );
        },
      );
  } finally {
    await plans.close();
  }
  await app.get(ProductionTasks).run(p.story.task.id);
  const result = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/stories/${p.story.id}`,
      p.narrator.token,
    ),
    200,
  );
  assert.equal(result.task.state, "obsolete");
  assert.equal(result.task.attempts.length, 0);
  assert.equal(textRequests.length, before);
});
test("one generation task can apply exactly one AI revision through the public version owner", async () => {
  const p = await preparedStory();
  await app.get(ProductionTasks).run(p.story.task.id);
  const first = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/stories/${p.story.id}`,
      p.narrator.token,
    ),
    200,
  );
  await assert.rejects(
    app
      .get(Participation)
      .withPlanAccess(
        p.projectId,
        `Bearer ${p.narrator.token}`,
        undefined,
        (tx) =>
          app.get(Stories).appendIn(tx, {
            projectId: p.projectId,
            storyId: p.story.id,
            expectedVersion: 1,
            generationTaskId: p.story.task.id,
            origin: "ai",
            content: {
              title: first.revision.title,
              theme: first.revision.theme,
              paragraphs: first.revision.paragraphs,
              reviewItems: first.revision.reviewItems,
            },
          }),
      ),
  );
  const current = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/stories/${p.story.id}`,
      p.narrator.token,
    ),
    200,
  );
  assert.equal(current.version, 1);
  assert.equal(current.currentRevisionId, first.currentRevisionId);
});
test("ASR submission counts exclude text attempts while the per-project monetary reservation includes both providers", async () => {
  const versionId = await packageWith((s) => {
      s.admission.d04.providerBudget.asrSubmissions.value = 2;
      s.admission.d04.providerBudget.costCap.value = 3;
    }),
    p = await bound(versionId),
    i = await interview(p);
  await sealedClip(p, i.id);
  let tasks = data(
    await request("GET", `/v1/projects/${p.projectId}/tasks`, p.narrator.token),
    200,
  );
  await app.get(ProductionTasks).run(tasks[0].id);
  await app.get(ProductionTasks).run(tasks[0].id);
  const first = data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/stories/organize`,
      p.narrator.token,
      { interviewId: i.id, baseVersion: 0 },
    ),
    202,
  );
  await app.get(ProductionTasks).run(first.task.id);
  await sealedClip(p, i.id);
  tasks = data(
    await request("GET", `/v1/projects/${p.projectId}/tasks`, p.narrator.token),
    200,
  );
  const next = tasks.find(
    (t: any) => t.kind === "transcribe_audio" && t.state === "queued",
  );
  assert.ok(next);
  await app.get(ProductionTasks).run(next.id);
  const accepted = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/tasks/${next.id}`,
      p.narrator.token,
    ),
    200,
  );
  assert.equal(accepted.state, "waiting_provider");
  await app.get(ProductionTasks).run(next.id);
  const regeneration = data(
      await request(
        "POST",
        `/v1/projects/${p.projectId}/stories/organize`,
        p.narrator.token,
        { interviewId: i.id, baseVersion: 1 },
      ),
      202,
    ),
    before = textRequests.length;
  await app.get(ProductionTasks).run(regeneration.task.id);
  const capped = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/stories/${first.id}`,
      p.narrator.token,
    ),
    200,
  );
  assert.equal(capped.task.state, "manual_review");
  assert.equal(capped.task.errorCode, "PROVIDER_BUDGET_EXHAUSTED");
  assert.equal(capped.version, 1);
  assert.equal(textRequests.length, before);
});
test("PostgreSQL keeps story revisions and source associations immutable and rejects a current revision from another story", async () => {
  const p = await preparedStory(),
    q = await preparedStory();
  await app.get(ProductionTasks).run(p.story.task.id);
  await app.get(ProductionTasks).run(q.story.task.id);
  const first = data(
      await request(
        "GET",
        `/v1/projects/${p.projectId}/stories/${p.story.id}`,
        p.narrator.token,
      ),
      200,
    ),
    other = data(
      await request(
        "GET",
        `/v1/projects/${q.projectId}/stories/${q.story.id}`,
        q.narrator.token,
      ),
      200,
    );
  await assert.rejects(
    db.storyRevision.update({
      where: { id: first.revision.id },
      data: { title: "覆写旧稿" },
    }),
    /immutable/,
  );
  await assert.rejects(
    db.storySource.update({
      where: {
        taskId_clipId: {
          taskId: p.story.task.id,
          clipId: first.task.sources[0].clipId,
        },
      },
      data: { question: { text: "替换来源" } },
    }),
    /immutable/,
  );
  await assert.rejects(
    db.story.update({
      where: { id: p.story.id },
      data: { currentRevisionId: other.revision.id, version: 1 },
    }),
    /Foreign key/,
  );
  const current = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/stories/${p.story.id}`,
      p.narrator.token,
    ),
    200,
  );
  assert.equal(current.revision.title, first.revision.title);
  assert.equal(current.revision.contentHash, first.revision.contentHash);
  assert.equal(current.currentRevisionId, first.revision.id);
});
test("an Outbox failure rolls back the complete story intent and the original user command safely recovers", async () => {
  const p = await bound(),
    i = await interview(p);
  await sealedClip(p, i.id);
  const key = randomUUID(),
    url = `/v1/projects/${p.projectId}/stories/organize`,
    body = { interviewId: i.id, baseVersion: 0 };
  await db.$executeRawUnsafe(
    "CREATE FUNCTION reject_story_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS(SELECT 1 FROM production_tasks WHERE id=NEW.task_id AND kind='compose_story') THEN RAISE EXCEPTION 'synthetic outbox fault'; END IF; RETURN NEW; END $$",
  );
  await db.$executeRawUnsafe(
    "CREATE TRIGGER reject_story_outbox BEFORE INSERT ON task_outbox FOR EACH ROW EXECUTE FUNCTION reject_story_outbox()",
  );
  try {
    const failed = await request("POST", url, p.narrator.token, body, key);
    assert.equal(failed.statusCode, 500);
  } finally {
    await db.$executeRawUnsafe(
      "DROP TRIGGER reject_story_outbox ON task_outbox",
    );
    await db.$executeRawUnsafe("DROP FUNCTION reject_story_outbox()");
  }
  const context = data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/stories/context`,
      p.narrator.token,
      { interviewId: i.id },
    ),
  );
  assert.equal(context.story, null);
  const recovered = data(
      await request("POST", url, p.narrator.token, body, key),
      202,
    ),
    replay = data(await request("POST", url, p.narrator.token, body, key), 202);
  assert.equal(replay.task.id, recovered.task.id);
  assert.equal(recovered.usage.organizations, 1);
  assert.equal(recovered.task.sources.length, 1);
});
test("withdrawal and renewed AI consent cannot revive a late generated draft", async () => {
  const p = await preparedStory(),
    original = providerTransport;
  let release!: () => void, arrived!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    reached = new Promise<void>((r) => (arrived = r));
  providerTransport = async (input, init) => {
    if (String(input).includes("deepseek.com")) {
      arrived();
      await gate;
    }
    return original(input, init);
  };
  const running = app.get(ProductionTasks).run(p.story.task.id);
  try {
    await reached;
    data((await choose(p, p.narrator.token, "ai", false)).response);
    data((await choose(p, p.narrator.token, "ai", true)).response);
    release();
    await running;
    const result = data(
      await request(
        "GET",
        `/v1/projects/${p.projectId}/stories/${p.story.id}`,
        p.narrator.token,
      ),
      200,
    );
    assert.equal(result.task.state, "obsolete");
    assert.equal(result.revision, null);
    assert.equal(result.task.attempts[0].usage.total_tokens, 30);
    assert.equal(result.task.attempts[0].observations[0].superseded, true);
  } finally {
    release();
    await running;
    providerTransport = original;
  }
});

test("collection-only assisted task responses expose progress while full text remains behind actual sharing authorization", async () => {
  const p = await assistedStory(false);
  await app.get(ProductionTasks).run(p.story.task.id);
  const context = data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/stories/context`,
      p.buyer.token,
      { interviewId: p.story.interviewId, assistedSessionId: p.collection.id },
    ),
  );
  assert.equal(context.story.task.state, "succeeded");
  assert.equal(context.story.revision, null);
  assert.equal(context.story.task.sources[0].transcript, null);
  assert.equal(context.story.task.sources[0].question, undefined);
  const forbidden = await request(
    "GET",
    `/v1/projects/${p.projectId}/stories/${p.story.id}`,
    p.buyer.token,
  );
  assert.equal(forbidden.statusCode, 403, forbidden.body);
  await assisted(p, "sharing");
  const readable = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/stories/${p.story.id}`,
      p.buyer.token,
    ),
    200,
  );
  assert.equal(readable.revision.title, "我记得的那一年");
});

test("concurrent organize commands serialize one frozen user quota with same-key replay and no duplicate story task", async () => {
  const versionId = await packageWith((s) => {
      s.admission.d04.userQuotas.storyOrganizations.value = 1;
    }),
    p = await bound(versionId),
    i = await interview(p);
  await sealedClip(p, i.id);
  const url = `/v1/projects/${p.projectId}/stories/organize`,
    body = { interviewId: i.id, baseVersion: 0 },
    key = randomUUID();
  const results = await Promise.all([
    request("POST", url, p.narrator.token, body, key),
    request("POST", url, p.narrator.token, body, key),
    request("POST", url, p.narrator.token, body, randomUUID()),
  ]);
  const accepted = results.filter((r) => r.statusCode === 202);
  assert.ok(accepted.length >= 1);
  assert.ok(results.some((r) => r.statusCode === 409));
  assert.equal(new Set(accepted.map((r) => data(r, 202).task.id)).size, 1);
  const context = data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/stories/context`,
      p.narrator.token,
      { interviewId: i.id },
    ),
  );
  assert.equal(context.story.usage.organizations, 1);
});
test("the shared task HTTP exposes the same sanitized attempt observations for a composition as its story status", async () => {
  const p = await preparedStory();
  await app.get(ProductionTasks).run(p.story.task.id);
  const task = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/tasks/${p.story.task.id}`,
      p.narrator.token,
    ),
    200,
  );
  assert.equal(task.kind, "compose_story");
  assert.equal(task.clipId, null);
  assert.equal(task.attempts[0].observations[0].state, "succeeded");
  assert.equal(task.attempts[0].usage.total_tokens, 30);
  assert.equal(task.originalTranscript, undefined);
});
test("a fresh command key cannot blindly resubmit the same frozen input whose DeepSeek outcome is unknown", async () => {
  const p = await preparedStory(),
    original = providerTransport;
  providerTransport = async (input, init) => {
    if (String(input).includes("deepseek.com"))
      throw Error("synthetic unknown");
    return original(input, init);
  };
  try {
    await app.get(ProductionTasks).run(p.story.task.id);
  } finally {
    providerTransport = original;
  }
  const duplicate = await request(
    "POST",
    `/v1/projects/${p.projectId}/stories/organize`,
    p.narrator.token,
    { interviewId: p.interviewId, baseVersion: 0 },
    randomUUID(),
  );
  assert.equal(duplicate.statusCode, 409, duplicate.body);
  const current = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/stories/${p.story.id}`,
      p.narrator.token,
    ),
    200,
  );
  assert.equal(current.task.id, p.story.task.id);
  assert.equal(current.usage.organizations, 1);
});

test("each frozen story source locates its original sealed audio through the existing authorized content route", async () => {
  const p = await preparedStory();
  await app.get(ProductionTasks).run(p.story.task.id);
  const current = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/stories/${p.story.id}`,
      p.narrator.token,
    ),
    200,
  );
  for (const source of current.revision.sourceManifest) {
    const content = await request(
      "GET",
      `/v1/projects/${p.projectId}/interviews/${source.interviewId}/clips/${source.intentId}/content`,
      p.narrator.token,
    );
    assert.equal(content.statusCode, 200, content.body);
    assert.equal(
      createHash("sha256").update(content.rawPayload).digest("hex"),
      source.inputHash,
    );
  }
});

test("the photo collection check returns only current authorization and leaves the frozen story untouched for narrator and assisted callers", async () => {
  const p = await preparedStory(),
    path = `/v1/projects/${p.projectId}/interviews/${p.interviewId}/collection-check`;
  assert.deepEqual(data(await request("POST", path, p.narrator.token, {})), {
    allowed: true,
  });
  assert.equal(
    (await request("POST", path, p.buyer.token, {})).statusCode,
    403,
  );
  const current = data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/stories/context`,
      p.narrator.token,
      { interviewId: p.interviewId },
    ),
  );
  assert.equal(current.story.task.id, p.story.task.id);
  assert.equal(current.story.task.state, "waiting_inputs");
  assert.equal(current.story.task.queuedAt, p.story.task.queuedAt);
  assert.equal(current.clipCount, 2);
  assert.equal(current.pendingCount, 0);
  const a = await assistedStory(false),
    assistedPath = `/v1/projects/${a.projectId}/interviews/${a.story.interviewId}/collection-check`;
  assert.deepEqual(
    data(
      await request("POST", assistedPath, a.buyer.token, {
        assistedSessionId: a.collection.id,
      }),
    ),
    { allowed: true },
  );
  assert.equal(
    (await request("POST", assistedPath, a.buyer.token, {})).statusCode,
    403,
  );
  data((await choose(p, p.narrator.token, "collection", false)).response);
  assert.equal(
    (await request("POST", path, p.narrator.token, {})).statusCode,
    403,
  );
});

test("a story relay endpoint change stops the frozen task before any provider submission", async () => {
  const p = await preparedStory();
  const before = textRequests.length;
  const deepseek = config.generation!.deepseek;
  const previous = deepseek.baseUrl;
  Object.assign(deepseek, { baseUrl: "https://cf.api.fan/v1" });
  try {
    await app.get(ProductionTasks).run(p.story.task.id);
    const current = data(
      await request(
        "GET",
        `/v1/projects/${p.projectId}/stories/${p.story.id}`,
        p.narrator.token,
      ),
      200,
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
