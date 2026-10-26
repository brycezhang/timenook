import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  startBookFixture,
  stopBookFixture,
  bound,
  choose,
  request,
  data,
  login,
  readyStory,
  app,
  db,
  config,
} from "./book-fixture";
import { ProductionTasks } from "../src/tasks/tasks";
import { paymentAdmin } from "./payment-admin-fixture";
before(startBookFixture);
after(stopBookFixture);
test("first-copy context uses the paid project and requires current private-content access", async () => {
  const p = await bound();
  data((await choose(p, p.narrator.token, "collection", true)).response);
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
      "creation_window",
      "creation_expiration",
      "shipping",
      "service.production",
      "service.logistics",
    ],
  );
});
test("only the initiator can version an address inside the purchased shipping range", async () => {
  const p = await bound();
  data((await choose(p, p.narrator.token, "collection", true)).response);
  data((await choose(p, p.narrator.token, "sharing", true)).response);
  const base = `/v1/projects/${p.projectId}/first-copy`;
  const body = {
    expectedVersion: 0,
    recipientName: "合成收件人",
    phone: "13800000000",
    regionCode: "CN-110000",
    detail: "合成地址一号",
  };
  assert.equal(
    (await request("POST", base + "/address", p.narrator.token, body))
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
  assert.equal(
    data(await request("GET", base, p.narrator.token), 200).address.value,
    null,
  );
});

export async function readyFirstCopyBook(
  specification: {
    minPages?: number;
    maxPages?: number;
    bleedMm?: number;
  } = {},
) {
  const snapshot = JSON.parse(
    readFileSync("test/fixtures/catalog-synthetic.json", "utf8"),
  );
  snapshot.d01.minPages = 1;
  snapshot.d01.bleedMm = 0;
  Object.assign(snapshot.d01, specification);
  snapshot.admission.d02.duration.value = 1;
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
        title: "首本合成套餐",
        price: { value: 99900, unit: "fen", currency: "CNY" },
      },
    },
  });
  const p = await readyStory(await bound(packageId));
  const story = data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/stories/${p.story.id}/revisions`,
      p.narrator.token,
      {
        baseRevisionId: p.story.revision.id,
        expectedVersion: p.story.version,
        title: p.story.revision.title,
        theme: p.story.revision.theme,
        paragraphs: p.story.revision.paragraphs,
        reviewResolutions: p.story.revision.reviewItems.map((item: string) => ({
          item,
          reason: "本人核对",
        })),
        notes: [],
      },
    ),
  );
  data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/stories/${story.id}/decisions`,
      p.narrator.token,
      {
        revisionId: story.revision.id,
        expectedVersion: story.version,
        contentHash: story.revision.contentHash,
        confirmed: true,
        allowInBook: true,
        noticeVersion: "synthetic-d08-v1",
        evidenceRef: `synthetic:首本故事-${randomUUID()}`,
      },
    ),
  );
  const context = data(
    await request("GET", `/v1/projects/${p.projectId}/book`, p.narrator.token),
    200,
  );
  const book = data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/book/versions`,
      p.narrator.token,
      { expectedInputHash: context.inputHash },
    ),
    202,
  );
  await app.get(ProductionTasks).run(book.task.id);
  const base = `/v1/projects/${p.projectId}/first-copy`;
  const current = data(await request("GET", base, p.buyer.token), 200);
  assert.equal(current.book.state, "ready");
  return { ...p, story, base, book: current.book };
}
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
test("confirmations bind the same complete PDF and only address changes invalidate initiator approval", async () => {
  const p = await readyFirstCopyBook();
  const a = data(
    await request("POST", p.base + "/address", p.buyer.token, addressBody),
  );
  assert.equal(
    (
      await request(
        "POST",
        p.base + "/confirmations",
        p.buyer.token,
        confirmation(p, "narrator"),
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await request("POST", p.base + "/confirmations", p.narrator.token, {
        ...confirmation(p, "narrator"),
        pdfHash: "0".repeat(64),
      })
    ).statusCode,
    409,
  );
  const n = confirmation(p, "narrator"),
    key = randomUUID();
  assert.equal(
    data(
      await request(
        "POST",
        p.base + "/confirmations",
        p.narrator.token,
        n,
        key,
      ),
    ).confirmations.narrator,
    true,
  );
  assert.equal(
    data(
      await request(
        "POST",
        p.base + "/confirmations",
        p.narrator.token,
        n,
        key,
      ),
    ).confirmations.narrator,
    true,
  );
  const c = data(
    await request(
      "POST",
      p.base + "/confirmations",
      p.buyer.token,
      confirmation(p, "initiator", a.address.hash),
    ),
  );
  assert.equal(c.canSubmit, true, JSON.stringify(c.blockers));
  const changed = data(
    await request("POST", p.base + "/address", p.buyer.token, {
      ...addressBody,
      expectedVersion: 1,
      detail: "新地址",
    }),
  );
  assert.deepEqual(changed.confirmations, { narrator: true, initiator: false });
  assert.equal(changed.canSubmit, false);
});
async function confirmedFirstCopy() {
  const p = await readyFirstCopyBook();
  const a = data(
    await request("POST", p.base + "/address", p.buyer.token, addressBody),
  );
  data(
    await request(
      "POST",
      p.base + "/confirmations",
      p.narrator.token,
      confirmation(p, "narrator"),
    ),
  );
  const c = data(
    await request(
      "POST",
      p.base + "/confirmations",
      p.buyer.token,
      confirmation(p, "initiator", a.address.hash),
    ),
  );
  const body = {
    bookVersionId: p.book.id,
    snapshotHash: p.book.snapshotHash,
    pdfHash: p.book.pdf.sha256,
    addressHash: c.address.hash,
  };
  return { ...p, body };
}
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
test("exact creation expiry creates one shared manual-review case across concurrent attempts and never reserves or deletes", async (t) => {
  const p = await confirmedFirstCopy();
  const before = data(await request("GET", p.base, p.buyer.token), 200);
  const end = Date.parse(before.creation.expiresAt);
  t.mock.timers.enable({ apis: ["Date"], now: end - 1 });
  assert.equal(
    data(await request("GET", p.base, p.buyer.token), 200).canSubmit,
    true,
  );
  t.mock.timers.setTime(end);
  const attempts = await Promise.all(
    Array.from({ length: 5 }, () =>
      request("POST", p.base + "/expiry-review", p.buyer.token, {}),
    ),
  );
  const contexts = attempts.map((r) => data(r));
  assert.equal(new Set(contexts.map((c) => c.expiryReview.caseId)).size, 1);
  assert.ok(contexts[0].expiryReview.caseId);
  assert.equal(contexts[0].creation.state, "expired");
  assert.equal(contexts[0].production, null);
  assert.equal(contexts[0].expiryReview.available, false);
  t.mock.timers.setTime(end + 1);
  const submitted = data(
    await request("POST", p.base + "/submit", p.buyer.token, p.body),
  );
  assert.equal(submitted.production, null);
  assert.equal(submitted.expiryReview.caseId, contexts[0].expiryReview.caseId);
  assert.equal(
    data(
      await request(
        "GET",
        `/v1/projects/${p.projectId}/book/versions/${p.book.id}`,
        p.narrator.token,
      ),
      200,
    ).state,
    "ready",
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
    "expiryReview",
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
test("changing an address and changing it back cannot resurrect an old initiator confirmation", async () => {
  const p = await confirmedFirstCopy();
  data(
    await request("POST", p.base + "/address", p.buyer.token, {
      ...addressBody,
      expectedVersion: 1,
      detail: "修改后地址",
    }),
  );
  const back = data(
    await request("POST", p.base + "/address", p.buyer.token, {
      ...addressBody,
      expectedVersion: 2,
    }),
  );
  assert.equal(back.address.hash, p.body.addressHash);
  assert.equal(back.confirmations.narrator, true);
  assert.equal(back.confirmations.initiator, false);
});
test("an expired reservation cannot be approved or unlocked by unrelated subject-verification tools", async (t) => {
  const p = await confirmedFirstCopy();
  const original = data(
    await request("POST", p.base + "/submit", p.buyer.token, p.body),
  );
  t.mock.timers.enable({
    apis: ["Date"],
    now: Date.parse(original.creation.expiresAt),
  });
  const headers = await paymentAdmin(config, app, [
    "fulfillment:write",
    "care:write",
  ]);
  const attempted = data(
    await app.inject({
      method: "POST",
      url: `/v1/admin/first-copy/${original.production.id}/approve`,
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: p.body,
    }),
  );
  assert.equal(attempted.production.state, "reserved");
  assert.ok(attempted.expiryReview.caseId);
  const state = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/participation`,
      p.buyer.token,
    ),
    200,
  );
  const unrelated = await app.inject({
    method: "POST",
    url: `/v1/admin/care-requests/${attempted.expiryReview.caseId}/verify`,
    headers: { ...headers, "idempotency-key": randomUUID() },
    payload: {
      expectedBindingVersion: state.bindingVersion,
      expectedAccessEpoch: state.accessEpoch,
      noticeVersion: "synthetic-d08-v1",
      evidenceRef: `synthetic:不能以本人核验放行-${randomUUID()}`,
    },
  });
  assert.equal(unrelated.statusCode, 409);
  assert.equal(
    data(await request("GET", p.base, p.buyer.token), 200).production.state,
    "reserved",
  );
});

