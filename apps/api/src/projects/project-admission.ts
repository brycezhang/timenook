import { NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
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
      project,
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
