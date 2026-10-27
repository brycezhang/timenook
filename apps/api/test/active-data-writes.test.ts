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
  project,
  bound,
  login,
  request,
  data,
  restartBookApplication,
} from "./book-fixture";
import {
  readyFirstCopyBook,
  readyReservedFirstCopy,
} from "./first-copy-fixture";
import {
  qualityAdmin,
  adminRequest,
  reviewedQualityOrder,
  deliveredQualityOrder,
} from "./quality-fixture";
import { refundFault, supplierRefunds } from "./payment-fixture";
import { ProjectServiceTerms } from "../src/projects/service-terms";
import { Deletions } from "../src/care/deletions";
import { PrivacyJournal } from "../src/privacy-journal/privacy-journal";
let versionId = randomUUID();
before(async () => {
  await startBookFixture();
  await app.get(Deletions).onModuleDestroy();
  const snapshot = JSON.parse(
    readFileSync("test/fixtures/catalog-synthetic.json", "utf8"),
  );
  snapshot.admission.d03.retention.activeData.duration.value = 1;
  const draftId = randomUUID();
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
        title: "合成截止写入控制",
        price: { value: 99900, unit: "fen", currency: "CNY" },
      },
    },
  });
});
after(stopBookFixture);
async function delivered(id: string) {
  const terms = new ProjectServiceTerms(config.databaseUrl);
  try {
    await terms.recordFact({
      projectId: id,
      kind: "delivery_completed",
      eventId: "synthetic-write-" + randomUUID(),
      occurredAt: new Date(),
    });
    return Date.parse((await terms.read(id)).retention!.activeData.expiresAt!);
  } finally {
    await terms.close();
  }
}
async function extend(cutoff: number) {
  const expiresAt = new Date(cutoff + 86400000);
  await db.session.updateMany({ data: { expiresAt } });
  await db.adminSession.updateMany({ data: { expiresAt } });
}
async function noScan(projectId: string) {
  const [{ n }] = await db.$queryRaw<
    { n: bigint }[]
  >`SELECT count(*) n FROM privacy_deletions WHERE project_id=${projectId}::uuid`;
  assert.equal(n, 0n);
}
for (const offset of [-1, 0, 1])
  test(`assisted positive and negative writes honor the original cutoff ${offset}ms before scanning`, async (t) => {
    const p = await project(versionId),
      url = `/v1/projects/${p.projectId}/assisted-sessions`,
      state = data(
        await request(
          "GET",
          `/v1/projects/${p.projectId}/participation`,
          p.buyer.token,
        ),
        200,
      ),
      base = {
        noticeVersion: "synthetic-d08-v1",
        expectedBindingVersion: state.bindingVersion,
        expectedAccessEpoch: state.accessEpoch,
      },
      original = data(
        await request("POST", url, p.buyer.token, {
          ...base,
          purpose: "collection",
          granted: true,
          evidenceRef: "synthetic:原协助证据",
        }),
      ),
      cutoff = await delivered(p.projectId);
    await extend(cutoff);
    t.mock.timers.enable({ apis: ["Date"], now: cutoff + offset });
    try {
      await noScan(p.projectId);
      const positive = await request("POST", url, p.buyer.token, {
        ...base,
        purpose: "ai",
        granted: true,
        evidenceRef: "synthetic:新肯定协助私人证据",
      });
      assert.equal(positive.statusCode, offset < 0 ? 201 : 403);
      const body = {
          ...base,
          purpose: "collection",
          granted: false,
          expectedSessionId: original.id,
          evidenceRef: "synthetic:否定协助私人证据",
        },
        key = randomUUID();
      const rejected = data(
        await request("POST", url, p.buyer.token, body, key),
      );
      assert.equal(rejected.granted, false);
      assert.equal(
        data(await request("POST", url, p.buyer.token, body, key)).id,
        rejected.id,
      );
      assert.equal(
        (
          await db.assistedSession.findUniqueOrThrow({
            where: { id: rejected.id },
          })
        ).evidenceRef,
        offset < 0 ? body.evidenceRef : null,
      );
      assert.equal(
        (
          await db.consentRecord.findFirstOrThrow({
            where: {
              projectId: p.projectId,
              purpose: "collection",
              granted: false,
            },
          })
        ).evidenceRef,
        offset < 0 ? body.evidenceRef : null,
      );
      assert.equal(
        await db.assistedSession.count({
          where: { projectId: p.projectId, purpose: "ai", granted: true },
        }),
        offset < 0 ? 1 : 0,
      );
      await noScan(p.projectId);
    } finally {
      t.mock.timers.reset();
    }
  });
