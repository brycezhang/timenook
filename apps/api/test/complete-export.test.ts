import { randomUUID, createHash } from "node:crypto";
import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import {
  startBookFixture,
  stopBookFixture,
  bound,
  choose,
  request,
  data,
  login,
} from "./book-fixture";
before(startBookFixture);
after(stopBookFixture);
test("complete export requests are subject choices, private and idempotent", async () => {
  const p = await bound();
  data((await choose(p, p.narrator.token, "collection", true)).response);
  data((await choose(p, p.narrator.token, "sharing", true)).response);
  const url = `/v1/projects/${p.projectId}/exports`;
  assert.equal((await request("GET", url)).statusCode, 401);
  assert.equal(
    (await request("GET", url, (await login()).token)).statusCode,
    403,
  );
  assert.equal(
    (
      await request("POST", url, p.buyer.token, {
        recipient: "self",
        noticeVersion: "synthetic-d08-v1",
        evidenceRef: "synthetic:明确申请完整资料",
      })
    ).statusCode,
    403,
  );
  const body = {
    recipient: "self",
    noticeVersion: "synthetic-d08-v1",
    evidenceRef: "synthetic:明确申请完整资料",
  };
  const key = randomUUID();
  const created = data(await request("POST", url, p.narrator.token, body, key));
  assert.equal(created.state, "requested");
  assert.equal(created.recipientUserId, p.narrator.id);
  assert.equal(
    data(await request("POST", url, p.narrator.token, body, key)).id,
    created.id,
  );
  assert.equal(
    (
      await request(
        "POST",
        url,
        p.narrator.token,
        { ...body, recipient: "initiator" },
        key,
      )
    ).statusCode,
    409,
  );
  const view = data(await request("GET", url, p.narrator.token), 200);
  assert.equal(view.requests.length, 1);
  assert.equal(view.amountDueFen, 0);
  assert.equal(
    data(await request("GET", url, p.buyer.token), 200).requests.length,
    0,
  );
});

import { app, config, db, storyPhoto } from "./book-fixture";
import { readyFirstCopyBook } from "./first-copy-fixture";
import { paymentAdmin } from "./payment-admin-fixture";
import { spawnSync } from "node:child_process";
async function adminRequest(
  method: "GET" | "POST",
  url: string,
  headers: Record<string, string>,
  payload?: object,
  key = randomUUID(),
) {
  return app.inject({
    method,
    url,
    headers: { ...headers, "idempotency-key": key },
    ...(payload ? { payload } : {}),
  });
}
async function requestedBook(
  photoRetention: Partial<
    Record<"originalPhotos" | "derivedPhotos", number>
  > = {},
) {
  const p = await readyFirstCopyBook({}, photoRetention);
  const exp = data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/exports`,
      p.narrator.token,
      {
        recipient: "self",
        noticeVersion: "synthetic-d08-v1",
        evidenceRef: "synthetic:本人完整导出并核验范围",
      },
    ),
  );
  const admin = await paymentAdmin(config, app, ["care:write", "audit:read"]);
  const current = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/participation`,
      p.narrator.token,
    ),
    200,
  );
  data(
    await adminRequest(
      "POST",
      `/v1/admin/care-requests/${exp.id}/verify`,
      admin,
      {
        expectedBindingVersion: current.bindingVersion,
        expectedAccessEpoch: current.accessEpoch,
        noticeVersion: "synthetic-d08-v1",
        evidenceRef: "synthetic:客服独立核验本人及全部资料范围",
      },
    ),
  );
  return {
    ...p,
    exp,
    admin,
    exportBase: `/v1/admin/care-requests/${exp.id}/export`,
  };
}
test("verified complete export produces independently readable full ZIP with exact version provenance and hashes", async () => {
  const p = await requestedBook();
  await storyPhoto(p, "合成照片说明");
  const dueAt = new Date(Date.now() + 86400000).toISOString();
  const accepted = data(
    await adminRequest("POST", p.exportBase + "/accept", p.admin, {
      dueAt,
      evidenceRef: "synthetic:按冻结日历核算处理期限",
    }),
  );
  assert.equal(accepted.state, "accepted");
  assert.equal(accepted.dueAt, dueAt);
  const packed = data(
    await adminRequest("POST", p.exportBase + "/pack", p.admin, {}),
  );
  assert.equal(packed.state, "ready");
  assert.ok(packed.sha256);
  assert.equal(
    packed.expiresAt,
    new Date(Date.parse(packed.readyAt) + 7 * 86400000).toISOString(),
  );
  const response = await request(
    "GET",
    `/v1/projects/${p.projectId}/exports/${p.exp.id}/download`,
    p.narrator.token,
  );
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers["content-type"], "application/zip");
  const inspected = spawnSync(
    "python3",
    [
      "-c",
      `import sys,io,zipfile,json,hashlib\nz=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); z.testzip(); m=json.loads(z.read('manifest.json')); print(json.dumps({'files':z.namelist(),'manifest':m,'hashes':{n:hashlib.sha256(z.read(n)).hexdigest() for n in z.namelist()},'text':{n:z.read(n).decode() for n in z.namelist() if n.endswith('.txt')}}))`,
    ],
    { input: response.rawPayload, encoding: "utf8" },
  );
  assert.equal(inspected.status, 0, inspected.stderr);
  const archive = JSON.parse(inspected.stdout);
  assert.ok(archive.files.includes("README.txt"));
  assert.ok(
    archive.files.some(
      (x: string) => x.startsWith("audio/") && x.endsWith(".mp3"),
    ),
  );
  assert.ok(
    archive.files.some(
      (x: string) => x.startsWith("transcripts/") && x.endsWith(".txt"),
    ),
  );
  assert.ok(
    archive.files.some(
      (x: string) => x.startsWith("stories/") && x.endsWith(".txt"),
    ),
  );
  assert.ok(
    archive.files.some(
      (x: string) => x.startsWith("photos/") && x.endsWith(".jpg"),
    ),
  );
  assert.ok(archive.files.includes(`books/${p.book.id}.pdf`));
  assert.equal(archive.manifest.files.length, archive.files.length - 1);
  for (const f of archive.manifest.files)
    assert.equal(archive.hashes[f.path], f.sha256, f.path);
  assert.equal(archive.hashes[`books/${p.book.id}.pdf`], p.book.pdf.sha256);
  assert.match(
    archive.text[
      Object.keys(archive.text).find((x) => x.startsWith("stories/"))!
    ],
    /AI 整理/,
  );
  assert.equal(
    archive.manifest.files.find((x: any) => x.path.startsWith("audio/"))
      .provenance,
    "原始录音（真实原声，非合成音频）",
  );
  assert.equal(
    (
      await request(
        "GET",
        `/v1/projects/${p.projectId}/exports/${p.exp.id}/download`,
        p.buyer.token,
      )
    ).statusCode,
    403,
  );
  assert.equal(
    data(await adminRequest("POST", p.exportBase + "/pack", p.admin, {}))
      .expiresAt,
    packed.expiresAt,
  );
});

