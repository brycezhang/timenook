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
  login,
  app,
  config,
  state,
  readyStory,
  db,
  restartBookApplication,
} from "./book-fixture";
before(startBookFixture);
after(stopBookFixture);
test("the narrator sees the committed purpose withdrawal and minimal disposition after collection access stops", async () => {
  const p = await bound();
  data((await choose(p, p.narrator.token, "collection", true)).response);
  const before = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/withdrawal-status`,
      p.narrator.token,
    ),
    200,
  );
  assert.deepEqual(before.changes, []);
  const changed = data(
    (await choose(p, p.narrator.token, "collection", false)).response,
  );
  assert.equal(changed.canRead, false);
  const status = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/withdrawal-status`,
      p.narrator.token,
    ),
    200,
  );
  assert.equal(status.accessEpoch, changed.accessEpoch);
  assert.equal(status.changes.length, 1);
  assert.equal(status.changes[0].purpose, "collection");
  assert.equal(status.changes[0].applied, true);
  assert.equal(status.changes[0].productionAction, "not_started");
  assert.ok(status.boundary.includes("纸书"));
  assert.equal(status.subjectName, undefined);
  assert.equal(status.book, undefined);
  assert.equal(
    (
      await request(
        "GET",
        `/v1/projects/${p.projectId}/withdrawal-status`,
        (await login()).token,
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (await request("GET", `/v1/projects/${p.projectId}/withdrawal-status`))
      .statusCode,
    401,
  );
});