test("published activeData expiry still records an assisted refusal with no private payload or positive authorization", async (t) => {
  const p = await project(versionId),
    url = `/v1/projects/${p.projectId}/assisted-sessions`,
    cutoff = await delivered(p.projectId);
  await extend(cutoff);
  await restartBookApplication();
  t.mock.timers.enable({ apis: ["Date"], now: cutoff });
  try {
    await app.get(Deletions).sweep(new Date(cutoff));
    const state = data(
        await request(
          "GET",
          `/v1/projects/${p.projectId}/participation`,
          p.buyer.token,
        ),
        200,
      ),
      body = {
        purpose: "collection",
        granted: false,
        noticeVersion: "synthetic-d08-v1",
        evidenceRef: "synthetic:已发布后的否定证据",
        expectedBindingVersion: state.bindingVersion,
        expectedAccessEpoch: state.accessEpoch,
      };
    const rejected = data(await request("POST", url, p.buyer.token, body));
    assert.equal(
      (
        await db.assistedSession.findUniqueOrThrow({
          where: { id: rejected.id },
        })
      ).evidenceRef,
      null,
    );
    assert.equal(
      (
        await request("POST", url, p.buyer.token, {
          ...body,
          granted: true,
          evidenceRef: "synthetic:不得重开肯定用途",
          expectedSessionId: rejected.id,
        })
      ).statusCode,
      403,
    );
  } finally {
    t.mock.timers.reset();
    await app.get(Deletions).onModuleDestroy();
  }
});

test("verified rebinding preserves minimum transitions and source fencing without new evidence at and after activeData cutoff", async (t) => {
  const p = await bound(versionId),
    headers = await qualityAdmin(),
    cutoff = await delivered(p.projectId);
  await extend(cutoff);
  let current = p.narrator;
  t.mock.timers.enable({ apis: ["Date"], now: cutoff - 1 });
  try {
    for (const offset of [-1, 0, 1]) {
      if (offset >= 0) t.mock.timers.tick(1);
      const state = data(
          await request(
            "GET",
            `/v1/projects/${p.projectId}/participation`,
            current.token,
          ),
          200,
        ),
        target = await login(),
        care = data(
          await request(
            "POST",
            `/v1/projects/${p.projectId}/care-requests`,
            current.token,
            {
              kind: "rebind",
              targetUserId: target.id,
              expectedBindingVersion: state.bindingVersion,
            },
          ),
        ),
        body = {
          supportCaseRef: care.supportCaseRef,
          targetUserId: target.id,
          expectedBindingVersion: state.bindingVersion,
          noticeVersion: "synthetic-d08-v1",
          evidenceRef: `synthetic:换绑写入-${offset}`,
        },
        key = randomUUID();
      const change = data(
        await adminRequest(
          "POST",
          `/v1/admin/projects/${p.projectId}/rebind`,
          headers,
          body,
          key,
        ),
      );
      assert.equal(
        data(
          await adminRequest(
            "POST",
            `/v1/admin/projects/${p.projectId}/rebind`,
            headers,
            body,
            key,
          ),
        ).bindingVersion,
        change.bindingVersion,
      );
      const row = await db.bindingChange.findFirstOrThrow({
        where: { supportCaseId: care.id },
      });
      assert.equal(row.evidenceRef, offset < 0 ? body.evidenceRef : null);
      assert.equal(
        (
          await request(
            "GET",
            `/v1/projects/${p.projectId}/participation`,
            current.token,
          )
        ).statusCode,
        403,
      );
      current = target;
      await noScan(p.projectId);
    }
  } finally {
    t.mock.timers.reset();
  }
});

test("story refusals discard expired evidence, preserve authentic confirmation basis and never grant a new positive decision", async (t) => {
  const p = await readyFirstCopyBook({}, {}, { activeData: 1 }),
    cutoff = await delivered(p.projectId),
    url = `/v1/projects/${p.projectId}/stories/${p.story.id}/decisions`,
    base = {
      revisionId: p.story.revision.id,
      expectedVersion: p.story.version,
      contentHash: p.story.revision.contentHash,
      noticeVersion: "synthetic-d08-v1",
    };
  await extend(cutoff);
  t.mock.timers.enable({ apis: ["Date"], now: cutoff - 1 });
  try {
    const legal = {
      ...base,
      confirmed: true,
      allowInBook: true,
      evidenceRef: "synthetic:截止前合法确认",
    };
    data(await request("POST", url, p.narrator.token, legal));
    t.mock.timers.tick(1);
    await noScan(p.projectId);
    const positive = await request("POST", url, p.narrator.token, {
      ...legal,
      evidenceRef: "synthetic:截止后不得新增肯定",
    });
    const denial = {
        ...base,
        confirmed: true,
        allowInBook: false,
        evidenceRef: "synthetic:仅撤回入书",
      },
      key = randomUUID();
    data(await request("POST", url, p.narrator.token, denial, key));
    data(await request("POST", url, p.narrator.token, denial, key));
    assert.equal(positive.statusCode, 403);
    const denied = await db.storyDecision.findFirstOrThrow({
      where: { projectId: p.projectId, idempotencyKey: key },
    });
    assert.equal(denied.method, "journal_denial");
    assert.match(denied.evidenceRef!, /^journal:[a-f0-9]{64}$/);
    t.mock.timers.tick(1);
    const second = {
        ...denial,
        confirmed: false,
        evidenceRef: "synthetic:撤回全部确认",
      },
      secondKey = randomUUID();
    data(await request("POST", url, p.narrator.token, second, secondKey));
    assert.match(
      (
        await db.storyDecision.findFirstOrThrow({
          where: { projectId: p.projectId, idempotencyKey: secondKey },
        })
      ).evidenceRef!,
      /^journal:[a-f0-9]{64}$/,
    );
    assert.equal(
      (
        await request("POST", url, p.narrator.token, {
          ...denial,
          evidenceRef: "synthetic:否定后不能制造确认",
        })
      ).statusCode,
      403,
    );
  } finally {
    t.mock.timers.reset();
  }
});

