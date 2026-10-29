import { createHash, randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import type { ApiConfig } from "../config";
import { ProjectPlans } from "./project-plans";
import { ProjectServiceTerms } from "./service-terms";
import { internalSnapshot } from "./internal-profile";

/** Operator-only composition; never registered as an HTTP route. */
export async function createInternalProject(
  config: ApiConfig,
  input: Record<string, unknown>,
) {
  if (
    !config.acceptance ||
    !config.web ||
    !config.privacyJournal ||
    config.payments
  )
    throw new ServiceUnavailableException();
  if (
    Object.keys(input).some(
      (key) =>
        ![
          "provisionKey",
          "initiatorUserId",
          "bookTitle",
          "subjectName",
        ].includes(key),
    ) ||
    typeof input.provisionKey !== "string" ||
    !/^[-A-Za-z0-9_:]{8,128}$/.test(input.provisionKey) ||
    typeof input.initiatorUserId !== "string" ||
    !/^[a-f0-9-]{36}$/.test(input.initiatorUserId) ||
    [input.bookTitle, input.subjectName].some(
      (value) =>
        value !== undefined &&
        (typeof value !== "string" || value.length > 120 || !value.trim()),
    )
  )
    throw new BadRequestException();
  const command = {
    provisionKey: input.provisionKey,
    initiatorUserId: input.initiatorUserId,
    bookTitle:
      (input.bookTitle as string | undefined)?.trim() ?? "内部验收故事书",
    subjectName: (input.subjectName as string | undefined)?.trim() ?? null,
    profileVersion: config.acceptance.profileVersion,
  };
  const requestHash = createHash("sha256")
    .update(JSON.stringify(command))
    .digest("hex");
  const db = new PrismaClient({ datasourceUrl: config.databaseUrl }),
    plans = new ProjectPlans(config.databaseUrl),
    terms = new ProjectServiceTerms(config.databaseUrl);
  try {
    return await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`internal-project:${command.provisionKey}`},0))`;
      const existing = await tx.internalProjectAdmission.findUnique({
        where: { provisionKey: command.provisionKey },
      });
      if (existing) {
        if (existing.requestHash !== requestHash) throw new ConflictException();
        return {
          projectId: existing.projectId,
          source: "internal-acceptance",
          admissionId: existing.id,
        };
      }
      if (
        !(await tx.user.findUnique({ where: { id: command.initiatorUserId } }))
      )
        throw new NotFoundException();
      const snapshot = internalSnapshot(command.profileVersion),
        projectId = randomUUID();
      await plans.createProject(
        { projectId, createdBy: command.initiatorUserId },
        tx,
      );
      await tx.project.update({
        where: { id: projectId },
        data: { bookTitle: command.bookTitle },
      });
      await tx.projectSubject.create({
        data: { id: randomUUID(), projectId, name: command.subjectName },
      });
      const admission = await tx.internalProjectAdmission.create({
        data: {
          id: randomUUID(),
          projectId,
          initiatorUserId: command.initiatorUserId,
          provisionKey: command.provisionKey,
          requestHash,
          profileVersion: command.profileVersion,
          snapshot,
        },
      });
      await terms.activateInternal(
        tx,
        projectId,
        admission.id,
        snapshot,
        admission.createdAt,
      );
      return {
        projectId,
        source: "internal-acceptance",
        admissionId: admission.id,
      };
    });
  } finally {
    await db.$disconnect();
    await plans.close();
    await terms.close();
  }
}
