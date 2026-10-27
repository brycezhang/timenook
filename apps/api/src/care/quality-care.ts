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
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiTags,
  ApiHeader,
  ApiProperty,
} from "@nestjs/swagger";
import { IsUUID, IsIn, IsString, MaxLength, Matches } from "class-validator";
import { Prisma, PrismaClient, QualityRequest } from "@prisma/client";
import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { QUALITY_REASONS } from "@timenook/contracts";
import type {
  QualityReason,
  QualityRequestView,
  OrderQualityView,
} from "@timenook/contracts";
import { API_CONFIG, ApiConfig } from "../config";
import { IdentityAccess } from "../identity/identity-access";
import { hash, idempotencyKey } from "../payments/orders";
type Tx = Prisma.TransactionClient;
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
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly identity: IdentityAccess,
  ) {
    this.db = new PrismaClient({ datasourceUrl: config.databaseUrl });
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
      tracking: attempt.tracking as any,
    };
  }
  async viewIn(tx: Tx, row: QualityRequest): Promise<QualityRequestView> {
    const original = await this.option(tx, row.originalAttemptId);
    return {
      id: row.id,
      caseId: row.caseId,
      orderId: row.orderId,
      projectId: row.projectId,
      reason: row.reason as QualityReason,
      state: row.state as "requested",
      original: { ...original, attemptId: original.id },
      createdAt: row.createdAt.toISOString(),
      ownerLabel: null,
      dueAt: null,
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
    return this.product(
      orderId,
      authorization,
      async (tx, { order, project, subject }, userId) => {
        if (userId !== order.buyerId) throw new ForbiddenException();
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
  async onModuleDestroy() {
    await this.db.$disconnect();
  }
}
@Controller("v1/orders/:orderId/quality-care")
@ApiTags("Quality care")
@ApiBearerAuth()
export class QualityCareController {
  constructor(private readonly care: QualityCare) {}
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