test("new staff access and initiator print confirmation cannot write activeData evidence after its original cutoff", async (t) => {
  const p = await readyFirstCopyBook({}, {}, { activeData: 1 }),
    cutoff = await delivered(p.projectId),
    base = `/v1/projects/${p.projectId}/first-copy`;
  const address = data(
    await request("POST", base + "/address", p.buyer.token, {
      expectedVersion: 0,
      recipientName: "合成人",
      phone: "13800000000",
      regionCode: "CN-110000",
      detail: "合成地址",
    }),
  );
  await extend(cutoff);
  t.mock.timers.enable({ apis: ["Date"], now: cutoff - 1 });
  try {
    const confirmation = {
        role: "initiator",
        bookVersionId: p.book.id,
        snapshotHash: p.book.snapshotHash,
        pdfHash: p.book.pdf.sha256,
        addressHash: address.address.hash,
        noticeVersion: "synthetic-d08-v1",
        evidenceRef: "synthetic:截止前发起人确认",
      },
      staffUrl = `/v1/projects/${p.projectId}/stories/${p.story.id}/care-access`,
      staff = {
        revisionId: p.story.revision.id,
        expectedVersion: p.story.version,
        contentHash: p.story.revision.contentHash,
        expiresAt: new Date(cutoff + 600000).toISOString(),
        noticeVersion: "synthetic-d08-v1",
        evidenceRef: "synthetic:截止前客服授权",
      };
    data(
      await request(
        "POST",
        base + "/confirmations",
        p.buyer.token,
        confirmation,
      ),
    );
    data(await request("POST", staffUrl, p.narrator.token, staff));
    t.mock.timers.tick(1);
    await noScan(p.projectId);
    const expiredConfirmation = (
      await request("POST", base + "/confirmations", p.buyer.token, {
        ...confirmation,
        evidenceRef: "synthetic:截止后发起人证据",
      })
    ).statusCode;
    const expiredStaff = (
      await request("POST", staffUrl, p.narrator.token, {
        ...staff,
        evidenceRef: "synthetic:截止后客服证据",
      })
    ).statusCode;
    assert.deepEqual([expiredConfirmation, expiredStaff], [403, 403]);
  } finally {
    t.mock.timers.reset();
  }
});

