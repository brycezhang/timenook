import { withWechatProfile, phoneLogin } from "./wechat-profile-fixture";
import { TERMS_VERSION } from "../src/identity/project-members";
import { bootPrivacyFixture, closePrivacyFixture } from "./privacy-fixture";
import sharp from "sharp";
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
import { startProductionWorker } from "../src/tasks/worker";
import { Deletions } from "../src/care/deletions";
const schema = `t16_${randomUUID().replaceAll("-", "")}`;
let config: ApiConfig;
let root: string;
let app: Awaited<ReturnType<typeof createApplication>>;
let db: PrismaClient;
const packageId = randomUUID();
const acceptedRequests = new Set<string>();
const providerCalls: { action: string; id: string }[] = [];
const aiFetch: typeof fetch = async (input, init) => {
  const action = String(input).endsWith("/submit") ? "submit" : "query",
    id = new Headers(init?.headers).get("X-Api-Request-Id")!;
  providerCalls.push({ action, id });
  if (action === "submit") acceptedRequests.add(id);
  if (!acceptedRequests.has(id))
    return new Response("{}", {
      status: 404,
      headers: { "X-Api-Status-Code": "45000001" },
    });
  return new Response(
    action === "submit"
      ? "{}"
      : JSON.stringify({
          task_id: id,
          result: { text: "照片里是那年的旧屋。" },
        }),
    { headers: { "X-Api-Status-Code": "20000000" } },
  );
};
let photoReadGate: ((key: string) => Promise<void>) | undefined;
class AsrObjects extends LocalProbeObjects {
  async read(key: string) {
    if (key.startsWith("photos/staging/")) await photoReadGate?.(key);
    return super.read(key);
  }
  async asrSource(key: string, _seconds: number) {
    await this.read(key);
    return {
      url: `https://synthetic.oss-cn-shanghai.aliyuncs.com/${key}?synthetic=private`,
      expiresAt: new Date(Date.now() + 120000).toISOString(),
      credentialsExpireAt: new Date(Date.now() + 180000).toISOString(),
    };
  }
}
const fixtureOptions = () => ({
  wechatFetch: withWechatProfile(wechatFetch),
  paymentFetch,
  aiFetch,
  recordingObjects: new AsrObjects(root),
});
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
  root = await mkdtemp(join(tmpdir(), "timenook-photos-"));
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
    port: 3426,
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
    transcription: {
      mode: "synthetic-local",
      configVersion: "synthetic-t16-combined",
      doubao: {
        apiKey: "synthetic-t16-key",
        resourceId: "synthetic-t16-resource",
        fetchWindowSeconds: 60,
      },
      pollIntervalMs: 0,
      submissionReservationFen: 1,
      deadlineMs: 600000,
    },
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
  app = await createApplication(config, fixtureOptions());
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
    payload: { ...phoneLogin(), code: `${who}:${randomUUID()}` },
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
      purchaseKind: "gift",
      packageVersionId: versionId,
      recipient: { typeCode: "mentor", relationshipLabel: "恩师" },
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
async function joinedProject(versionId = packageId) {
  const p = await project(versionId),
    narrator = await login();
  const invite = data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/invitations`,
      p.buyer.token,
    ),
  );
  data(
    await request(
      "POST",
      `/v1/invitations/${invite.token}/accept`,
      narrator.token,
      { relationship: "家人", termsVersion: TERMS_VERSION },
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

async function interview() {
  const p = await joinedProject();

  const plan = data(
    await request("GET", `/v1/projects/${p.projectId}/plan`, p.narrator.token),
    200,
  );
  const i = data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/interviews`,
      p.narrator.token,
      {
        clientInterviewId: randomUUID(),
        expectedPlanRevision: plan.revision,
        starterKind: "photo",
      },
    ),
  );
  return {
    ...p,
    interview: i,
    base: `/v1/projects/${p.projectId}/photos`,
    materials: `/v1/projects/${p.projectId}/interviews/${i.id}/photo-materials`,
  };
}
test("a project with no interviews can reserve photos and list its own assets", async () => {
  const p = await joinedProject();
  const base = `/v1/projects/${p.projectId}/photos`;
  const empty = data(await request("GET", base, p.narrator.token), 200);
  assert.deepEqual(empty.photos, []);
  const body = {
    clientPhotoId: randomUUID(),
    bytes: 100,
    sha256: "a".repeat(64),
  };
  const photo = data(await request("POST", base, p.narrator.token, body));
  assert.equal(photo.projectId, p.projectId);
  assert.equal("interviewId" in photo, false);
  assert.equal("actualQuestionId" in photo, false);
  const collection = data(await request("GET", base, p.buyer.token), 200);
  assert.equal(collection.photos[0].id, photo.id);
  assert.deepEqual(collection.usage, { reservedCount: 1, consumedCount: 0 });
  assert.equal(
    (await request("GET", base, (await login()).token)).statusCode,
    403,
  );
});

