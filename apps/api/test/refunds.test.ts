import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { before, after, test } from "node:test";
import {
  startBookFixture,
  stopBookFixture,
  app,
  db,
  config,
  project,
  bound,
  login,
  data,
  request,
  restartBookApplication,
} from "./book-fixture";
import { paymentAdmin } from "./payment-admin-fixture";
import { readyReservedFirstCopy } from "./first-copy-fixture";
import {
  supplierRefunds,
  refundFault,
  paymentRequests,
  callback,
  paymentConfig,
} from "./payment-fixture";

let admin: Record<string, string>;
before(async () => {
  await startBookFixture();
  admin = await paymentAdmin(config, app, ["care:write", "audit:read"]);
});
test("unknown refund submission keeps its reservation and reconciles the original number across restart instead of resending", async () => {
  const p = await project(),
    r = data(await open(p));
  data(
    await adminRequest("POST", `/${r.id}/approve`, {
      amountFen: 99900,
      evidenceRef: "synthetic:approval",
    }),
  );
  const before = paymentRequests.filter(
    (r) => r.path === "/v3/refund/domestic/refunds" && r.method === "POST",
  ).length;
  refundFault("timeout");
  const unknown = data(await adminRequest("POST", `/${r.id}/submit`, {}));
  assert.equal(unknown.state, "unknown");
  assert.equal(unknown.outRefundNo, r.outRefundNo);
  assert.equal(
    data(
      await request("GET", `/v1/orders/${p.orderId}/refunds`, p.buyer.token),
      200,
    ).reservedAmountFen,
    99900,
  );
  await restartBookApplication();
  const recovered = data(await adminRequest("POST", `/${r.id}/submit`, {}));
  assert.equal(recovered.state, "processing");
  assert.equal(
    paymentRequests.filter(
      (r) => r.path === "/v3/refund/domestic/refunds" && r.method === "POST",
    ).length,
    before + 1,
  );
  const supplier = supplierRefunds.get(r.outRefundNo)!;
  Object.assign(supplier, {
    status: "SUCCESS",
    success_time: new Date().toISOString(),
  });
  const success = data(await adminRequest("POST", `/${r.id}/reconcile`, {}));
  assert.equal(success.state, "succeeded");
  assert.ok(success.completedAt);
  const state = data(
    await request("GET", `/v1/orders/${p.orderId}/refunds`, p.buyer.token),
    200,
  );
  assert.equal(state.refundedAmountFen, 99900);
  assert.equal(state.reservedAmountFen, 0);
  assert.equal(state.creationState, "terminated");
  const order = data(
    await request("GET", `/v1/orders/${p.orderId}`, p.buyer.token),
    200,
  );
  assert.equal(order.state, "paid");
  assert.equal(order.project.entitlement.state, "revoked");
  assert.equal(order.project.terms.deleteData, false);
  assert.equal(order.project.terms.canRecord, false);
  assert.equal(order.project.terms.firstCopyAction, "blocked");
});
after(stopBookFixture);