for (const published of [false, true])
  test(`late fulfillment stores only actual times and states and accepts original input replays with published expiry=${published}`, async (t) => {
    const p = await reviewedQualityOrder("original", { activeData: 1 }),
      reprint = data(
        await adminRequest(
          "POST",
          p.qualityAdminBase + "/reprints",
          p.headers,
          { expectedVersion: p.quality.version, ...p.binding },
        ),
      ),
      attemptId = reprint.productionAttemptId,
      base = `${p.base}/attempts/${attemptId}`;
    data(
      await request(
        "POST",
        `/v1/projects/${p.projectId}/fulfillment/grants`,
        p.narrator.token,
        {
          ...p.binding,
          attemptId,
          expiresAt: new Date(Date.now() + 600000).toISOString(),
          noticeVersion: "synthetic-d08-v1",
          evidenceRef: "synthetic:重印交接授权",
        },
      ),
    );
    data(await adminRequest("POST", base + "/handoff", p.headers, {}));
    const terms = new ProjectServiceTerms(config.databaseUrl);
    let cutoff: number;
    try {
      cutoff = Date.parse(
        (await terms.read(p.projectId)).retention!.activeData.expiresAt!,
      );
    } finally {
      await terms.close();
    }
    await extend(cutoff);
    t.mock.timers.enable({ apis: ["Date"], now: cutoff - 1 });
    try {
      data(
        await adminRequest("POST", base + "/receipt", p.headers, {
          outcome: "unknown",
          evidenceRef: "synthetic:截止前未知交接正文",
        }),
      );
      t.mock.timers.tick(1);
      if (published) {
        await restartBookApplication();
        await app.get(Deletions).sweep(new Date(cutoff));
      } else await noScan(p.projectId);
      const acceptedBody = {
        outcome: "accepted",
        evidenceRef: "synthetic:截止后接单正文",
      };
      assert.equal(
        data(
          await adminRequest(
            "POST",
            base + "/receipt",
            p.headers,
            acceptedBody,
          ),
        ).current.state,
        "in_production",
      );
      const shipping = {
        carrier: "不应新增的物流名称",
        number: "SYNTHETICLATE",
        shippedAt: new Date().toISOString(),
        evidenceRef: "synthetic:截止后发货正文",
        wechat: {
          handling: "implemented_and_verified",
          evidenceRef: "synthetic:截止后微信正文",
          result: "recorded",
        },
      };
      assert.equal(
        data(
          await adminRequest("POST", base + "/shipping", p.headers, shipping),
        ).current.state,
        "shipped",
      );
      t.mock.timers.tick(1);
      const deliveryBody = {
        deliveredAt: new Date().toISOString(),
        evidenceRef: "synthetic:截止后签收正文",
      };
      assert.equal(
        data(
          await adminRequest(
            "POST",
            base + "/delivery",
            p.headers,
            deliveryBody,
          ),
        ).current.state,
        "delivered",
      );
      const row = await db.fulfillmentAttempt.findUniqueOrThrow({
        where: { id: attemptId },
      });
      assert.equal(
        row.receiptRef,
        published ? null : "synthetic:截止前未知交接正文",
      );
      assert.equal(row.tracking, null);
      assert.equal(row.wechat, null);
      assert.equal(row.shippedAt?.getTime(), cutoff);
      assert.equal(row.deliveredAt?.getTime(), cutoff + 1);
      const records = await db.fulfillmentRecord.findMany({
        where: {
          attemptId,
          kind: { in: ["receipt_accepted", "shipping", "delivery"] },
        },
      });
      assert.ok(records.every((r) => r.evidence === null));
      data(
        await adminRequest("POST", base + "/receipt", p.headers, acceptedBody),
      );
      data(await adminRequest("POST", base + "/shipping", p.headers, shipping));
      data(
        await adminRequest("POST", base + "/delivery", p.headers, deliveryBody),
      );
      assert.equal(
        (
          await adminRequest("POST", base + "/receipt", p.headers, {
            ...acceptedBody,
            evidenceRef: "synthetic:改变原接单输入",
          })
        ).statusCode,
        409,
      );
      assert.equal(
        (
          await adminRequest("POST", base + "/shipping", p.headers, {
            ...shipping,
            shippedAt: new Date(cutoff + 1).toISOString(),
          })
        ).statusCode,
        409,
      );
      assert.equal(
        (
          await adminRequest("POST", base + "/delivery", p.headers, {
            ...deliveryBody,
            evidenceRef: "synthetic:改变原签收输入",
          })
        ).statusCode,
        409,
      );
      await assert.rejects(
        db.fulfillmentAttempt.update({
          where: { id: attemptId },
          data: { shippedAt: new Date(cutoff - 1) },
        }),
      );
    } finally {
      t.mock.timers.reset();
      await app.get(Deletions).onModuleDestroy();
    }
  });

