import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import {
  startBookFixture,
  stopBookFixture,
  project,
  login,
  request,
  data,
  db,
} from "./book-fixture";
import { verifiedPhone } from "./wechat-profile-fixture";
import { USER_TERMS_VERSION } from "@timenook/contracts";
import { randomUUID } from "node:crypto";
import { callback, paid } from "./payment-fixture";
import { app } from "./book-fixture";

before(startBookFixture);
after(stopBookFixture);

test("a gift verifies the account phone, requires explicit acceptance, and opens the purchased project once", async () => {
  const p = await project(),
    recipient = await login(),
    wrong = await login();
  const recipientPhone = verifiedPhone("synthetic-timenook", recipient.who);
  const base = `/v1/projects/${p.projectId}`;
  const gift = data(
    await request("POST", `${base}/gift`, p.buyer.token, {
      recipientName: "爸爸",
      recipientPhone,
    }),
  );
  assert.equal(gift.version, 1);
  assert.equal(gift.state, "unclaimed");
  const recovered = data(
    await request("GET", `${base}/gift`, p.buyer.token),
    200,
  );
  assert.equal(
    recovered.gift.token,
    gift.token,
    "owner recovers the same current card without reissue",
  );
  assert.equal(
    (await request("GET", `${base}/gift`, recipient.token)).statusCode,
    403,
  );
  assert.equal((await request("GET", `${base}/gift`)).statusCode, 401);
  const card = `/v1/gifts/${gift.token}`;
  const preview = data(await request("GET", card), 200);
  assert.deepEqual(preview, {
    state: "unclaimed",
    bookTitle: "私人标题不能泄露",
    recipientName: "爸爸",
    maskedPhone: recipientPhone.slice(0, 3) + "****" + recipientPhone.slice(-4),
  });
  const mismatch = data(
    await request("GET", `${card}/verification`, wrong.token),
    200,
  );
  assert.equal(mismatch.state, "mismatch");
  assert.equal(mismatch.projectId, undefined);
  assert.equal(
    (
      await request("POST", `${card}/claim`, wrong.token, {
        termsVersion: USER_TERMS_VERSION,
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await request("POST", `${card}/claim`, wrong.token, {
        termsVersion: USER_TERMS_VERSION,
        recipientPhone,
      })
    ).statusCode,
    400,
  );
  const verified = data(
    await request("GET", `${card}/verification`, recipient.token),
    200,
  );
  assert.equal(verified.state, "ready");
  assert.equal(
    (await request("GET", `${base}/overview`, recipient.token)).statusCode,
    403,
    "verification alone does not join",
  );
  const claims = await Promise.all(
    Array.from({ length: 6 }, () =>
      request("POST", `${card}/claim`, recipient.token, {
        termsVersion: USER_TERMS_VERSION,
      }),
    ),
  );
  for (const r of claims) assert.equal(data(r).projectId, p.projectId);
  assert.equal(
    await db.projectMember.count({
      where: { projectId: p.projectId, userId: recipient.id },
    }),
    1,
  );
  assert.equal(
    (
      await db.projectSubject.findUniqueOrThrow({
        where: { projectId: p.projectId },
      })
    ).boundUserId,
    recipient.id,
  );
  assert.equal(
    (await request("GET", `${base}/overview`, recipient.token)).statusCode,
    200,
  );
  const reopened = data(
    await request("GET", `${card}/verification`, recipient.token),
    200,
  );
  assert.equal(reopened.state, "claimed");
  assert.equal(reopened.projectId, p.projectId);
  assert.equal(
    data(await request("GET", `${card}/verification`, wrong.token), 200)
      .projectId,
    undefined,
  );
  assert.equal(
    (
      await request("POST", `${base}/gift`, p.buyer.token, {
        recipientName: "爸爸",
        recipientPhone,
      })
    ).statusCode,
    409,
  );
});

test("only the purchaser can issue; correcting the phone invalidates the old card and self purchases cannot issue", async () => {
  const p = await project(),
    recipient = await login(),
    other = await login();
  const base = `/v1/projects/${p.projectId}/gift`;
  const command = {
    recipientName: "妈妈",
    recipientPhone: verifiedPhone("synthetic-timenook", recipient.who),
  };
  assert.equal(
    (await request("POST", base, other.token, command)).statusCode,
    403,
  );
  const old = data(
    await request("POST", base, p.buyer.token, {
      ...command,
      recipientPhone: verifiedPhone("synthetic-timenook", other.who),
    }),
  );
  const corrected = data(await request("POST", base, p.buyer.token, command));
  assert.equal(corrected.version, 2);
  assert.notEqual(corrected.token, old.token);
  for (const [method, path] of [
    ["GET", ""],
    ["GET", "/verification"],
    ["POST", "/claim"],
  ] as const)
    assert.equal(
      (
        await request(
          method,
          `/v1/gifts/${old.token}${path}`,
          other.token,
          method === "POST" ? { termsVersion: USER_TERMS_VERSION } : undefined,
        )
      ).statusCode,
      404,
    );
  assert.equal(
    data(
      await request(
        "GET",
        `/v1/gifts/${corrected.token}/verification`,
        recipient.token,
      ),
      200,
    ).state,
    "ready",
  );
  const orderSource = await db.paymentOrder.findUniqueOrThrow({
    where: { id: p.orderId },
  });
  const self = data(
    await request("POST", "/v1/orders", p.buyer.token, {
      packageVersionId: orderSource.packageVersionId,
      purchaseKind: "self",
      bookTitle: "自己的时光",
      recipient: { typeCode: "self", relationshipLabel: "自己" },
    }),
  );
  data(await request("POST", `/v1/orders/${self.id}/payment`, p.buyer.token));
  const event = await callback(paid(self.outTradeNo), randomUUID());
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/webhooks/wechat-pay/payments",
        headers: { ...event.headers, "content-type": "application/json" },
        payload: event.body,
      })
    ).statusCode,
    204,
  );
  const paidSelf = data(
    await request("GET", `/v1/orders/${self.id}`, p.buyer.token),
    200,
  );
  assert.equal(
    (
      await request(
        "POST",
        `/v1/projects/${paidSelf.project.id}/gift`,
        p.buyer.token,
        command,
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await request(
        "GET",
        `/v1/projects/${paidSelf.project.id}/gift`,
        p.buyer.token,
      )
    ).statusCode,
    403,
  );
});
