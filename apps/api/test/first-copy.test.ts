import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { randomUUID } from "node:crypto";
import {
  startBookFixture,
  stopBookFixture,
  joinedProject,
  request,
  data,
  login,
  app,
  db,
  config,
} from "./book-fixture";
import { readyFirstCopyBook } from "./first-copy-fixture";
import { paymentAdmin } from "./payment-admin-fixture";
before(startBookFixture);
after(stopBookFixture);
test("first-copy context uses the paid project and requires current private-content access", async () => {
  const p = await joinedProject();

  const url = `/v1/projects/${p.projectId}/first-copy`;
  assert.equal((await request("GET", url)).statusCode, 401);
  assert.equal(
    (await request("GET", url, (await login()).token)).statusCode,
    403,
  );
  const c = data(await request("GET", url, p.narrator.token), 200);
  assert.equal(c.role, "narrator");
  assert.deepEqual(c.payment, {
    paidAmountFen: 99900,
    currency: "CNY",
    copies: 1,
    amountDueFen: 0,
  });
  assert.equal(c.canSubmit, false);
  assert.ok(c.blockers.includes("BOOK_NOT_READY"));
  assert.deepEqual(
    c.shipping.terms.map((term: { key: string }) => term.key),
    [
      "print_specification",
      "creation_service",
      "shipping",
      "service.production",
      "service.logistics",
    ],
  );
});
test("only project members can version an address inside the purchased shipping range", async () => {
  const p = await joinedProject();

  const base = `/v1/projects/${p.projectId}/first-copy`;
  const body = {
    expectedVersion: 0,
    recipientName: "合成收件人",
    phone: "13800000000",
    regionCode: "CN-110000",
    detail: "合成地址一号",
  };
  assert.equal(
    (await request("POST", base + "/address", (await login()).token, body))
      .statusCode,
    403,
  );
  assert.equal(
    (
      await request("POST", base + "/address", p.buyer.token, {
        ...body,
        regionCode: "CN-810000",
      })
    ).statusCode,
    422,
  );
  const key = randomUUID();
  const c = data(
    await request("POST", base + "/address", p.buyer.token, body, key),
  );
  assert.equal(c.address.version, 1);
  assert.deepEqual(c.address.value, {
    recipientName: body.recipientName,
    phone: body.phone,
    regionCode: body.regionCode,
    detail: body.detail,
  });
  assert.equal(
    data(await request("POST", base + "/address", p.buyer.token, body, key))
      .address.hash,
    c.address.hash,
  );
  assert.equal(
    (
      await request(
        "POST",
        base + "/address",
        p.buyer.token,
        { ...body, detail: "其他" },
        key,
      )
    ).statusCode,
    409,
  );
  assert.deepEqual(
    data(await request("GET", base, p.narrator.token), 200).address.value,
    c.address.value,
  );
});

const addressBody = {
  expectedVersion: 0,
  recipientName: "合成收件人",
  phone: "13800000000",
  regionCode: "CN-110000",
  detail: "合成地址一号",
};
function confirmation(
  p: Awaited<ReturnType<typeof readyFirstCopyBook>>,
  role: string,
  addressHash?: string,
) {
  return {
    role,
    bookVersionId: p.book.id,
    snapshotHash: p.book.snapshotHash,
    pdfHash: p.book.pdf.sha256,
    ...(addressHash ? { addressHash } : {}),
    noticeVersion: "synthetic-d08-v1",
    evidenceRef: `synthetic:书稿确认-${randomUUID()}`,
  };
}

