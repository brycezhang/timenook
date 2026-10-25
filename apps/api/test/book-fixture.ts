import sharp from "sharp";
import { ProductionTasks } from "../src/tasks/tasks";
import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import { LocalProbeObjects } from "../src/probe/local-objects";
import { createApplication } from "../src/application";
import type { ApiConfig } from "../src/config";
import { paymentConfig, paymentFetch, paid, callback } from "./payment-fixture";
const schema = `t20_${randomUUID().replaceAll("-", "")}`;
export let config: ApiConfig;
export let root: string;
export let app: Awaited<ReturnType<typeof createApplication>>;
export let db: PrismaClient;
let fixtureOptions: Parameters<typeof createApplication>[1];
const packageId = randomUUID();
const providerTransport: typeof fetch = async (input, init) => {
  if (String(input).includes("deepseek.com")) {
    const payload = JSON.parse(String(init?.body));
    const source = JSON.parse(payload.messages[1].content);
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
export async function startBookFixture() {
  assert.ok(process.env.DATABASE_URL);
  assert.ok(process.env.REDIS_URL);
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set("schema", schema);
  root = await mkdtemp(join(tmpdir(), "timenook-book-"));
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
  config.books = {
    mode: "synthetic-local",
    storageRoot: root + "/books",
    entryBaseUrl: "https://example.invalid/timenook/audio/",
    specificationVersion: "synthetic-t04-v1",
    provenanceVersion: "synthetic-d08-v1",
  };
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
      return {
        url: `https://synthetic.oss-cn-shanghai.aliyuncs.com/${key}?signature=private`,
        expiresAt: new Date(Date.now() + 120000).toISOString(),
        credentialsExpireAt: new Date(Date.now() + 180000).toISOString(),
      };
    }
  }
  const aiFetch: typeof fetch = (...args) => providerTransport(...args);
  fixtureOptions = {
    wechatFetch,
    paymentFetch,
    aiFetch,
    recordingObjects: new Objects(root),
  };
  app = await createApplication(config, fixtureOptions);
}
export async function stopBookFixture() {
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
}

export async function login(who = randomUUID(), target = app) {
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
export function request(
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
export function data(
  r: { statusCode: number; body: string; json(): any },
  status = 201,
) {
  assert.equal(r.statusCode, status, r.body);
  assert.equal(r.json().error, undefined);
  return r.json().data;
}
export async function project(versionId = packageId) {
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
export async function bound(versionId = packageId) {
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
export async function state(p: { projectId: string }, token: string) {
  return data(
    await request("GET", `/v1/projects/${p.projectId}/participation`, token),
    200,
  );
}
export async function choose(
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

export function formUpload(
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

export function syntheticAudio(seconds: 1 | 0.5 = 1) {
  return readFileSync(
    seconds === 1
      ? "test/fixtures/synthetic-1s.mp3"
      : "test/fixtures/synthetic-576ms.mp3",
  );
}
export async function interview(
  p: Awaited<ReturnType<typeof bound>>,
  ai = true,
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
        starterKind: "free-narration",
      },
    ),
  );
}

export async function sealedClip(
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

export async function readyStory(existing?: Awaited<ReturnType<typeof bound>>) {
  const p = existing ?? (await bound()),
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

export async function storyPhoto(
  p: Awaited<ReturnType<typeof readyStory>>,
  caption: string,
  pixels = { width: 120, height: 80 },
) {
  const bytes = await sharp({
      create: { ...pixels, channels: 3, background: "#e54334" },
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

export async function restartBookApplication() {
  await app.close();
  app = await createApplication(config, fixtureOptions);
  return app;
}