import {
  interceptBookObjectRead,
  restartBookApplication,
  root,
} from "./book-fixture";
import { ProjectServiceTerms } from "../src/projects/service-terms";
import { join } from "node:path";
import { access, rm, readFile, writeFile } from "node:fs/promises";
async function acceptedBook(
  photoRetention: Partial<
    Record<"originalPhotos" | "derivedPhotos", number>
  > = {},
) {
  const p = await requestedBook(photoRetention);
  data(
    await adminRequest("POST", p.exportBase + "/accept", p.admin, {
      dueAt: new Date(Date.now() + 86400000).toISOString(),
      evidenceRef: "synthetic:处理期限经人工日历核验",
    }),
  );
  return p;
}
test("export completion rejects withdrawal during storage read and retry cannot activate stale content", async () => {
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
  const packing = adminRequest("POST", p.exportBase + "/pack", p.admin, {});
  await started;
  try {
    data((await choose(p, p.narrator.token, "sharing", false)).response);
  } finally {
    release();
    interceptBookObjectRead();
  }
  assert.equal((await packing).statusCode, 403);
  const status = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/exports`,
      p.narrator.token,
    ),
    200,
  );
  assert.equal(status.requests[0].canDownload, false);
  assert.equal(status.requests[0].state, "revoked");
  assert.notEqual(
    status.requests[0].missingReason,
    "EXPORT_SOURCE_RETENTION_EXPIRED",
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
  assert.equal(
    (await adminRequest("POST", p.exportBase + "/pack", p.admin, {}))
      .statusCode,
    403,
  );
});
test("export package expiry is independent and repeated delivery never extends its fixed ready window", async (t) => {
  const p = await acceptedBook(),
    packed = data(
      await adminRequest("POST", p.exportBase + "/pack", p.admin, {}),
    );
  const stored = await db.careExport.findUniqueOrThrow({
      where: { id: p.exp.id },
    }),
    path = join(config.books!.storageRoot, stored.objectKey!);
  const expiry = Date.parse(packed.expiresAt);
  await db.session.updateMany({
    where: { userId: p.narrator.id },
    data: { expiresAt: new Date(expiry + 86400000) },
  });
  t.mock.timers.enable({ apis: ["Date"], now: expiry - 1 });
  try {
    assert.equal(
      (
        await request(
          "GET",
          `/v1/projects/${p.projectId}/exports/${p.exp.id}/download`,
          p.narrator.token,
        )
      ).statusCode,
      200,
    );
    t.mock.timers.setTime(expiry);
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
    assert.equal(view.requests[0].state, "expired");
    assert.equal(view.requests[0].expiresAt, packed.expiresAt);
    await assert.rejects(access(path));
    assert.ok(
      (await db.recordingAsset.count({ where: { projectId: p.projectId } })) >
        0,
      "package cleanup retains source assets",
    );
  } finally {
    t.mock.timers.reset();
  }
});

test("only an explicitly authorized initiator receives the package and download acknowledgement preserves expiry", async () => {
  const p = await readyFirstCopyBook(),
    requestUrl = `/v1/projects/${p.projectId}/exports`;
  const exp = data(
    await request("POST", requestUrl, p.narrator.token, {
      recipient: "initiator",
      noticeVersion: "synthetic-d08-v1",
      evidenceRef: "synthetic:本人单独授权发起人接收全部资料",
    }),
  );
  const admin = await paymentAdmin(config, app, ["care:write"]),
    current = data(
      await request(
        "GET",
        `/v1/projects/${p.projectId}/participation`,
        p.narrator.token,
      ),
      200,
    ),
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
        evidenceRef: "synthetic:核验独立接收授权及全部范围",
      },
    ),
  );
  data(
    await adminRequest("POST", base + "/accept", admin, {
      dueAt: new Date(Date.now() + 86400000).toISOString(),
      evidenceRef: "synthetic:本次工作日历核算",
    }),
  );
  const packed = data(await adminRequest("POST", base + "/pack", admin, {}));
  assert.equal(
    data(await request("GET", requestUrl, p.buyer.token), 200).requests[0]
      .canDownload,
    true,
  );
  assert.equal(
    (await request("GET", `${requestUrl}/${exp.id}/download`, p.buyer.token))
      .statusCode,
    200,
  );
  assert.equal(
    (await request("GET", `${requestUrl}/${exp.id}/download`, p.narrator.token))
      .statusCode,
    403,
  );
  const acknowledged = data(
    await request("POST", `${requestUrl}/${exp.id}/receipt`, p.buyer.token, {
      sha256: packed.sha256,
    }),
  );
  assert.equal(acknowledged.state, "delivered");
  assert.equal(acknowledged.expiresAt, packed.expiresAt);
  assert.equal(
    data(
      await request("POST", `${requestUrl}/${exp.id}/receipt`, p.buyer.token, {
        sha256: packed.sha256,
      }),
    ).deliveredAt,
    acknowledged.deliveredAt,
  );
  assert.equal(
    (
      await request("POST", `${requestUrl}/${exp.id}/receipt`, p.buyer.token, {
        sha256: "0".repeat(64),
      })
    ).statusCode,
    409,
  );
});

test("download rechecks the exported confirmed version rather than only its package hash", async () => {
  const p = await acceptedBook();
  data(await adminRequest("POST", p.exportBase + "/pack", p.admin, {}));
  data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/stories/${p.story.id}/decisions`,
      p.narrator.token,
      {
        revisionId: p.story.revision.id,
        expectedVersion: p.story.version,
        contentHash: p.story.revision.contentHash,
        confirmed: false,
        allowInBook: false,
        noticeVersion: "synthetic-d08-v1",
        evidenceRef: `synthetic:撤回本版故事-${randomUUID()}`,
      },
    ),
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
});

