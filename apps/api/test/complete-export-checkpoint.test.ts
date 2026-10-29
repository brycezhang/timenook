import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import {
  startBookFixture,
  stopBookFixture,
  bound,
  choose,
  request,
  data,
  app,
  config,
  db,
  restartBookApplication,
  root,
  state,
} from "./book-fixture";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import { Deletions } from "../src/care/deletions";
import { PrismaClient } from "@prisma/client";
import { PrivacyJournal } from "../src/privacy-journal/privacy-journal";
import { ProjectStreams } from "../src/media/project-streams";
import { CompleteExports } from "../src/care/complete-export";
import { before, after, test } from "node:test";
import {
  adminRequest,
  acceptedBook,
  pausedZip,
  streamExport,
  assistedExportChoice,
  observed,
  productExportStream,
} from "./complete-export-fixture";

before(startBookFixture);

after(stopBookFixture);

for (const channel of ["product", "alternative"] as const) {
  test(`${channel} ZIP starts while an unrelated published withdrawal awaits its PostgreSQL checkpoint`, async () => {
    await app.get(Deletions).sweep();
    const p = await streamExport(channel),
      unrelated = await bound(),
      locks = new PrismaClient({ datasourceUrl: config.databaseUrl }),
      source = new PrivacyJournal(config.privacyJournal!),
      choice = await state(unrelated, unrelated.narrator.token);
    let releaseProject!: () => void,
      projectLocked!: () => void,
      releaseCheckpoint!: () => void,
      checkpointLocked!: () => void;
    const projectGate = new Promise<void>((r) => {
        releaseProject = r;
      }),
      projectReady = new Promise<void>((r) => {
        projectLocked = r;
      }),
      checkpointGate = new Promise<void>((r) => {
        releaseCheckpoint = r;
      }),
      checkpointReady = new Promise<void>((r) => {
        checkpointLocked = r;
      });
    let pid = 0,
      checkpointPid = 0;
    const projectLock = locks.$transaction(
      async (tx) => {
        [{ pid }] = await tx.$queryRaw<
          { pid: number }[]
        >`SELECT pg_backend_pid() pid`;
        await tx.$queryRaw`SELECT id FROM projects WHERE id=${p.projectId}::uuid FOR UPDATE`;
        projectLocked();
        await projectGate;
      },
      { timeout: 30000 },
    );
    await projectReady;
    let stream: Awaited<ReturnType<typeof pausedZip>> | undefined,
      download: ReturnType<typeof pausedZip> | undefined,
      withdrawal:
        Promise<{ response: Awaited<ReturnType<typeof request>> }> | undefined,
      checkpointLock: Promise<unknown> | undefined;
    try {
      download = pausedZip(p.url, p.headers);
      // This real row-lock wait proves the request-level replay gate passed
      // before the independent event; the next fence must handle the new head.
      void download.catch(() => {});
      await observed(
        async () =>
          (
            await db.$queryRaw<{ waiting: boolean }[]>`
        SELECT EXISTS(SELECT 1 FROM pg_stat_activity a
        WHERE ${pid}=ANY(pg_blocking_pids(a.pid)) AND a.query LIKE '%FROM projects%') waiting
      `
          )[0].waiting,
        "ZIP request did not reach its project lock",
      );
      checkpointLock = locks.$transaction(
        async (tx) => {
          [{ pid: checkpointPid }] = await tx.$queryRaw<
            { pid: number }[]
          >`SELECT pg_backend_pid() pid`;
          await tx.$queryRaw`SELECT singleton FROM privacy_recovery_state FOR UPDATE`;
          checkpointLocked();
          await checkpointGate;
        },
        { timeout: 30000 },
      );
      await checkpointReady;
      withdrawal = request(
        "POST",
        `/v1/projects/${unrelated.projectId}/consents`,
        unrelated.narrator.token,
        {
          purpose: "collection",
          granted: false,
          expectedBindingVersion: choice.bindingVersion,
          expectedAccessEpoch: choice.accessEpoch,
          noticeVersion: "synthetic-d08-v1",
          evidenceRef: "synthetic:另项目的真实撤回",
        },
      ).then((response) => ({ response }));
      // Observe the PG publication barrier; repeatedly taking journal snapshots
      // here would compete for the same flock as the publisher under test.
      await observed(
        async () =>
          (
            await db.$queryRaw<{ waiting: boolean }[]>`
        SELECT EXISTS(SELECT 1 FROM pg_stat_activity a WHERE ${checkpointPid}=ANY(pg_blocking_pids(a.pid)) AND a.query LIKE '%privacy_recovery_state%') waiting
      `
          )[0].waiting,
        "withdrawal did not reach its checkpoint lock",
      );
      assert.ok(
        (await source.snapshot()).events.some(
          (e) => e.projectId === unrelated.projectId && e.kind === "revocation",
        ),
      );
      assert.equal(
        (
          await db.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) n FROM privacy_events WHERE project_id=${unrelated.projectId}::uuid
      `
        )[0].n,
        0n,
        "the independently published event is still uncommitted",
      );
      releaseProject();
      await projectLock;
      stream = await download;
      releaseCheckpoint();
      await checkpointLock;
      data((await withdrawal).response);
      const received = await stream.finish();
      assert.equal(received.completed, true);
      assert.equal(received.bytes.length, p.packed.bytes);
      assert.equal(
        createHash("sha256").update(received.bytes).digest("hex"),
        p.packed.sha256,
      );
      assert.equal(
        (
          await request(
            "GET",
            `/v1/projects/${unrelated.projectId}/plan`,
            unrelated.narrator.token,
          )
        ).statusCode,
        403,
      );
      // Drain earlier fake-clock sweeps before installing a checkpoint barrier.
      // Otherwise a previous project's future-cutoff run could be the publisher
      // holding this barrier before the command under test reaches onRequest.
      await app.get(Deletions).sweep();
      // The same authenticated publication window must still reject this
      // project's fence before its PostgreSQL denial can commit.
      stream = await pausedZip(p.url, p.headers);
      const previous = (await source.snapshot()).generation;
      const ownReady = new Promise<void>((r) => {
          checkpointLocked = r;
        }),
        ownGate = new Promise<void>((r) => {
          releaseCheckpoint = r;
        });
      checkpointLock = locks.$transaction(
        async (tx) => {
          [{ pid: checkpointPid }] = await tx.$queryRaw<
            { pid: number }[]
          >`SELECT pg_backend_pid() pid`;
          await tx.$queryRaw`SELECT singleton FROM privacy_recovery_state FOR UPDATE`;
          checkpointLocked();
          await ownGate;
        },
        { timeout: 30000 },
      );
      await ownReady;
      const ownWithdrawal =
        "narrator" in p
          ? choose(p, p.narrator.token, "collection", false).then(
              (r) => r.response,
            )
          : assistedExportChoice(p, "collection", false);
      // Retain the command for cleanup even if the assertion below fails.
      const ownResult = ownWithdrawal.then((response) => ({ response }));
      withdrawal = ownResult;
      await observed(
        async () =>
          (
            await db.$queryRaw<{ waiting: boolean }[]>`
        SELECT EXISTS(SELECT 1 FROM pg_stat_activity a WHERE ${checkpointPid}=ANY(pg_blocking_pids(a.pid)) AND a.query LIKE '%privacy_recovery_state%') waiting
      `
          )[0].waiting,
        "own withdrawal did not reach its checkpoint lock",
      );
      const ownEvent = (await source.snapshot()).events.find(
        (e) => e.projectId === p.projectId && e.generation > previous,
      );
      assert.ok(ownEvent);
      assert.equal(
        (
          await db.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) n FROM privacy_events WHERE id=${ownEvent.eventId}::uuid
      `
        )[0].n,
        0n,
      );
      await assert.rejects(
        app.get(ProjectStreams).fence(p.projectId),
        (error: { getStatus(): number; message: string }) =>
          error.getStatus() === 503 &&
          error.message === "Independent source replay is pending",
      );
      await assert.rejects(
        app.get(ProjectStreams).fence(p.projectId.toUpperCase()),
        (error: { getStatus(): number; message: string }) =>
          error.getStatus() === 503 &&
          error.message === "Independent source replay is pending",
      );
      // A chunk check already waiting on this command's project row remains
      // blocked; it must not wait for us to consume bytes to release that row.
      releaseCheckpoint();
      await checkpointLock;
      data(await ownWithdrawal);
      const stopped = await stream.finish();
      assert.equal(stopped.completed, false);
      assert.ok(stopped.bytes.length < p.packed.bytes);
      assert.equal(
        (await app.inject({ method: "GET", url: p.url, headers: p.headers }))
          .statusCode,
        403,
      );
      data(
        await request(
          "GET",
          `/v1/projects/${unrelated.projectId}/participation`,
          unrelated.narrator.token,
        ),
        200,
      );
    } finally {
      releaseProject();
      releaseCheckpoint();
      await Promise.allSettled([
        projectLock,
        checkpointLock,
        withdrawal,
        download,
      ]);
      stream?.response.destroy();
      await locks.$disconnect();
    }
  });
}