function adminRequest(
  method: "GET" | "POST",
  path: string,
  body?: object,
  key = randomUUID(),
  headers = admin,
) {
  return app.inject({
    method,
    url: `/v1/admin/refunds${path}`,
    headers: { ...headers, "idempotency-key": key },
    ...(body ? { payload: body } : {}),
  });
}
const refundBody = {
  reason: "notParticipated",
  evidenceRef: "synthetic:buyer-refund-request",
};
async function open(
  p: Awaited<ReturnType<typeof project>>,
  body = refundBody,
  key = randomUUID(),
) {
  return request(
    "POST",
    `/v1/orders/${p.orderId}/refunds`,
    p.buyer.token,
    body,
    key,
  );
}
test("paid buyer requests a persistent refund case, replays the same intent and cannot inspect another buyer's money", async () => {
  const p = await project(),
    key = randomUUID();
  const created = data(await open(p, refundBody, key));
  assert.equal(created.state, "requested");
  assert.equal(created.reason, "notParticipated");
  assert.equal(created.amountFen, null);
  assert.equal(created.orderId, p.orderId);
  assert.equal(created.deleteData, false);
  assert.deepEqual(data(await open(p, refundBody, key)), created);
  assert.equal(
    (await open(p, { ...refundBody, evidenceRef: "synthetic:different" }, key))
      .statusCode,
    409,
  );
  const list = data(
    await request("GET", `/v1/orders/${p.orderId}/refunds`, p.buyer.token),
    200,
  );
  assert.equal(list.refunds[0].id, created.id);
  assert.equal(list.paidAmountFen, 99900);
  assert.equal(list.refundedAmountFen, 0);
  assert.equal(list.reservedAmountFen, 0);
  const stranger = await login();
  assert.equal(
    (await request("GET", `/v1/orders/${p.orderId}/refunds`, stranger.token))
      .statusCode,
    404,
  );
  assert.equal(
    (await request("GET", `/v1/orders/${p.orderId}/refunds`)).statusCode,
    401,
  );
  const care = data(
    await app.inject({
      method: "GET",
      url: `/v1/admin/care-requests/${created.caseId}`,
      headers: admin,
    }),
    200,
  );
  assert.equal(care.kind, "refund");
  assert.equal(care.projectId, p.projectId);
});
test("approval freezes production, reserves fixed D07 money under the order lock and rejects concurrent over-refunds", async () => {
  const p = await project(),
    one = data(await open(p)),
    two = data(await open(p));
  const key = randomUUID(),
    secondKey = randomUUID(),
    otherAdmin = await paymentAdmin(config, app, ["care:write"]),
    body = { amountFen: 99900, evidenceRef: "synthetic:verified-fixed-policy" };
  const results = await Promise.all([
    adminRequest("POST", `/${one.id}/approve`, body, key),
    adminRequest("POST", `/${two.id}/approve`, body, secondKey, otherAdmin),
  ]);
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [201, 409]);
  const success = results.find((r) => r.statusCode === 201)!.json().data;
  const winner =
    results[0].statusCode === 201
      ? { key, headers: admin }
      : { key: secondKey, headers: otherAdmin };
  assert.equal(success.state, "approved");
  assert.equal(success.amountFen, 99900);
  assert.equal(success.rule.entitlementEffect.creation, "terminate");
  assert.ok(success.approvedBy);
  assert.ok(success.dueAt);
  const state = data(
    await request("GET", `/v1/orders/${p.orderId}/refunds`, p.buyer.token),
    200,
  );
  assert.equal(state.reservedAmountFen, 99900);
  assert.equal(state.availableAmountFen, 0);
  assert.equal(state.productionFrozen, true);
  assert.equal(state.refundedAmountFen, 0);
  assert.equal(
    (
      await adminRequest(
        "POST",
        `/${success.id}/approve`,
        { ...body, amountFen: 1 },
        winner.key,
        winner.headers,
      )
    ).statusCode,
    409,
  );
  assert.equal(
    data(
      await adminRequest(
        "POST",
        `/${success.id}/approve`,
        body,
        winner.key,
        winner.headers,
      ),
    ).dueAt,
    success.dueAt,
  );
  const invalid = await project(),
    pending = data(await open(invalid));
  assert.equal(
    (
      await adminRequest("POST", `/${pending.id}/approve`, {
        ...body,
        amountFen: 100,
      })
    ).statusCode,
    409,
  );
  const started = await bound(),
    requestId = data(await open(started));
  assert.equal(
    (await adminRequest("POST", `/${requestId.id}/approve`, body)).statusCode,
    409,
  );
});
async function customProject(
  amount: number,
  effect = { creation: "retain", firstCopy: "retain" },
) {
  const snapshot = JSON.parse(
    readFileSync("test/fixtures/catalog-synthetic.json", "utf8"),
  );
  Object.assign(snapshot.admission.d07.notParticipated, {
    refundAmount: { value: amount, unit: "fen" },
    entitlementEffect: effect,
  });
  const draftId = randomUUID(),
    id = randomUUID();
  await db.packageDraft.create({
    data: { id: draftId, realm: "local", ...snapshot },
  });
  await db.packageVersion.create({
    data: {
      id,
      realm: "local",
      purpose: "local_preview",
      draftId,
      draftRevision: 1,
      snapshot,
      publicOffer: { title: "synthetic refund policy" },
    },
  });
  return project(id);
}
async function refundCallback(row: Record<string, unknown>, id = randomUUID()) {
  const status = String(row.status);
  const event = await callback(
    { ...row, mchid: paymentConfig.merchantId, refund_status: status },
    id,
    "refund",
    `REFUND.${status}`,
  );
  return app.inject({
    method: "POST",
    url: "/v1/webhooks/wechat-pay/refunds",
    headers: { ...event.headers, "content-type": "application/json" },
    payload: event.body,
  });
}
test("signed refund callbacks reject wrong money and replayed event changes while partial refunds preserve the same entitlement", async () => {
  const p = await customProject(30000),
    r = data(await open(p));
  data(
    await adminRequest("POST", `/${r.id}/approve`, {
      amountFen: 30000,
      evidenceRef: "synthetic:partial-fixed-policy",
    }),
  );
  const processing = data(await adminRequest("POST", `/${r.id}/submit`, {}));
  assert.equal(processing.state, "processing");
  const row = supplierRefunds.get(r.outRefundNo)!;
  const sent = [...paymentRequests]
    .reverse()
    .find(
      (q) =>
        q.path === "/v3/refund/domestic/refunds" &&
        q.body.out_refund_no === r.outRefundNo,
    )!;
  assert.equal(
    sent.body.notify_url,
    "https://synthetic.invalid/timenook/v1/webhooks/wechat-pay/refunds",
  );
  Object.assign(row, {
    status: "SUCCESS",
    success_time: new Date().toISOString(),
  });
  const wrong = {
    ...row,
    amount: { total: 99900, refund: 1, currency: "CNY" },
  };
  assert.equal((await refundCallback(wrong)).statusCode, 400);
  const id = randomUUID(),
    event = await callback(
      { ...row, mchid: paymentConfig.merchantId, refund_status: "SUCCESS" },
      id,
      "refund",
      "REFUND.SUCCESS",
    );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/webhooks/wechat-pay/refunds",
        headers: {
          ...event.headers,
          "Wechatpay-Signature": "invalid",
          "content-type": "application/json",
        },
        payload: event.body,
      })
    ).statusCode,
    400,
  );
  assert.equal((await refundCallback(row, id)).statusCode, 204);
  assert.equal((await refundCallback(row, id)).statusCode, 204);
  assert.equal(
    (await refundCallback({ ...row, status: "ABNORMAL" })).statusCode,
    204,
    "a late abnormal event cannot erase verified success",
  );
  assert.equal(
    (
      await refundCallback(
        { ...row, success_time: new Date(Date.now() - 1000).toISOString() },
        id,
      )
    ).statusCode,
    409,
  );
  const state = data(
    await request("GET", `/v1/orders/${p.orderId}/refunds`, p.buyer.token),
    200,
  );
  assert.equal(state.refundedAmountFen, 30000);
  assert.equal(state.availableAmountFen, 69900);
  assert.equal(state.reservedAmountFen, 0);
  assert.equal(state.productionFrozen, false);
  assert.equal(state.creationState, "active");
  const order = data(
    await request("GET", `/v1/orders/${p.orderId}`, p.buyer.token),
    200,
  );
  assert.equal(order.project.entitlement.state, "available");
  assert.equal(order.project.terms.deleteData, false);
  const second = data(await open(p));
  data(
    await adminRequest("POST", `/${second.id}/approve`, {
      amountFen: 30000,
      evidenceRef: "synthetic:second-fixed-partial",
    }),
  );
  assert.equal(
    data(
      await request("GET", `/v1/orders/${p.orderId}/refunds`, p.buyer.token),
      200,
    ).availableAmountFen,
    39900,
  );
});
test("an unsubmitted approved refund can be rejected with evidence, releasing its reservation without inventing supplier failure", async () => {
  const p = await project(),
    r = data(await open(p));
  data(
    await adminRequest("POST", `/${r.id}/approve`, {
      amountFen: 99900,
      evidenceRef: "synthetic:approved",
    }),
  );
  const rejected = data(
    await adminRequest("POST", `/${r.id}/reject`, {
      evidenceRef: "synthetic:buyer-changed-request",
    }),
  );
  assert.equal(rejected.state, "rejected");
  const state = data(
    await request("GET", `/v1/orders/${p.orderId}/refunds`, p.buyer.token),
    200,
  );
  assert.equal(state.reservedAmountFen, 0);
  assert.equal(state.productionFrozen, false);
  assert.equal(
    (await adminRequest("POST", `/${r.id}/submit`, {})).statusCode,
    409,
  );
});
test("a refund freezes a reserved production attempt and requires a verified original receipt before executing unknown handoff money", async () => {
  const p = await readyReservedFirstCopy(),
    h = await paymentAdmin(config, app, ["fulfillment:write", "care:write"]),
    base = `/v1/admin/fulfillment/${p.order.id}`;
  const cmd = (path: string, body: object = {}) =>
    app.inject({
      method: "POST",
      url: base + path,
      headers: { ...h, "idempotency-key": randomUUID() },
      payload: body,
    });
  const attempt = data(
    await cmd("/attempts", {
      ...p.binding,
      supplierRef: "record:synthetic-provider",
      dueAt: new Date(Date.now() + 86400000).toISOString(),
    }),
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
        evidenceRef: "synthetic:handoff-grant",
      },
    ),
  );
  data(await cmd(`/attempts/${attempt.id}/handoff`));
  const r = data(
    await open(p, {
      reason: "platformUnableDeliver",
      evidenceRef: "synthetic:delivery-failure",
    }),
  );
  const approved = data(
    await adminRequest("POST", `/${r.id}/approve`, {
      amountFen: 99900,
      evidenceRef: "synthetic:failure-verified",
      failureNotifiedAt: new Date().toISOString(),
    }),
  );
  assert.equal(approved.productionReviewRequired, true);
  assert.equal(
    (await adminRequest("POST", `/${r.id}/submit`, {})).statusCode,
    409,
  );
  assert.equal(
    (
      await adminRequest("POST", `/${r.id}/production-review`, {
        attemptId: attempt.id,
        evidenceRef: "synthetic:still-unknown",
      })
    ).statusCode,
    409,
  );
  data(
    await cmd(`/attempts/${attempt.id}/receipt`, {
      outcome: "accepted",
      evidenceRef: "synthetic:accepted-receipt",
    }),
  );
  const reviewed = data(
    await adminRequest("POST", `/${r.id}/production-review`, {
      attemptId: attempt.id,
      evidenceRef: "synthetic:verified-cannot-stop-original",
    }),
  );
  assert.equal(reviewed.productionReviewRequired, false);
  data(await adminRequest("POST", `/${r.id}/submit`, {}));
  const row = supplierRefunds.get(r.outRefundNo)!;
  Object.assign(row, {
    status: "SUCCESS",
    success_time: new Date().toISOString(),
  });
  assert.equal((await refundCallback(row)).statusCode, 204);
  const order = data(
    await request("GET", `/v1/orders/${p.orderId}`, p.buyer.token),
    200,
  );
  assert.equal(
    order.project.entitlement.state,
    "consumed",
    "known physical production stays consumed after money refund",
  );
  data(
    await cmd(`/attempts/${attempt.id}/cancel`, {
      evidenceRef: "synthetic:stop-after-refund",
    }),
  );
  data(
    await cmd(`/attempts/${attempt.id}/receipt`, {
      outcome: "cancelled",
      evidenceRef: "synthetic:cancel-confirmed-after-refund",
    }),
  );
  const cancelledOrder = data(
    await request("GET", `/v1/orders/${p.orderId}`, p.buyer.token),
    200,
  );
  assert.equal(
    cancelledOrder.project.entitlement.state,
    "revoked",
    "a later confirmed cancellation applies the purchased refund first-copy effect",
  );
  assert.equal(
    (
      await cmd("/attempts", {
        ...p.binding,
        supplierRef: "record:synthetic-provider",
        dueAt: new Date(Date.now() + 86400000).toISOString(),
      })
    ).statusCode,
    409,
  );
});
test("known cancellation retains the production acceptance fact for the purchased in-production refund policy", async () => {
  const p = await readyReservedFirstCopy(),
    h = await paymentAdmin(config, app, ["fulfillment:write"]),
    base = `/v1/admin/fulfillment/${p.order.id}`;
  const cmd = (path: string, body: object = {}) =>
    app.inject({
      method: "POST",
      url: base + path,
      headers: { ...h, "idempotency-key": randomUUID() },
      payload: body,
    });
  const attempt = data(
    await cmd("/attempts", {
      ...p.binding,
      supplierRef: "record:synthetic-provider",
      dueAt: new Date(Date.now() + 86400000).toISOString(),
    }),
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
        evidenceRef: "synthetic:grant",
      },
    ),
  );
  data(await cmd(`/attempts/${attempt.id}/handoff`));
  data(
    await cmd(`/attempts/${attempt.id}/receipt`, {
      outcome: "accepted",
      evidenceRef: "synthetic:accepted",
    }),
  );
  data(
    await cmd(`/attempts/${attempt.id}/cancel`, {
      evidenceRef: "synthetic:cancel-request",
    }),
  );
  data(
    await cmd(`/attempts/${attempt.id}/receipt`, {
      outcome: "cancelled",
      evidenceRef: "synthetic:confirmed-cancel",
    }),
  );
  const r = data(
    await open(p, {
      reason: "inProduction",
      evidenceRef: "synthetic:refund-after-cancellation",
    }),
  );
  const approved = data(
    await adminRequest("POST", `/${r.id}/approve`, {
      amountFen: 20000,
      evidenceRef: "synthetic:original-acceptance-reviewed",
    }),
  );
  assert.equal(approved.amountFen, 20000);
  assert.equal(approved.productionReviewRequired, false);
  assert.equal((await cmd(`/attempts/${attempt.id}/handoff`)).statusCode, 409);
});
test("abnormal outcomes keep the reserved amount and only a verified closure releases it", async () => {
  const p = await customProject(10000),
    r = data(await open(p)),
    body = { amountFen: 10000, evidenceRef: "synthetic:partial-approved" };
  data(await adminRequest("POST", `/${r.id}/approve`, body));
  const before = paymentRequests.filter(
    (q) => q.path === "/v3/refund/domestic/refunds" && q.method === "POST",
  ).length;
  const submissions = await Promise.all([
    adminRequest("POST", `/${r.id}/submit`, {}),
    adminRequest("POST", `/${r.id}/submit`, {}),
  ]);
  assert.ok(submissions.every((q) => q.statusCode === 201));
  assert.equal(
    paymentRequests.filter(
      (q) => q.path === "/v3/refund/domestic/refunds" && q.method === "POST",
    ).length,
    before + 1,
  );
  const row = supplierRefunds.get(r.outRefundNo)!;
  Object.assign(row, { status: "ABNORMAL" });
  assert.equal((await refundCallback(row)).statusCode, 204);
  assert.equal(
    data(
      await request("GET", `/v1/orders/${p.orderId}/refunds`, p.buyer.token),
      200,
    ).reservedAmountFen,
    10000,
  );
  assert.equal(
    (
      await adminRequest("POST", `/${r.id}/reject`, {
        evidenceRef: "synthetic:operator-cannot-erase-submitted-money",
      })
    ).statusCode,
    409,
  );
  Object.assign(row, { status: "CLOSED" });
  assert.equal((await refundCallback(row)).statusCode, 204);
  const state = data(
    await request("GET", `/v1/orders/${p.orderId}/refunds`, p.buyer.token),
    200,
  );
  assert.equal(state.reservedAmountFen, 0);
  assert.equal(state.refundedAmountFen, 0);
  assert.equal(state.productionFrozen, false);
});
test("refund management requires permission and CSRF, validates payload and records denied attempts without financial mutation", async () => {
  const p = await project(),
    r = data(await open(p)),
    body = { amountFen: 99900, evidenceRef: "synthetic:approval" },
    restricted = await paymentAdmin(config, app, ["ops:read"]);
  assert.equal(
    (
      await adminRequest(
        "POST",
        `/${r.id}/approve`,
        body,
        randomUUID(),
        restricted,
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/v1/admin/refunds/${r.id}/approve`,
        headers: { cookie: admin.cookie, "idempotency-key": randomUUID() },
        payload: body,
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await adminRequest("POST", `/${r.id}/approve`, {
        ...body,
        state: "succeeded",
      })
    ).statusCode,
    400,
  );
  const view = data(
    await request("GET", `/v1/orders/${p.orderId}/refunds`, p.buyer.token),
    200,
  );
  assert.equal(view.reservedAmountFen, 0);
  assert.equal(view.refunds[0].state, "requested");
  const audit = data(
    await app.inject({ method: "GET", url: "/v1/admin/audit", headers: admin }),
    200,
  );
  assert.ok(
    audit.some(
      (a: { action: string; result: string }) =>
        a.action === "refund.approve" && a.result === "denied:400",
    ),
  );
});
test("approval blocks an otherwise authorized original handoff before any provider money is submitted", async () => {
  const p = await readyReservedFirstCopy(),
    h = await paymentAdmin(config, app, ["fulfillment:write"]),
    base = `/v1/admin/fulfillment/${p.order.id}`;
  const cmd = (path: string, body: object = {}) =>
    app.inject({
      method: "POST",
      url: base + path,
      headers: { ...h, "idempotency-key": randomUUID() },
      payload: body,
    });
  const attempt = data(
    await cmd("/attempts", {
      ...p.binding,
      supplierRef: "record:synthetic-provider",
      dueAt: new Date(Date.now() + 86400000).toISOString(),
    }),
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
        evidenceRef: "synthetic:grant-before-refund",
      },
    ),
  );
  const allowed = await app.inject({
    method: "GET",
    url: base + `/attempts/${attempt.id}/materials`,
    headers: h,
  });
  assert.equal(allowed.statusCode, 200);
  const r = data(
    await open(p, {
      reason: "platformUnableDeliver",
      evidenceRef: "synthetic:verified-platform-failure",
    }),
  );
  data(
    await adminRequest("POST", `/${r.id}/approve`, {
      amountFen: 99900,
      evidenceRef: "synthetic:approved-before-handoff",
      failureNotifiedAt: new Date().toISOString(),
    }),
  );
  assert.equal((await cmd(`/attempts/${attempt.id}/handoff`)).statusCode, 409);
  const context = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/first-copy`,
      p.buyer.token,
    ),
    200,
  );
  assert.ok(context.blockers.includes("PROJECT_FROZEN"));
  assert.equal(
    data(
      await request("GET", `/v1/orders/${p.orderId}/refunds`, p.buyer.token),
      200,
    ).reservedAmountFen,
    99900,
  );
});
