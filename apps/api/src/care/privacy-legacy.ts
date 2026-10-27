import type { PrivacyRights } from "./privacy-rights";
/** One-way upgrade of pre-journal rights facts. Only original immutable IDs,
 * times and captured scopes are published; no present-day target is inferred. */
export async function importLegacyPrivacy(rights: PrivacyRights) {
  const revocations = await rights.db.projectAccessRevocation.findMany({
    orderBy: { sequence: "asc" },
  });
  for (const original of revocations)
    await rights.db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM projects WHERE id=${original.projectId}::uuid FOR UPDATE`;
        if (
          (
            await tx.$queryRaw<
              { id: string }[]
            >`SELECT id FROM privacy_events WHERE id=${original.id}::uuid`
          ).length
        )
          return;
        const row = await tx.projectAccessRevocation.findUniqueOrThrow({
          where: { id: original.id },
        });
        const change =
          row.reason === "rebind"
            ? await tx.bindingChange.findFirst({
                where: {
                  projectId: row.projectId,
                  accessEpoch: row.accessEpoch,
                },
              })
            : null;
        let payload: Record<string, unknown>;
        if (row.captureVersion !== 1 || (row.reason === "rebind" && !change)) {
          payload = {
            operation: "legacy_hold",
            reason:
              row.reason === "rebind"
                ? "BINDING_HISTORY_REVIEW_REQUIRED"
                : "LEGACY_CAPTURE_REVIEW_REQUIRED",
            originalKind: "revocation",
            permanentDeletion: false,
            purpose: row.purpose,
            originalAccessEpoch: row.accessEpoch,
          };
        } else
          payload = {
            operation: "revoke",
            revocationId: row.id,
            sequence: row.sequence,
            accessEpoch: row.accessEpoch,
            purpose: row.purpose,
            reason: row.reason,
            taskFences: row.taskFences,
            sourceSessionId: row.sourceSessionId,
            targetAttemptId: row.targetAttemptId,
            ...(change
              ? {
                  binding: {
                    id: change.subjectId,
                    bindingVersion: change.bindingVersion,
                    boundUserId: change.toUserId,
                  },
                }
              : {}),
          };
        await rights.publishIn(tx, {
          eventId: row.id,
          projectId: row.projectId,
          kind: "revocation",
          occurredAt: row.createdAt.toISOString(),
          payload,
        });
      },
      { timeout: 30000 },
    );
  const denials = await rights.db.storyDecision.findMany({
    where: {
      method: { not: "journal_denial" },
      OR: [{ confirmed: false }, { allowInBook: false }],
    },
    orderBy: { sequence: "asc" },
    select: {
      id: true,
      projectId: true,
      storyId: true,
      revisionId: true,
      contentHash: true,
      subjectId: true,
      operatorUserId: true,
      bindingVersion: true,
      accessEpoch: true,
      method: true,
      noticeVersion: true,
      confirmed: true,
      allowInBook: true,
      idempotencyKey: true,
      requestHash: true,
      assistedEvidenceId: true,
      contentKind: true,
      createdAt: true,
    },
  });
  for (const row of denials)
    await rights.db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM projects WHERE id=${row.projectId}::uuid FOR UPDATE`;
        if (
          (
            await tx.$queryRaw<
              { id: string }[]
            >`SELECT id FROM privacy_events WHERE id=${row.id}::uuid`
          ).length
        )
          return;
        const { createdAt, ...decision } = row;
        await rights.publishIn(tx, {
          eventId: row.id,
          projectId: row.projectId,
          kind: "revocation",
          occurredAt: createdAt.toISOString(),
          payload: { operation: "story_decision", decision },
        });
      },
      { timeout: 30000 },
    );
  const deletions = await rights.db.careRequest.findMany({
    where: { kind: "delete", state: { in: ["verified", "completed"] } },
    orderBy: { createdAt: "asc" },
  });
  for (const row of deletions)
    await rights.db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM projects WHERE id=${row.projectId}::uuid FOR UPDATE`;
        if (
          (
            await tx.$queryRaw<
              { id: string }[]
            >`SELECT id FROM privacy_events WHERE id=${row.id}::uuid`
          ).length
        )
          return;
        // T12/T24 verified requests did not capture erasure/task/production targets.
        // Persist the known whole-project denial, keep every cleanup layer pending.
        await rights.publishIn(tx, {
          eventId: row.id,
          projectId: row.projectId,
          kind: "deletion",
          occurredAt: (row.verifiedAt || row.createdAt).toISOString(),
          payload: {
            operation: "legacy_hold",
            reason: row.verifiedAt
              ? "LEGACY_DELETION_SCOPE_REVIEW_REQUIRED"
              : "LEGACY_VERIFICATION_TIME_REVIEW_REQUIRED",
            originalKind: "delete",
            permanentDeletion: !!row.verifiedAt,
            requestId: row.id,
            effectiveAt: (row.verifiedAt || row.createdAt).toISOString(),
            originalBindingVersion: row.sourceBindingVersion,
            originalAccessEpoch: row.sourceAccessEpoch,
          },
        });
      },
      { timeout: 30000 },
    );
}
