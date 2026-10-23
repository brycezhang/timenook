import { Prisma, PrismaClient } from "@prisma/client";
import { PaymentIdempotencyConflict } from "../payments/errors";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
const DAY = 86400000;
type Duration = { value: number; unit: "calendar_days" };
type WindowRule = { duration: Duration; startsAt: string };
type FixedPolicy = {
  d02: {
    duration: Duration;
    startsAt: "subject_participation";
    notStarted: {
      maxWait: Duration;
      startsAt: "payment_verified";
      resolution: "contact_and_offer_refund";
    };
    pause: { clock: "stops"; maxTotal: Duration; atLimit: "resume_clock" };
    expiration: {
      newRecording: "blocked";
      firstCopy: "manual_review";
      existingData: "per_d03";
    };
  };
  d03: {
    onlinePlayback: WindowRule;
    exportRequests: WindowRule;
    retention: Record<string, WindowRule>;
    deletion: unknown;
  };
};
const days = (v: Duration) =>
  Number.isSafeInteger(v?.value) && v.value > 0 && v.unit === "calendar_days";
// One selected synthetic policy shape, not a policy engine. Unsupported or
// missing commercial choices remain pending and grant no timed capability.
function fixedPolicy(value: unknown): FixedPolicy | null {
  const p = value as FixedPolicy;
  if (!p?.d02 || !p?.d03) return null;
  const d = p.d02;
  if (
    !days(d.duration) ||
    d.startsAt !== "subject_participation" ||
    !days(d.notStarted?.maxWait) ||
    d.notStarted.startsAt !== "payment_verified" ||
    d.notStarted.resolution !== "contact_and_offer_refund" ||
    d.pause?.clock !== "stops" ||
    !days(d.pause.maxTotal) ||
    d.pause.atLimit !== "resume_clock" ||
    d.expiration?.newRecording !== "blocked" ||
    d.expiration.firstCopy !== "manual_review" ||
    d.expiration.existingData !== "per_d03"
  )
    return null;
  for (const w of [p.d03.onlinePlayback, p.d03.exportRequests])
    if (!days(w?.duration) || w.startsAt !== "delivery_completed") return null;
  if (
    !p.d03.retention ||
    !Object.values(p.d03.retention).every(
      (w) =>
        days(w.duration) &&
        ["delivery_completed", "export_ready", "processing_completed"].includes(
          w.startsAt,
        ),
    )
  )
    return null;
  return p;
}
function window(start: Date | null, duration: Duration, now: Date) {
  const end = start ? new Date(start.getTime() + duration.value * DAY) : null;
  return {
    state: !end ? "not_started" : now < end ? "active" : "expired",
    startsAt: start?.toISOString() ?? null,
    expiresAt: end?.toISOString() ?? null,
  };
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
  // Caller must verify the operator, shared support case and CSRF (AdminAccess).
  async changePause(
    command: {
      projectId: string;
      eventId: string;
      kind: "pause" | "resume";
      operatorId: string;
      supportCaseRef: string;
    },
    transaction?: Prisma.TransactionClient,
  ) {
    if (
      !["pause", "resume"].includes(command.kind) ||
      !/^[-A-Za-z0-9_:]{8,128}$/.test(command.eventId) ||
      !/^record:[A-Za-z0-9_:-]{3,120}$/.test(command.supportCaseRef) ||
      !/^[-a-f0-9]{36}$/.test(command.operatorId)
    )
      throw new BadRequestException();
    const write = async (tx: Prisma.TransactionClient) => {
      await tx.$queryRaw`SELECT id FROM projects WHERE id=${command.projectId}::uuid FOR UPDATE`;
      const row = await tx.projectServiceTerms.findUnique({
        where: { projectId: command.projectId },
      });
      if (!row) throw new NotFoundException();
      const policy = fixedPolicy(row.policy);
      if (!policy) throw new ConflictException();
      const prior = await tx.projectServiceEvent.findUnique({
        where: {
          projectId_eventId: {
            projectId: command.projectId,
            eventId: command.eventId,
          },
        },
      });
      if (prior) {
        if (
          prior.kind !== command.kind ||
          prior.operatorId !== command.operatorId ||
          prior.supportCaseRef !== command.supportCaseRef
        )
          throw new PaymentIdempotencyConflict();
        return;
      }
      const now = this.now();
      const events = await tx.projectServiceEvent.findMany({
        where: { projectId: command.projectId },
        orderBy: { occurredAt: "asc" },
      });
      const participation =
        events.find((e) => e.kind === "subject_participation")?.occurredAt ??
        null;
      const clock = pauseClock(
        events,
        now,
        policy.d02.pause.maxTotal.value * DAY,
      );
      if (
        !participation ||
        events.some((e) => e.occurredAt > now) ||
        now.getTime() >=
          participation.getTime() +
            policy.d02.duration.value * DAY +
            clock.total ||
        (command.kind === "pause" &&
          (clock.paused ||
            clock.total >= policy.d02.pause.maxTotal.value * DAY)) ||
        (command.kind === "resume" && !clock.open)
      )
        throw new ConflictException();
      await tx.projectServiceEvent.create({
        data: { ...command, occurredAt: now },
      });
    };
    return transaction ? write(transaction) : this.database.$transaction(write);
  }
  async read(
    projectId: string,
    at = this.now(),
    transaction?: Prisma.TransactionClient,
  ) {
    const database = transaction ?? this.database;
    const row = await database.projectServiceTerms.findUnique({
      where: { projectId },
    });
    if (!row) throw new NotFoundException();
    const policy = fixedPolicy(row.policy);
    if (!policy)
      return { policyStatus: "pending", deleteData: false, canRecord: false };
    const events = await database.projectServiceEvent.findMany({
      where: { projectId, occurredAt: { lte: at } },
    });
    const participation =
      events.find((e) => e.kind === "subject_participation")?.occurredAt ??
      null;
    const delivery =
      events.find((e) => e.kind === "delivery_completed")?.occurredAt ?? null;
    const clock = pauseClock(events, at, policy.d02.pause.maxTotal.value * DAY);
    const creation = window(
      participation ? new Date(participation.getTime() + clock.total) : null,
      policy.d02.duration,
      at,
    );
    creation.startsAt = participation?.toISOString() ?? null;
    if (clock.paused && creation.state === "active") creation.state = "paused";
    return {
      policyStatus: "synthetic-fixed-policy",
      creation,
      pause: {
        usedMilliseconds: clock.total,
        maxMilliseconds: policy.d02.pause.maxTotal.value * DAY,
      },
      firstCopyAction:
        creation.state === "expired" ? "manual_review" : "available",
      playback: window(delivery, policy.d03.onlinePlayback.duration, at),
      exportRequests: window(delivery, policy.d03.exportRequests.duration, at),
      retention: Object.fromEntries(
        Object.entries(policy.d03.retention).map(([name, rule]) => [
          name,
          {
            ...window(
              rule.startsAt === "delivery_completed" ? delivery : null,
              rule.duration,
              at,
            ),
            trigger: rule.startsAt,
          },
        ]),
      ),
      notStarted: {
        reviewAt: new Date(
          row.activatedAt.getTime() + policy.d02.notStarted.maxWait.value * DAY,
        ).toISOString(),
        action: participation
          ? "none"
          : at.getTime() >=
              row.activatedAt.getTime() +
                policy.d02.notStarted.maxWait.value * DAY
            ? "contact_and_offer_refund"
            : "await_participation",
      },
      deleteData: false,
      canRecord: creation.state === "active",
    };
  }
  async close() {
    await this.database.$disconnect();
  }
}

function pauseClock(
  events: { kind: string; occurredAt: Date }[],
  at: Date,
  cap: number,
) {
  let total = 0;
  let open: Date | null = null;
  for (const event of [...events]
    .filter((e) => e.occurredAt <= at)
    .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())) {
    if (event.kind === "pause") open = event.occurredAt;
    if (event.kind === "resume" && open) {
      total += event.occurredAt.getTime() - open.getTime();
      open = null;
    }
  }
  if (open) total += at.getTime() - open.getTime();
  return {
    total: Math.min(cap, total),
    paused: !!open && total < cap,
    open: !!open,
  };
}