import { startProductionWorker } from "../src/tasks/worker";
import { project } from "./book-fixture";
test("without-WeChat export uses a separately verified subject recipient and leaves a delivery receipt", async () => {
  const p = await project(),
    admin = await paymentAdmin(config, app, ["care:write"]),
    generic = `/v1/admin/projects/${p.projectId}/care-requests`;
  const care = data(
    await adminRequest("POST", generic, admin, {
      kind: "export",
      expectedBindingVersion: 0,
    }),
  );
  const base = `/v1/admin/care-requests/${care.id}/export`;
  assert.equal(
    (
      await adminRequest("POST", base + "/accept", admin, {
        dueAt: new Date(Date.now() + 86400000).toISOString(),
        evidenceRef: "synthetic:未核验不能领取",
        recipientRef: "synthetic:本人替代接收人",
      })
    ).statusCode,
    403,
  );
  data(
    await adminRequest(
      "POST",
      `/v1/admin/care-requests/${care.id}/verify`,
      admin,
      {
        expectedBindingVersion: 0,
        expectedAccessEpoch: 0,
        noticeVersion: "synthetic-d08-v1",
        evidenceRef: "synthetic:非微信讲述者本人及完整范围核验",
      },
    ),
  );
  assert.equal(
    (
      await adminRequest("POST", base + "/accept", admin, {
        dueAt: new Date(Date.now() + 86400000).toISOString(),
        evidenceRef: "synthetic:未指定接收人",
      })
    ).statusCode,
    403,
  );
  data(
    await adminRequest("POST", base + "/accept", admin, {
      dueAt: new Date(Date.now() + 86400000).toISOString(),
      evidenceRef: "synthetic:核验本人指定渠道及接收人",
      recipientRef: "synthetic:本人核验的接收人和渠道",
    }),
  );
  const packed = data(await adminRequest("POST", base + "/pack", admin, {}));
  assert.equal(packed.recipientUserId, null);
  assert.equal(packed.recipient, "verified_alternative");
  assert.equal(
    (
      await request(
        "GET",
        `/v1/projects/${p.projectId}/exports/${care.id}/download`,
        p.buyer.token,
      )
    ).statusCode,
    403,
  );
  const other = await paymentAdmin(config, app, ["care:write"]);
  assert.equal(
    (await adminRequest("GET", base + "/download", other)).statusCode,
    403,
  );
  assert.equal(
    (await adminRequest("GET", base + "/download", admin)).statusCode,
    200,
  );
  const body = { evidenceRef: "synthetic:实际替代渠道交付回执" },
    delivered = data(
      await adminRequest("POST", base + "/delivery", admin, body),
    );
  assert.equal(delivered.state, "delivered");
  assert.equal(delivered.expiresAt, packed.expiresAt);
  assert.equal(
    data(await adminRequest("POST", base + "/delivery", admin, body))
      .deliveredAt,
    delivered.deliveredAt,
  );
});
test("an accepted request survives its request deadline while new requests stop exactly at that deadline", async (t) => {
  const p = await acceptedBook(),
    terms = new ProjectServiceTerms(config.databaseUrl),
    deliveredAt = new Date();
  await terms.recordFact({
    projectId: p.projectId,
    eventId: `export-delivery:${randomUUID()}`,
    kind: "delivery_completed",
    occurredAt: deliveredAt,
  });
  await terms.close();
  const expiry = deliveredAt.getTime() + 365 * 86400000;
  await db.session.updateMany({
    where: { userId: p.narrator.id },
    data: { expiresAt: new Date(expiry + 86400000) },
  });
  await db.adminSession.updateMany({
    data: { expiresAt: new Date(expiry + 86400000) },
  });
  t.mock.timers.enable({ apis: ["Date"], now: expiry - 1 });
  try {
    assert.equal(
      data(
        await request(
          "GET",
          `/v1/projects/${p.projectId}/exports`,
          p.narrator.token,
        ),
        200,
      ).canRequest,
      true,
    );
    t.mock.timers.setTime(expiry);
    assert.equal(
      (
        await request(
          "POST",
          `/v1/projects/${p.projectId}/exports`,
          p.narrator.token,
          {
            recipient: "self",
            noticeVersion: "synthetic-d08-v1",
            evidenceRef: "synthetic:到期新请求拒绝",
          },
        )
      ).statusCode,
      403,
    );
    const packed = data(
      await adminRequest("POST", p.exportBase + "/pack", p.admin, {}),
    );
    assert.equal(packed.state, "ready");
    assert.equal(
      (
        await request(
          "GET",
          `/v1/projects/${p.projectId}/exports/${p.exp.id}/download`,
          p.narrator.token,
        )
      ).statusCode,
      200,
    );
    assert.equal(
      data(await adminRequest("POST", p.exportBase + "/pack", p.admin, {}))
        .expiresAt,
      packed.expiresAt,
    );
  } finally {
    t.mock.timers.reset();
  }
});