test("server rejects missing confirmations and unprintable purchased specifications", async () => {
  const p = await readyFirstCopyBook({ minPages: 100 });
  const a = data(
    await request("POST", p.base + "/address", p.buyer.token, addressBody),
  );
  const body = {
    bookVersionId: p.book.id,
    snapshotHash: p.book.snapshotHash,
    pdfHash: p.book.pdf.sha256,
    addressHash: a.address.hash,
  };
  assert.equal(
    (await request("POST", p.base + "/submit", p.buyer.token, body)).statusCode,
    409,
  );
  data(
    await request(
      "POST",
      p.base + "/confirmations",
      p.narrator.token,
      confirmation(p, "narrator"),
    ),
  );
  const c = data(
    await request(
      "POST",
      p.base + "/confirmations",
      p.buyer.token,
      confirmation(p, "initiator", a.address.hash),
    ),
  );
  assert.deepEqual(c.confirmations, { narrator: true, initiator: true });
  assert.ok(c.blockers.includes("SPECIFICATION_MISMATCH"));
  assert.equal(
    (await request("POST", p.base + "/submit", p.buyer.token, body)).statusCode,
    409,
  );
});
test("new story permission and a shared deletion request each prevent first-copy reservation", async () => {
  const p = await confirmedFirstCopy();
  data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/stories/${p.story.id}/decisions`,
      p.narrator.token,
      {
        revisionId: p.story.revision.id,
        expectedVersion: p.story.version,
        contentHash: p.story.revision.contentHash,
        confirmed: true,
        allowInBook: false,
        noticeVersion: "synthetic-d08-v1",
        evidenceRef: `synthetic:收回入书-${randomUUID()}`,
      },
    ),
  );
  const stale = data(await request("GET", p.base, p.buyer.token), 200);
  assert.equal(stale.book.state, "obsolete");
  assert.deepEqual(stale.confirmations, { narrator: false, initiator: false });
  assert.equal(
    (await request("POST", p.base + "/submit", p.buyer.token, p.body))
      .statusCode,
    409,
  );
  const q = await confirmedFirstCopy();
  const state = data(
    await request(
      "GET",
      `/v1/projects/${q.projectId}/participation`,
      q.narrator.token,
    ),
    200,
  );
  data(
    await request(
      "POST",
      `/v1/projects/${q.projectId}/care-requests`,
      q.narrator.token,
      {
        kind: "delete",
        expectedBindingVersion: state.bindingVersion,
      },
    ),
  );
  assert.ok(
    data(await request("GET", q.base, q.buyer.token), 200).blockers.includes(
      "PROJECT_FROZEN",
    ),
  );
  assert.equal(
    (await request("POST", q.base + "/submit", q.buyer.token, q.body))
      .statusCode,
    409,
  );
});
test("pause applies the purchased creation clock to submission and can be resumed only through service terms", async () => {
  const p = await confirmedFirstCopy(),
    headers = await paymentAdmin(config, app);
  const pause = (action: string) =>
    app.inject({
      method: "POST",
      url: `/v1/admin/service-terms/${p.projectId}/pause`,
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: { action, supportCaseRef: "record:synthetic-creation-pause" },
    });
  data(await pause("pause"));
  const c = data(await request("GET", p.base, p.buyer.token), 200);
  assert.equal(c.creation.state, "paused");
  assert.ok(c.blockers.includes("CREATION_PAUSED"));
  assert.equal(
    (await request("POST", p.base + "/submit", p.buyer.token, p.body))
      .statusCode,
    409,
  );
  data(await pause("resume"));
  assert.equal(
    data(await request("POST", p.base + "/submit", p.buyer.token, p.body))
      .production.state,
    "reserved",
  );
});
test("assisted book confirmation requires the dedicated current purpose and records fresh exact-version evidence", async () => {
  const p = await readyFirstCopyBook();
  const state = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/participation`,
      p.buyer.token,
    ),
    200,
  );
  const session = (purpose: string) =>
    request(
      "POST",
      `/v1/projects/${p.projectId}/assisted-sessions`,
      p.buyer.token,
      {
        purpose,
        granted: true,
        expectedBindingVersion: state.bindingVersion,
        expectedAccessEpoch: state.accessEpoch,
        noticeVersion: "synthetic-d08-v1",
        evidenceRef: `synthetic:当次协助-${randomUUID()}`,
      },
    );
  const wrong = data(await session("story_confirmation"));
  assert.equal(
    (
      await request("POST", p.base + "/confirmations", p.buyer.token, {
        ...confirmation(p, "narrator"),
        assistedSessionId: wrong.id,
      })
    ).statusCode,
    403,
  );
  const correct = data(await session("book_confirmation"));
  const body = {
    ...confirmation(p, "narrator"),
    assistedSessionId: correct.id,
  };
  assert.equal(
    data(await request("POST", p.base + "/confirmations", p.buyer.token, body))
      .confirmations.narrator,
    true,
  );
  assert.equal(
    (await request("POST", p.base + "/confirmations", p.buyer.token, body))
      .statusCode,
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
  const p = await bound();
  data((await choose(p, p.narrator.token, "collection", true)).response);
  data((await choose(p, p.narrator.token, "sharing", true)).response);
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
