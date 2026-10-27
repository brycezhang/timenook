import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  startBookFixture,
  stopBookFixture,
  app,
  config,
  db,
  request,
  data,
  choose,
  bound,
} from "./book-fixture";
import { reviewedQualityOrder, adminRequest } from "./quality-fixture";
import { ProductionTasks } from "../src/tasks/tasks";
import { Deletions } from "../src/care/deletions";
import { ProjectServiceTerms } from "../src/projects/service-terms";
before(startBookFixture);
after(stopBookFixture);

test("quality access replays historical withdrawals without self-locking and full deletion erases both reprint versions while preserving original money facts", async () => {
  const p = await reviewedQualityOrder("revised");
  data((await choose(p, p.narrator.token, "sharing", false)).response);
  data((await choose(p, p.narrator.token, "sharing", true)).response);
  assert.equal(
    (await adminRequest("GET", p.qualityAdminBase + "/materials", p.headers))
      .statusCode,
    403,
  );
  data(
    await request(
      "POST",
      `${p.qualityBase}/${p.quality.id}/access`,
      p.narrator.token,
      { ...p.qualityAccess, expectedVersion: p.quality.version },
    ),
  );
  const materials = data(
    await adminRequest("GET", p.qualityAdminBase + "/materials", p.headers),
    200,
  );
  assert.equal(materials.description, "合成原单质量核对说明");
  assert.equal(
    (await adminRequest("GET", p.qualityAdminBase + "/pdf", p.headers))
      .statusCode,
    200,
  );
  const story = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/stories/${p.story.id}`,
      p.narrator.token,
    ),
    200,
  );
  data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/stories/${p.story.id}/decisions`,
      p.narrator.token,
      {
        revisionId: story.revision.id,
        expectedVersion: story.version,
        contentHash: story.revision.contentHash,
        confirmed: true,
        allowInBook: true,
        noticeVersion: "synthetic-d08-v1",
        evidenceRef: `synthetic:撤回后重新确认-${randomUUID()}`,
      },
    ),
  );

  const bookBase = `/v1/projects/${p.projectId}/book`,
    firstCopy = `/v1/projects/${p.projectId}/first-copy`;
  data(
    await request("POST", bookBase + "/cover", p.buyer.token, {
      expectedVersion: 0,
      salutation: "删除组合验证的新版封面",
      photoAssetId: null,
    }),
  );
  const context = data(await request("GET", bookBase, p.buyer.token), 200);
  const queued = data(
    await request("POST", bookBase + "/versions", p.buyer.token, {
      expectedInputHash: context.inputHash,
    }),
    202,
  );
  await app.get(ProductionTasks).run(queued.task.id);
  const current = data(await request("GET", firstCopy, p.buyer.token), 200);
  const binding = {
    bookVersionId: current.book.id,
    snapshotHash: current.book.snapshotHash,
    pdfHash: current.book.pdf.sha256,
    addressHash: current.address.hash,
  };
  for (const role of ["narrator", "initiator"])
    data(
      await request(
        "POST",
        firstCopy + "/confirmations",
        role === "narrator" ? p.narrator.token : p.buyer.token,
        {
          ...binding,
          ...(role === "narrator" ? { addressHash: undefined } : {}),
          role,
          noticeVersion: "synthetic-d08-v1",
          evidenceRef: `synthetic:新版核验-${randomUUID()}`,
        },
      ),
    );
  const eligible = data(
    await adminRequest("GET", p.qualityAdminBase, p.headers),
    200,
  );
  const reprint = data(
    await adminRequest("POST", p.qualityAdminBase + "/reprints", p.headers, {
      expectedVersion: eligible.version,
      ...eligible.replacement,
    }),
  );
  assert.ok(reprint.productionAttemptId);
  data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/fulfillment/grants`,
      p.narrator.token,
      {
        ...binding,
        attemptId: reprint.productionAttemptId,
        expiresAt: new Date(Date.now() + 600000).toISOString(),
        noticeVersion: "synthetic-d08-v1",
        evidenceRef: `synthetic:新版交接-${randomUUID()}`,
      },
    ),
  );
  const outputs = await db.bookOutput.findMany({
    where: { bookId: { in: [p.book.id, binding.bookVersionId] } },
  });
  assert.equal(outputs.length, 2);
  for (const output of outputs)
    assert.equal(
      (await readFile(join(config.books!.storageRoot, output.objectKey)))
        .subarray(0, 5)
        .toString(),
      "%PDF-",
    );
  const beforeMoney = await db.paymentOrder.findUniqueOrThrow({
    where: { id: p.orderId },
  });
  const control = await bound();
  data(
    (await choose(control, control.narrator.token, "collection", true))
      .response,
  );
  const participation = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/participation`,
      p.narrator.token,
    ),
    200,
  );
  const care = data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/care-requests`,
      p.narrator.token,
      { kind: "delete", expectedBindingVersion: participation.bindingVersion },
    ),
  );
  data(
    await adminRequest(
      "POST",
      `/v1/admin/care-requests/${care.id}/verify`,
      p.headers,
      {
        expectedBindingVersion: participation.bindingVersion,
        expectedAccessEpoch: participation.accessEpoch,
        noticeVersion: "synthetic-d08-v1",
        evidenceRef: "synthetic:质检删除组合核验",
      },
    ),
  );
  const evidence = await db.qualityEvidence.findUniqueOrThrow({
    where: { requestId: p.quality.id },
  });
  assert.equal(evidence.description, null);
  assert.ok(evidence.erasedAt);
  const quality = await db.qualityRequest.findUniqueOrThrow({
    where: { id: p.quality.id },
  });
  assert.equal(quality.assignmentEvidenceRef, null);
  assert.equal(quality.reviewEvidenceRef, null);
  const status = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/deletion-status`,
      p.narrator.token,
    ),
    200,
  );
  assert.ok(
    status.changes
      .flatMap((change: any) => change.items)
      .filter((item: any) =>
        ["active_database", "active_files", "cache"].includes(item.layer),
      )
      .every((item: any) => item.state === "completed"),
    "explicitly overlapping payload columns finish once without immutable no-op failures",
  );
  const attempts = await db.fulfillmentAttempt.findMany({
    where: { projectId: p.projectId },
  });
  assert.equal(attempts.length, 2);
  assert.ok(
    attempts.every(
      (a) =>
        a.address === null &&
        a.tracking === null &&
        a.supplierRef === null &&
        a.receiptRef === null,
    ),
  );
  assert.equal(
    (
      await db.firstCopyEntitlement.findUniqueOrThrow({
        where: { projectId: p.projectId },
      })
    ).state,
    "consumed",
  );
  const afterMoney = await db.paymentOrder.findUniqueOrThrow({
    where: { id: p.orderId },
  });
  for (const key of [
    "amount",
    "outTradeNo",
    "state",
    "createdAt",
    "packageVersionId",
  ] as const)
    assert.deepEqual(afterMoney[key], beforeMoney[key]);
  for (const output of outputs)
    await assert.rejects(
      access(join(config.books!.storageRoot, output.objectKey)),
      { code: "ENOENT" },
    );
  assert.ok(
    (await db.qualityGrant.count({ where: { projectId: p.projectId } })) >= 2,
  );
  for (const suffix of ["/materials", "/pdf"])
    assert.equal(
      (await adminRequest("GET", p.qualityAdminBase + suffix, p.headers))
        .statusCode,
      403,
    );
  assert.equal(
    (
      await request(
        "POST",
        `${p.qualityBase}/${p.quality.id}/access`,
        p.narrator.token,
        { ...p.qualityAccess, expectedVersion: quality.version },
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await adminRequest("POST", p.qualityAdminBase + "/reprints", p.headers, {
        expectedVersion: quality.version,
        ...binding,
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await request(
        "GET",
        `/v1/projects/${control.projectId}/plan`,
        control.narrator.token,
      )
    ).statusCode,
    200,
  );
  await assert.rejects(
    db.$executeRaw`UPDATE quality_evidence SET description='restored',erased_at=NULL WHERE request_id=${p.quality.id}::uuid`,
  );
  await app.get(Deletions).reconcile(p.projectId);
  assert.deepEqual(
    (
      await db.qualityEvidence.findUniqueOrThrow({
        where: { requestId: p.quality.id },
      })
    ).erasedAt,
    evidence.erasedAt,
  );
});

test("activeData expiry erases quality text with a monotonic receipt and leaves its separately retained original PDF readable", async () => {
  const p = await reviewedQualityOrder("original", {
    activeData: 1,
    bookPdf: 20,
  });
  const terms = new ProjectServiceTerms(config.databaseUrl);
  const deadline = (await terms.read(p.projectId)).retention!.activeData
    .expiresAt!;
  await terms.close();
  const output = await db.bookOutput.findUniqueOrThrow({
    where: { bookId: p.book.id },
  });
  const path = join(config.books!.storageRoot, output.objectKey),
    pdf = await readFile(path);
  await app.get(Deletions).sweep(new Date(Date.parse(deadline) - 1));
  assert.equal(
    (
      await db.qualityEvidence.findUniqueOrThrow({
        where: { requestId: p.quality.id },
      })
    ).description,
    "合成原单质量核对说明",
  );
  await app.get(Deletions).sweep(new Date(deadline));
  const erased = await db.qualityEvidence.findUniqueOrThrow({
    where: { requestId: p.quality.id },
  });
  assert.equal(erased.description, null);
  assert.ok(erased.erasedAt);
  assert.equal(
    (await adminRequest("GET", p.qualityAdminBase + "/materials", p.headers))
      .statusCode,
    403,
  );
  assert.equal(
    (await adminRequest("GET", p.qualityAdminBase + "/pdf", p.headers))
      .statusCode,
    200,
  );
  assert.deepEqual(await readFile(path), pdf);
  assert.equal(
    (await request("GET", `/v1/projects/${p.projectId}/plan`, p.narrator.token))
      .statusCode,
    403,
  );
  assert.equal(
    (
      await request(
        "GET",
        `/v1/projects/${p.projectId}/interviews`,
        p.narrator.token,
      )
    ).statusCode,
    403,
  );
  const order = data(
    await request("GET", `/v1/orders/${p.orderId}`, p.buyer.token),
    200,
  );
  assert.equal(order.project, null);
  assert.equal(order.materialsUnavailable, true);
  await app.get(Deletions).sweep(new Date(Date.parse(deadline) + 1));
  assert.deepEqual(
    (
      await db.qualityEvidence.findUniqueOrThrow({
        where: { requestId: p.quality.id },
      })
    ).erasedAt,
    erased.erasedAt,
  );
});
