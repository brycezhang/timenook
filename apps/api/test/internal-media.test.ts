import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { after, before, test } from "node:test";
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import { createApplication } from "../src/application";
import { readConfig, type ApiConfig } from "../src/config";
import { createInternalProject } from "../src/projects/internal-project";
import { provisionWebAccount } from "../src/web/web-provisioning";
import { LocalProbeObjects } from "../src/probe/local-objects";
import { ProductionTasks } from "../src/tasks/tasks";
import { startProductionWorker } from "../src/tasks/worker";
import { waitForWorkerJobs } from "./worker-completion";
import { bootPrivacyFixture, closePrivacyFixture } from "./privacy-fixture";
const schema = `internal_media_${randomUUID().replaceAll("-", "")}`,
  origin = "https://localhost:3447";
let root: string,
  config: ApiConfig,
  db: PrismaClient,
  app: Awaited<ReturnType<typeof createApplication>>,
  objects: Objects;
const sent: { kind: string; value: unknown }[] = [];
class Objects extends LocalProbeObjects {
  async uploadForm(key: string, _bytes: number, expiresAt: Date) {
    return {
      storage: "oss" as const,
      url: "https://timenook.oss-cn-shanghai.aliyuncs.com",
      expiresAt: expiresAt.toISOString(),
      fields: { key },
    };
  }
  async asrSource(key: string, seconds: number) {
    return {
      url: `https://timenook.oss-cn-shanghai.aliyuncs.com/timenook/product/internal/${key}?controlled-source`,
      expiresAt: new Date(Date.now() + (seconds + 5) * 1000).toISOString(),
      credentialMode: "static" as const,
      credentialsExpireAt: null,
    };
  }
}
const aiFetch: typeof fetch = async (url, init) => {
  if (String(url).includes("/chat/completions")) {
    const body = JSON.parse(String(init?.body)),
      input = JSON.parse(body.messages[1].content);
    sent.push({ kind: "story", value: input });
    return new Response(
      JSON.stringify({
        model: "deepseek-flash",
        usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 },
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: JSON.stringify({
                title: "我记得的童年",
                theme: "家乡",
                paragraphs: [
                  {
                    text: "小时候，我在村口的大树下和同伴玩耍。",
                    sourceRefs: input.sourceRefs,
                  },
                ],
                reviewItems: [],
              }),
            },
          },
        ],
      }),
    );
  }
  const id = new Headers(init?.headers).get("X-Api-Request-Id")!,
    action = String(url).endsWith("/submit") ? "submit" : "query";
  sent.push({ kind: action, value: JSON.parse(String(init?.body)) });
  return new Response(
    action === "submit"
      ? "{}"
      : JSON.stringify({
          task_id: id,
          result: { text: "小时候，我在村口的大树下和同伴玩耍。" },
        }),
    { headers: { "X-Api-Status-Code": "20000000" } },
  );
};
before(async () => {
  const database = new URL(process.env.DATABASE_URL!);
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(database.hostname));
  database.searchParams.set("schema", schema);
  root = await mkdtemp(join(tmpdir(), "timenook-internal-media-"));
  config = readConfig({
    ...process.env,
    NODE_ENV: "development",
    DATABASE_URL: database.toString(),
    REDIS_KEY_PREFIX: schema,
    INTERNAL_ACCEPTANCE_ENABLED: "1",
    WEB_ORIGIN: origin,
    WEB_SESSION_KEY: randomBytes(32).toString("base64"),
    TIMENOOK_PRODUCT_STORAGE_ROOT: root,
    TIMENOOK_PRODUCT_OSS_BUCKET: "timenook",
    TIMENOOK_PRODUCT_OSS_REGION: "cn-shanghai",
    TIMENOOK_PRODUCT_OSS_KEY_PREFIX: "timenook/product/internal",
    TIMENOOK_PRODUCT_OSS_ACCESS_KEY_ID: "controlled-id",
    TIMENOOK_PRODUCT_OSS_ACCESS_KEY_SECRET: "controlled-secret",
    TIMENOOK_PRODUCT_DOUBAO_API_KEY: "controlled-asr",
    TIMENOOK_PRODUCT_DOUBAO_RESOURCE_ID: "volc.seedasr.auc",
    TIMENOOK_PRODUCT_DEEPSEEK_API_KEY: "controlled-text",
    TIMENOOK_PRODUCT_DEEPSEEK_BASE_URL: "https://cf.api.fan/v1",
    TIMENOOK_PRODUCT_DEEPSEEK_MODEL: "deepseek-flash",
  });
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
  // Non-test composition must boot with native adapters before replacing only the two external boundaries.
  const realComposition = await createApplication(config);
  await realComposition.close();
  config.environment = "test";
  config.transcription!.pollIntervalMs = 0;
  objects = new Objects(root);
  app = await createApplication(config, { recordingObjects: objects, aiFetch });
  db = new PrismaClient({ datasourceUrl: config.databaseUrl });
});
after(async () => {
  await app?.close();
  if (!config) return;
  const redis = new Redis(config.redisUrl);
  try {
    await db?.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    const keys = await redis.keys(`${schema}:*`);
    if (keys.length) await redis.del(...keys);
  } finally {
    await db?.$disconnect();
    redis.disconnect();
    await closePrivacyFixture(config);
    await rm(root, { recursive: true, force: true });
  }
});
type Actor = { id: string; cookie: string; csrf: string };
function data(
  r: { statusCode: number; body: string; json(): any },
  status = 201,
) {
  assert.equal(r.statusCode, status, r.body);
  return r.json().data;
}
async function login(): Promise<Actor> {
  const user = (await provisionWebAccount(config, "create", {})) as {
      user: { id: string };
    },
    link = (await provisionWebAccount(config, "issue", {
      userId: user.user.id,
    })) as { url: string },
    reply = await app.inject({
      method: "POST",
      url: "/v1/web/session",
      headers: { origin, "x-timenook-web": "1" },
      payload: {
        ticket: new URLSearchParams(new URL(link.url).hash.slice(1)).get(
          "ticket",
        ),
      },
    });
  const current = data(reply);
  return {
    id: user.user.id,
    cookie: String(reply.headers["set-cookie"]).split(";")[0],
    csrf: current.csrfToken,
  };
}
function request(
  method: "GET" | "POST",
  url: string,
  actor: Actor,
  payload?: object,
) {
  return app.inject({
    method,
    url,
    headers: {
      cookie: actor.cookie,
      origin,
      "x-timenook-web": "1",
      "x-csrf-token": actor.csrf,
      "idempotency-key": randomUUID(),
    },
    ...(payload ? { payload } : {}),
  });
}
const notice = () => ({
  noticeVersion: "internal-participation-v1",
  evidenceRef: `internal:${randomUUID()}`,
});
test("one unpaid Cookie project records, seals, transcribes, confirms its story and produces one PDF confirmed by both participants", async () => {
  const owner = await login(),
    narrator = await login(),
    project = await createInternalProject(config, {
      provisionKey: randomUUID(),
      initiatorUserId: owner.id,
      subjectName: "内部合成样本",
    }),
    base = `/v1/projects/${project.projectId}`,
    invitation = data(await request("POST", `${base}/invitations`, owner)),
    application = data(
      await request(
        "POST",
        `/v1/invitations/${invitation.token}/requests`,
        narrator,
        notice(),
      ),
    );
  data(
    await request(
      "POST",
      `/v1/binding-requests/${application.id}/approve`,
      owner,
      { expectedBindingVersion: 0, evidenceRef: `internal:${randomUUID()}` },
    ),
  );
  for (const purpose of ["collection", "ai", "sharing"]) {
    const state = data(
      await request("GET", `${base}/participation`, narrator),
      200,
    );
    data(
      await request("POST", `${base}/consents`, narrator, {
        ...notice(),
        purpose,
        granted: true,
        expectedBindingVersion: state.bindingVersion,
        expectedAccessEpoch: state.accessEpoch,
      }),
    );
  }
  const interview = data(
    await request("POST", `${base}/interviews`, narrator, {
      clientInterviewId: randomUUID(),
      expectedPlanRevision: 1,
      starterKind: "free-narration",
    }),
  );
  data(
    await request(
      "POST",
      `${base}/interviews/${interview.id}/recording-start`,
      narrator,
      {},
    ),
  );
  const audio = readFileSync("test/fixtures/synthetic-1s.mp3"),
    sha256 = createHash("sha256").update(audio).digest("hex"),
    clips = `${base}/interviews/${interview.id}/clips`,
    clip = data(
      await request("POST", clips, narrator, {
        clientClipId: randomUUID(),
        bytes: audio.length,
        sha256,
      }),
    ),
    form = data(
      await request("POST", `${clips}/${clip.id}/upload`, narrator, {}),
    );
  assert.equal(
    await db.productionTask.count(),
    0,
    "ASR cannot begin before reliable save",
  );
  await objects.put(form.fields.key, audio); // Only the private OSS transport is substituted.
  data(await request("POST", `${clips}/${clip.id}/seal`, narrator, {}));
  const source = await db.productionTask.findFirstOrThrow({
    where: { projectId: project.projectId, kind: "transcribe_audio" },
  });
  await app.get(ProductionTasks).run(source.id);
  await app.get(ProductionTasks).run(source.id);
  const transcript = await db.formalTranscript.findUniqueOrThrow({
    where: { taskId: source.id },
  });
  assert.match(transcript.text!, /村口/);
  const organized = data(
      await request("POST", `${base}/stories/organize`, narrator, {
        interviewId: interview.id,
        baseVersion: 0,
      }),
      202,
    ),
    runtime = await startProductionWorker(app);
  try {
    await waitForWorkerJobs(runtime.worker, async (expect) => {
      expect([organized.task.id]);
      await runtime.recoverDue();
    });
  } finally {
    await runtime.close();
  }
  const story = data(
    await request("GET", `${base}/stories/${organized.id}`, narrator),
    200,
  );
  assert.equal(story.task.state, "succeeded");
  assert.equal(story.revision.sourceManifest.length, 1);
  const confirmed = data(
    await request(
      "POST",
      `${base}/stories/${organized.id}/decisions`,
      narrator,
      {
        ...notice(),
        revisionId: story.revision.id,
        expectedVersion: story.version,
        contentHash: story.revision.contentHash,
        confirmed: true,
        allowInBook: true,
      },
    ),
  );
  assert.equal(confirmed.decision.confirmed, true);
  assert.equal(confirmed.decision.allowInBook, true);
  const bookBase = `${base}/book`,
    bookContext = data(await request("GET", bookBase, narrator), 200);
  assert.equal(bookContext.physicalProduction, false);
  assert.equal(bookContext.eligibleStories.length, 1);
  const book = data(
      await request("POST", bookBase + "/versions", narrator, {
        expectedInputHash: bookContext.inputHash,
      }),
      202,
    ),
    pdfRuntime = await startProductionWorker(app);
  try {
    // PDF rendering and inspection each have a bounded 60s subprocess budget.
    // A valid render need not emit a completed event within the default 5s idle window.
    await waitForWorkerJobs(
      pdfRuntime.worker,
      async (expect) => {
        expect([book.task.id]);
        await pdfRuntime.recoverDue();
      },
      125_000,
    );
  } finally {
    await pdfRuntime.close();
  }
  const ready = data(
    await request("GET", bookBase + `/versions/${book.id}`, narrator),
    200,
  );
  assert.equal(ready.state, "ready", JSON.stringify(ready.task));
  assert.equal(
    ready.snapshot.specification.status,
    "internal-acceptance-candidate",
  );
  assert.equal(
    ready.snapshot.chapters[0].stories[0].revisionId,
    story.revision.id,
  );
  for (const [role, actor] of [
    ["narrator", narrator],
    ["initiator", owner],
  ] as const) {
    const pdf = await request(
      "GET",
      bookBase + `/versions/${book.id}/pdf`,
      actor,
    );
    assert.equal(pdf.statusCode, 200, pdf.body);
    assert.equal(
      createHash("sha256").update(pdf.rawPayload).digest("hex"),
      ready.pdf.sha256,
    );
    const context = data(
      await request("GET", bookBase + "/confirmations", actor),
      200,
    );
    assert.equal(context.role, role);
    const saved = data(
      await request("POST", bookBase + "/confirmations", actor, {
        role,
        bookVersionId: ready.id,
        snapshotHash: ready.snapshotHash,
        pdfHash: ready.pdf.sha256,
        noticeVersion: context.noticeVersion,
        evidenceRef: `internal:本人逐页核对本版-${role}-${randomUUID()}`,
      }),
    );
    assert.equal(saved.confirmations[role], true);
  }
  const both = data(
    await request("GET", bookBase + "/confirmations", narrator),
    200,
  );
  assert.deepEqual(both.confirmations, { narrator: true, initiator: true });
  const pdfDecision = await db.bookConfirmation.findFirstOrThrow({
    where: { projectId: project.projectId, role: "narrator" },
  });
  assert.equal(pdfDecision.method, "self_web");
  assert.match(pdfDecision.evidenceRef!, /^self_web:[a-f0-9-]{36}:internal:/);
  assert.equal(await db.firstCopyOrder.count(), 0);
  const decision = await db.storyDecision.findFirstOrThrow({
    where: { projectId: project.projectId },
  });
  assert.equal(decision.method, "self_web");
  assert.match(decision.evidenceRef!, /^self_web:[0-9a-f-]{36}:internal:/);
  const recording = await db.recordingIntent.findUniqueOrThrow({
    where: { id: clip.id },
  });
  assert.equal(recording.method, "self_web");
  assert.equal(recording.state, "sealed");
  assert.equal(
    (
      await db.recordingAsset.findUniqueOrThrow({
        where: {
          id: (
            await db.recordingClip.findUniqueOrThrow({
              where: { intentId: clip.id },
            })
          ).assetId,
        },
      })
    ).sha256,
    sha256,
  );
  assert.equal(await db.paymentOrder.count(), 0);
  assert.equal(await db.wechatIdentity.count(), 0);
  assert.equal(await db.firstCopyEntitlement.count(), 0);
  assert.deepEqual(
    sent.map((s) => s.kind),
    ["submit", "query", "story"],
  );
});
