import { bootPrivacyFixture, closePrivacyFixture } from "./privacy-fixture";
import sharp from "sharp";
import { ProjectPlans } from "../src/projects/project-plans";
import { Stories } from "../src/stories/stories";
import { Participation } from "../src/identity/participation";
import { paymentAdmin } from "./payment-admin-fixture";
import { once } from "node:events";
import { ProductionTasks } from "../src/tasks/tasks";
import { startProductionWorker } from "../src/tasks/worker";
import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
const schema = `t19_${randomUUID().replaceAll("-", "")}`;
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
              content: JSON.stringify(
                source.currentQuestion
                  ? {
                      action: "ask",
                      question: "那段往事中，您还记得家门前的哪一个场景？",
                      intent: "scene",
                      sourceRefs: source.sourceRefs,
                      reasonCode: "SCENE_AVAILABLE",
                    }
                  : {
                      title: "我记得的那一年",
                      theme: "旧时光",
                      paragraphs: [
                        {
                          text: "我记得那一年大概是八十年代，也可能更早。",
                          sourceRefs: source.sourceRefs,
                        },
                      ],
                      reviewItems: ["确切年代待本人核对"],
                    },
              ),
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
    ...{
      photos: {
        mode: "synthetic-local" as const,
        placement: { widthMm: 100, heightMm: 150 },
      },
      recording: { mode: "synthetic-local" as const, storageRoot: root },
    },
    environment: "test",
    host: "127.0.0.1",
    port: 3430,
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