import { readyReservedFirstCopy } from "./first-copy-fixture";
import { paymentAdmin } from "./payment-admin-fixture";
async function operator() {
  return paymentAdmin(config, app, [
    "fulfillment:write",
    "care:write",
    "audit:read",
  ]);
}
async function admin(
  url: string,
  headers: Record<string, string>,
  body: object,
) {
  return app.inject({
    method: "POST",
    url,
    headers: { ...headers, "idempotency-key": randomUUID() },
    payload: body,
  });
}
async function production() {
  const p = await readyReservedFirstCopy(),
    headers = await operator(),
    base = `/v1/admin/fulfillment/${p.order.id}`;
  const view = data(
    await admin(base + "/attempts", headers, {
      ...p.binding,
      supplierRef: "record:synthetic-provider",
      dueAt: new Date(Date.now() + 86400000).toISOString(),
    }),
  );
  const attempt = view.current;
  data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/fulfillment/grants`,
      p.narrator.token,
      {
        ...p.binding,
        attemptId: attempt.id,
        expiresAt: new Date(Date.now() + 600000).toISOString(),
        noticeVersion: "synthetic-d08-v1",
        evidenceRef: `synthetic:withdraw-grant-${randomUUID()}`,
      },
    ),
  );
  return {
    ...p,
    headers,
    base,
    attempt,
    attemptBase: `${base}/attempts/${attempt.id}`,
  };
}
test("withdrawal stops a prepared handoff without releasing the reserved first copy", async () => {
  const p = await production();
  data((await choose(p, p.narrator.token, "sharing", false)).response);
  const status = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/withdrawal-status`,
      p.narrator.token,
    ),
    200,
  );
  assert.equal(status.production.state, "cancelled");
  assert.equal(status.changes[0].productionAction, "stopped_before_handoff");
  const view = await app.inject({
    method: "GET",
    url: p.base,
    headers: p.headers,
  });
  assert.equal(data(view, 200).entitlementState, "reserved");
  assert.equal(
    (
      await admin(p.attemptBase + "/handoff", p.headers, {
        evidenceRef: "synthetic:late-handoff",
      })
    ).statusCode,
    409,
  );
});
test("a handed-off file stays pending supplier confirmation after withdrawal and survives API restart", async () => {
  const p = await production();
  data(
    await admin(p.attemptBase + "/handoff", p.headers, {
      evidenceRef: "synthetic:handoff-before-withdrawal",
    }),
  );
  data((await choose(p, p.narrator.token, "collection", false)).response);
  let status = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/withdrawal-status`,
      p.narrator.token,
    ),
    200,
  );
  assert.equal(status.production.state, "cancellation_pending");
  assert.equal(status.changes[0].productionAction, "supplier_pending");
  await restartBookApplication();
  status = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/withdrawal-status`,
      p.narrator.token,
    ),
    200,
  );
  assert.equal(status.production.state, "cancellation_pending");
  assert.equal(status.changes.length, 1);
});
import http from "node:http";
import { createHash } from "node:crypto";
import { interview, formUpload, syntheticAudio } from "./book-fixture";
for (const change of ["withdrawal", "rebind"] as const)
  test(`a real backpressured private audio response is terminated after the committed ${change}`, async () => {
    const p = await bound(),
      i = await interview(p);
    // Valid ID3 padding makes the real private transfer larger than socket buffers;
    // the pinned CI validator needs only its supported MP3 decoder, never an encoder.
    const paddingBytes = 1800000,
      header = Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]);
    for (let index = 0; index < 4; index++)
      header[6 + index] = (paddingBytes >> (7 * (3 - index))) & 0x7f;
    const audio = Buffer.concat([
      header,
      Buffer.alloc(paddingBytes),
      syntheticAudio(),
    ]);
    const base = `/v1/projects/${p.projectId}/interviews/${i.id}/clips`;
    const clip = data(
      await request("POST", base, p.narrator.token, {
        clientClipId: randomUUID(),
        bytes: audio.length,
        sha256: createHash("sha256").update(audio).digest("hex"),
      }),
    );
    const form = data(
      await request("POST", `${base}/${clip.id}/upload`, p.narrator.token, {}),
    );
    assert.equal(
      (await formUpload(app, form, audio, {}, p.narrator.token)).statusCode,
      204,
    );
    data(
      await request("POST", `${base}/${clip.id}/seal`, p.narrator.token, {}),
    );
    if (!app.getHttpServer().listening) await app.listen(0, "127.0.0.1");
    const server = await app.getUrl();
    const response = await new Promise<http.IncomingMessage>(
      (resolve, reject) => {
        http
          .get(
            `${server}${base}/${clip.id}/content`,
            { headers: { authorization: `Bearer ${p.narrator.token}` } },
            resolve,
          )
          .on("error", reject);
      },
    );
    assert.equal(response.statusCode, 200);
    let count = 0;
    await new Promise<void>((resolve, reject) =>
      response
        .once("data", (chunk) => {
          count += chunk.length;
          response.pause();
          resolve();
        })
        .once("error", reject),
    );
    const closed = new Promise<boolean>((resolve) => {
      response.once("aborted", () => resolve(true));
      response.once("end", () => resolve(false));
      response.on("error", () => {});
    });
    if (change === "withdrawal")
      data((await choose(p, p.narrator.token, "collection", false)).response);
    else {
      const next = await login(),
        current = await state(p, p.narrator.token),
        headers = await operator();
      const care = data(
        await admin(
          `/v1/admin/projects/${p.projectId}/care-requests`,
          headers,
          {
            kind: "rebind",
            targetUserId: next.id,
            expectedBindingVersion: current.bindingVersion,
          },
        ),
      );
      data(
        await admin(`/v1/admin/projects/${p.projectId}/rebind`, headers, {
          supportCaseRef: `record:${care.id}`,
          targetUserId: next.id,
          expectedBindingVersion: current.bindingVersion,
          noticeVersion: "synthetic-d08-v1",
          evidenceRef: "synthetic:rebind-active-stream",
        }),
      );
      const rebound = await state(p, next.token);
      assert.equal(rebound.subjectId, p.subjectId);
      assert.equal(rebound.canRead, false);
    }
    response.on("data", (chunk) => {
      count += chunk.length;
    });
    response.resume();
    assert.equal(await closed, true);
    assert.ok(count < audio.length, `${count}/${audio.length}`);
    assert.equal(
      (await request("GET", `${base}/${clip.id}/content`, p.narrator.token))
        .statusCode,
      403,
    );
  });
