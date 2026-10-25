import nock from "nock";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import { createApplication } from "../src/application";
import type { ApiConfig } from "../src/config";
import { AsrSourcePreflightError } from "../src/probe/ai-providers";

const schema = `t03_${randomUUID().replaceAll("-", "")}`;
let config: ApiConfig;
let root: string;
const candidate = {
  configVersion: "synthetic-2026-10-22",
  doubao: {
    apiKey: "synthetic-secret",
    resourceId: "volc.bigasr.auc",
    fetchWindowSeconds: 600,
  },
  deepseek: {
    apiKey: "synthetic-secret",
    model: "synthetic-model",
    maxTokens: 1024,
  },
};
before(async () => {
  assert.ok(process.env.DATABASE_URL);
  assert.ok(process.env.REDIS_URL);
  root = await mkdtemp(join(tmpdir(), "timenook-ai-"));
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set("schema", schema);
  config = {
    environment: "test",
    host: "127.0.0.1",
    port: 3417,
    databaseUrl: url.toString(),
    redisUrl: process.env.REDIS_URL,
    redisKeyPrefix: schema,
    audioProbe: { storageRoot: root },
  };
  const migrated = spawnSync(
    process.execPath,
    ["node_modules/prisma/build/index.js", "migrate", "deploy"],
    {
      env: { ...process.env, DATABASE_URL: config.databaseUrl },
      encoding: "utf8",
    },
  );
  assert.equal(migrated.status, 0, "Isolated integration migration failed");
});
after(async () => {
  if (!config) return;
  const db = new PrismaClient({ datasourceUrl: config.databaseUrl });
  const redis = new Redis(config.redisUrl);
  try {
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    const keys = await redis.keys(`${schema}:*`);
    if (keys.length) await redis.del(...keys);
  } finally {
    await db.$disconnect();
    redis.disconnect();
    await rm(root, { recursive: true, force: true });
  }
});
async function provision() {
  const file = join(root, `${randomUUID()}.json`);
  const result = spawnSync(
    process.execPath,
    ["dist-test/src/probe/probe-cli.js", file],
    {
      env: {
        ...process.env,
        NODE_ENV: "test",
        DATABASE_URL: config.databaseUrl,
        REDIS_KEY_PREFIX: schema,
        AUDIO_PROBE_ENABLED: "local-simulator",
        AUDIO_PROBE_STORAGE_ROOT: root,
      },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0);
  return JSON.parse(await readFile(file, "utf8")) as {
    token: string;
    id: string;
    expiresAt: string;
  };
}
type App = Awaited<ReturnType<typeof createApplication>>;
function request(
  app: App,
  token: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  payload?: object,
) {
  return app.inject({
    method,
    url: `/v1/probes/${path}`,
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
}
async function sealed(app: App, token: string, seal = true) {
  const bytes = await readFile("test/fixtures/synthetic-1s.mp3");
  const created = await request(app, token, "POST", "audio/clips", {
    clientClipId: randomUUID(),
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  assert.equal(created.statusCode, 201);
  const clip = created.json().data;
  if (!seal) return clip;
  const form = (
    await request(app, token, "POST", `audio/clips/${clip.id}/upload`, {})
  ).json().data;
  const boundary = `probe-${randomUUID()}`;
  const payload = Buffer.concat([
    ...Object.entries(form.fields).map(([key, value]) =>
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`,
      ),
    ),
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="synthetic.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`,
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: form.url,
        headers: {
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        payload,
      })
    ).statusCode,
    204,
  );
  assert.equal(
    (await request(app, token, "POST", `audio/clips/${clip.id}/seal`, {}))
      .statusCode,
    201,
  );
  return clip;
}
const command = (clipId: string) => ({
  requestId: randomUUID(),
  clipId,
  inputVersion: "synthetic-v1",
  sampleKind: "synthetic",
  stoppedAt: new Date(Date.now() - 1000).toISOString(),
});

test("AI probe creates one immutable sealed input concurrently and recovers it after restart", async () => {
  const identity = await provision();
  const enabled = { ...config, aiProbe: candidate };
  const app = await createApplication(enabled);
  let id = "";
  try {
    const clip = await sealed(app, identity.token);
    const input = command(clip.id);
    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        request(app, identity.token, "POST", "ai/runs", input),
      ),
    );
    for (const response of responses) {
      assert.equal(response.statusCode, 201);
      assert.equal(response.json().data.id, input.requestId);
      assert.equal(response.json().data.state, "ready");
    }
    id = input.requestId;
    assert.equal(
      (
        await request(app, identity.token, "POST", "ai/runs", {
          ...input,
          inputVersion: "changed",
        })
      ).statusCode,
      409,
    );
    assert.equal(
      (await request(app, "invalid", "GET", `ai/runs/${id}`)).statusCode,
      401,
    );
    const other = await provision();
    assert.equal(
      (await request(app, other.token, "GET", `ai/runs/${id}`)).statusCode,
      404,
    );
    const pending = await sealed(app, identity.token, false);
    assert.equal(
      (
        await request(
          app,
          identity.token,
          "POST",
          "ai/runs",
          command(pending.id),
        )
      ).statusCode,
      409,
    );
  } finally {
    await app.close();
  }
  const restarted = await createApplication(enabled);
  try {
    const result = await request(
      restarted,
      identity.token,
      "GET",
      `ai/runs/${id}`,
    );
    assert.equal(result.statusCode, 200);
    assert.equal(result.json().data.id, id);
    assert.equal(result.json().data.originalTranscript, null);
    assert.equal(result.json().data.cost, null);
    assert.doesNotMatch(result.body, /synthetic-secret|sourceUrl/);
  } finally {
    await restarted.close();
  }
});

async function ossFixture() {
  const bytes = await readFile("test/fixtures/synthetic-1s.mp3");
  const oss = {
    bucket: "timenook-synthetic-probe",
    region: "cn-hangzhou",
    accessKeyId: "STS.synthetic",
    accessKeySecret: "synthetic-secret",
    securityToken: "synthetic-sts",
    expiresAt: new Date(Date.now() + 900000).toISOString(),
  };
  nock("https://timenook-synthetic-probe.oss-cn-hangzhou.aliyuncs.com")
    .persist()
    .get(/\/(staging|sealed)\//)
    .reply(200, bytes)
    .put(/\/staging\//, bytes)
    .reply(200, "", { etag: '"synthetic"' })
    .delete(/\/staging\//)
    .reply(204)
    .put(/\/sealed\//)
    .reply(
      200,
      "<CopyObjectResult><LastModified>2026-10-22T00:00:00Z</LastModified><ETag>synthetic</ETag></CopyObjectResult>",
      { "content-type": "application/xml" },
    );
  const enabled = {
    ...config,
    audioProbe: { ...config.audioProbe!, oss },
    aiProbe: candidate,
  };
  const identity = await provision();
  return {
    enabled,
    identity,
    async clip(app: App) {
      const created = await request(
        app,
        identity.token,
        "POST",
        "audio/clips",
        {
          clientClipId: randomUUID(),
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      );
      const id = created.json().data.id;
      assert.equal(
        (
          await request(
            app,
            identity.token,
            "POST",
            `audio/clips/${id}/seal`,
            {},
          )
        ).statusCode,
        201,
      );
      return id as string;
    },
  };
}

test("unknown ASR submission is durable before I/O, excludes concurrent submits and queries the original UUID after restart", async () => {
  const fixture = await ossFixture();
  let app: App;
  let release!: () => void;
  let entered!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const seen: string[] = [];
  const transport: typeof fetch = async (url, init) => {
    const id = new Headers(init?.headers).get("X-Api-Request-Id")!;
    seen.push(String(url));
    if (String(url).endsWith("/submit")) {
      const persisted = await request(
        app,
        fixture.identity.token,
        "GET",
        `ai/runs/${id}`,
      );
      assert.equal(persisted.json().data.state, "submitting");
      assert.equal(persisted.json().data.id, id);
      entered();
      await pending;
      throw new Error("synthetic lost response with a secret URL");
    }
    return new Response('{"result":{"text":"合成测试：约在八十年代。"}}', {
      headers: { "X-Api-Status-Code": "20000000" },
    });
  };
  app = await createApplication(fixture.enabled, { aiFetch: transport } as any);
  let id = "";
  try {
    const input = command(await fixture.clip(app));
    id = input.requestId;
    assert.equal(
      (await request(app, fixture.identity.token, "POST", "ai/runs", input))
        .statusCode,
      201,
    );
    const inFlight = request(
      app,
      fixture.identity.token,
      "POST",
      `ai/runs/${id}/advance`,
      {},
    );
    await Promise.race([
      started,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("submit not reached")), 2000),
      ),
    ]);
    assert.equal(
      (
        await request(
          app,
          fixture.identity.token,
          "POST",
          `ai/runs/${id}/advance`,
          {},
        )
      ).json().data.state,
      "submitting",
    );
    release();
    assert.equal((await inFlight).json().data.state, "unknown");
  } finally {
    release();
    await app.close();
  }
  app = await createApplication(fixture.enabled, { aiFetch: transport } as any);
  try {
    const completed = await request(
      app,
      fixture.identity.token,
      "POST",
      `ai/runs/${id}/advance`,
      {},
    );
    assert.equal(completed.json().data.state, "succeeded");
    assert.equal(
      completed.json().data.originalTranscript,
      "合成测试：约在八十年代。",
    );
    assert.ok(completed.json().data.latency.stopToTranscriptMs >= 1000);
    assert.equal(completed.json().data.cost, null);
    assert.doesNotMatch(completed.body, /secret URL|x-oss-|synthetic-secret/);
    assert.equal(
      (
        await request(
          app,
          fixture.identity.token,
          "POST",
          `ai/runs/${id}/advance`,
          {},
        )
      ).json().data.state,
      "succeeded",
    );
    assert.deepEqual(
      seen.map((url) => url.split("/").pop()),
      ["submit", "query"],
    );
  } finally {
    await app.close();
    nock.cleanAll();
  }
});

test("generation is optional, replayable and keeps original transcription separate with measured stages and provider usage", async () => {
  const fixture = await ossFixture();
  let generationCalls = 0;
  const transport: typeof fetch = async (url, init) => {
    if (String(url).endsWith("/submit"))
      return new Response(null, {
        headers: { "X-Api-Status-Code": "20000000" },
      });
    if (String(url).endsWith("/query"))
      return Response.json(
        { result: { text: "合成：约在八十年代。" } },
        { headers: { "X-Api-Status-Code": "20000000" } },
      );
    generationCalls++;
    const body = JSON.parse(String(init?.body));
    const input = JSON.parse(body.messages[1].content);
    const sourceRefs = input.sourceRefs;
    const story = body.messages[0].content.includes("第一人称结构化");
    const output = story
      ? {
          title: "合成故事",
          paragraphs: [{ text: "我记得约在八十年代。", sourceRefs }],
          theme: "合成回忆",
          reviewItems: ["具体年份待核对"],
        }
      : {
          action: "ask",
          question: "您还想补充什么？",
          intent: "specific_detail",
          sourceRefs,
          reasonCode: "DETAIL_AVAILABLE",
        };
    return Response.json({
      model: "synthetic-model",
      choices: [
        {
          finish_reason: "stop",
          message: { role: "assistant", content: JSON.stringify(output) },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    });
  };
  const app = await createApplication(fixture.enabled, { aiFetch: transport });
  try {
    const input = command(await fixture.clip(app));
    await request(app, fixture.identity.token, "POST", "ai/runs", input);
    const gen = { requestId: randomUUID(), kind: "question" };
    const path = `ai/runs/${input.requestId}`;
    assert.equal(
      (
        await request(
          app,
          fixture.identity.token,
          "POST",
          `${path}/generations`,
          gen,
        )
      ).statusCode,
      409,
    );
    assert.equal(
      (
        await request(
          app,
          fixture.identity.token,
          "POST",
          `${path}/advance`,
          {},
        )
      ).json().data.state,
      "accepted",
    );
    assert.equal(generationCalls, 0);
    await request(app, fixture.identity.token, "POST", `${path}/advance`, {});
    const question = await request(
      app,
      fixture.identity.token,
      "POST",
      `${path}/generations`,
      gen,
    );
    assert.equal(question.statusCode, 201);
    assert.equal(question.json().data.state, "succeeded");
    assert.ok(question.json().data.latency.transcriptToQuestionMs >= 0);
    assert.equal(question.json().data.cost, null);
    assert.equal(
      (
        await request(
          app,
          fixture.identity.token,
          "POST",
          `${path}/generations`,
          gen,
        )
      ).json().data.id,
      gen.requestId,
    );
    assert.equal(generationCalls, 1);
    assert.equal(
      (
        await request(
          app,
          fixture.identity.token,
          "POST",
          `${path}/generations`,
          { ...gen, kind: "story" },
        )
      ).statusCode,
      409,
    );
    const story = await request(
      app,
      fixture.identity.token,
      "POST",
      `${path}/generations`,
      { requestId: randomUUID(), kind: "story" },
    );
    assert.equal(story.json().data.state, "succeeded");
    assert.ok(story.json().data.latency.submitToStoryMs >= 0);
    const saved = (
      await request(app, fixture.identity.token, "GET", path)
    ).json().data;
    assert.equal(saved.originalTranscript, "合成：约在八十年代。");
    assert.equal(saved.generations.length, 2);
    assert.equal(saved.generations[0].usage.total_tokens, 30);
  } finally {
    await app.close();
    nock.cleanAll();
  }
});

test("invalidating an input discards a late ASR result and same-version configuration drift cannot reuse its UUID", async () => {
  const fixture = await ossFixture();
  let release!: (value: Response) => void;
  let entered!: () => void;
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const transport: typeof fetch = async (url) => {
    if (String(url).endsWith("/submit"))
      return new Response(null, {
        headers: { "X-Api-Status-Code": "20000000" },
      });
    entered();
    return new Promise<Response>((resolve) => {
      release = resolve;
    });
  };
  const app = await createApplication(fixture.enabled, { aiFetch: transport });
  let input: ReturnType<typeof command>;
  try {
    input = command(await fixture.clip(app));
    await request(app, fixture.identity.token, "POST", "ai/runs", input);
    await request(
      app,
      fixture.identity.token,
      "POST",
      `ai/runs/${input.requestId}/advance`,
      {},
    );
    const late = request(
      app,
      fixture.identity.token,
      "POST",
      `ai/runs/${input.requestId}/advance`,
      {},
    );
    await started;
    assert.equal(
      (
        await request(
          app,
          fixture.identity.token,
          "POST",
          `ai/runs/${input.requestId}/invalidate`,
          {},
        )
      ).statusCode,
      201,
    );
    release(
      Response.json(
        { result: { text: "迟到合成转录" } },
        { headers: { "X-Api-Status-Code": "20000000" } },
      ),
    );
    assert.equal((await late).json().data.state, "invalidated");
    assert.equal(
      (
        await request(
          app,
          fixture.identity.token,
          "GET",
          `ai/runs/${input.requestId}`,
        )
      ).json().data.originalTranscript,
      null,
    );
  } finally {
    release?.(new Response("{}"));
    await app.close();
  }
  const changed = await createApplication(
    {
      ...fixture.enabled,
      aiProbe: {
        ...candidate,
        deepseek: { ...candidate.deepseek, model: "different-candidate" },
      },
    },
    {
      aiFetch: async () => {
        throw new Error("must not call provider");
      },
    },
  );
  try {
    assert.equal(
      (
        await request(
          changed,
          fixture.identity.token,
          "POST",
          "ai/runs",
          input!,
        )
      ).statusCode,
      409,
    );
  } finally {
    await changed.close();
    nock.cleanAll();
  }
});

test("invalidation queued first prevents a competing generation from sending its stale transcript", async () => {
  const fixture = await ossFixture();
  let generated = 0;
  const app = await createApplication(fixture.enabled, {
    aiFetch: async (url) => {
      if (String(url).includes("deepseek")) {
        generated++;
        throw new Error("unexpected generation");
      }
      return Response.json(
        String(url).endsWith("/query") ? { result: { text: "合成讲述" } } : {},
        { headers: { "X-Api-Status-Code": "20000000" } },
      );
    },
  });
  const db = new PrismaClient({ datasourceUrl: fixture.enabled.databaseUrl });
  let release!: () => void;
  let locked!: (pid: number) => void;
  const ready = new Promise<number>((r) => {
    locked = r;
  });
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let blocker: Promise<unknown> | undefined;
  try {
    const input = command(await fixture.clip(app));
    await request(app, fixture.identity.token, "POST", "ai/runs", input);
    const path = `ai/runs/${input.requestId}`;
    await request(app, fixture.identity.token, "POST", `${path}/advance`, {});
    await request(app, fixture.identity.token, "POST", `${path}/advance`, {});
    blocker = db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT id FROM probe_ai_runs WHERE id = ${input.requestId}::uuid FOR UPDATE`;
        const [{ pid }] = await tx.$queryRaw<
          { pid: number }[]
        >`SELECT pg_backend_pid() AS pid`;
        locked(pid);
        await gate;
      },
      { timeout: 10000 },
    );
    const pid = await ready;
    async function waitForWaiters(count: number) {
      for (let n = 0; n < 100; n++) {
        const [{ waiting }] = await db.$queryRaw<
          { waiting: number }[]
        >`WITH RECURSIVE blocked AS (SELECT pid FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid)) UNION SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid = ANY(pg_blocking_pids(a.pid))) SELECT count(*)::int AS waiting FROM blocked`;
        if (waiting >= count) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(
        "Real database contention fixture did not reach its synchronization point",
      );
    }
    const invalidate = request(
      app,
      fixture.identity.token,
      "POST",
      `${path}/invalidate`,
      {},
    );
    await waitForWaiters(1);
    const generate = request(
      app,
      fixture.identity.token,
      "POST",
      `${path}/generations`,
      { requestId: randomUUID(), kind: "question" },
    );
    await waitForWaiters(2);
    release();
    await blocker;
    assert.equal((await invalidate).statusCode, 201);
    assert.equal((await generate).statusCode, 409);
    assert.equal(generated, 0);
    assert.equal(
      (await request(app, fixture.identity.token, "GET", path)).json().data
        .state,
      "invalidated",
    );
  } finally {
    release?.();
    await blocker;
    await db.$disconnect();
    await app.close();
    nock.cleanAll();
  }
});

test("no-speech cannot generate, unknown generation survives restart without resend, and metrics keep unknown outside final failure rates", async () => {
  const fixture = await ossFixture();
  const silent = new Set<string>();
  let generated = 0;
  const transport: typeof fetch = async (url, init) => {
    if (String(url).includes("deepseek")) {
      generated++;
      throw new Error("synthetic lost result");
    }
    const id = new Headers(init?.headers).get("X-Api-Request-Id")!;
    return Response.json(
      String(url).endsWith("/query")
        ? { result: { text: silent.has(id) ? " " : "合成讲述" } }
        : {},
      { headers: { "X-Api-Status-Code": "20000000" } },
    );
  };
  let app = await createApplication(fixture.enabled, { aiFetch: transport });
  let unknownPath = "";
  const gen = { requestId: randomUUID(), kind: "story" };
  try {
    for (const isSilent of [true, false]) {
      const input = command(await fixture.clip(app));
      if (isSilent) silent.add(input.requestId);
      const path = `ai/runs/${input.requestId}`;
      await request(app, fixture.identity.token, "POST", "ai/runs", input);
      await request(app, fixture.identity.token, "POST", `${path}/advance`, {});
      const result = await request(
        app,
        fixture.identity.token,
        "POST",
        `${path}/advance`,
        {},
      );
      assert.equal(
        result.json().data.state,
        isSilent ? "no_speech" : "succeeded",
      );
      const generation = await request(
        app,
        fixture.identity.token,
        "POST",
        `${path}/generations`,
        gen,
      );
      if (isSilent) {
        assert.equal(generation.statusCode, 409);
        assert.equal(generated, 0);
      } else {
        unknownPath = path;
        assert.equal(generation.json().data.state, "unknown");
        assert.equal(generation.json().data.usable, false);
        assert.equal(generation.json().data.completedAt, null);
      }
    }
  } finally {
    await app.close();
  }
  app = await createApplication(fixture.enabled, { aiFetch: transport });
  try {
    assert.equal(
      (
        await request(
          app,
          fixture.identity.token,
          "POST",
          `${unknownPath}/generations`,
          gen,
        )
      ).json().data.state,
      "unknown",
    );
    assert.equal(generated, 1);
    const response = await request(
      app,
      fixture.identity.token,
      "GET",
      "ai/metrics",
    );
    assert.equal(response.statusCode, 200);
    const metrics = response.json().data.groups[0];
    assert.equal(metrics.sampleKind, "synthetic");
    assert.equal(metrics.asr.counts.no_speech, 1);
    assert.equal(metrics.asr.counts.succeeded, 1);
    assert.equal(metrics.asr.failureRateAmongFinal, 0);
    assert.equal(metrics.generation.counts.unknown, 1);
    assert.equal(metrics.generation.failureRateAmongFinal, null);
    assert.equal(metrics.cost, null);
  } finally {
    await app.close();
    nock.cleanAll();
  }
});

test("in-flight generation is persisted once, then invalidation discards its text while retaining reported usage", async () => {
  const fixture = await ossFixture();
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let calls = 0;
  const app = await createApplication(fixture.enabled, {
    aiFetch: async (url, init) => {
      if (!String(url).includes("deepseek"))
        return Response.json(
          String(url).endsWith("/query")
            ? { result: { text: "合成讲述" } }
            : {},
          { headers: { "X-Api-Status-Code": "20000000" } },
        );
      calls++;
      const input = JSON.parse(
        JSON.parse(String(init?.body)).messages[1].content,
      );
      entered();
      await gate;
      return Response.json({
        model: "synthetic-model",
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: JSON.stringify({
                action: "ask",
                question: "您还想补充什么？",
                intent: "specific_detail",
                sourceRefs: input.sourceRefs,
                reasonCode: "DETAIL_AVAILABLE",
              }),
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      });
    },
  });
  try {
    const input = command(await fixture.clip(app));
    const path = `ai/runs/${input.requestId}`;
    await request(app, fixture.identity.token, "POST", "ai/runs", input);
    await request(app, fixture.identity.token, "POST", `${path}/advance`, {});
    await request(app, fixture.identity.token, "POST", `${path}/advance`, {});
    const gen = { requestId: randomUUID(), kind: "question" };
    const pending = request(
      app,
      fixture.identity.token,
      "POST",
      `${path}/generations`,
      gen,
    );
    await started;
    assert.equal(
      (await request(app, fixture.identity.token, "GET", path)).json().data
        .generations[0].state,
      "generating",
    );
    assert.equal(
      (
        await request(
          app,
          fixture.identity.token,
          "POST",
          `${path}/generations`,
          gen,
        )
      ).json().data.state,
      "generating",
    );
    await request(
      app,
      fixture.identity.token,
      "POST",
      `${path}/invalidate`,
      {},
    );
    release();
    const result = (await pending).json().data;
    assert.equal(result.state, "invalidated");
    assert.equal(result.output, null);
    assert.equal(result.usage.total_tokens, 30);
    assert.equal(calls, 1);
    const saved = (
      await request(app, fixture.identity.token, "GET", path)
    ).json().data;
    assert.equal(saved.originalTranscript, "合成讲述");
    assert.equal(saved.generations[0].usable, false);
    assert.equal(
      (
        await request(
          app,
          fixture.identity.token,
          "POST",
          `${path}/generations`,
          { requestId: randomUUID(), kind: "story" },
        )
      ).statusCode,
      409,
    );
  } finally {
    release?.();
    await app.close();
    nock.cleanAll();
  }
});

test("configuration/account drift and storage changes cannot resume a frozen request, and AI routes default off", async () => {
  const identity = await provision();
  const initial = await createApplication({ ...config, aiProbe: candidate });
  let input: ReturnType<typeof command>;
  try {
    input = command((await sealed(initial, identity.token)).id);
    await request(initial, identity.token, "POST", "ai/runs", input);
    assert.equal(
      (
        await request(
          initial,
          identity.token,
          "POST",
          `ai/runs/${input.requestId}/advance`,
          {},
        )
      ).statusCode,
      409,
    );
  } finally {
    await initial.close();
  }
  for (const aiProbe of [
    {
      ...candidate,
      deepseek: { ...candidate.deepseek, model: "changed-model" },
    },
    {
      ...candidate,
      doubao: { ...candidate.doubao, apiKey: "changed-account-key" },
    },
    {
      ...candidate,
      doubao: { ...candidate.doubao, resourceId: "volc.seedasr.auc" },
    },
  ]) {
    const app = await createApplication(
      { ...config, aiProbe },
      {
        aiFetch: async () => {
          throw new Error("unexpected provider network");
        },
      },
    );
    try {
      assert.equal(
        (await request(app, identity.token, "POST", "ai/runs", input!))
          .statusCode,
        409,
      );
      assert.equal(
        (
          await request(
            app,
            identity.token,
            "POST",
            `ai/runs/${input!.requestId}/advance`,
            {},
          )
        ).statusCode,
        409,
      );
    } finally {
      await app.close();
    }
  }
  const changedStorage = await createApplication({
    ...config,
    audioProbe: { storageRoot: join(root, "another") },
    aiProbe: candidate,
  });
  try {
    assert.equal(
      (
        await request(
          changedStorage,
          identity.token,
          "GET",
          `ai/runs/${input!.requestId}`,
        )
      ).statusCode,
      404,
    );
  } finally {
    await changedStorage.close();
  }
  const disabled = await createApplication(config);
  try {
    assert.equal(
      (
        await request(
          disabled,
          identity.token,
          "GET",
          `ai/runs/${input!.requestId}`,
        )
      ).statusCode,
      404,
    );
  } finally {
    await disabled.close();
  }
  await assert.rejects(
    createApplication({
      ...config,
      environment: "production",
      aiProbe: candidate,
    }),
    /non-production|production/,
  );
});

test("an expired ASR claim is queried by a second API instance and its late submit response cannot overwrite the transcript", async (t) => {
  for (const lateOutcome of ["accepted", "transport-error"]) {
    const fixture = await ossFixture();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let submits = 0;
    const transport: typeof fetch = async (url) => {
      if (String(url).endsWith("/submit")) {
        submits++;
        entered();
        await gate;
        if (lateOutcome === "transport-error")
          throw new AsrSourcePreflightError(
            "Transport error must stay unknown",
          );
        return new Response(null, {
          headers: { "X-Api-Status-Code": "20000000" },
        });
      }
      return Response.json(
        { result: { text: "租约恢复后的合成转录" } },
        { headers: { "X-Api-Status-Code": "20000000" } },
      );
    };
    const first = await createApplication(fixture.enabled, {
      aiFetch: transport,
    });
    let second: App | undefined;
    try {
      const input = command(await fixture.clip(first));
      const path = `ai/runs/${input.requestId}`;
      await request(first, fixture.identity.token, "POST", "ai/runs", input);
      const pending = request(
        first,
        fixture.identity.token,
        "POST",
        `${path}/advance`,
        {},
      );
      await started;
      const future = Date.now() + 31000;
      t.mock.method(Date, "now", () => future);
      second = await createApplication(fixture.enabled, { aiFetch: transport });
      assert.equal(
        (await request(second, fixture.identity.token, "GET", path)).json().data
          .state,
        "unknown",
      );
      assert.equal(
        (
          await request(
            second,
            fixture.identity.token,
            "POST",
            `${path}/advance`,
            {},
          )
        ).json().data.originalTranscript,
        "租约恢复后的合成转录",
      );
      release();
      assert.equal((await pending).json().data.state, "succeeded");
      const saved = (
        await request(second, fixture.identity.token, "GET", path)
      ).json().data;
      assert.equal(saved.submitAttempts, 1);
      assert.equal(saved.originalTranscript, "租约恢复后的合成转录");
      assert.equal(submits, 1);
    } finally {
      t.mock.restoreAll();
      release?.();
      await second?.close();
      await first.close();
      nock.cleanAll();
    }
  }
});

test("revoking the probe identity while ASR is in flight discards the result and denies subsequent reads", async () => {
  const fixture = await ossFixture();
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const app = await createApplication(fixture.enabled, {
    aiFetch: async (url) => {
      if (String(url).endsWith("/submit"))
        return new Response(null, {
          headers: { "X-Api-Status-Code": "20000000" },
        });
      entered();
      await gate;
      return Response.json(
        { result: { text: "不得返回的迟到私密转录" } },
        { headers: { "X-Api-Status-Code": "20000000" } },
      );
    },
  });
  const redis = new Redis(config.redisUrl);
  try {
    const input = command(await fixture.clip(app));
    const path = `ai/runs/${input.requestId}`;
    await request(app, fixture.identity.token, "POST", "ai/runs", input);
    await request(app, fixture.identity.token, "POST", `${path}/advance`, {});
    const pending = request(
      app,
      fixture.identity.token,
      "POST",
      `${path}/advance`,
      {},
    );
    await started;
    // External identity store revocation fixture; all content assertions use HTTP.
    await redis.del(
      `${schema}:probe:session:${createHash("sha256").update(fixture.identity.token).digest("hex")}`,
    );
    release();
    const result = await pending;
    assert.equal(result.statusCode, 409);
    assert.doesNotMatch(result.body, /私密转录/);
    assert.equal(
      (await request(app, fixture.identity.token, "GET", path)).statusCode,
      401,
    );
  } finally {
    release?.();
    redis.disconnect();
    await app.close();
    nock.cleanAll();
  }
});

test("a source window expiring before transport restores ready and retries the same UUID without recording a submit", async (t) => {
  const fixture = await ossFixture();
  const calls: { action: string; id: string }[] = [];
  const app = await createApplication(fixture.enabled, {
    aiFetch: async (url, init) => {
      calls.push({
        action: String(url).split("/").pop()!,
        id: new Headers(init?.headers).get("X-Api-Request-Id")!,
      });
      return Response.json(
        String(url).endsWith("/query")
          ? { result: { text: "源窗重签后的合成转录" } }
          : {},
        { headers: { "X-Api-Status-Code": "20000000" } },
      );
    },
  });
  const db = new PrismaClient({ datasourceUrl: fixture.enabled.databaseUrl });
  let release!: () => void;
  let locked!: (pid: number) => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<number>((resolve) => {
    locked = resolve;
  });
  let blocker: Promise<unknown> | undefined;
  try {
    const input = command(await fixture.clip(app));
    const path = `ai/runs/${input.requestId}`;
    await request(app, fixture.identity.token, "POST", "ai/runs", input);
    blocker = db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT id FROM probe_ai_runs WHERE id = ${input.requestId}::uuid FOR UPDATE`;
        const [{ pid }] = await tx.$queryRaw<
          { pid: number }[]
        >`SELECT pg_backend_pid() AS pid`;
        locked(pid);
        await gate;
      },
      { timeout: 10000 },
    );
    const pid = await ready;
    const pending = request(
      app,
      fixture.identity.token,
      "POST",
      `${path}/advance`,
      {},
    );
    let waiting = false;
    for (let n = 0; n < 100; n++) {
      const [{ count }] = await db.$queryRaw<
        { count: number }[]
      >`SELECT count(*)::int AS count FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))`;
      if (count) {
        waiting = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(
      waiting,
      "Claim must wait after the real OSS SDK has signed the source",
    );
    const delayed = Date.now() + 6000;
    t.mock.method(Date, "now", () => delayed);
    release();
    await blocker;
    const response = await pending;
    assert.equal(response.statusCode, 201);
    assert.equal(response.json().data.state, "ready");
    assert.equal(response.json().data.submitAttempts, 0);
    assert.equal(response.json().data.submittedAt, null);
    assert.deepEqual(calls, []);
    const persisted = (
      await request(app, fixture.identity.token, "GET", path)
    ).json().data;
    assert.equal(persisted.state, "ready");
    assert.equal(
      (
        await request(
          app,
          fixture.identity.token,
          "POST",
          `${path}/advance`,
          {},
        )
      ).json().data.state,
      "accepted",
    );
    assert.equal(
      (
        await request(
          app,
          fixture.identity.token,
          "POST",
          `${path}/advance`,
          {},
        )
      ).json().data.originalTranscript,
      "源窗重签后的合成转录",
    );
    assert.deepEqual(calls, [
      { action: "submit", id: input.requestId },
      { action: "query", id: input.requestId },
    ]);
    assert.equal(
      (await request(app, fixture.identity.token, "GET", path)).json().data
        .submitAttempts,
      1,
    );
  } finally {
    t.mock.restoreAll();
    release?.();
    await blocker;
    await db.$disconnect();
    await app.close();
    nock.cleanAll();
  }
});

test("a finish decision is a known terminal result without a usable question or question latency", async () => {
  const fixture = await ossFixture();
  let generationCalls = 0;
  const output = {
    action: "finish",
    question: null,
    intent: null,
    sourceRefs: [],
    reasonCode: "ENOUGH_DETAIL",
  };
  const app = await createApplication(fixture.enabled, {
    aiFetch: async (url) => {
      if (!String(url).includes("deepseek"))
        return Response.json(
          String(url).endsWith("/query")
            ? { result: { text: "合成讲述已经完整。" } }
            : {},
          { headers: { "X-Api-Status-Code": "20000000" } },
        );
      generationCalls++;
      return Response.json({
        model: "synthetic-model",
        choices: [
          {
            finish_reason: "stop",
            message: { role: "assistant", content: JSON.stringify(output) },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      });
    },
  });
  try {
    const input = command(await fixture.clip(app));
    const path = `ai/runs/${input.requestId}`;
    await request(app, fixture.identity.token, "POST", "ai/runs", input);
    await request(app, fixture.identity.token, "POST", `${path}/advance`, {});
    await request(app, fixture.identity.token, "POST", `${path}/advance`, {});
    const generation = { requestId: randomUUID(), kind: "question" };
    for (let replay = 0; replay < 2; replay++) {
      const response = await request(
        app,
        fixture.identity.token,
        "POST",
        `${path}/generations`,
        generation,
      );
      assert.equal(response.statusCode, 201);
      assert.equal(response.json().data.state, "finished");
      assert.equal(response.json().data.usable, false);
      assert.equal(response.json().data.latency.transcriptToQuestionMs, null);
      assert.deepEqual(response.json().data.output, output);
    }
    assert.equal(generationCalls, 1);
    const metrics = (
      await request(app, fixture.identity.token, "GET", "ai/metrics")
    ).json().data;
    assert.deepEqual(metrics.groups[0].generation, {
      counts: { finished: 1 },
      total: 1,
      finalCount: 1,
      failureRateAmongFinal: 0,
    });
    const saved = (
      await request(app, fixture.identity.token, "GET", path)
    ).json().data;
    assert.equal(saved.originalTranscript, "合成讲述已经完整。");
    assert.equal(saved.generations[0].usable, false);
  } finally {
    await app.close();
    nock.cleanAll();
  }
});

test("v1 synthetic persisted results remain readable but their UUIDs cannot run the v2 prompt or output contract", async () => {
  const fixture = await ossFixture();
  let externalCalls = 0;
  const app = await createApplication(fixture.enabled, {
    aiFetch: async () => {
      externalCalls++;
      throw new Error("Historical inputs must not enter provider transport");
    },
  });
  const db = new PrismaClient({ datasourceUrl: fixture.enabled.databaseUrl });
  // Synthetic historical fixture copied from 6c41f37's persisted shape; not a backup restore drill.
  const historicalConfiguration = {
    version: "synthetic-2026-10-22",
    doubao: {
      protocol: "bigmodel-async-v3-api-key",
      resourceId: "volc.bigasr.auc",
      fetchWindowSeconds: 600,
    },
    deepseek: {
      model: "synthetic-model",
      maxTokens: 1024,
      thinking: "disabled",
    },
    promptVersion: "t03-v1",
  };
  const historicalHash = createHash("sha256")
    .update(
      JSON.stringify({
        configuration: historicalConfiguration,
        credentials: {
          doubao: "synthetic-secret",
          deepseek: "synthetic-secret",
        },
      }),
    )
    .digest("hex");
  try {
    const clipId = await fixture.clip(app);
    const completed = command(clipId);
    const pending = command(clipId);
    for (const input of [completed, pending]) {
      await request(app, fixture.identity.token, "POST", "ai/runs", input);
      await db.probeAiRun.update({
        where: { id: input.requestId },
        data: {
          configuration: historicalConfiguration,
          configurationHash: historicalHash,
        },
      });
    }
    const transcriptHash = createHash("sha256")
      .update("合成历史原转录")
      .digest("hex");
    const historicalOutput = {
      status: "ok",
      title: "合成旧稿",
      paragraphs: [
        {
          text: "合成历史原转录",
          sources: [{ clipId, transcriptHash, quote: "合成历史原转录" }],
        },
      ],
      uncertainties: [],
    };
    await db.probeAiRun.update({
      where: { id: completed.requestId },
      data: {
        state: "succeeded",
        originalTranscript: "合成历史原转录",
        completedAt: new Date(),
      },
    });
    await db.probeAiGeneration.create({
      data: {
        id: randomUUID(),
        runId: completed.requestId,
        kind: "story",
        transcriptHash,
        state: "succeeded",
        output: historicalOutput,
        completedAt: new Date(),
      },
    });
    const read = await request(
      app,
      fixture.identity.token,
      "GET",
      `ai/runs/${completed.requestId}`,
    );
    assert.equal(read.statusCode, 200);
    assert.deepEqual(read.json().data.configuration, historicalConfiguration);
    assert.deepEqual(read.json().data.generations[0].output, historicalOutput);
    assert.equal(read.json().data.originalTranscript, "合成历史原转录");
    for (const input of [completed, pending]) {
      assert.equal(
        (await request(app, fixture.identity.token, "POST", "ai/runs", input))
          .statusCode,
        409,
      );
    }
    assert.equal(
      (
        await request(
          app,
          fixture.identity.token,
          "POST",
          `ai/runs/${pending.requestId}/advance`,
          {},
        )
      ).statusCode,
      409,
    );
    assert.equal(
      (
        await request(
          app,
          fixture.identity.token,
          "POST",
          `ai/runs/${completed.requestId}/generations`,
          { requestId: randomUUID(), kind: "story" },
        )
      ).statusCode,
      409,
    );
    const current = (
      await request(
        app,
        fixture.identity.token,
        "POST",
        "ai/runs",
        command(clipId),
      )
    ).json().data;
    assert.equal(current.configuration.promptVersion, "t03-v2");
    assert.equal(current.configuration.outputContract, "t03-v2");
    assert.equal(externalCalls, 0);
  } finally {
    await db.$disconnect();
    await app.close();
    nock.cleanAll();
  }
});

test("a relay endpoint change cannot replay or advance a frozen run with the same model and credentials", async () => {
  const fixture = await ossFixture();
  const aiProbe = {
    ...candidate,
    deepseek: { ...candidate.deepseek, baseUrl: "https://cf.api.fan/v1/" },
  };
  const initial = await createApplication({ ...fixture.enabled, aiProbe });
  let input!: ReturnType<typeof command>;
  let frozenConfiguration: Record<string, any>;
  try {
    input = command(await fixture.clip(initial));
    const created = await request(
      initial,
      fixture.identity.token,
      "POST",
      "ai/runs",
      input,
    );
    assert.equal(created.statusCode, 201);
    frozenConfiguration = created.json().data.configuration;
  } finally {
    await initial.close();
  }
  let calls = 0;
  for (const baseUrl of [
    "https://other-relay.synthetic/v1",
    "https://cf.api.fan/other/v1",
  ]) {
    const changed = await createApplication(
      {
        ...fixture.enabled,
        aiProbe: { ...aiProbe, deepseek: { ...aiProbe.deepseek, baseUrl } },
      },
      {
        aiFetch: async () => {
          calls++;
          return new Response(null, {
            headers: { "X-Api-Status-Code": "20000000" },
          });
        },
      },
    );
    try {
      assert.equal(
        (
          await request(
            changed,
            fixture.identity.token,
            "POST",
            "ai/runs",
            input,
          )
        ).statusCode,
        409,
      );
      assert.equal(
        (
          await request(
            changed,
            fixture.identity.token,
            "POST",
            `ai/runs/${input.requestId}/advance`,
            {},
          )
        ).statusCode,
        409,
      );
    } finally {
      await changed.close();
    }
  }
  const equivalent = await createApplication({
    ...fixture.enabled,
    aiProbe: {
      ...aiProbe,
      deepseek: { ...aiProbe.deepseek, baseUrl: "https://cf.api.fan/v1" },
    },
  });
  try {
    assert.equal(
      (
        await request(
          equivalent,
          fixture.identity.token,
          "POST",
          "ai/runs",
          input,
        )
      ).statusCode,
      201,
    );
    assert.equal(
      frozenConfiguration!.deepseek.baseUrl,
      "https://cf.api.fan/v1",
    );
    assert.equal(calls, 0);
  } finally {
    await equivalent.close();
    nock.cleanAll();
  }
});
