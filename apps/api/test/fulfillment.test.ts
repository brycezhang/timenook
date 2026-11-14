import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import {
  coverMetadata,
  startBookFixture,
  stopBookFixture,
  joinedProject,
  request,
  data,
  login,
} from "./book-fixture";
before(startBookFixture);
after(stopBookFixture);
test("fulfillment progress is private and does not expose manuscript or address", async () => {
  const p = await joinedProject();

  const url = `/v1/projects/${p.projectId}/fulfillment`;
  assert.equal((await request("GET", url)).statusCode, 401);
  assert.equal(
    (await request("GET", url, (await login()).token)).statusCode,
    403,
  );
  const view = data(await request("GET", url, p.narrator.token), 200);
  assert.equal(view.orderId, null);
  assert.equal(view.current, null);
  assert.deepEqual(view.attempts, []);
  assert.equal(view.book, undefined);
  assert.equal(view.address, undefined);
});
import { createHash, randomUUID } from "node:crypto";
import {
  readyFirstCopyBook,
  readyReservedFirstCopy,
} from "./first-copy-fixture";
import { paymentAdmin, partnerAdmin } from "./payment-admin-fixture";
import { app, config, state } from "./book-fixture";
async function operator() {
  return paymentAdmin(config, app, ["fulfillment:write", "audit:read"]);
}
async function admin(
  method: "GET" | "POST",
  url: string,
  headers: Record<string, string>,
  body?: object,
  key = randomUUID(),
) {
  return app.inject({
    method,
    url,
    headers: { ...headers, "idempotency-key": key },
    ...(body ? { payload: body } : {}),
  });
}
test("members can read the reserved PDF after changing the draft while ordinary preview stays unavailable", async () => {
  const p = await readyReservedFirstCopy();
  const base = `/v1/projects/${p.projectId}`;
  data(
    await request("POST", base + "/book/cover", p.buyer.token, {
      ...(await coverMetadata(p.projectId, p.buyer.token)),
      expectedVersion: 0,
      salutation: "下一版的寄语",
      photoAssetId: null,
    }),
  );
  const ordinary = data(
    await request("GET", base + `/book/versions/${p.book.id}`, p.buyer.token),
    200,
  );
  assert.equal(ordinary.state, "obsolete");
  assert.equal(
    (
      await request(
        "GET",
        base + `/book/versions/${p.book.id}/pdf`,
        p.buyer.token,
      )
    ).statusCode,
    409,
  );
  const fixed = data(
    await request("GET", base + "/fulfillment/book", p.narrator.token),
    200,
  );
  assert.equal(fixed.id, p.binding.bookVersionId);
  assert.equal(fixed.snapshotHash, p.binding.snapshotHash);
  assert.equal(fixed.pdf.sha256, p.binding.pdfHash);
  const pdf = await request(
    "GET",
    base + "/fulfillment/book/pdf",
    p.narrator.token,
  );
  assert.equal(pdf.statusCode, 200, pdf.body);
  assert.equal(
    createHash("sha256").update(pdf.rawPayload).digest("hex"),
    p.binding.pdfHash,
  );
  const outsider = await login();
  for (const suffix of ["/fulfillment/book", "/fulfillment/book/pdf"])
    assert.equal(
      (await request("GET", base + suffix, outsider.token)).statusCode,
      403,
    );
  const current = await state(p, p.narrator.token);
  const careOperator = await paymentAdmin(config, app, ["care:write"]);
  const care = data(
    await admin(
      "POST",
      `/v1/admin/projects/${p.projectId}/care-requests`,
      careOperator,
      {
      kind: "delete",
        expectedBindingVersion: current.bindingVersion,
      },
    ),
  );
  data(
    await admin(
      "POST",
      `/v1/admin/care-requests/${care.id}/verify`,
      careOperator,
      {
        expectedBindingVersion: current.bindingVersion,
        expectedAccessEpoch: current.accessEpoch,
        noticeVersion: "synthetic-d08-v1",
      evidenceRef: "synthetic:本人申请删除固定稿资料",
      },
    ),
  );
  for (const suffix of ["/fulfillment/book", "/fulfillment/book/pdf"])
    assert.equal(
      (await request("GET", base + suffix, p.narrator.token)).statusCode,
      403,
    );
});
test("concurrent creation fixes one production attempt, handoff id and case owner without exposing private materials", async () => {
  const p = await readyReservedFirstCopy(),
    h = await operator(),
    base = `/v1/admin/fulfillment/${p.order.id}`;
  const body = {
    ...p.binding,
    supplierRef: "record:synthetic-provider",
    dueAt: new Date(Date.now() + 86400000).toISOString(),
  };
  const responses = await Promise.all(
    Array.from({ length: 4 }, () => admin("POST", base + "/attempts", h, body)),
  );
  const views = responses.map((r) => data(r));
  const a = views[0].current;
  assert.equal(new Set(views.map((v) => v.current.id)).size, 1);
  assert.equal(a.state, "approved");
  assert.equal(a.sequence, 1);
  assert.ok(a.handoffId);
  assert.ok(a.caseId);
  assert.ok(a.ownerAdminId);
  assert.ok(a.dueAt);
  assert.equal(views[0].address, undefined);
  assert.equal(views[0].book, undefined);
  const progress = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/fulfillment`,
      p.buyer.token,
    ),
    200,
  );
  assert.equal(progress.current.id, a.id);
  assert.equal(progress.current.handoffId, a.handoffId);
  assert.equal(progress.deliveryAddress.recipientName, "合成收件人");
  assert.equal(progress.deliveryAddress.detail, "合成地址一号");
  assert.equal(progress.deliveryAddress.regionLabel, "北京地区（合成）");
  assert.equal(
    views[0].deliveryAddress,
    null,
    "admin progress does not grant private address access",
  );
  assert.equal(
    (await admin("GET", `${base}/attempts/${a.id}/materials`, h)).statusCode,
    200,
  );
  assert.equal(
    (
      await admin("POST", base + "/attempts", h, {
        ...body,
        supplierRef: "synthetic:另一印厂",
      })
    ).statusCode,
    409,
  );
});
async function attemptFixture() {
  const p = await readyReservedFirstCopy(),
    headers = await operator(),
    base = `/v1/admin/fulfillment/${p.order.id}`;
  const attemptKey = randomUUID();
  const attemptBody = {
    ...p.binding,
    supplierRef: "record:synthetic-provider",
    dueAt: new Date(Date.now() + 86400000).toISOString(),
  };
  const view = data(
    await admin("POST", base + "/attempts", headers, attemptBody, attemptKey),
  );
  return {
    ...p,
    headers,
    base,
    attemptKey,
    attemptBody,
    attempt: view.current,
    attemptBase: `${base}/attempts/${view.current.id}`,
  };
}

test("unknown handoff stays reserved and forbids another handoff; only verified supplier acceptance consumes the entitlement", async () => {
  const p = await attemptFixture();
  const key = randomUUID();
  const handoff = data(
    await admin("POST", p.attemptBase + "/handoff", p.headers, {}, key),
  );
  assert.equal(handoff.current.state, "handoff_pending");
  assert.equal(handoff.entitlementState, "reserved");
  assert.equal(
    data(await admin("POST", p.attemptBase + "/handoff", p.headers, {}, key))
      .current.handoffId,
    p.attempt.handoffId,
  );
  assert.equal(
    (await admin("POST", p.attemptBase + "/handoff", p.headers, {})).statusCode,
    409,
  );
  const unknown = data(
    await admin("POST", p.attemptBase + "/receipt", p.headers, {
      outcome: "unknown",
      evidenceRef: "synthetic:等待核实印厂",
    }),
  );
  assert.equal(unknown.current.state, "handoff_pending");
  assert.equal(unknown.entitlementState, "reserved");
  assert.equal(
    (
      await admin("POST", p.base + "/attempts", p.headers, {
        ...p.binding,
        supplierRef: "record:synthetic-provider",
        dueAt: new Date(Date.now() + 86400000).toISOString(),
      })
    ).statusCode,
    409,
  );
  const accepted = data(
    await admin("POST", p.attemptBase + "/receipt", p.headers, {
      outcome: "accepted",
      evidenceRef: "synthetic:印厂确定接单回执",
    }),
  );
  assert.equal(accepted.current.state, "in_production");
  assert.equal(accepted.entitlementState, "consumed");
  const creationReplay = data(
    await admin(
      "POST",
      p.base + "/attempts",
      p.headers,
      p.attemptBody,
      p.attemptKey,
    ),
  );
  assert.equal(creationReplay.current.id, p.attempt.id);
  assert.equal(creationReplay.current.state, "in_production");
  assert.equal(
    (await admin("GET", p.attemptBase + "/pdf", p.headers)).statusCode,
    403,
  );
});
test("cancellation before handoff is final, but accepted production waits for verified supplier cancellation before another attempt", async () => {
  const p = await attemptFixture();
  const cancelled = data(
    await admin("POST", p.attemptBase + "/cancel", p.headers, {
      evidenceRef: "synthetic:交接前取消",
    }),
  );
  assert.equal(cancelled.current.state, "cancelled");
  assert.equal(cancelled.entitlementState, "reserved");
  const attemptBody = {
    ...p.binding,
    supplierRef: "record:synthetic-provider",
    dueAt: new Date(Date.now() + 86400000).toISOString(),
  };
  const second = data(
    await admin("POST", p.base + "/attempts", p.headers, attemptBody),
  ).current;
  assert.notEqual(second.id, p.attempt.id);
  assert.notEqual(second.handoffId, p.attempt.handoffId);
  assert.equal(second.sequence, 2);
  const next = {
    ...p,
    attempt: second,
    attemptBase: `${p.base}/attempts/${second.id}`,
  };
  data(await admin("POST", next.attemptBase + "/handoff", p.headers, {}));
  data(
    await admin("POST", next.attemptBase + "/receipt", p.headers, {
      outcome: "accepted",
      evidenceRef: "synthetic:印厂确认生产",
    }),
  );
  const pending = data(
    await admin("POST", next.attemptBase + "/cancel", p.headers, {
      evidenceRef: "synthetic:本人撤回请求取消",
    }),
  );
  assert.equal(pending.current.state, "cancellation_pending");
  assert.equal(pending.entitlementState, "consumed");
  assert.match(pending.current.cancellationNotice, /不承诺/);
  assert.equal(
    (await admin("POST", p.base + "/attempts", p.headers, attemptBody))
      .statusCode,
    409,
  );
  const confirmed = data(
    await admin("POST", next.attemptBase + "/receipt", p.headers, {
      outcome: "cancelled",
      evidenceRef: "synthetic:印厂确认取消回执",
    }),
  );
  assert.equal(confirmed.current.state, "cancelled");
  assert.equal(confirmed.entitlementState, "reserved");
  const third = data(
    await admin("POST", p.base + "/attempts", p.headers, attemptBody),
  );
  assert.equal(third.current.sequence, 3);
});
test("physical delivery records one delivery fact and repeated logistics preserve lifetime service", async (t) => {
  const p = await attemptFixture();
  const pending = data(
    await admin("POST", p.attemptBase + "/handoff", p.headers, {}),
  );
  t.mock.timers.enable({
    apis: ["Date"],
    now: Date.now() + 60000,
  });
  const headers = await operator();
  const accepted = data(
    await admin("POST", p.attemptBase + "/receipt", headers, {
      outcome: "accepted",
      evidenceRef: "synthetic:到期后核实既有交接",
    }),
  );
  assert.equal(accepted.current.state, "in_production");
  assert.equal(accepted.current.printedAt, null);
  const printedAt = new Date().toISOString();
  const printBody = { printedAt, evidenceRef: "synthetic:实际完成印制回执" };
  assert.equal(
    (
      await admin("POST", p.attemptBase + "/shipping", headers, {
        carrier: "合成物流",
        number: "SYNTHETIC123",
        shippedAt: printedAt,
        evidenceRef: "synthetic:不能用接单代替印制",
      })
    ).statusCode,
    409,
  );
  const printKey = randomUUID();
  const printed = data(
    await admin(
      "POST",
      p.attemptBase + "/printing",
      headers,
      printBody,
      printKey,
    ),
  );
  assert.equal(printed.current.printedAt, printedAt);
  assert.ok(printed.current.printedBy);
  assert.equal(
    data(
      await admin(
        "POST",
        p.attemptBase + "/printing",
        headers,
        printBody,
        printKey,
      ),
    ).current.printedAt,
    printedAt,
  );
  assert.equal(
    (
      await admin("POST", p.attemptBase + "/printing", headers, {
        ...printBody,
        printedAt: new Date(Date.now() - 1).toISOString(),
      })
    ).statusCode,
    409,
  );
  const visible = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/fulfillment`,
      p.buyer.token,
    ),
    200,
  );
  assert.equal(visible.current.printedAt, printedAt);
  const shippedAt = new Date().toISOString();
  const body = {
    carrier: "合成物流",
    number: "SYNTHETIC123",
    shippedAt,
    evidenceRef: "synthetic:承运接收回执",
  };
  const shipped = data(
    await admin("POST", p.attemptBase + "/shipping", headers, body),
  );
  assert.equal(shipped.current.state, "shipped");
  assert.equal(shipped.current.wechat, null);
  assert.equal(shipped.serviceTerms.playback.state, "active");
  const deliveredAt = new Date().toISOString(),
    delivery = { deliveredAt, evidenceRef: "synthetic:实际签收凭证" };
  const delivered = data(
    await admin("POST", p.attemptBase + "/delivery", headers, delivery),
  );
  assert.equal(delivered.current.state, "delivered");
  assert.equal(delivered.serviceTerms.playback.expiresAt, null);
  const expiresAt = delivered.serviceTerms.playback.expiresAt;
  t.mock.timers.setTime(Date.now() + 1000);
  const replay = data(
    await admin("POST", p.attemptBase + "/delivery", headers, delivery),
  );
  assert.equal(replay.serviceTerms.playback.expiresAt, expiresAt);
  const shipReplay = data(
    await admin("POST", p.attemptBase + "/wechat", headers, {
      evidenceRef: "synthetic:微信发货管理失败",
      result: "failed",
    }),
  );
  assert.equal(shipReplay.current.state, "delivered");
  assert.equal(shipReplay.current.wechat.result, "failed");
  assert.equal(shipReplay.serviceTerms.playback.expiresAt, expiresAt);
  assert.equal(
    (
      await admin("POST", p.attemptBase + "/delivery", headers, {
        ...delivery,
        deliveredAt: new Date().toISOString(),
      })
    ).statusCode,
    409,
  );
  t.mock.timers.reset();
});
import { restartBookApplication } from "./book-fixture";
test("unknown printer result survives process restart and remains fenced to the same handoff", async () => {
  const p = await attemptFixture();
  data(await admin("POST", p.attemptBase + "/handoff", p.headers, {}));
  data(
    await admin("POST", p.attemptBase + "/receipt", p.headers, {
      outcome: "unknown",
      evidenceRef: "synthetic:印厂回执尚未知",
    }),
  );
  await restartBookApplication();
  const restored = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/fulfillment`,
      p.narrator.token,
    ),
    200,
  );
  assert.equal(restored.current.id, p.attempt.id);
  assert.equal(restored.current.handoffId, p.attempt.handoffId);
  assert.equal(restored.current.state, "handoff_pending");
  assert.equal(restored.entitlementState, "reserved");
  const headers = await operator();
  assert.equal(
    (await admin("POST", p.attemptBase + "/handoff", headers, {})).statusCode,
    409,
  );
  assert.equal(
    (
      await admin("POST", p.base + "/attempts", headers, {
        ...p.binding,
        supplierRef: "record:synthetic-provider",
        dueAt: new Date(Date.now() + 86400000).toISOString(),
      })
    ).statusCode,
    409,
  );
});
test("a later manuscript change preserves the reserved production materials, PDF and handoff", async () => {
  const p = await attemptFixture();
  data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/book/cover`,
      p.buyer.token,
      {
        ...(await coverMetadata(p.projectId, p.buyer.token)),
        expectedVersion: 0,
        salutation: "后来修改的封面",
        photoAssetId: null,
      },
    ),
  );
  assert.equal(
    (await admin("GET", p.attemptBase + "/materials", p.headers)).statusCode,
    200,
  );
  assert.equal(
    (await admin("GET", p.attemptBase + "/pdf", p.headers)).statusCode,
    200,
  );
  assert.equal(
    (await admin("POST", p.attemptBase + "/handoff", p.headers, {})).statusCode,
    201,
  );
  const progress = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/fulfillment`,
      p.narrator.token,
    ),
    200,
  );
  assert.equal(progress.current.id, p.attempt.id);
  assert.equal(progress.current.state, "handoff_pending");
  assert.equal(progress.reservation.pdfHash, p.binding.pdfHash);
});
test("handoff approval cannot choose a printing provider outside the purchased D08 admission", async () => {
  const p = await readyReservedFirstCopy(),
    headers = await operator();
  assert.equal(
    (
      await admin(
        "POST",
        `/v1/admin/fulfillment/${p.order.id}/attempts`,
        headers,
        {
          ...p.binding,
          supplierRef: "synthetic:未准入供应商",
          dueAt: new Date(Date.now() + 86400000).toISOString(),
        },
      )
    ).statusCode,
    409,
  );
});

test("operational commands retain authenticated permission CSRF and payload idempotency checks", async () => {
  const p = await attemptFixture(),
    wrong = await partnerAdmin(config, app);
  assert.equal((await admin("GET", p.base, wrong)).statusCode, 403);
  assert.equal(
    (
      await admin(
        "POST",
        p.attemptBase + "/cancel",
        { cookie: p.headers.cookie, origin: p.headers.origin },
        { evidenceRef: "synthetic:缺少csrf" },
      )
    ).statusCode,
    403,
  );
  const key = randomUUID();
  data(
    await admin(
      "POST",
      p.attemptBase + "/cancel",
      p.headers,
      { evidenceRef: "synthetic:正常取消" },
      key,
    ),
  );
  assert.equal(
    (
      await admin(
        "POST",
        p.attemptBase + "/cancel",
        p.headers,
        { evidenceRef: "synthetic:异载荷重放" },
        key,
      )
    ).statusCode,
    409,
  );
  const audit = data(await admin("GET", "/v1/admin/audit", p.headers), 200);
  assert.ok(
    audit.some(
      (event: { action: string; result: string }) =>
        event.action === "fulfillment.cancel" && event.result === "denied:403",
    ),
  );
});

test("verified cancellation rejection resumes the existing physical stage before and after shipment, then delivery records one lifetime-service fact", async () => {
  const p = await attemptFixture();
  data(await admin("POST", p.attemptBase + "/handoff", p.headers, {}));
  data(
    await admin("POST", p.attemptBase + "/receipt", p.headers, {
      outcome: "accepted",
      evidenceRef: "synthetic:印厂已确定接单",
    }),
  );
  const cancelled = data(
    await admin("POST", p.attemptBase + "/cancel", p.headers, {
      evidenceRef: "synthetic:生产中申请取消",
    }),
  );
  assert.equal(cancelled.current.state, "cancellation_pending");
  const rejected = {
    outcome: "cancellation_rejected",
    evidenceRef: "synthetic:印厂确认已生产不能取消",
  };
  const key = randomUUID();
  const continuing = data(
    await admin("POST", p.attemptBase + "/receipt", p.headers, rejected, key),
  );
  assert.equal(continuing.current.state, "in_production");
  assert.equal(continuing.current.id, p.attempt.id);
  assert.equal(continuing.current.handoffId, p.attempt.handoffId);
  assert.equal(continuing.entitlementState, "consumed");
  assert.equal(continuing.attempts.length, 1);
  assert.equal(
    data(
      await admin("POST", p.attemptBase + "/receipt", p.headers, rejected, key),
    ).current.state,
    "in_production",
  );
  assert.equal(
    (
      await admin(
        "POST",
        p.attemptBase + "/receipt",
        p.headers,
        { ...rejected, evidenceRef: "synthetic:同键不同核验结果" },
        key,
      )
    ).statusCode,
    409,
  );
  assert.equal(
    (await admin("POST", p.base + "/attempts", p.headers, p.attemptBody))
      .statusCode,
    409,
  );
  data(
    await admin("POST", p.attemptBase + "/printing", p.headers, {
      printedAt: new Date().toISOString(),
      evidenceRef: "synthetic:完成印制核验",
    }),
  );
  const shipping = {
    carrier: "合成物流",
    number: "CONTINUE123",
    shippedAt: new Date().toISOString(),
    evidenceRef: "synthetic:实际承运接收",
  };
  const shipped = data(
    await admin("POST", p.attemptBase + "/shipping", p.headers, shipping),
  );
  assert.equal(shipped.current.state, "shipped");
  data(
    await admin("POST", p.attemptBase + "/cancel", p.headers, {
      evidenceRef: "synthetic:发货后申请取消",
    }),
  );
  const stillShipped = data(
    await admin("POST", p.attemptBase + "/receipt", p.headers, {
      outcome: "cancellation_rejected",
      evidenceRef: "synthetic:已发货无法召回",
    }),
  );
  assert.equal(stillShipped.current.state, "shipped");
  assert.deepEqual(stillShipped.current.tracking, shipped.current.tracking);
  assert.equal(stillShipped.entitlementState, "consumed");
  assert.equal(stillShipped.attempts.length, 1);
  const delivery = {
    deliveredAt: new Date().toISOString(),
    evidenceRef: "synthetic:实际交付签收凭证",
  };
  const delivered = data(
    await admin("POST", p.attemptBase + "/delivery", p.headers, delivery),
  );
  assert.equal(delivered.current.state, "delivered");
  assert.equal(delivered.serviceTerms.playback.expiresAt, null);
  assert.equal(
    data(await admin("POST", p.attemptBase + "/delivery", p.headers, delivery))
      .serviceTerms.playback.expiresAt,
    delivered.serviceTerms.playback.expiresAt,
  );
});

test("a rejected cancellation with no accepted-production fact preserves the unknown handoff and reservation", async () => {
  const p = await attemptFixture();
  data(await admin("POST", p.attemptBase + "/handoff", p.headers, {}));
  data(
    await admin("POST", p.attemptBase + "/cancel", p.headers, {
      evidenceRef: "synthetic:待核实交接申请取消",
    }),
  );
  const continuing = data(
    await admin("POST", p.attemptBase + "/receipt", p.headers, {
      outcome: "cancellation_rejected",
      evidenceRef: "synthetic:印厂未能取消仍待核实",
    }),
  );
  assert.equal(continuing.current.state, "handoff_pending");
  assert.equal(continuing.entitlementState, "reserved");
  assert.equal(
    (await admin("POST", p.attemptBase + "/handoff", p.headers, {})).statusCode,
    409,
  );
  assert.equal(
    (
      await admin("POST", p.attemptBase + "/shipping", p.headers, {
        carrier: "合成物流",
        number: "UNKNOWN123",
        shippedAt: new Date().toISOString(),
        evidenceRef: "synthetic:未经核实发货",
      })
    ).statusCode,
    409,
  );
});

import { ProductionTasks } from "../src/tasks/tasks";

test("production search covers linked identifiers with stable filtered pagination and separates pending exceptions", async () => {
  const a = await readyReservedFirstCopy(),
    b = await readyReservedFirstCopy(),
    h = await operator();
  const list = async (q: string) =>
    data(await admin("GET", `/v1/admin/fulfillment?${q}`, h), 200);
  const first = await list("page=1&pageSize=1&state=pdf_ready");
  const next = await list("page=2&pageSize=1&state=pdf_ready");
  assert.ok(first.total >= 2);
  assert.equal(first.items.length, 1);
  assert.notEqual(first.items[0].id, next.items[0].id);
  assert.equal((await list(`q=${a.order.id}`)).items[0].id, a.order.id);
  assert.equal(
    (await list(`q=${a.projectId}&pending=true&exception=false`)).total,
    1,
  );
  assert.equal(
    (await list(`q=${a.orderId}`)).items[0].paymentOrderId,
    a.orderId,
  );
  assert.equal((await list(`q=${b.projectId}&exception=true`)).total, 0);
  assert.equal(
    (await admin("GET", "/v1/admin/fulfillment?pageSize=101", h)).statusCode,
    400,
  );
  assert.equal(
    (await admin("GET", "/v1/admin/fulfillment?state=arbitrary", h)).statusCode,
    400,
  );
});

test("a paid content-only package does not acquire physical rights from a ready candidate PDF or payment", async () => {
  const p = await readyFirstCopyBook({}, false);
  const value = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/first-copy`,
      p.buyer.token,
    ),
    200,
  );
  assert.equal(value.payment.paidAmountFen, 99900);
  assert.ok(value.blockers.includes("PHYSICAL_PRODUCTION_UNAVAILABLE"));
  assert.equal(value.canSubmit, false);
});

