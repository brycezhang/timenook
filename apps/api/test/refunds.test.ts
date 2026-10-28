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
  interceptRefundExecution,
  setRefundInstant,
} from "./book-fixture";
import { paymentAdmin } from "./payment-admin-fixture";
import { readyReservedFirstCopy } from "./first-copy-fixture";
import { createApplication } from "../src/application";
import {
  supplierRefunds,
  refundFault,
  paymentRequests,
  callback,
  paymentConfig,
  paymentFetch,
  supplierOrders,
  interceptRefundQuery,
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

test("refund execution cannot send another merchant's persisted order to this merchant transport", async () => {
  const p = await project();
  const row = data(await open(p));
  data(
    await adminRequest("POST", `/${row.id}/approve`, {
      amountFen: 99900,
      evidenceRef: "synthetic:scope-review",
    }),
  );
  const foreign = await createApplication(
    {
      ...config,
      payments: { ...paymentConfig, merchantId: "synthetic-other-merchant" },
      participation: undefined,
      recording: undefined,
      books: undefined,
      photos: undefined,
      transcription: undefined,
      generation: undefined,
    },
    { paymentFetch },
  );
  const before = paymentRequests.length;
  try {
    assert.equal(
      (
        await foreign.inject({
          method: "POST",
          url: `/v1/admin/refunds/${row.id}/submit`,
          headers: { ...admin, "idempotency-key": randomUUID() },
          payload: {},
        })
      ).statusCode,
      404,
    );
    assert.equal(paymentRequests.length, before);
    assert.equal(
      (await db.refund.findUniqueOrThrow({ where: { id: row.id } })).state,
      "approved",
    );
  } finally {
    await foreign.close();
  }
});

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
    "https://synthetic.invalid/api/v1/webhooks/wechat-pay/refunds",
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
      failureNotifiedAt: new Date(Date.now() - 1000).toISOString(),
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
      failureNotifiedAt: new Date(Date.now() - 1000).toISOString(),
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
test("an approved refund rejected after submit preflight cannot spend the replacement refund reservation", async (t) => {
  const p = await project(),
    first = data(await open(p)),
    second = data(await open(p)),
    other = await paymentAdmin(config, app, ["care:write"]);
  const approval = {
    amountFen: 99900,
    evidenceRef: "synthetic:approved-reservation",
  };
  data(await adminRequest("POST", `/${first.id}/approve`, approval));
  let reached!: () => void, release!: () => void;
  const gated = new Promise<void>((resolve) => {
      reached = resolve;
    }),
    resume = new Promise<void>((resolve) => {
      release = resolve;
    });
  interceptRefundExecution(async (id) => {
    if (id === first.id) {
      reached();
      await resume;
    }
  });
  t.after(() => {
    release();
    interceptRefundExecution();
  });
  const before = paymentRequests.filter(
    (row) =>
      row.path === "/v3/refund/domestic/refunds" && row.method === "POST",
  ).length;
  const pending = adminRequest("POST", `/${first.id}/submit`, {});
  await gated;
  data(
    await adminRequest(
      "POST",
      `/${first.id}/reject`,
      { evidenceRef: "synthetic:rejected-before-final-claim" },
      randomUUID(),
      other,
    ),
  );
  data(
    await adminRequest(
      "POST",
      `/${second.id}/approve`,
      approval,
      randomUUID(),
      other,
    ),
  );
  release();
  const response = await pending;
  assert.equal(response.statusCode, 409, response.body);
  const state = data(
    await request("GET", `/v1/orders/${p.orderId}/refunds`, p.buyer.token),
    200,
  );
  assert.equal(state.reservedAmountFen, 99900);
  assert.equal(state.availableAmountFen, 0);
  assert.equal(
    state.refunds.find((row: { id: string }) => row.id === first.id).state,
    "rejected",
  );
  assert.equal(
    paymentRequests.filter(
      (row) =>
        row.path === "/v3/refund/domestic/refunds" && row.method === "POST",
    ).length,
    before,
  );
  assert.equal(supplierRefunds.has(first.outRefundNo), false);
});
async function refundWindow(p: Awaited<ReturnType<typeof project>>) {
  const order = data(
    await request("GET", `/v1/orders/${p.orderId}`, p.buyer.token),
    200,
  );
  const original = supplierOrders.get(order.outTradeNo)!;
  const paidAt = new Date(String(original.success_time));
  return { paidAt, expiresAt: new Date(paidAt.getTime() + 30 * 86400000) };
}
test("D07 refund applications use the half-open original request window before, exactly at and after its end", async (t) => {
  t.after(() => setRefundInstant());
  for (const offset of [-1, 0, 1]) {
    const p = await project(),
      window = await refundWindow(p),
      instant = new Date(window.expiresAt.getTime() + offset);
    setRefundInstant(instant);
    const r = data(await open(p));
    assert.equal(r.createdAt, instant.toISOString());
    const response = await adminRequest("POST", `/${r.id}/approve`, {
      amountFen: 99900,
      evidenceRef: "synthetic:request-window-boundary",
    });
    assert.equal(response.statusCode, offset < 0 ? 201 : 409, response.body);
  }
});
test("a timely D07 application can be verified and executed after its request window while its independent processing deadline never moves", async (t) => {
  t.after(() => setRefundInstant());
  const p = await project(),
    window = await refundWindow(p),
    requestedAt = new Date(window.expiresAt.getTime() - 1),
    requestKey = randomUUID();
  setRefundInstant(requestedAt);
  const r = data(await open(p, refundBody, requestKey));
  const verifiedAt = new Date(window.expiresAt.getTime() + 86400000);
  setRefundInstant(verifiedAt);
  assert.equal(
    data(await open(p, refundBody, requestKey)).createdAt,
    requestedAt.toISOString(),
  );
  const key = randomUUID(),
    body = {
      amountFen: 99900,
      evidenceRef: "synthetic:timely-request-late-verification",
    };
  const approved = data(
    await adminRequest("POST", `/${r.id}/approve`, body, key),
  );
  const dueAt = new Date(verifiedAt.getTime() + 7 * 86400000);
  assert.equal(approved.approvedAt, verifiedAt.toISOString());
  assert.equal(approved.dueAt, dueAt.toISOString());
  assert.equal(approved.requestWindowStartedAt, window.paidAt.toISOString());
  assert.equal(approved.requestWindowEndsAt, window.expiresAt.toISOString());
  for (const offset of [-1, 0, 1]) {
    setRefundInstant(new Date(dueAt.getTime() + offset));
    const state = data(
      await request("GET", `/v1/orders/${p.orderId}/refunds`, p.buyer.token),
      200,
    ).refunds.find((row: { id: string }) => row.id === r.id);
    assert.equal(state.processingState, offset < 0 ? "active" : "overdue");
    assert.equal(state.dueAt, dueAt.toISOString());
  }
  const repeated = data(
    await adminRequest("POST", `/${r.id}/approve`, body, key),
  );
  assert.equal(repeated.dueAt, dueAt.toISOString());
  const processing = data(await adminRequest("POST", `/${r.id}/submit`, {}));
  assert.equal(processing.state, "processing");
  assert.equal(processing.dueAt, dueAt.toISOString());
  assert.equal(processing.processingState, "overdue");
});
test("a verified closure while an original not-found query is in flight prevents another retry from spending replacement money", async (t) => {
  const p = await project(),
    first = data(await open(p)),
    second = data(await open(p)),
    approval = { amountFen: 99900, evidenceRef: "synthetic:fixed-policy" };
  data(await adminRequest("POST", `/${first.id}/approve`, approval));
  refundFault("timeout-before");
  assert.equal(
    data(await adminRequest("POST", `/${first.id}/submit`, {})).state,
    "unknown",
  );
  assert.equal(supplierRefunds.has(first.outRefundNo), false);
  const before = paymentRequests.filter(
    (row) =>
      row.path === "/v3/refund/domestic/refunds" && row.method === "POST",
  ).length;
  let reached!: () => void, release!: () => void;
  const gate = new Promise<void>((resolve) => {
      reached = resolve;
    }),
    resume = new Promise<void>((resolve) => {
      release = resolve;
    });
  interceptRefundQuery(async (no) => {
    if (no === first.outRefundNo) {
      reached();
      await resume;
    }
  });
  t.after(() => {
    release();
    interceptRefundQuery();
    setRefundInstant();
  });
  setRefundInstant(new Date(Date.now() + 20000));
  const pending = adminRequest("POST", `/${first.id}/submit`, {});
  await gate;
  const order = data(
      await request("GET", `/v1/orders/${p.orderId}`, p.buyer.token),
      200,
    ),
    original = supplierOrders.get(order.outTradeNo)!;
  assert.equal(
    (
      await refundCallback({
        out_trade_no: order.outTradeNo,
        out_refund_no: first.outRefundNo,
        transaction_id: original.transaction_id,
        refund_id: `synthetic-refund-${first.outRefundNo}`,
        status: "CLOSED",
        amount: { total: 99900, refund: 99900, currency: "CNY" },
      })
    ).statusCode,
    204,
  );
  const other = await paymentAdmin(config, app, ["care:write"]);
  data(
    await adminRequest(
      "POST",
      `/${second.id}/approve`,
      approval,
      randomUUID(),
      other,
    ),
  );
  release();
  const settled = data(await pending);
  assert.equal(settled.state, "closed");
  const state = data(
    await request("GET", `/v1/orders/${p.orderId}/refunds`, p.buyer.token),
    200,
  );
  assert.equal(state.reservedAmountFen, 99900);
  assert.equal(state.availableAmountFen, 0);
  assert.equal(
    paymentRequests.filter(
      (row) =>
        row.path === "/v3/refund/domestic/refunds" && row.method === "POST",
    ).length,
    before,
  );
});
test("refund clock and scheduling controls are unavailable outside isolated test construction", async () => {
  for (const environment of ["development", "production"] as const)
    await assert.rejects(
      () =>
        createApplication(
          { ...config, environment },
          { refundRuntime: { now: () => new Date() } },
        ),
      /Refund scheduling and clock overrides require isolated tests/,
    );
});

async function waitingBehind(blockers: number[], excluded: number[] = []) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const waiting = await db.$queryRaw<{ pid: number; blockers: number[] }[]>`
      SELECT pid, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock'`;
    const match = waiting.find(
      (row) =>
        !excluded.includes(row.pid) &&
        row.blockers.some((pid) => blockers.includes(pid)),
    );
    if (match) return match.pid;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Concurrent HTTP request did not reach its PostgreSQL lock");
}

