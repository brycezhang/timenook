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
import { LocalProbeObjects } from "../src/probe/local-objects";
import type { ApiConfig } from "../src/config";

const schema = `t02_${randomUUID().replaceAll("-", "")}`;
let config: ApiConfig;
let root: string;
before(async () => {
  assert.ok(process.env.DATABASE_URL, "Real PostgreSQL is required");
  assert.ok(process.env.REDIS_URL, "Real Redis is required");
  root = await mkdtemp(join(tmpdir(), "timenook-probe-"));
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set("schema", schema);
  config = {
    environment: "test",
    host: "127.0.0.1",
    port: 3417,
    databaseUrl: url.toString(),
    redisUrl: process.env.REDIS_URL,
    redisKeyPrefix: schema,
  };
  const migrated = spawnSync(
    process.execPath,
    ["node_modules/prisma/build/index.js", "migrate", "deploy"],
    {
      env: { ...process.env, DATABASE_URL: config.databaseUrl },
      encoding: "utf8",
    },
  );
  assert.equal(
    migrated.status,
    0,
    "Isolated integration schema migration failed",
  );
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

test("audio probe is absent by default and cannot be enabled in production", async () => {
  const app = await createApplication(config);
  try {
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/v1/probes/audio/clips",
          payload: {},
        })
      ).statusCode,
      404,
    );
  } finally {
    await app.close();
  }
  const invalid = {
    ...config,
    environment: "production",
    audioProbe: { storageRoot: root },
  } as ApiConfig;
  await assert.rejects(createApplication(invalid), /probe.*production/i);
});

async function provision(ttl = 3600) {
  const output = join(root, `session-${randomUUID()}.json`);
  const result = spawnSync(
    process.execPath,
    ["dist-test/src/probe/probe-cli.js", output],
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
  assert.equal(
    result.status,
    0,
    "Probe operator CLI should provision a private test identity",
  );
  assert.doesNotMatch(result.stdout, /token|p2_/);
  return { ...JSON.parse(await readFile(output, "utf8")), file: output } as {
    token: string;
    id: string;
    expiresAt: string;
    file: string;
  };
}
const clipCommand = () => ({
  clientClipId: randomUUID(),
  bytes: 100,
  sha256: "a".repeat(64),
});
function request(
  app: Awaited<ReturnType<typeof createApplication>>,
  token: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  payload?: object,
) {
  return app.inject({
    method,
    url: `/v1/probes/audio${path}`,
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
}
test("only operator-provisioned probe identities can create clips, independent of product sessions", async () => {
  const identity = await provision();
  const app = await createApplication({
    ...config,
    audioProbe: { storageRoot: root },
  });
  try {
    assert.equal(
      (await request(app, "invalid", "POST", "/clips", clipCommand()))
        .statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: "/v1/users/me",
          headers: { authorization: `Bearer ${identity.token}` },
        })
      ).statusCode,
      401,
    );
    const created = await request(
      app,
      identity.token,
      "POST",
      "/clips",
      clipCommand(),
    );
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().data.state, "pending");
    assert.equal(created.json().data.storage, "local-simulator");
    assert.equal(created.headers["cache-control"], "no-store");
    assert.equal(
      (await request(app, identity.token, "POST", "/sessions", {})).statusCode,
      404,
    );
  } finally {
    await app.close();
  }
});

test("clip creation replays one stable identity concurrently and survives an API restart", async () => {
  const identity = await provision();
  const enabled = { ...config, audioProbe: { storageRoot: root } };
  const app = await createApplication(enabled);
  const command = clipCommand();
  let id: string;
  try {
    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        request(app, identity.token, "POST", "/clips", command),
      ),
    );
    for (const response of responses) assert.equal(response.statusCode, 201);
    id = responses[0].json().data.id;
    assert.equal(new Set(responses.map((r) => r.json().data.id)).size, 1);
    assert.equal(
      (
        await request(app, identity.token, "POST", "/clips", {
          ...command,
          bytes: 101,
        })
      ).statusCode,
      409,
    );
  } finally {
    await app.close();
  }
  const restarted = await createApplication(enabled);
  try {
    assert.equal(
      (
        await request(restarted, identity.token, "POST", "/clips", command)
      ).json().data.id,
      id!,
    );
  } finally {
    await restarted.close();
  }
});