test("missing source bytes never publish an incomplete package and orphan cleanup survives a process restart", async () => {
  const p = await acceptedBook(),
    asset = await db.recordingAsset.findFirstOrThrow({
      where: { projectId: p.projectId },
    }),
    path = join(root, "objects", asset.objectKey),
    original = await readFile(path);
  await rm(path);
  assert.equal(
    (await adminRequest("POST", p.exportBase + "/pack", p.admin, {}))
      .statusCode,
    409,
  );
  const failed = data(await adminRequest("GET", p.exportBase, p.admin), 200);
  assert.equal(failed.state, "failed");
  assert.equal(
    failed.missingReason,
    "EXPORT_SOURCE_MISSING_OR_PERMISSION_CHANGED",
  );
  assert.equal(failed.sha256, null);
  await writeFile(path, original);
  const packed = data(
    await adminRequest("POST", p.exportBase + "/pack", p.admin, {}),
  );
  assert.equal(packed.state, "ready");
  const orphan = join(
    config.books!.storageRoot,
    "exports",
    `${randomUUID()}-9.zip`,
  );
  await writeFile(orphan, Buffer.from("orphaned synthetic bytes"));
  await restartBookApplication();
  const worker = await startProductionWorker(app);
  try {
    await worker.recoverDue();
  } finally {
    await worker.close();
  }
  await assert.rejects(access(orphan));
  assert.equal(
    (
      await request(
        "GET",
        `/v1/projects/${p.projectId}/exports/${p.exp.id}/download`,
        p.narrator.token,
      )
    ).statusCode,
    200,
  );
});