async function confirmedFirstCopy() {
  const p = await readyFirstCopyBook();
  const a = data(
    await request("POST", p.base + "/address", p.buyer.token, addressBody),
  );
  const c = a;
  const body = {
    bookVersionId: p.book.id,
    snapshotHash: p.book.snapshotHash,
    pdfHash: p.book.pdf.sha256,
    addressHash: c.address.hash,
  };
  return { ...p, body };
}
test("first-copy submission remains available beyond 2099 and retains one paid entitlement", async (t) => {
  const p = await confirmedFirstCopy();
  await db.session.updateMany({
    where: { userId: p.buyer.id },
    data: { expiresAt: new Date("2200-01-01T00:00:00Z") },
  });
  t.mock.timers.enable({
    apis: ["Date"],
    now: Date.parse("2100-01-01T00:00:00Z"),
  });
  try {
    const current = data(await request("GET", p.base, p.buyer.token), 200);
    assert.equal(current.creation.state, "active");
    assert.equal(current.creation.expiresAt, null);
    assert.equal(current.expiryReview, undefined);
    assert.equal(current.canSubmit, true);
    const saved = data(
      await request("POST", p.base + "/submit", p.buyer.token, p.body),
    );
    assert.equal(saved.production.state, "reserved");
    assert.equal(saved.production.copies, 1);
    assert.equal(saved.production.amountDueFen, 0);
  } finally {
    t.mock.timers.reset();
  }
});
test("concurrent same and distinct submission keys reserve exactly one first copy without another payment", async () => {
  const p = await confirmedFirstCopy();
  const key = randomUUID();
  const responses = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      request(
        "POST",
        p.base + "/submit",
        p.buyer.token,
        p.body,
        i < 4 ? key : randomUUID(),
      ),
    ),
  );
  const results = responses.map((r) => data(r));
  assert.equal(new Set(results.map((r) => r.production.id)).size, 1);
  assert.deepEqual(results[0].production, {
    id: results[0].production.id,
    state: "reserved",
    ...p.body,
    copies: 1,
    amountDueFen: 0,
  });
  assert.equal(
    data(await request("POST", p.base + "/submit", p.buyer.token, p.body, key))
      .production.id,
    results[0].production.id,
  );
  assert.equal(
    (
      await request(
        "POST",
        p.base + "/submit",
        p.buyer.token,
        { ...p.body, addressHash: "0".repeat(64) },
        key,
      )
    ).statusCode,
    409,
  );
  assert.equal(
    data(await request("GET", p.base, p.buyer.token), 200).production.id,
    results[0].production.id,
  );
});

test("admin approval rechecks the same current PDF and permissions rather than overriding a stale reservation", async () => {
  const p = await confirmedFirstCopy();
  const reserved = data(
    await request("POST", p.base + "/submit", p.buyer.token, p.body),
  ).production;
  const headers = await paymentAdmin(config, app, ["care:write"]);
  const url = `/v1/admin/first-copy/${reserved.id}/approve`;
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: p.body,
      })
    ).statusCode,
    403,
  );
  const allowed = await paymentAdmin(config, app, ["fulfillment:write"]);
  const result = await app.inject({
    method: "POST",
    url,
    headers: { ...allowed, "idempotency-key": randomUUID() },
    payload: p.body,
  });
  assert.equal(data(result).production.state, "approved");
  assert.deepEqual(Object.keys(data(result)).sort(), [
    "production",
    "projectId",
  ]);
  assert.ok(!result.body.includes("合成收件人"));
  assert.ok(!result.body.includes(p.story.revision.paragraphs[0].text));
  const changed = await request(
    "POST",
    `/v1/projects/${p.projectId}/stories/${p.story.id}/revisions`,
    p.narrator.token,
    {
      baseRevisionId: p.story.revision.id,
      expectedVersion: p.story.version,
      title: p.story.revision.title,
      theme: p.story.revision.theme,
      paragraphs: [
        { ...p.story.revision.paragraphs[0], text: "在线修改后的内容" },
      ],
      reviewResolutions: [],
      notes: [],
    },
  );
  data(changed);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url,
        headers: { ...allowed, "idempotency-key": randomUUID() },
        payload: p.body,
      })
    ).statusCode,
    409,
  );
});