for (const published of [false, true])
  test(`a timely original quality case can resolve its purchased refund without private material after activeData expiry published=${published}`, async (t) => {
    const p = await deliveredQualityOrder({ activeData: 1 }),
      created = data(
        await request("POST", p.qualityBase, p.buyer.token, {
          attemptId: p.attempt.id,
          reason: "qualityMissingPages",
          description: "原窗口内的质量申请",
        }),
      ),
      base = `/v1/admin/quality/cases/${created.caseId}`,
      terms = new ProjectServiceTerms(config.databaseUrl);
    let cutoff: number;
    try {
      cutoff = Date.parse(
        (await terms.read(p.projectId)).retention!.activeData.expiresAt!,
      );
    } finally {
      await terms.close();
    }
    await extend(cutoff);
    t.mock.timers.enable({ apis: ["Date"], now: cutoff - 1 });
    try {
      const assigned = data(
        await adminRequest("POST", base + "/assign", p.headers, {
          expectedVersion: created.version,
          dueAt: new Date(cutoff + 86400000).toISOString(),
          evidenceRef: "synthetic:截止前分配证据",
        }),
      );
      data(
        await request(
          "POST",
          `${p.qualityBase}/${created.id}/access`,
          p.narrator.token,
          {
            expectedVersion: assigned.version,
            scopes: ["pdf", "evidence"],
            expiresAt: new Date(cutoff + 600000).toISOString(),
            consented: true,
            noticeVersion: "synthetic-d08-v1",
          },
        ),
      );
      t.mock.timers.tick(1);
      if (published) {
        await restartBookApplication();
        await app.get(Deletions).sweep(new Date(cutoff));
      } else await noScan(p.projectId);
      const reviewed = data(
        await adminRequest("POST", base + "/review", p.headers, {
          expectedVersion: assigned.version,
          resolution: "refund",
          evidenceRef: "synthetic:到期后退款责任核验正文",
        }),
      );
      assert.equal(reviewed.resolution, "refund");
      assert.equal(
        (
          await db.qualityRequest.findUniqueOrThrow({
            where: { id: created.id },
          })
        ).reviewEvidenceRef,
        null,
      );
      assert.equal(
        (
          await db.careRequest.findUniqueOrThrow({
            where: { id: created.caseId },
          })
        ).verificationEvidence,
        null,
      );
      const linked = data(
          await request(
            "POST",
            `${p.qualityBase}/${created.id}/refund`,
            p.buyer.token,
            { expectedVersion: reviewed.version },
          ),
        ),
        id = linked.refund.id;
      data(
        await adminRequest(
          "POST",
          `/v1/admin/refunds/${id}/approve`,
          p.headers,
          { amountFen: 99900, evidenceRef: "synthetic:到期后资金核验正文" },
        ),
      );
      refundFault("timeout");
      const unknown = data(
        await adminRequest(
          "POST",
          `/v1/admin/refunds/${id}/submit`,
          p.headers,
          {},
        ),
      );
      assert.equal(unknown.state, "unknown");
      const reserved = data(
        await request("GET", `/v1/orders/${p.orderId}/refunds`, p.buyer.token),
        200,
      );
      assert.equal(reserved.reservedAmountFen, 99900);
      assert.equal(reserved.productionFrozen, true);
      Object.assign(supplierRefunds.get(unknown.outRefundNo)!, {
        status: "SUCCESS",
        success_time: new Date().toISOString(),
      });
      assert.equal(
        data(
          await adminRequest(
            "POST",
            `/v1/admin/refunds/${id}/reconcile`,
            p.headers,
            {},
          ),
        ).state,
        "succeeded",
      );
      assert.equal(
        data(await request("GET", p.qualityBase, p.buyer.token), 200)
          .requests[0].state,
        "completed",
      );
      assert.equal(
        (await db.refund.findUniqueOrThrow({ where: { id } })).evidenceRef,
        null,
      );
    } finally {
      t.mock.timers.reset();
      refundFault("");
      await app.get(Deletions).onModuleDestroy();
    }
  });

test("quality assignment preserves minimum ownership at before, at, after and published cutoff without storing new private evidence", async (t) => {
  const p = await deliveredQualityOrder({ activeData: 1 });
  const cases: { id: string; caseId: string; version: number }[] = [];
  for (let i = 0; i < 4; i++)
    cases.push(
      data(
        await request("POST", p.qualityBase, p.buyer.token, {
          attemptId: p.attempt.id,
          reason: "qualityMissingPages",
          description: `原期限内质量案${i}`,
        }),
      ),
    );
  const terms = new ProjectServiceTerms(config.databaseUrl);
  let cutoff: number;
  try {
    cutoff = Date.parse(
      (await terms.read(p.projectId)).retention!.activeData.expiresAt!,
    );
  } finally {
    await terms.close();
  }
  await extend(cutoff);
  t.mock.timers.enable({ apis: ["Date"], now: cutoff - 1 });
  try {
    for (let i = 0; i < cases.length; i++) {
      if (i === 1 || i === 2) t.mock.timers.tick(1);
      if (i === 3) {
        await restartBookApplication();
        await app.get(Deletions).sweep(new Date(cutoff + 1));
      } else await noScan(p.projectId);
      const row = cases[i],
        evidenceRef = `synthetic:处理人员原输入${i}`,
        body = {
          expectedVersion: row.version,
          dueAt: new Date(cutoff + 86400000).toISOString(),
          evidenceRef,
        },
        key = randomUUID(),
        url = `/v1/admin/quality/cases/${row.caseId}/assign`;
      const result = data(
        await adminRequest("POST", url, p.headers, body, key),
      );
      assert.equal(result.state, "assigned");
      assert.equal(
        data(await adminRequest("POST", url, p.headers, body, key)).version,
        result.version,
      );
      assert.equal(
        (await db.qualityRequest.findUniqueOrThrow({ where: { id: row.id } }))
          .assignmentEvidenceRef,
        i === 0 ? evidenceRef : null,
      );
    }
  } finally {
    t.mock.timers.reset();
    await app.get(Deletions).onModuleDestroy();
  }
});

