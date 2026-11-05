import { randomUUID, createHash } from "node:crypto";
import assert from "node:assert/strict";
import {
  startBookFixture,
  stopBookFixture,
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
  pendingStreamExport,
  recordAlternativeStaffVerification,
} from "./complete-export-fixture";

before(startBookFixture);

after(stopBookFixture);

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
