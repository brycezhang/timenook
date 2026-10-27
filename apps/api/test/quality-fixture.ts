import { randomUUID } from "node:crypto";
import { readyReservedFirstCopy } from "./first-copy-fixture";
import { app, config, data, request } from "./book-fixture";
import { paymentAdmin } from "./payment-admin-fixture";
export async function qualityAdmin() {
  return paymentAdmin(config, app, [
    "fulfillment:write",
    "care:write",
    "audit:read",
  ]);
}
export function adminRequest(
  method: "GET" | "POST",
  url: string,
  headers: Record<string, string>,
  payload?: object,
  key = randomUUID(),
) {
  return app.inject({
    method,
    url,
    headers: { ...headers, "idempotency-key": key },
    ...(payload ? { payload } : {}),
  });
}
export async function deliveredQualityOrder(
  retention: Record<string, number> = {},
) {
  const p = await readyReservedFirstCopy(retention),
    headers = await qualityAdmin(),
    base = `/v1/admin/fulfillment/${p.order.id}`;
  const view = data(
    await adminRequest("POST", base + "/attempts", headers, {
      ...p.binding,
      supplierRef: "record:synthetic-provider",
      dueAt: new Date(Date.now() + 86400000).toISOString(),
    }),
  );
  const attempt = view.current,
    attemptBase = `${base}/attempts/${attempt.id}`;
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
        evidenceRef: `synthetic:${randomUUID()}`,
      },
    ),
  );
  data(await adminRequest("POST", attemptBase + "/handoff", headers, {}));
  data(
    await adminRequest("POST", attemptBase + "/receipt", headers, {
      outcome: "accepted",
      evidenceRef: "synthetic:接单核验",
    }),
  );
  data(
    await adminRequest("POST", attemptBase + "/shipping", headers, {
      carrier: "合成物流",
      number: "SYNTHETICQUALITY",
      shippedAt: new Date().toISOString(),
      evidenceRef: "synthetic:承运核验",
      wechat: {
        handling: "implemented_and_verified",
        evidenceRef: "synthetic:微信发货",
        result: "recorded",
      },
    }),
  );
  const delivered = data(
    await adminRequest("POST", attemptBase + "/delivery", headers, {
      deliveredAt: new Date().toISOString(),
      evidenceRef: "synthetic:签收核验",
    }),
  );
  return {
    ...p,
    headers,
    base,
    attempt,
    attemptBase,
    delivered,
    qualityBase: `/v1/orders/${p.orderId}/quality-care`,
  };
}
export async function reviewedQualityOrder(
  mode: "original" | "revised" | "refund" = "original",
  retention: Record<string, number> = {},
) {
  const p = await deliveredQualityOrder(retention),
    created = data(
      await request("POST", p.qualityBase, p.buyer.token, {
        attemptId: p.attempt.id,
        reason: "qualityMissingPages",
        description: "合成原单质量核对说明",
      }),
    ),
    qualityAdminBase = `/v1/admin/quality/cases/${created.caseId}`;
  const assigned = data(
    await adminRequest("POST", qualityAdminBase + "/assign", p.headers, {
      expectedVersion: created.version,
      dueAt: new Date(Date.now() + 86400000).toISOString(),
      evidenceRef: "synthetic:按原D06日历确定实际截止",
    }),
  );
  const qualityAccess = {
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
      qualityAccess,
    ),
  );
  const quality = data(
    await adminRequest("POST", qualityAdminBase + "/review", p.headers, {
      expectedVersion: assigned.version,
      resolution: mode === "refund" ? "refund" : "reprint",
      ...(mode === "refund" ? {} : { mode }),
      evidenceRef: "synthetic:原D07及原印刷责任核验",
    }),
  );
  return { ...p, qualityAdminBase, quality, qualityAccess };
}
