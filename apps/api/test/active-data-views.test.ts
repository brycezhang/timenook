import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { randomUUID } from "node:crypto";
import {
  app,
  config,
  db,
  startBookFixture,
  stopBookFixture,
  request,
  data,
  project,
  bound,
  login,
  choose,
  restartBookApplication,
} from "./book-fixture";
import { reviewedQualityOrder, adminRequest } from "./quality-fixture";
import { ProjectServiceTerms } from "../src/projects/service-terms";
import { Deletions } from "../src/care/deletions";

let p: Awaited<ReturnType<typeof reviewedQualityOrder>>,
  cutoff: number,
  versionId: ReturnType<typeof randomUUID>;
before(async () => {
  await startBookFixture();
  await app.get(Deletions).onModuleDestroy();
  p = await reviewedQualityOrder("original", { activeData: 1, bookPdf: 20 });
  const terms = new ProjectServiceTerms(config.databaseUrl);
  try {
    cutoff = Date.parse(
      (await terms.read(p.projectId)).retention!.activeData.expiresAt!,
    );
  } finally {
    await terms.close();
  }
  versionId = (
    await db.paymentOrder.findUniqueOrThrow({ where: { id: p.orderId } })
  ).packageVersionId as typeof versionId;
  await extend(cutoff);
});
after(stopBookFixture);
async function extend(at: number) {
  const expiresAt = new Date(at + 86400000);
  await db.session.updateMany({ data: { expiresAt } });
  await db.adminSession.updateMany({ data: { expiresAt } });
}
async function noScan(id = p.projectId) {
  const [{ n }] = await db.$queryRaw<
    { n: bigint }[]
  >`SELECT count(*) n FROM privacy_deletions WHERE project_id=${id}::uuid`;
  assert.equal(n, 0n);
}
async function delivered(id: string) {
  const terms = new ProjectServiceTerms(config.databaseUrl);
  try {
    await terms.recordFact({
      projectId: id,
      eventId: "synthetic-view-" + randomUUID(),
      kind: "delivery_completed",
      occurredAt: new Date(),
    });
    return Date.parse((await terms.read(id)).retention!.activeData.expiresAt!);
  } finally {
    await terms.close();
  }
}

test("generic verified care details hide only private evidence at the original cutoff before physical scanning", async (t) => {
  const read = () =>
    adminRequest(
      "GET",
      `/v1/admin/care-requests/${p.quality.caseId}`,
      p.headers,
    );
  t.mock.timers.enable({ apis: ["Date"], now: cutoff - 1 });
  try {
    const before = data(await read(), 200);
    assert.equal(
      before.verification.evidenceRef,
      "synthetic:原D07及原印刷责任核验",
    );
    for (const delta of [1, 1]) {
      t.mock.timers.tick(delta);
      await noScan();
      const after = data(await read(), 200);
      assert.equal(after.verification.evidenceRef, null);
      assert.equal(after.verification.noticeVersion, null);
      assert.equal(
        after.verification.operatorAdminId,
        before.verification.operatorAdminId,
      );
      assert.equal(after.verification.createdAt, before.verification.createdAt);
      assert.equal(after.state, before.state);
    }
  } finally {
    t.mock.timers.reset();
  }
});

test("first-copy address is private at activeData cutoff while the independent fixed PDF and binding stay readable", async (t) => {
  const read = () =>
    request("GET", `/v1/projects/${p.projectId}/first-copy`, p.buyer.token);
  t.mock.timers.enable({ apis: ["Date"], now: cutoff - 1 });
  try {
    const before = data(await read(), 200);
    assert.equal(before.address.value.phone, "13800000000");
    t.mock.timers.tick(1);
    await noScan();
    const after = data(await read(), 200);
    assert.equal(after.address.value, null);
    assert.equal(after.address.hash, before.address.hash);
    assert.equal(after.address.version, before.address.version);
    assert.equal(after.production.id, before.production.id);
    assert.equal(after.book.pdf.sha256, before.book.pdf.sha256);
    assert.equal(
      (
        await request(
          "GET",
          `/v1/projects/${p.projectId}/book/versions/${p.book.id}/pdf`,
          p.narrator.token,
        )
      ).statusCode,
      200,
    );
  } finally {
    t.mock.timers.reset();
  }
});