test("a currently authorized narrator reserves one stable photo without requiring an interview", async () => {
  const p = await interview();
  const body = {
    clientPhotoId: randomUUID(),
    bytes: 100,
    sha256: "a".repeat(64),
  };
  assert.equal(
    (await request("POST", p.base, undefined, body)).statusCode,
    401,
  );
  assert.equal(
    (await request("POST", p.base, (await login()).token, body)).statusCode,
    403,
  );
  const created = data(await request("POST", p.base, p.narrator.token, body));
  assert.equal(created.projectId, p.projectId);
  assert.equal("interviewId" in created, false);
  assert.equal(created.state, "pending");
  assert.equal(created.clientPhotoId, body.clientPhotoId);
  const replay = data(await request("POST", p.base, p.narrator.token, body));
  assert.equal(replay.id, created.id);
  assert.equal(
    (await request("POST", p.base, p.narrator.token, { ...body, bytes: 101 }))
      .statusCode,
    409,
  );
});

async function reserve(
  p: Awaited<ReturnType<typeof interview>>,
  bytes: Buffer,
) {
  return data(
    await request("POST", p.base, p.narrator.token, {
      clientPhotoId: randomUUID(),
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }),
  );
}
async function upload(
  p: Awaited<ReturnType<typeof interview>>,
  photo: any,
  bytes: Buffer,
) {
  const form = data(
    await request("POST", `${p.base}/${photo.id}/upload`, p.narrator.token, {}),
  );
  const boundary = `photo-${randomUUID()}`;
  const parts: Buffer[] = Object.entries(form.fields).map(([name, value]) =>
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    ),
  );
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="private.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  const r = await app.inject({
    method: "POST",
    url: form.url,
    headers: {
      authorization: `Bearer ${p.narrator.token}`,
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
    payload: Buffer.concat(parts),
  });
  assert.equal(r.statusCode, 204, r.body);
}
test("photo sealing retains the actual original and creates private oriented metadata-free derivatives", async () => {
  const p = await interview();
  const bytes = await sharp({
    create: { width: 120, height: 80, channels: 3, background: "#e54334" },
  })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();
  const photo = await reserve(p, bytes);
  await upload(p, photo, bytes);
  const sealed = data(
    await request("POST", `${p.base}/${photo.id}/seal`, p.narrator.token, {}),
  );
  assert.equal(sealed.state, "sealed");
  assert.equal(sealed.lowResolution, true);
  assert.deepEqual(sealed.orientedPixels, { width: 80, height: 120 });
  assert.equal(sealed.assets.length, 3);
  const original = sealed.assets.find((a: any) => a.kind === "original");
  for (const kind of ["original", "preview", "thumbnail", "print"]) {
    const url = `${p.base}/${photo.id}/content/${kind}`;
    assert.equal((await request("GET", url)).statusCode, 401);
    assert.equal(
      (await request("GET", url, (await login()).token)).statusCode,
      403,
    );
    const r = await request("GET", url, p.narrator.token);
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.headers["cache-control"], "private, no-store");
    if (kind === "original") assert.deepEqual(r.rawPayload, bytes);
    else {
      const metadata = await sharp(r.rawPayload).metadata();
      assert.equal(metadata.exif, undefined);
      assert.equal(metadata.width, 80);
      assert.equal(metadata.height, 120);
      const asset = sealed.assets.find(
        (a: any) => a.kind === (kind === "thumbnail" ? "preview" : kind),
      );
      assert.equal(asset.parentId, original.id);
      assert.ok(asset.processingVersion);
    }
  }
});