test("published NULL fact exceptions reject positive purpose, forged story provenance, stale binding and permanent tombstone bypasses in PostgreSQL", async (t) => {
  const p = await readyReservedFirstCopy({ activeData: 1 }),
    headers = await qualityAdmin(),
    state = data(
      await request(
        "GET",
        `/v1/projects/${p.projectId}/participation`,
        p.narrator.token,
      ),
      200,
    ),
    assisted = data(
      await request(
        "POST",
        `/v1/projects/${p.projectId}/assisted-sessions`,
        p.buyer.token,
        {
          purpose: "ai",
          granted: true,
          noticeVersion: "synthetic-d08-v1",
          evidenceRef: "synthetic:原协助AI证据",
          expectedBindingVersion: state.bindingVersion,
          expectedAccessEpoch: state.accessEpoch,
        },
      ),
    ),
    attempt = data(
      await adminRequest(
        "POST",
        `/v1/admin/fulfillment/${p.order.id}/attempts`,
        headers,
        {
          ...p.binding,
          supplierRef: "record:synthetic-provider",
          dueAt: new Date(Date.now() + 86400000).toISOString(),
        },
      ),
    ).current;
  data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/fulfillment/grants`,
      p.narrator.token,
      {
        ...p.binding,
        attemptId: attempt.id,
        expiresAt: new Date(Date.now() + 600000).toISOString(),
        noticeVersion: "synthetic-d08-v1",
        evidenceRef: "synthetic:原履约授权证据",
      },
    ),
  );
  const cutoff = await delivered(p.projectId);
  await extend(cutoff);
  await restartBookApplication();
  t.mock.timers.enable({ apis: ["Date"], now: cutoff });
  try {
    await app.get(Deletions).sweep(new Date(cutoff));
    const denialKey = randomUUID();
    data(
      await request(
        "POST",
        `/v1/projects/${p.projectId}/stories/${p.story.id}/decisions`,
        p.narrator.token,
        {
          revisionId: p.story.revision.id,
          expectedVersion: p.story.version,
          contentHash: p.story.revision.contentHash,
          confirmed: false,
          allowInBook: false,
          noticeVersion: "synthetic-d08-v1",
          evidenceRef: "synthetic:已发布后的版本否决",
        },
        denialKey,
      ),
    );
    const denied = await db.storyDecision.findFirstOrThrow({
      where: { projectId: p.projectId, idempotencyKey: denialKey },
    });
    const { sequence: ignoredDecisionSequence, ...decisionData } = denied;
    await assert.rejects(
      db.storyDecision.create({
        data: { ...decisionData, confirmed: true, allowInBook: false },
      }),
      /exact authenticated rejection/,
    );
    await assert.rejects(
      db.storyDecision.create({
        data: {
          ...decisionData,
          id: randomUUID(),
          idempotencyKey: randomUUID(),
        },
      }),
      /exact authenticated rejection/,
    );
    await assert.rejects(
      db.storyDecision.create({
        data: {
          ...decisionData,
          id: randomUUID(),
          idempotencyKey: randomUUID(),
          method: "self_wechat",
          evidenceRef: null,
          confirmed: true,
          allowInBook: true,
        },
      }),
      /Deleted project/,
    );
    const rejected = data(
      await request(
        "POST",
        `/v1/projects/${p.projectId}/assisted-sessions`,
        p.buyer.token,
        {
          purpose: "ai",
          granted: false,
          noticeVersion: "synthetic-d08-v1",
          evidenceRef: "synthetic:已发布后的协助否决",
          expectedBindingVersion: state.bindingVersion,
          expectedAccessEpoch: state.accessEpoch,
          expectedSessionId: assisted.id,
        },
      ),
    );
    const negative = await db.assistedSession.findUniqueOrThrow({
      where: { id: rejected.id },
    });
    const { sequence: ignoredSessionSequence, ...sessionData } = negative;
    await assert.rejects(
      db.assistedSession.create({
        data: {
          ...sessionData,
          id: randomUUID(),
          idempotencyKey: randomUUID(),
          granted: true,
          evidenceRef: null,
        },
      }),
      /Deleted project/,
    );
    await assert.rejects(
      db.assistedSession.create({
        data: {
          ...sessionData,
          id: randomUUID(),
          idempotencyKey: randomUUID(),
          bindingVersion: 0,
          evidenceRef: null,
        },
      }),
      /Deleted project/,
    );
    const consent = await db.consentRecord.findFirstOrThrow({
      where: { projectId: p.projectId, purpose: "ai", granted: false },
    });
    const { sequence: ignoredConsentSequence, ...consentData } = consent;
    await assert.rejects(
      db.consentRecord.create({
        data: {
          ...consentData,
          id: randomUUID(),
          granted: true,
          evidenceRef: null,
        },
      }),
      /Deleted project/,
    );
    await assert.rejects(
      db.assistedVersionEvidence.create({
        data: {
          id: randomUUID(),
          projectId: p.projectId,
          subjectId: p.subjectId,
          operatorUserId: p.buyer.id,
          sessionId: assisted.id,
          contentKind: "story",
          versionId: p.story.revision.id,
          contentHash: p.story.revision.contentHash,
          noticeVersion: "synthetic-d08-v1",
          evidenceRef: null,
          bindingVersion: state.bindingVersion,
          accessEpoch: state.accessEpoch,
          idempotencyKey: randomUUID(),
          requestHash: "0".repeat(64),
        },
      }),
      /Deleted project/,
    );
    const confirmation = await db.bookConfirmation.findFirstOrThrow({
      where: { projectId: p.projectId, role: "narrator" },
    });
    const { sequence: ignoredConfirmationSequence, ...confirmationData } =
      confirmation;
    await assert.rejects(
      db.bookConfirmation.create({
        data: { ...confirmationData, id: randomUUID(), evidenceRef: null },
      }),
      /Deleted project/,
    );
    const grant = await db.fulfillmentGrant.findFirstOrThrow({
      where: { projectId: p.projectId },
    });
    const { sequence: ignoredGrantSequence, ...grantData } = grant;
    await assert.rejects(
      db.fulfillmentGrant.create({
        data: { ...grantData, id: randomUUID(), evidenceRef: null },
      }),
      /Deleted project/,
    );
    const target = await login(),
      care = data(
        await request(
          "POST",
          `/v1/projects/${p.projectId}/care-requests`,
          p.narrator.token,
          {
            kind: "rebind",
            targetUserId: target.id,
            expectedBindingVersion: state.bindingVersion,
          },
        ),
      );
    const rebound = data(
      await adminRequest(
        "POST",
        `/v1/admin/projects/${p.projectId}/rebind`,
        headers,
        {
          supportCaseRef: care.supportCaseRef,
          targetUserId: target.id,
          expectedBindingVersion: state.bindingVersion,
          noticeVersion: "synthetic-d08-v1",
          evidenceRef: "synthetic:已发布后换绑核验正文",
        },
      ),
    );
    const change = await db.bindingChange.findFirstOrThrow({
      where: { supportCaseId: care.id },
    });
    assert.equal(change.evidenceRef, null);
    await assert.rejects(
      db.bindingChange.create({
        data: {
          ...change,
          id: randomUUID(),
          requestId: randomUUID(),
          toUserId: p.narrator.id,
        },
      }),
      /Deleted project/,
    );
    assert.equal(
      (
        await request(
          "POST",
          `/v1/projects/${p.projectId}/consents`,
          p.narrator.token,
          {
            purpose: "collection",
            granted: true,
            noticeVersion: "synthetic-d08-v1",
            evidenceRef: "synthetic:旧绑定不能重授权",
            expectedBindingVersion: rebound.bindingVersion,
            expectedAccessEpoch: rebound.accessEpoch,
          },
        )
      ).statusCode,
      403,
    );
    const full = data(
      await request(
        "POST",
        `/v1/projects/${p.projectId}/care-requests`,
        target.token,
        { kind: "delete", expectedBindingVersion: rebound.bindingVersion },
      ),
    );
    data(
      await adminRequest(
        "POST",
        `/v1/admin/care-requests/${full.id}/verify`,
        headers,
        {
          expectedBindingVersion: rebound.bindingVersion,
          expectedAccessEpoch: rebound.accessEpoch,
          noticeVersion: "synthetic-d08-v1",
          evidenceRef: "synthetic:永久删除核验正文",
        },
      ),
    );
    const current = await db.project.findUniqueOrThrow({
      where: { id: p.projectId },
    });
    await assert.rejects(
      db.assistedSession.create({
        data: {
          ...sessionData,
          id: randomUUID(),
          idempotencyKey: randomUUID(),
          bindingVersion: rebound.bindingVersion,
          accessEpoch: current.accessEpoch,
          evidenceRef: null,
        },
      }),
      /Deleted project/,
    );
  } finally {
    t.mock.timers.reset();
    await app.get(Deletions).onModuleDestroy();
  }
});

test("story editing cannot copy expired mixed source payload into a new independently retained revision", async (t) => {
  const p = await readyFirstCopyBook({}, {}, { activeData: 1 }),
    cutoff = await delivered(p.projectId),
    url = `/v1/projects/${p.projectId}/stories/${p.story.id}/revisions`;
  await extend(cutoff);
  t.mock.timers.enable({ apis: ["Date"], now: cutoff - 1 });
  try {
    const body = {
      baseRevisionId: p.story.revision.id,
      expectedVersion: p.story.version,
      title: p.story.revision.title,
      theme: p.story.revision.theme,
      paragraphs: p.story.revision.paragraphs,
      reviewResolutions: p.story.revision.reviewResolutions,
      notes: [],
    };
    const legal = data(await request("POST", url, p.narrator.token, body));
    t.mock.timers.tick(1);
    await noScan(p.projectId);
    const late = await request("POST", url, p.narrator.token, {
      ...body,
      baseRevisionId: legal.revision.id,
      expectedVersion: legal.version,
    });
    assert.equal(late.statusCode, 403);
    assert.equal(
      (
        await request(
          "GET",
          `/v1/projects/${p.projectId}/stories/${p.story.id}`,
          p.narrator.token,
        )
      ).statusCode,
      200,
    );
  } finally {
    t.mock.timers.reset();
  }
});

test("an expired exact story refusal survives a PostgreSQL failure after independent publication and reuses its original intent", async (t) => {
  const p = await readyFirstCopyBook({}, {}, { activeData: 1 }),
    cutoff = await delivered(p.projectId),
    key = randomUUID(),
    url = `/v1/projects/${p.projectId}/stories/${p.story.id}/decisions`,
    body = {
      revisionId: p.story.revision.id,
      expectedVersion: p.story.version,
      contentHash: p.story.revision.contentHash,
      confirmed: true,
      allowInBook: false,
      noticeVersion: "synthetic-d08-v1",
      evidenceRef: "synthetic:不能进入独立源的否定正文",
    };
  await extend(cutoff);
  await restartBookApplication();
  t.mock.timers.enable({ apis: ["Date"], now: cutoff });
  try {
    await app.get(Deletions).sweep(new Date(cutoff));
    await db.$executeRawUnsafe(
      "CREATE FUNCTION reject_t26_story_projection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.payload->>'operation'='story_decision' THEN RAISE EXCEPTION 'synthetic story projection fault'; END IF; RETURN NEW; END $$",
    );
    await db.$executeRawUnsafe(
      "CREATE TRIGGER reject_t26_story_projection AFTER INSERT ON privacy_events FOR EACH ROW EXECUTE FUNCTION reject_t26_story_projection()",
    );
    assert.equal(
      (await request("POST", url, p.narrator.token, body, key)).statusCode,
      500,
    );
    const journal = new PrivacyJournal(config.privacyJournal!),
      published = await journal.snapshot(),
      event = published.events.find(
        (e) =>
          (e.payload.decision as { idempotencyKey?: string } | undefined)
            ?.idempotencyKey === key,
      )!;
    assert.ok(event);
    assert.equal(
      JSON.stringify(event.payload).includes(body.evidenceRef),
      false,
    );
    assert.equal(
      await db.storyDecision.count({ where: { id: event.eventId } }),
      0,
    );
    // The real maintenance path must see the authenticated event while its
    // projection is still unavailable, exactly as the runtime timer can.
    await assert.rejects(
      app.get(Deletions).sweep(new Date(cutoff)),
      (error: { getStatus(): number }) => error.getStatus() === 503,
    );
    await db.$executeRawUnsafe(
      "DROP TRIGGER reject_t26_story_projection ON privacy_events",
    );
    // Removing the external fault cannot silently reopen a process whose
    // recovery gate already failed. A fresh process must replay the same source.
    assert.equal(
      (await request("POST", url, p.narrator.token, body, key)).statusCode,
      503,
    );
    await restartBookApplication();
    data(await request("POST", url, p.narrator.token, body, key));
    const projected = await db.storyDecision.findUniqueOrThrow({
      where: { id: event.eventId },
    });
    assert.equal(projected.method, "journal_denial");
    assert.equal(projected.confirmed, true);
    assert.equal(projected.allowInBook, false);
    assert.equal(projected.evidenceRef, "journal:" + event.hash);
    const recovered = await journal.snapshot();
    assert.equal(recovered.sourceId, published.sourceId);
    assert.equal(recovered.generation, published.generation);
    assert.equal(recovered.hash, published.hash);
    assert.deepEqual(recovered.authority, published.authority);
  } finally {
    await db.$executeRawUnsafe(
      "DROP TRIGGER IF EXISTS reject_t26_story_projection ON privacy_events",
    );
    await db.$executeRawUnsafe(
      "DROP FUNCTION IF EXISTS reject_t26_story_projection()",
    );
    t.mock.timers.reset();
    await app.get(Deletions).onModuleDestroy();
  }
});
