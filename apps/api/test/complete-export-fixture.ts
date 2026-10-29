import { randomUUID, createHash } from "node:crypto";
import assert from "node:assert/strict";
import {
  request,
  data,
  login,
  app,
  config,
  db,
  project,
  interview,
  formUpload,
  syntheticAudio,
  state,
} from "./book-fixture";
import { readyFirstCopyBook } from "./first-copy-fixture";
import { paymentAdmin } from "./payment-admin-fixture";
import { ProjectServiceTerms } from "../src/projects/service-terms";
import http from "node:http";
import { ProductionTasks } from "../src/tasks/tasks";
import { performance } from "node:perf_hooks";

export async function adminRequest(
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

export async function requestedBook(
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

export async function acceptedBook(
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

export async function anotherAcceptedExport(
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

export async function photoDeadline(
  p: Awaited<ReturnType<typeof acceptedBook>>,
) {
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

export async function largeExportSources(
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

export async function pausedZip(url: string, headers: Record<string, string>) {
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

export async function assistedExportChoice(
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
  return acceptAlternativeCase(p);
}

export async function acceptAlternativeCase(
  p: Awaited<ReturnType<typeof project>>,
  existingAdmin?: Record<string, string>,
) {
  const admin =
      existingAdmin ?? (await paymentAdmin(config, app, ["care:write"])),
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

export async function alternativeExport() {
  const p = await acceptedAlternativeExport(),
    packed = data(await adminRequest("POST", p.base + "/pack", p.admin, {}));
  return { ...p, packed };
}

export async function alternativeWithdrawal(
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

export async function productExportStream() {
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

export async function streamExport(channel: "product" | "alternative") {
  if (channel === "product") return productExportStream();
  const p = await alternativeExport();
  return { ...p, url: p.base + "/download", headers: p.admin };
}

export async function pendingStreamExport(channel: "product" | "alternative") {
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

export async function rebindExport(
  p: Awaited<ReturnType<typeof streamExport>>,
) {
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

export async function observed(check: () => Promise<boolean>, message: string) {
  const deadline = performance.now() + 10000;
  while (!(await check())) {
    assert.ok(performance.now() < deadline, message);
  }
}
