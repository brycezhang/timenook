import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, after, test } from "node:test";
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import { createApplication } from "../src/application";
import type { ApiConfig } from "../src/config";
const schema = `t04_${randomUUID().replaceAll("-", "")}`;
let config: ApiConfig, root: string;
before(async () => {
  assert.ok(process.env.DATABASE_URL);
  assert.ok(process.env.REDIS_URL);
  root = await mkdtemp(join(tmpdir(), "t04-api-"));
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set("schema", schema);
  config = {
    environment: "test",
    host: "127.0.0.1",
    port: 0,
    databaseUrl: url.toString(),
    redisUrl: process.env.REDIS_URL,
    redisKeyPrefix: schema,
    audioProbe: { storageRoot: root },
  };
  const r = spawnSync(
    process.execPath,
    ["node_modules/prisma/build/index.js", "migrate", "deploy"],
    {
      env: { ...process.env, DATABASE_URL: config.databaseUrl },
      encoding: "utf8",
    },
  );
  assert.equal(r.status, 0, "Isolated migration failed");
});
after(async () => {
  if (!config) return;
  const db = new PrismaClient({ datasourceUrl: config.databaseUrl }),
    redis = new Redis(config.redisUrl);
  try {
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    const keys = await redis.keys(`${schema}:*`);
    if (keys.length) await redis.del(...keys);
    assert.equal((await redis.keys(`${schema}:*`)).length, 0);
  } finally {
    await db.$disconnect();
    redis.disconnect();
    await rm(root, { recursive: true, force: true });
  }
});
async function identity(ttl = 3600) {
  const file = join(root, `identity-${randomUUID()}.json`);
  const r = spawnSync(
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
        AUDIO_PROBE_SESSION_TTL: String(ttl),
      },
      encoding: "utf8",
    },
  );
  assert.equal(r.status, 0);
  return JSON.parse(await readFile(file, "utf8")) as { token: string };
}
function request(
  app: Awaited<ReturnType<typeof createApplication>>,
  token: string,
  method: "GET" | "POST",
  url: string,
  payload?: object,
) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
}
async function clip(
  app: Awaited<ReturnType<typeof createApplication>>,
  token: string,
  seal = true,
) {
  const audio = await readFile("test/fixtures/synthetic-1s.mp3");
  const created = await request(app, token, "POST", "/v1/probes/audio/clips", {
    clientClipId: randomUUID(),
    bytes: audio.length,
    sha256: createHash("sha256").update(audio).digest("hex"),
  });
  assert.equal(created.statusCode, 201);
  const id = created.json().data.id;
  if (seal) {
    const form = (
      await request(
        app,
        token,
        "POST",
        `/v1/probes/audio/clips/${id}/upload`,
        {},
      )
    ).json().data;
    const boundary = `t04-${randomUUID()}`;
    const payload = Buffer.concat([
      ...Object.entries(form.fields as Record<string, string>).map(
        ([key, value]) =>
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`,
          ),
      ),
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="synthetic.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`,
      ),
      audio,
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
      (
        await request(
          app,
          token,
          "POST",
          `/v1/probes/audio/clips/${id}/seal`,
          {},
        )
      ).statusCode,
      201,
    );
  }
  return { id, audio };
}

test("paper entries replay one random stable id for an owned sealed clip and survive restart", async () => {
  const owner = await identity(),
    app = await createApplication(config);
  let entryId: string, clipId: string;
  try {
    const sealed = await clip(app, owner.token);
    clipId = sealed.id;
    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        request(app, owner.token, "POST", "/v1/probes/print/entries", {
          clipId,
        }),
      ),
    );
    for (const r of responses) assert.equal(r.statusCode, 201);
    entryId = responses[0].json().data.id;
    assert.match(entryId, /^[A-Za-z0-9_-]{22}$/);
    assert.equal(new Set(responses.map((r) => r.json().data.id)).size, 1);
    assert.deepEqual(Object.keys(responses[0].json().data), ["id"]);
  } finally {
    await app.close();
  }
  const restarted = await createApplication(config);
  try {
    assert.equal(
      (
        await request(
          restarted,
          owner.token,
          "POST",
          "/v1/probes/print/entries",
          { clipId: clipId! },
        )
      ).json().data.id,
      entryId!,
    );
    const found = await request(
      restarted,
      owner.token,
      "GET",
      `/v1/probes/print/entries/${entryId!}`,
    );
    assert.equal(found.statusCode, 200);
    assert.equal(found.json().data.clipId, clipId!);
    assert.equal(found.headers["cache-control"], "private, no-store");
  } finally {
    await restarted.close();
  }
});