test("fulfillment and quality progress keep exact operational facts but hide expired tracking and receipt payload before any scan", async (t) => {
  const progress = () =>
      request("GET", `/v1/projects/${p.projectId}/fulfillment`, p.buyer.token),
    quality = () => request("GET", p.qualityBase, p.buyer.token);
  t.mock.timers.enable({ apis: ["Date"], now: cutoff - 1 });
  try {
    const before = data(await progress(), 200);
    assert.equal(before.current.tracking.number, "SYNTHETICQUALITY");
    assert.equal(before.current.receiptRef, "synthetic:接单核验");
    assert.equal(
      data(await quality(), 200).attempts[0].tracking.number,
      "SYNTHETICQUALITY",
    );
    t.mock.timers.tick(1);
    await noScan();
    for (const after of [
      data(await progress(), 200),
      data(await adminRequest("GET", p.base, p.headers), 200),
    ]) {
      assert.equal(after.current.tracking, null);
      assert.equal(after.current.wechat, null);
      assert.equal(after.current.receiptRef, null);
      assert.equal(after.current.supplierRef, "资料已删除");
      assert.equal(after.current.id, before.current.id);
      assert.equal(after.current.state, "delivered");
      assert.equal(after.current.pdfHash, before.current.pdfHash);
      assert.equal(after.current.addressHash, before.current.addressHash);
    }
    const q = data(await quality(), 200);
    assert.equal(q.attempts[0].tracking, null);
    assert.equal(q.requests[0].original.tracking, null);
    assert.equal(q.requests[0].state, p.quality.state);
    assert.equal(
      data(await adminRequest("GET", p.qualityAdminBase, p.headers), 200)
        .original.tracking,
      null,
    );
  } finally {
    t.mock.timers.reset();
  }
});

test("a retained story omits expired decision evidence while preserving its independently retained text", async (t) => {
  const read = () =>
    request(
      "GET",
      `/v1/projects/${p.projectId}/stories/${p.story.id}`,
      p.narrator.token,
    );
  t.mock.timers.enable({ apis: ["Date"], now: cutoff - 1 });
  try {
    const before = data(await read(), 200);
    assert.ok(before.decision.evidenceRef);
    t.mock.timers.tick(1);
    await noScan();
    const after = data(await read(), 200);
    assert.equal(after.decision.evidenceRef, null);
    assert.equal(after.decision.confirmed, true);
    assert.equal(after.revision.contentHash, before.revision.contentHash);
    assert.deepEqual(after.revision.paragraphs, before.revision.paragraphs);
  } finally {
    t.mock.timers.reset();
  }
});

test("quality user and admin status omit expired original tracking while the shared case and PDF remain available", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: cutoff - 1 });
  try {
    const before = data(
      await request("GET", p.qualityBase, p.buyer.token),
      200,
    );
    assert.equal(before.attempts[0].tracking.number, "SYNTHETICQUALITY");
    t.mock.timers.tick(1);
    await noScan();
    const after = data(await request("GET", p.qualityBase, p.buyer.token), 200);
    assert.equal(after.attempts[0].tracking, null);
    assert.equal(after.requests[0].original.tracking, null);
    assert.equal(after.requests[0].state, before.requests[0].state);
    assert.equal(
      data(await adminRequest("GET", p.qualityAdminBase, p.headers), 200)
        .original.tracking,
      null,
    );
  } finally {
    t.mock.timers.reset();
  }
});

test("assisted history hides expired evidence while retaining subject, operator and original session facts", async (t) => {
  const q = await project(versionId),
    url = `/v1/projects/${q.projectId}/assisted-sessions`,
    state = data(
      await request(
        "GET",
        `/v1/projects/${q.projectId}/participation`,
        q.buyer.token,
      ),
      200,
    );
  const session = data(
    await request("POST", url, q.buyer.token, {
      purpose: "collection",
      granted: true,
      noticeVersion: "synthetic-d08-v1",
      evidenceRef: "synthetic:协助历史私人证据",
      expectedBindingVersion: state.bindingVersion,
      expectedAccessEpoch: state.accessEpoch,
    }),
  );
  const at = await delivered(q.projectId);
  await extend(at);
  t.mock.timers.enable({ apis: ["Date"], now: at - 1 });
  try {
    assert.equal(
      data(await request("GET", url, q.buyer.token), 200).sessions[0]
        .evidenceRef,
      "synthetic:协助历史私人证据",
    );
    t.mock.timers.tick(1);
    await noScan(q.projectId);
    const after = data(await request("GET", url, q.buyer.token), 200)
      .sessions[0];
    assert.equal(after.evidenceRef, null);
    assert.equal(after.id, session.id);
    assert.equal(after.operatorUserId, session.operatorUserId);
    assert.equal(after.subjectId, session.subjectId);
    assert.equal(after.state, "expired");
  } finally {
    t.mock.timers.reset();
  }
});

