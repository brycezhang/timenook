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
  app,
  db,
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

  data(await adminRequest("POST", attemptBase + "/handoff", p.headers, {}));
  data(
    await adminRequest("POST", attemptBase + "/receipt", p.headers, {
      outcome: "accepted",
      evidenceRef: "synthetic:重印实际接单",
    }),
  );
  data(
    await adminRequest("POST", attemptBase + "/printing", p.headers, {
      printedAt: new Date().toISOString(),
      evidenceRef: "synthetic:完成印制核验",
    }),
  );
  data(
    await adminRequest("POST", attemptBase + "/shipping", p.headers, {
      carrier: "合成物流",
      number: "SYNTHETICREPRINT",
      shippedAt: new Date().toISOString(),
      evidenceRef: "synthetic:重印承运",
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
  const delivery = await db.fulfillmentDelivery.findUniqueOrThrow({
    where: { orderId: p.order.id },
  });
  const end = delivery.occurredAt.getTime() + 30 * 86400000;
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

test("quality evidence stays available beyond 2099 while private staff grants still expire and can be renewed", async (t) => {
  const p = await deliveredQualityOrder(),
    created = data(
      await request("POST", p.qualityBase, p.narrator.token, {
        attemptId: p.attempt.id,
        reason: "qualityMissingPages",
        description: "长期保留的质量证据",
      }),
    ),
    base = `/v1/admin/quality/cases/${created.caseId}`;
  const assigned = data(
    await adminRequest("POST", base + "/assign", p.headers, {
      expectedVersion: created.version,
      dueAt: new Date(Date.now() + 86400000).toISOString(),
      evidenceRef: "synthetic:按人工时限核验",
    }),
  );
  await db.adminSession.updateMany({
    data: { expiresAt: new Date("2200-01-01T00:00:00Z") },
  });
  const future = Date.parse("2100-01-01T00:00:00Z");
  t.mock.timers.enable({ apis: ["Date"], now: future });
  try {
    const narrator = await login(p.narrator.who);
    const grant = () =>
      request("POST", `${p.qualityBase}/${created.id}/access`, narrator.token, {
        expectedVersion: assigned.version,
        scopes: ["evidence"],
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        consented: true,
        noticeVersion: "synthetic-d08-v1",
      });
    data(await grant());
    assert.equal(
      data(await adminRequest("GET", base + "/materials", p.headers), 200)
        .description,
      "长期保留的质量证据",
    );
    t.mock.timers.setTime(future + 60000);
    assert.equal(
      (await adminRequest("GET", base + "/materials", p.headers)).statusCode,
      403,
    );
    data(await grant());
    assert.equal(
      data(await adminRequest("GET", base + "/materials", p.headers), 200)
        .description,
      "长期保留的质量证据",
    );
  } finally {
    t.mock.timers.reset();
  }
});

test("an existing quality request accepts internal review evidence and its actions belong to the original order history", async () => {
  const p = await deliveredQualityOrder();
  const created = data(
    await request("POST", p.qualityBase, p.buyer.token, {
      attemptId: p.attempt.id,
      reason: "qualityMissingPages",
      description: "合成订单详情质量核对说明",
    }),
  );
  const base = `/v1/admin/quality/cases/${created.caseId}`;
  const assigned = data(
    await adminRequest("POST", base + "/assign", p.headers, {
      expectedVersion: created.version,
      dueAt: new Date(Date.now() + 86400000).toISOString(),
      evidenceRef: "internal:原D06负责人和处理截止已核验",
    }),
  );
  assert.equal(assigned.state, "assigned");
  const detail = data(
    await adminRequest("GET", `/v1/admin/orders/${p.orderId}`, p.headers),
    200,
  );
  assert.equal(detail.qualityRequests[0].caseId, created.caseId);
  assert.ok(
    detail.history.some(
      (entry: any) =>
        entry.action === "quality.assign" && entry.result === "success",
    ),
  );
});
