import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  app,
  config,
  db,
  startBookFixture,
  stopBookFixture,
  bound,
  interview,
  request,
  data,
  storyPhoto,
  choose,
} from "./book-fixture";
import { readyFirstCopyBook } from "./first-copy-fixture";
import { paymentAdmin } from "./payment-admin-fixture";
import { refundFault, supplierRefunds } from "./payment-fixture";
import { ProjectServiceTerms } from "../src/projects/service-terms";
import { Deletions } from "../src/care/deletions";
before(startBookFixture);
after(stopBookFixture);
test("a real metadata change before erasure is detected from retained counters even if the old PDF was never reread", async () => {
  const p = await readyFirstCopyBook({}, {}, { activeData: 1, bookPdf: 20 }),
    base = `/v1/projects/${p.projectId}/book`;
  data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/metadata`,
      p.narrator.token,
      { expectedVersion: 0, bookTitle: "擦除之前已实际修改" },
    ),
  );
  const row = await db.bookVersion.findUniqueOrThrow({
    where: { id: p.book.id },
  });
  assert.equal(
    (await db.productionTask.findUniqueOrThrow({ where: { id: row.taskId } }))
      .state,
    "succeeded",
  );
  await app.get(Deletions).sweep(await delivery(p.projectId));
  assert.equal(
    data(
      await request("GET", `${base}/versions/${p.book.id}`, p.narrator.token),
      200,
    ).state,
    "obsolete",
  );
  assert.equal(
    (
      await request(
        "GET",
        `${base}/versions/${p.book.id}/pdf`,
        p.narrator.token,
      )
    ).statusCode,
    409,
  );
});
test("erasure of live inputs never restores a PDF already made obsolete by an actual cover edit", async () => {
  const p = await readyFirstCopyBook({}, {}, { activeData: 1, bookPdf: 20 }),
    base = `/v1/projects/${p.projectId}/book`;
  const edited = data(
    await request("POST", base + "/cover", p.narrator.token, {
      expectedVersion: 0,
      salutation: "已改变的实际封面",
      photoAssetId: null,
    }),
  );
  assert.equal(edited.current.state, "obsolete");
  await app.get(Deletions).sweep(await delivery(p.projectId));
  assert.equal(
    data(
      await request("GET", `${base}/versions/${p.book.id}`, p.narrator.token),
      200,
    ).state,
    "obsolete",
  );
  assert.equal(
    (
      await request(
        "GET",
        `${base}/versions/${p.book.id}/pdf`,
        p.narrator.token,
      )
    ).statusCode,
    409,
  );
});
async function delivery(projectId: string, anchor = new Date()) {
  const terms = new ProjectServiceTerms(config.databaseUrl);
  try {
    await terms.recordFact({
      projectId,
      eventId: "synthetic-review-" + randomUUID(),
      kind: "delivery_completed",
      occurredAt: anchor,
    });
  } finally {
    await terms.close();
  }
  return new Date(anchor.getTime() + 86400000);
}
test("activeData-only expiry preserves new refunds and commands on approved money while discarding private evidence", async () => {
  const snapshot = JSON.parse(
    readFileSync("test/fixtures/catalog-synthetic.json", "utf8"),
  );
  snapshot.admission.d03.retention.activeData.duration.value = 1;
  const draftId = randomUUID(),
    versionId = randomUUID();
  await db.packageDraft.create({
    data: { id: draftId, realm: "local", ...snapshot },
  });
  await db.packageVersion.create({
    data: {
      id: versionId,
      realm: "local",
      purpose: "local_preview",
      draftId,
      draftRevision: 1,
      snapshot,
      publicOffer: {
        title: "合成分类退款",
        price: { value: 99900, unit: "fen", currency: "CNY" },
      },
    },
  });
  const fresh = await bound(versionId),
    old = await bound(versionId);
  for (const p of [fresh, old]) await interview(p, false);
  const headers = await paymentAdmin(config, app, ["care:write", "audit:read"]);
  const admin = (id: string, path: string, payload: object) =>
    app.inject({
      method: "POST",
      url: `/v1/admin/refunds/${id}${path}`,
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload,
    });
  const requestBody = {
    reason: "usedNotProduced",
    evidenceRef: "synthetic:本次退款的私人正文",
  };
  const prior = data(
    await request(
      "POST",
      `/v1/orders/${old.orderId}/refunds`,
      old.buyer.token,
      requestBody,
    ),
  );
  data(
    await admin(prior.id, "/approve", {
      amountFen: 70000,
      evidenceRef: "synthetic:原批准正文",
    }),
  );
  const cutoff = await delivery(fresh.projectId);
  await delivery(old.projectId, new Date(cutoff.getTime() - 86400000));
  await app.get(Deletions).sweep(cutoff);
  const created = data(
    await request(
      "POST",
      `/v1/orders/${fresh.orderId}/refunds`,
      fresh.buyer.token,
      requestBody,
    ),
  );
  assert.equal(
    data(
      await admin(created.id, "/approve", {
        amountFen: 70000,
        evidenceRef: "synthetic:到期后批准正文",
      }),
    ).amountFen,
    70000,
  );
  refundFault("timeout");
  assert.equal(data(await admin(created.id, "/submit", {})).state, "unknown");
  const unknown = data(
    await request(
      "GET",
      `/v1/orders/${fresh.orderId}/refunds`,
      fresh.buyer.token,
    ),
    200,
  );
  assert.equal(unknown.reservedAmountFen, 70000);
  assert.equal(unknown.productionFrozen, true);
  Object.assign(supplierRefunds.get(created.outRefundNo)!, {
    status: "SUCCESS",
    success_time: new Date().toISOString(),
  });
  assert.equal(
    data(await admin(created.id, "/reconcile", {})).state,
    "succeeded",
  );
  assert.equal(
    data(
      await admin(prior.id, "/reject", {
        evidenceRef: "synthetic:到期后撤销批准正文",
      }),
    ).state,
    "rejected",
  );
  const money = data(
    await request(
      "GET",
      `/v1/orders/${fresh.orderId}/refunds`,
      fresh.buyer.token,
    ),
    200,
  );
  assert.equal(money.refundedAmountFen, 70000);
  assert.equal(money.reservedAmountFen, 0);
  for (const id of [prior.id, created.id]) {
    assert.equal(
      (await db.refund.findUniqueOrThrow({ where: { id } })).evidenceRef,
      null,
    );
    assert.ok(
      (await db.refundCommand.findMany({ where: { refundId: id } })).every(
        (row) => row.payload === null,
      ),
    );
  }
});
test("a retained user PDF stays readable after live plan erasure while edits and current authorization remain enforced", async () => {
  const p = await readyFirstCopyBook({}, {}, { activeData: 1, bookPdf: 20 }),
    base = `/v1/projects/${p.projectId}/book`;
  const before = await request(
    "GET",
    `${base}/versions/${p.book.id}/pdf`,
    p.narrator.token,
  );
  assert.equal(before.statusCode, 200);
  await app.get(Deletions).sweep(await delivery(p.projectId));
  const context = data(await request("GET", base, p.narrator.token), 200);
  assert.equal(context.draftAccess.allowed, false);
  assert.equal(context.inputHash, null);
  assert.equal(context.current.state, "ready");
  const current = data(
    await request("GET", `${base}/versions/${p.book.id}`, p.narrator.token),
    200,
  );
  assert.equal(current.state, "ready");
  assert.equal(
    (
      await request(
        "POST",
        `/v1/projects/${p.projectId}/metadata`,
        p.narrator.token,
        { expectedVersion: 0, bookTitle: "不可重新写入已到期书名" },
      )
    ).statusCode,
    403,
  );
  const after = await request(
    "GET",
    `${base}/versions/${p.book.id}/pdf`,
    p.narrator.token,
  );
  assert.equal(after.statusCode, 200);
  assert.deepEqual(after.rawPayload, before.rawPayload);
  assert.equal(
    (
      await request("POST", base + "/cover", p.narrator.token, {
        expectedVersion: 0,
        salutation: "不可改稿",
        photoAssetId: null,
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await request("POST", base + "/versions", p.narrator.token, {
        expectedInputHash: p.book.inputHash,
      })
    ).statusCode,
    403,
  );
  data((await choose(p, p.narrator.token, "collection", false)).response);
  assert.equal(
    (
      await request(
        "GET",
        `${base}/versions/${p.book.id}/pdf`,
        p.narrator.token,
      )
    ).statusCode,
    403,
  );
});
for (const expired of ["originalPhotos", "derivedPhotos"] as const)
  test(`${expired} expiry denies that class and preserves actual independent photo downloads`, async () => {
    const p = await readyFirstCopyBook(
      {},
      {},
      {
        originalPhotos: expired === "originalPhotos" ? 1 : 20,
        derivedPhotos: expired === "derivedPhotos" ? 1 : 20,
      },
    );
    const photos = await storyPhoto(p, "独立照片分类说明"),
      photo = photos.entries[0],
      base = `/v1/projects/${p.projectId}/interviews/${p.interviewId}/photos/${photo.photoId}/content`;
    const beforeOriginal = await request(
        "GET",
        base + "/original",
        p.narrator.token,
      ),
      beforePreview = await request("GET", base + "/preview", p.narrator.token);
    assert.equal(beforeOriginal.statusCode, 200);
    assert.equal(beforePreview.statusCode, 200);
    await app.get(Deletions).sweep(await delivery(p.projectId));
    const original = await request("GET", base + "/original", p.narrator.token),
      preview = await request("GET", base + "/preview", p.narrator.token);
    assert.equal(original.statusCode, expired === "originalPhotos" ? 403 : 200);
    assert.equal(preview.statusCode, expired === "derivedPhotos" ? 403 : 200);
    if (original.statusCode === 200)
      assert.deepEqual(original.rawPayload, beforeOriginal.rawPayload);
    if (preview.statusCode === 200)
      assert.deepEqual(preview.rawPayload, beforePreview.rawPayload);
  });
test("activeData expiry still permits an authenticated refusal and a newly verified permanent deletion without new private evidence", async () => {
  const p = await readyFirstCopyBook({}, {}, { activeData: 1, bookPdf: 20 });
  await app.get(Deletions).sweep(await delivery(p.projectId));
  const refusal = data(
    (await choose(p, p.narrator.token, "collection", false)).response,
  );
  const care = data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/care-requests`,
      p.narrator.token,
      { kind: "delete", expectedBindingVersion: refusal.bindingVersion },
    ),
  );
  const headers = await paymentAdmin(config, app, ["care:write", "audit:read"]);
  data(
    await app.inject({
      method: "POST",
      url: `/v1/admin/care-requests/${care.id}/verify`,
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: {
        expectedBindingVersion: refusal.bindingVersion,
        expectedAccessEpoch: refusal.accessEpoch,
        noticeVersion: "synthetic-d08-v1",
        evidenceRef: "synthetic:到期后核验删除",
      },
    }),
  );
  const status = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/deletion-status`,
      p.narrator.token,
    ),
    200,
  );
  assert.equal(status.permanentProjectDeletion, true);
  assert.ok(
    (
      await db.consentRecord.findMany({
        where: { projectId: p.projectId, granted: false },
      })
    ).every((row) => row.evidenceRef === null),
  );
  const verified = await db.careRequest.findUniqueOrThrow({
    where: { id: care.id },
  });
  assert.equal(verified.verificationEvidence, null);
  assert.equal(verified.verificationNotice, null);
  assert.equal(
    (
      await request(
        "POST",
        `/v1/projects/${p.projectId}/consents`,
        p.narrator.token,
        {
          purpose: "collection",
          granted: true,
          expectedBindingVersion: refusal.bindingVersion,
          expectedAccessEpoch: status.accessEpoch,
          noticeVersion: "synthetic-d08-v1",
          evidenceRef: "synthetic:不可复活",
        },
      )
    ).statusCode,
    403,
  );
});
