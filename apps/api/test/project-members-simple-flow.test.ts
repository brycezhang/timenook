import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  startBookFixture,
  stopBookFixture,
  project,
  login,
  request,
  data,
  sealedClip,
  app,
  db,
  config,
} from "./book-fixture";
import { paymentAdmin } from "./payment-admin-fixture";
import { ProductionTasks } from "../src/tasks/tasks";
import { TERMS_VERSION } from "../src/identity/project-members";

before(startBookFixture);
after(stopBookFixture);
test("project lists show the purchase title for owners and members, then prefer the renamed title", async () => {
  const p = await project(),
    member = await login(),
    outsider = await login();
  const base = `/v1/projects/${p.projectId}`;
  const invite = data(
    await request("POST", `${base}/invitations`, p.buyer.token),
  );
  const preview = data(
    await request("GET", `/v1/invitations/${invite.token}`),
    200,
  );
  assert.equal(
    preview.bookTitle,
    "私人标题不能泄露",
    "invitation uses the same purchased book title",
  );
  data(
    await request(
      "POST",
      `/v1/invitations/${invite.token}/accept`,
      member.token,
      {
        relationship: "家人",
        termsVersion: TERMS_VERSION,
      },
    ),
  );
  const list = async (token: string) =>
    data(await request("GET", "/v1/participations", token), 200).projects;
  for (const [user, category] of [
    [p.buyer, "sent"],
    [member, "participating"],
  ] as const) {
    assert.deepEqual(await list(user.token), [
      {
        projectId: p.projectId,
        bookTitle: "私人标题不能泄露",
        state: "active",
        categories: [category],
        isSelfGift: false,
        giverNickname: data(
          await request("GET", "/v1/users/me", p.buyer.token),
          200,
        ).nickname,
        giftRelationship: "恩师",
        storyCount: 0,
      },
    ]);
  }
  assert.deepEqual(await list(outsider.token), []);
  const renamed = data(
    await request("POST", `${base}/metadata`, member.token, {
      expectedVersion: 0,
      bookTitle: "妈妈亲手写下的时光故事",
    }),
  );
  for (const user of [p.buyer, member]) {
    assert.equal((await list(user.token))[0].bookTitle, renamed.bookTitle);
  }
  assert.equal(
    (await db.paymentOrder.findUniqueOrThrow({ where: { id: p.orderId } }))
      .bookTitle,
    "私人标题不能泄露",
  );
});
test("payer and multiple invited members can create, edit, preview and submit without old confirmations", async () => {
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
        title: "成员流程合成套餐",
        price: { value: 99900, unit: "fen", currency: "CNY" },
      },
    },
  });
  const p = await project(packageId),
    member = await login(),
    second = await login(),
    outsider = await login();
  const base = `/v1/projects/${p.projectId}`;
  assert.equal(
    (await request("GET", `${base}/overview`, outsider.token)).statusCode,
    403,
  );
  const invite = data(
    await request("POST", `${base}/invitations`, p.buyer.token),
  );
  for (const user of [member, second]) {
    data(
      await request(
        "POST",
        `/v1/invitations/${invite.token}/accept`,
        user.token,
        { relationship: "家人", termsVersion: TERMS_VERSION },
      ),
    );
    const state = data(
      await request("GET", `${base}/participation`, user.token),
      200,
    );
    assert.equal(state.canRead, true);
    assert.equal(state.canCollect, true);
    assert.equal(state.role, "member");
    assert.equal(state.canInvite, false);
  }
  assert.equal(
    await db.projectMember.count({ where: { projectId: p.projectId } }),
    2,
  );
  assert.equal(
    (await request("POST", `${base}/invitations`, member.token)).statusCode,
    403,
  );
  const own = data(
    await request("GET", `${base}/participation`, p.buyer.token),
    200,
  );
  assert.equal(own.canCollect, true);
  const plan = data(await request("GET", `${base}/plan`, second.token), 200);
  assert.equal(plan.subjectDecision, "member");
  const interview = data(
    await request("POST", `${base}/interviews`, member.token, {
      clientInterviewId: randomUUID(),
      expectedPlanRevision: plan.revision,
      starterKind: "free-narration",
    }),
  );
  await sealedClip({ ...p, narrator: member }, interview.id);
  // Upload commits the compose task and outbox atomically; no frontend organize call.
  let tasks = await db.productionTask.findMany({
    where: { projectId: p.projectId },
  });
  assert.ok(tasks.some((t) => t.kind === "compose_story"));
  for (let pass = 0; pass < 7; pass++) {
    await new Promise((resolve) => setTimeout(resolve, 1100));
    tasks = await db.productionTask.findMany({
      where: { projectId: p.projectId },
      orderBy: { createdAt: "asc" },
    });
    for (const task of tasks) await app.get(ProductionTasks).run(task.id);
  }
  const overview = data(
    await request("GET", `${base}/overview`, second.token),
    200,
  );
  const story = overview.stories[0];
  assert.ok(
    story.revision,
    JSON.stringify(
      tasks.map((t) => ({ kind: t.kind, state: t.state, error: t.errorCode })),
    ),
  );
  assert.equal(story.included, true);
  const unassigned = data(
    await request("GET", `${base}/book`, second.token),
    200,
  );
  assert.ok(
    unassigned.directory.chapters.every(
      (c: { storyRefs: string[] }) => !c.storyRefs.includes(story.id),
    ),
  );
  const outline = data(await request("GET", `${base}/plan`, second.token), 200);
  outline.chapters[0].storyRefs.push(story.id);
  data(
    await request("POST", `${base}/plan`, second.token, {
      expectedVersion: outline.revision,
      content: { chapters: outline.chapters, starters: outline.starters },
    }),
  );
  const book = data(await request("GET", `${base}/book`, second.token), 200);
  assert.ok(book.directory.chapters[0].storyRefs.includes(story.id));
  assert.ok(
    book.eligibleStories.some((s: { id: string }) => s.id === story.id),
  );
  const revised = data(
    await request(
      "POST",
      `${base}/stories/${story.id}/revisions`,
      second.token,
      {
        baseRevisionId: story.revision.id,
        expectedVersion: story.version,
        title: "成员修改的故事",
        theme: story.revision.theme,
        paragraphs: story.revision.paragraphs,
        notes: [],
        reviewResolutions: [],
      },
    ),
  );
  assert.equal(revised.revision.title, "成员修改的故事");
  const excluded = data(
    await request(
      "POST",
      `${base}/stories/${story.id}/inclusion`,
      member.token,
      { expectedVersion: revised.version, included: false },
    ),
  );
  assert.equal(excluded.included, false);
  const withoutStory = data(
    await request("GET", `${base}/book`, member.token),
    200,
  );
  assert.equal(
    withoutStory.directory.chapters.flatMap(
      (c: { storyRefs: string[] }) => c.storyRefs,
    ).length,
    0,
  );
  data(
    await request(
      "POST",
      `${base}/stories/${story.id}/inclusion`,
      member.token,
      { expectedVersion: excluded.version, included: true },
    ),
  );
  const restoredOutline = data(
    await request("GET", `${base}/plan`, second.token),
    200,
  );
  restoredOutline.chapters[0].storyRefs.push(story.id);
  data(
    await request("POST", `${base}/plan`, second.token, {
      expectedVersion: restoredOutline.revision,
      content: {
        chapters: restoredOutline.chapters,
        starters: restoredOutline.starters,
      },
    }),
  );
  const address = data(
    await request("POST", `${base}/first-copy/address`, second.token, {
      expectedVersion: 0,
      recipientName: "测试收件人",
      phone: "13800000000",
      regionCode: "CN-110000",
      detail: "合成地址 1 号",
    }),
  );
  assert.equal(address.address.value.recipientName, "测试收件人");
  const buyerAddress = data(
    await request("GET", `${base}/first-copy`, p.buyer.token),
    200,
  );
  assert.equal(buyerAddress.address.hash, address.address.hash);
  assert.ok(!buyerAddress.blockers.includes("NARRATOR_CONFIRMATION_REQUIRED"));
  assert.ok(!buyerAddress.blockers.includes("INITIATOR_CONFIRMATION_REQUIRED"));
  const currentBook = data(
    await request("GET", `${base}/book`, member.token),
    200,
  );
  const generated = data(
    await request("POST", `${base}/book/versions`, member.token, {
      expectedInputHash: currentBook.inputHash,
    }),
    202,
  );
  for (let n = 0; n < 3; n++)
    await app.get(ProductionTasks).run(generated.task.id);
  const ready = data(
    await request("GET", `${base}/book/versions/${generated.id}`, second.token),
    200,
  );
  assert.equal(ready.state, "ready", JSON.stringify(ready));
  assert.ok(ready.pdf.sha256);
  assert.equal(
    (
      await request(
        "GET",
        `${base}/book/versions/${generated.id}`,
        outsider.token,
      )
    ).statusCode,
    403,
  );
  const printable = data(
    await request("GET", `${base}/first-copy`, member.token),
    200,
  );
  assert.equal(printable.canSubmit, true, JSON.stringify(printable.blockers));
  const binding = {
    bookVersionId: ready.id,
    snapshotHash: ready.snapshotHash,
    pdfHash: ready.pdf.sha256,
    addressHash: address.address.hash,
  };
  const [one, two] = await Promise.all([
    request("POST", `${base}/first-copy/submit`, member.token, binding),
    request("POST", `${base}/first-copy/submit`, second.token, binding),
  ]);
  assert.equal(data(one).production.id, data(two).production.id);
  assert.equal(
    await db.firstCopyOrder.count({ where: { projectId: p.projectId } }),
    1,
  );
  const submitted = await db.firstCopyOrder.findFirstOrThrow({
    where: { projectId: p.projectId },
  });
  assert.equal(submitted.narratorConfirmationId, null);
  assert.equal(submitted.initiatorConfirmationId, null);
  const operator = await paymentAdmin(config, app, [
    "fulfillment:write",
    "audit:read",
  ]);
  const adminBase = `/v1/admin/fulfillment/${submitted.id}`;
  const attemptView = data(
    await app.inject({
      method: "POST",
      url: adminBase + "/attempts",
      headers: { ...operator, "idempotency-key": randomUUID() },
      payload: {
        ...binding,
        supplierRef: "record:synthetic-provider",
        dueAt: new Date(Date.now() + 86400000).toISOString(),
      },
    }),
  );
  const materials = data(
    await app.inject({
      method: "GET",
      url: `${adminBase}/attempts/${attemptView.current.id}/materials`,
      headers: operator,
    }),
    200,
  );
  assert.equal(materials.pdf.sha256, ready.pdf.sha256);
  assert.equal(materials.address.recipientName, "测试收件人");
  assert.equal(materials.grantExpiresAt, null);
  assert.equal(
    await db.fulfillmentGrant.count({ where: { projectId: p.projectId } }),
    0,
  );
  const otherOperator = await paymentAdmin(config, app, [
    "fulfillment:write",
    "audit:read",
  ]);
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: `${adminBase}/attempts/${attemptView.current.id}/materials`,
        headers: otherOperator,
      })
    ).statusCode,
    403,
  );
  assert.equal(submitted.termsVersion, TERMS_VERSION);
  assert.ok(submitted.submittedBy);
  assert.equal(
    (
      await request(
        "POST",
        `${base}/first-copy/submit`,
        outsider.token,
        binding,
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (await request("POST", `${base}/consents`, member.token, {})).statusCode,
    404,
  );
  assert.equal(
    await db.termsAcceptance.count({
      where: {
        version: TERMS_VERSION,
        userId: { in: [p.buyer.id, member.id, second.id, outsider.id] },
      },
    }),
    4,
  );
});
