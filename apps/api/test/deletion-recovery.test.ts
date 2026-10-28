import assert from "node:assert/strict";
import { test, beforeEach, afterEach } from "node:test";
import { randomUUID } from "node:crypto";
import { fork, spawnSync, type ChildProcess } from "node:child_process";
import {
  cp,
  mkdtemp,
  writeFile,
  rm,
  readFile,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import {
  startBookFixture,
  stopBookFixture,
  app,
  db,
  config,
  root,
  bound,
  readyStory,
  interview,
  sealedClip,
  choose,
  request,
  data,
  login,
  createBookApplication,
} from "./book-fixture";
import { paymentAdmin } from "./payment-admin-fixture";
import { PrivacyJournal } from "../src/privacy-journal/privacy-journal";
import { privacyAuthorityId } from "../src/care/privacy-rights";
import type { ApiConfig } from "../src/config";
beforeEach(startBookFixture);
const children = new Set<ChildProcess>();
const restoredSchemas = new Set<string>();
const directories = new Set<string>();
afterEach(async () => {
  for (const child of children) {
    child.kill("SIGCONT");
    child.kill("SIGKILL");
    if (child.exitCode === null && child.signalCode === null)
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  }
  children.clear();
  try {
    for (const schema of restoredSchemas)
      await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    restoredSchemas.clear();
    for (const directory of directories)
      await rm(directory, { recursive: true, force: true });
    directories.clear();
    await stopBookFixture();
  }
});
async function fixtureDirectory(prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.add(directory);
  return directory;
}
test("a valid authenticated source copied inside business file storage cannot open private capabilities", async () => {
  const copied = join(
    config.books!.storageRoot,
    "independent-source-is-not-business-data",
  );
  await cp(config.privacyJournal!.root, copied, { recursive: true });
  await assert.rejects(
    createBookApplication({
      ...config,
      privacyJournal: { ...config.privacyJournal!, root: copied },
    }),
    /separate from business storage roots/,
  );
  const directory = await fixtureDirectory("timenook-source-alias-");
  const alias = join(directory, "alias");
  await symlink(config.privacyJournal!.root, alias);
  await assert.rejects(
    createBookApplication({
      ...config,
      books: {
        ...config.books!,
        storageRoot: join(alias, "not-created-media"),
      },
    }),
    /separate from business storage roots/,
  );
  assert.equal((await request("GET", "/health/live")).statusCode, 200);
});
async function child(configPath: string, mode = "api") {
  const proc = fork(
    resolve(__dirname, "deletion-recovery-process.js"),
    [configPath, mode],
    {
      env: { ...process.env, NODE_ENV: "test" },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  children.add(proc);
  const result = await new Promise<{ ready: boolean; url?: string }>(
    (yes, no) => {
      proc.once("message", (m) => yes(m as any));
      proc.once("error", no);
      proc.once("exit", (code) => {
        if (code) no(new Error("Recovery process refused before readiness"));
      });
    },
  );
  return { proc, ...result };
}
async function closeChild(p: ChildProcess) {
  p.kill("SIGCONT");
  p.send("close");
  await new Promise<void>((r) => p.once("exit", () => r()));
  children.delete(p);
}
async function fileConfig(
  directory: string,
  value: ApiConfig,
  name = "config.json",
) {
  const path = join(directory, name);
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  return path;
}
function postgresContainer() {
  const result = spawnSync(
    "docker",
    ["ps", "--filter", "publish=54329", "--format", "{{.ID}}"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0);
  const ids = result.stdout.trim().split(/\s+/);
  assert.equal(ids.length, 1, "one isolated loopback PostgreSQL service");
  assert.match(ids[0], /^[a-f0-9]+$/);
  return ids[0];
}
function database() {
  return decodeURIComponent(new URL(config.databaseUrl).pathname.slice(1));
}
function dump(schema: string) {
  const out = spawnSync(
    "docker",
    [
      "exec",
      postgresContainer(),
      "pg_dump",
      "-U",
      "timenook",
      "-d",
      database(),
      "--schema=" + schema,
      "--no-owner",
      "--no-acl",
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  assert.equal(out.status, 0, "real PostgreSQL16 backup");
  return out.stdout;
}
function restore(sql: string, source: string, target: string) {
  assert.match(target, /^[a-z_0-9]+$/);
  restoredSchemas.add(target);
  const out = spawnSync(
    "docker",
    [
      "exec",
      "-i",
      postgresContainer(),
      "psql",
      "-U",
      "timenook",
      "-d",
      database(),
      "-v",
      "ON_ERROR_STOP=1",
    ],
    {
      input: sql.replaceAll(source, target),
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  assert.equal(out.status, 0, "real PostgreSQL16 restore");
}
async function deletion(p: Awaited<ReturnType<typeof bound>>) {
  const current = data(
      await request(
        "GET",
        `/v1/projects/${p.projectId}/participation`,
        p.narrator.token,
      ),
      200,
    ),
    headers = await paymentAdmin(config, app, ["care:write", "audit:read"]);
  const care = data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/care-requests`,
      p.narrator.token,
      { kind: "delete", expectedBindingVersion: current.bindingVersion },
    ),
  );
  const key = randomUUID(),
    body = {
      expectedBindingVersion: current.bindingVersion,
      expectedAccessEpoch: current.accessEpoch,
      noticeVersion: "synthetic-d08-v1",
      evidenceRef: "synthetic:恢复删除核验",
    };
  data(
    await app.inject({
      method: "POST",
      url: `/v1/admin/care-requests/${care.id}/verify`,
      headers: { ...headers, "idempotency-key": key },
      payload: body,
    }),
  );
  return { care, headers, key, body };
}
async function get(url: string, path: string, token: string) {
  return fetch(url + path, { headers: { authorization: "Bearer " + token } });
}
test("a real older PostgreSQL and file backup stays closed until independent replay and explicit authority promotion precede separate API and worker readiness", async () => {
  const erased = await readyStory(),
    revoked = await readyStory(),
    rebound = await readyStory(),
    control = await readyStory(),
    replacement = await login();
  const queued = await sealedClip(control, control.interviewId);
  const asset = await db.recordingAsset.findFirstOrThrow({
    where: { projectId: erased.projectId },
  });
  const physical = join(
    config.recording!.storageRoot,
    "objects",
    asset.objectKey,
  );
  assert.equal(
    (
      await request(
        "GET",
        `/v1/projects/${erased.projectId}/stories/${erased.story.id}`,
        erased.narrator.token,
      )
    ).statusCode,
    200,
  );
  const knownBytes = await readFile(physical);
  assert.ok(knownBytes.length > 100);
  const sourceSchema = new URL(config.databaseUrl).searchParams.get("schema")!,
    targetSchema = "restore_" + randomUUID().replaceAll("-", "");
  const backup = dump(sourceSchema),
    directory = await fixtureDirectory("timenook-restore-");
  await cp(root, join(directory, "files"), { recursive: true });
  await deletion(erased);
  data(
    (await choose(revoked, revoked.narrator.token, "collection", false))
      .response,
  );
  const binding = data(
    await request(
      "GET",
      `/v1/projects/${rebound.projectId}/participation`,
      rebound.narrator.token,
    ),
    200,
  );
  const care = data(
    await request(
      "POST",
      `/v1/projects/${rebound.projectId}/care-requests`,
      rebound.buyer.token,
      {
        kind: "rebind",
        targetUserId: replacement.id,
        expectedBindingVersion: binding.bindingVersion,
      },
    ),
  );
  const admin = await paymentAdmin(config, app, ["care:write", "audit:read"]);
  data(
    await app.inject({
      method: "POST",
      url: `/v1/admin/projects/${rebound.projectId}/rebind`,
      headers: { ...admin, "idempotency-key": randomUUID() },
      payload: {
        supportCaseRef: `record:${care.id}`,
        targetUserId: replacement.id,
        expectedBindingVersion: binding.bindingVersion,
        noticeVersion: "synthetic-d08-v1",
        evidenceRef: "synthetic:独立核验换绑",
      },
    }),
  );
  await app.close();
  const originalConfig = await fileConfig(directory, config, "original.json"),
    old = await child(originalConfig);
  assert.equal(old.ready, true);
  old.proc.kill("SIGSTOP");
  restore(backup, sourceSchema, targetSchema);
  await cp(join(directory, "files"), root, { recursive: true });
  assert.deepEqual(
    await readFile(physical),
    knownBytes,
    "restored physical bytes use the same logical storage scope",
  );
  const restoredUrl = new URL(config.databaseUrl);
  restoredUrl.searchParams.set("schema", targetSchema);
  const restored = { ...config, databaseUrl: restoredUrl.toString() };
  const targetDb = new PrismaClient({ datasourceUrl: restored.databaseUrl });
  const [before] = await targetDb.$queryRaw<
    { text: string }[]
  >`SELECT text FROM formal_transcripts WHERE project_id=${erased.projectId}::uuid LIMIT 1`;
  assert.ok(before.text.includes("八十年代"));
  const targetConfig = await fileConfig(directory, restored);
  const closed = await child(targetConfig);
  assert.equal(
    closed.ready,
    false,
    "a cloned installation cannot inherit source writer authority",
  );
  const activation = spawnSync(
    process.execPath,
    [
      resolve(__dirname, "../src/care/privacy-recovery-cli.js"),
      "activate",
      "--test-config-file",
      targetConfig,
    ],
    {
      env: { ...process.env, NODE_ENV: "test" },
      encoding: "utf8",
      timeout: 30000,
    },
  );
  assert.equal(activation.status, 0, activation.stderr);
  const api = await child(targetConfig),
    worker = await child(targetConfig, "worker");
  assert.equal(api.ready, true);
  assert.equal(worker.ready, true);
  old.proc.kill("SIGCONT");
  assert.equal(
    (
      await get(
        old.url!,
        `/v1/projects/${control.projectId}/stories/${control.story.id}`,
        control.narrator.token,
      )
    ).status,
    503,
    "the old API does not adopt a new authority",
  );
  assert.equal(
    (
      await get(
        api.url!,
        `/v1/projects/${erased.projectId}/stories/${erased.story.id}`,
        erased.narrator.token,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await get(
        api.url!,
        `/v1/projects/${revoked.projectId}/stories/${revoked.story.id}`,
        revoked.narrator.token,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await get(
        api.url!,
        `/v1/projects/${control.projectId}/stories/${control.story.id}`,
        control.narrator.token,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await get(
        api.url!,
        `/v1/projects/${rebound.projectId}/deletion-status`,
        rebound.narrator.token,
      )
    ).status,
    403,
    "the old bound account cannot inspect restored subject status",
  );
  const oldGrant = await fetch(
    api.url! + `/v1/projects/${rebound.projectId}/consents`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer " + rebound.narrator.token,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
      },
      body: JSON.stringify({
        purpose: "collection",
        granted: true,
        expectedBindingVersion: binding.bindingVersion,
        expectedAccessEpoch: binding.accessEpoch + 1,
        noticeVersion: "synthetic-d08-v1",
        evidenceRef: "synthetic:旧绑定不能复活",
      }),
    },
  );
  assert.equal(oldGrant.status, 403);
  assert.equal(
    (
      await get(
        api.url!,
        `/v1/projects/${rebound.projectId}/deletion-status`,
        replacement.token,
      )
    ).status,
    200,
  );
  await assert.rejects(readFile(physical));
  const [erasedText] = await targetDb.$queryRaw<
    { text: null }[]
  >`SELECT text FROM formal_transcripts WHERE project_id=${erased.projectId}::uuid LIMIT 1`;
  assert.equal(erasedText.text, null);
  let succeeded = false;
  for (let n = 0; n < 60; n++) {
    const rows = await targetDb.productionTask.findMany({
      where: { assetId: queued.sealed.asset.id },
    });
    if (rows.some((t) => t.state === "succeeded")) {
      succeeded = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(
    succeeded,
    true,
    "unrelated worker task: " +
      JSON.stringify(
        await targetDb.productionTask.findMany({
          where: { assetId: queued.sealed.asset.id },
          select: { state: true, errorCode: true },
        }),
      ),
  );
  await closeChild(worker.proc);
  await closeChild(api.proc);
  await closeChild(old.proc);
  await targetDb.$disconnect();
  await db.$executeRawUnsafe(`DROP SCHEMA "${targetSchema}" CASCADE`);
  await rm(directory, { recursive: true, force: true });
});
test("a source event whose later project is absent from the backup prevents activation rather than skipping a private target", async () => {
  const earlier = await bound(),
    sourceSchema = new URL(config.databaseUrl).searchParams.get("schema")!,
    backup = dump(sourceSchema),
    later = await bound();
  await deletion(later);
  const targetSchema = "missing_" + randomUUID().replaceAll("-", ""),
    directory = await fixtureDirectory("timenook-restore-missing-");
  restore(backup, sourceSchema, targetSchema);
  const url = new URL(config.databaseUrl);
  url.searchParams.set("schema", targetSchema);
  const path = await fileConfig(directory, {
    ...config,
    databaseUrl: url.toString(),
  });
  const before = await new PrivacyJournal(config.privacyJournal!).snapshot();
  const result = spawnSync(
    process.execPath,
    [
      resolve(__dirname, "../src/care/privacy-recovery-cli.js"),
      "activate",
      "--test-config-file",
      path,
    ],
    {
      env: { ...process.env, NODE_ENV: "test" },
      encoding: "utf8",
      timeout: 30000,
    },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.deepEqual(
    (await new PrivacyJournal(config.privacyJournal!).snapshot()).authority,
    before.authority,
  );
  assert.equal(
    (
      await request(
        "GET",
        `/v1/projects/${earlier.projectId}/deletion-status`,
        earlier.buyer.token,
      )
    ).statusCode,
    200,
  );
  await db.$executeRawUnsafe(`DROP SCHEMA "${targetSchema}" CASCADE`);
  await rm(directory, { recursive: true, force: true });
});
test("a valid older authenticated source head cannot pass a newer durable checkpoint", async () => {
  const p = await bound();
  data((await choose(p, p.narrator.token, "collection", true)).response);
  const older = join(tmpdir(), "timenook-old-source-" + randomUUID());
  await cp(config.privacyJournal!.root, older, { recursive: true });
  data((await choose(p, p.narrator.token, "collection", false)).response);
  await app.close();
  const directory = await fixtureDirectory("timenook-short-source-"),
    path = await fileConfig(directory, {
      ...config,
      privacyJournal: { ...config.privacyJournal!, root: older },
    });
  const failed = await child(path);
  assert.equal(failed.ready, false);
  await rm(older, { recursive: true, force: true });
  await rm(directory, { recursive: true, force: true });
});
test("SIGKILL after independent publication and before PostgreSQL commit replays the denial and the original verification receipt on HTTP retry", async () => {
  const p = await bound();
  data((await choose(p, p.narrator.token, "collection", true)).response);
  const state = data(
      await request(
        "GET",
        `/v1/projects/${p.projectId}/participation`,
        p.narrator.token,
      ),
      200,
    ),
    care = data(
      await request(
        "POST",
        `/v1/projects/${p.projectId}/care-requests`,
        p.narrator.token,
        { kind: "delete", expectedBindingVersion: state.bindingVersion },
      ),
    ),
    headers = await paymentAdmin(config, app, ["care:write", "audit:read"]);
  await app.close();
  await db.$executeRawUnsafe(
    `CREATE FUNCTION hold_privacy_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(20); RETURN NEW; END $$`,
  );
  await db.$executeRawUnsafe(
    `CREATE TRIGGER hold_privacy_commit BEFORE INSERT ON privacy_events FOR EACH ROW EXECUTE FUNCTION hold_privacy_commit()`,
  );
  const directory = await fixtureDirectory("timenook-commit-crash-"),
    path = await fileConfig(directory, config),
    api = await child(path),
    key = randomUUID(),
    body = {
      expectedBindingVersion: state.bindingVersion,
      expectedAccessEpoch: state.accessEpoch,
      noticeVersion: "synthetic-d08-v1",
      evidenceRef: "synthetic:发布窗口删除核验",
    };
  const url = `/v1/admin/care-requests/${care.id}/verify`,
    post = (base: string) =>
      fetch(base + url, {
        method: "POST",
        headers: {
          ...headers,
          "idempotency-key": key,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
  const interrupted = post(api.url!).then(
    () => false,
    () => true,
  );
  let published = false;
  for (let n = 0; n < 60; n++) {
    if (
      (await new PrivacyJournal(config.privacyJournal!).snapshot()).events.some(
        (e) => e.eventId === care.id,
      )
    ) {
      published = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(published, true);
  api.proc.kill("SIGKILL");
  await new Promise<void>((r) => api.proc.once("exit", () => r()));
  children.delete(api.proc);
  assert.equal(await interrupted, true);
  const [receipt] = await db.$queryRaw<
    { n: bigint }[]
  >`SELECT count(*) n FROM privacy_events WHERE id=${care.id}::uuid`;
  assert.equal(receipt.n, 0n);
  const [checkpoint] = await db.$queryRaw<
    { checkpoint_generation: bigint }[]
  >`SELECT checkpoint_generation FROM privacy_recovery_state`;
  assert.equal(checkpoint.checkpoint_generation, 0n);
  await db.$executeRawUnsafe(
    "DROP TRIGGER hold_privacy_commit ON privacy_events",
  );
  await db.$executeRawUnsafe("DROP FUNCTION hold_privacy_commit()");
  const restarted = await child(path);
  assert.equal(restarted.ready, true);
  assert.equal(
    (
      await get(
        restarted.url!,
        `/v1/projects/${p.projectId}/plan`,
        p.narrator.token,
      )
    ).status,
    403,
  );
  const retried = await post(restarted.url!);
  assert.equal(retried.status, 201);
  assert.equal(((await retried.json()) as any).data.currentAccessRevoked, true);
  assert.equal(
    (await new PrivacyJournal(config.privacyJournal!).snapshot()).events.length,
    1,
  );
  const [committed] = await db.$queryRaw<
    { checkpoint_generation: bigint }[]
  >`SELECT checkpoint_generation FROM privacy_recovery_state`;
  assert.equal(committed.checkpoint_generation, 1n);
  await closeChild(restarted.proc);
  await rm(directory, { recursive: true, force: true });
});
import { ProductionTasks } from "../src/tasks/tasks";
test("runtime independent-source damage closes private HTTP, readiness and worker claims while liveness remains available", async () => {
  const p = await bound();
  data((await choose(p, p.narrator.token, "collection", true)).response);
  assert.equal(
    (await request("GET", `/v1/projects/${p.projectId}/plan`, p.narrator.token))
      .statusCode,
    200,
  );
  await writeFile(
    join(config.privacyJournal!.root, "head.json"),
    '{"truncated":',
    { mode: 0o600 },
  );
  assert.equal(
    (await request("GET", `/v1/projects/${p.projectId}/plan`, p.narrator.token))
      .statusCode,
    503,
  );
  assert.equal(
    (await app.inject({ method: "GET", url: "/health/ready" })).statusCode,
    503,
  );
  assert.equal(
    (await app.inject({ method: "GET", url: "/health/live" })).statusCode,
    200,
  );
  await assert.rejects(app.get(ProductionTasks).due());
});
import { readyFirstCopyBook } from "./first-copy-fixture";
test("an assisted version rejection restores as an authenticated denial without inventing lost assisted evidence or renewing an old positive command", async () => {
  const p = await readyFirstCopyBook(),
    base = `/v1/projects/${p.projectId}/stories/${p.story.id}`,
    state = data(
      await request(
        "GET",
        `/v1/projects/${p.projectId}/participation`,
        p.buyer.token,
      ),
      200,
    );
  const positive = await db.storyDecision.findFirstOrThrow({
    where: { projectId: p.projectId, confirmed: true, allowInBook: true },
    orderBy: { sequence: "desc" },
  });
  const session = data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/assisted-sessions`,
      p.buyer.token,
      {
        purpose: "story_confirmation",
        granted: true,
        expectedBindingVersion: state.bindingVersion,
        expectedAccessEpoch: state.accessEpoch,
        noticeVersion: "synthetic-d08-v1",
        evidenceRef: "synthetic:恢复前本人在场确认",
      },
    ),
  );
  const schema = new URL(config.databaseUrl).searchParams.get("schema")!,
    backup = dump(schema),
    target = "storydeny_" + randomUUID().replaceAll("-", "");
  const rejected = data(
    await request("POST", base + "/decisions", p.buyer.token, {
      revisionId: p.story.revision.id,
      expectedVersion: p.story.version,
      contentHash: p.story.revision.contentHash,
      confirmed: true,
      allowInBook: false,
      noticeVersion: "synthetic-d08-v1",
      evidenceRef: "synthetic:明确撤回同一版入书",
      assistedSessionId: session.id,
    }),
  );
  assert.equal(rejected.decision.method, "assisted");
  assert.ok(rejected.decision.assistedEvidenceId);
  await app.close();
  restore(backup, schema, target);
  const directory = await fixtureDirectory("timenook-story-denial-"),
    url = new URL(config.databaseUrl);
  url.searchParams.set("schema", target);
  const recovered = { ...config, databaseUrl: url.toString() },
    path = await fileConfig(directory, recovered);
  const activated = spawnSync(
    process.execPath,
    [
      resolve(__dirname, "../src/care/privacy-recovery-cli.js"),
      "activate",
      "--test-config-file",
      path,
    ],
    {
      env: { ...process.env, NODE_ENV: "test" },
      encoding: "utf8",
      timeout: 30000,
    },
  );
  assert.equal(activated.status, 0, activated.stderr);
  const api = await child(path),
    targetDb = new PrismaClient({ datasourceUrl: recovered.databaseUrl });
  const denial = await targetDb.storyDecision.findUniqueOrThrow({
    where: { id: rejected.decision.id },
  });
  assert.equal(denial.method, "journal_denial");
  assert.equal(denial.allowInBook, false);
  assert.equal(denial.assistedEvidenceId, null);
  assert.ok(denial.evidenceRef);
  assert.match(denial.evidenceRef, /^journal:[a-f0-9]{64}$/);
  assert.equal(
    await targetDb.assistedVersionEvidence.count({
      where: { id: rejected.decision.assistedEvidenceId },
    }),
    0,
  );
  const send = (body: object, key: string = randomUUID()) =>
    fetch(api.url! + base + "/decisions", {
      method: "POST",
      headers: {
        authorization: "Bearer " + p.narrator.token,
        "content-type": "application/json",
        "idempotency-key": key,
      },
      body: JSON.stringify(body),
    });
  const oldBody = {
    revisionId: p.story.revision.id,
    expectedVersion: p.story.version,
    contentHash: p.story.revision.contentHash,
    confirmed: true,
    allowInBook: true,
    noticeVersion: positive.noticeVersion,
    evidenceRef: positive.evidenceRef,
  };
  const old = await send(oldBody, positive.idempotencyKey);
  assert.equal(old.status, 201);
  assert.equal(((await old.json()) as any).data.decision.allowInBook, false);
  const forbiddenMethod = await send({ ...oldBody, method: "journal_denial" });
  assert.equal(forbiddenMethod.status, 400);
  const renewed = await send({
    ...oldBody,
    evidenceRef: "synthetic:本人在恢复后另作明确确认",
  });
  assert.equal(renewed.status, 201);
  assert.equal(((await renewed.json()) as any).data.decision.allowInBook, true);
  await assert.rejects(
    targetDb.$executeRaw`UPDATE story_decisions SET allow_in_book=true WHERE id=${denial.id}::uuid`,
  );
  await closeChild(api.proc);
  await targetDb.$disconnect();
  await db.$executeRawUnsafe(`DROP SCHEMA "${target}" CASCADE`);
  await rm(directory, { recursive: true, force: true });
});
