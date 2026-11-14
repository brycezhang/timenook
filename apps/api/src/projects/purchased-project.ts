import { randomUUID } from "node:crypto";
import type { PaymentOrder, Prisma } from "@prisma/client";
import type { ProjectPlans } from "./project-plans";
import type { ProjectServiceTerms } from "./service-terms";
/** Purchases from all sources initialize the same book, subject and single first-copy entitlement. */
export async function initializePurchasedProjectIn(
  tx: Prisma.TransactionClient,
  plans: ProjectPlans,
  terms: ProjectServiceTerms,
  order: PaymentOrder,
  activatedAt: Date,
) {
  const projectId = randomUUID();
  await plans.createProject({ projectId, createdBy: order.buyerId }, tx);
  await tx.project.update({
    where: { id: projectId },
    data: { orderId: order.id, bookTitle: order.bookTitle },
  });
  await tx.projectSubject.create({
    data: {
      id: randomUUID(),
      projectId,
      name: order.subjectName,
      boundUserId: order.purchaseKind === "self" ? order.buyerId : null,
      bindingVersion: order.purchaseKind === "self" ? 1 : 0,
    },
  });
  await tx.firstCopyEntitlement.create({
    data: { id: randomUUID(), orderId: order.id, projectId },
  });
  await terms.activate(
    tx,
    projectId,
    order.packageVersionId,
    order.packageSnapshot,
    activatedAt,
  );
  return projectId;
}