test("a signed successful refund callback and the approving operator's reconciliation both complete while contending for the original order", async () => {
  setRefundInstant();
  const p = await project(),
    r = data(await open(p));
  data(
    await adminRequest("POST", `/${r.id}/approve`, {
      amountFen: 99900,
      evidenceRef: "synthetic:concurrent-original-refund",
    }),
  );
  data(await adminRequest("POST", `/${r.id}/submit`, {}));
  Object.assign(supplierRefunds.get(r.outRefundNo)!, {
    status: "SUCCESS",
    success_time: new Date().toISOString(),
  });
  let acquired!: (pid: number) => void, release!: () => void;
  const locked = new Promise<number>((resolve) => {
    acquired = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Only database scheduling is controlled. Callback and command outcomes are HTTP.
  const blocker = db.$transaction(
    async (tx) => {
      const [{ pid }] = await tx.$queryRaw<
        { pid: number }[]
      >`SELECT pg_backend_pid() AS pid`;
      await tx.$queryRaw`SELECT id FROM payment_orders WHERE id=${p.orderId}::uuid FOR UPDATE`;
      acquired(pid);
      await gate;
    },
    { timeout: 15000 },
  );
  let notification: ReturnType<typeof refundCallback> | undefined;
  let reconciliation:
    Promise<Awaited<ReturnType<typeof adminRequest>>> | undefined;
  try {
    const pid = await locked;
    notification = refundCallback(supplierRefunds.get(r.outRefundNo)!);
    const callbackPid = await waitingBehind([pid]);
    reconciliation = adminRequest("POST", `/${r.id}/reconcile`, {}).then(
      (response) => response,
    );
    await waitingBehind([pid, callbackPid], [callbackPid]);
    release();
    const [notice, result] = await Promise.all([notification, reconciliation]);
    assert.equal(notice.statusCode, 204, notice.body);
    assert.equal(result.statusCode, 201, result.body);
    assert.equal(result.json().data.state, "succeeded");
    const balance = data(
      await request("GET", `/v1/orders/${p.orderId}/refunds`, p.buyer.token),
      200,
    );
    assert.equal(balance.refundedAmountFen, 99900);
    assert.equal(balance.reservedAmountFen, 0);
  } finally {
    release();
    await blocker;
    await Promise.allSettled([notification, reconciliation].filter(Boolean));
  }
});

test("queued refund approval rechecks account disablement and permission revocation after acquiring authority", async (t) => {
  for (const change of ["disable", "revoke"] as const)
    await t.test(change, async () => {
      const headers = await paymentAdmin(config, app, ["care:write"]);
      const p = await project(),
        r = data(await open(p));
      const session = data(
        await app.inject({ method: "GET", url: "/v1/admin/session", headers }),
        200,
      );
      let acquired!: (pid: number) => void, release!: () => void;
      const locked = new Promise<number>((resolve) => {
        acquired = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const blocker = db.$transaction(
        async (tx) => {
          const [{ pid }] = await tx.$queryRaw<
            { pid: number }[]
          >`SELECT pg_backend_pid() AS pid`;
          await tx.$queryRaw`SELECT id FROM admin_accounts WHERE id=${session.operator.id}::uuid FOR UPDATE`;
          acquired(pid);
          await gate;
          await tx.adminAccount.update({
            where: { id: session.operator.id },
            data:
              change === "disable" ? { disabled: true } : { permissions: [] },
          });
        },
        { timeout: 15000 },
      );
      let pending:
        Promise<Awaited<ReturnType<typeof adminRequest>>> | undefined;
      try {
        const pid = await locked;
        pending = adminRequest(
          "POST",
          `/${r.id}/approve`,
          { amountFen: 99900, evidenceRef: "synthetic:queued-approval" },
          randomUUID(),
          headers,
        ).then((response) => response);
        await waitingBehind([pid]);
        release();
        await blocker;
        const rejected = await pending;
        assert.equal(
          rejected.statusCode,
          change === "disable" ? 401 : 403,
          rejected.body,
        );
        const balance = data(
          await request(
            "GET",
            `/v1/orders/${p.orderId}/refunds`,
            p.buyer.token,
          ),
          200,
        );
        assert.equal(balance.refunds[0].state, "requested");
        assert.equal(balance.refundedAmountFen, 0);
        assert.equal(balance.reservedAmountFen, 0);
      } finally {
        release();
        await blocker;
        await pending;
      }
    });
});