test("a cancelled attempt permits a corrected address and direct resubmission on the same first-copy order, then relocks the next reservation", async () => {
  const p = await attemptFixture();
  data(
    await admin("POST", p.attemptBase + "/cancel", p.headers, {
      evidenceRef: "synthetic:已确定取消原尝试",
    }),
  );
  const firstCopy = `/v1/projects/${p.projectId}/first-copy`;
  const before = data(await request("GET", firstCopy, p.buyer.token), 200);
  assert.equal(before.canReviseProduction, true);
  const originalReplay = data(
    await request(
      "POST",
      firstCopy + "/submit",
      p.buyer.token,
      p.binding,
      p.originalSubmitKey,
    ),
  );
  assert.equal(originalReplay.production.id, p.order.id);
  assert.equal(originalReplay.canReviseProduction, true);

  const corrected = data(
    await request("POST", firstCopy + "/address", p.buyer.token, {
      ...before.address.value,
      expectedVersion: before.address.version,
      detail: "合成更正后的新地址",
    }),
  );
  const cancelled = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/fulfillment`,
      p.buyer.token,
    ),
    200,
  );
  assert.equal(cancelled.current.state, "cancelled");
  assert.equal(
    cancelled.deliveryAddress.detail,
    "合成地址一号",
    "editing the next address preserves the cancelled attempt snapshot",
  );

  const binding = { ...p.binding, addressHash: corrected.address.hash };

  const key = randomUUID();
  const submitted = data(
    await request("POST", firstCopy + "/submit", p.buyer.token, binding, key),
  );
  assert.equal(submitted.production.id, p.order.id);
  assert.equal(submitted.production.addressHash, binding.addressHash);
  assert.equal(submitted.canReviseProduction, false);
  const waiting = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/fulfillment`,
      p.buyer.token,
    ),
    200,
  );
  assert.equal(
    waiting.current,
    null,
    "the cancelled prior reservation is not the new production stage",
  );
  assert.equal(waiting.attempts[0].state, "cancelled");
  assert.equal(waiting.deliveryAddress.detail, "合成更正后的新地址");
  data(
    await admin(
      "POST",
      `/v1/admin/first-copy/${p.order.id}/approve`,
      p.headers,
      binding,
    ),
  );
  assert.equal(
    data(await request("GET", firstCopy, p.buyer.token), 200)
      .canReviseProduction,
    false,
  );

  assert.equal(
    (
      await request("POST", firstCopy + "/address", p.buyer.token, {
        ...before.address.value,
        expectedVersion: corrected.address.version,
      })
    ).statusCode,
    409,
  );
  assert.equal(
    data(
      await request("POST", firstCopy + "/submit", p.buyer.token, binding, key),
    ).production.id,
    p.order.id,
  );
  const retried = data(
    await admin("POST", p.base + "/attempts", p.headers, {
      ...p.attemptBody,
      ...binding,
    }),
  );
  assert.equal(retried.current.sequence, 2);
  assert.equal(retried.current.addressHash, binding.addressHash);
  assert.equal(retried.attempts[1].addressHash, p.binding.addressHash);
  assert.equal(retried.attempts[1].state, "cancelled");
  assert.equal(retried.entitlementState, "reserved");
  assert.equal(
    data(await request("GET", firstCopy, p.buyer.token), 200)
      .canReviseProduction,
    false,
  );
});
test("a corrected manuscript after definitive cancellation can be directly resubmitted while preserving the previous attempt PDF", async () => {
  const p = await attemptFixture();
  data(
    await admin("POST", p.attemptBase + "/cancel", p.headers, {
      evidenceRef: "synthetic:原版确认取消",
    }),
  );
  const firstCopy = `/v1/projects/${p.projectId}/first-copy`,
    bookBase = `/v1/projects/${p.projectId}/book`;
  data(
    await request("POST", bookBase + "/cover", p.buyer.token, {
      ...(await coverMetadata(p.projectId, p.buyer.token)),
      expectedVersion: 0,
      salutation: "本人要求更正的新版封面",
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
  assert.equal(current.book.state, "ready");

  const binding = {
    bookVersionId: current.book.id,
    snapshotHash: current.book.snapshotHash,
    pdfHash: current.book.pdf.sha256,
    addressHash: current.address.hash,
  };
  assert.notEqual(binding.bookVersionId, p.binding.bookVersionId);
  assert.notEqual(binding.pdfHash, p.binding.pdfHash);

  const reserved = data(
    await request("POST", firstCopy + "/submit", p.buyer.token, binding),
  );
  assert.equal(reserved.production.id, p.order.id);
  assert.equal(reserved.canReviseProduction, false);
  const retried = data(
    await admin("POST", p.base + "/attempts", p.headers, {
      ...p.attemptBody,
      ...binding,
    }),
  );
  assert.equal(retried.orderId, p.order.id);
  assert.equal(retried.current.bookVersionId, binding.bookVersionId);
  assert.equal(retried.current.pdfHash, binding.pdfHash);
  assert.equal(retried.attempts[1].bookVersionId, p.binding.bookVersionId);
  assert.equal(retried.attempts[1].snapshotHash, p.binding.snapshotHash);
  assert.equal(retried.attempts[1].pdfHash, p.binding.pdfHash);
  assert.equal(retried.attempts[1].state, "cancelled");
  assert.equal(
    (await admin("GET", p.attemptBase + "/pdf", p.headers)).statusCode,
    403,
  );
});
