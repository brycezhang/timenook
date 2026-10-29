import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import {
  startBookFixture,
  stopBookFixture,
  bound,
  choose,
  request,
  data,
  login,
} from "./book-fixture";
before(startBookFixture);
after(stopBookFixture);
test("fulfillment progress is private and does not expose manuscript or address", async () => {
  const p = await bound();
  data((await choose(p, p.narrator.token, "collection", true)).response);
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
import { randomUUID } from "node:crypto";
import { readyReservedFirstCopy } from "./first-copy-fixture";
import { paymentAdmin } from "./payment-admin-fixture";
import { app, config } from "./book-fixture";
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
  assert.equal(
    (await admin("GET", `${base}/attempts/${a.id}/materials`, h)).statusCode,
    403,
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
function grantBody(
  p: Awaited<ReturnType<typeof attemptFixture>>,
  minutes = 10,
) {
  return {
    ...p.binding,
    attemptId: p.attempt.id,
    expiresAt: new Date(Date.now() + minutes * 60000).toISOString(),
    noticeVersion: "synthetic-d08-v1",
    evidenceRef: `synthetic:交接读取-${randomUUID()}`,
  };
}
test("only current narrator can grant the case owner a bounded exact-version PDF and address read", async (t) => {
  const p = await attemptFixture(),
    url = `/v1/projects/${p.projectId}/fulfillment/grants`,
    body = grantBody(p);
  assert.equal(
    (await request("POST", url, p.buyer.token, body)).statusCode,
    403,
  );
  assert.equal(
    (await request("POST", url, p.narrator.token, grantBody(p, 31))).statusCode,
    400,
  );
  const granted = data(await request("POST", url, p.narrator.token, body));
  assert.equal(granted.current.grantExpiresAt, body.expiresAt);
  const materials = data(
    await admin("GET", p.attemptBase + "/materials", p.headers),
    200,
  );
  assert.deepEqual(materials.address, {
    recipientName: "合成收件人",
    phone: "13800000000",
    regionCode: "CN-110000",
    detail: "合成地址一号",
  });
  assert.equal(materials.pdf.sha256, p.binding.pdfHash);
  assert.equal(materials.stories, undefined);
  const pdf = await admin("GET", p.attemptBase + "/pdf", p.headers);
  assert.equal(pdf.statusCode, 200);
  assert.equal(pdf.rawPayload.subarray(0, 5).toString(), "%PDF-");
  const other = await operator();
  assert.equal(
    (await admin("GET", p.attemptBase + "/materials", other)).statusCode,
    403,
  );
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(body.expiresAt) });
  assert.equal(
    (await admin("GET", p.attemptBase + "/pdf", p.headers)).statusCode,
    403,
  );
  t.mock.timers.reset();
  data((await choose(p, p.narrator.token, "sharing", false)).response);
  assert.equal(
    (await admin("GET", p.attemptBase + "/materials", p.headers)).statusCode,
    403,
  );
});
test("unknown handoff stays reserved and forbids another handoff; only verified supplier acceptance consumes the entitlement", async () => {
  const p = await attemptFixture();
  data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/fulfillment/grants`,
      p.narrator.token,
      grantBody(p),
    ),
  );
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
  data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/fulfillment/grants`,
      p.narrator.token,
      grantBody(next),
    ),
  );
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
test("physical delivery after creation expiry records one delivery fact and repeated logistics never extend D03", async (t) => {
  const p = await attemptFixture();
  data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/fulfillment/grants`,
      p.narrator.token,
      grantBody(p),
    ),
  );
  const pending = data(
    await admin("POST", p.attemptBase + "/handoff", p.headers, {}),
  );
  t.mock.timers.enable({
    apis: ["Date"],
    now: Date.parse(pending.creation.expiresAt) + 1,
  });
  const headers = await operator();
  const accepted = data(
    await admin("POST", p.attemptBase + "/receipt", headers, {
      outcome: "accepted",
      evidenceRef: "synthetic:到期后核实既有交接",
    }),
  );
  assert.equal(accepted.current.state, "in_production");
  const shippedAt = new Date().toISOString();
  const body = {
    carrier: "合成物流",
    number: "SYNTHETIC123",
    shippedAt,
    evidenceRef: "synthetic:承运接收回执",
    wechat: {
      handling: "implemented_and_verified",
      evidenceRef: "synthetic:微信发货管理结果",
      result: "pending",
    },
  };
  const shipped = data(
    await admin("POST", p.attemptBase + "/shipping", headers, body),
  );
  assert.equal(shipped.current.state, "shipped");
  assert.equal(shipped.current.wechat.result, "pending");
  assert.equal(shipped.serviceTerms.playback.state, "not_started");
  const deliveredAt = new Date().toISOString(),
    delivery = { deliveredAt, evidenceRef: "synthetic:实际签收凭证" };
  const delivered = data(
    await admin("POST", p.attemptBase + "/delivery", headers, delivery),
  );
  assert.equal(delivered.current.state, "delivered");
  assert.equal(delivered.serviceTerms.playback.startsAt, deliveredAt);
  const expiresAt = delivered.serviceTerms.playback.expiresAt;
  t.mock.timers.setTime(Date.now() + 1000);
  const replay = data(
    await admin("POST", p.attemptBase + "/delivery", headers, delivery),
  );
  assert.equal(replay.serviceTerms.playback.expiresAt, expiresAt);
  const shipReplay = data(
    await admin("POST", p.attemptBase + "/shipping", headers, {
      ...body,
      wechat: { ...body.wechat, result: "recorded" },
    }),
  );
  assert.equal(shipReplay.current.state, "delivered");
  assert.equal(shipReplay.current.wechat.result, "recorded");
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
  data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/fulfillment/grants`,
      p.narrator.token,
      grantBody(p),
    ),
  );
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
test("a manuscript change after the timed grant blocks both production downloads and handoff without hiding historical progress", async () => {
  const p = await attemptFixture();
  data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/fulfillment/grants`,
      p.narrator.token,
      grantBody(p),
    ),
  );
  data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/book/cover`,
      p.buyer.token,
      { expectedVersion: 0, salutation: "后来修改的封面", photoAssetId: null },
    ),
  );
  assert.equal(
    (await admin("GET", p.attemptBase + "/materials", p.headers)).statusCode,
    409,
  );
  assert.equal(
    (await admin("GET", p.attemptBase + "/pdf", p.headers)).statusCode,
    409,
  );
  assert.equal(
    (await admin("POST", p.attemptBase + "/handoff", p.headers, {})).statusCode,
    409,
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
  assert.equal(progress.current.state, "approved");
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
test("assisted operational access requires fresh book-purpose evidence and a paused creation clock still blocks handoff", async () => {
  const p = await attemptFixture(),
    status = data(
      await request(
        "GET",
        `/v1/projects/${p.projectId}/participation`,
        p.buyer.token,
      ),
      200,
    ),
    url = `/v1/projects/${p.projectId}/fulfillment/grants`;
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
          evidenceRef: `synthetic:${randomUUID()}`,
        },
      ),
    );
  const wrong = await session("story_confirmation");
  assert.equal(
    (
      await request("POST", url, p.buyer.token, {
        ...grantBody(p),
        assistedSessionId: wrong.id,
      })
    ).statusCode,
    403,
  );
  const correct = await session("book_confirmation");
  data(
    await request("POST", url, p.buyer.token, {
      ...grantBody(p),
      assistedSessionId: correct.id,
    }),
  );
  const termsHeaders = await paymentAdmin(config, app);
  data(
    await admin(
      "POST",
      `/v1/admin/service-terms/${p.projectId}/pause`,
      termsHeaders,
      { action: "pause", supportCaseRef: "record:synthetic-production-pause" },
    ),
  );
  assert.equal(
    (await admin("GET", p.attemptBase + "/materials", p.headers)).statusCode,
    409,
  );
  assert.equal(
    (await admin("POST", p.attemptBase + "/handoff", p.headers, {})).statusCode,
    409,
  );
  assert.equal(
    data(await admin("GET", p.base, p.headers), 200).current.state,
    "approved",
  );
});
test("operational commands retain authenticated permission CSRF and payload idempotency checks", async () => {
  const p = await attemptFixture(),
    wrong = await paymentAdmin(config, app, ["care:write"]);
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

test("verified cancellation rejection resumes the existing physical stage before and after shipment, then delivery starts D03 once", async () => {
  const p = await attemptFixture();
  data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/fulfillment/grants`,
      p.narrator.token,
      grantBody(p),
    ),
  );
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
  const shipping = {
    carrier: "合成物流",
    number: "CONTINUE123",
    shippedAt: new Date().toISOString(),
    evidenceRef: "synthetic:实际承运接收",
    wechat: {
      handling: "implemented_and_verified",
      evidenceRef: "synthetic:微信发货管理结果",
      result: "recorded",
    },
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
  assert.equal(delivered.serviceTerms.playback.startsAt, delivery.deliveredAt);
  assert.equal(
    data(await admin("POST", p.attemptBase + "/delivery", p.headers, delivery))
      .serviceTerms.playback.expiresAt,
    delivered.serviceTerms.playback.expiresAt,
  );
});

test("a rejected cancellation with no accepted-production fact preserves the unknown handoff and reservation", async () => {
  const p = await attemptFixture();
  data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/fulfillment/grants`,
      p.narrator.token,
      grantBody(p),
    ),
  );
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
        wechat: {
          handling: "implemented_and_verified",
          evidenceRef: "synthetic:微信待核验",
          result: "pending",
        },
      })
    ).statusCode,
    409,
  );
});