test("a ZIP chunk rechecks its source after a scope check waits for a published withdrawal that rolls back", async () => {
  await app.get(Deletions).sweep();
  const p = await acceptedBook();
  data(await adminRequest("POST", p.exportBase + "/pack", p.admin, {}));
  const streams = app.get(ProjectStreams),
    file = await app
      .get(CompleteExports)
      .download(p.projectId, p.exp.id, `Bearer ${p.narrator.token}`),
    fence = await streams.userFence(p.projectId, `Bearer ${p.narrator.token}`),
    stream = await streams.guard(
      p.projectId,
      fence.epoch,
      file.bytes,
      file.check,
      `Bearer ${p.narrator.token}`,
      fence.sequence,
    ),
    locks = new PrismaClient({ datasourceUrl: config.databaseUrl }),
    key = Math.floor(Math.random() * 1000000000);
  let release!: () => void,
    locked!: () => void,
    pid = 0;
  const gate = new Promise<void>((r) => {
      release = r;
    }),
    ready = new Promise<void>((r) => {
      locked = r;
    });
  const held = locks.$transaction(
    async (tx) => {
      [{ pid }] = await tx.$queryRaw<
        { pid: number }[]
      >`SELECT pg_backend_pid() pid`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${key}::integer)`;
      locked();
      await gate;
    },
    { timeout: 30000 },
  );
  await ready;
  let command: ReturnType<typeof choose> | undefined,
    next: Promise<IteratorResult<Buffer>> | undefined;
  try {
    await db.$executeRawUnsafe(`CREATE FUNCTION pause_t26_zip_denial() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.project_id='${p.projectId}'::uuid AND NEW.purpose='collection' AND NOT NEW.granted THEN
        PERFORM pg_advisory_xact_lock(${key});
      END IF; RETURN NEW; END $$`);
    await db.$executeRawUnsafe(
      `CREATE TRIGGER pause_t26_zip_denial BEFORE INSERT ON consent_records FOR EACH ROW EXECUTE FUNCTION pause_t26_zip_denial()`,
    );
    await db.$executeRawUnsafe(`CREATE FUNCTION fail_t26_zip_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF EXISTS(SELECT 1 FROM privacy_events WHERE project_id='${p.projectId}'::uuid) THEN
        RAISE EXCEPTION 'synthetic published denial PostgreSQL rollback';
      END IF; RETURN NEW; END $$`);
    await db.$executeRawUnsafe(
      `CREATE TRIGGER fail_t26_zip_checkpoint BEFORE UPDATE ON privacy_recovery_state FOR EACH ROW EXECUTE FUNCTION fail_t26_zip_checkpoint()`,
    );
    command = choose(p, p.narrator.token, "collection", false);
    let writer = 0;
    await observed(async () => {
      const [row] = await db.$queryRaw<{ pid: number }[]>`
        SELECT a.pid FROM pg_stat_activity a WHERE ${pid}=ANY(pg_blocking_pids(a.pid)) AND a.query LIKE '%consent_records%'
      `;
      writer = row?.pid ?? 0;
      return !!writer;
    }, "withdrawal did not pause before independent publication");
    next = stream[Symbol.asyncIterator]().next();
    void next.catch(() => {});
    await observed(
      async () =>
        (
          await db.$queryRaw<{ waiting: boolean }[]>`
      SELECT EXISTS(SELECT 1 FROM pg_stat_activity a WHERE ${writer}=ANY(pg_blocking_pids(a.pid)) AND a.query LIKE '%FROM projects%') waiting
    `
        )[0].waiting,
      "chunk scope check did not wait behind the withdrawal",
    );
    release();
    await held;
    assert.equal((await command).response.statusCode, 500);
    const event = (
      await new PrivacyJournal(config.privacyJournal!).snapshot()
    ).events.find((e) => e.projectId === p.projectId);
    assert.ok(event);
    assert.equal(
      (
        await db.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) n FROM privacy_events WHERE id=${event.eventId}::uuid
    `
      )[0].n,
      0n,
    );
    // No chunk may escape using the still-old PG consent after rollback.
    await assert.rejects(next, (error: { getStatus(): number }) =>
      [403, 503].includes(error.getStatus()),
    );
  } finally {
    release();
    stream.destroy();
    await Promise.allSettled([held, command, next]);
    await db.$executeRawUnsafe(
      "DROP TRIGGER IF EXISTS pause_t26_zip_denial ON consent_records",
    );
    await db.$executeRawUnsafe(
      "DROP FUNCTION IF EXISTS pause_t26_zip_denial()",
    );
    await db.$executeRawUnsafe(
      "DROP TRIGGER IF EXISTS fail_t26_zip_checkpoint ON privacy_recovery_state",
    );
    await db.$executeRawUnsafe(
      "DROP FUNCTION IF EXISTS fail_t26_zip_checkpoint()",
    );
    await locks.$disconnect();
    await restartBookApplication();
  }
  assert.equal(
    (
      await request(
        "GET",
        `/v1/projects/${p.projectId}/exports/${p.exp.id}/download`,
        p.narrator.token,
      )
    ).statusCode,
    403,
  );
});

