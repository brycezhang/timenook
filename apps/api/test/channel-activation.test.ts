import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  startBookFixture,
  stopBookFixture,
  login,
  request,
  data,
  db,
} from "./book-fixture";
import { verifiedPhone } from "./wechat-profile-fixture";
before(startBookFixture);
after(stopBookFixture);
async function gift(buyer: Awaited<ReturnType<typeof login>>) {
  const version = await db.packageVersion.findFirstOrThrow();
  const operator = await db.adminAccount.create({
    data: {
      id: randomUUID(),
      username: randomUUID(),
      realm: "local",
      permissions: [],
      disabled: true,
    },
  });
  return db.channelGift.create({
    data: {
      id: randomUUID(),
      internalNumber: randomUUID(),
      operatorId: operator.id,
      idempotencyKey: randomUUID(),
      requestHash: "0".repeat(64),
      buyerPhone: verifiedPhone("synthetic-timenook", buyer.who),
      buyerId: buyer.id,
      packageVersionId: version.id,
      packageSnapshot: version.snapshot!,
      packageTitle: "时光故事书",
      listAmount: 99900,
      associatedAt: new Date(),
    },
  });
}
test("buyer confirms one channel gift concurrently and resumes the same self book with one entitlement and unknown paid amount", async () => {
  const buyer = await login(),
    row = await gift(buyer);
  const command = {
    purchaseKind: "self",
    recipient: { typeCode: "self", relationshipLabel: "自己" },
    bookTitle: "我的故事",
  };
  assert.deepEqual(
    data(await request("GET", "/v1/participations", buyer.token), 200).projects,
    [],
  );
  const results = await Promise.all(
    Array.from({ length: 3 }, () =>
      request(
        "POST",
        `/v1/channel-gifts/${row.id}/activate`,
        buyer.token,
        command,
      ),
    ),
  );
  const first = data(results[0]);
  for (const result of results) assert.deepEqual(data(result), first);
  assert.ok(first.projectId);
  assert.ok(first.entitlementId);
  assert.equal(first.paidAmount, null);
  const projects = data(
    await request("GET", "/v1/participations", buyer.token),
    200,
  ).projects;
  assert.equal(projects.length, 1);
  assert.equal(projects[0].projectId, first.projectId);
  assert.deepEqual(projects[0].categories, ["sent", "received"]);
  assert.equal(
    (
      await request(
        "POST",
        `/v1/channel-gifts/${row.id}/activate`,
        buyer.token,
        { ...command, bookTitle: "另一书名" },
      )
    ).statusCode,
    409,
  );
  assert.equal(
    data(await request("GET", "/v1/channel-gifts/reminders", buyer.token), 200)
      .pendingCount,
    0,
  );
});
test("new gifts merge, handled reminders persist, gift issuance stops pending count and outsiders cannot activate", async () => {
  const buyer = await login(),
    other = await login(),
    a = await gift(buyer),
    b = await gift(buyer);
  const reminders = () =>
    request("GET", "/v1/channel-gifts/reminders", buyer.token).then((r) =>
      data(r, 200),
    );
  assert.equal((await reminders()).newCount, 2);
  data(
    await request("POST", "/v1/channel-gifts/reminders/handle", other.token, {
      ids: [a.id, b.id],
    }),
  );
  assert.equal((await reminders()).newCount, 2);
  data(
    await request("POST", "/v1/channel-gifts/reminders/handle", buyer.token, {
      ids: [a.id, b.id],
    }),
  );
  assert.equal((await reminders()).newCount, 0);
  assert.equal((await reminders()).pendingCount, 2);
  const command = {
    purchaseKind: "gift",
    recipient: { relationshipLabel: "爸爸" },
    bookTitle: "爸爸的故事",
  };
  assert.equal(
    (
      await request(
        "POST",
        `/v1/channel-gifts/${a.id}/activate`,
        other.token,
        command,
      )
    ).statusCode,
    404,
  );
  const result = data(
    await request(
      "POST",
      `/v1/channel-gifts/${a.id}/activate`,
      buyer.token,
      command,
    ),
  );
  assert.equal((await reminders()).pendingCount, 2);
  const order = data(
    await request("GET", `/v1/orders/${result.orderId}`, buyer.token),
    200,
  );
  assert.equal(order.provider, "channel");
  assert.equal(order.amount, null);
  assert.equal(order.project.entitlement.id, result.entitlementId);
  const production = data(
    await request(
      "GET",
      `/v1/projects/${result.projectId}/first-copy`,
      buyer.token,
    ),
    200,
  );
  assert.equal(production.payment.paidAmountFen, null);
  assert.ok(!production.blockers.includes("ENTITLEMENT_UNAVAILABLE"));
  const issued = data(
    await request(
      "POST",
      `/v1/projects/${result.projectId}/gift`,
      buyer.token,
      {
        recipientName: "爸爸",
        recipientPhone: verifiedPhone("synthetic-timenook", other.who),
      },
    ),
  );
  assert.equal((await reminders()).pendingCount, 1);
  assert.equal(
    data(
      await request(
        "GET",
        `/v1/projects/${result.projectId}/gift`,
        buyer.token,
      ),
      200,
    ).gift.token,
    issued.token,
  );
  const list = data(
    await request("GET", "/v1/channel-gifts", buyer.token),
    200,
  );
  assert.equal(list.length, 2);
  assert.equal(
    list.find((g: { id: string }) => g.id === a.id).projectId,
    result.projectId,
  );
});
