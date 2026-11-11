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
import { app, readyStory, projectPhoto, config } from "./book-fixture";
import { readFileSync } from "node:fs";
import { ProductionTasks } from "../src/tasks/tasks";
import { paymentAdmin } from "./payment-admin-fixture";
import { Deletions } from "../src/care/deletions";

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
  const anotherBuyerSession = await login(p.buyer.who);
  const recovered = data(
    await request("GET", `${base}/gift`, anotherBuyerSession.token),
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

test("claim preserves the purchaser's prepared recordings, project photos, and frozen PDF for both members", async () => {
  const snapshot = JSON.parse(
    readFileSync("test/fixtures/catalog-synthetic.json", "utf8"),
  );
  snapshot.d01.minPages = 1;
  snapshot.d01.bleedMm = 0;
  const draftId = randomUUID(),
    packageId = randomUUID();
  await db.packageDraft.create({
    data: { id: draftId, realm: "local", ...snapshot },
  });
  await db.packageVersion.create({
    data: {
      id: packageId,
      realm: "local",
      purpose: "local_preview",
      draftId,
      draftRevision: 1,
      snapshot,
      publicOffer: {
        title: "赠礼素材合成套餐",
        price: { value: 99900, unit: "fen", currency: "CNY" },
      },
    },
  });
  const purchased = await project(packageId);
  const p = await readyStory({ ...purchased, narrator: purchased.buyer });
  const photo = await projectPhoto(p);
  const base = `/v1/projects/${p.projectId}`;
  const before = data(
    await request("GET", `${base}/participation`, p.buyer.token),
    200,
  );
  const context = data(
    await request("GET", `${base}/book`, p.buyer.token),
    200,
  );
  const book = data(
    await request("POST", `${base}/book/versions`, p.buyer.token, {
      expectedInputHash: context.inputHash,
    }),
    202,
  );
  await app.get(ProductionTasks).run(book.task.id);
  const bookStatus = data(
    await request("GET", `${base}/book/versions/${book.id}`, p.buyer.token),
    200,
  );
  assert.equal(bookStatus.state, "ready", JSON.stringify(bookStatus.task));
  const pdfPath = `${base}/book/versions/${book.id}/pdf`;
  const pdfBefore = await request("GET", pdfPath, p.buyer.token);
  assert.equal(pdfBefore.statusCode, 200, pdfBefore.body);
  const clips = data(
    await request("GET", `${base}/interviews/${p.interviewId}`, p.buyer.token),
    200,
  );
  const clipPath = `${base}/interviews/${p.interviewId}/clips/${clips.clips[0].id}/content`;
  const audioBefore = await request("GET", clipPath, p.buyer.token);
  assert.equal(audioBefore.statusCode, 200);
  const photoPath = `${base}/photos/${photo.id}/assets/${photo.assets.find((a: { kind: string }) => a.kind === "original").id}/content`;
  const photoBefore = await request("GET", photoPath, p.buyer.token);
  assert.equal(photoBefore.statusCode, 200);
  const recipient = await login();
  const card = data(
    await request("POST", `${base}/gift`, p.buyer.token, {
      recipientName: "恩师",
      recipientPhone: verifiedPhone("synthetic-timenook", recipient.who),
    }),
  );
  data(
    await request("POST", `/v1/gifts/${card.token}/claim`, recipient.token, {
      termsVersion: USER_TERMS_VERSION,
    }),
  );
  for (const member of [p.buyer, recipient]) {
    const after = data(
      await request("GET", `${base}/participation`, member.token),
      200,
    );
    assert.equal(after.accessEpoch, before.accessEpoch);
    assert.equal(after.bindingVersion, before.bindingVersion);
    for (const [path, prior] of [
      [clipPath, audioBefore],
      [photoPath, photoBefore],
      [pdfPath, pdfBefore],
    ] as const) {
      const response = await request("GET", path, member.token);
      assert.equal(response.statusCode, 200, path);
      assert.deepEqual(
        response.rawPayload,
        prior.rawPayload,
        "claim keeps the original prepared material usable",
      );
    }
  }
  const originalOrder = data(
    await request("GET", `/v1/orders/${p.orderId}`, p.buyer.token),
    200,
  );
  assert.equal(originalOrder.project.id, p.projectId);
  assert.equal(
    await db.firstCopyEntitlement.count({ where: { projectId: p.projectId } }),
    1,
  );
  assert.equal(await db.project.count({ where: { orderId: p.orderId } }), 1);
});

test("verified project erasure clears gift phone, name, card secret and claimant identity and prevents restoration", async () => {
  const p = await project(),
    recipient = await login();
  const base = `/v1/projects/${p.projectId}`;
  const card = data(
    await request("POST", `${base}/gift`, p.buyer.token, {
      recipientName: "私人收礼人",
      recipientPhone: verifiedPhone("synthetic-timenook", recipient.who),
    }),
  );
  data(
    await request("POST", `/v1/gifts/${card.token}/claim`, recipient.token, {
      termsVersion: USER_TERMS_VERSION,
    }),
  );
  const state = data(
    await request("GET", `${base}/participation`, recipient.token),
    200,
  );
  const opened = data(
    await request("POST", `${base}/care-requests`, recipient.token, {
      kind: "delete",
      expectedBindingVersion: state.bindingVersion,
    }),
  );
  const headers = await paymentAdmin(config, app, ["care:write", "audit:read"]);
  data(
    await app.inject({
      method: "POST",
      url: `/v1/admin/care-requests/${opened.id}/verify`,
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: {
        expectedBindingVersion: state.bindingVersion,
        expectedAccessEpoch: state.accessEpoch,
        noticeVersion: "synthetic-d08-v1",
        evidenceRef: "synthetic:赠礼删除核验",
      },
    }),
  );
  await app.get(Deletions).reconcile(p.projectId);
  const row = await db.projectGift.findUniqueOrThrow({
    where: { projectId: p.projectId },
  });
  for (const field of [
    "recipientName",
    "recipientPhone",
    "token",
    "tokenHash",
    "claimedByUserId",
  ] as const)
    assert.equal(row[field], null, field);
  assert.equal(
    (await request("GET", `/v1/gifts/${card.token}`)).statusCode,
    404,
  );
  assert.equal(
    (await request("GET", `${base}/gift`, p.buyer.token)).statusCode,
    403,
  );
  await assert.rejects(
    db.projectGift.update({
      where: { projectId: p.projectId },
      data: { recipientName: "不能恢复" },
    }),
  );
});
