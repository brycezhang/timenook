import { NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  ACCEPTANCE_INPUT_QUOTAS,
  ACCEPTANCE_PROVIDER_BUDGET,
} from "./internal-profile";

/** Apply current acceptance limits without changing the immutable order snapshot. */
export function projectInputPolicy(
  snapshot: Prisma.JsonObject,
): Prisma.JsonObject | undefined {
  const admission = snapshot.admission as Prisma.JsonObject | undefined;
  const policy = admission?.d04 as Prisma.JsonObject | undefined;
  if (
    policy &&
    (snapshot.scope === "paid-e2e" || snapshot.scope === "internal-acceptance")
  )
    return {
      ...policy,
      userQuotas: ACCEPTANCE_INPUT_QUOTAS,
      providerBudget: ACCEPTANCE_PROVIDER_BUDGET,
    };
  return policy;
}

export async function readProjectAdmissionIn(
  tx: Prisma.TransactionClient,
  projectId: string,
) {
  const project = await tx.project.findUnique({ where: { id: projectId } });
  if (!project) throw new NotFoundException();
  const internal = await tx.internalProjectAdmission.findUnique({
    where: { projectId },
  });
  if (project.orderId) {
    if (internal) throw new NotFoundException();
    const order = await tx.paymentOrder.findUnique({
      where: { id: project.orderId },
    });
    if (!order || order.state !== "paid" || project.createdBy !== order.buyerId)
      throw new NotFoundException();
    return {
      project: { ...project, bookTitle: project.bookTitle ?? order.bookTitle },
      source: "paid" as const,
      initiatorUserId: order.buyerId,
      snapshot: order.packageSnapshot as Prisma.JsonObject,
    };
  }
  if (
    !internal ||
    internal.initiatorUserId !== project.createdBy ||
    (internal.snapshot as Prisma.JsonObject).scope !== "internal-acceptance"
  )
    throw new NotFoundException();
  return {
    project,
    source: "internal-acceptance" as const,
    initiatorUserId: internal.initiatorUserId,
    snapshot: internal.snapshot as Prisma.JsonObject,
  };
}
