import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { randomUUID } from "node:crypto";
import {
  startBookFixture,
  stopBookFixture,
  app,
  config,
  db,
  data,
  project,
} from "./book-fixture";
import {
  alternativeExport,
  adminRequest,
  alternativeWithdrawal,
  rebindExport,
  pausedZip,
  assistedExportChoice,
  largeExportSources,
  acceptAlternativeCase,
} from "./complete-export-fixture";
import { authenticateFeishu } from "./admin-feishu-fixture";
import { paymentAdmin } from "./payment-admin-fixture";
before(startBookFixture);
after(stopBookFixture);
async function relogin(p: Awaited<ReturnType<typeof alternativeExport>>) {
  const care = await db.careRequest.findUniqueOrThrow({
    where: { id: p.exp.id },
  });
  const admin = await db.adminAccount.findUniqueOrThrow({
    where: { id: care.verifiedBy! },
  });
  assert.ok(admin.feishuAppId && admin.feishuOpenId && admin.tenantKey);
  const auth = await authenticateFeishu(config, app, {
    ...admin,
    feishuAppId: admin.feishuAppId,
    feishuOpenId: admin.feishuOpenId,
    tenantKey: admin.tenantKey,
  });
  return {
    cookie: auth.cookie,
    origin: config.admin!.origin,
    "x-csrf-token": auth.csrf,
  };
}
async function verification(
  p: Awaited<ReturnType<typeof alternativeExport>>,
  expiresAt = new Date(Date.now() + 15 * 60000).toISOString(),
) {
  const subject = await db.projectSubject.findUniqueOrThrow({
    where: { projectId: p.projectId },
  });
  const project = await db.project.findUniqueOrThrow({
    where: { id: p.projectId },
  });
  return {
    expectedBindingVersion: subject.bindingVersion,
    expectedAccessEpoch: project.accessEpoch,
    purpose: "complete_export_delivery",
    noticeVersion: "synthetic-d08-v1",
    identityVerified: true,
    subjectConsented: true,
    identityProcedureRef: "record:subject-verification",
    confirmationChannelRef: "record:subject-confirmation",
    verificationRef: `record:synthetic-renewal-${randomUUID()}`,
    recipientRef: "synthetic:本人指定的替代接收人和渠道",
    expiresAt,
  };
}
async function explicitAlternativeAfterCollectionRefusal() {
  const p = await project();
  const collection = data(await assistedExportChoice(p, "collection", true));
  data(await assistedExportChoice(p, "ai", true));
  await largeExportSources(p.projectId, p.buyer.token, collection.id);
  data(await assistedExportChoice(p, "collection", false));
  const accepted = await acceptAlternativeCase(p);
  return {
    ...accepted,
    packed: data(
      await adminRequest("POST", accepted.base + "/pack", accepted.admin, {}),
    ),
  };
}
test("a completed alternative export requires fresh recorded subject verification after staff TTL; login and old grant replay cannot renew it", async (t) => {
  const p = await explicitAlternativeAfterCollectionRefusal();
  data(
    await adminRequest("POST", p.base + "/delivery", p.admin, {
      evidenceRef: "synthetic:实际交付",
    }),
  );
  const initial = data(await adminRequest("GET", p.base, p.admin), 200);
  assert.ok(initial.staffAccess.available);
  assert.equal(initial.expiresAt, null);
  const future = Date.now() + 8 * 86400000;
  t.mock.timers.enable({ apis: ["Date"], now: future });
  try {
    const headers = await relogin(p);
    assert.equal(
      (await adminRequest("GET", p.base + "/download", headers)).statusCode,
      403,
    );
    const accepted = await db.careExport.findUniqueOrThrow({
      where: { id: p.exp.id },
    });
    data(
      await adminRequest("POST", p.base + "/accept", headers, {
        dueAt: accepted.dueAt!.toISOString(),
        evidenceRef: "synthetic:替代交付处理日历和期限",
        recipientRef: "synthetic:本人指定的替代接收人和渠道",
      }),
    );
    assert.equal(
      (await adminRequest("GET", p.base + "/download", headers)).statusCode,
      403,
    );
    const body = await verification(p),
      key = randomUUID(),
      url = p.base + "/access-verification";
    for (const bad of [
      { subjectConsented: false },
      { identityVerified: false },
      { noticeVersion: "obsolete" },
      { purpose: "customer_login" },
      { identityProcedureRef: "record:unapproved" },
      { recipientRef: "synthetic:不同接收人" },
    ]) {
      const response = await adminRequest("POST", url, headers, {
        ...body,
        ...bad,
      });
      assert.ok([400, 403].includes(response.statusCode), response.body);
    }
    const other = await paymentAdmin(config, app, ["care:write"]);
    assert.equal(
      (await adminRequest("POST", url, other, body)).statusCode,
      403,
    );
    const grant = data(await adminRequest("POST", url, headers, body, key));
    const response = await adminRequest("GET", p.base + "/download", headers);
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["content-type"], "application/zip");
    assert.equal(
      (await db.careExport.findUniqueOrThrow({ where: { id: p.exp.id } }))
        .sha256,
      p.packed.sha256,
    );
    t.mock.timers.setTime(Date.parse(grant.expiresAt));
    assert.equal(
      (await adminRequest("GET", p.base + "/download", headers)).statusCode,
      403,
    );
    assert.deepEqual(
      data(await adminRequest("POST", url, headers, body, key)),
      grant,
    );
    assert.equal(
      (await adminRequest("GET", p.base + "/download", headers)).statusCode,
      403,
    );
    assert.equal(
      (
        await adminRequest(
          "POST",
          url,
          headers,
          { ...body, expiresAt: new Date(Date.now() + 60000).toISOString() },
          key,
        )
      ).statusCode,
      409,
    );
    assert.equal(
      (
        await adminRequest("POST", url, headers, {
          ...body,
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        })
      ).statusCode,
      409,
    );
    data(await adminRequest("POST", url, headers, await verification(p)));
    assert.equal(
      (await adminRequest("GET", p.base + "/download", headers)).statusCode,
      200,
    );
    assert.equal(
      (await adminRequest("GET", p.base + "/download", other)).statusCode,
      403,
    );
  } finally {
    t.mock.timers.reset();
  }
});
test("new subject withdrawal permanently invalidates the old staff authorization and cannot be renewed from the old case", async () => {
  const p = await alternativeExport();
  const body = await verification(p),
    key = randomUUID();
  data(
    await adminRequest(
      "POST",
      p.base + "/access-verification",
      p.admin,
      body,
      key,
    ),
  );
  await alternativeWithdrawal(p);
  assert.equal(
    (await adminRequest("GET", p.base + "/download", p.admin)).statusCode,
    403,
  );
  assert.equal(
    (
      await adminRequest(
        "POST",
        p.base + "/access-verification",
        p.admin,
        body,
        key,
      )
    ).statusCode,
    403,
  );
});
test("subject rebinding rejects both staff grant replay and download", async () => {
  const p = await alternativeExport(),
    body = await verification(p),
    key = randomUUID();
  data(
    await adminRequest(
      "POST",
      p.base + "/access-verification",
      p.admin,
      body,
      key,
    ),
  );
  await rebindExport({ ...p, url: p.base + "/download", headers: p.admin });
  assert.equal(
    (await adminRequest("GET", p.base + "/download", p.admin)).statusCode,
    403,
  );
  assert.equal(
    (
      await adminRequest(
        "POST",
        p.base + "/access-verification",
        p.admin,
        body,
        key,
      )
    ).statusCode,
    403,
  );
});
test("a backpressured alternative ZIP stream stops exactly when its captured staff grant expires", async (t) => {
  const p = await alternativeExport(),
    end = Date.now() + 60000;
  data(
    await adminRequest(
      "POST",
      p.base + "/access-verification",
      p.admin,
      await verification(p, new Date(end).toISOString()),
    ),
  );
  const stream = await pausedZip(p.base + "/download", p.admin);
  try {
    assert.equal(
      Number(stream.response.headers["content-length"]),
      p.packed.bytes,
    );
    t.mock.timers.enable({ apis: ["Date"], now: end });
    const received = await stream.finish();
    assert.equal(received.completed, false);
    assert.ok(received.bytes.length < p.packed.bytes);
    assert.equal(
      (await adminRequest("GET", p.base + "/download", p.admin)).statusCode,
      403,
    );
  } finally {
    stream.response.destroy();
    t.mock.timers.reset();
  }
});

test("renewing staff access never transfers an already started ZIP stream to the new grant", async () => {
  const p = await alternativeExport();
  const stream = await pausedZip(p.base + "/download", p.admin);
  try {
    data(
      await adminRequest(
        "POST",
        p.base + "/access-verification",
        p.admin,
        await verification(p),
      ),
    );
    const received = await stream.finish();
    assert.equal(received.completed, false);
    assert.ok(received.bytes.length < p.packed.bytes);
    assert.equal(
      (await adminRequest("GET", p.base + "/download", p.admin)).statusCode,
      200,
    );
  } finally {
    stream.response.destroy();
  }
});
