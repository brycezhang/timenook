import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { USER_TERMS_VERSION } from "@timenook/contracts";
import {
  startBookFixture,
  stopBookFixture,
  project,
  login,
  request,
  data,
  db,
  app,
  config,
} from "./book-fixture";
import { verifiedPhone } from "./wechat-profile-fixture";
import { callback, paid } from "./payment-fixture";
import { paymentAdmin } from "./payment-admin-fixture";

before(startBookFixture);
after(stopBookFixture);

test("family invitations require the narrator-perspective relationship, while the purchaser can use the project before supplying it", async () => {
  const p = await project(),
    member = await login(),
    outsider = await login();
  const base = `/v1/projects/${p.projectId}`;
  const profile = data(
    await request("GET", `${base}/member-profile`, p.buyer.token),
    200,
  );
  assert.equal(profile.relationship, null);
  assert.equal(profile.isNarrator, false);
  assert.equal(
    (await request("GET", `${base}/overview`, p.buyer.token)).statusCode,
    200,
  );
  assert.equal(
    (
      await request("POST", `${base}/member-profile`, outsider.token, {
        relationship: "女儿",
      })
    ).statusCode,
    403,
  );
  const invite = data(
    await request("POST", `${base}/invitations`, p.buyer.token),
  );
  assert.equal(
    (
      await request(
        "POST",
        `/v1/invitations/${invite.token}/accept`,
        member.token,
        { termsVersion: USER_TERMS_VERSION },
      )
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await request(
        "POST",
        `/v1/invitations/${invite.token}/accept`,
        member.token,
        { termsVersion: USER_TERMS_VERSION, relationship: "  " },
      )
    ).statusCode,
    400,
  );
  const joined = data(
    await request(
      "POST",
      `/v1/invitations/${invite.token}/accept`,
      member.token,
      { termsVersion: USER_TERMS_VERSION, relationship: "  外孙女  " },
    ),
  );
  assert.equal(joined.projectId, p.projectId);
  assert.equal(
    data(await request("GET", `${base}/member-profile`, member.token), 200)
      .relationship,
    "外孙女",
  );
  assert.equal(
    (await request("POST", `${base}/invitations`, member.token)).statusCode,
    403,
  );
  const buyer = data(
    await request("POST", `${base}/member-profile`, p.buyer.token, {
      relationship: "学生",
    }),
  );
  assert.equal(buyer.relationship, "学生");
  const list = data(
    await request("GET", "/v1/participations", member.token),
    200,
  ).projects;
  assert.deepEqual(list[0].categories, ["participating"]);
  assert.equal(list[0].giftRelationship, "恩师");
  assert.equal(list[0].isSelfGift, false);
  const operator = await paymentAdmin(config, app, ["care:write"]);
  const admin = await app.inject({
    method: "GET",
    url: `/v1/admin/users/${member.id}`,
    headers: operator,
  });
  assert.equal(admin.statusCode, 200, admin.body);
  assert.ok(
    admin
      .json()
      .data.projects.some((p: { id: string }) => p.id === joined.projectId),
  );
});

test("gift categories follow purchase, verified claim and invitation facts; self purchase opens the same project from sent and received", async () => {
  const p = await project(),
    recipient = await login(),
    family = await login();
  const list = async (token: string) =>
    data(await request("GET", "/v1/participations", token), 200).projects;
  const base = `/v1/projects/${p.projectId}`;
  data(
    await request("POST", "/v1/users/me/profile", p.buyer.token, {
      nickname: "赠礼者",
    }),
  );
  const gift = data(
    await request("POST", `${base}/gift`, p.buyer.token, {
      recipientName: "老师",
      recipientPhone: verifiedPhone("synthetic-timenook", recipient.who),
    }),
  );
  assert.deepEqual(await list(recipient.token), []);
  data(
    await request("POST", `/v1/gifts/${gift.token}/claim`, recipient.token, {
      termsVersion: USER_TERMS_VERSION,
    }),
  );
  const received = (await list(recipient.token))[0];
  assert.deepEqual(received.categories, ["received"]);
  assert.equal(received.giverNickname, "赠礼者");
  assert.equal(received.giftRelationship, "恩师");
  assert.equal(
    data(await request("GET", `${base}/member-profile`, recipient.token), 200)
      .relationship,
    "本人",
  );
  const invite = data(
    await request("POST", `${base}/invitations`, p.buyer.token),
  );
  data(
    await request(
      "POST",
      `/v1/invitations/${invite.token}/accept`,
      family.token,
      { termsVersion: USER_TERMS_VERSION, relationship: "女儿" },
    ),
  );
  assert.deepEqual((await list(family.token))[0].categories, ["participating"]);
  assert.deepEqual((await list(p.buyer.token))[0].categories, ["sent"]);

  const source = await db.paymentOrder.findUniqueOrThrow({
    where: { id: p.orderId },
  });
  const self = data(
    await request("POST", "/v1/orders", p.buyer.token, {
      packageVersionId: source.packageVersionId,
      purchaseKind: "self",
      bookTitle: "我的故事",
      recipient: { typeCode: "self", relationshipLabel: "自己" },
    }),
  );
  data(await request("POST", `/v1/orders/${self.id}/payment`, p.buyer.token));
  const event = await callback(paid(self.outTradeNo));
  const paidResponse = await app.inject({
    method: "POST",
    url: "/v1/webhooks/wechat-pay/payments",
    headers: { ...event.headers, "content-type": "application/json" },
    payload: event.body,
  });
  assert.equal(paidResponse.statusCode, 204, paidResponse.body);
  const paidSelf = data(
    await request("GET", `/v1/orders/${self.id}`, p.buyer.token),
    200,
  );
  const own = (await list(p.buyer.token)).filter(
    (row: { isSelfGift: boolean }) => row.isSelfGift,
  );
  assert.equal(own.length, 1);
  assert.deepEqual(own[0].categories, ["sent", "received"]);
  assert.equal(own[0].projectId, paidSelf.project.id);
  assert.equal(
    data(
      await request(
        "GET",
        `/v1/projects/${own[0].projectId}/member-profile`,
        p.buyer.token,
      ),
      200,
    ).relationship,
    "本人",
  );
});
