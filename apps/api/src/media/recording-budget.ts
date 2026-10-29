import { readProjectAdmissionIn } from "../projects/project-admission";
import { ServiceUnavailableException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

export async function recordingQuotaIn(
  tx: Prisma.TransactionClient,
  projectId: string,
) {
  const { snapshot } = await readProjectAdmissionIn(tx, projectId);
  const admission = snapshot.admission as Prisma.JsonObject | undefined;
  const d04 = admission?.d04 as Prisma.JsonObject | undefined;
  const quotas = d04?.userQuotas as Prisma.JsonObject | undefined;
  const per = quotas?.recordingPerClip as Prisma.JsonObject | undefined,
    total = quotas?.recordingTotal as Prisma.JsonObject | undefined;
  if (
    (d04?.review as Prisma.JsonObject)?.state !== "frozen" ||
    per?.unit !== "seconds" ||
    total?.unit !== "seconds" ||
    !Number.isSafeInteger(per.value) ||
    !Number.isSafeInteger(total.value) ||
    Number(per.value) < 1 ||
    Number(total.value) < 1
  )
    throw new ServiceUnavailableException();
  return {
    perClipMs: Math.min(Number(per.value) * 1000, 300000),
    totalMs: Number(total.value) * 1000,
  };
}

export async function recordingUsageIn(
  tx: Prisma.TransactionClient,
  projectId: string,
) {
  const sum = await tx.recordingIntent.aggregate({
    where: { projectId },
    _sum: { reservedMs: true, consumedMs: true },
  });
  return {
    reservedMs: sum._sum.reservedMs ?? 0,
    consumedMs: sum._sum.consumedMs ?? 0,
  };
}

/** Snapshot only: recording-start never creates an upload reservation. */
export async function recordingBudgetIn(
  tx: Prisma.TransactionClient,
  projectId: string,
) {
  const quota = await recordingQuotaIn(tx, projectId),
    usage = await recordingUsageIn(tx, projectId);
  return Math.max(
    0,
    Math.min(
      quota.perClipMs,
      quota.totalMs - usage.reservedMs - usage.consumedMs,
    ),
  );
}
