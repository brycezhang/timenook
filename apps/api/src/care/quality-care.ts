import { PrivacyRights } from "./privacy-rights";
import {
  Body,
  Controller,
  Get,
  Post,
  Param,
  ParseUUIDPipe,
  Req,
  Header,
  Inject,
  Injectable,
  OnModuleDestroy,
  NotFoundException,
  ForbiddenException,
  ConflictException,
  BadRequestException,
  Res,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiTags,
  ApiHeader,
  ApiProperty,
  ApiCookieAuth,
} from "@nestjs/swagger";
import {
  IsUUID,
  IsIn,
  IsString,
  MaxLength,
  Matches,
  IsInt,
  Min,
  IsISO8601,
  Equals,
  IsOptional,
  IsArray,
  ArrayNotEmpty,
  ArrayMaxSize,
  ArrayUnique,
} from "class-validator";
import { Prisma, PrismaClient, QualityRequest } from "@prisma/client";
import { randomUUID } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { QUALITY_REASONS, ADMIN_PERMISSIONS } from "@timenook/contracts";
import type {
  QualityReason,
  QualityRequestView,
  QualityAttemptOption,
  QualityScope,
} from "@timenook/contracts";
import { API_CONFIG, ApiConfig } from "../config";
import { IdentityAccess } from "../identity/identity-access";
import { hash, idempotencyKey } from "../payments/orders";
import { Participation } from "../identity/participation";
import { AdminAccess } from "../admin/admin-access";
import { Refunds } from "../payments/refunds";
import { FirstCopies } from "../books/first-copy";
import { Books } from "../books/books";
import { Fulfillment } from "../books/fulfillment";
import { ProjectServiceTerms } from "../projects/service-terms";
import { ProjectStreams } from "../media/project-streams";
type Tx = Prisma.TransactionClient;
class QualityVersionDto {
  @ApiProperty() @IsInt() @Min(1) expectedVersion!: number;
}
class AssignQualityDto extends QualityVersionDto {
  @ApiProperty() @IsISO8601() dueAt!: string;
  @ApiProperty() @Matches(/^synthetic:[^\r\n]{3,160}$/) evidenceRef!: string;
}
class QualityAccessDto extends QualityVersionDto {
  @ApiProperty({ enum: ["pdf", "evidence"], isArray: true })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(2)
  @ArrayUnique()
  @IsIn(["pdf", "evidence"], { each: true })
  scopes!: QualityScope[];
  @ApiProperty() @IsISO8601() expiresAt!: string;
  @ApiProperty() @Equals(true) consented!: true;
  @ApiProperty() @Equals("synthetic-d08-v1") noticeVersion!: string;
  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  assistedSessionId?: string;
}
class ReviewQualityDto extends QualityVersionDto {
  @ApiProperty({ enum: ["reprint", "refund"] })
  @IsIn(["reprint", "refund"])
  resolution!: "reprint" | "refund";
  @ApiProperty({ enum: ["original", "revised"], required: false })
  @IsOptional()
  @IsIn(["original", "revised"])
  mode?: "original" | "revised";
  @ApiProperty() @Matches(/^synthetic:[^\r\n]{3,160}$/) evidenceRef!: string;
}
class QualityReprintDto extends QualityVersionDto {
  @ApiProperty() @IsUUID() bookVersionId!: string;
  @ApiProperty() @Matches(/^[a-f0-9]{64}$/) snapshotHash!: string;
  @ApiProperty() @Matches(/^[a-f0-9]{64}$/) pdfHash!: string;
  @ApiProperty() @Matches(/^[a-f0-9]{64}$/) addressHash!: string;
}
class RequestQualityDto {
  @ApiProperty() @IsUUID() attemptId!: string;
  @ApiProperty({ enum: QUALITY_REASONS })
  @IsIn(QUALITY_REASONS)
  reason!: QualityReason;
  @ApiProperty()
  @IsString()
  @MaxLength(1500)
  @Matches(/\S/)
  description!: string;
}
@Injectable()
export class QualityCare implements OnModuleDestroy {
  readonly db: PrismaClient;
  private readonly terms: ProjectServiceTerms;
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly identity: IdentityAccess,
    private readonly rights: PrivacyRights,
    private readonly participation: Participation,
    private readonly books: Books,
    private readonly copies: FirstCopies,
    private readonly refunds: Refunds,
    private readonly streams: ProjectStreams,
    private readonly fulfillment: Fulfillment,
  ) {
    this.db = new PrismaClient({ datasourceUrl: config.databaseUrl });
    this.terms = new ProjectServiceTerms(config.databaseUrl);
  }
  private async evidenceTermsIn(tx: Tx, projectId: string) {
    await this.rights.requireAvailableIn(tx, projectId, "activeData");
    const terms = await this.terms.read(projectId, tx);
    if (
      !terms.retention?.activeData ||
      terms.retention.activeData.state === "deleted"
    )
      throw new ForbiddenException("Quality evidence retention is unavailable");
  }
  private async locked(tx: Tx, orderId: string) {
    await tx.$queryRaw`SELECT id FROM payment_orders WHERE id=${orderId}::uuid FOR UPDATE`;
    const order = await tx.paymentOrder.findUnique({ where: { id: orderId } }),
      project = await tx.project.findUnique({ where: { orderId } });
    if (!order || order.state !== "paid" || !project)
      throw new NotFoundException();
    await tx.$queryRaw`SELECT id FROM projects WHERE id=${project.id}::uuid FOR UPDATE`;
    const subject = await tx.projectSubject.findUniqueOrThrow({
      where: { projectId: project.id },
    });
    return {
      order,
      project: await tx.project.findUniqueOrThrow({
        where: { id: project.id },
      }),
      subject,
    };
  }
  private async product<T>(
    orderId: string,
    authorization: string | undefined,
    work: (
      tx: Tx,
      ctx: Awaited<ReturnType<QualityCare["locked"]>>,
      userId: string,
    ) => Promise<T>,
  ) {
    return this.db.$transaction(async (tx) => {
      const user = await this.identity.current(authorization, tx),
        ctx = await this.locked(tx, orderId);
      if (user.id !== ctx.order.buyerId && user.id !== ctx.subject.boundUserId)
        throw new NotFoundException();
      return work(tx, ctx, user.id);
    });
  }
  private async option(tx: Tx, attemptId: string) {
    const attempt = await tx.fulfillmentAttempt.findUniqueOrThrow({
        where: { id: attemptId },
      }),
      book = await tx.bookVersion.findUniqueOrThrow({
        where: { id: attempt.bookId },
      });
    return {
      id: attempt.id,
      sequence: attempt.sequence,
      bookVersion: book.version,
      bookVersionId: attempt.bookId,
      snapshotHash: attempt.snapshotHash,
      pdfHash: attempt.pdfHash,
      addressHash: attempt.addressHash,
      deliveredAt: attempt.deliveredAt?.toISOString() ?? null,
      tracking: (await this.participation.activeDataDeletedIn(
        tx,
        attempt.projectId,
      ))
        ? null
        : (attempt.tracking as unknown as QualityAttemptOption["tracking"]),
    };
  }
  async viewIn(tx: Tx, row: QualityRequest): Promise<QualityRequestView> {
    const erased = await this.rights.deletedIn(tx, row.projectId);
    const refund = row.refundId
      ? await tx.refund.findUniqueOrThrow({ where: { id: row.refundId } })
      : null;
    if (
      refund &&
      ["succeeded", "closed", "rejected"].includes(refund.state) &&
      row.state !== "completed"
    ) {
      row = await tx.qualityRequest.update({
        where: { id: row.id },
        data: { state: "completed", version: { increment: 1 } },
      });
      await tx.careRequest.update({
        where: { id: row.caseId },
        data: { state: "completed", completedBy: row.ownerAdminId },
      });
    }
    const original = await this.option(tx, row.originalAttemptId),
      owner = row.ownerAdminId
        ? await tx.adminAccount.findUnique({ where: { id: row.ownerAdminId } })
        : null,
      grant = await tx.qualityGrant.findFirst({
        where: { requestId: row.id },
        orderBy: { sequence: "desc" },
      }),
      attempt = await tx.fulfillmentAttempt.findFirst({
        where: { qualityRequestId: row.id },
        orderBy: { sequence: "desc" },
      });
    return {
      id: row.id,
      caseId: row.caseId,
      orderId: row.orderId,
      productionOrderId: row.productionOrderId,
      projectId: row.projectId,
      version: row.version,
      reason: row.reason as QualityReason,
      state: row.state as QualityRequestView["state"],
      original: { ...original, attemptId: original.id },
      createdAt: row.createdAt.toISOString(),
      ownerLabel: owner?.username ?? null,
      dueAt: row.dueAt?.toISOString() ?? null,
      assignedAt: row.assignedAt?.toISOString() ?? null,
      reviewedAt: row.reviewedAt?.toISOString() ?? null,
      resolution: row.resolution as QualityRequestView["resolution"],
      reprintMode: row.reprintMode as QualityRequestView["reprintMode"],
      replacement: erased
        ? null
        : await this.copies.qualityReplacementIn(tx, row.id),
      grant:
        !erased && grant
          ? {
              expiresAt: grant.expiresAt.toISOString(),
              scopes: grant.scopes as QualityScope[],
            }
          : null,
      productionAttemptId: attempt?.id ?? null,
      productionState: attempt?.state ?? null,
      refund: refund ? { id: refund.id, state: refund.state } : null,
    };
  }
  list(orderId: string, authorization?: string) {
    return this.product(orderId, authorization, async (tx) => {
      const production = await tx.firstCopyOrder.findUnique({
          where: { paymentOrderId: orderId },
        }),
        attempts = production
          ? await tx.fulfillmentAttempt.findMany({
              where: { orderId: production.id, state: "delivered" },
              orderBy: { sequence: "desc" },
            })
          : [];
      return {
        orderId,
        attempts: await Promise.all(attempts.map((a) => this.option(tx, a.id))),
        requests: await Promise.all(
          (
            await tx.qualityRequest.findMany({
              where: { orderId },
              orderBy: { createdAt: "desc" },
            })
          ).map((r) => this.viewIn(tx, r)),
        ),
      };
    });
  }
  request(
    orderId: string,
    authorization: string | undefined,
    body: RequestQualityDto,
    key: string,
  ) {
    const requestedAt = new Date();
    return this.product(
      orderId,
      authorization,
      async (tx, { order, project, subject }, userId) => {
        const prior = await tx.qualityRequest.findUnique({
          where: {
            orderId_requesterId_requestKey: {
              orderId,
              requesterId: userId,
              requestKey: key,
            },
          },
        });
        if (prior) {
          if (prior.requestHash !== hash(body)) throw new ConflictException();
          return this.viewIn(tx, prior);
        }
        await this.evidenceTermsIn(tx, project.id);
        const production = await tx.firstCopyOrder.findUnique({
            where: { paymentOrderId: orderId },
          }),
          attempt = await tx.fulfillmentAttempt.findFirst({
            where: {
              id: body.attemptId,
              projectId: project.id,
              state: "delivered",
            },
          });
        if (
          !production ||
          !attempt ||
          attempt.orderId !== production.id ||
          !attempt.deliveredAt
        )
          throw new ConflictException("Delivered original production required");
        const id = randomUUID(),
          caseId = randomUUID();
        await tx.careRequest.create({
          data: {
            id: caseId,
            projectId: project.id,
            requesterId: userId,
            requesterSubjectId: subject.id,
            operatorId: userId,
            operatorRealm: "product",
            sourceBindingVersion: subject.bindingVersion,
            sourceAccessEpoch: project.accessEpoch,
            idempotencyKey: `quality:${key}`,
            requestHash: hash(body),
            kind: "quality",
            createdAt: requestedAt,
          },
        });
        const row = await tx.qualityRequest.create({
          data: {
            id,
            caseId,
            orderId,
            productionOrderId: production.id,
            projectId: project.id,
            originalAttemptId: attempt.id,
            requesterId: userId,
            reason: body.reason,
            requestKey: key,
            requestHash: hash(body),
            createdAt: requestedAt,
          },
        });
        await tx.qualityEvidence.create({
          data: {
            requestId: id,
            projectId: project.id,
            description: body.description.trim(),
          },
        });
        return this.viewIn(tx, row);
      },
    );
  }
  private async caseIn(tx: Tx, caseId: string) {
    const found = await tx.qualityRequest.findUnique({ where: { caseId } });
    if (!found) throw new NotFoundException();
    const context = await this.locked(tx, found.orderId);
    return {
      ...context,
      row: await tx.qualityRequest.findUniqueOrThrow({
        where: { id: found.id },
      }),
    };
  }
  private async command(
    tx: Tx,
    row: QualityRequest,
    actorId: string,
    action: string,
    key: string,
    body: unknown,
  ) {
    const where = {
        requestId_actorId_action_key: {
          requestId: row.id,
          actorId,
          action,
          key,
        },
      },
      prior = await tx.qualityCommand.findUnique({ where });
    if (prior) {
      if (prior.requestHash !== hash(body)) throw new ConflictException();
      return false;
    }
    await tx.qualityCommand.create({
      data: {
        requestId: row.id,
        actorId,
        action,
        key,
        requestHash: hash(body),
      },
    });
    return true;
  }
  async readIn(tx: Tx, caseId: string) {
    return this.viewIn(tx, (await this.caseIn(tx, caseId)).row);
  }
  async assignIn(
    tx: Tx,
    caseId: string,
    actorId: string,
    body: AssignQualityDto,
    key: string,
  ) {
    const { row, order } = await this.caseIn(tx, caseId);
    const payloadDeleted = await this.participation.activeDataDeletedIn(
      tx,
      row.projectId,
    );
    if (!(await this.command(tx, row, actorId, "assign", key, body)))
      return this.viewIn(tx, row);
    if (row.version !== body.expectedVersion || row.state !== "requested")
      throw new ConflictException();
    const d06 = (order.packageSnapshot as any).admission?.d06;
    if (
      d06?.review?.state !== "frozen" ||
      !d06.businessCalendarRef ||
      !d06.afterSales?.ownerRef ||
      !d06.afterSales?.procedureRef
    )
      throw new ConflictException("Frozen D06 operating procedure required");
    if (Date.parse(body.dueAt) <= Date.now())
      throw new BadRequestException(
        "Verified future operational deadline required",
      );
    return this.viewIn(
      tx,
      await tx.qualityRequest.update({
        where: { id: row.id },
        data: {
          state: "assigned",
          version: { increment: 1 },
          ownerAdminId: actorId,
          assignedAt: new Date(),
          dueAt: new Date(body.dueAt),
          assignmentEvidenceRef: payloadDeleted ? undefined : body.evidenceRef,
        },
      }),
    );
  }
  access(
    orderId: string,
    id: string,
    authorization: string | undefined,
    body: QualityAccessDto,
    key: string,
  ) {
    return this.product(
      orderId,
      authorization,
      async (tx, { order, project, subject }, userId) => {
        const row = await tx.qualityRequest.findFirst({
          where: { id, orderId },
        });
        if (!row) throw new NotFoundException();
        if (!row.ownerAdminId || row.state === "completed")
          throw new ConflictException();
        const expiry = Date.parse(body.expiresAt);
        if (expiry <= Date.now() || expiry > Date.now() + 1800000)
          throw new BadRequestException();
        if (
          !(await this.participation.subjectCareGrantIn(tx, {
            projectId: project.id,
            subjectId: subject.id,
            bindingVersion: subject.bindingVersion,
            accessEpoch: project.accessEpoch,
            operatorUserId: userId,
            assistedSessionId: body.assistedSessionId,
          }))
        )
          throw new ForbiddenException();
        const original = await tx.fulfillmentAttempt.findUniqueOrThrow({
          where: { id: row.originalAttemptId },
        });
        if (body.scopes.includes("evidence"))
          await this.evidenceTermsIn(tx, project.id);
        if (body.scopes.includes("pdf"))
          await this.books.frozenOutputIn(
            tx,
            project.id,
            original.bookId,
            original.pdfHash,
          );
        if (subject.boundUserId !== userId) {
          if (!body.assistedSessionId) throw new ForbiddenException();
          await this.participation.recordAssistedVersionEvidence(tx, {
            projectId: project.id,
            sessionId: body.assistedSessionId,
            operatorUserId: userId,
            content: {
              kind: "book",
              versionId: original.bookId,
              hash: original.snapshotHash,
            },
            action: "quality_care_access",
            noticeVersion: body.noticeVersion,
            evidenceRef: `synthetic:quality-${row.id}-${hash(key).slice(0, 16)}`,
            idempotencyKey: key,
          });
        }
        if (!(await this.command(tx, row, userId, "access", key, body)))
          return this.viewIn(tx, row);
        if (row.version !== body.expectedVersion) throw new ConflictException();
        const fence = await this.streams.fence(project.id, false);
        await tx.qualityGrant.create({
          data: {
            id: randomUUID(),
            accessSequence: fence.sequence,
            projectId: project.id,
            requestId: row.id,
            ownerAdminId: row.ownerAdminId,
            actorId: userId,
            assistedSessionId:
              subject.boundUserId === userId ? null : body.assistedSessionId,
            subjectId: subject.id,
            bindingVersion: subject.bindingVersion,
            accessEpoch: project.accessEpoch,
            scopes: body.scopes,
            expiresAt: new Date(body.expiresAt),
            noticeVersion: body.noticeVersion,
          },
        });
        return this.viewIn(tx, row);
      },
    );
  }
  private async scopeIn(tx: Tx, caseId: string, actorId: string) {
    const context = await this.caseIn(tx, caseId),
      { row, order, project, subject } = context,
      grant = await tx.qualityGrant.findFirst({
        where: { requestId: row.id },
        orderBy: { sequence: "desc" },
      }),
      care = await tx.careRequest.findUniqueOrThrow({
        where: { id: row.caseId },
      });
    if (
      !grant ||
      row.ownerAdminId !== actorId ||
      grant.ownerAdminId !== actorId ||
      row.state === "completed" ||
      care.state === "completed" ||
      grant.expiresAt.getTime() <= Date.now() ||
      grant.subjectId !== subject.id ||
      grant.bindingVersion !== subject.bindingVersion ||
      grant.accessEpoch !== project.accessEpoch
    )
      throw new ForbiddenException();
    if (
      !(await this.participation.subjectCareGrantIn(tx, {
        projectId: project.id,
        subjectId: subject.id,
        bindingVersion: subject.bindingVersion,
        accessEpoch: project.accessEpoch,
        operatorUserId: grant.actorId,
        assistedSessionId: grant.assistedSessionId,
      }))
    )
      throw new ForbiddenException();
    if (
      (await this.streams.fence(project.id, false)).sequence !==
      grant.accessSequence
    )
      throw new ForbiddenException(
        "Fresh quality permission required after withdrawal",
      );
    return { ...context, grant };
  }
  async materialsIn(tx: Tx, caseId: string, actorId: string) {
    const { row, grant } = await this.scopeIn(tx, caseId, actorId),
      original = await tx.fulfillmentAttempt.findUniqueOrThrow({
        where: { id: row.originalAttemptId },
      }),
      evidence = grant.scopes.includes("evidence")
        ? await tx.qualityEvidence.findUnique({ where: { requestId: row.id } })
        : null,
      output = grant.scopes.includes("pdf")
        ? await this.books.frozenOutputIn(
            tx,
            row.projectId,
            original.bookId,
            original.pdfHash,
          )
        : null;
    if (grant.scopes.includes("evidence"))
      await this.evidenceTermsIn(tx, row.projectId);
    return {
      description: evidence?.erasedAt ? null : (evidence?.description ?? null),
      pdf: output?.pdf ?? null,
      grantExpiresAt: grant.expiresAt.toISOString(),
    };
  }
  async pdfIn(tx: Tx, caseId: string, actorId: string) {
    const { row, grant } = await this.scopeIn(tx, caseId, actorId);
    if (!grant.scopes.includes("pdf")) throw new ForbiddenException();
    const original = await tx.fulfillmentAttempt.findUniqueOrThrow({
      where: { id: row.originalAttemptId },
    });
    return {
      projectId: row.projectId,
      ...(await this.books.frozenOutputIn(
        tx,
        row.projectId,
        original.bookId,
        original.pdfHash,
      )),
    };
  }
  async reviewIn(
    tx: Tx,
    caseId: string,
    actorId: string,
    body: ReviewQualityDto,
    key: string,
  ) {
    const { row, order } = await this.caseIn(tx, caseId);
    const payloadDeleted = await this.participation.activeDataDeletedIn(
      tx,
      row.projectId,
    );
    const minimumRefund = payloadDeleted && body.resolution === "refund";
    const scope = minimumRefund
      ? null
      : await this.scopeIn(tx, caseId, actorId);
    if (row.ownerAdminId !== actorId) throw new ForbiddenException();
    if (!(await this.command(tx, row, actorId, "review", key, body)))
      return this.viewIn(tx, row);
    if (
      row.version !== body.expectedVersion ||
      row.state !== "assigned" ||
      (!minimumRefund &&
        (!scope!.grant.scopes.includes("pdf") ||
          !scope!.grant.scopes.includes("evidence")))
    )
      throw new ConflictException();
    if (!minimumRefund) await this.evidenceTermsIn(tx, row.projectId);
    const original = await tx.fulfillmentAttempt.findUniqueOrThrow({
      where: { id: row.originalAttemptId },
    });
    if (!minimumRefund)
      await this.books.frozenOutputIn(
        tx,
        row.projectId,
        original.bookId,
        original.pdfHash,
      );
    const d07 = (order.packageSnapshot as any).admission?.d07,
      rule = d07?.[row.reason];
    if (
      d07?.review?.state !== "frozen" ||
      d07.qualityReprintUsesOriginalOrder !== true ||
      !rule ||
      !rule.policyRef ||
      !rule.ownerRef ||
      rule.requestWindow?.startsAt !== "delivered" ||
      rule.requestWindow.duration?.unit !== "calendar_days" ||
      !Number.isSafeInteger(rule.requestWindow.duration.value) ||
      rule.requestWindow.duration.value <= 0
    )
      throw new ConflictException("Purchased frozen quality policy required");
    if (
      body.resolution === "reprint" &&
      (!body.mode ||
        !["reprint_or_refund", "resend_or_refund"].includes(rule.remedy))
    )
      throw new ConflictException("Purchased reprint remedy required");
    if (
      body.resolution === "refund" &&
      (body.mode ||
        !["refund", "reprint_or_refund", "resend_or_refund"].includes(
          rule.remedy,
        ) ||
        !rule.refundAmount?.value)
    )
      throw new ConflictException("Purchased refund remedy required");
    const delivery = await tx.fulfillmentDelivery.findUnique({
      where: { orderId: row.productionOrderId },
    });
    if (!delivery) throw new ConflictException();
    const start = delivery.occurredAt,
      end = new Date(
        start.getTime() + rule.requestWindow.duration.value * 86400000,
      );
    if (row.createdAt < start || row.createdAt >= end)
      throw new ConflictException(
        "Original quality request was outside the purchased window",
      );
    if (
      body.resolution === "reprint" &&
      (await tx.qualityRequest.findFirst({
        where: {
          productionOrderId: row.productionOrderId,
          id: { not: row.id },
          resolution: "reprint",
          state: { in: ["reviewed", "reprinting"] },
        },
      }))
    )
      throw new ConflictException(
        "An earlier original-order remedy remains active",
      );
    const updated = await tx.qualityRequest.update({
      where: { id: row.id },
      data: {
        state: "reviewed",
        version: { increment: 1 },
        resolution: body.resolution,
        reprintMode: body.mode ?? null,
        reviewedAt: new Date(),
        reviewEvidenceRef: payloadDeleted ? undefined : body.evidenceRef,
        requestWindowStartedAt: start,
        requestWindowEndsAt: end,
      },
    });
    await tx.careRequest.update({
      where: { id: row.caseId },
      data: {
        state: "verified",
        verifiedBy: actorId,
        verifiedAt: updated.reviewedAt,
        verificationEvidence: payloadDeleted ? undefined : body.evidenceRef,
      },
    });
    return this.viewIn(tx, updated);
  }
  async reprintIn(
    tx: Tx,
    caseId: string,
    actorId: string,
    body: QualityReprintDto,
    key: string,
  ) {
    const { row, grant } = await this.scopeIn(tx, caseId, actorId);
    if (!(await this.command(tx, row, actorId, "reprint", key, body)))
      return this.viewIn(tx, row);
    if (
      row.version !== body.expectedVersion ||
      !["reviewed", "reprinting"].includes(row.state) ||
      row.resolution !== "reprint" ||
      !grant.scopes.includes("pdf")
    )
      throw new ConflictException();
    await this.fulfillment.createQualityIn(tx, row.id, body, actorId, key);
    return this.viewIn(
      tx,
      await tx.qualityRequest.update({
        where: { id: row.id },
        data: { state: "reprinting", version: { increment: 1 } },
      }),
    );
  }
  refund(
    orderId: string,
    id: string,
    authorization: string | undefined,
    body: QualityVersionDto,
    key: string,
  ) {
    return this.product(
      orderId,
      authorization,
      async (tx, { order }, userId) => {
        if (userId !== order.buyerId) throw new ForbiddenException();
        const row = await tx.qualityRequest.findFirst({
          where: { id, orderId },
        });
        if (!row) throw new NotFoundException();
        if (!(await this.command(tx, row, userId, "refund", key, body)))
          return this.viewIn(tx, row);
        if (
          row.version !== body.expectedVersion ||
          row.state !== "reviewed" ||
          row.resolution !== "refund"
        )
          throw new ConflictException();
        // product() already holds the real session, this order and then project.
        // Preserve the timely original quality application when support reviews later.
        const refund = await this.refunds.requestIn(
          tx,
          orderId,
          userId,
          `quality:${row.id}`,
          {
            reason: row.reason as QualityReason,
            evidenceRef: `synthetic:quality-${row.id}`,
          },
          row.createdAt,
        );
        return this.viewIn(
          tx,
          await tx.qualityRequest.update({
            where: { id: row.id },
            data: {
              state: "refund_requested",
              version: { increment: 1 },
              refundId: refund.id,
            },
          }),
        );
      },
    );
  }
  async onModuleDestroy() {
    await Promise.all([this.db.$disconnect(), this.terms.close()]);
  }
}
@Controller("v1/orders/:orderId/quality-care")
@ApiTags("Quality care")
@ApiBearerAuth()
export class QualityCareController {
  constructor(private readonly care: QualityCare) {}
  @Post(":id/refund")
  @Header("Cache-Control", "no-store")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  async refund(
    @Param("orderId", ParseUUIDPipe) orderId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: QualityVersionDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.care.refund(
        orderId,
        id,
        req.headers.authorization,
        body,
        idempotencyKey(req),
      ),
      meta: { requestId: req.id },
    };
  }
  @Post(":id/access")
  @Header("Cache-Control", "no-store")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  async access(
    @Param("orderId", ParseUUIDPipe) orderId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: QualityAccessDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.care.access(
        orderId,
        id,
        req.headers.authorization,
        body,
        idempotencyKey(req),
      ),
      meta: { requestId: req.id },
    };
  }
  @Get() @Header("Cache-Control", "no-store") async list(
    @Param("orderId", ParseUUIDPipe) id: string,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.care.list(id, req.headers.authorization),
      meta: { requestId: req.id },
    };
  }
  @Post()
  @Header("Cache-Control", "no-store")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  async request(
    @Param("orderId", ParseUUIDPipe) id: string,
    @Body() body: RequestQualityDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.care.request(
        id,
        req.headers.authorization,
        body,
        idempotencyKey(req),
      ),
      meta: { requestId: req.id },
    };
  }
}

