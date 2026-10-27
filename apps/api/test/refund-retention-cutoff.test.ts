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
  bound,
  interview,
  request,
  data,
  choose,
} from "./book-fixture";
import { paymentAdmin } from "./payment-admin-fixture";
import {
  refundFault,
  supplierRefunds,
  paymentRequests,
} from "./payment-fixture";
import { ProjectServiceTerms } from "../src/projects/service-terms";
import { Deletions } from "../src/care/deletions";

let admin: Record<string, string>;
before(async () => {
  await startBookFixture();
  // Only this isolated fixture's physical scanner is stopped. Logical deadlines
  // still come from its actual purchased policy and original delivery fact.
  await app.get(Deletions).onModuleDestroy();
  admin = await paymentAdmin(config, app, ["care:write", "audit:read"]);
});
after(stopBookFixture);

async function soldProject(activeDays: number) {
  const snapshot = JSON.parse(
    readFileSync("test/fixtures/catalog-synthetic.json", "utf8"),
  );
  snapshot.admission.d03.retention.activeData.duration.value = activeDays;
  const draftId = randomUUID(),
    versionId = randomUUID();
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
        title: "合成原截止核验",
        price: { value: 99900, unit: "fen", currency: "CNY" },
      },
    },
  });
  const p = await bound(versionId);
  await interview(p, false);
  return p;
}
async function delivered(
  p: Awaited<ReturnType<typeof soldProject>>,
  anchor: Date,
) {
  const terms = new ProjectServiceTerms(config.databaseUrl);
  try {
    await terms.recordFact({
      projectId: p.projectId,
      eventId: "synthetic-cutoff-" + randomUUID(),
      kind: "delivery_completed",
      occurredAt: anchor,
    });
    return Date.parse(
      (await terms.read(p.projectId)).retention!.activeData.expiresAt!,
    );
  } finally {
    await terms.close();
  }
}
async function extendSessions(cutoff: number) {
  const expiresAt = new Date(cutoff + 86400000);
  await db.session.updateMany({ data: { expiresAt } });
  await db.adminSession.updateMany({ data: { expiresAt } });
}
async function noScan(projectId: string) {
  const [{ n }] = await db.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) n FROM privacy_deletions WHERE project_id=${projectId}::uuid`;
  assert.equal(n, 0n, "no deletion event has been published by a scan");
}
const body = {
  reason: "usedNotProduced",
  evidenceRef: "synthetic:原截止前退款私人说明",
};
const adminRefund = (
  id: string,
  path = "",
  payload?: object,
  key = randomUUID(),
) =>
  app.inject({
    method: payload ? "POST" : "GET",
    url: `/v1/admin/refunds/${id}${path}`,
    headers: { ...admin, "idempotency-key": key },
    ...(payload ? { payload } : {}),
  });

test("purchased activeData cutoff masks refund evidence and stops new payload before any scan while money and original-number retries continue", async (t) => {
  const p = await soldProject(1),
    control = await soldProject(20),
    url = `/v1/orders/${p.orderId}/refunds`,
    key = randomUUID();
  const old = data(await request("POST", url, p.buyer.token, body, key));
  const anchor = new Date(),
    cutoff = await delivered(p, anchor);
  await delivered(control, anchor);
  await extendSessions(cutoff);
  t.mock.timers.enable({ apis: ["Date"], now: cutoff - 1 });
  try {
    assert.equal(
      data(await adminRefund(old.id), 200).requestDescription,
      "原截止前退款私人说明",
    );
    assert.equal(
      data(await request("GET", url, p.buyer.token), 200).refunds[0]
        .requestDescription,
      "原截止前退款私人说明",
    );
    t.mock.timers.tick(1);
    await noScan(p.projectId);
    assert.equal(
      (
        await request(
          "GET",
          `/v1/projects/${p.projectId}/plan`,
          p.narrator.token,
        )
      ).statusCode,
      403,
    );
    const marker = "资料已删除；仅保留退款事实";
    assert.equal(
      data(await request("GET", url, p.buyer.token), 200).refunds[0]
        .requestDescription,
      marker,
    );
    assert.equal(
      data(await adminRefund(old.id), 200).requestDescription,
      marker,
    );
    const replay = data(await request("POST", url, p.buyer.token, body, key));
    assert.equal(replay.id, old.id);
    assert.equal(replay.requestDescription, marker);
    // Existing bytes may await physical cleanup; they must not reach a view.
    assert.equal(
      (await db.refund.findUniqueOrThrow({ where: { id: old.id } }))
        .evidenceRef,
      body.evidenceRef,
    );
    const newBody = {
        ...body,
        evidenceRef: "synthetic:截止时不得新增的私人说明",
      },
      newKey = randomUUID();
    const fresh = data(
      await request("POST", url, p.buyer.token, newBody, newKey),
    );
    assert.equal(
      (await db.refund.findUniqueOrThrow({ where: { id: fresh.id } }))
        .evidenceRef,
      null,
    );
    assert.equal(
      data(await request("POST", url, p.buyer.token, newBody, newKey)).id,
      fresh.id,
    );
    const approved = data(
      await adminRefund(fresh.id, "/approve", {
        amountFen: 70000,
        evidenceRef: "synthetic:截止时核验正文",
      }),
    );
    assert.equal(approved.amountFen, 70000);
    assert.equal(
      (await db.careRequest.findUniqueOrThrow({ where: { id: fresh.caseId } }))
        .verificationEvidence,
      null,
    );
    refundFault("timeout-before");
    assert.equal(
      data(await adminRefund(fresh.id, "/submit", {})).state,
      "unknown",
    );
    t.mock.timers.tick(1);
    assert.equal(
      data(await adminRefund(fresh.id, "/reconcile", {})).state,
      "unknown",
    );
    const reserved = data(await request("GET", url, p.buyer.token), 200);
    assert.equal(reserved.reservedAmountFen, 70000);
    assert.equal(reserved.productionFrozen, true);
    assert.equal(
      data(
        await adminRefund(old.id, "/reject", {
          evidenceRef: "synthetic:截止后拒绝正文",
        }),
      ).state,
      "rejected",
    );
    const live = data(
      await request(
        "POST",
        `/v1/orders/${control.orderId}/refunds`,
        control.buyer.token,
        body,
      ),
    );
    assert.equal(live.requestDescription, "原截止前退款私人说明");
    assert.equal(
      (await db.refund.findUniqueOrThrow({ where: { id: live.id } }))
        .evidenceRef,
      body.evidenceRef,
    );
    const posts = () =>
      paymentRequests.filter(
        (r) =>
          r.method === "POST" && r.body.out_refund_no === fresh.outRefundNo,
      ).length;
    assert.equal(posts(), 1);
    t.mock.timers.tick(10000);
    const retried = data(await adminRefund(fresh.id, "/submit", {}));
    assert.equal(retried.outRefundNo, fresh.outRefundNo);
    assert.equal(retried.state, "processing");
    assert.equal(posts(), 2);
    Object.assign(supplierRefunds.get(fresh.outRefundNo)!, {
      status: "SUCCESS",
      success_time: new Date().toISOString(),
    });
    assert.equal(
      data(await adminRefund(fresh.id, "/reconcile", {})).state,
      "succeeded",
    );
    assert.equal(
      data(await adminRefund(fresh.id, "/submit", {})).state,
      "succeeded",
    );
    assert.equal(posts(), 2);
    const money = data(await request("GET", url, p.buyer.token), 200);
    assert.equal(money.refundedAmountFen, 70000);
    assert.equal(money.reservedAmountFen, 0);
    for (const refundId of [old.id, fresh.id])
      assert.ok(
        (await db.refundCommand.findMany({ where: { refundId } })).every(
          (r) => r.payload === null,
        ),
      );
    await noScan(p.projectId);
  } finally {
    t.mock.timers.reset();
    refundFault("");
  }
});

for (const offset of [-1, 0, 1])
  test(`negative consent and care verification preserve rights with private evidence gated at sold cutoff ${offset}ms before any scan`, async (t) => {
    const p = await soldProject(1),
      cutoff = await delivered(p, new Date());
    await extendSessions(cutoff);
    t.mock.timers.enable({ apis: ["Date"], now: cutoff + offset });
    try {
      await noScan(p.projectId);
      const result = await choose(p, p.narrator.token, "collection", false),
        refusal = data(result.response);
      const recorded = await db.consentRecord.findFirstOrThrow({
        where: {
          projectId: p.projectId,
          purpose: "collection",
          granted: false,
        },
      });
      assert.equal(
        recorded.evidenceRef,
        offset < 0 ? result.body.evidenceRef : null,
      );
      if (offset >= 0)
        assert.equal(
          (await choose(p, p.narrator.token, "collection", true)).response
            .statusCode,
          403,
        );
      await noScan(p.projectId);
      const kind = offset < 0 ? "correction" : "delete",
        care = data(
          await request(
            "POST",
            `/v1/projects/${p.projectId}/care-requests`,
            p.narrator.token,
            {
              kind,
              expectedBindingVersion: refusal.bindingVersion,
            },
          ),
        ),
        verify = {
          expectedBindingVersion: refusal.bindingVersion,
          expectedAccessEpoch: refusal.accessEpoch,
          noticeVersion: "synthetic-d08-v1",
          evidenceRef: "synthetic:原截止核验私人证据",
        },
        key = randomUUID();
      const verified = () =>
        app.inject({
          method: "POST",
          url: `/v1/admin/care-requests/${care.id}/verify`,
          headers: { ...admin, "idempotency-key": key },
          payload: verify,
        });
      data(await verified());
      data(await verified());
      const saved = await db.careRequest.findUniqueOrThrow({
        where: { id: care.id },
      });
      assert.equal(
        saved.verificationEvidence,
        offset < 0 ? verify.evidenceRef : null,
      );
      assert.equal(
        saved.verificationNotice,
        offset < 0 ? verify.noticeVersion : null,
      );
      if (offset >= 0) {
        const status = data(
          await request(
            "GET",
            `/v1/projects/${p.projectId}/deletion-status`,
            p.narrator.token,
          ),
          200,
        );
        assert.equal(status.permanentProjectDeletion, true);
        assert.equal(
          (
            await request(
              "POST",
              `/v1/projects/${p.projectId}/consents`,
              p.narrator.token,
              {
                ...result.body,
                granted: true,
                expectedAccessEpoch: status.accessEpoch,
              },
            )
          ).statusCode,
          403,
        );
      } else await noScan(p.projectId);
    } finally {
      t.mock.timers.reset();
    }
  });