async function selectPhotos(
  p: Awaited<ReturnType<typeof interview>>,
  photoIds: string[],
) {
  const current = data(
    await request("GET", p.materials, p.narrator.token),
    200,
  );
  return data(
    await request("POST", p.materials, p.narrator.token, {
      expectedRevision: current?.revision ?? 0,
      entries: photoIds.map((photoId) => ({ photoId, caption: "" })),
    }),
  );
}

test("adding, describing and reordering photos creates immutable material snapshots without replacing recorded audio", async () => {
  const p = await interview();
  const bytes = await sharp({
    create: { width: 60, height: 40, channels: 3, background: "#247b93" },
  })
    .png()
    .toBuffer();
  const ids = [];
  for (let i = 0; i < 2; i++) {
    const photo = await reserve(p, bytes);
    await upload(p, photo, bytes);
    const sealed = data(
      await request("POST", `${p.base}/${photo.id}/seal`, p.narrator.token, {}),
    );
    ids.push(sealed.id);
  }
  const state = { snapshot: await selectPhotos(p, ids) };
  assert.equal(state.snapshot.revision, 1);
  assert.deepEqual(
    state.snapshot.entries.map((e: any) => e.photoId),
    ids,
  );
  const first = state.snapshot;
  const edited = data(
    await request("POST", `${p.materials}`, p.narrator.token, {
      expectedRevision: first.revision,
      entries: [
        { photoId: ids[1], caption: "旧屋门口" },
        { photoId: ids[0], caption: "" },
      ],
    }),
  );
  assert.equal(edited.revision, 2);
  assert.notEqual(edited.hash, first.hash);
  assert.equal(edited.entries[0].caption, "旧屋门口");
  const old = data(
    await request("GET", `${p.materials}/${first.id}`, p.narrator.token),
    200,
  );
  assert.deepEqual(old, first);
  assert.equal(
    (
      await request("POST", `${p.materials}`, p.narrator.token, {
        expectedRevision: first.revision,
        entries: [],
      })
    ).statusCode,
    409,
  );
  const restored = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/interviews/${p.interview.id}`,
      p.narrator.token,
    ),
    200,
  );
  assert.deepEqual(restored.clips, []);
});

test("photo intents survive ordinary AI and sharing grants while the same app seals audio and restores its real Worker transcription", async () => {
  const p = await interview(),
    bytes = await sharp({
      create: { width: 60, height: 40, channels: 3, background: "#247b93" },
    })
      .png()
      .toBuffer(),
    photo = await reserve(p, bytes),
    beforeGrant = await state(p, p.narrator.token);
  await upload(p, photo, bytes);

  assert.equal(
    (await state(p, p.narrator.token)).accessEpoch,
    beforeGrant.accessEpoch,
  );
  data(
    await request("POST", `${p.base}/${photo.id}/seal`, p.narrator.token, {}),
  );
  const firstSnapshot = await selectPhotos(p, [photo.id]);
  const audio = readFileSync("test/fixtures/synthetic-1s.mp3"),
    clipsBase = `/v1/projects/${p.projectId}/interviews/${p.interview.id}/clips`,
    clip = data(
      await request("POST", clipsBase, p.narrator.token, {
        clientClipId: randomUUID(),
        bytes: audio.length,
        sha256: createHash("sha256").update(audio).digest("hex"),
      }),
    );
  await upload({ ...p, base: clipsBase }, clip, audio);
  const sealed = data(
      await request(
        "POST",
        `${clipsBase}/${clip.id}/seal`,
        p.narrator.token,
        {},
      ),
    ),
    taskView = async () =>
      data(
        await request(
          "GET",
          `/v1/projects/${p.projectId}/tasks`,
          p.narrator.token,
        ),
        200,
      ),
    [originalTask] = await taskView(),
    recorded = data(
      await request(
        "GET",
        `/v1/projects/${p.projectId}/interviews/${p.interview.id}`,
        p.narrator.token,
      ),
      200,
    );
  assert.equal(originalTask.inputHash, sealed.sha256);
  assert.equal(originalTask.state, "queued");
  assert.equal(originalTask.recordingUsageMs, 1080);
  const wake = async (
    runtime: Awaited<ReturnType<typeof startProductionWorker>>,
  ) => {
    const delivery = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        runtime.worker.off("completed", completed);
        reject(Error("combined Worker delivery did not complete"));
      }, 5000);
      const completed = (job: { id?: string }) => {
        if (job.id !== originalTask.id) return;
        clearTimeout(timer);
        runtime.worker.off("completed", completed);
        resolve();
      };
      runtime.worker.on("completed", completed);
    });
    await runtime.recoverDue();
    await delivery;
  };
  let runtime = await startProductionWorker(app);
  try {
    await wake(runtime);
    assert.equal((await taskView())[0].state, "waiting_provider");
    const added = await reserve(p, bytes);
    await upload(p, added, bytes);

    assert.equal(
      (await state(p, p.narrator.token)).accessEpoch,
      beforeGrant.accessEpoch,
    );
    data(
      await request("POST", `${p.base}/${added.id}/seal`, p.narrator.token, {}),
    );
    await selectPhotos(p, [photo.id, added.id]);
    await runtime.close();
    runtime = await startProductionWorker(app);
    await wake(runtime);
    const [finished] = await taskView();
    assert.equal(finished.id, originalTask.id);
    assert.equal(finished.state, "succeeded");
    assert.equal(finished.queuedAt, originalTask.queuedAt);
    assert.equal(finished.recordingUsageMs, 1080);
    assert.equal(finished.attempts.length, 1);
    assert.equal(finished.originalTranscript.text, "照片里是那年的旧屋。");
    assert.equal(finished.originalTranscript.inputHash, sealed.sha256);
    assert.deepEqual(
      providerCalls.filter(
        (call) => call.id === originalTask.providerRequestId,
      ),
      [
        { action: "submit", id: originalTask.providerRequestId },
        { action: "query", id: originalTask.providerRequestId },
      ],
    );
    assert.equal((await taskView()).length, 1);
    assert.equal(
      data(await request("GET", p.materials, p.narrator.token), 200).revision,
      2,
    );
    assert.deepEqual(
      data(
        await request(
          "GET",
          `${p.materials}/${firstSnapshot.id}`,
          p.narrator.token,
        ),
        200,
      ),
      firstSnapshot,
    );
    assert.deepEqual(
      data(
        await request(
          "GET",
          `/v1/projects/${p.projectId}/interviews/${p.interview.id}`,
          p.narrator.token,
        ),
        200,
      ).clips,
      recorded.clips,
    );
    const content = await request(
      "GET",
      `${p.base}/${photo.id}/content/original`,
      p.narrator.token,
    );
    assert.equal(content.statusCode, 200);
    assert.deepEqual(content.rawPayload, bytes);
  } finally {
    await runtime.close();
  }
  await app.close();
  app = await createApplication(config, fixtureOptions());
  assert.equal((await taskView())[0].id, originalTask.id);
  assert.equal((await taskView())[0].state, "succeeded");
});

test("a bounded crop creates new derivative references and preserves the original and old snapshot", async () => {
  const p = await interview(),
    bytes = await sharp({
      create: { width: 100, height: 80, channels: 3, background: "#247b93" },
    })
      .png()
      .toBuffer();
  const photo = await reserve(p, bytes);
  await upload(p, photo, bytes);
  data(
    await request("POST", `${p.base}/${photo.id}/seal`, p.narrator.token, {}),
  );
  const before = await selectPhotos(p, [photo.id]);
  const cropped = data(
    await request("POST", `${p.materials}/${photo.id}/crop`, p.narrator.token, {
      expectedRevision: before.revision,
      left: 10,
      top: 20,
      width: 40,
      height: 30,
    }),
  );
  assert.equal(cropped.revision, 2);
  assert.notEqual(cropped.hash, before.hash);
  const original = before.entries[0].assets.find(
    (a: any) => a.kind === "original",
  );
  assert.equal(
    cropped.entries[0].assets.find((a: any) => a.kind === "original").id,
    original.id,
  );
  assert.notEqual(
    cropped.entries[0].assets.find((a: any) => a.kind === "print").id,
    before.entries[0].assets.find((a: any) => a.kind === "print").id,
  );
  const id = cropped.entries[0].assets.find((a: any) => a.kind === "print").id;
  const result = await request(
    "GET",
    `${p.base}/${photo.id}/assets/${id}/content`,
    p.narrator.token,
  );
  assert.equal(result.statusCode, 200, result.body);
  const actual = await sharp(result.rawPayload).metadata();
  assert.equal(actual.width, 40);
  assert.equal(actual.height, 30);
  assert.deepEqual(
    data(
      await request("GET", `${p.materials}/${before.id}`, p.narrator.token),
      200,
    ),
    before,
  );
  assert.equal(
    (
      await request(
        "POST",
        `${p.materials}/${photo.id}/crop`,
        p.narrator.token,
        {
          expectedRevision: 2,
          left: 90,
          top: 0,
          width: 40,
          height: 30,
        },
      )
    ).statusCode,
    422,
  );
});

test("unsupported bytes remain recoverable and parallel stable IDs consume one photo reservation", async () => {
  const p = await interview(),
    bytes = Buffer.from("unsupported-private-format");
  const body = {
    clientPhotoId: randomUUID(),
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const responses = await Promise.all([
    request("POST", p.base, p.narrator.token, body),
    request("POST", p.base, p.narrator.token, body),
  ]);
  const first = data(responses[0]);
  assert.equal(data(responses[1]).id, first.id);
  await upload(p, first, bytes);
  assert.equal(
    (await request("POST", `${p.base}/${first.id}/seal`, p.narrator.token, {}))
      .statusCode,
    422,
  );
  const status = data(
    await request("POST", `${p.base}/${first.id}/status`, p.narrator.token, {}),
  );
  assert.equal(status.state, "pending");
  assert.deepEqual(status.assets, []);
  assert.deepEqual(
    data(await request("GET", p.base, p.narrator.token), 200).usage,
    { reservedCount: 1, consumedCount: 0 },
  );
});

test("final objects survive a database rollback and app restart without duplicate usage or snapshots", async () => {
  const p = await interview(),
    bytes = readFileSync("../../tests/print-probe/fixtures/synthetic.heic");
  const photo = await reserve(p, bytes);
  await upload(p, photo, bytes);
  await db.$executeRawUnsafe(
    `CREATE FUNCTION fail_photo_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic commit failure'; END $$`,
  );
  await db.$executeRawUnsafe(
    `CREATE TRIGGER fail_photo_snapshot BEFORE INSERT ON photo_assets FOR EACH ROW EXECUTE FUNCTION fail_photo_snapshot()`,
  );
  try {
    assert.equal(
      (
        await request(
          "POST",
          `${p.base}/${photo.id}/seal`,
          p.narrator.token,
          {},
        )
      ).statusCode,
      500,
    );
  } finally {
    await db.$executeRawUnsafe(
      `DROP TRIGGER fail_photo_snapshot ON photo_assets`,
    );
    await db.$executeRawUnsafe(`DROP FUNCTION fail_photo_snapshot()`);
  }
  const pending = data(
    await request("POST", `${p.base}/${photo.id}/status`, p.narrator.token, {}),
  );
  assert.equal(pending.state, "pending");
  assert.deepEqual(pending.assets, []);
  await app.close();
  app = await createApplication(config, fixtureOptions());
  const results = await Promise.all([
    request("POST", `${p.base}/${photo.id}/seal`, p.narrator.token, {}),
    request("POST", `${p.base}/${photo.id}/seal`, p.narrator.token, {}),
  ]);
  const sealed = data(results[0]);
  assert.equal(
    data(results[1]).assets.find((a: any) => a.kind === "original").id,
    sealed.assets.find((a: any) => a.kind === "original").id,
  );
  const state = data(await request("GET", p.base, p.narrator.token), 200);
  assert.equal(
    data(await request("GET", p.materials, p.narrator.token), 200),
    null,
  );
  assert.deepEqual(state.usage, { reservedCount: 0, consumedCount: 1 });
});

