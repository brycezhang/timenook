import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  startBookFixture,
  stopBookFixture,
  app,
  config,
  db,
  request,
  data,
  restartBookApplication,
} from "./book-fixture";
import { readyFirstCopyBook } from "./first-copy-fixture";
import { paymentAdmin } from "./payment-admin-fixture";
import { Deletions } from "../src/care/deletions";
import { PrivacyJournal } from "../src/privacy-journal/privacy-journal";
before(startBookFixture);
after(stopBookFixture);
test("each export expires at its own ready deadline without erasing another package or barring a later export", async () => {
  const p = await readyFirstCopyBook({}, {}, { exportPackages: 1 });
  const headers = await paymentAdmin(config, app, ["care:write", "audit:read"]);
  const admin = (url: string, payload: object) =>
    app.inject({
      method: "POST",
      url,
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload,
    });
  async function pack() {
    const opened = data(
      await request(
        "POST",
        `/v1/projects/${p.projectId}/exports`,
        p.narrator.token,
        {
          recipient: "self",
          noticeVersion: "synthetic-d08-v1",
          evidenceRef: `synthetic:逐包导出-${randomUUID()}`,
        },
      ),
    );
    const current = data(
      await request(
        "GET",
        `/v1/projects/${p.projectId}/participation`,
        p.narrator.token,
      ),
      200,
    );
    data(
      await admin(`/v1/admin/care-requests/${opened.id}/verify`, {
        expectedBindingVersion: current.bindingVersion,
        expectedAccessEpoch: current.accessEpoch,
        noticeVersion: "synthetic-d08-v1",
        evidenceRef: "synthetic:逐包核验本人",
      }),
    );
    const base = `/v1/admin/care-requests/${opened.id}/export`;
    data(
      await admin(base + "/accept", {
        dueAt: new Date(Date.now() + 86400000).toISOString(),
        evidenceRef: "synthetic:逐包处理期限",
      }),
    );
    return data(await admin(base + "/pack", {}));
  }
  const first = await pack(),
    second = await pack();
  assert.ok(Date.parse(first.expiresAt) < Date.parse(second.expiresAt));
  const old = await db.careExport.findUniqueOrThrow({
    where: { id: first.id },
  });
  const other = await db.careExport.findUniqueOrThrow({
    where: { id: second.id },
  });
  const oldPath = join(config.books!.storageRoot, old.objectKey!),
    otherPath = join(config.books!.storageRoot, other.objectKey!);
  const otherBytes = await readFile(otherPath);
  await app.get(Deletions).sweep(new Date(Date.parse(first.expiresAt) - 1));
  assert.ok(
    (await db.careExport.findUniqueOrThrow({ where: { id: first.id } }))
      .manifest,
  );
  await app.get(Deletions).sweep(new Date(first.expiresAt));
  const erased = await db.careExport.findUniqueOrThrow({
    where: { id: first.id },
  });
  assert.equal(erased.manifest, null);
  assert.equal(erased.evidenceRef, null);
  await assert.rejects(access(oldPath), { code: "ENOENT" });
  assert.equal(
    (
      await request(
        "GET",
        `/v1/projects/${p.projectId}/exports/${first.id}/download`,
        p.narrator.token,
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await request(
        "GET",
        `/v1/projects/${p.projectId}/exports/${second.id}/download`,
        p.narrator.token,
      )
    ).statusCode,
    200,
  );
  assert.deepEqual(await readFile(otherPath), otherBytes);
  const next = await pack();
  assert.equal(next.state, "ready");
  await restartBookApplication();
  await app.get(Deletions).sweep(new Date(first.expiresAt));
  const events = (
    await new PrivacyJournal(config.privacyJournal!).snapshot()
  ).events.filter((e) => e.payload.scopedExportId === first.id);
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.effectiveAt, first.expiresAt);
  const status = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/deletion-status`,
      p.narrator.token,
    ),
    200,
  );
  assert.equal(status.permanentProjectDeletion, false);
  assert.equal(status.onlineAccessStopped, false);
  assert.equal(
    (await request("GET", `/v1/projects/${p.projectId}/plan`, p.narrator.token))
      .statusCode,
    200,
  );
});