import { sealedClip } from "./book-fixture";
import { ProductionTasks } from "../src/tasks/tasks";
test("AI withdrawal invalidates pending processing and a late worker cannot create a transcript, while collection remains readable", async () => {
  const p = await bound(),
    i = await interview(p),
    sealed = await sealedClip(p, i.id);
  const taskStatus = data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/tasks/status`,
      p.narrator.token,
      { interviewId: i.id },
    ),
  );
  const task = taskStatus[0];
  assert.ok(task);
  data((await choose(p, p.narrator.token, "ai", false)).response);
  const denied = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/tasks/${task.id}`,
      p.narrator.token,
    ),
    200,
  );
  assert.equal(denied.state, "invalidated");
  await app.get(ProductionTasks).run(task.id);
  const after = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/tasks/${task.id}`,
      p.narrator.token,
    ),
    200,
  );
  assert.equal(after.originalTranscript, null);
  assert.equal(after.retryable, false);
  assert.equal(
    (
      await request(
        "GET",
        `${sealed.base}/${sealed.clip.id}/content`,
        p.narrator.token,
      )
    ).statusCode,
    200,
  );
});
test("the payer cannot choose a narrator purpose, and verified Care withdrawal applies only the requested purpose", async () => {
  const p = await bound();
  for (const purpose of ["collection", "ai", "sharing"] as const)
    data((await choose(p, p.narrator.token, purpose, true)).response);
  assert.equal(
    (await choose(p, p.buyer.token, "collection", false)).response.statusCode,
    403,
  );
  const current = await state(p, p.narrator.token),
    headers = await operator();
  const opened = data(
    await admin(`/v1/admin/projects/${p.projectId}/care-requests`, headers, {
      kind: "withdraw",
      purpose: "ai",
      expectedBindingVersion: current.bindingVersion,
    }),
  );
  data(
    await admin(`/v1/admin/care-requests/${opened.id}/verify`, headers, {
      noticeVersion: "synthetic-d08-v1",
      evidenceRef: "synthetic:verified-ai-only",
      expectedBindingVersion: current.bindingVersion,
      expectedAccessEpoch: current.accessEpoch,
    }),
  );
  const after = await state(p, p.narrator.token);
  assert.equal(after.canProcessAi, false);
  assert.equal(after.canRead, true);
  assert.equal(
    after.choices.find((c: any) => c.purpose === "sharing").granted,
    true,
  );
  const status = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/withdrawal-status`,
      p.narrator.token,
    ),
    200,
  );
  assert.equal(status.changes[0].purpose, "ai");
  assert.equal(status.changes[0].reason, "care_verified");
});

test("withdrawal races with confirmation, first-copy submission and handoff without reopening content or creating another attempt", async () => {
  const p = await production();
  const results = await Promise.all([
    choose(p, p.narrator.token, "collection", false),
    request(
      "POST",
      `/v1/projects/${p.projectId}/first-copy/confirmations`,
      p.narrator.token,
      {
        role: "narrator",
        bookVersionId: p.binding.bookVersionId,
        snapshotHash: p.binding.snapshotHash,
        pdfHash: p.binding.pdfHash,
        noticeVersion: "synthetic-d08-v1",
        evidenceRef: `synthetic:race-${randomUUID()}`,
      },
    ),
    request(
      "POST",
      `/v1/projects/${p.projectId}/first-copy/submit`,
      p.buyer.token,
      p.binding,
    ),
    admin(p.attemptBase + "/handoff", p.headers, {
      evidenceRef: "synthetic:race-handoff",
    }),
  ]);
  data(results[0].response);
  for (const response of results.slice(1) as Awaited<
    ReturnType<typeof request>
  >[])
    assert.ok([201, 403, 409].includes(response.statusCode), response.body);
  const status = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/withdrawal-status`,
      p.narrator.token,
    ),
    200,
  );
  assert.ok(
    ["cancelled", "cancellation_pending"].includes(status.production.state),
  );
  assert.equal(
    (await request("GET", `/v1/projects/${p.projectId}/book`, p.narrator.token))
      .statusCode,
    403,
  );
  const view = data(
    await app.inject({ method: "GET", url: p.base, headers: p.headers }),
    200,
  );
  assert.equal(view.attempts.length, 1);
  assert.equal(view.entitlementState, "reserved");
});
test("a committed denial survives a follow-up fault and pending work is reconciled without resurrecting access", async () => {
  const p = await bound();
  data((await choose(p, p.narrator.token, "collection", true)).response);
  await db.$executeRawUnsafe(
    "CREATE FUNCTION reject_t24_followup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic revocation followup fault'; END $$",
  );
  await db.$executeRawUnsafe(
    "CREATE TRIGGER reject_t24_followup BEFORE UPDATE ON project_access_revocations FOR EACH ROW EXECUTE FUNCTION reject_t24_followup()",
  );
  try {
    assert.equal(
      (await choose(p, p.narrator.token, "collection", false)).response
        .statusCode,
      500,
    );
    assert.equal(
      (await request("GET", `/v1/projects/${p.projectId}`, p.narrator.token))
        .statusCode,
      403,
    );
  } finally {
    await db.$executeRawUnsafe(
      "DROP TRIGGER reject_t24_followup ON project_access_revocations",
    );
    await db.$executeRawUnsafe("DROP FUNCTION reject_t24_followup()");
  }
  await restartBookApplication();
  const status = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/withdrawal-status`,
      p.narrator.token,
    ),
    200,
  );
  assert.equal(status.changes[0].applied, true);
  assert.equal((await state(p, p.narrator.token)).canRead, false);
});