import { interview, sealedClip } from "./book-fixture";
test("incomplete original transcript is reported in the shared case instead of offering a partial archive", async () => {
  const p = await bound(),
    i = await interview(p);
  await sealedClip(p, i.id);
  const exp = data(
      await request(
        "POST",
        `/v1/projects/${p.projectId}/exports`,
        p.narrator.token,
        {
          recipient: "self",
          noticeVersion: "synthetic-d08-v1",
          evidenceRef: "synthetic:申请当前完整资料",
        },
      ),
    ),
    admin = await paymentAdmin(config, app, ["care:write"]),
    current = data(
      await request(
        "GET",
        `/v1/projects/${p.projectId}/participation`,
        p.narrator.token,
      ),
      200,
    ),
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
        evidenceRef: "synthetic:核验本人和当前资料范围",
      },
    ),
  );
  data(
    await adminRequest("POST", base + "/accept", admin, {
      dueAt: new Date(Date.now() + 86400000).toISOString(),
      evidenceRef: "synthetic:原订单期限和处理人核验",
    }),
  );
  const failed = data(await adminRequest("POST", base + "/pack", admin, {}));
  assert.equal(failed.state, "failed");
  assert.equal(failed.missingReason, "EXPORT_TRANSCRIPT_PENDING");
  const view = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/exports`,
      p.narrator.token,
    ),
    200,
  );
  assert.equal(view.requests[0].missingReason, "EXPORT_TRANSCRIPT_PENDING");
  assert.equal(view.requests[0].canDownload, false);
});

async function anotherAcceptedExport(
  p: Awaited<ReturnType<typeof acceptedBook>>,
) {
  const exp = data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/exports`,
      p.narrator.token,
      {
        recipient: "self",
        noticeVersion: "synthetic-d08-v1",
        evidenceRef: `synthetic:独立本次完整资料-${randomUUID()}`,
      },
    ),
  );
  const current = data(
      await request(
        "GET",
        `/v1/projects/${p.projectId}/participation`,
        p.narrator.token,
      ),
      200,
    ),
    base = `/v1/admin/care-requests/${exp.id}/export`;
  data(
    await adminRequest(
      "POST",
      `/v1/admin/care-requests/${exp.id}/verify`,
      p.admin,
      {
        expectedBindingVersion: current.bindingVersion,
        expectedAccessEpoch: current.accessEpoch,
        noticeVersion: "synthetic-d08-v1",
        evidenceRef: "synthetic:核验本次本人和完整范围",
      },
    ),
  );
  data(
    await adminRequest("POST", base + "/accept", p.admin, {
      dueAt: new Date(Date.now() + 86400000).toISOString(),
      evidenceRef: "synthetic:本次范围处理期限核算",
    }),
  );
  return { id: exp.id, base };
}
async function photoDeadline(p: Awaited<ReturnType<typeof acceptedBook>>) {
  const terms = new ProjectServiceTerms(config.databaseUrl),
    deliveredAt = new Date();
  await terms.recordFact({
    projectId: p.projectId,
    eventId: `photo-delivery:${randomUUID()}`,
    kind: "delivery_completed",
    occurredAt: deliveredAt,
  });
  await terms.close();
  const end = deliveredAt.getTime() + 86400000;
  await db.session.updateMany({
    where: { userId: p.narrator.id },
    data: { expiresAt: new Date(end + 86400000) },
  });
  await db.adminSession.updateMany({
    data: { expiresAt: new Date(end + 86400000) },
  });
  return end;
}
test("a first pack at or after source retention expiry records a stable failure visible to the recipient and operator", async (t) => {
  const p = await acceptedBook({ derivedPhotos: 1, originalPhotos: 400 });
  await storyPhoto(p, "首次打包前已到期的衍生图");
  const after = await anotherAcceptedExport(p),
    end = await photoDeadline(p);
  const before = data(await adminRequest("GET", p.exportBase, p.admin), 200);
  assert.equal(before.state, "accepted");
  assert.equal(before.missingReason, null);
  t.mock.timers.enable({ apis: ["Date"], now: end });
  try {
    for (const [id, base, now] of [
      [p.exp.id, p.exportBase, end],
      [after.id, after.base, end + 1],
    ] as const) {
      t.mock.timers.setTime(now);
      const accepted = data(await adminRequest("GET", base, p.admin), 200);
      for (let attempt = 0; attempt < 2; attempt++) {
        const failed = data(
          await adminRequest("POST", base + "/pack", p.admin, {}),
        );
        assert.equal(failed.state, "failed");
        assert.equal(failed.missingReason, "EXPORT_SOURCE_RETENTION_EXPIRED");
        const recipient = data(
          await request(
            "GET",
            `/v1/projects/${p.projectId}/exports`,
            p.narrator.token,
          ),
          200,
        ).requests.find((r: { id: string }) => r.id === id);
        const operator = data(await adminRequest("GET", base, p.admin), 200);
        for (const view of [failed, recipient, operator]) {
          assert.equal(view.state, "failed");
          assert.equal(view.missingReason, "EXPORT_SOURCE_RETENTION_EXPIRED");
          assert.equal(view.acceptedAt, accepted.acceptedAt);
          assert.equal(view.dueAt, accepted.dueAt);
          assert.equal(view.readyAt, null);
          assert.equal(view.expiresAt, null);
          assert.equal(view.sha256, null);
          assert.equal(view.bytes, null);
          assert.equal(view.canDownload, false);
        }
        assert.equal(
          (
            await request(
              "GET",
              `/v1/projects/${p.projectId}/exports/${id}/download`,
              p.narrator.token,
            )
          ).statusCode,
          403,
        );
      }
    }
  } finally {
    t.mock.timers.reset();
  }
});
test("derived-photo retention stops new complete packs and existing ZIP downloads exactly at its own deadline", async (t) => {
  const p = await acceptedBook({ derivedPhotos: 1, originalPhotos: 400 });
  await storyPhoto(p, "本次期限不同的原图与衍生照片");
  const at = await anotherAcceptedExport(p),
    after = await anotherAcceptedExport(p),
    end = await photoDeadline(p);
  const assets = await db.photoAsset.findMany({
    where: { projectId: p.projectId },
  });
  assert.ok(assets.some((a) => a.kind !== "original"));
  t.mock.timers.enable({ apis: ["Date"], now: end - 1 });
  try {
    const packed = data(
      await adminRequest("POST", p.exportBase + "/pack", p.admin, {}),
    );
    assert.equal(packed.state, "ready");
    assert.equal(
      (
        await request(
          "GET",
          `/v1/projects/${p.projectId}/exports/${p.exp.id}/download`,
          p.narrator.token,
        )
      ).statusCode,
      200,
    );
    t.mock.timers.setTime(end);
    assert.equal(
      data(await adminRequest("POST", at.base + "/pack", p.admin, {})).state,
      "failed",
      "expired derived photos cannot enter a newly packed archive",
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
      "existing package cannot bypass the source-category deadline",
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
      view.requests.find((r: { id: string }) => r.id === p.exp.id).canDownload,
      false,
    );
    t.mock.timers.setTime(end + 1);
    assert.equal(
      data(await adminRequest("POST", after.base + "/pack", p.admin, {})).state,
      "failed",
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
    for (const asset of assets)
      await access(join(root, "objects", asset.objectKey));
    assert.ok(
      Date.parse(packed.expiresAt) > end,
      "the package's own download window remains unexpired",
    );
  } finally {
    t.mock.timers.reset();
  }
});

test("a derived-photo deadline crossed during packing prevents the late ZIP from becoming ready", async (t) => {
  const p = await acceptedBook({ derivedPhotos: 1, originalPhotos: 400 });
  await storyPhoto(p, "慢打包期间到期的衍生图");
  const end = await photoDeadline(p);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => {
      release = r;
    }),
    started = new Promise<void>((r) => {
      entered = r;
    });
  t.mock.timers.enable({ apis: ["Date"], now: end - 1 });
  interceptBookObjectRead(async () => {
    entered();
    await gate;
  });
  try {
    const packing = adminRequest("POST", p.exportBase + "/pack", p.admin, {});
    await started;
    t.mock.timers.setTime(end);
    release();
    assert.equal((await packing).statusCode, 403);
    const view = data(
        await request(
          "GET",
          `/v1/projects/${p.projectId}/exports`,
          p.narrator.token,
        ),
        200,
      ),
      row = view.requests.find((r: { id: string }) => r.id === p.exp.id);
    assert.equal(row.canDownload, false);
    assert.equal(row.sha256, null);
    assert.equal(row.readyAt, null);
    assert.equal(row.state, "failed");
    assert.equal(row.missingReason, "EXPORT_SOURCE_RETENTION_EXPIRED");
    const operator = data(
      await adminRequest("GET", p.exportBase, p.admin),
      200,
    );
    assert.equal(operator.state, "failed");
    assert.equal(operator.missingReason, "EXPORT_SOURCE_RETENTION_EXPIRED");
    for (const asset of await db.photoAsset.findMany({
      where: { projectId: p.projectId },
    }))
      await access(join(root, "objects", asset.objectKey));
  } finally {
    release();
    interceptBookObjectRead();
    t.mock.timers.reset();
  }
});
test("an unused derived-photo retention category does not block an otherwise complete archive", async (t) => {
  const p = await acceptedBook({ derivedPhotos: 1, originalPhotos: 400 }),
    end = await photoDeadline(p);
  t.mock.timers.enable({ apis: ["Date"], now: end });
  try {
    const packed = data(
      await adminRequest("POST", p.exportBase + "/pack", p.admin, {}),
    );
    assert.equal(packed.state, "ready");
    assert.equal(
      (
        await request(
          "GET",
          `/v1/projects/${p.projectId}/exports/${p.exp.id}/download`,
          p.narrator.token,
        )
      ).statusCode,
      200,
    );
  } finally {
    t.mock.timers.reset();
  }
});