async function readyStory() {
  const p = await bound(),
    i = await interview(p);
  await sealedClip(p, i.id);
  await sealedClip(p, i.id);
  const tasks = data(
    await request("GET", `/v1/projects/${p.projectId}/tasks`, p.narrator.token),
    200,
  );
  for (const task of tasks) {
    await app.get(ProductionTasks).run(task.id);
    await app.get(ProductionTasks).run(task.id);
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
  for (let n = 0; n < 4; n++) await app.get(ProductionTasks).run(story.task.id);
  const current = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/stories/${story.id}`,
      p.narrator.token,
    ),
    200,
  );
  assert.equal(current.version, 1);
  data((await choose(p, p.narrator.token, "sharing", true)).response);
  return { ...p, interviewId: i.id, story: current };
}
async function readyFollowupStory() {
  const p = await readyStory(),
    base = `/v1/projects/${p.projectId}`,
    interview = data(
      await request(
        "GET",
        `${base}/interviews/${p.interviewId}`,
        p.narrator.token,
      ),
      200,
    ),
    path = `${base}/interviews/${p.interviewId}`,
    followup = data(
      await request("POST", `${path}/follow-up`, p.narrator.token, {
        clientRequestId: randomUUID(),
        actualQuestionId: interview.currentQuestion.id,
        expectedQuestionVersion: interview.questionVersion,
      }),
      202,
    );
  await app.get(ProductionTasks).run(followup.task.id);
  const result = data(
      await request("POST", `${path}/follow-up/status`, p.narrator.token, {}),
    ),
    displayed = data(
      await request("POST", `${path}/actual-question`, p.narrator.token, {
        clientQuestionId: followup.task.id,
        expectedVersion: interview.questionVersion,
        expectedActualQuestionId: interview.currentQuestion.id,
        expectedPlanRevision: result.planRevision,
        followupTaskId: followup.task.id,
      }),
    );
  assert.equal(displayed.currentQuestion.source.kind, "follow-up");
  const pin = data(
    await request("POST", `${path}/recording-start`, p.narrator.token, {
      actualQuestionId: displayed.currentQuestion.id,
      expectedQuestionVersion: displayed.questionVersion,
    }),
  );
  assert.equal(pin.actualQuestionId, displayed.currentQuestion.id);
  assert.equal(pin.questionVersion, 2);
  const audio = syntheticAudio(),
    clip = data(
      await request("POST", `${path}/clips`, p.narrator.token, {
        clientClipId: randomUUID(),
        actualQuestionId: pin.actualQuestionId,
        bytes: audio.length,
        sha256: createHash("sha256").update(audio).digest("hex"),
      }),
    ),
    form = data(
      await request(
        "POST",
        `${path}/clips/${clip.id}/upload`,
        p.narrator.token,
        {},
      ),
    );
  assert.equal(
    (await formUpload(app, form, audio, {}, p.narrator.token)).statusCode,
    204,
  );
  data(
    await request(
      "POST",
      `${path}/clips/${clip.id}/seal`,
      p.narrator.token,
      {},
    ),
  );
  const tasks = data(
    await request("GET", `${base}/tasks`, p.narrator.token),
    200,
  );
  for (const task of tasks.filter(
    (row: any) => row.kind === "transcribe_audio",
  )) {
    await app.get(ProductionTasks).run(task.id);
    await app.get(ProductionTasks).run(task.id);
  }
  const organized = data(
    await request("POST", `${base}/stories/organize`, p.narrator.token, {
      interviewId: p.interviewId,
      baseVersion: p.story.version,
    }),
    202,
  );
  for (let n = 0; n < 4; n++)
    await app.get(ProductionTasks).run(organized.task.id);
  const current = data(
    await request("GET", `${base}/stories/${p.story.id}`, p.narrator.token),
    200,
  );
  assert.equal(current.version, 2);
  assert.deepEqual(
    [
      ...new Set(
        current.revision.sourceManifest.map(
          (source: any) => source.actualQuestionId,
        ),
      ),
    ],
    [interview.actualQuestion.id, displayed.currentQuestion.id],
  );
  assert.equal(
    current.revision.sourceManifest[2].question.snapshot.text,
    displayed.currentQuestion.snapshot.text,
  );
  return { ...p, story: current, originalStory: p.story, displayed };
}
function correction(story: any) {
  return {
    baseRevisionId: story.revision.id,
    expectedVersion: story.version,
    title: story.revision.title,
    theme: story.revision.theme,
    paragraphs: [
      {
        text: "我记得那时大约是八十年代，后来才搬家。",
        sourceRefs: story.revision.paragraphs[0].sourceRefs,
      },
    ],
    reviewResolutions: [],
    notes: [],
  };
}
test("an authorized initiator corrects a real story by appending v2 without overwriting its original sources", async () => {
  const p = await readyStory(),
    original = structuredClone(p.story);
  const changed = data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/stories/${p.story.id}/revisions`,
      p.buyer.token,
      correction(p.story),
    ),
  );
  assert.equal(changed.version, 2);
  assert.notEqual(changed.revision.id, original.revision.id);
  assert.equal(changed.revision.origin, "participant");
  assert.equal(changed.revision.baseRevisionId, original.revision.id);
  assert.equal(
    changed.revision.paragraphs[0].text,
    "我记得那时大约是八十年代，后来才搬家。",
  );
  assert.deepEqual(
    changed.revision.sourceManifest,
    original.revision.sourceManifest,
  );
  assert.deepEqual(changed.task.sources, original.task.sources);
  const reread = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/stories/${p.story.id}`,
      p.narrator.token,
    ),
    200,
  );
  assert.equal(reread.revision.id, changed.revision.id);
});
function decision(story: any, allowInBook = false) {
  return {
    revisionId: story.revision.id,
    contentHash: story.revision.contentHash,
    expectedVersion: story.version,
    confirmed: true,
    allowInBook,
    ...notice(),
    evidenceRef: `synthetic:本人逐次确认-${randomUUID()}`,
  };
}
test("an unresolved review item blocks the narrator's exact-version confirmation", async () => {
  const p = await readyStory();
  const response = await request(
    "POST",
    `/v1/projects/${p.projectId}/stories/${p.story.id}/decisions`,
    p.narrator.token,
    decision(p.story),
  );
  assert.equal(response.statusCode, 409, response.body);
});
test("review resolutions append a revision and narrator fact confirmation can refuse book permission", async () => {
  const p = await readyStory();
  const corrected = data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/stories/${p.story.id}/revisions`,
      p.buyer.token,
      {
        ...correction(p.story),
        reviewResolutions: [
          {
            item: "确切年代待本人核对",
            reason: "本人说明只记得大约年代，保留模糊表述",
          },
        ],
      },
    ),
  );
  assert.deepEqual(corrected.revision.reviewItems, ["确切年代待本人核对"]);
  assert.equal(
    corrected.revision.reviewResolutions[0].reason,
    "本人说明只记得大约年代，保留模糊表述",
  );
  const confirmed = data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/stories/${p.story.id}/decisions`,
      p.narrator.token,
      decision(corrected, false),
    ),
  );
  assert.equal(confirmed.decision.confirmed, true);
  assert.equal(confirmed.decision.allowInBook, false);
  assert.equal(confirmed.decision.revisionId, corrected.revision.id);
  assert.equal(confirmed.decision.subjectId, p.subjectId);
  assert.equal(confirmed.decision.operatorUserId, p.narrator.id);
  const reread = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/stories/${p.story.id}`,
      p.buyer.token,
    ),
    200,
  );
  assert.equal(reread.decision.confirmed, true);
  assert.equal(reread.decision.allowInBook, false);
});
test("a single actual confirmation click retains an earlier explicit inclusion refusal across edits until the narrator changes it", async () => {
  const p = await readyStory(),
    url = `/v1/projects/${p.projectId}/stories/${p.story.id}`;
  const corrected = data(
    await request("POST", `${url}/revisions`, p.buyer.token, {
      ...correction(p.story),
      reviewResolutions: [
        { item: "确切年代待本人核对", reason: "本人要求保留大约年代" },
      ],
    }),
  );
  const refused = data(
    await request(
      "POST",
      `${url}/decisions`,
      p.narrator.token,
      decision(corrected, false),
    ),
  );
  assert.equal(refused.decision.allowInBook, false);
  const edited = data(
    await request("POST", `${url}/revisions`, p.buyer.token, {
      ...correction(corrected),
      reviewResolutions: corrected.revision.reviewResolutions,
    }),
  );
  const reading = data(await request("GET", url, p.narrator.token), 200);
  assert.equal(
    reading.decision,
    null,
    "editing cannot inherit content confirmation",
  );
  assert.equal(
    reading.confirmation.allowInBook,
    false,
    "simplified UI cannot silently widen a refusal",
  );
  const click = {
    ...decision(edited, false),
    evidenceRef: `synthetic:click:story-confirm:${randomUUID()}`,
  };
  const key = randomUUID();
  const confirmed = data(
    await request("POST", `${url}/decisions`, p.narrator.token, click, key),
  );
  assert.equal(confirmed.decision.confirmed, true);
  assert.equal(confirmed.decision.allowInBook, false);
  assert.equal(confirmed.decision.contentHash, edited.revision.contentHash);
  assert.equal(confirmed.decision.operatorUserId, p.narrator.id);
  assert.equal(confirmed.decision.evidenceRef, click.evidenceRef);
  assert.equal(
    data(
      await request("POST", `${url}/decisions`, p.narrator.token, click, key),
    ).decision.id,
    confirmed.decision.id,
  );
  const allowed = data(
    await request(
      "POST",
      `${url}/decisions`,
      p.narrator.token,
      decision(edited, true),
    ),
  );
  assert.equal(allowed.decision.allowInBook, true);
});

