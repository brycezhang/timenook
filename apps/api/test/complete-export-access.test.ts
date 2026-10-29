import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { randomUUID, createHash } from "node:crypto";
import {
  startBookFixture,
  stopBookFixture,
  app,
  config,
  db,
  data,
  project,
  state,
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
  exportVerificationScope,
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
  const scope = data(
    await adminRequest("GET", p.base, p.admin),
    200,
  ).staffAccess;
  return {
    expectedBindingVersion: scope.bindingVersion,
    expectedAccessEpoch: scope.accessEpoch,
    expectedAccessSequence: scope.accessSequence,
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
    p.admin = headers;
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
      { expectedAccessSequence: undefined },
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
test("a staff verification prepared before withdrawal cannot acquire a later authorization sequence", async () => {
  const p = await alternativeExport();
  const body = await verification(p),
    key = randomUUID();
  data(await assistedExportChoice(p, "collection", false));
  data(await assistedExportChoice(p, "collection", true));
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
    409,
  );
  assert.equal(
    (await adminRequest("GET", p.base + "/download", p.admin)).statusCode,
    403,
  );
  data(
    await adminRequest(
      "POST",
      p.base + "/access-verification",
      p.admin,
      await verification(p),
    ),
  );
  const renewed = await adminRequest("GET", p.base + "/download", p.admin);
  assert.equal(renewed.statusCode, 200);
  assert.equal(
    createHash("sha256").update(renewed.rawPayload).digest("hex"),
    p.packed.sha256,
  );
});
test("first acceptance cannot upgrade a subject verification recorded before withdrawal", async () => {
  const p = await project();
  data(await assistedExportChoice(p, "collection", true));
  const admin = await paymentAdmin(config, app, ["care:write"]);
  const current = await state(p, p.buyer.token);
  const exp = data(
    await adminRequest(
      "POST",
      `/v1/admin/projects/${p.projectId}/care-requests`,
      admin,
      {
        kind: "export",
        expectedBindingVersion: current.bindingVersion,
      },
    ),
  );
  const body = {
    expectedBindingVersion: current.bindingVersion,
    expectedAccessEpoch: current.accessEpoch,
    noticeVersion: "synthetic-d08-v1",
    evidenceRef: "synthetic:撤回前本人核验和完整范围",
    ...(await exportVerificationScope(exp.id, admin)),
  };
  const verificationKey = randomUUID();
  data(
    await adminRequest(
      "POST",
      `/v1/admin/care-requests/${exp.id}/verify`,
      admin,
      body,
      verificationKey,
    ),
  );
  data(await assistedExportChoice(p, "collection", false));
  data(await assistedExportChoice(p, "collection", true));
  assert.equal(
    (
      await adminRequest(
        "POST",
        `/v1/admin/care-requests/${exp.id}/verify`,
        admin,
        body,
        verificationKey,
      )
    ).statusCode,
    409,
  );
  const base = `/v1/admin/care-requests/${exp.id}/export`;
  assert.equal(
    (
      await adminRequest("POST", base + "/accept", admin, {
        dueAt: new Date(Date.now() + 86400000).toISOString(),
        evidenceRef: "synthetic:迟到的受理不等于重新本人核验",
        recipientRef: "synthetic:本人指定的替代接收人和渠道",
      })
    ).statusCode,
    409,
  );
});
test("an initial subject verification request cannot cross withdrawal and regrant, and missing sequence is never inferred", async () => {
  const p = await project();
  data(await assistedExportChoice(p, "collection", true));
  const admin = await paymentAdmin(config, app, ["care:write"]);
  const current = await state(p, p.buyer.token);
  const exp = data(
    await adminRequest(
      "POST",
      `/v1/admin/projects/${p.projectId}/care-requests`,
      admin,
      {
        kind: "export",
        expectedBindingVersion: current.bindingVersion,
      },
    ),
  );
  const url = `/v1/admin/care-requests/${exp.id}/verify`;
  const body = {
    expectedBindingVersion: current.bindingVersion,
    expectedAccessEpoch: current.accessEpoch,
    noticeVersion: "synthetic-d08-v1",
    evidenceRef: "synthetic:撤回前已完成但请求尚未送达的本人核验",
    ...(await exportVerificationScope(exp.id, admin)),
  };
  const key = randomUUID();
  assert.equal(
    (
      await adminRequest("POST", url, admin, {
        ...body,
        expectedAccessSequence: undefined,
      })
    ).statusCode,
    409,
  );
  data(await assistedExportChoice(p, "collection", false));
  data(await assistedExportChoice(p, "collection", true));
  assert.equal(
    (await adminRequest("POST", url, admin, body, key)).statusCode,
    409,
  );
  const fresh = {
    ...body,
    ...(await exportVerificationScope(exp.id, admin)),
    evidenceRef: "synthetic:重新同意后实际重新核验本人",
  };
  assert.notEqual(fresh.expectedAccessSequence, body.expectedAccessSequence);
  data(await adminRequest("POST", url, admin, fresh));
  const base = `/v1/admin/care-requests/${exp.id}/export`;
  data(
    await adminRequest("POST", base + "/accept", admin, {
      dueAt: new Date(Date.now() + 86400000).toISOString(),
      evidenceRef: "synthetic:新本人核验后受理",
      recipientRef: "synthetic:本人指定的替代接收人和渠道",
    }),
  );
  const view = data(await adminRequest("GET", base, admin), 200);
  assert.equal(view.staffAccess.available, true);
  assert.equal(view.staffAccess.accessSequence, fresh.expectedAccessSequence);
  const care = data(
    await adminRequest("GET", `/v1/admin/care-requests/${exp.id}`, admin),
    200,
  );
  assert.equal(care.verification.accessSequence, fresh.expectedAccessSequence);
});
test("first acceptance cannot renew an expired initial subject verification", async (t) => {
  const p = await project();
  data(await assistedExportChoice(p, "collection", true));
  const admin = await paymentAdmin(config, app, ["care:write"]);
  const current = await state(p, p.buyer.token);
  const exp = data(
    await adminRequest(
      "POST",
      `/v1/admin/projects/${p.projectId}/care-requests`,
      admin,
      {
        kind: "export",
        expectedBindingVersion: current.bindingVersion,
      },
    ),
  );
  data(
    await adminRequest(
      "POST",
      `/v1/admin/care-requests/${exp.id}/verify`,
      admin,
      {
        expectedBindingVersion: current.bindingVersion,
        expectedAccessEpoch: current.accessEpoch,
        ...(await exportVerificationScope(exp.id, admin)),
        noticeVersion: "synthetic-d08-v1",
        evidenceRef: "synthetic:核验当时本人同意但受理已迟到",
      },
    ),
  );
  const care = data(
    await adminRequest("GET", `/v1/admin/care-requests/${exp.id}`, admin),
    200,
  );
  t.mock.timers.enable({
    apis: ["Date"],
    now: Date.parse(care.verification.createdAt) + 30 * 60000,
  });
  try {
    assert.equal(
      (
        await adminRequest(
          "POST",
          `/v1/admin/care-requests/${exp.id}/export/accept`,
          admin,
          {
            dueAt: new Date(Date.now() + 86400000).toISOString(),
            evidenceRef: "synthetic:期限不重置本人核验时间",
            recipientRef: "synthetic:本人指定的替代接收人和渠道",
          },
        )
      ).statusCode,
      409,
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
