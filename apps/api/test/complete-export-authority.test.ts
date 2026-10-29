import { randomUUID, createHash } from "node:crypto";
import assert from "node:assert/strict";
import {
  startBookFixture,
  stopBookFixture,
  bound,
  choose,
  request,
  data,
  app,
  config,
  interceptBookObjectRead,
  interview,
  sealedClip,
  state,
} from "./book-fixture";
import { paymentAdmin } from "./payment-admin-fixture";
import { ProductionTasks } from "../src/tasks/tasks";
import { before, after, test } from "node:test";
import {
  adminRequest,
  acceptedBook,
  anotherAcceptedExport,
  pausedZip,
  alternativeExport,
  streamExport,
  assistedExportChoice,
  acceptAlternativeCase,
} from "./complete-export-fixture";

before(startBookFixture);

after(stopBookFixture);

test("a new product ZIP request cannot use pre-refusal export authority after same-epoch collection refusal", async () => {
  const p = await bound(),
    i = await interview(p),
    sealed = await sealedClip(p, i.id),
    tasks = data(
      await request(
        "POST",
        `/v1/projects/${p.projectId}/tasks/status`,
        p.narrator.token,
        { interviewId: i.id },
      ),
    );
  for (const task of tasks) {
    await app.get(ProductionTasks).run(task.id);
    await app.get(ProductionTasks).run(task.id);
  }
  const key = randomUUID(),
    url = `/v1/projects/${p.projectId}/exports`,
    exp = data(
      await request(
        "POST",
        url,
        p.narrator.token,
        {
          recipient: "self",
          noticeVersion: "synthetic-d08-v1",
          evidenceRef: "synthetic:review-export-request",
        },
        key,
      ),
    ),
    admin = await paymentAdmin(config, app, ["care:write", "audit:read"]),
    current = await state(p, p.narrator.token),
    base = `/v1/admin/care-requests/${exp.id}/export`;
  data(
    await adminRequest(
      "POST",
      `/v1/admin/care-requests/${exp.id}/verify`,
      admin,
      {
        expectedBindingVersion: current.bindingVersion,
        expectedAccessEpoch: current.accessEpoch,
        noticeVersion: "synthetic-d08-v1",
        evidenceRef: "synthetic:review-verify",
      },
    ),
  );
  data(
    await adminRequest("POST", base + "/accept", admin, {
      dueAt: new Date(Date.now() + 86400000).toISOString(),
      evidenceRef: "synthetic:review-accept",
    }),
  );
  const packed = data(await adminRequest("POST", base + "/pack", admin, {}));
  assert.equal(
    packed.bytes,
    9959,
    "the review's one-recording archive is unchanged",
  );
  const pending = data(
    await request("POST", url, p.narrator.token, {
      recipient: "self",
      noticeVersion: "synthetic-d08-v1",
      evidenceRef: "synthetic:拒绝前尚未核验的导出申请",
    }),
  );
  data(await assistedExportChoice(p, "collection", false));
  const denied = await state(p, p.narrator.token);
  assert.equal(denied.accessEpoch, current.accessEpoch);
  assert.equal(denied.canRead, false);
  assert.equal(
    (
      await request(
        "GET",
        `${sealed.base}/${sealed.clip.id}/content`,
        p.narrator.token,
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (await request("GET", `${url}/${exp.id}/download`, p.narrator.token))
      .statusCode,
    403,
  );
  const replay = data(
    await request(
      "POST",
      url,
      p.narrator.token,
      {
        recipient: "self",
        noticeVersion: "synthetic-d08-v1",
        evidenceRef: "synthetic:review-export-request",
      },
      key,
    ),
  );
  assert.equal(replay.canDownload, false);
  assert.equal(replay.missingReason, "EXPORT_CURRENT_AUTHORIZATION_REQUIRED");
  const view = data(await request("GET", url, p.narrator.token), 200);
  assert.equal(
    view.requests.find((r: { id: string }) => r.id === exp.id).canDownload,
    false,
  );
  assert.equal(
    view.requests[0].missingReason,
    "EXPORT_CURRENT_AUTHORIZATION_REQUIRED",
  );
  assert.equal(view.canRequest, true);
  data(
    await adminRequest(
      "POST",
      `/v1/admin/care-requests/${pending.id}/verify`,
      admin,
      {
        expectedBindingVersion: denied.bindingVersion,
        expectedAccessEpoch: denied.accessEpoch,
        noticeVersion: "synthetic-d08-v1",
        evidenceRef: "synthetic:核验发生在拒绝后仍不能改变旧申请事实",
      },
    ),
  );
  const pendingBase = `/v1/admin/care-requests/${pending.id}/export`;
  data(
    await adminRequest("POST", pendingBase + "/accept", admin, {
      dueAt: new Date(Date.now() + 86400000).toISOString(),
      evidenceRef: "synthetic:旧申请的原处理期限",
    }),
  );
  assert.equal(
    (await adminRequest("POST", pendingBase + "/pack", admin, {})).statusCode,
    403,
  );
  const next = data(
      await request("POST", url, p.narrator.token, {
        recipient: "self",
        noticeVersion: "synthetic-d08-v1",
        evidenceRef: "synthetic:拒绝期间仍可申请本人导出权利",
      }),
    ),
    nextBase = `/v1/admin/care-requests/${next.id}/export`;
  data(
    await adminRequest(
      "POST",
      `/v1/admin/care-requests/${next.id}/verify`,
      admin,
      {
        expectedBindingVersion: denied.bindingVersion,
        expectedAccessEpoch: denied.accessEpoch,
        noticeVersion: "synthetic-d08-v1",
        evidenceRef: "synthetic:受理本人权利不等于恢复内容访问",
      },
    ),
  );
  data(
    await adminRequest("POST", nextBase + "/accept", admin, {
      dueAt: new Date(Date.now() + 86400000).toISOString(),
      evidenceRef: "synthetic:权利申请处理期限",
    }),
  );
  const newlyAuthorized = data(
    await adminRequest("POST", nextBase + "/pack", admin, {}),
  );
  assert.equal(newlyAuthorized.state, "ready");
  assert.equal(
    (await request("GET", `${url}/${next.id}/download`, p.narrator.token))
      .statusCode,
    200,
  );
  assert.equal(
    (await request("GET", `${url}/${exp.id}/download`, p.narrator.token))
      .statusCode,
    403,
    "a new explicit case cannot silently renew the old package authority",
  );
  const separate = data(await request("GET", url, p.narrator.token), 200);
  assert.equal(
    separate.requests.find((r: { id: string }) => r.id === next.id).canDownload,
    true,
  );
  assert.equal(
    separate.requests.find((r: { id: string }) => r.id === exp.id).canDownload,
    false,
  );
  data(await assistedExportChoice(p, "collection", false));
  assert.equal(
    (await request("GET", `${url}/${next.id}/download`, p.narrator.token))
      .statusCode,
    403,
    "a later collection refusal invalidates even the new case's earlier dedicated authority",
  );
  data(await assistedExportChoice(p, "collection", true));
  assert.equal(
    (await state(p, p.narrator.token)).accessEpoch,
    current.accessEpoch,
  );
  const restored = await request(
    "GET",
    `${url}/${exp.id}/download`,
    p.narrator.token,
  );
  assert.equal(restored.statusCode, 200, restored.body);
  assert.equal(restored.rawPayload.length, packed.bytes);
  assert.equal(
    createHash("sha256").update(restored.rawPayload).digest("hex"),
    packed.sha256,
  );
  const restoredView = data(
    await request("GET", url, p.narrator.token),
    200,
  ).requests.find((r: { id: string }) => r.id === exp.id);
  assert.equal(restoredView.canDownload, true);
  assert.equal(restoredView.missingReason, null);
  assert.equal(restoredView.expiresAt, packed.expiresAt);
});

test("the alternative transport rejects fresh claims under same-epoch refusal and resumes only with a valid renewed collection choice", async () => {
  const p = await alternativeExport(),
    before = await state(p, p.buyer.token);
  assert.equal(
    before.canRead,
    false,
    "ordinary buyer sharing is not the explicit verified export authority",
  );
  data(await assistedExportChoice(p, "collection", false));
  assert.equal((await state(p, p.buyer.token)).accessEpoch, before.accessEpoch);
  assert.equal(
    (await adminRequest("GET", p.base + "/download", p.admin)).statusCode,
    403,
  );
  assert.equal(
    (await adminRequest("POST", p.base + "/pack", p.admin, {})).statusCode,
    403,
  );
  assert.equal(
    (
      await adminRequest("POST", p.base + "/delivery", p.admin, {
        evidenceRef: "synthetic:旧授权不可留下实际交付回执",
      })
    ).statusCode,
    403,
  );
  const status = data(await adminRequest("GET", p.base, p.admin), 200);
  assert.equal(status.state, "ready");
  assert.equal(status.canDownload, false);
  assert.equal(status.missingReason, "EXPORT_CURRENT_AUTHORIZATION_REQUIRED");
  const dedicated = await acceptAlternativeCase(p, p.admin),
    newPackage = data(
      await adminRequest("POST", dedicated.base + "/pack", p.admin, {}),
    );
  const explicit = await adminRequest(
    "GET",
    dedicated.base + "/download",
    p.admin,
  );
  assert.equal(explicit.statusCode, 200, explicit.body);
  assert.equal(
    createHash("sha256").update(explicit.rawPayload).digest("hex"),
    newPackage.sha256,
  );
  assert.equal(
    (await state(p, p.buyer.token)).canRead,
    false,
    "specific subject-right export must not require general buyer sharing or new collection consent",
  );
  assert.equal(
    (await adminRequest("GET", p.base + "/download", p.admin)).statusCode,
    403,
  );
  data(await assistedExportChoice(p, "collection", false));
  assert.equal(
    (await adminRequest("GET", dedicated.base + "/download", p.admin))
      .statusCode,
    403,
  );
  data(await assistedExportChoice(p, "collection", true));
  const stream = await pausedZip(p.base + "/download", p.admin);
  try {
    data(
      await request(
        "GET",
        `/v1/projects/${p.projectId}/withdrawal-status`,
        p.buyer.token,
      ),
      200,
    );
    const received = await stream.finish();
    assert.equal(received.completed, true);
    assert.equal(
      createHash("sha256").update(received.bytes).digest("hex"),
      p.packed.sha256,
    );
    assert.equal(
      (await state(p, p.buyer.token)).accessEpoch,
      before.accessEpoch,
    );
  } finally {
    stream.response.destroy();
  }
});

test("a narrator's fresh verified export after self withdrawal delivers history without renewing collection", async () => {
  const p = await acceptedBook(),
    oldPackage = data(
      await adminRequest("POST", p.exportBase + "/pack", p.admin, {}),
    );
  data((await choose(p, p.narrator.token, "collection", false)).response);
  const refused = await state(p, p.narrator.token),
    fresh = await anotherAcceptedExport(p),
    packed = data(
      await adminRequest("POST", fresh.base + "/pack", p.admin, {}),
    ),
    received = await request(
      "GET",
      `/v1/projects/${p.projectId}/exports/${fresh.id}/download`,
      p.narrator.token,
    );
  assert.equal(packed.state, "ready");
  assert.equal(received.statusCode, 200, received.body);
  assert.equal(
    createHash("sha256").update(received.rawPayload).digest("hex"),
    packed.sha256,
  );
  const current = await state(p, p.narrator.token);
  assert.equal(current.canRead, false);
  assert.equal(
    current.choices.find((c: { purpose: string }) => c.purpose === "collection")
      .granted,
    false,
  );
  assert.equal(current.accessEpoch, refused.accessEpoch);
  assert.equal(
    (await request("GET", `/v1/projects/${p.projectId}/book`, p.narrator.token))
      .statusCode,
    403,
  );
  assert.equal(
    (
      await request(
        "GET",
        `/v1/projects/${p.projectId}/exports/${p.exp.id}/download`,
        p.narrator.token,
      )
    ).statusCode,
    403,
  );
  const view = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/exports`,
      p.narrator.token,
    ),
    200,
  );
  assert.equal(
    view.requests.find((r: { id: string }) => r.id === fresh.id).canDownload,
    true,
  );
  assert.equal(
    view.requests.find((r: { id: string }) => r.id === p.exp.id).expiresAt,
    oldPackage.expiresAt,
  );
});

test("a collection refusal committed during ZIP assembly cannot publish a late package in the same epoch", async () => {
  const p = await acceptedBook();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => {
      release = r;
    }),
    started = new Promise<void>((r) => {
      entered = r;
    });
  interceptBookObjectRead(async () => {
    entered();
    await gate;
  });
  try {
    const packing = adminRequest("POST", p.exportBase + "/pack", p.admin, {});
    await started;
    const epoch = (await state(p, p.narrator.token)).accessEpoch;
    data(await assistedExportChoice(p, "collection", false));
    release();
    assert.equal((await packing).statusCode, 403);
    const status = data(await adminRequest("GET", p.exportBase, p.admin), 200);
    assert.equal(status.missingReason, "EXPORT_CURRENT_AUTHORIZATION_REQUIRED");
    assert.equal(status.readyAt, null);
    assert.equal(status.sha256, null);
    data(await assistedExportChoice(p, "collection", true));
    assert.equal((await state(p, p.narrator.token)).accessEpoch, epoch);
    const retry = data(
      await adminRequest("POST", p.exportBase + "/pack", p.admin, {}),
    );
    assert.equal(retry.state, "ready");
  } finally {
    release();
    interceptBookObjectRead();
  }
});

for (const channel of ["product", "alternative"] as const)
  test(`${channel} ZIP content authorization expires with the current assisted collection session`, async (t) => {
    const p = await streamExport(channel),
      collection = data(await assistedExportChoice(p, "collection", true)),
      epoch = (await state(p, p.buyer.token)).accessEpoch,
      stream = await pausedZip(p.url, p.headers);
    t.mock.timers.enable({
      apis: ["Date"],
      now: Date.parse(collection.expiresAt),
    });
    try {
      const received = await stream.finish();
      assert.equal(received.completed, false);
      assert.ok(received.bytes.length < p.packed.bytes);
      assert.equal(
        (await app.inject({ method: "GET", url: p.url, headers: p.headers }))
          .statusCode,
        403,
      );
      assert.equal(
        data(
          await adminRequest(
            "GET",
            "exportBase" in p ? p.exportBase : p.base,
            p.admin,
          ),
          200,
        ).missingReason,
        "EXPORT_CURRENT_AUTHORIZATION_REQUIRED",
      );
      data(await assistedExportChoice(p, "collection", true));
      const restored = await app.inject({
        method: "GET",
        url: p.url,
        headers: p.headers,
      });
      assert.equal(restored.statusCode, 200, restored.body);
      assert.equal(
        createHash("sha256").update(restored.rawPayload).digest("hex"),
        p.packed.sha256,
      );
      assert.equal((await state(p, p.buyer.token)).accessEpoch, epoch);
    } finally {
      stream.response.destroy();
      t.mock.timers.reset();
    }
  });
