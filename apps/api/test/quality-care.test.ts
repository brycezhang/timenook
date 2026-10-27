import { refundFault, supplierRefunds } from "./payment-fixture";
import { ProductionTasks } from "../src/tasks/tasks";
import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { randomUUID } from "node:crypto";
import {
  startBookFixture,
  stopBookFixture,
  request,
  data,
  login,
  choose,
  app,
} from "./book-fixture";
import {
  deliveredQualityOrder,
  adminRequest,
  qualityAdmin,
  reviewedQualityOrder,
} from "./quality-fixture";
before(startBookFixture);
after(stopBookFixture);
test("buyer submits quality evidence against the delivered original and sees the same private shared case after replay", async () => {
  const p = await deliveredQualityOrder(),
    key = randomUUID(),
    body = {
      attemptId: p.attempt.id,
      reason: "qualityMissingPages",
      description: "合成书第十页缺失，申请核对原版。",
    };
  assert.equal((await request("GET", p.qualityBase)).statusCode, 401);
  assert.equal(
    (await request("GET", p.qualityBase, (await login()).token)).statusCode,
    404,
  );
  const created = data(
    await request("POST", p.qualityBase, p.buyer.token, body, key),
  );
  assert.equal(created.reason, "qualityMissingPages");
  assert.equal(created.state, "requested");
  assert.equal(created.original.pdfHash, p.binding.pdfHash);
  assert.equal(created.original.attemptId, p.attempt.id);
  assert.equal(created.description, undefined);
  assert.equal(created.address, undefined);
  const replay = data(
    await request("POST", p.qualityBase, p.buyer.token, body, key),
  );
  assert.equal(replay.id, created.id);
  assert.equal(
    (
      await request(
        "POST",
        p.qualityBase,
        p.buyer.token,
        { ...body, description: "另一证据" },
        key,
      )
    ).statusCode,
    409,
  );
  const list = data(await request("GET", p.qualityBase, p.buyer.token), 200);
  assert.equal(list.requests[0].id, created.id);
  assert.equal(list.attempts[0].id, p.attempt.id);
  const cases = data(
    await adminRequest("GET", "/v1/admin/care-requests", p.headers),
    200,
  );
  assert.ok(
    cases.requests.some(
      (c: any) => c.id === created.caseId && c.kind === "quality",
    ),
  );
});
test("assigned case owner reads only the narrator's bounded original evidence and PDF; expiry and withdrawal revoke the read", async (t) => {
  const p = await deliveredQualityOrder(),
    created = data(
      await request("POST", p.qualityBase, p.buyer.token, {
        attemptId: p.attempt.id,
        reason: "qualityMissingPages",
        description: "合成缺页证据正文",
      }),
    ),
    base = `/v1/admin/quality/cases/${created.caseId}`;
  assert.equal(
    (await adminRequest("GET", base + "/materials", p.headers)).statusCode,
    403,
  );
  const dueAt = new Date(Date.now() + 86400000).toISOString(),
    assigned = data(
      await adminRequest("POST", base + "/assign", p.headers, {
        expectedVersion: created.version,
        dueAt,
        evidenceRef: "synthetic:按原D06日历核验处理截止",
      }),
    );
  assert.ok(assigned.ownerLabel);
  assert.equal(assigned.dueAt, dueAt);
  assert.equal(assigned.state, "assigned");
  const grant = {
    expectedVersion: assigned.version,
    scopes: ["pdf", "evidence"],
    expiresAt: new Date(Date.now() + 600000).toISOString(),
    consented: true,
    noticeVersion: "synthetic-d08-v1",
  };
  assert.equal(
    (
      await request(
        "POST",
        `${p.qualityBase}/${created.id}/access`,
        p.buyer.token,
        grant,
      )
    ).statusCode,
    403,
  );
  const granted = data(
    await request(
      "POST",
      `${p.qualityBase}/${created.id}/access`,
      p.narrator.token,
      grant,
    ),
  );
  assert.equal(granted.grant.expiresAt, grant.expiresAt);
  const materials = data(
    await adminRequest("GET", base + "/materials", p.headers),
    200,
  );
  assert.equal(materials.description, "合成缺页证据正文");
  assert.equal(materials.pdf.sha256, p.binding.pdfHash);
  assert.equal(materials.address, undefined);
  const pdf = await adminRequest("GET", base + "/pdf", p.headers);
  assert.equal(pdf.statusCode, 200);
  assert.equal(pdf.rawPayload.subarray(0, 5).toString(), "%PDF-");
  const other = await qualityAdmin();
  assert.equal(
    (await adminRequest("GET", base + "/materials", other)).statusCode,
    403,
  );
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(grant.expiresAt) });
  assert.equal(
    (await adminRequest("GET", base + "/pdf", p.headers)).statusCode,
    403,
  );
  t.mock.timers.reset();
  data(
    await request(
      "POST",
      `${p.qualityBase}/${created.id}/access`,
      p.narrator.token,
      { ...grant, expiresAt: new Date(Date.now() + 600000).toISOString() },
    ),
  );
  data((await choose(p, p.narrator.token, "sharing", false)).response);
  assert.equal(
    (await adminRequest("GET", base + "/materials", p.headers)).statusCode,
    403,
  );
});
test("quality original reprint preserves delivered history, consumes no extra first copy, and never restarts the first delivery services", async () => {
  const p = await deliveredQualityOrder(),
    created = data(
      await request("POST", p.qualityBase, p.narrator.token, {
        attemptId: p.attempt.id,
        reason: "qualityMissingPages",
        description: "本人提出合成缺页核对",
      }),
    ),
    base = `/v1/admin/quality/cases/${created.caseId}`;
  const assigned = data(
    await adminRequest("POST", base + "/assign", p.headers, {
      expectedVersion: created.version,
      dueAt: new Date(Date.now() + 86400000).toISOString(),
      evidenceRef: "synthetic:按日历核验售后时限",
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
        expiresAt: new Date(Date.now() + 600000).toISOString(),
        consented: true,
        noticeVersion: "synthetic-d08-v1",
      },
    ),
  );
  const reviewed = data(
    await adminRequest("POST", base + "/review", p.headers, {
      expectedVersion: assigned.version,
      resolution: "reprint",
      mode: "original",
      evidenceRef: "synthetic:原D07缺页责任及原文件核验",
    }),
  );
  const results = await Promise.all(
    [1, 2, 3].map(() =>
      adminRequest("POST", base + "/reprints", p.headers, {
        expectedVersion: reviewed.version,
        ...p.binding,
      }),
    ),
  );
  assert.equal(results.filter((r) => r.statusCode === 201).length, 1);
  assert.equal(results.filter((r) => r.statusCode === 409).length, 2);
  const reprinted = data(results.find((r) => r.statusCode === 201)!);
  assert.ok(reprinted.productionAttemptId);
  assert.equal(reprinted.productionOrderId, p.order.id);
  const url = `/v1/projects/${p.projectId}/fulfillment`,
    progress = data(await request("GET", url, p.narrator.token), 200);
  assert.equal(progress.paymentOrderId, p.orderId);
  assert.equal(progress.entitlementState, "consumed");
  assert.equal(progress.attempts.length, 2);
  assert.equal(progress.attempts[1].state, "delivered");
  assert.equal(progress.current.sequence, 2);
  assert.equal(
    (
      await request(
        "POST",
        `/v1/projects/${p.projectId}/first-copy/submit`,
        p.buyer.token,
        p.binding,
      )
    ).statusCode,
    409,
  );
  const attemptBase = `/v1/admin/fulfillment/${p.order.id}/attempts/${reprinted.productionAttemptId}`;
  data(
    await request("POST", url + "/grants", p.narrator.token, {
      ...p.binding,
      attemptId: reprinted.productionAttemptId,
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      noticeVersion: "synthetic-d08-v1",
      evidenceRef: `synthetic:原单重印交接-${randomUUID()}`,
    }),
  );
  data(await adminRequest("POST", attemptBase + "/handoff", p.headers, {}));
  data(
    await adminRequest("POST", attemptBase + "/receipt", p.headers, {
      outcome: "accepted",
      evidenceRef: "synthetic:重印实际接单",
    }),
  );
  data(
    await adminRequest("POST", attemptBase + "/shipping", p.headers, {
      carrier: "合成物流",
      number: "SYNTHETICREPRINT",
      shippedAt: new Date().toISOString(),
      evidenceRef: "synthetic:重印承运",
      wechat: {
        handling: "implemented_and_verified",
        evidenceRef: "synthetic:重印微信发货",
        result: "recorded",
      },
    }),
  );
  const delivered = data(
    await adminRequest("POST", attemptBase + "/delivery", p.headers, {
      deliveredAt: new Date().toISOString(),
      evidenceRef: "synthetic:重印签收",
    }),
  );
  assert.equal(delivered.current.state, "delivered");
  assert.equal(delivered.entitlementState, "consumed");
  assert.deepEqual(delivered.serviceTerms, p.delivered.serviceTerms);
  const complete = data(await adminRequest("GET", base, p.headers), 200);
  assert.equal(complete.state, "completed");
  assert.equal(complete.productionState, "delivered");
});
test("revised quality remedy exposes a replacement only after a new PDF and both fresh exact confirmations", async () => {
  const p = await reviewedQualityOrder("revised"),
    firstCopy = `/v1/projects/${p.projectId}/first-copy`,
    bookBase = `/v1/projects/${p.projectId}/book`;
  const initial = data(await request("GET", firstCopy, p.buyer.token), 200);
  assert.equal(initial.qualityRevisionRequestId, p.quality.id);
  assert.equal(initial.canReviseProduction, true);
  assert.equal(initial.canSubmit, false);
  assert.equal(p.quality.replacement, null);
  data(
    await request("POST", bookBase + "/cover", p.buyer.token, {
      expectedVersion: 0,
      salutation: "本人核对的售后新版封面",
      photoAssetId: null,
    }),
  );
  const context = data(await request("GET", bookBase, p.buyer.token), 200),
    queued = data(
      await request("POST", bookBase + "/versions", p.buyer.token, {
        expectedInputHash: context.inputHash,
      }),
      202,
    );
  await app.get(ProductionTasks).run(queued.task.id);
  const current = data(await request("GET", firstCopy, p.buyer.token), 200),
    binding = {
      bookVersionId: current.book.id,
      snapshotHash: current.book.snapshotHash,
      pdfHash: current.book.pdf.sha256,
      addressHash: current.address.hash,
    };
  assert.notEqual(binding.pdfHash, p.binding.pdfHash);
  assert.equal(
    (
      await adminRequest("POST", p.qualityAdminBase + "/reprints", p.headers, {
        expectedVersion: p.quality.version,
        ...binding,
      })
    ).statusCode,
    409,
  );
  data(
    await request("POST", firstCopy + "/confirmations", p.narrator.token, {
      role: "narrator",
      bookVersionId: binding.bookVersionId,
      snapshotHash: binding.snapshotHash,
      pdfHash: binding.pdfHash,
      noticeVersion: "synthetic-d08-v1",
      evidenceRef: `synthetic:新版本人确认-${randomUUID()}`,
    }),
  );
  assert.equal(
    (
      await adminRequest("POST", p.qualityAdminBase + "/reprints", p.headers, {
        expectedVersion: p.quality.version,
        ...binding,
      })
    ).statusCode,
    409,
  );
  data(
    await request("POST", firstCopy + "/confirmations", p.buyer.token, {
      role: "initiator",
      ...binding,
      noticeVersion: "synthetic-d08-v1",
      evidenceRef: `synthetic:新版发起人确认-${randomUUID()}`,
    }),
  );
  const eligible = data(
    await adminRequest("GET", p.qualityAdminBase, p.headers),
    200,
  );
  assert.deepEqual(eligible.replacement, binding);
  const reprinted = data(
    await adminRequest("POST", p.qualityAdminBase + "/reprints", p.headers, {
      expectedVersion: eligible.version,
      ...eligible.replacement,
    }),
  );
  assert.ok(reprinted.productionAttemptId);
  const materials = data(
    await adminRequest("GET", p.qualityAdminBase + "/materials", p.headers),
    200,
  );
  assert.equal(materials.pdf.sha256, p.binding.pdfHash);
  const progress = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/fulfillment`,
      p.narrator.token,
    ),
    200,
  );
  assert.equal(progress.current.pdfHash, binding.pdfHash);
  assert.equal(progress.attempts[1].pdfHash, p.binding.pdfHash);
  assert.equal(progress.entitlementState, "consumed");
  assert.equal(
    (await request("POST", firstCopy + "/submit", p.buyer.token, binding))
      .statusCode,
    409,
  );
});
test("quality refund uses the original refund application and verified reconciliation instead of a manual money result", async () => {
  const p = await reviewedQualityOrder("refund"),
    url = `${p.qualityBase}/${p.quality.id}/refund`,
    body = { expectedVersion: p.quality.version },
    key = randomUUID();
  assert.equal(
    (await request("POST", url, p.narrator.token, body)).statusCode,
    403,
  );
  const opened = data(await request("POST", url, p.buyer.token, body, key));
  assert.ok(opened.refund.id);
  assert.equal(opened.refund.state, "requested");
  assert.equal(
    data(await request("POST", url, p.buyer.token, body, key)).refund.id,
    opened.refund.id,
  );
  const money = data(
      await request("GET", `/v1/orders/${p.orderId}/refunds`, p.buyer.token),
      200,
    ),
    refund = money.refunds.find((r: any) => r.id === opened.refund.id);
  assert.ok(refund);
  const refundBase = `/v1/admin/refunds/${refund.id}`;
  data(
    await adminRequest("POST", refundBase + "/approve", p.headers, {
      amountFen: 99900,
      evidenceRef: "synthetic:按原质量退款政策批准",
    }),
  );
  refundFault("timeout");
  const unknown = data(
    await adminRequest("POST", refundBase + "/submit", p.headers, {}),
  );
  assert.equal(unknown.state, "unknown");
  assert.equal(unknown.outRefundNo, refund.outRefundNo);
  const reserved = data(
    await request("GET", `/v1/orders/${p.orderId}/refunds`, p.buyer.token),
    200,
  );
  assert.equal(reserved.reservedAmountFen, 99900);
  data(await adminRequest("POST", refundBase + "/submit", p.headers, {}));
  Object.assign(supplierRefunds.get(refund.outRefundNo)!, {
    status: "SUCCESS",
    success_time: new Date().toISOString(),
  });
  const paid = data(
    await adminRequest("POST", refundBase + "/reconcile", p.headers, {}),
  );
  assert.equal(paid.state, "succeeded");
  const result = data(
    await adminRequest("GET", p.qualityAdminBase, p.headers),
    200,
  );
  assert.equal(result.state, "completed");
  assert.equal(result.refund.state, "succeeded");
  const fulfillment = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/fulfillment`,
      p.narrator.token,
    ),
    200,
  );
  assert.equal(fulfillment.entitlementState, "consumed");
  assert.deepEqual(fulfillment.serviceTerms, p.delivered.serviceTerms);
});
test("unknown quality handoff occupies the original order and verified cancellation never releases another first copy", async () => {
  const p = await reviewedQualityOrder(),
    quality = data(
      await adminRequest("POST", p.qualityAdminBase + "/reprints", p.headers, {
        expectedVersion: p.quality.version,
        ...p.binding,
      }),
    ),
    url = `/v1/projects/${p.projectId}/fulfillment`,
    attemptBase = `/v1/admin/fulfillment/${p.order.id}/attempts/${quality.productionAttemptId}`;
  data(
    await request("POST", url + "/grants", p.narrator.token, {
      ...p.binding,
      attemptId: quality.productionAttemptId,
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      noticeVersion: "synthetic-d08-v1",
      evidenceRef: `synthetic:取消分支交接-${randomUUID()}`,
    }),
  );
  data(await adminRequest("POST", attemptBase + "/handoff", p.headers, {}));
  const unknown = data(
    await adminRequest("POST", attemptBase + "/receipt", p.headers, {
      outcome: "unknown",
      evidenceRef: "synthetic:重印接单未核实",
    }),
  );
  assert.equal(unknown.current.state, "handoff_pending");
  assert.equal(unknown.entitlementState, "consumed");
  assert.equal(
    (
      await adminRequest("POST", p.qualityAdminBase + "/reprints", p.headers, {
        expectedVersion: quality.version,
        ...p.binding,
      })
    ).statusCode,
    409,
  );
  const pending = data(
    await adminRequest("POST", attemptBase + "/cancel", p.headers, {
      evidenceRef: "synthetic:请求核实印厂取消",
    }),
  );
  assert.equal(pending.current.state, "cancellation_pending");
  assert.equal(
    (
      await adminRequest("POST", p.qualityAdminBase + "/reprints", p.headers, {
        expectedVersion: quality.version,
        ...p.binding,
      })
    ).statusCode,
    409,
  );
  const cancelled = data(
    await adminRequest("POST", attemptBase + "/receipt", p.headers, {
      outcome: "cancelled",
      evidenceRef: "synthetic:已核实取消该重印",
    }),
  );
  assert.equal(cancelled.entitlementState, "consumed");
  assert.equal(cancelled.current.state, "cancelled");
  assert.equal(
    (
      await adminRequest("POST", attemptBase + "/receipt", p.headers, {
        outcome: "accepted",
        evidenceRef: "synthetic:错误迟到接单",
      })
    ).statusCode,
    409,
  );
  const retried = data(
    await adminRequest("POST", p.qualityAdminBase + "/reprints", p.headers, {
      expectedVersion: quality.version,
      ...p.binding,
    }),
  );
  assert.notEqual(retried.productionAttemptId, quality.productionAttemptId);
  assert.equal(retried.dueAt, p.quality.dueAt);
  const progress = data(await request("GET", url, p.narrator.token), 200);
  assert.equal(progress.entitlementState, "consumed");
  assert.equal(progress.current.sequence, 3);
  assert.equal(progress.attempts[2].state, "delivered");
});
test("assisted quality evidence access requires the exact book-purpose session and respects the chosen scope", async () => {
  const p = await deliveredQualityOrder(),
    created = data(
      await request("POST", p.qualityBase, p.buyer.token, {
        attemptId: p.attempt.id,
        reason: "qualityMissingPages",
        description: "仅文字证据可看",
      }),
    ),
    base = `/v1/admin/quality/cases/${created.caseId}`;
  const assigned = data(
    await adminRequest("POST", base + "/assign", p.headers, {
      expectedVersion: created.version,
      dueAt: new Date(Date.now() + 86400000).toISOString(),
      evidenceRef: "synthetic:同机质量工单领取",
    }),
  );
  const status = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/participation`,
      p.buyer.token,
    ),
    200,
  );
  const session = async (purpose: string) =>
    data(
      await request(
        "POST",
        `/v1/projects/${p.projectId}/assisted-sessions`,
        p.buyer.token,
        {
          purpose,
          granted: true,
          expectedBindingVersion: status.bindingVersion,
          expectedAccessEpoch: status.accessEpoch,
          noticeVersion: "synthetic-d08-v1",
          evidenceRef: `synthetic:质量本人在场-${randomUUID()}`,
        },
      ),
    );
  const body = {
    expectedVersion: assigned.version,
    scopes: ["evidence"],
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    consented: true,
    noticeVersion: "synthetic-d08-v1",
  };
  const wrong = await session("story_confirmation");
  assert.equal(
    (
      await request(
        "POST",
        `${p.qualityBase}/${created.id}/access`,
        p.buyer.token,
        { ...body, assistedSessionId: wrong.id },
      )
    ).statusCode,
    403,
  );
  const correct = await session("book_confirmation");
  data(
    await request(
      "POST",
      `${p.qualityBase}/${created.id}/access`,
      p.buyer.token,
      { ...body, assistedSessionId: correct.id },
    ),
  );
  const evidence = data(
    await adminRequest("GET", base + "/materials", p.headers),
    200,
  );
  assert.equal(evidence.description, "仅文字证据可看");
  assert.equal(evidence.pdf, null);
  assert.equal(
    (await adminRequest("GET", base + "/pdf", p.headers)).statusCode,
    403,
  );
  const both = {
    ...body,
    scopes: ["pdf", "evidence"],
    assistedSessionId: correct.id,
  };
  data(
    await request(
      "POST",
      `${p.qualityBase}/${created.id}/access`,
      p.buyer.token,
      both,
    ),
  );
  assert.equal(
    (await adminRequest("GET", base + "/pdf", p.headers)).statusCode,
    200,
  );
  const latest = new Map<string, string>();
  const choice = async (purpose: string, granted: boolean) => {
    const result = data(
      await request(
        "POST",
        `/v1/projects/${p.projectId}/assisted-sessions`,
        p.buyer.token,
        {
          purpose,
          granted,
          expectedBindingVersion: status.bindingVersion,
          expectedAccessEpoch: status.accessEpoch,
          expectedSessionId: latest.get(purpose),
          noticeVersion: "synthetic-d08-v1",
          evidenceRef: `synthetic:质量用途选择-${randomUUID()}`,
        },
      ),
    );
    latest.set(purpose, result.id);
    return result;
  };
  await choice("collection", false);
  const denied = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/participation`,
      p.buyer.token,
    ),
    200,
  );
  assert.equal(denied.accessEpoch, status.accessEpoch);
  assert.equal(denied.canRead, false);
  assert.equal(
    (await adminRequest("GET", base + "/materials", p.headers)).statusCode,
    403,
  );
  assert.equal(
    (await adminRequest("GET", base + "/pdf", p.headers)).statusCode,
    403,
  );
  await choice("collection", true);
  assert.equal(
    (await adminRequest("GET", base + "/materials", p.headers)).statusCode,
    403,
  );
  data(
    await request(
      "POST",
      `${p.qualityBase}/${created.id}/access`,
      p.buyer.token,
      both,
    ),
  );
  assert.equal(
    (await adminRequest("GET", base + "/pdf", p.headers)).statusCode,
    200,
  );
  await choice("ai", false);
  assert.equal(
    (await adminRequest("GET", base + "/pdf", p.headers)).statusCode,
    200,
  );
});
test("an approved concurrent refund freezes quality production without restoring or rewriting the delivered entitlement", async () => {
  const p = await reviewedQualityOrder(),
    refund = data(
      await request("POST", `/v1/orders/${p.orderId}/refunds`, p.buyer.token, {
        reason: "qualityMissingPages",
        evidenceRef: "synthetic:并行退款申请",
      }),
    );
  data(
    await adminRequest(
      "POST",
      `/v1/admin/refunds/${refund.id}/approve`,
      p.headers,
      { amountFen: 99900, evidenceRef: "synthetic:原政策退款核验" },
    ),
  );
  assert.equal(
    (
      await adminRequest("POST", p.qualityAdminBase + "/reprints", p.headers, {
        expectedVersion: p.quality.version,
        ...p.binding,
      })
    ).statusCode,
    409,
  );
  const original = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/fulfillment`,
      p.narrator.token,
    ),
    200,
  );
  assert.equal(original.entitlementState, "consumed");
  assert.equal(original.attempts.length, 1);
  assert.equal(original.current.state, "delivered");
  const funds = data(
    await request("GET", `/v1/orders/${p.orderId}/refunds`, p.buyer.token),
    200,
  );
  assert.equal(funds.productionFrozen, true);
});
test("quality eligibility keeps the original application time through delayed review and excludes the exact window end", async (t) => {
  const p = await deliveredQualityOrder(),
    timely = data(
      await request("POST", p.qualityBase, p.buyer.token, {
        attemptId: p.attempt.id,
        reason: "qualityMissingPages",
        description: "原窗口内已申请",
      }),
    );
  const end =
    Date.parse(p.delivered.serviceTerms.playback.startsAt) + 30 * 86400000;
  t.mock.timers.enable({ apis: ["Date"], now: end });
  t.after(() => t.mock.timers.reset());
  const buyer = await login(p.buyer.who),
    narrator = await login(p.narrator.who),
    headers = await qualityAdmin(),
    late = data(
      await request("POST", p.qualityBase, buyer.token, {
        attemptId: p.attempt.id,
        reason: "qualityMissingPages",
        description: "恰好窗口截止才申请",
      }),
    );
  const review = async (row: any) => {
    const base = `/v1/admin/quality/cases/${row.caseId}`,
      assigned = data(
        await adminRequest("POST", base + "/assign", headers, {
          expectedVersion: row.version,
          dueAt: new Date(Date.now() + 86400000).toISOString(),
          evidenceRef: "synthetic:跨期按日历核验截止",
        }),
      );
    data(
      await request(
        "POST",
        `${p.qualityBase}/${row.id}/access`,
        narrator.token,
        {
          expectedVersion: assigned.version,
          scopes: ["pdf", "evidence"],
          expiresAt: new Date(Date.now() + 600000).toISOString(),
          consented: true,
          noticeVersion: "synthetic-d08-v1",
        },
      ),
    );
    return adminRequest("POST", base + "/review", headers, {
      expectedVersion: assigned.version,
      resolution: "refund",
      evidenceRef: "synthetic:按原申请时点核验窗口",
    });
  };
  assert.equal(data(await review(timely)).state, "reviewed");
  assert.equal((await review(late)).statusCode, 409);
});
test("narrator can grant a dedicated quality owner while refusing buyer sharing without opening buyer content or production", async () => {
  const p = await deliveredQualityOrder();
  data((await choose(p, p.narrator.token, "sharing", false)).response);
  const created = data(
      await request("POST", p.qualityBase, p.narrator.token, {
        attemptId: p.attempt.id,
        reason: "qualityMissingPages",
        description: "仅授权客服核对的缺页说明",
      }),
    ),
    base = `/v1/admin/quality/cases/${created.caseId}`;
  const assigned = data(
    await adminRequest("POST", base + "/assign", p.headers, {
      expectedVersion: created.version,
      dueAt: new Date(Date.now() + 86400000).toISOString(),
      evidenceRef: "synthetic:专属客服核验时限",
    }),
  );
  const grant = {
    expectedVersion: assigned.version,
    scopes: ["pdf", "evidence"],
    expiresAt: new Date(Date.now() + 600000).toISOString(),
    consented: true,
    noticeVersion: "synthetic-d08-v1",
  };
  data(
    await request(
      "POST",
      `${p.qualityBase}/${created.id}/access`,
      p.narrator.token,
      grant,
    ),
  );
  const materials = data(
    await adminRequest("GET", base + "/materials", p.headers),
    200,
  );
  assert.equal(materials.description, "仅授权客服核对的缺页说明");
  assert.equal(materials.pdf.sha256, p.binding.pdfHash);
  assert.equal(
    (await adminRequest("GET", base + "/pdf", p.headers)).statusCode,
    200,
  );
  const purposeState = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/participation`,
      p.buyer.token,
    ),
    200,
  );
  data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/assisted-sessions`,
      p.buyer.token,
      {
        purpose: "sharing",
        granted: false,
        expectedBindingVersion: purposeState.bindingVersion,
        expectedAccessEpoch: purposeState.accessEpoch,
        noticeVersion: "synthetic-d08-v1",
        evidenceRef: `synthetic:向发起人共享的单独拒绝-${randomUUID()}`,
      },
    ),
  );
  assert.equal(
    (await adminRequest("GET", base + "/pdf", p.headers)).statusCode,
    200,
  );
  assert.equal(
    (await request("GET", `/v1/projects/${p.projectId}/book`, p.buyer.token))
      .statusCode,
    403,
  );
  assert.equal(
    (await adminRequest("GET", base + "/materials", await qualityAdmin()))
      .statusCode,
    403,
  );
  const reviewed = data(
    await adminRequest("POST", base + "/review", p.headers, {
      expectedVersion: assigned.version,
      resolution: "reprint",
      mode: "original",
      evidenceRef: "synthetic:仅核对责任不扩大发起人权限",
    }),
  );
  assert.equal(
    (
      await adminRequest("POST", base + "/reprints", p.headers, {
        expectedVersion: reviewed.version,
        ...p.binding,
      })
    ).statusCode,
    403,
  );
  const currentGrant = { ...grant, expectedVersion: reviewed.version };
  assert.equal(
    (
      await request(
        "POST",
        `${p.qualityBase}/${created.id}/access`,
        p.buyer.token,
        currentGrant,
      )
    ).statusCode,
    403,
  );
  const state = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/participation`,
      p.buyer.token,
    ),
    200,
  );
  const session = data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/assisted-sessions`,
      p.buyer.token,
      {
        purpose: "book_confirmation",
        granted: true,
        expectedBindingVersion: state.bindingVersion,
        expectedAccessEpoch: state.accessEpoch,
        noticeVersion: "synthetic-d08-v1",
        evidenceRef: `synthetic:专属客服授权本人在场-${randomUUID()}`,
      },
    ),
  );
  data(
    await request(
      "POST",
      `${p.qualityBase}/${created.id}/access`,
      p.buyer.token,
      { ...currentGrant, assistedSessionId: session.id },
    ),
  );
  assert.equal(
    (await adminRequest("GET", base + "/pdf", p.headers)).statusCode,
    200,
  );
  assert.equal(
    (await request("GET", `/v1/projects/${p.projectId}/book`, p.buyer.token))
      .statusCode,
    403,
  );
  data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/assisted-sessions`,
      p.buyer.token,
      {
        purpose: "book_confirmation",
        granted: false,
        expectedSessionId: session.id,
        expectedBindingVersion: state.bindingVersion,
        expectedAccessEpoch: state.accessEpoch,
        noticeVersion: "synthetic-d08-v1",
        evidenceRef: `synthetic:结束本次客服协助授权-${randomUUID()}`,
      },
    ),
  );
  assert.equal(
    (await adminRequest("GET", base + "/materials", p.headers)).statusCode,
    403,
  );
});
test("expired D03 active data blocks new quality evidence and fresh grants while leaving minimal case status", async (t) => {
  const p = await deliveredQualityOrder(),
    created = data(
      await request("POST", p.qualityBase, p.narrator.token, {
        attemptId: p.attempt.id,
        reason: "qualityMissingPages",
        description: "到期前申请的质量证据",
      }),
    ),
    base = `/v1/admin/quality/cases/${created.caseId}`;
  const assigned = data(
    await adminRequest("POST", base + "/assign", p.headers, {
      expectedVersion: created.version,
      dueAt: new Date(Date.now() + 86400000).toISOString(),
      evidenceRef: "synthetic:到期边界核验",
    }),
  );
  t.mock.timers.enable({
    apis: ["Date"],
    now:
      Date.parse(p.delivered.serviceTerms.playback.startsAt) + 400 * 86400000,
  });
  t.after(() => t.mock.timers.reset());
  const narrator = await login(p.narrator.who);
  assert.equal(
    (
      await request("POST", p.qualityBase, narrator.token, {
        attemptId: p.attempt.id,
        reason: "qualityMissingPages",
        description: "到期后不应新增私人证据",
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await request(
        "POST",
        `${p.qualityBase}/${created.id}/access`,
        narrator.token,
        {
          expectedVersion: assigned.version,
          scopes: ["evidence"],
          expiresAt: new Date(Date.now() + 60000).toISOString(),
          consented: true,
          noticeVersion: "synthetic-d08-v1",
        },
      )
    ).statusCode,
    403,
  );
  const status = data(await request("GET", p.qualityBase, narrator.token), 200);
  assert.equal(status.requests[0].id, created.id);
  assert.equal(status.requests[0].description, undefined);
});
test("original quality reprint obeys the exact story version's current book permission while care evidence remains available", async () => {
  const p = await reviewedQualityOrder(),
    storyUrl = `/v1/projects/${p.projectId}/stories/${p.story.id}`;
  const decide = async (allowInBook: boolean) => {
    const story = data(await request("GET", storyUrl, p.narrator.token), 200);
    return data(
      await request("POST", storyUrl + "/decisions", p.narrator.token, {
        revisionId: story.revision.id,
        expectedVersion: story.version,
        contentHash: story.revision.contentHash,
        confirmed: true,
        allowInBook,
        noticeVersion: "synthetic-d08-v1",
        evidenceRef: `synthetic:本版入书选择-${randomUUID()}`,
      }),
    );
  };
  await decide(false);
  assert.equal(
    (await adminRequest("GET", p.qualityAdminBase + "/pdf", p.headers))
      .statusCode,
    200,
  );
  assert.equal(
    (
      await adminRequest("POST", p.qualityAdminBase + "/reprints", p.headers, {
        expectedVersion: p.quality.version,
        ...p.binding,
      })
    ).statusCode,
    409,
  );
  await decide(true);
  const reprinted = data(
    await adminRequest("POST", p.qualityAdminBase + "/reprints", p.headers, {
      expectedVersion: p.quality.version,
      ...p.binding,
    }),
  );
  assert.ok(reprinted.productionAttemptId);
});
