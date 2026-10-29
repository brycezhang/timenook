import { randomUUID, createHash } from "node:crypto";
import assert from "node:assert/strict";
import {
  startBookFixture,
  stopBookFixture,
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
import { ProjectServiceTerms } from "../src/projects/service-terms";
import { join } from "node:path";
import { access } from "node:fs/promises";
import { Deletions } from "../src/care/deletions";
import { before, after, test } from "node:test";
import {
  adminRequest,
  acceptedBook,
  largeExportSources,
  pausedZip,
  alternativeExport,
  alternativeWithdrawal,
  streamExport,
  rebindExport,
  assistedExportChoice,
  pendingStreamExport,
} from "./complete-export-fixture";

before(startBookFixture);

after(stopBookFixture);

test("the product ZIP stream stops after committed withdrawal while the receiver is backpressured", async () => {
  const p = await acceptedBook();
  await largeExportSources(p.projectId, p.narrator.token);
  const packed = data(
      await adminRequest("POST", p.exportBase + "/pack", p.admin, {}),
    ),
    url = `/v1/projects/${p.projectId}/exports/${p.exp.id}/download`,
    stream = await pausedZip(url, {
      authorization: `Bearer ${p.narrator.token}`,
    });
  try {
    assert.equal(
      Number(stream.response.headers["content-length"]),
      packed.bytes,
    );
    data((await choose(p, p.narrator.token, "collection", false)).response);
    const received = await stream.finish();
    assert.equal(received.completed, false);
    assert.ok(received.bytes.length < packed.bytes);
    assert.equal((await request("GET", url, p.narrator.token)).statusCode, 403);
  } finally {
    stream.response.destroy();
  }
});

test("the verified alternative ZIP stream stops after the subject's committed withdrawal", async () => {
  const p = await alternativeExport(),
    stream = await pausedZip(p.base + "/download", p.admin);
  try {
    assert.equal(
      Number(stream.response.headers["content-length"]),
      p.packed.bytes,
    );
    await alternativeWithdrawal(p);
    const received = await stream.finish();
    assert.equal(received.completed, false);
    assert.ok(received.bytes.length < p.packed.bytes);
    assert.equal(
      (await adminRequest("GET", p.base + "/download", p.admin)).statusCode,
      403,
    );
  } finally {
    stream.response.destroy();
  }
});

for (const channel of ["product", "alternative"] as const) {
  test(`${channel} ZIP stream rechecks subject binding after its first bytes`, async () => {
    const p = await streamExport(channel),
      stream = await pausedZip(p.url, p.headers);
    try {
      await rebindExport(p);
      const received = await stream.finish();
      assert.equal(received.completed, false);
      assert.ok(received.bytes.length < p.packed.bytes);
      assert.equal(
        (await app.inject({ method: "GET", url: p.url, headers: p.headers }))
          .statusCode,
        403,
      );
    } finally {
      stream.response.destroy();
    }
  });
}

test("alternative ZIP stream rechecks the current administrator session after its first bytes", async () => {
  const p = await alternativeExport(),
    stream = await pausedZip(p.base + "/download", p.admin);
  try {
    const loggedOut = await adminRequest(
      "POST",
      "/v1/admin/logout",
      p.admin,
      {},
    );
    assert.equal(loggedOut.statusCode, 204, loggedOut.body);
    const received = await stream.finish();
    assert.equal(received.completed, false);
    assert.ok(received.bytes.length < p.packed.bytes);
    assert.equal(
      (await adminRequest("GET", p.base + "/download", p.admin)).statusCode,
      401,
    );
  } finally {
    stream.response.destroy();
  }
});

test("replaying an old assisted revocation leaves the newly authorized same-epoch ZIP stream intact", async () => {
  const p = await alternativeExport(),
    originalEpoch = (await state(p, p.buyer.token)).accessEpoch,
    original = await pausedZip(p.base + "/download", p.admin);
  let fresh: Awaited<ReturnType<typeof pausedZip>> | undefined;
  await db.$executeRawUnsafe(
    "CREATE FUNCTION reject_t25_stream_followup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic delayed export followup'; END $$",
  );
  await db.$executeRawUnsafe(
    "CREATE TRIGGER reject_t25_stream_followup BEFORE UPDATE ON project_access_revocations FOR EACH ROW EXECUTE FUNCTION reject_t25_stream_followup()",
  );
  try {
    assert.equal(
      (await assistedExportChoice(p, "collection", false)).statusCode,
      500,
    );
    data(await assistedExportChoice(p, "collection", true));
    assert.equal((await state(p, p.buyer.token)).accessEpoch, originalEpoch);
    fresh = await pausedZip(p.base + "/download", p.admin);
    await db.$executeRawUnsafe(
      "DROP TRIGGER reject_t25_stream_followup ON project_access_revocations",
    );
    await db.$executeRawUnsafe("DROP FUNCTION reject_t25_stream_followup()");
    const status = data(
      await request(
        "GET",
        `/v1/projects/${p.projectId}/withdrawal-status`,
        p.buyer.token,
      ),
      200,
    );
    assert.equal(status.changes[0].applied, true);
    assert.equal((await original.finish()).completed, false);
    const received = await fresh.finish();
    assert.equal(
      received.completed,
      true,
      "old sequence must not abort a new authorized stream in the same epoch",
    );
    assert.equal(received.bytes.length, p.packed.bytes);
    assert.equal(
      createHash("sha256").update(received.bytes).digest("hex"),
      p.packed.sha256,
    );
  } finally {
    original.response.destroy();
    fresh?.response.destroy();
    await db.$executeRawUnsafe(
      "DROP TRIGGER IF EXISTS reject_t25_stream_followup ON project_access_revocations",
    );
    await db.$executeRawUnsafe(
      "DROP FUNCTION IF EXISTS reject_t25_stream_followup()",
    );
  }
});
