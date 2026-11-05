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
  joinedProject,
  readyStory,
  interview,
  sealedClip,
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
async function deletion(p: Awaited<ReturnType<typeof joinedProject>>) {
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

test("a source event whose later project is absent from the backup prevents activation rather than skipping a private target", async () => {
  const earlier = await joinedProject(),
    sourceSchema = new URL(config.databaseUrl).searchParams.get("schema")!,
    backup = dump(sourceSchema),
    later = await joinedProject();
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

test("SIGKILL after independent publication and before PostgreSQL commit replays the denial and the original verification receipt on HTTP retry", async () => {
  const p = await joinedProject();

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
  const p = await joinedProject();

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