test("a recovered paid label without a verified payment transaction cannot reserve the entitlement", async () => {
  const p = await confirmedFirstCopy();
  // Restore-damage fixture in this disposable schema; the HTTP boundary must fail closed.
  await db.paymentTransaction.delete({ where: { orderId: p.orderId } });
  const c = data(await request("GET", p.base, p.buyer.token), 200);
  assert.equal(c.payment.paidAmountFen, 0);
  assert.ok(c.blockers.includes("ENTITLEMENT_UNAVAILABLE"));
  assert.equal(
    (await request("POST", p.base + "/submit", p.buyer.token, p.body))
      .statusCode,
    409,
  );
  assert.equal(
    data(await request("GET", p.base, p.buyer.token), 200).production,
    null,
  );
});
test("a persisted Commerce freeze blocks initial reservation and administrator approval", async () => {
  const p = await confirmedFirstCopy();
  await db.firstCopyEntitlement.update({
    where: { projectId: p.projectId },
    data: { state: "suspended" },
  });
  assert.ok(
    data(await request("GET", p.base, p.buyer.token), 200).blockers.includes(
      "ENTITLEMENT_UNAVAILABLE",
    ),
  );
  assert.equal(
    (await request("POST", p.base + "/submit", p.buyer.token, p.body))
      .statusCode,
    409,
  );
  const q = await confirmedFirstCopy();
  const original = data(
    await request("POST", q.base + "/submit", q.buyer.token, q.body),
  );
  await db.firstCopyEntitlement.update({
    where: { projectId: q.projectId },
    data: { state: "revoked" },
  });
  const headers = await paymentAdmin(config, app, ["fulfillment:write"]);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/v1/admin/first-copy/${original.production.id}/approve`,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: q.body,
      })
    ).statusCode,
    409,
  );
});

test("first-copy addresses reject invalid mainland mobile numbers and replay a valid number", async () => {
  const p = await joinedProject();

  const base = `/v1/projects/${p.projectId}/first-copy`;
  for (const phone of [
    "      ",
    "------",
    "1380000000",
    "138000000000",
    "1380000000a",
    "23800000000",
  ]) {
    const response = await request("POST", base + "/address", p.buyer.token, {
      ...addressBody,
      phone,
    });
    assert.equal(
      response.statusCode,
      400,
      `invalid phone ${JSON.stringify(phone)}: ${response.body}`,
    );
  }
  const key = randomUUID();
  const saved = data(
    await request("POST", base + "/address", p.buyer.token, addressBody, key),
  );
  assert.equal(saved.address.value.phone, "13800000000");
  assert.equal(
    data(
      await request("POST", base + "/address", p.buyer.token, addressBody, key),
    ).address.hash,
    saved.address.hash,
  );
  assert.equal(
    data(await request("GET", base, p.buyer.token), 200).address.version,
    1,
  );
});

test("a stored invalid phone blocks first-copy submission and administrative approval", async () => {
  const p = await confirmedFirstCopy();
  // Disposable restore-damage fixtures keep the old binding while invalidating its stored address value.
  await db.firstCopyAddress.update({
    where: { projectId: p.projectId },
    data: { value: { ...addressBody, phone: "" } },
  });
  assert.equal(
    (await request("POST", p.base + "/submit", p.buyer.token, p.body))
      .statusCode,
    409,
  );
  assert.ok(
    data(await request("GET", p.base, p.buyer.token), 200).blockers.includes(
      "ADDRESS_REQUIRED",
    ),
  );
  const q = await confirmedFirstCopy();
  const reserved = data(
    await request("POST", q.base + "/submit", q.buyer.token, q.body),
  ).production;
  await db.firstCopyAddress.update({
    where: { projectId: q.projectId },
    data: { value: { ...addressBody, phone: "------" } },
  });
  const headers = await paymentAdmin(config, app, ["fulfillment:write"]);
  const response = await app.inject({
    method: "POST",
    url: `/v1/admin/first-copy/${reserved.id}/approve`,
    headers: { ...headers, "idempotency-key": randomUUID() },
    payload: q.body,
  });
  assert.equal(response.statusCode, 409);
  const current = data(await request("GET", q.base, q.buyer.token), 200);
  assert.equal(current.production.state, "reserved");
  assert.ok(current.blockers.includes("ADDRESS_REQUIRED"));
});