test("a source failure after ZIP scope checks returns a JSON 503 before any ZIP response headers", async () => {
  await app.get(Deletions).sweep();
  const p = await acceptedBook();
  data(await adminRequest("POST", p.exportBase + "/pack", p.admin, {}));
  const head = join(config.privacyJournal!.root, "head.json"),
    original = await readFile(head),
    locks = new PrismaClient({ datasourceUrl: config.databaseUrl });
  let release!: () => void,
    locked!: () => void,
    pid = 0;
  const gate = new Promise<void>((r) => {
      release = r;
    }),
    ready = new Promise<void>((r) => {
      locked = r;
    });
  const held = locks.$transaction(
    async (tx) => {
      [{ pid }] = await tx.$queryRaw<
        { pid: number }[]
      >`SELECT pg_backend_pid() pid`;
      await tx.$queryRaw`SELECT id FROM projects WHERE id=${p.projectId}::uuid FOR UPDATE`;
      locked();
      await gate;
    },
    { timeout: 30000 },
  );
  await ready;
  let download:
    | Promise<{
        status: number | undefined;
        headers: http.IncomingHttpHeaders;
        body: Buffer;
      }>
    | undefined;
  try {
    if (!app.getHttpServer().listening) await app.listen(0, "127.0.0.1");
    const origin = await app.getUrl();
    download = new Promise((resolve, reject) => {
      http
        .get(
          `${origin}/v1/projects/${p.projectId}/exports/${p.exp.id}/download`,
          { headers: { authorization: `Bearer ${p.narrator.token}` } },
          (response) => {
            const bytes: Buffer[] = [];
            response.on("data", (b) => bytes.push(b));
            response.once("end", () =>
              resolve({
                status: response.statusCode,
                headers: response.headers,
                body: Buffer.concat(bytes),
              }),
            );
            response.once("error", reject);
          },
        )
        .once("error", reject);
    });
    await observed(
      async () =>
        (
          await db.$queryRaw<{ waiting: boolean }[]>`
      SELECT EXISTS(SELECT 1 FROM pg_stat_activity a WHERE ${pid}=ANY(pg_blocking_pids(a.pid)) AND a.query LIKE '%FROM projects%') waiting
    `
        )[0].waiting,
      "ZIP scope did not reach the controlled project lock",
    );
    await writeFile(head, '{"truncated":', { mode: 0o600 });
    release();
    await held;
    const result = await download;
    assert.equal(result.status, 503);
    assert.match(result.headers["content-type"]!, /^application\/json/);
    assert.equal(result.headers["content-disposition"], undefined);
    assert.equal(
      JSON.parse(result.body.toString()).error.code,
      "SERVICE_UNAVAILABLE",
    );
  } finally {
    release();
    await Promise.allSettled([held, download]);
    await writeFile(head, original, { mode: 0o600 });
    await locks.$disconnect();
    await restartBookApplication();
  }
  assert.equal(
    (
      await request(
        "GET",
        `/v1/projects/${p.projectId}/exports/${p.exp.id}/download`,
        p.narrator.token,
      )
    ).statusCode,
    200,
  );
});

test("withdrawal in a separate project does not interrupt a currently authorized ZIP stream", async () => {
  const p = await productExportStream(),
    unrelated = await bound(),
    stream = await pausedZip(p.url, p.headers);
  try {
    data(
      (await choose(unrelated, unrelated.narrator.token, "collection", false))
        .response,
    );
    const received = await stream.finish();
    assert.equal(received.completed, true);
    assert.equal(received.bytes.length, p.packed.bytes);
    assert.equal(
      createHash("sha256").update(received.bytes).digest("hex"),
      p.packed.sha256,
    );
  } finally {
    stream.response.destroy();
  }
});
