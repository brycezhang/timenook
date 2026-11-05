import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import {
  startBookFixture,
  stopBookFixture,
  joinedProject,
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
  observed,
  productExportStream,
} from "./complete-export-fixture";

before(startBookFixture);

after(stopBookFixture);

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