function formUpload(
  app: Awaited<ReturnType<typeof createApplication>>,
  form: { url: string; fields: Record<string, string> },
  bytes: Buffer,
  overrides: Record<string, string> = {},
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
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload,
  });
}
test("short-lived upload form permits only its exact staging key and length; upload success stays pending", async () => {
  const identity = await provision();
  const app = await createApplication({
    ...config,
    audioProbe: { storageRoot: root, uploadTtlSeconds: 1 },
  });
  try {
    const created = (
      await request(app, identity.token, "POST", "/clips", clipCommand())
    ).json().data;
    const issued = await request(
      app,
      identity.token,
      "POST",
      `/clips/${created.id}/upload`,
      {},
    );
    assert.equal(issued.statusCode, 201);
    const form = issued.json().data;
    const policy = JSON.parse(
      Buffer.from(form.fields.policy, "base64").toString(),
    );
    assert.ok(
      policy.conditions.some(
        (c: string[]) =>
          JSON.stringify(c) === JSON.stringify(["eq", "$key", form.fields.key]),
      ),
    );
    assert.deepEqual(
      policy.conditions.find((c: string[]) => c[0] === "content-length-range"),
      ["content-length-range", 100, 100],
    );
    assert.equal(
      (
        await formUpload(app, form, Buffer.alloc(100), {
          key: form.fields.key.replace("staging", "sealed"),
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (await formUpload(app, form, Buffer.alloc(101))).statusCode,
      400,
    );
    assert.equal(
      (await formUpload(app, form, Buffer.alloc(100))).statusCode,
      204,
    );
    assert.equal(
      (await request(app, identity.token, "GET", `/clips/${created.id}`)).json()
        .data.state,
      "pending",
    );
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(
      (await formUpload(app, form, Buffer.alloc(100))).statusCode,
      403,
    );
  } finally {
    await app.close();
  }
});

async function uploaded(
  app: Awaited<ReturnType<typeof createApplication>>,
  token: string,
  audio: Buffer,
) {
  const command = {
    clientClipId: randomUUID(),
    bytes: audio.length,
    sha256: createHash("sha256").update(audio).digest("hex"),
  };
  const created = await request(app, token, "POST", "/clips", command);
  assert.equal(
    created.statusCode,
    201,
    JSON.stringify({
      stage: "create clip",
      status: created.statusCode,
      error: created.json().error?.code,
    }),
  );
  const clip = created.json().data;
  const issued = await request(
    app,
    token,
    "POST",
    `/clips/${clip.id}/upload`,
    {},
  );
  assert.equal(
    issued.statusCode,
    201,
    JSON.stringify({
      stage: "issue upload form",
      status: issued.statusCode,
      error: issued.json().error?.code,
    }),
  );
  const form = issued.json().data;
  assert.equal((await formUpload(app, form, audio)).statusCode, 204);
  return { clip, form };
}
test("a real decodable MP3 is sealed once with independently known hash and duration after concurrent completion", async () => {
  const audio = await readFile("test/fixtures/synthetic-1s.mp3");
  const identity = await provision();
  const enabled = { ...config, audioProbe: { storageRoot: root } };
  const app = await createApplication(enabled);
  let clip: { id: string };
  try {
    const uploadedClip = await uploaded(app, identity.token, audio);
    clip = uploadedClip.clip;
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        request(app, identity.token, "POST", `/clips/${clip.id}/seal`, {}),
      ),
    );
    for (const result of results) {
      assert.equal(result.statusCode, 201);
      assert.equal(result.json().data.state, "sealed");
      assert.equal(
        result.json().data.sha256,
        "11acbbcff6041a9f144e26d84400ec07264bb42885c3473a380cee08e75d1016",
      );
      assert.equal(result.json().data.durationMs, 1080);
    }
    assert.equal(
      (await formUpload(app, uploadedClip.form, audio)).statusCode,
      409,
    );
  } finally {
    await app.close();
  }
  const restarted = await createApplication(enabled);
  try {
    assert.equal(
      (
        await request(restarted, identity.token, "GET", `/clips/${clip!.id}`)
      ).json().data.state,
      "sealed",
    );
  } finally {
    await restarted.close();
  }
});

test("private playback supports bounded Range while hiding foreign clips and expiring access", async () => {
  const audio = await readFile("test/fixtures/synthetic-1s.mp3");
  const identity = await provision(2);
  const foreign = await provision();
  const app = await createApplication({
    ...config,
    audioProbe: { storageRoot: root },
  });
  try {
    const { clip } = await uploaded(app, identity.token, audio);
    assert.equal(
      (await request(app, identity.token, "GET", `/clips/${clip.id}/content`))
        .statusCode,
      409,
    );
    await request(app, identity.token, "POST", `/clips/${clip.id}/seal`, {});
    const url = `/v1/probes/audio/clips/${clip.id}/content`;
    assert.equal((await app.inject({ method: "GET", url })).statusCode, 401);
    assert.equal(
      (await request(app, foreign.token, "GET", `/clips/${clip.id}/content`))
        .statusCode,
      404,
    );
    const range = await app.inject({
      method: "GET",
      url,
      headers: {
        authorization: `Bearer ${identity.token}`,
        range: "bytes=10-29",
      },
    });
    assert.equal(range.statusCode, 206);
    assert.deepEqual(range.rawPayload, audio.subarray(10, 30));
    assert.equal(range.headers["content-range"], `bytes 10-29/${audio.length}`);
    assert.equal(range.headers["cache-control"], "private, no-store");
    const unsatisfiable = await app.inject({
      method: "GET",
      url,
      headers: {
        authorization: `Bearer ${identity.token}`,
        range: "bytes=999999-",
      },
    });
    assert.equal(unsatisfiable.statusCode, 416);
    assert.equal(
      unsatisfiable.headers["content-range"],
      `bytes */${audio.length}`,
    );
    const full = await request(
      app,
      identity.token,
      "GET",
      `/clips/${clip.id}/content`,
    );
    assert.deepEqual(full.rawPayload, audio);
    await new Promise((resolve) => setTimeout(resolve, 2100));
    assert.equal(
      (await request(app, identity.token, "GET", `/clips/${clip.id}/content`))
        .statusCode,
      401,
    );
  } finally {
    await app.close();
  }
});

test("copy corruption never becomes sealed and a retry reuses the saved input", async () => {
  const audio = await readFile("test/fixtures/synthetic-1s.mp3");
  const identity = await provision();
  const objects = new LocalProbeObjects(root);
  let corrupt = true;
  const storage = {
    put: objects.put.bind(objects),
    putSnapshot: objects.putSnapshot.bind(objects),
    read: objects.read.bind(objects),
    remove: objects.remove.bind(objects),
    async copy(source: string, target: string) {
      await objects.copy(source, target);
      if (corrupt) await objects.put(target, Buffer.from("corrupt-copy"));
    },
  };
  const app = await createApplication(
    { ...config, audioProbe: { storageRoot: root } },
    { probeObjects: storage },
  );
  try {
    const { clip } = await uploaded(app, identity.token, audio);
    const rejected = await request(
      app,
      identity.token,
      "POST",
      `/clips/${clip.id}/seal`,
      {},
    );
    assert.equal(rejected.statusCode, 422);
    assert.equal(rejected.json().error.code, "INVALID_MEDIA");
    assert.equal(
      (await request(app, identity.token, "GET", `/clips/${clip.id}`)).json()
        .data.state,
      "pending",
    );
    assert.equal(
      (await request(app, identity.token, "GET", `/clips/${clip.id}/content`))
        .statusCode,
      409,
    );
    corrupt = false;
    assert.equal(
      (
        await request(app, identity.token, "POST", `/clips/${clip.id}/seal`, {})
      ).json().data.state,
      "sealed",
    );
  } finally {
    await app.close();
  }
});

test("declared MP3 metadata cannot bypass real format, hash, whole-file decoding or five-minute bounds", async () => {
  const audio = await readFile("test/fixtures/synthetic-1s.mp3");
  const identity = await provision();
  const app = await createApplication({
    ...config,
    audioProbe: { storageRoot: root },
  });
  try {
    for (const bytes of [
      Buffer.from("#EXTM3U\nhttps://example.invalid/private\n"),
      Buffer.alloc(audio.length),
      Buffer.concat(Array.from({ length: 280 }, () => audio)),
    ]) {
      const { clip } = await uploaded(app, identity.token, bytes);
      assert.equal(
        (
          await request(
            app,
            identity.token,
            "POST",
            `/clips/${clip.id}/seal`,
            {},
          )
        ).statusCode,
        422,
      );
      assert.equal(
        (await request(app, identity.token, "GET", `/clips/${clip.id}`)).json()
          .data.state,
        "pending",
      );
    }
    const command = { ...clipCommand(), bytes: audio.length };
    const clip = (
      await request(app, identity.token, "POST", "/clips", command)
    ).json().data;
    const form = (
      await request(app, identity.token, "POST", `/clips/${clip.id}/upload`, {})
    ).json().data;
    assert.equal((await formUpload(app, form, audio)).statusCode, 204);
    assert.equal(
      (await request(app, identity.token, "POST", `/clips/${clip.id}/seal`, {}))
        .statusCode,
      422,
    );
    assert.equal(
      (
        await request(app, identity.token, "POST", "/clips", {
          ...clipCommand(),
          bytes: 2097153,
        })
      ).statusCode,
      400,
    );
  } finally {
    await app.close();
  }
});

test("changing object storage scope cannot relabel a previous simulator clip as a different backend", async () => {
  const identity = await provision();
  const app = await createApplication({
    ...config,
    audioProbe: { storageRoot: root },
  });
  const other = await createApplication({
    ...config,
    audioProbe: { storageRoot: join(root, "other-store") },
  });
  try {
    const command = clipCommand();
    const clip = (
      await request(app, identity.token, "POST", "/clips", command)
    ).json().data;
    assert.equal(
      (await request(other, identity.token, "GET", `/clips/${clip.id}`))
        .statusCode,
      404,
    );
    assert.equal(
      (await request(other, identity.token, "POST", "/clips", command))
        .statusCode,
      409,
    );
  } finally {
    await app.close();
    await other.close();
  }
});

test("operator cleanup removes only the selected probe identity and its objects, including after expiry", async () => {
  const identity = await provision();
  const foreign = await provision();
  const app = await createApplication({
    ...config,
    audioProbe: { storageRoot: root },
  });
  let owned: string, other: string;
  try {
    owned = (
      await uploaded(
        app,
        identity.token,
        await readFile("test/fixtures/synthetic-1s.mp3"),
      )
    ).clip.id;
    other = (
      await request(app, foreign.token, "POST", "/clips", clipCommand())
    ).json().data.id;
    assert.equal(
      (await request(app, identity.token, "GET", `/clips/${owned}`)).statusCode,
      200,
    );
    // Expire only this fixture after setup, independent of CLI/API startup speed.
    const redis = new Redis(config.redisUrl);
    try {
      assert.equal(
        await redis.pexpireat(
          `${schema}:probe:session:${createHash("sha256").update(identity.token).digest("hex")}`,
          1,
        ),
        1,
      );
    } finally {
      redis.disconnect();
    }
    const expired = await request(
      app,
      identity.token,
      "GET",
      `/clips/${owned}`,
    );
    assert.equal(expired.statusCode, 401);
    assert.equal(expired.json().error.code, "UNAUTHENTICATED");
  } finally {
    await app.close();
  }
  const result = spawnSync(
    process.execPath,
    ["dist-test/src/probe/probe-cli.js", "--clean", identity.file],
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
  const restarted = await createApplication({
    ...config,
    audioProbe: { storageRoot: root },
  });
  try {
    assert.equal(
      (await request(restarted, foreign.token, "GET", `/clips/${other!}`))
        .statusCode,
      200,
    );
    assert.equal(
      (await request(restarted, identity.token, "GET", `/clips/${owned!}`))
        .statusCode,
      401,
    );
    await assert.rejects(
      readFile(join(root, "objects", "staging", `${owned!}.mp3`)),
    );
  } finally {
    await restarted.close();
  }
});