test("paper entries reject pending, foreign, anonymous, expired and wrong-storage access without private metadata", async () => {
  const owner = await identity(),
    foreign = await identity(),
    app = await createApplication(config);
  try {
    const pending = await clip(app, owner.token, false);
    assert.equal(
      (
        await request(app, owner.token, "POST", "/v1/probes/print/entries", {
          clipId: pending.id,
        })
      ).statusCode,
      409,
    );
    assert.equal(
      (
        await request(app, foreign.token, "POST", "/v1/probes/print/entries", {
          clipId: pending.id,
        })
      ).statusCode,
      404,
    );
    const sealed = await clip(app, owner.token),
      entry = (
        await request(app, owner.token, "POST", "/v1/probes/print/entries", {
          clipId: sealed.id,
        })
      ).json().data;
    const url = `/v1/probes/print/entries/${entry.id}`;
    const anonymous = await app.inject({ method: "GET", url });
    assert.equal(anonymous.statusCode, 401);
    assert.ok(!anonymous.body.includes(sealed.id));
    const denied = await request(app, foreign.token, "GET", url);
    assert.equal(denied.statusCode, 404);
    assert.ok(!denied.body.includes(sealed.id));
    const other = await createApplication({
      ...config,
      audioProbe: { storageRoot: join(root, "other") },
    });
    try {
      assert.equal(
        (await request(other, owner.token, "GET", url)).statusCode,
        404,
      );
    } finally {
      await other.close();
    }
    const short = await identity(2),
      shortClip = await clip(app, short.token);
    const shortEntry = (
      await request(app, short.token, "POST", "/v1/probes/print/entries", {
        clipId: shortClip.id,
      })
    ).json().data;
    await new Promise((r) => setTimeout(r, 2100));
    assert.equal(
      (
        await request(
          app,
          short.token,
          "GET",
          `/v1/probes/print/entries/${shortEntry.id}`,
        )
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await request(
          app,
          short.token,
          "GET",
          `/v1/probes/audio/clips/${shortClip.id}/content`,
        )
      ).statusCode,
      401,
    );
  } finally {
    await app.close();
  }
  const disabled = await createApplication({
    ...config,
    audioProbe: undefined,
  });
  try {
    assert.equal(
      (
        await disabled.inject({
          method: "POST",
          url: "/v1/probes/print/entries",
          payload: {},
        })
      ).statusCode,
      404,
    );
  } finally {
    await disabled.close();
  }
  await assert.rejects(
    createApplication({ ...config, environment: "production" }),
    /probe.*production/i,
  );
});

test("actual raster-decoded paper QR resolves through controlled HTTP to exactly its synthetic sealed audio", async () => {
  const { writeFile, mkdir } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const artifact = process.env.T04_ARTIFACT_DIR
    ? resolve(process.env.T04_ARTIFACT_DIR)
    : join(root, "paper-artifact");
  await mkdir(artifact, { recursive: true, mode: 0o700 });
  const owner = await identity(),
    app = await createApplication(config);
  try {
    const sealed = await clip(app, owner.token),
      entry = (
        await request(app, owner.token, "POST", "/v1/probes/print/entries", {
          clipId: sealed.id,
        })
      ).json().data;
    function cli(args: string[]) {
      return spawnSync(
        process.execPath,
        [resolve("../../scripts/print-probe/cli.mjs"), ...args],
        {
          env: { ...process.env, PRINT_PROBE_ENABLED: "synthetic-local" },
          encoding: "utf8",
          timeout: 90000,
        },
      );
    }
    const photo = join(artifact, "photo"),
      bookFile = join(artifact, "book.json"),
      bookDir = join(artifact, "book"),
      pages = join(artifact, "pages");
    const image = cli([
      "photo",
      resolve("../../tests/print-probe/fixtures/synthetic.heic"),
      photo,
      "96",
      "64",
    ]);
    assert.equal(image.status, 0, image.stderr);
    const prose =
      "春天的清晨，我沿着河岸慢慢走过，记得岸边有一棵老树。那时的生活简单，偶尔下雨，我们便在屋檐下等候。日子一点一点过去，回忆留在了心里。";
    await writeFile(
      bookFile,
      JSON.stringify({
        scope: "synthetic-local-probe",
        title: "河岸回忆 合成试验样书",
        entryBaseUrl: "http://127.0.0.1:4310/timenook/v1/probes/print/entries/",
        chapters: [
          {
            title: "第一章 沿着河岸",
            paragraphs: [prose.repeat(45), "这段长文完整结束。"],
          },
          {
            title: "第二章 照片与原声",
            paragraphs: ["这是合成色块与合成声音，只用于本地技术验证。"],
            photoDirectory: photo,
            entryId: entry.id,
          },
        ],
      }),
      { mode: 0o600 },
    );
    const rendered = cli(["book", bookFile, bookDir]);
    assert.equal(rendered.status, 0, rendered.stderr);
    const inspected = cli(["inspect", join(bookDir, "book.pdf"), pages]);
    assert.equal(inspected.status, 0, inspected.stderr);
    const report = JSON.parse(
      await readFile(join(pages, "inspection.json"), "utf8"),
    ) as { pages: { qr: string[] }[] };
    const codes = report.pages.flatMap((p) => p.qr);
    assert.equal(codes.length, 1);
    const decoded = new URL(codes[0]);
    assert.equal(decoded.origin, "http://127.0.0.1:4310");
    assert.equal(decoded.search, "");
    assert.equal(decoded.hash, "");
    assert.match(
      decoded.pathname,
      /^\/timenook\/v1\/probes\/print\/entries\/[A-Za-z0-9_-]{22}$/,
    );
    // The local test applies ADR 0009's Nginx prefix rewrite; no public deployment is claimed.
    const route = decoded.pathname.slice("/timenook".length);
    assert.equal(
      (await app.inject({ method: "GET", url: route })).statusCode,
      401,
    );
    const resolved = await request(app, owner.token, "GET", route);
    assert.equal(resolved.statusCode, 200);
    const playback = await request(
      app,
      owner.token,
      "GET",
      `/v1/probes/audio/clips/${resolved.json().data.clipId}/content`,
    );
    assert.equal(playback.statusCode, 200);
    assert.deepEqual(playback.rawPayload, sealed.audio);
    assert.equal(playback.headers["cache-control"], "private, no-store");
    await writeFile(
      join(artifact, "http-proof.json"),
      JSON.stringify(
        {
          decodedQr: codes[0],
          anonymousStatus: 401,
          authorizedEntryStatus: 200,
          playbackStatus: 200,
          audioSha256: createHash("sha256")
            .update(playback.rawPayload)
            .digest("hex"),
          scope:
            "isolated local PostgreSQL/Redis; prefix rewrite modeled; identity and mapping cleaned after test",
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  } finally {
    await app.close();
  }
});
