import { BadRequestException, ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
/** Caller already holds the project lock; commands store no private result. */
export async function claimRecordingCommand(
  tx: Prisma.TransactionClient,
  projectId: string,
  operatorUserId: string,
  key: string | undefined,
  command: unknown,
) {
  if (!key || !/^[-A-Za-z0-9_:]{8,128}$/.test(key))
    throw new BadRequestException();
  const requestHash = createHash("sha256")
    .update(JSON.stringify(command))
    .digest("hex");
  const where = {
    projectId_operatorUserId_idempotencyKey: {
      projectId,
      operatorUserId,
      idempotencyKey: key,
    },
  };
  const prior = await tx.recordingCommand.findUnique({ where });
  if (prior && prior.requestHash !== requestHash) throw new ConflictException();
  if (!prior)
    await tx.recordingCommand.create({
      data: { projectId, operatorUserId, idempotencyKey: key, requestHash },
    });
}
