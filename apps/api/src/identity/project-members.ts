import { ForbiddenException } from "@nestjs/common";
import { USER_TERMS_VERSION } from "@timenook/contracts";
import type { Prisma } from "@prisma/client";

export const TERMS_VERSION = USER_TERMS_VERSION;

export async function acceptTermsIn(
  tx: Prisma.TransactionClient,
  userId: string,
  source: "wechat_login" | "invitation" | "web_login" | "gift",
) {
  return tx.termsAcceptance.upsert({
    where: { userId_version: { userId, version: TERMS_VERSION } },
    create: { userId, version: TERMS_VERSION, source },
    update: {},
  });
}

// The purchaser owns the project. Accepted invitees have the same project
// capabilities; the book's subject describes content, not a permission role.
export async function isProjectMemberIn(
  tx: Prisma.TransactionClient,
  projectId: string,
  userId: string,
) {
  const project = await tx.project.findUnique({ where: { id: projectId } });
  if (!project) return false;
  return (
    project.createdBy === userId ||
    !!(await tx.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId } },
    }))
  );
}

export async function requireProjectMemberIn(
  tx: Prisma.TransactionClient,
  projectId: string,
  userId: string,
) {
  if (!(await isProjectMemberIn(tx, projectId, userId)))
    throw new ForbiddenException("您尚未加入这个项目");
}
