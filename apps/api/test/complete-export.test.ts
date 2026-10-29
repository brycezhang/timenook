import { randomUUID, createHash } from "node:crypto";
import assert from "node:assert/strict";
import {
  startBookFixture,
  stopBookFixture,
  bound,
  choose,
  request,
  data,
  login,
  app,
  config,
  db,
  storyPhoto,
  interceptBookObjectRead,
  restartBookApplication,
  root,
  project,
  interview,
  sealedClip,
  state,
} from "./book-fixture";
import { readyFirstCopyBook } from "./first-copy-fixture";
import { paymentAdmin } from "./payment-admin-fixture";
import { spawnSync } from "node:child_process";
import { ProjectServiceTerms } from "../src/projects/service-terms";
import { join } from "node:path";
import { access, rm, readFile, writeFile } from "node:fs/promises";
import { startProductionWorker } from "../src/tasks/worker";
import { Deletions } from "../src/care/deletions";
import { before, after, test } from "node:test";
import {
  requestedBook,
  adminRequest,
  acceptedBook,
  anotherAcceptedExport,
  photoDeadline,
} from "./complete-export-fixture";

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
  assert.equal(packed.expiresAt, null);
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
  assert.notEqual(status.requests[0].missingReason, "EXPORT_SOURCE_DELETED");
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

test("without-WeChat export uses a separately verified subject recipient and leaves a delivery receipt", async () => {
  const p = await project(),
    admin = await paymentAdmin(config, app, ["care:write"]),
    generic = `/v1/admin/projects/${p.projectId}/care-requests`;
  const noCollection = await state(p, p.buyer.token);
  assert.equal(noCollection.canRead, false);
  assert.equal(
    noCollection.choices.find(
      (c: { purpose: string }) => c.purpose === "collection",
    )?.granted,
    null,
  );
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
