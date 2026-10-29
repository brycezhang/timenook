import { Prisma, PrismaClient } from "@prisma/client";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
const MATERIALS = [
  "originalAudio",
  "originalPhotos",
  "derivedAudio",
  "derivedPhotos",
  "transcripts",
  "confirmedStories",
  "bookPdf",
  "exportPackages",
  "activeData",
  "historicalObjects",
  "backupCopies",
] as const;
function lifetimePolicy(value: unknown) {
  const p = value as {
    d02?: { service?: string };
    d03?: {
      onlinePlayback?: { service?: string };
      exportRequests?: { service?: string };
      retention?: Record<string, { service?: string }>;
    };
  };
  return (
    p?.d02?.service === "lifetime" &&
    p.d03?.onlinePlayback?.service === "lifetime" &&
    p.d03.exportRequests?.service === "lifetime" &&
    MATERIALS.every((kind) => p.d03?.retention?.[kind]?.service === "lifetime")
  );
}
export class ProjectServiceTerms {
  private readonly database: PrismaClient;
  constructor(
    databaseUrl: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.database = new PrismaClient({ datasourceUrl: databaseUrl });
  }
  async activate(
    tx: Prisma.TransactionClient,
    projectId: string,
    packageVersionId: string,
    packageSnapshot: Prisma.JsonValue,
    paidAt: Date,
  ) {
    const snapshot = packageSnapshot as {
      admission?: { d02?: Prisma.InputJsonValue; d03?: Prisma.InputJsonValue };
    };
    await tx.projectServiceTerms.create({
      data: {
        projectId,
        packageVersionId,
        activatedAt: paidAt,
        policy: {
          d02: snapshot.admission?.d02 ?? null,
          d03: snapshot.admission?.d03 ?? null,
        },
      },
    });
  }
  // Trusted server-to-server composition boundary for T11/T23, never user input.
  async recordFact(
    command: {
      projectId: string;
      eventId: string;
      kind: "subject_participation" | "delivery_completed";
      occurredAt: Date;
    },
    transaction?: Prisma.TransactionClient,
  ) {
    if (
      !["subject_participation", "delivery_completed"].includes(command.kind) ||
      !/^[-A-Za-z0-9_:]{8,128}$/.test(command.eventId) ||
      !Number.isFinite(command.occurredAt.getTime()) ||
      command.occurredAt > this.now()
    )
      throw new BadRequestException();
    const write = async (tx: Prisma.TransactionClient) => {
      await tx.$queryRaw`SELECT id FROM projects WHERE id=${command.projectId}::uuid FOR UPDATE`;
      const terms = await tx.projectServiceTerms.findUnique({
        where: { projectId: command.projectId },
      });
      if (!terms) throw new NotFoundException();
      if (command.occurredAt < terms.activatedAt) throw new ConflictException();
      const sameKey = await tx.projectServiceEvent.findUnique({
        where: {
          projectId_eventId: {
            projectId: command.projectId,
            eventId: command.eventId,
          },
        },
      });
      const sameFact = await tx.projectServiceEvent.findFirst({
        where: { projectId: command.projectId, kind: command.kind },
      });
      const prior = sameKey ?? sameFact;
      if (prior) {
        if (
          prior.kind !== command.kind ||
          prior.occurredAt.getTime() !== command.occurredAt.getTime()
        )
          throw new ConflictException();
        return;
      }
      await tx.projectServiceEvent.create({ data: command });
    };
    return transaction ? write(transaction) : this.database.$transaction(write);
  }
  // Trusted participation composition; caller keeps the project lock through its
  // binding/session write. Existing facts preserve their original server time.
  async ensureSubjectParticipation(
    tx: Prisma.TransactionClient,
    projectId: string,
    subjectId: string,
  ) {
    await tx.$queryRaw`SELECT id FROM projects WHERE id=${projectId}::uuid FOR UPDATE`;
    const subject = await tx.projectSubject.findUnique({
      where: { projectId },
    });
    if (!subject || subject.id !== subjectId) throw new NotFoundException();
    const prior = await tx.projectServiceEvent.findFirst({
      where: { projectId, kind: "subject_participation" },
    });
    if (prior) return prior.occurredAt;
    const occurredAt = this.now();
    await this.recordFact(
      {
        projectId,
        eventId: `subject-participation:${subjectId}`,
        kind: "subject_participation",
        occurredAt,
      },
      tx,
    );
    return occurredAt;
  }
  async read(projectId: string, transaction?: Prisma.TransactionClient) {
    const database = transaction ?? this.database;
    const row = await database.projectServiceTerms.findUnique({
      where: { projectId },
    });
    if (!row) throw new NotFoundException();
    if (!lifetimePolicy(row.policy))
      return { policyStatus: "pending", deleteData: false, canRecord: false };
    const erasedRows = await database.$queryRaw<
      { categories: string[] }[]
    >`SELECT categories FROM privacy_deletions WHERE project_id=${projectId}::uuid AND scoped_export_id IS NULL`;
    const erased = new Set(erasedRows.flatMap((r) => r.categories));
    const available = (category?: string) => ({
      state:
        erased.has("all") || (category && erased.has(category))
          ? "deleted"
          : "active",
      startsAt: row.activatedAt.toISOString(),
      expiresAt: null,
    });
    const creation = available("activeData");
    const project = await database.project.findUnique({
      where: { id: projectId },
    });
    const order = project?.orderId
      ? await database.paymentOrder.findUnique({
          where: { id: project.orderId },
        })
      : null;
    if (order?.creationState === "terminated") creation.state = "terminated";
    else if (order?.creationState === "suspended") creation.state = "suspended";
    return {
      policyStatus: "lifetime",
      creation,
      firstCopyAction: creation.state === "active" ? "available" : "blocked",
      playback: available("originalAudio"),
      exportRequests: available("activeData"),
      retention: Object.fromEntries(
        MATERIALS.map((name) => [name, available(name)]),
      ),
      deleteData: false,
      canRecord: creation.state === "active",
    };
  }
  async close() {
    await this.database.$disconnect();
  }
}