test("correction and decision retries keep one result but recheck current sharing before replay", async () => {
  const p = await readyStory(),
    url = `/v1/projects/${p.projectId}/stories/${p.story.id}`,
    key = randomUUID(),
    body = {
      ...correction(p.story),
      reviewResolutions: [
        { item: "确切年代待本人核对", reason: "本人要求保留大约年代" },
      ],
    };
  const edited = data(
    await request("POST", `${url}/revisions`, p.buyer.token, body, key),
  );
  const replay = data(
    await request("POST", `${url}/revisions`, p.buyer.token, body, key),
  );
  assert.equal(replay.revision.id, edited.revision.id);
  assert.equal(
    (
      await request(
        "POST",
        `${url}/revisions`,
        p.buyer.token,
        { ...body, title: "其他标题" },
        key,
      )
    ).statusCode,
    409,
  );
  const choice = decision(edited, true),
    choiceKey = randomUUID();
  const first = data(
    await request(
      "POST",
      `${url}/decisions`,
      p.narrator.token,
      choice,
      choiceKey,
    ),
  );
  const repeated = data(
    await request(
      "POST",
      `${url}/decisions`,
      p.narrator.token,
      choice,
      choiceKey,
    ),
  );
  assert.equal(repeated.decision.id, first.decision.id);
  data((await choose(p, p.narrator.token, "sharing", false)).response);
  assert.equal(
    (await request("POST", `${url}/revisions`, p.buyer.token, body, key))
      .statusCode,
    403,
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

test("assisted exact-version decisions require the current story purpose and fresh evidence on every action", async (t) => {
  const p = await assistedStory();
  for (let n = 0; n < 4; n++)
    await app.get(ProductionTasks).run(p.story.task.id);
  const story = data(
      await request(
        "GET",
        `/v1/projects/${p.projectId}/stories/${p.story.id}`,
        p.buyer.token,
      ),
      200,
    ),
    url = `/v1/projects/${p.projectId}/stories/${story.id}`;
  const edited = data(
    await request("POST", `${url}/revisions`, p.buyer.token, {
      ...correction(story),
      reviewResolutions: [
        { item: "确切年代待本人核对", reason: "本人要求保留大约年代" },
      ],
    }),
  );
  assert.equal(
    (await request("POST", `${url}/decisions`, p.buyer.token, decision(edited)))
      .statusCode,
    403,
  );
  assert.equal(
    (
      await request("POST", `${url}/decisions`, p.buyer.token, {
        ...decision(edited),
        assistedSessionId: p.collection.id,
      })
    ).statusCode,
    403,
  );
  const session = await assisted(p, "story_confirmation"),
    key = randomUUID(),
    choice = { ...decision(edited, false), assistedSessionId: session.id };
  const confirmed = data(
    await request("POST", `${url}/decisions`, p.buyer.token, choice, key),
  );
  assert.equal(confirmed.decision.subjectId, p.subjectId);
  assert.equal(confirmed.decision.operatorUserId, p.buyer.id);
  assert.equal(confirmed.decision.method, "assisted");
  assert.ok(confirmed.decision.assistedEvidenceId);
  const replay = data(
    await request("POST", `${url}/decisions`, p.buyer.token, choice, key),
  );
  assert.equal(replay.decision.id, confirmed.decision.id);
  assert.equal(
    (
      await request("POST", `${url}/decisions`, p.buyer.token, {
        ...choice,
        allowInBook: true,
      })
    ).statusCode,
    409,
    "one action cannot reuse previous action evidence",
  );
  const allowed = data(
    await request("POST", `${url}/decisions`, p.buyer.token, {
      ...decision(edited, true),
      assistedSessionId: session.id,
    }),
  );
  assert.equal(allowed.decision.allowInBook, true);
  t.mock.method(Date, "now", () => Date.parse(session.expiresAt));
  assert.equal(
    (await request("POST", `${url}/decisions`, p.buyer.token, choice, key))
      .statusCode,
    403,
    "same key still checks current story-purpose session",
  );
  t.mock.restoreAll();
});
test("participant notes and ordered original-audio selection form a new immutable hash without inheriting confirmation", async () => {
  const p = await readyStory(),
    url = `/v1/projects/${p.projectId}/stories/${p.story.id}`,
    noteId = randomUUID();
  const edited = data(
    await request("POST", `${url}/revisions`, p.buyer.token, {
      ...correction(p.story),
      reviewResolutions: [
        { item: "确切年代待本人核对", reason: "按本人说明保留大约年代" },
      ],
    }),
  );
  data(
    await request(
      "POST",
      `${url}/decisions`,
      p.narrator.token,
      decision(edited, true),
    ),
  );
  const changed = data(
    await request("POST", `${url}/revisions`, p.buyer.token, {
      ...correction(edited),
      paragraphs: [
        { text: "我只记得大约年代。", sourceRefs: [`note:${noteId}`] },
      ],
      notes: [
        { id: noteId, text: "本人校对说明：具体年份记不清，只保留大约年代。" },
      ],
      audioClipIds: [...p.story.revision.sourceManifest]
        .reverse()
        .map((s: any) => s.clipId),
      reviewResolutions: edited.revision.reviewResolutions,
    }),
  );
  assert.equal(changed.version, 3);
  assert.notEqual(changed.revision.contentHash, edited.revision.contentHash);
  assert.equal(changed.revision.notes[0].id, noteId);
  assert.deepEqual(
    changed.revision.audioManifest.map((s: any) => s.clipId),
    [...p.story.revision.sourceManifest].reverse().map((s: any) => s.clipId),
  );
  assert.equal(changed.decision, null);
  assert.equal(
    (
      await request(
        "POST",
        `${url}/decisions`,
        p.narrator.token,
        decision(edited, true),
      )
    ).statusCode,
    409,
  );
  const invalid = await request("POST", `${url}/revisions`, p.buyer.token, {
    ...correction(changed),
    audioClipIds: [randomUUID()],
  });
  assert.equal(invalid.statusCode, 409);
  const unknown = await request("POST", `${url}/revisions`, p.buyer.token, {
    ...correction(changed),
    reviewResolutions: [
      { item: "not a review item", reason: "pretend handled" },
    ],
  });
  assert.equal(unknown.statusCode, 400);
});

async function storyPhoto(
  p: Awaited<ReturnType<typeof readyStory>>,
  caption: string,
) {
  const bytes = await sharp({
      create: { width: 120, height: 80, channels: 3, background: "#e54334" },
    })
      .jpeg()
      .toBuffer(),
    base = `/v1/projects/${p.projectId}/interviews/${p.interviewId}/photos`;
  const photo = data(
    await request("POST", base, p.narrator.token, {
      clientPhotoId: randomUUID(),
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }),
  );
  const form = data(
    await request("POST", `${base}/${photo.id}/upload`, p.narrator.token, {}),
  );
  assert.equal(
    (await formUpload(app, form, bytes, {}, p.narrator.token)).statusCode,
    204,
  );
  data(await request("POST", `${base}/${photo.id}/seal`, p.narrator.token, {}));
  const collection = data(await request("GET", base, p.narrator.token), 200);
  return data(
    await request("POST", `${base}/materials`, p.narrator.token, {
      expectedRevision: collection.snapshot?.revision ?? 0,
      entries: [{ photoId: photo.id, caption }],
    }),
  );
}
test("exact photo captions and order are revision content and foreign interview snapshots are rejected", async () => {
  const p = await readyStory(),
    url = `/v1/projects/${p.projectId}/stories/${p.story.id}`,
    photos = await storyPhoto(p, "当年旧屋"),
    other = await readyStory(),
    foreign = await storyPhoto(other, "别人的照片");
  const first = data(
    await request("POST", `${url}/revisions`, p.buyer.token, {
      ...correction(p.story),
      photoSnapshotId: photos.id,
      reviewResolutions: [
        { item: "确切年代待本人核对", reason: "本人要求保留模糊年代" },
      ],
    }),
  );
  assert.equal(first.revision.photoSnapshot.hash, photos.hash);
  assert.equal(first.revision.photoSnapshot.entries[0].caption, "当年旧屋");
  data(
    await request(
      "POST",
      `${url}/decisions`,
      p.narrator.token,
      decision(first, true),
    ),
  );
  const base = `/v1/projects/${p.projectId}/interviews/${p.interviewId}/photos`;
  const updated = data(
    await request("POST", `${base}/materials`, p.narrator.token, {
      expectedRevision: photos.revision,
      entries: [
        {
          photoId: photos.entries[0].photoId,
          caption: "本人补充：并非出生的房子",
        },
      ],
    }),
  );
  const next = data(
    await request("POST", `${url}/revisions`, p.buyer.token, {
      ...correction(first),
      photoSnapshotId: updated.id,
      reviewResolutions: first.revision.reviewResolutions,
    }),
  );
  assert.notEqual(next.revision.contentHash, first.revision.contentHash);
  assert.equal(next.decision, null);
  assert.equal(
    next.revision.photoSnapshot.entries[0].caption,
    "本人补充：并非出生的房子",
  );
  assert.equal(
    (
      await request("POST", `${url}/revisions`, p.buyer.token, {
        ...correction(next),
        photoSnapshotId: foreign.id,
      })
    ).statusCode,
    404,
  );
});
test("project withdrawal serializes with edits and old-epoch decisions cannot become effective again", async () => {
  const p = await readyStory(),
    url = `/v1/projects/${p.projectId}/stories/${p.story.id}`;
  const edited = data(
    await request("POST", `${url}/revisions`, p.buyer.token, {
      ...correction(p.story),
      reviewResolutions: [
        { item: "确切年代待本人核对", reason: "本人确认保留模糊表述" },
      ],
    }),
  );
  const decisions = await Promise.all([
    request(
      "POST",
      `${url}/decisions`,
      p.narrator.token,
      decision(edited, true),
    ),
    request(
      "POST",
      `${url}/decisions`,
      p.narrator.token,
      decision(edited, false),
    ),
  ]);
  assert.equal(
    decisions.every((r) => r.statusCode === 201),
    true,
  );
  data((await choose(p, p.narrator.token, "sharing", false)).response);
  data((await choose(p, p.narrator.token, "sharing", true)).response);
  const reread = data(await request("GET", url, p.narrator.token), 200);
  assert.equal(
    reread.decision,
    null,
    "previous access epoch is historical evidence only",
  );
  const edits = await Promise.all([
    request("POST", `${url}/revisions`, p.buyer.token, correction(edited)),
    request("POST", `${url}/revisions`, p.buyer.token, {
      ...correction(edited),
      title: "另一个校对",
    }),
  ]);
  assert.deepEqual(edits.map((r) => r.statusCode).sort(), [201, 409]);
  const rev = data(await request("GET", url, p.narrator.token), 200);
  assert.equal(rev.version, 3);
  assert.equal(
    (
      await request(
        "POST",
        `${url}/decisions`,
        p.narrator.token,
        decision(edited),
      )
    ).statusCode,
    409,
  );
});
test("project overview derives real task and version decisions and renaming never rewrites the sold order", async () => {
  const p = await readyStory(),
    base = `/v1/projects/${p.projectId}`;
  const first = data(
    await request("GET", `${base}/overview`, p.buyer.token),
    200,
  );
  assert.equal(first.bookTitle, "私人标题不能泄露");
  assert.equal(first.summary.pending, 1);
  assert.equal(first.summary.confirmed, 0);
  assert.equal(first.stories[0].revision.id, p.story.revision.id);
  assert.ok(first.interviews.some((i: any) => i.id === p.interviewId));
  const key = randomUUID(),
    payload = {
      expectedVersion: first.metadataVersion,
      bookTitle: "我们留下的时光",
    };
  const renamed = data(
    await request("POST", `${base}/metadata`, p.buyer.token, payload, key),
  );
  assert.equal(renamed.bookTitle, "我们留下的时光");
  assert.equal(
    data(await request("POST", `${base}/metadata`, p.buyer.token, payload, key))
      .metadataVersion,
    renamed.metadataVersion,
  );
  const sold = data(
    await request("GET", `/v1/orders/${p.orderId}`, p.buyer.token),
    200,
  );
  assert.equal(sold.bookTitle, "私人标题不能泄露");
  assert.equal(
    (await request("POST", `${base}/metadata`, p.buyer.token, payload))
      .statusCode,
    409,
  );
  const outsider = await login();
  assert.equal(
    (await request("GET", `${base}/overview`, outsider.token)).statusCode,
    403,
  );
});
test("project overview reports the real optional follow-up task without changing story confirmation counts", async () => {
  const p = await readyStory(),
    base = `/v1/projects/${p.projectId}`,
    interview = data(
      await request(
        "GET",
        `${base}/interviews/${p.interviewId}`,
        p.narrator.token,
      ),
      200,
    ),
    followup = data(
      await request(
        "POST",
        `${base}/interviews/${p.interviewId}/follow-up`,
        p.narrator.token,
        {
          clientRequestId: randomUUID(),
          actualQuestionId: interview.currentQuestion.id,
          expectedQuestionVersion: interview.questionVersion,
        },
      ),
      202,
    );
  assert.equal(followup.task.kind, "ask_followup");
  const overview = () => request("GET", `${base}/overview`, p.narrator.token);
  const queued = data(await overview(), 200),
    task = queued.tasks?.find((item: any) => item.id === followup.task.id);
  assert.equal(task?.kind, "ask_followup");
  assert.equal(task.state, "queued");
  assert.equal(task.nextAction, "leave_and_return");
  assert.equal(queued.summary.pending, 1);
  assert.equal(queued.summary.confirmed, 0);
  assert.ok(queued.tasks.every((item: any) => !item.originalTranscript));
  await app.get(ProductionTasks).run(followup.task.id);
  const complete = data(await overview(), 200),
    completed = complete.tasks.find((item: any) => item.id === task.id);
  assert.equal(completed.state, "succeeded");
  assert.equal(completed.kind, "ask_followup");
  assert.equal(complete.summary.confirmed, 0);
  assert.equal(complete.summary.included, 0);
  assert.equal(
    complete.stories[0].revision.contentHash,
    p.story.revision.contentHash,
  );
});
test("a real follow-up answer keeps its question source through correction and the narrator's exact-version decision", async () => {
  const p = await readyFollowupStory(),
    url = `/v1/projects/${p.projectId}/stories/${p.story.id}`,
    edited = data(
      await request("POST", `${url}/revisions`, p.buyer.token, {
        ...correction(p.story),
        reviewResolutions: p.story.revision.reviewItems.map((item: string) => ({
          item,
          reason: "本人保留大约年代，核对追问来源",
        })),
      }),
    );
  assert.equal(edited.version, 3);
  assert.deepEqual(
    edited.revision.sourceManifest,
    p.story.revision.sourceManifest,
  );
  assert.equal(edited.decision, null);
  const confirmed = data(
    await request(
      "POST",
      `${url}/decisions`,
      p.narrator.token,
      decision(edited),
    ),
  );
  assert.equal(confirmed.decision.revisionId, edited.revision.id);
  assert.equal(confirmed.decision.contentHash, edited.revision.contentHash);
  assert.equal(confirmed.decision.confirmed, true);
  assert.equal(confirmed.decision.allowInBook, false);
  const original = await db.storyRevision.findUniqueOrThrow({
    where: { id: p.originalStory.revision.id },
  });
  assert.equal(original.contentHash, p.originalStory.revision.contentHash);
});
test("Care correction needs a narrator's expiring story grant and verified case, never care permission alone", async (t) => {
  const p = await readyStory(),
    headers = await paymentAdmin(config, app, ["care:write"]),
    url = `/v1/projects/${p.projectId}/stories/${p.story.id}`;
  const adminRequest = (
    method: "GET" | "POST",
    path: string,
    payload?: object,
  ) =>
    app.inject({
      method,
      url: path,
      headers: {
        ...(method === "GET" ? { cookie: headers.cookie } : headers),
        "idempotency-key": randomUUID(),
      },
      ...(payload ? { payload } : {}),
    });
  const grant = data(
    await request("POST", `${url}/care-access`, p.narrator.token, {
      revisionId: p.story.revision.id,
      contentHash: p.story.revision.contentHash,
      expectedVersion: p.story.version,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      ...notice(),
      evidenceRef: `synthetic:本人同意当次校对-${randomUUID()}`,
    }),
  );
  const path = `/v1/admin/care-requests/${grant.caseId}/story`;
  assert.equal((await adminRequest("GET", path)).statusCode, 403);
  const current = await state(p, p.narrator.token);
  data(
    await adminRequest(
      "POST",
      `/v1/admin/care-requests/${grant.caseId}/verify`,
      {
        ...notice(),
        evidenceRef: `synthetic:客服核验本次校对-${randomUUID()}`,
        expectedBindingVersion: current.bindingVersion,
        expectedAccessEpoch: current.accessEpoch,
      },
    ),
  );
  const readable = data(await adminRequest("GET", path), 200);
  assert.equal(readable.id, p.story.id);
  const corrected = data(
    await adminRequest("POST", `${path}/revisions`, correction(readable)),
  );
  assert.equal(corrected.revision.origin, "participant");
  assert.equal(corrected.revision.operatorRealm, "admin");
  assert.equal(corrected.decision, null);
  t.mock.method(Date, "now", () => Date.parse(grant.expiresAt));
  assert.equal((await adminRequest("GET", path)).statusCode, 403);
  t.mock.restoreAll();
});
test("malformed participant explanations cannot produce server errors or change a story", async () => {
  const p = await readyStory(),
    url = `/v1/projects/${p.projectId}/stories/${p.story.id}`;
  assert.equal(
    (
      await request("POST", `${url}/revisions`, p.buyer.token, {
        ...correction(p.story),
        notes: [null],
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await request("POST", `${url}/revisions`, p.buyer.token, {
        ...correction(p.story),
        reviewResolutions: [null],
      })
    ).statusCode,
    400,
  );
  assert.equal(data(await request("GET", url, p.buyer.token), 200).version, 1);
});
test("PostgreSQL rejects confirmation evidence from a different story and subject", async () => {
  const p = await readyStory(),
    q = await readyStory();
  const edit = async (p: any) =>
    data(
      await request(
        "POST",
        `/v1/projects/${p.projectId}/stories/${p.story.id}/revisions`,
        p.buyer.token,
        {
          ...correction(p.story),
          reviewResolutions: [
            { item: "确切年代待本人核对", reason: "本人保留模糊年代" },
          ],
        },
      ),
    );
  const current = await edit(p),
    other = await edit(q),
    session = await assisted(q, "story_confirmation");
  const own = data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/stories/${p.story.id}/decisions`,
      p.narrator.token,
      decision(current, true),
    ),
  );
  const theirs = data(
    await request(
      "POST",
      `/v1/projects/${q.projectId}/stories/${q.story.id}/decisions`,
      q.buyer.token,
      { ...decision(other), assistedSessionId: session.id },
    ),
  );
  const { id, sequence, createdAt, ...original } =
    await db.storyDecision.findUniqueOrThrow({
      where: { id: own.decision.id },
    });
  await assert.rejects(
    db.storyDecision.create({
      data: {
        ...original,
        id: randomUUID(),
        idempotencyKey: randomUUID(),
        evidenceRef: `synthetic:cross-project-${randomUUID()}`,
        method: "assisted",
        assistedEvidenceId: theirs.decision.assistedEvidenceId,
      },
    }),
    (e: any) => e.code === "P2003",
  );
});
test("late correction retries identify the originally applied revision while returning current state", async () => {
  const p = await readyStory(),
    url = `/v1/projects/${p.projectId}/stories/${p.story.id}`,
    body = correction(p.story),
    key = randomUUID();
  const first = data(
    await request("POST", `${url}/revisions`, p.buyer.token, body, key),
  );
  assert.equal(first.appliedRevision.id, first.revision.id);
  const latest = data(
    await request("POST", `${url}/revisions`, p.buyer.token, {
      ...correction(first),
      title: "第二次独立校对",
    }),
  );
  const replay = data(
    await request("POST", `${url}/revisions`, p.buyer.token, body, key),
  );
  assert.equal(replay.appliedRevision.id, first.revision.id);
  assert.equal(replay.appliedRevision.contentHash, first.revision.contentHash);
  assert.equal(replay.revision.id, latest.revision.id);
  assert.equal(replay.version, 3);
});
test("a rejected assisted action rolls back its per-action evidence before a valid retry", async () => {
  const p = await readyStory(),
    url = `/v1/projects/${p.projectId}/stories/${p.story.id}`,
    edited = data(
      await request("POST", `${url}/revisions`, p.buyer.token, {
        ...correction(p.story),
        reviewResolutions: [
          { item: "确切年代待本人核对", reason: "本人保留不确定年代" },
        ],
      }),
    ),
    session = await assisted(p, "story_confirmation"),
    key = randomUUID(),
    choice = { ...decision(edited, true), assistedSessionId: session.id };
  assert.equal(
    (
      await request(
        "POST",
        `${url}/decisions`,
        p.buyer.token,
        { ...choice, confirmed: false },
        key,
      )
    ).statusCode,
    400,
  );
  const accepted = data(
    await request("POST", `${url}/decisions`, p.buyer.token, choice, key),
  );
  assert.equal(accepted.decision.confirmed, true);
  assert.ok(accepted.decision.assistedEvidenceId);
});
test("Care access and story decisions cannot consume each other's assisted action evidence", async (t) => {
  for (const firstAction of ["care-access", "decisions"]) {
    await t.test(
      `${firstAction} evidence only replays that same action`,
      async () => {
        const p = await assistedStory();
        for (let n = 0; n < 4; n++)
          await app.get(ProductionTasks).run(p.story.task.id);
        const url = `/v1/projects/${p.projectId}/stories/${p.story.id}`,
          current = data(await request("GET", url, p.buyer.token), 200),
          edited = data(
            await request("POST", `${url}/revisions`, p.buyer.token, {
              ...correction(current),
              reviewResolutions: [
                { item: "确切年代待本人核对", reason: "本人保留不确定年代" },
              ],
            }),
          ),
          session = await assisted(p, "story_confirmation"),
          key = randomUUID(),
          choice = { ...decision(edited), assistedSessionId: session.id },
          care = {
            revisionId: choice.revisionId,
            contentHash: choice.contentHash,
            expectedVersion: choice.expectedVersion,
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
            noticeVersion: choice.noticeVersion,
            evidenceRef: choice.evidenceRef,
            assistedSessionId: session.id,
          },
          secondAction =
            firstAction === "care-access" ? "decisions" : "care-access",
          body = (action: string) => (action === "care-access" ? care : choice),
          first = data(
            await request(
              "POST",
              `${url}/${firstAction}`,
              p.buyer.token,
              body(firstAction),
              key,
            ),
          );
        const replay = data(
          await request(
            "POST",
            `${url}/${firstAction}`,
            p.buyer.token,
            body(firstAction),
            key,
          ),
        );
        assert.equal(
          firstAction === "care-access" ? replay.caseId : replay.decision.id,
          firstAction === "care-access" ? first.caseId : first.decision.id,
        );
        assert.equal(
          (
            await request(
              "POST",
              `${url}/${secondAction}`,
              p.buyer.token,
              body(secondAction),
              key,
            )
          ).statusCode,
          409,
          "a Care authorization is not a fact confirmation, in either direction",
        );
        assert.equal(
          (
            await request(
              "POST",
              `${url}/${secondAction}`,
              p.buyer.token,
              body(secondAction),
            )
          ).statusCode,
          409,
          "a new command still requires fresh action evidence",
        );
        assert.equal(
          await db.assistedVersionEvidence.count({
            where: { projectId: p.projectId, evidenceRef: choice.evidenceRef },
          }),
          1,
        );
        const fresh = {
          ...body(secondAction),
          evidenceRef: `synthetic:另一次本人明确选择-${randomUUID()}`,
        };
        data(
          await request("POST", `${url}/${secondAction}`, p.buyer.token, fresh),
        );
        data(
          await request(
            "POST",
            `${url}/${firstAction}`,
            p.buyer.token,
            body(firstAction),
            key,
          ),
        );
        t.mock.method(Date, "now", () => Date.parse(session.expiresAt));
        try {
          assert.equal(
            (
              await request(
                "POST",
                `${url}/${firstAction}`,
                p.buyer.token,
                body(firstAction),
                key,
              )
            ).statusCode,
            403,
            "legitimate replay still checks the exact current session expiry",
          );
        } finally {
          t.mock.restoreAll();
        }
      },
    );
  }
});
test("collection-only assistance remains available when the private project overview is forbidden", async () => {
  const p = await project(),
    collection = await assisted(p, "collection"),
    base = `/v1/projects/${p.projectId}`;
  assert.equal(
    (await request("GET", `${base}/overview`, p.buyer.token)).statusCode,
    403,
  );
  const context = data(
    await request("POST", `${base}/interviews/context`, p.buyer.token, {
      assistedSessionId: collection.id,
    }),
  );
  assert.deepEqual(context.interviews, []);
  assert.equal(context.canRecord, true);
  const started = data(
    await request("POST", `${base}/interviews`, p.buyer.token, {
      clientInterviewId: randomUUID(),
      expectedPlanRevision: context.plan.revision,
      starterKind: "free-narration",
      assistedSessionId: collection.id,
    }),
  );
  const resume = data(
    await request(
      "POST",
      `${base}/interviews/${started.id}/resume`,
      p.buyer.token,
      { assistedSessionId: collection.id },
    ),
  );
  assert.equal(resume.id, started.id);
});

test("OpenAPI describes structured correction paragraphs and independent exact-version decisions", async () => {
  const document = createOpenApiDocument(app);
  assert.ok(document.paths["/v1/projects/{id}/overview"]);
  assert.ok(document.paths["/v1/projects/{id}/stories/{storyId}/revisions"]);
  assert.ok(document.paths["/v1/projects/{id}/stories/{storyId}/decisions"]);
  const schemas = document.components!.schemas! as any;
  assert.equal(
    schemas.ReviseStoryDto.properties.paragraphs.items.$ref,
    "#/components/schemas/StoryParagraphDto",
  );
  for (const name of [
    "revisionId",
    "contentHash",
    "expectedVersion",
    "confirmed",
    "allowInBook",
    "evidenceRef",
  ])
    assert.ok(schemas.StoryDecisionDto.required.includes(name));
  await writeFile(
    "/tmp/timenook-t19-openapi.json",
    JSON.stringify(document, null, 2),
  );
});

after(async () => {
  await closePrivacyFixture(config);
});