test("real database ownership constraints reject photos and immutable references from another project", async () => {
  const p = await interview(),
    q = await interview(),
    bytes = await sharp({
      create: { width: 40, height: 30, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
  const photo = await reserve(p, bytes);
  await upload(p, photo, bytes);
  data(
    await request("POST", `${p.base}/${photo.id}/seal`, p.narrator.token, {}),
  );
  const snapshot = await selectPhotos(p, [photo.id]);
  const asset = snapshot.entries[0].assets[0];
  await assert.rejects(
    db.$executeRaw`INSERT INTO photo_references(snapshot_id,project_id,interview_id,photo_id,position,caption,original_id,preview_id,print_id) VALUES(${snapshot.id}::uuid,${q.projectId}::uuid,${q.interview.id}::uuid,${photo.id}::uuid,5,'',${asset.id}::uuid,${asset.id}::uuid,${asset.id}::uuid)`,
  );
  await assert.rejects(
    db.$executeRaw`UPDATE photo_snapshots SET hash=${"f".repeat(64)} WHERE id=${snapshot.id}::uuid`,
  );
  await assert.rejects(
    db.$executeRaw`UPDATE photo_assets SET bytes=1 WHERE id=${asset.id}::uuid`,
  );
  assert.equal(
    (
      await request("POST", `${q.materials}`, q.narrator.token, {
        expectedRevision: 0,
        entries: [{ photoId: photo.id, caption: "" }],
      })
    ).statusCode,
    404,
  );
});

test("one sealed project photo can be reused across interviews without duplicate quota and detached without changing prior snapshots", async () => {
  const p = await interview();
  const bytes = await sharp({
    create: { width: 40, height: 30, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  const photo = await reserve(p, bytes);
  await upload(p, photo, bytes);
  data(
    await request("POST", `${p.base}/${photo.id}/seal`, p.narrator.token, {}),
  );
  const first = await selectPhotos(p, [photo.id]);
  const next = data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/interviews`,
      p.buyer.token,
      {
        clientInterviewId: randomUUID(),
        expectedPlanRevision: 1,
        starterKind: "photo",
      },
    ),
  );
  const materials = `/v1/projects/${p.projectId}/interviews/${next.id}/photo-materials`;
  const reused = data(
    await request("POST", materials, p.buyer.token, {
      expectedRevision: 0,
      entries: [{ photoId: photo.id, caption: "另一次讲述" }],
    }),
  );
  assert.equal(reused.entries[0].photoId, photo.id);
  assert.equal(reused.entries[0].assets[0].id, first.entries[0].assets[0].id);
  const removed = data(
    await request("POST", materials, p.buyer.token, {
      expectedRevision: 1,
      entries: [],
    }),
  );
  assert.deepEqual(removed.entries, []);
  assert.deepEqual(
    data(await request("GET", `${materials}/${reused.id}`, p.buyer.token), 200),
    reused,
  );
  assert.deepEqual(
    data(await request("GET", p.materials, p.narrator.token), 200),
    first,
  );
  const collection = data(await request("GET", p.base, p.buyer.token), 200);
  assert.equal(collection.photos.length, 1);
  assert.deepEqual(collection.usage, { reservedCount: 0, consumedCount: 1 });
});

test("photo routes remain disabled by default and synthetic configuration is rejected in production", async () => {
  const inactive = await createApplication(
    { ...config, photos: undefined },
    fixtureOptions(),
  );
  try {
    assert.equal(
      (
        await inactive.inject({
          method: "GET",
          url: `/v1/projects/${randomUUID()}/photos`,
        })
      ).statusCode,
      404,
    );
    assert.ok(
      !JSON.stringify(createOpenApiDocument(inactive)).includes(
        "photo-materials",
      ),
    );
  } finally {
    await inactive.close();
  }
  await assert.rejects(
    createApplication(
      { ...config, environment: "production" },
      fixtureOptions(),
    ),
  );
  assert.ok(
    JSON.stringify(createOpenApiDocument(app)).includes("photo-materials"),
  );
});

test("an unsupported photo can release its reservation and recover with a supported replacement at the quota limit", async () => {
  const fixture = JSON.parse(
    readFileSync("test/fixtures/catalog-synthetic.json", "utf8"),
  );
  fixture.admission.d04.userQuotas.photos.value = 1;
  const draftId = randomUUID(),
    version = randomUUID();
  await db.packageDraft.create({
    data: { id: draftId, realm: "local", ...fixture },
  });
  await db.packageVersion.create({
    data: {
      id: version,
      realm: "local",
      purpose: "local_preview",
      draftId,
      draftRevision: 1,
      snapshot: fixture,
      publicOffer: {
        title: "合成",
        price: { value: 99900, unit: "fen", currency: "CNY" },
      },
    },
  });
  const p = await joinedProject(version);

  const plan = data(
    await request("GET", `/v1/projects/${p.projectId}/plan`, p.narrator.token),
    200,
  );
  const i = data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/interviews`,
      p.narrator.token,
      {
        clientInterviewId: randomUUID(),
        expectedPlanRevision: plan.revision,
        starterKind: "photo",
      },
    ),
  );
  const q = {
    ...p,
    interview: i,
    base: `/v1/projects/${p.projectId}/photos`,
    materials: `/v1/projects/${p.projectId}/interviews/${i.id}/photo-materials`,
  };
  const invalid = Buffer.from("not an image"),
    bad = await reserve(q, invalid);
  await upload(q, bad, invalid);
  assert.equal(
    (await request("POST", `${q.base}/${bad.id}/seal`, q.narrator.token, {}))
      .statusCode,
    422,
  );
  assert.equal(
    (
      await request("POST", q.base, q.narrator.token, {
        clientPhotoId: randomUUID(),
        bytes: 5,
        sha256: "a".repeat(64),
      })
    ).statusCode,
    409,
  );
  const released = data(
    await request("POST", `${q.base}/${bad.id}/release`, q.narrator.token, {}),
  );
  assert.equal(released.state, "released");
  const bytes = await sharp({
    create: { width: 40, height: 30, channels: 3, background: "white" },
  })
    .jpeg()
    .toBuffer();
  const good = await reserve(q, bytes);
  await upload(q, good, bytes);
  data(
    await request("POST", `${q.base}/${good.id}/seal`, q.narrator.token, {}),
  );
  assert.deepEqual(
    data(await request("GET", q.base, q.narrator.token), 200).usage,
    { reservedCount: 0, consumedCount: 1 },
  );
});

test("photo decoding gives bounded backpressure while duplicate completions still converge", async () => {
  const p = await interview(),
    bytes = await sharp({
      create: { width: 100, height: 80, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
  const photos = [];
  for (let i = 0; i < 6; i++) {
    const photo = await reserve(p, bytes);
    await upload(p, photo, bytes);
    photos.push(photo);
  }
  let release!: () => void, enter!: () => void;
  const held = new Promise<void>((r) => (release = r)),
    entered = new Promise<void>((r) => (enter = r));
  let active = 0;
  photoReadGate = async () => {
    if (++active === 2) enter();
    await held;
  };
  const pending = photos.map((photo) =>
    request("POST", `${p.base}/${photo.id}/seal`, p.narrator.token, {}),
  );
  let results: Awaited<(typeof pending)[number]>[];
  try {
    await entered;
    await Promise.race([
      Promise.any(
        pending.map(async (request) => {
          const result = await request;
          if (result.statusCode !== 503)
            throw Error("Not a backpressure response");
          return result;
        }),
      ),
      new Promise((_, reject) =>
        setTimeout(
          () =>
            reject(
              Error(
                "Two real held decoders did not apply bounded backpressure",
              ),
            ),
          5000,
        ),
      ),
    ]);
  } finally {
    release();
    photoReadGate = undefined;
    results = await Promise.all(pending);
  }
  assert.ok(
    results.some((r) => r.statusCode === 503),
    "busy decoder gives recoverable backpressure",
  );
  for (const [i, r] of results.entries()) {
    if (r.statusCode === 503)
      data(
        await request(
          "POST",
          `${p.base}/${photos[i].id}/seal`,
          p.narrator.token,
          {},
        ),
      );
    else data(r);
  }
  const state = data(await request("GET", p.base, p.narrator.token), 200);
  assert.deepEqual(state.usage, { reservedCount: 0, consumedCount: 6 });
  assert.equal(
    data(await request("GET", p.materials, p.narrator.token), 200),
    null,
  );
});

test("database lineage rejects a derivative parent from another photo in the same project", async () => {
  const p = await interview(),
    bytes = await sharp({
      create: { width: 40, height: 30, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
  const one = await reserve(p, bytes),
    two = await reserve(p, bytes);
  await upload(p, one, bytes);
  data(await request("POST", `${p.base}/${one.id}/seal`, p.narrator.token, {}));
  await assert.rejects(
    db.$executeRaw`INSERT INTO photo_assets(id,project_id,intent_id,parent_id,kind,processing_version,storage,store,storage_scope,object_key,bytes,sha256,mime,width,height,metadata) SELECT ${randomUUID()}::uuid,project_id,${two.id}::uuid,id,'preview','synthetic-invalid-parent',storage,store,storage_scope,${`photos/sealed/${randomUUID()}/preview.jpg`},bytes,sha256,mime,width,height,metadata FROM photo_assets WHERE intent_id=${one.id}::uuid AND kind='original'`,
  );
});

test("a lost material-edit response replays its exact immutable result even after later revisions", async () => {
  const p = await interview(),
    bytes = await sharp({
      create: { width: 40, height: 30, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
  const photo = await reserve(p, bytes);
  await upload(p, photo, bytes);
  data(
    await request("POST", `${p.base}/${photo.id}/seal`, p.narrator.token, {}),
  );
  await selectPhotos(p, [photo.id]);
  const key = randomUUID(),
    command = {
      expectedRevision: 1,
      entries: [{ photoId: photo.id, caption: "第一份说明" }],
    };
  const first = data(
    await request("POST", `${p.materials}`, p.narrator.token, command, key),
  );
  data(
    await request("POST", `${p.materials}`, p.narrator.token, {
      expectedRevision: 2,
      entries: [{ photoId: photo.id, caption: "后来修改的说明" }],
    }),
  );
  const replay = data(
    await request("POST", `${p.materials}`, p.narrator.token, command, key),
  );
  assert.deepEqual(replay, first);
});

test("photo derivative dimensions describe the actual resized preview rather than the source pixels", async () => {
  const p = await interview(),
    bytes = await sharp({
      create: { width: 2000, height: 1000, channels: 3, background: "white" },
    })
      .jpeg()
      .toBuffer();
  const photo = await reserve(p, bytes);
  await upload(p, photo, bytes);
  const sealed = data(
    await request("POST", `${p.base}/${photo.id}/seal`, p.narrator.token, {}),
  );
  const preview = sealed.assets.find((a: any) => a.kind === "preview"),
    original = sealed.assets.find((a: any) => a.kind === "original");
  assert.equal(preview.width, 1200);
  assert.equal(preview.height, 600);
  assert.equal(original.width, 2000);
  assert.equal(original.height, 1000);
  const r = await request(
    "GET",
    `${p.base}/${photo.id}/content/preview`,
    p.narrator.token,
  );
  assert.equal(r.statusCode, 200, r.body);
  const actual = await sharp(r.rawPayload).metadata();
  assert.equal(actual.width, preview.width);
  assert.equal(actual.height, preview.height);
});

after(async () => {
  await closePrivacyFixture(config);
});