import http from "node:http";
import { formUpload, syntheticAudio, state } from "./book-fixture";
import { ProductionTasks } from "../src/tasks/tasks";
async function largeExportSources(
  projectId: string,
  token: string,
  assistedSessionId?: string,
) {
  const session = assistedSessionId ? { assistedSessionId } : {},
    interview = data(
      await request("POST", `/v1/projects/${projectId}/interviews`, token, {
        clientInterviewId: randomUUID(),
        expectedPlanRevision: 1,
        starterKind: "free-narration",
        ...session,
      }),
    ),
    base = `/v1/projects/${projectId}/interviews/${interview.id}/clips`,
    paddingBytes = 1800000,
    header = Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]);
  for (let index = 0; index < 4; index++)
    header[6 + index] = (paddingBytes >> (7 * (3 - index))) & 0x7f;
  const audio = Buffer.concat([
    header,
    Buffer.alloc(paddingBytes),
    syntheticAudio(),
  ]);
  // Four independently validated MP3s make the ZIP larger than local socket buffers.
  for (let index = 0; index < 4; index++) {
    const clip = data(
      await request("POST", base, token, {
        clientClipId: randomUUID(),
        bytes: audio.length,
        sha256: createHash("sha256").update(audio).digest("hex"),
        ...session,
      }),
    );
    const form = data(
      await request("POST", `${base}/${clip.id}/upload`, token, session),
    );
    assert.equal(
      (await formUpload(app, form, audio, {}, token)).statusCode,
      204,
    );
    data(await request("POST", `${base}/${clip.id}/seal`, token, session));
  }
  const tasks = data(
    await request("POST", `/v1/projects/${projectId}/tasks/status`, token, {
      interviewId: interview.id,
      ...session,
    }),
  );
  for (const task of tasks) {
    await app.get(ProductionTasks).run(task.id);
    await app.get(ProductionTasks).run(task.id);
  }
}
async function pausedZip(url: string, headers: Record<string, string>) {
  if (!app.getHttpServer().listening) await app.listen(0, "127.0.0.1");
  const server = await app.getUrl();
  const response = await new Promise<http.IncomingMessage>((resolve, reject) =>
    http.get(`${server}${url}`, { headers }, resolve).on("error", reject),
  );
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-type"], "application/zip");
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) =>
    response
      .once("data", (chunk) => {
        chunks.push(chunk);
        response.pause();
        resolve();
      })
      .once("error", reject),
  );
  const completed = new Promise<boolean>((resolve) => {
    response.once("aborted", () => resolve(false));
    response.once("end", () => resolve(true));
    response.on("error", () => {});
  });
  return {
    response,
    async finish() {
      response.on("data", (chunk) => chunks.push(chunk));
      response.resume();
      return { completed: await completed, bytes: Buffer.concat(chunks) };
    },
  };
}
test("the product ZIP stream stops after committed withdrawal while the receiver is backpressured", async () => {
  const p = await acceptedBook();
  await largeExportSources(p.projectId, p.narrator.token);
  const packed = data(
      await adminRequest("POST", p.exportBase + "/pack", p.admin, {}),
    ),
    url = `/v1/projects/${p.projectId}/exports/${p.exp.id}/download`,
    stream = await pausedZip(url, {
      authorization: `Bearer ${p.narrator.token}`,
    });
  try {
    assert.equal(
      Number(stream.response.headers["content-length"]),
      packed.bytes,
    );
    data((await choose(p, p.narrator.token, "collection", false)).response);
    const received = await stream.finish();
    assert.equal(received.completed, false);
    assert.ok(received.bytes.length < packed.bytes);
    assert.equal((await request("GET", url, p.narrator.token)).statusCode, 403);
  } finally {
    stream.response.destroy();
  }
});
async function assistedExportChoice(
  p: { projectId: string; buyer: { token: string } },
  purpose: string,
  granted: boolean,
) {
  const current = await state(p, p.buyer.token),
    sessions = data(
      await request(
        "GET",
        `/v1/projects/${p.projectId}/assisted-sessions`,
        p.buyer.token,
      ),
      200,
    ).sessions,
    latest = sessions.find(
      (row: { purpose: string }) => row.purpose === purpose,
    );
  return request(
    "POST",
    `/v1/projects/${p.projectId}/assisted-sessions`,
    p.buyer.token,
    {
      purpose,
      granted,
      noticeVersion: "synthetic-d08-v1",
      evidenceRef: `synthetic:export-stream-scope-${randomUUID()}`,
      expectedBindingVersion: current.bindingVersion,
      expectedAccessEpoch: current.accessEpoch,
      ...(latest ? { expectedSessionId: latest.id } : {}),
    },
  );
}
async function acceptedAlternativeExport() {
  const p = await project(),
    collection = data(await assistedExportChoice(p, "collection", true));
  data(await assistedExportChoice(p, "ai", true));
  await largeExportSources(p.projectId, p.buyer.token, collection.id);
  const admin = await paymentAdmin(config, app, ["care:write"]),
    current = await state(p, p.buyer.token),
    exp = data(
      await adminRequest(
        "POST",
        `/v1/admin/projects/${p.projectId}/care-requests`,
        admin,
        {
          kind: "export",
          expectedBindingVersion: current.bindingVersion,
        },
      ),
    ),
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
        evidenceRef: "synthetic:核验本人及替代交付完整范围",
      },
    ),
  );
  data(
    await adminRequest("POST", base + "/accept", admin, {
      dueAt: new Date(Date.now() + 86400000).toISOString(),
      evidenceRef: "synthetic:替代交付处理日历和期限",
      recipientRef: "synthetic:本人指定的替代接收人和渠道",
    }),
  );
  return { ...p, exp, base, admin };
}
async function alternativeExport() {
  const p = await acceptedAlternativeExport(),
    packed = data(await adminRequest("POST", p.base + "/pack", p.admin, {}));
  return { ...p, packed };
}
async function alternativeWithdrawal(
  p: Awaited<ReturnType<typeof alternativeExport>>,
) {
  const current = await state(p, p.buyer.token),
    care = data(
      await adminRequest(
        "POST",
        `/v1/admin/projects/${p.projectId}/care-requests`,
        p.admin,
        {
          kind: "withdraw",
          purpose: "collection",
          expectedBindingVersion: current.bindingVersion,
        },
      ),
    );
  data(
    await adminRequest(
      "POST",
      `/v1/admin/care-requests/${care.id}/verify`,
      p.admin,
      {
        expectedBindingVersion: current.bindingVersion,
        expectedAccessEpoch: current.accessEpoch,
        noticeVersion: "synthetic-d08-v1",
        evidenceRef: "synthetic:本人替代渠道撤回核验",
      },
    ),
  );
}
test("the verified alternative ZIP stream stops after the subject's committed withdrawal", async () => {
  const p = await alternativeExport(),
    stream = await pausedZip(p.base + "/download", p.admin);
  try {
    assert.equal(
      Number(stream.response.headers["content-length"]),
      p.packed.bytes,
    );
    await alternativeWithdrawal(p);
    const received = await stream.finish();
    assert.equal(received.completed, false);
    assert.ok(received.bytes.length < p.packed.bytes);
    assert.equal(
      (await adminRequest("GET", p.base + "/download", p.admin)).statusCode,
      403,
    );
  } finally {
    stream.response.destroy();
  }
});
async function productExportStream() {
  const p = await acceptedBook();
  await largeExportSources(p.projectId, p.narrator.token);
  return {
    ...p,
    packed: data(
      await adminRequest("POST", p.exportBase + "/pack", p.admin, {}),
    ),
    url: `/v1/projects/${p.projectId}/exports/${p.exp.id}/download`,
    headers: { authorization: `Bearer ${p.narrator.token}` },
  };
}
async function streamExport(channel: "product" | "alternative") {
  if (channel === "product") return productExportStream();
  const p = await alternativeExport();
  return { ...p, url: p.base + "/download", headers: p.admin };
}
async function pendingStreamExport(channel: "product" | "alternative") {
  if (channel === "product") {
    const p = await acceptedBook();
    await largeExportSources(p.projectId, p.narrator.token);
    return {
      ...p,
      caseBase: p.exportBase,
      url: `/v1/projects/${p.projectId}/exports/${p.exp.id}/download`,
      headers: { authorization: `Bearer ${p.narrator.token}` },
    };
  }
  const p = await acceptedAlternativeExport();
  return {
    ...p,
    caseBase: p.base,
    url: p.base + "/download",
    headers: p.admin,
  };
}
async function rebindExport(p: Awaited<ReturnType<typeof streamExport>>) {
  const current = await state(p, p.buyer.token),
    next = await login(),
    care = data(
      await adminRequest(
        "POST",
        `/v1/admin/projects/${p.projectId}/care-requests`,
        p.admin,
        {
          kind: "rebind",
          expectedBindingVersion: current.bindingVersion,
          targetUserId: next.id,
        },
      ),
    );
  data(
    await adminRequest(
      "POST",
      `/v1/admin/projects/${p.projectId}/rebind`,
      p.admin,
      {
        supportCaseRef: `record:${care.id}`,
        targetUserId: next.id,
        expectedBindingVersion: current.bindingVersion,
        noticeVersion: "synthetic-d08-v1",
        evidenceRef: "synthetic:活动导出流期间换绑",
      },
    ),
  );
}
for (const channel of ["product", "alternative"] as const) {
  test(`${channel} ZIP stream rechecks subject binding after its first bytes`, async () => {
    const p = await streamExport(channel),
      stream = await pausedZip(p.url, p.headers);
    try {
      await rebindExport(p);
      const received = await stream.finish();
      assert.equal(received.completed, false);
      assert.ok(received.bytes.length < p.packed.bytes);
      assert.equal(
        (await app.inject({ method: "GET", url: p.url, headers: p.headers }))
          .statusCode,
        403,
      );
    } finally {
      stream.response.destroy();
    }
  });
  test(`${channel} ZIP stream stops exactly at its package deadline during backpressure`, async (t) => {
    const p = await streamExport(channel),
      end = Date.parse(p.packed.expiresAt);
    await db.session.updateMany({
      data: { expiresAt: new Date(end + 86400000) },
    });
    await db.adminSession.updateMany({
      data: { expiresAt: new Date(end + 86400000) },
    });
    const stream = await pausedZip(p.url, p.headers);
    t.mock.timers.enable({ apis: ["Date"], now: end });
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
      const received = await stream.finish();
      assert.equal(received.completed, false);
      assert.ok(received.bytes.length < p.packed.bytes);
      assert.equal(
        (await app.inject({ method: "GET", url: p.url, headers: p.headers }))
          .statusCode,
        403,
      );
    } finally {
      stream.response.destroy();
      t.mock.timers.reset();
    }
  });
  test(`${channel} ZIP stream stops when a represented source category expires before the package deadline`, async (t) => {
    const p = await pendingStreamExport(channel);
    const terms = new ProjectServiceTerms(config.databaseUrl),
      deliveredAt = new Date(),
      end = deliveredAt.getTime() + 400 * 86400000;
    await terms.recordFact({
      projectId: p.projectId,
      eventId: `active-export-category:${randomUUID()}`,
      kind: "delivery_completed",
      occurredAt: deliveredAt,
    });
    await terms.close();
    await db.session.updateMany({
      data: { expiresAt: new Date(end + 86400000) },
    });
    await db.adminSession.updateMany({
      data: { expiresAt: new Date(end + 86400000) },
    });
    t.mock.timers.enable({ apis: ["Date"], now: end - 1 });
    let stream: Awaited<ReturnType<typeof pausedZip>> | undefined;
    try {
      const packed = data(
        await adminRequest("POST", p.caseBase + "/pack", p.admin, {}),
      );
      assert.equal(packed.state, "ready");
      assert.ok(Date.parse(packed.expiresAt) > end);
      stream = await pausedZip(p.url, p.headers);
      t.mock.timers.setTime(end);
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
      const received = await stream.finish();
      assert.equal(received.completed, false);
      assert.ok(received.bytes.length < packed.bytes);
      assert.equal(
        (await app.inject({ method: "GET", url: p.url, headers: p.headers }))
          .statusCode,
        403,
      );
      const asset = await db.recordingAsset.findFirstOrThrow({
        where: { projectId: p.projectId },
      });
      await access(join(root, "objects", asset.objectKey));
    } finally {
      stream?.response.destroy();
      t.mock.timers.reset();
    }
  });
}
test("alternative ZIP stream rechecks the current administrator session after its first bytes", async () => {
  const p = await alternativeExport(),
    stream = await pausedZip(p.base + "/download", p.admin);
  try {
    const loggedOut = await adminRequest(
      "POST",
      "/v1/admin/logout",
      p.admin,
      {},
    );
    assert.equal(loggedOut.statusCode, 204, loggedOut.body);
    const received = await stream.finish();
    assert.equal(received.completed, false);
    assert.ok(received.bytes.length < p.packed.bytes);
    assert.equal(
      (await adminRequest("GET", p.base + "/download", p.admin)).statusCode,
      401,
    );
  } finally {
    stream.response.destroy();
  }
});
test("replaying an old assisted revocation leaves the newly authorized same-epoch ZIP stream intact", async () => {
  const p = await alternativeExport(),
    originalEpoch = (await state(p, p.buyer.token)).accessEpoch,
    original = await pausedZip(p.base + "/download", p.admin);
  let fresh: Awaited<ReturnType<typeof pausedZip>> | undefined;
  await db.$executeRawUnsafe(
    "CREATE FUNCTION reject_t25_stream_followup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic delayed export followup'; END $$",
  );
  await db.$executeRawUnsafe(
    "CREATE TRIGGER reject_t25_stream_followup BEFORE UPDATE ON project_access_revocations FOR EACH ROW EXECUTE FUNCTION reject_t25_stream_followup()",
  );
  try {
    assert.equal(
      (await assistedExportChoice(p, "collection", false)).statusCode,
      500,
    );
    data(await assistedExportChoice(p, "collection", true));
    assert.equal((await state(p, p.buyer.token)).accessEpoch, originalEpoch);
    fresh = await pausedZip(p.base + "/download", p.admin);
    await db.$executeRawUnsafe(
      "DROP TRIGGER reject_t25_stream_followup ON project_access_revocations",
    );
    await db.$executeRawUnsafe("DROP FUNCTION reject_t25_stream_followup()");
    const status = data(
      await request(
        "GET",
        `/v1/projects/${p.projectId}/withdrawal-status`,
        p.buyer.token,
      ),
      200,
    );
    assert.equal(status.changes[0].applied, true);
    assert.equal((await original.finish()).completed, false);
    const received = await fresh.finish();
    assert.equal(
      received.completed,
      true,
      "old sequence must not abort a new authorized stream in the same epoch",
    );
    assert.equal(received.bytes.length, p.packed.bytes);
    assert.equal(
      createHash("sha256").update(received.bytes).digest("hex"),
      p.packed.sha256,
    );
  } finally {
    original.response.destroy();
    fresh?.response.destroy();
    await db.$executeRawUnsafe(
      "DROP TRIGGER IF EXISTS reject_t25_stream_followup ON project_access_revocations",
    );
    await db.$executeRawUnsafe(
      "DROP FUNCTION IF EXISTS reject_t25_stream_followup()",
    );
  }
});
test("withdrawal in a separate project does not interrupt a currently authorized ZIP stream", async () => {
  const p = await productExportStream(),
    unrelated = await bound(),
    stream = await pausedZip(p.url, p.headers);
  try {
    data(
      (await choose(unrelated, unrelated.narrator.token, "collection", false))
        .response,
    );
    const received = await stream.finish();
    assert.equal(received.completed, true);
    assert.equal(received.bytes.length, p.packed.bytes);
    assert.equal(
      createHash("sha256").update(received.bytes).digest("hex"),
      p.packed.sha256,
    );
  } finally {
    stream.response.destroy();
  }
});