import { project as unboundProject } from "./book-fixture";
async function assistedChoice(
  p: { projectId: string; buyer: { token: string } },
  purpose: string,
  granted: boolean,
) {
  const current = await state(p, p.buyer.token);
  const sessions = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/assisted-sessions`,
      p.buyer.token,
    ),
    200,
  ).sessions;
  const latest = sessions.find((row: any) => row.purpose === purpose);
  return request(
    "POST",
    `/v1/projects/${p.projectId}/assisted-sessions`,
    p.buyer.token,
    {
      purpose,
      granted,
      noticeVersion: "synthetic-d08-v1",
      evidenceRef: `synthetic:recovery-${randomUUID()}`,
      expectedBindingVersion: current.bindingVersion,
      expectedAccessEpoch: current.accessEpoch,
      ...(latest ? { expectedSessionId: latest.id } : {}),
    },
  );
}
async function assistedSealed(
  p: { projectId: string; buyer: { token: string } },
  collection: string,
  audio = syntheticAudio(),
) {
  const interview = data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/interviews`,
      p.buyer.token,
      {
        clientInterviewId: randomUUID(),
        expectedPlanRevision: 1,
        starterKind: "free-narration",
        assistedSessionId: collection,
      },
    ),
  );
  const base = `/v1/projects/${p.projectId}/interviews/${interview.id}/clips`;
  const clip = data(
    await request("POST", base, p.buyer.token, {
      clientClipId: randomUUID(),
      bytes: audio.length,
      sha256: createHash("sha256").update(audio).digest("hex"),
      assistedSessionId: collection,
    }),
  );
  const form = data(
    await request("POST", `${base}/${clip.id}/upload`, p.buyer.token, {
      assistedSessionId: collection,
    }),
  );
  assert.equal(
    (await formUpload(app, form, audio, {}, p.buyer.token)).statusCode,
    204,
  );
  data(
    await request("POST", `${base}/${clip.id}/seal`, p.buyer.token, {
      assistedSessionId: collection,
    }),
  );
  const tasks = data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/tasks/status`,
      p.buyer.token,
      { interviewId: interview.id, assistedSessionId: collection },
    ),
  );
  return { base, clip, task: tasks[0] };
}
test("delayed assisted revocation recovery preserves a renewed session's new task and active stream in the same epoch", async () => {
  const p = await unboundProject(),
    collection = data(await assistedChoice(p, "collection", true));
  data(await assistedChoice(p, "ai", true));
  data(await assistedChoice(p, "sharing", true));
  await db.$executeRawUnsafe(
    "CREATE FUNCTION same_t24_scope_time() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.created_at := '2026-10-26T00:00:00Z'::timestamptz; RETURN NEW; END $$",
  );
  await db.$executeRawUnsafe(
    "CREATE TRIGGER same_t24_task_time BEFORE INSERT ON production_tasks FOR EACH ROW EXECUTE FUNCTION same_t24_scope_time()",
  );
  await db.$executeRawUnsafe(
    "CREATE TRIGGER same_t24_revoke_time BEFORE INSERT ON project_access_revocations FOR EACH ROW EXECUTE FUNCTION same_t24_scope_time()",
  );
  const original = await assistedSealed(p, collection.id),
    epoch = (await state(p, p.buyer.token)).accessEpoch;
  await db.$executeRawUnsafe(
    "CREATE FUNCTION reject_t24_scoped_followup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic scoped followup fault'; END $$",
  );
  await db.$executeRawUnsafe(
    "CREATE TRIGGER reject_t24_scoped_followup BEFORE UPDATE ON project_access_revocations FOR EACH ROW EXECUTE FUNCTION reject_t24_scoped_followup()",
  );
  let response: http.IncomingMessage | undefined;
  let fault = true;
  try {
    assert.equal(
      (await assistedChoice(p, "collection", false)).statusCode,
      500,
    );
    const renewed = data(await assistedChoice(p, "collection", true));
    const paddingBytes = 1800000,
      header = Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]);
    for (let index = 0; index < 4; index++)
      header[6 + index] = (paddingBytes >> (7 * (3 - index))) & 0x7f;
    const audio = Buffer.concat([
      header,
      Buffer.alloc(paddingBytes),
      syntheticAudio(),
    ]);
    const fresh = await assistedSealed(p, renewed.id, audio);
    assert.equal(fresh.task.state, "queued");
    assert.equal((await state(p, p.buyer.token)).accessEpoch, epoch);
    if (!app.getHttpServer().listening) await app.listen(0, "127.0.0.1");
    const server = await app.getUrl();
    response = await new Promise<http.IncomingMessage>((resolve, reject) =>
      http
        .get(
          `${server}${fresh.base}/${fresh.clip.id}/content`,
          { headers: { authorization: `Bearer ${p.buyer.token}` } },
          resolve,
        )
        .on("error", reject),
    );
    assert.equal(response.statusCode, 200);
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) =>
      response!
        .once("data", (chunk) => {
          chunks.push(chunk);
          response!.pause();
          resolve();
        })
        .once("error", reject),
    );
    const completed = new Promise<boolean>((resolve) => {
      response!.once("aborted", () => resolve(false));
      response!.once("end", () => resolve(true));
      response!.on("error", () => {});
    });
    await db.$executeRawUnsafe(
      "DROP TRIGGER reject_t24_scoped_followup ON project_access_revocations",
    );
    await db.$executeRawUnsafe("DROP FUNCTION reject_t24_scoped_followup()");
    fault = false;
    const disposition = data(
      await request(
        "GET",
        `/v1/projects/${p.projectId}/withdrawal-status`,
        p.buyer.token,
      ),
      200,
    );
    assert.equal(disposition.changes[0].createdAt, original.task.queuedAt);
    assert.equal(
      fresh.task.queuedAt,
      original.task.queuedAt,
      "a timestamp cannot distinguish the old and renewed work",
    );
    const after = data(
      await request(
        "GET",
        `/v1/projects/${p.projectId}/tasks/${fresh.task.id}`,
        p.buyer.token,
      ),
      200,
    );
    response.on("data", (chunk) => chunks.push(chunk));
    response.resume();
    const finished = await completed;
    assert.equal(
      after.state,
      "queued",
      "the old refusal cannot invalidate work created under renewed collection",
    );
    assert.equal(
      finished,
      true,
      "the old refusal cannot abort a stream started under renewed collection",
    );
    assert.deepEqual(Buffer.concat(chunks), audio);
    const old = data(
      await request(
        "GET",
        `/v1/projects/${p.projectId}/tasks/${original.task.id}`,
        p.buyer.token,
      ),
      200,
    );
    assert.equal(old.state, "invalidated");
  } finally {
    response?.destroy();
    await db.$executeRawUnsafe(
      "DROP TRIGGER same_t24_task_time ON production_tasks",
    );
    await db.$executeRawUnsafe(
      "DROP TRIGGER same_t24_revoke_time ON project_access_revocations",
    );
    await db.$executeRawUnsafe("DROP FUNCTION same_t24_scope_time()");
    if (fault) {
      await db.$executeRawUnsafe(
        "DROP TRIGGER reject_t24_scoped_followup ON project_access_revocations",
      );
      await db.$executeRawUnsafe("DROP FUNCTION reject_t24_scoped_followup()");
    }
  }
});