test("care rebinding history hides expired evidence without losing the verified binding transition", async (t) => {
  const q = await bound(versionId),
    target = await login(),
    state = data(
      await request(
        "GET",
        `/v1/projects/${q.projectId}/participation`,
        q.narrator.token,
      ),
      200,
    ),
    care = data(
      await request(
        "POST",
        `/v1/projects/${q.projectId}/care-requests`,
        q.narrator.token,
        {
          kind: "rebind",
          targetUserId: target.id,
          expectedBindingVersion: state.bindingVersion,
        },
      ),
    );
  data(
    await adminRequest(
      "POST",
      `/v1/admin/projects/${q.projectId}/rebind`,
      p.headers,
      {
        supportCaseRef: care.supportCaseRef,
        targetUserId: target.id,
        expectedBindingVersion: state.bindingVersion,
        noticeVersion: "synthetic-d08-v1",
        evidenceRef: "synthetic:换绑私人核验证据",
      },
    ),
  );
  const at = await delivered(q.projectId),
    read = () =>
      adminRequest("GET", `/v1/admin/care-requests/${care.id}`, p.headers);
  await extend(at);
  t.mock.timers.enable({ apis: ["Date"], now: at - 1 });
  try {
    const before = data(await read(), 200);
    assert.equal(before.changes[0].evidenceRef, "synthetic:换绑私人核验证据");
    t.mock.timers.tick(1);
    await noScan(q.projectId);
    const after = data(await read(), 200);
    assert.equal(after.changes[0].evidenceRef, null);
    assert.equal(
      after.changes[0].bindingVersion,
      before.changes[0].bindingVersion,
    );
    assert.equal(after.changes[0].operatorId, before.changes[0].operatorId);
  } finally {
    t.mock.timers.reset();
  }
});

test("an expired first-copy address cannot be replaced with new private payload before scanning", async (t) => {
  const q = await bound(versionId);
  data((await choose(q, q.narrator.token, "collection", true)).response);
  data((await choose(q, q.narrator.token, "sharing", true)).response);
  const at = await delivered(q.projectId),
    url = `/v1/projects/${q.projectId}/first-copy/address`,
    body = {
      expectedVersion: 0,
      recipientName: "合成收件人",
      phone: "13800000000",
      regionCode: "CN-110000",
      detail: "截止前地址",
    };
  await extend(at);
  t.mock.timers.enable({ apis: ["Date"], now: at - 1 });
  try {
    assert.equal(
      data(await request("POST", url, q.buyer.token, body)).address.value
        .detail,
      body.detail,
    );
    t.mock.timers.tick(1);
    await noScan(q.projectId);
    assert.equal(
      (
        await request("POST", url, q.buyer.token, {
          ...body,
          expectedVersion: 1,
          detail: "截止后新私人地址",
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await db.firstCopyAddress.findUniqueOrThrow({
          where: { projectId: q.projectId },
        })
      ).version,
      1,
    );
  } finally {
    t.mock.timers.reset();
  }
});

test("a fresh PDF-only quality grant cannot copy an expired original address into a new reprint attempt", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: cutoff });
  try {
    await noScan();
    data(
      await request(
        "POST",
        `${p.qualityBase}/${p.quality.id}/access`,
        p.narrator.token,
        {
          expectedVersion: p.quality.version,
          scopes: ["pdf"],
          expiresAt: new Date(cutoff + 600000).toISOString(),
          consented: true,
          noticeVersion: "synthetic-d08-v1",
        },
      ),
    );
    assert.equal(
      (await adminRequest("GET", p.qualityAdminBase + "/pdf", p.headers))
        .statusCode,
      200,
    );
    assert.equal(
      (
        await adminRequest(
          "POST",
          p.qualityAdminBase + "/reprints",
          p.headers,
          {
            expectedVersion: p.quality.version,
            ...p.binding,
          },
        )
      ).statusCode,
      403,
    );
    assert.equal(
      await db.fulfillmentAttempt.count({ where: { orderId: p.order.id } }),
      1,
    );
  } finally {
    t.mock.timers.reset();
  }
});

test("published activeData cleanup keeps minimal care, fulfillment, quality and fixed PDF reads available", async () => {
  await restartBookApplication();
  await app.get(Deletions).sweep(new Date(cutoff));
  const care = data(
    await adminRequest(
      "GET",
      `/v1/admin/care-requests/${p.quality.caseId}`,
      p.headers,
    ),
    200,
  );
  assert.equal(care.verification.evidenceRef, null);
  const copies = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/first-copy`,
      p.buyer.token,
    ),
    200,
  );
  assert.equal(copies.address.value, null);
  assert.equal(copies.address.hash, p.binding.addressHash);
  assert.equal(copies.book.pdf.sha256, p.binding.pdfHash);
  const fulfillment = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/fulfillment`,
      p.buyer.token,
    ),
    200,
  );
  assert.equal(fulfillment.current.tracking, null);
  const quality = data(await request("GET", p.qualityBase, p.buyer.token), 200);
  assert.equal(quality.attempts[0].tracking, null);
  assert.equal(
    (
      await request(
        "GET",
        `/v1/projects/${p.projectId}/book/versions/${p.book.id}/pdf`,
        p.narrator.token,
      )
    ).statusCode,
    200,
  );
});
