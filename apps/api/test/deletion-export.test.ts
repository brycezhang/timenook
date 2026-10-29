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
import { exportVerificationScope } from "./complete-export-fixture";
before(startBookFixture);
after(stopBookFixture);
test("completed export packages have no business expiry and survive maintenance and orphan cleanup beyond 2099", async (t) => {
  const p = await readyFirstCopyBook();
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
        ...(await exportVerificationScope(opened.id, headers)),
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
  assert.equal(first.expiresAt, null);
  assert.equal(second.expiresAt, null);
  const row = await db.careExport.findUniqueOrThrow({
    where: { id: first.id },
  });
  const path = join(config.books!.storageRoot, row.objectKey!),
    bytes = await readFile(path);
  await db.session.updateMany({
    data: { expiresAt: new Date("2200-01-01T00:00:00Z") },
  });
  await db.adminSession.updateMany({
    data: { expiresAt: new Date("2200-01-01T00:00:00Z") },
  });
  t.mock.timers.enable({
    apis: ["Date"],
    now: Date.parse("2100-01-01T00:00:00Z"),
  });
  try {
    await app.get(Deletions).sweep();
    data(await admin("/v1/admin/exports/cleanup", {}));
    await restartBookApplication();
    await app.get(Deletions).sweep();
    assert.deepEqual(await readFile(path), bytes);
    assert.ok(
      (await db.careExport.findUniqueOrThrow({ where: { id: first.id } }))
        .manifest,
    );
    assert.equal(
      (
        await request(
          "GET",
          `/v1/projects/${p.projectId}/exports/${first.id}/download`,
          p.narrator.token,
        )
      ).statusCode,
      200,
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
    const events = (
      await new PrivacyJournal(config.privacyJournal!).snapshot()
    ).events.filter(
      (e) => e.projectId === p.projectId && e.kind === "deletion",
    );
    assert.equal(events.length, 0);
  } finally {
    t.mock.timers.reset();
  }
});