@Controller("v1/admin/quality/cases/:caseId")
@ApiTags("Administration quality care")
@ApiCookieAuth("timenook-admin")
export class AdminQualityCareController {
  constructor(
    private readonly care: QualityCare,
    private readonly access: AdminAccess,
    private readonly fulfillment: Fulfillment,
    private readonly streams: ProjectStreams,
  ) {}
  private run<T>(
    req: FastifyRequest,
    action: string,
    work: (tx: Tx, id: string) => Promise<T>,
  ) {
    return this.access.run(action, req, async () => {
      const actor = await this.access.authorized(
        req,
        ADMIN_PERMISSIONS.writeCare,
      );
      return this.access.command(
        req,
        ADMIN_PERMISSIONS.writeCare,
        (tx) => work(tx, actor.adminId!),
        req.method === "GET",
      );
    });
  }
  @Get() @Header("Cache-Control", "no-store") async read(
    @Param("caseId", ParseUUIDPipe) caseId: string,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.run(req, "quality.read", (tx) =>
        this.care.readIn(tx, caseId),
      ),
      meta: { requestId: req.id },
    };
  }
  @Post("assign")
  @Header("Cache-Control", "no-store")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  async assign(
    @Param("caseId", ParseUUIDPipe) caseId: string,
    @Body() body: AssignQualityDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.run(req, "quality.assign", (tx, id) =>
        this.care.assignIn(tx, caseId, id, body, idempotencyKey(req)),
      ),
      meta: { requestId: req.id },
    };
  }
  @Post("review")
  @Header("Cache-Control", "no-store")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  async review(
    @Param("caseId", ParseUUIDPipe) caseId: string,
    @Body() body: ReviewQualityDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.run(req, "quality.review", (tx, id) =>
        this.care.reviewIn(tx, caseId, id, body, idempotencyKey(req)),
      ),
      meta: { requestId: req.id },
    };
  }
  @Post("reprints")
  @Header("Cache-Control", "no-store")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  async reprint(
    @Param("caseId", ParseUUIDPipe) caseId: string,
    @Body() body: QualityReprintDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.run(req, "quality.reprint", async (tx, id) => {
        const account = await tx.adminAccount.findUniqueOrThrow({
          where: { id },
        });
        if (!account.permissions.includes(ADMIN_PERMISSIONS.writeFulfillment))
          throw new ForbiddenException();
        return this.care.reprintIn(tx, caseId, id, body, idempotencyKey(req));
      }),
      meta: { requestId: req.id },
    };
  }
  @Get("materials") @Header("Cache-Control", "no-store") async materials(
    @Param("caseId", ParseUUIDPipe) caseId: string,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.run(req, "quality.materials", (tx, id) =>
        this.care.materialsIn(tx, caseId, id),
      ),
      meta: { requestId: req.id },
    };
  }
  @Get("pdf") @Header("Cache-Control", "no-store") async pdf(
    @Param("caseId", ParseUUIDPipe) caseId: string,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const scope = await this.run(req, "quality.pdf", (tx, id) =>
        this.care.pdfIn(tx, caseId, id),
      ),
      fence = await this.streams.fence(scope.projectId, false),
      bytes = await this.fulfillment.readPdf(scope.path, scope.pdf);
    return reply
      .header("Cache-Control", "no-store")
      .header("Content-Type", "application/pdf")
      .header(
        "Content-Disposition",
        `attachment; filename="quality-${caseId}.pdf"`,
      )
      .header("Content-Length", bytes.length)
      .send(
        await this.streams.guard(
          scope.projectId,
          fence.epoch,
          bytes,
          () =>
            this.run(req, "quality.pdf", (tx, id) =>
              this.care.pdfIn(tx, caseId, id),
            ),
          undefined,
          fence.sequence,
          false,
        ),
      );
  }
}
