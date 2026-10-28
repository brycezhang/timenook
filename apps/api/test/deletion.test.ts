import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { randomUUID } from "node:crypto";
import {
  startBookFixture,
  stopBookFixture,
  bound,
  choose,
  request,
  data,
  app,
  config,
  db,
} from "./book-fixture";
import { paymentAdmin } from "./payment-admin-fixture";
import Redis from "ioredis";
import { Deletions } from "../src/care/deletions";
before(startBookFixture);
after(stopBookFixture);
test("verified deletion immediately denies all private use and exposes separate cleanup layers to current participants", async () => {
  const p = await bound();
  data((await choose(p, p.narrator.token, "collection", true)).response);
  const statusUrl = `/v1/projects/${p.projectId}/deletion-status`;
  assert.equal(
    data(await request("GET", statusUrl, p.narrator.token), 200)
      .onlineAccessStopped,
    false,
  );
  const current = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/participation`,
      p.narrator.token,
    ),
    200,
  );
  const opened = data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/care-requests`,
      p.narrator.token,
      { kind: "delete", expectedBindingVersion: current.bindingVersion },
    ),
  );
  const headers = await paymentAdmin(config, app, ["care:write", "audit:read"]);
  const verified = data(
    await app.inject({
      method: "POST",
      url: `/v1/admin/care-requests/${opened.id}/verify`,
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: {
        expectedBindingVersion: current.bindingVersion,
        expectedAccessEpoch: current.accessEpoch,
        noticeVersion: "synthetic-d08-v1",
        evidenceRef: "synthetic:删除核验",
      },
    }),
  );
  assert.equal(verified.currentAccessRevoked, true);
  const status = data(await request("GET", statusUrl, p.narrator.token), 200);
  assert.equal(status.permanentProjectDeletion, true);
  assert.equal(status.onlineAccessStopped, true);
  assert.ok(
    status.changes[0].items.some(
      (x: any) => x.layer === "backup" && x.state === "awaiting_evidence",
    ),
  );
  assert.ok(
    status.changes[0].items.some(
      (x: any) => x.layer === "supplier" && x.state === "awaiting_evidence",
    ),
  );
  assert.equal(
    (await request("GET", `/v1/projects/${p.projectId}/plan`, p.narrator.token))
      .statusCode,
    403,
  );
  assert.equal(
    (
      await request(
        "POST",
        `/v1/projects/${p.projectId}/consents`,
        p.narrator.token,
        {
          purpose: "collection",
          granted: true,
          expectedBindingVersion: current.bindingVersion,
          expectedAccessEpoch: status.accessEpoch,
          noticeVersion: "synthetic-d08-v1",
          evidenceRef: "synthetic:不得复活",
        },
      )
    ).statusCode,
    403,
  );
  const plan = await db.$queryRawUnsafe<any[]>(
    "SELECT content FROM plan_revisions WHERE project_id=$1::uuid",
    p.projectId,
  );
  assert.ok(plan.length > 0);
  assert.ok(plan.every((x) => x.content === null));
  const unrelated = await bound();
  data(
    (await choose(unrelated, unrelated.narrator.token, "collection", true))
      .response,
  );
  assert.equal(
    (
      await request(
        "GET",
        `/v1/projects/${unrelated.projectId}/plan`,
        unrelated.narrator.token,
      )
    ).statusCode,
    200,
  );
});
import { readyReservedFirstCopy } from "./first-copy-fixture";
import { ERASURE_REGISTRY } from "../src/care/erasure-registry";
import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { supplierRefunds } from "./payment-fixture";
import { interview, storyPhoto } from "./book-fixture";
async function eraseProject(p: Awaited<ReturnType<typeof bound>>) {
  const current = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/participation`,
      p.narrator.token,
    ),
    200,
  );
  const opened = data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/care-requests`,
      p.narrator.token,
      { kind: "delete", expectedBindingVersion: current.bindingVersion },
    ),
  );
  const headers = await paymentAdmin(config, app, ["care:write", "audit:read"]);
  data(
    await app.inject({
      method: "POST",
      url: `/v1/admin/care-requests/${opened.id}/verify`,
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: {
        expectedBindingVersion: current.bindingVersion,
        expectedAccessEpoch: current.accessEpoch,
        noticeVersion: "synthetic-d08-v1",
        evidenceRef: `synthetic:删除核验-${randomUUID()}`,
      },
    }),
  );
  return {
    opened,
    headers,
    status: data(
      await request(
        "GET",
        `/v1/projects/${p.projectId}/deletion-status`,
        p.narrator.token,
      ),
      200,
    ),
  };
}
test("all historical payloads and owned files disappear while minimum version and financial shells reject restoration", async (t) => {
  const p = await readyReservedFirstCopy();
  const photos = await storyPhoto(p, "合成删除照片私人说明");
  data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/interviews/${p.interviewId}/photos/${photos.entries[0].photoId}/crop`,
      p.narrator.token,
      {
        expectedRevision: photos.revision,
        left: 0,
        top: 0,
        width: 60,
        height: 40,
      },
    ),
  );
  assert.ok(
    (await db.photoAsset.count({ where: { projectId: p.projectId } })) >= 5,
  );
  const output = await db.bookOutput.findUniqueOrThrow({
    where: { bookId: p.book.id },
  });
  const pdf = join(config.books!.storageRoot, output.objectKey);
  assert.ok((await readFile(pdf)).length > 100);
  const original = await db.planRevision.findFirstOrThrow({
    where: { projectId: p.projectId },
  });
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 0 });
  t.after(() => redis.disconnect());
  const capabilities = async (projectId: string) => {
    const found: string[] = [];
    for (const kind of ["recording", "photo"]) {
      for (const key of await redis.keys(
        `${config.redisKeyPrefix}:${kind}:upload:*`,
      )) {
        const value = await redis.get(key);
        if (value && JSON.parse(value).projectId === projectId) found.push(key);
      }
    }
    return found;
  };
  const targetCaps = await capabilities(p.projectId);
  assert.ok(targetCaps.some((key) => key.includes(":recording:upload:")));
  assert.ok(targetCaps.some((key) => key.includes(":photo:upload:")));
  const lateCapability = await redis.get(targetCaps[0]);
  assert.ok(lateCapability);
  const control = await bound(),
    controlInterview = await interview(control, false);
  await sealedClip(control, controlInterview.id);
  const controlCaps = await capabilities(control.projectId);
  assert.ok(controlCaps.length > 0);
  const { status } = await eraseProject(p);
  assert.deepEqual(await capabilities(p.projectId), []);
  assert.deepEqual(await capabilities(control.projectId), controlCaps);
  await redis.set(targetCaps[0], lateCapability, "EX", 120);
  await app.get(Deletions).reconcile(p.projectId);
  assert.deepEqual(await capabilities(p.projectId), []);
  assert.deepEqual(await capabilities(control.projectId), controlCaps);
  const pending = status.changes
    .flatMap((e: any) => e.items)
    .filter(
      (i: any) =>
        ["active_database", "active_files", "cache"].includes(i.layer) &&
        i.state !== "completed",
    );
  assert.deepEqual(pending, []);
  for (const e of ERASURE_REGISTRY) {
    const [count] = await db.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM "${e.table}" r WHERE ${e.owner}=$1::uuid AND ${"filter" in e ? e.filter : "true"} AND (${e.columns.map((c) => `"${c}" IS NOT NULL`).join(" OR ")})`,
      p.projectId,
    );
    assert.equal(Number(count.n), 0, `${e.table}/${e.category} payload`);
  }
  await assert.rejects(access(pdf));
  await assert.rejects(
    db.$executeRaw`UPDATE plan_revisions SET content=${JSON.stringify(original.content)}::jsonb WHERE project_id=${p.projectId}::uuid`,
  );
  await assert.rejects(
    db.$executeRaw`UPDATE plan_revisions SET privacy_erased_columns='{}',content=${JSON.stringify(original.content)}::jsonb WHERE project_id=${p.projectId}::uuid`,
  );
  const order = await db.$queryRaw<
    { state: string; amount: number; address: null }[]
  >`SELECT p.state,p.amount,f.address FROM payment_orders p JOIN first_copy_orders f ON f.payment_order_id=p.id WHERE p.id=${p.orderId}::uuid`;
  assert.equal(order[0].state, "paid");
  assert.equal(order[0].amount, 99900);
  assert.equal(order[0].address, null);
  const shell = data(
    await request("GET", `/v1/orders/${p.orderId}`, p.buyer.token),
    200,
  );
  assert.equal(shell.state, "paid");
  assert.equal(shell.project, null);
  assert.equal(shell.materialsUnavailable, true);
});
test("deletion preserves a later synthetic refund request, reservation, reconciliation and minimum money facts without new private evidence", async () => {
  const p = await bound();
  await interview(p, false);
  await eraseProject(p);
  const body = {
    reason: "usedNotProduced",
    evidenceRef: "synthetic:删除之后的私人退款说明",
  };
  const opened = data(
    await request(
      "POST",
      `/v1/orders/${p.orderId}/refunds`,
      p.buyer.token,
      body,
    ),
  );
  const headers = await paymentAdmin(config, app, ["care:write", "audit:read"]);
  const admin = (path: string, payload: object) =>
    app.inject({
      method: "POST",
      url: `/v1/admin/refunds/${opened.id}${path}`,
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload,
    });
  const approved = data(
    await admin("/approve", {
      amountFen: 70000,
      evidenceRef: "synthetic:本人权益审核",
    }),
  );
  assert.equal(approved.amountFen, 70000);
  const pending = data(await admin("/submit", {}));
  assert.equal(pending.state, "processing");
  const supplier = supplierRefunds.get(opened.outRefundNo)!;
  Object.assign(supplier, {
    status: "SUCCESS",
    success_time: new Date().toISOString(),
  });
  assert.equal(data(await admin("/reconcile", {})).state, "succeeded");
  const money = data(
    await request("GET", `/v1/orders/${p.orderId}/refunds`, p.buyer.token),
    200,
  );
  assert.equal(money.refundedAmountFen, 70000);
  assert.equal(money.reservedAmountFen, 0);
  const [refund] = await db.$queryRaw<
    { evidence_ref: null; production_evidence: null }[]
  >`SELECT evidence_ref,production_evidence FROM refunds WHERE id=${opened.id}::uuid`;
  assert.equal(refund.evidence_ref, null);
  const commands = await db.$queryRaw<
    { payload: null }[]
  >`SELECT payload FROM refund_commands WHERE refund_id=${opened.id}::uuid`;
  assert.ok(commands.every((c) => c.payload === null));
});
import {
  interceptBookObjectCopy,
  sealedClip,
  readyStory,
} from "./book-fixture";
import { PrivacyJournal } from "../src/privacy-journal/privacy-journal";
test("random sealing ownership is durable before I/O and a provider write completed after deletion is swept by its exact captured target", async () => {
  const control = await readyStory(),
    p = await bound(),
    i = await interview(p, false);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((r) => (enter = r)),
    gate = new Promise<void>((r) => (release = r));
  let key = "",
    written = false;
  interceptBookObjectCopy(async (source, target, write) => {
    key = target;
    const owners = await db.$queryRaw<
      { object_keys: string[] }[]
    >`SELECT object_keys FROM privacy_owned_resources WHERE project_id=${p.projectId}::uuid`;
    assert.ok(
      owners.some(
        (o) => o.object_keys.includes(source) && o.object_keys.includes(target),
      ),
      "durable owner precedes the first server snapshot/copy",
    );
    enter();
    await gate;
    await write();
    assert.ok(
      (await readFile(join(config.recording!.storageRoot, "objects", target)))
        .length > 100,
    );
    written = true;
  });
  const sealing = sealedClip(p, i.id).then(
    () => false,
    () => true,
  );
  await entered;
  await eraseProject(p);
  const source = await new PrivacyJournal(config.privacyJournal!).snapshot(),
    event = source.events.find(
      (e) => e.projectId === p.projectId && e.kind === "deletion",
    )!;
  assert.ok((event.payload.targets as any[]).some((t) => t.key === key));
  release();
  assert.equal(await sealing, true);
  assert.equal(written, true);
  interceptBookObjectCopy();
  data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/deletion-status`,
      p.narrator.token,
    ),
    200,
  );
  await assert.rejects(
    readFile(join(config.recording!.storageRoot, "objects", key)),
  );
  assert.equal(
    await db.recordingAsset.count({ where: { projectId: p.projectId } }),
    0,
  );
  assert.equal(
    (
      await request(
        "GET",
        `/v1/projects/${control.projectId}/stories/${control.story.id}`,
        control.narrator.token,
      )
    ).statusCode,
    200,
  );
});
test("a committed tombstone also denies payload-only updates before a failed erase is retried, and matching another project row is rejected", async () => {
  const p = await bound(),
    control = await bound();
  data((await choose(p, p.narrator.token, "collection", true)).response);
  await db.paymentSubmission.upsert({
    where: { orderId: p.orderId },
    create: { orderId: p.orderId, parameters: { privateCapability: "old" } },
    update: { parameters: { privateCapability: "old" } },
  });
  await db.paymentSubmission.upsert({
    where: { orderId: control.orderId },
    create: {
      orderId: control.orderId,
      parameters: { privateCapability: "control" },
    },
    update: { parameters: { privateCapability: "control" } },
  });
  await db.$executeRawUnsafe(
    `CREATE FUNCTION hold_test_erasure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.parameters IS NULL THEN RAISE EXCEPTION 'synthetic I/O-like erasure failure'; END IF; RETURN NEW; END $$`,
  );
  await db.$executeRawUnsafe(
    `CREATE TRIGGER hold_test_erasure BEFORE UPDATE ON payment_submissions FOR EACH ROW EXECUTE FUNCTION hold_test_erasure()`,
  );
  const { opened, headers, status } = await eraseProject(p);
  assert.ok(
    status.changes
      .flatMap((e: any) => e.items)
      .some((i: any) => i.state === "pending"),
  );
  await assert.rejects(
    db.$executeRaw`UPDATE payment_submissions SET parameters='{"privateCapability":"resurrect"}'::jsonb WHERE order_id=${p.orderId}::uuid`,
  );
  await assert.rejects(
    db.$executeRaw`UPDATE payment_submissions SET parameters=NULL WHERE order_id=${p.orderId}::uuid`,
  );
  const event = status.changes[0].id;
  await db.$executeRaw`INSERT INTO privacy_deletion_items(id,event_id,project_id,category,layer,target_table,target_key,target_columns) VALUES(${randomUUID()}::uuid,${event}::uuid,${p.projectId}::uuid,'activeData','active_database','payment_submissions',${JSON.stringify({ order_id: control.orderId })}::jsonb,ARRAY['parameters'])`;
  await assert.rejects(
    db.$executeRaw`UPDATE payment_submissions SET parameters=NULL,privacy_erased_columns=ARRAY['parameters'] WHERE order_id=${control.orderId}::uuid`,
  );
  await db.$executeRawUnsafe(
    "DROP TRIGGER hold_test_erasure ON payment_submissions",
  );
  await db.$executeRawUnsafe("DROP FUNCTION hold_test_erasure()");
  const response = data(
    await app.inject({
      method: "POST",
      url: `/v1/admin/care-requests/${opened.id}/deletion/reconcile`,
      headers: { ...headers, "idempotency-key": randomUUID() },
    }),
  );
  assert.ok(
    response.changes
      .flatMap((e: any) => e.items)
      .some(
        (i: any) => i.layer === "active_database" && i.state === "completed",
      ),
  );
  const [other] = await db.$queryRaw<
    { parameters: unknown }[]
  >`SELECT parameters FROM payment_submissions WHERE order_id=${control.orderId}::uuid`;
  assert.deepEqual(other.parameters, { privateCapability: "control" });
});