test("a cancelled attempt permits corrected address reconfirmation on the same first-copy order, then relocks the next reservation", async () => {
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
  assert.equal(corrected.confirmations.narrator, true);
  assert.equal(corrected.confirmations.initiator, false);
  const binding = { ...p.binding, addressHash: corrected.address.hash };
  assert.equal(
    (await request("POST", firstCopy + "/submit", p.buyer.token, binding))
      .statusCode,
    409,
  );
  data(
    await request("POST", firstCopy + "/confirmations", p.buyer.token, {
      role: "initiator",
      ...binding,
      noticeVersion: "synthetic-d08-v1",
      evidenceRef: `synthetic:更正地址确认-${randomUUID()}`,
    }),
  );
  const key = randomUUID();
  const submitted = data(
    await request("POST", firstCopy + "/submit", p.buyer.token, binding, key),
  );
  assert.equal(submitted.production.id, p.order.id);
  assert.equal(submitted.production.addressHash, binding.addressHash);
  assert.equal(submitted.canReviseProduction, false);
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

import { ProductionTasks } from "../src/tasks/tasks";
test("a corrected manuscript after definitive cancellation requires both new confirmations and preserves the previous attempt PDF", async () => {
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
  assert.deepEqual(current.confirmations, {
    narrator: false,
    initiator: false,
  });
  const binding = {
    bookVersionId: current.book.id,
    snapshotHash: current.book.snapshotHash,
    pdfHash: current.book.pdf.sha256,
    addressHash: current.address.hash,
  };
  assert.notEqual(binding.bookVersionId, p.binding.bookVersionId);
  assert.notEqual(binding.pdfHash, p.binding.pdfHash);
  assert.equal(
    (await request("POST", firstCopy + "/submit", p.buyer.token, binding))
      .statusCode,
    409,
  );
  const notice = {
    noticeVersion: "synthetic-d08-v1",
    evidenceRef: `synthetic:本人确认新书稿-${randomUUID()}`,
  };
  data(
    await request("POST", firstCopy + "/confirmations", p.narrator.token, {
      role: "narrator",
      bookVersionId: binding.bookVersionId,
      snapshotHash: binding.snapshotHash,
      pdfHash: binding.pdfHash,
      ...notice,
    }),
  );
  assert.equal(
    (await request("POST", firstCopy + "/submit", p.buyer.token, binding))
      .statusCode,
    409,
  );
  data(
    await request("POST", firstCopy + "/confirmations", p.buyer.token, {
      role: "initiator",
      ...binding,
      ...notice,
      evidenceRef: `synthetic:发起人确认新书稿-${randomUUID()}`,
    }),
  );
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
