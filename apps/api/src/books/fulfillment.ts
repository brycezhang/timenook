import { ProjectStreams } from "../media/project-streams";
import {
  Injectable,
  Controller,
  Get,
  Post,
  Body,
  Param,
  ParseUUIDPipe,
  Req,
  Res,
  Header,
  Inject,
  OnModuleDestroy,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
  UnprocessableEntityException,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiTags,
  ApiProperty,
  ApiHeader,
} from "@nestjs/swagger";
import {
  IsUUID,
  IsISO8601,
  Matches,
  IsOptional,
  Equals,
  IsIn,
  IsString,
  MaxLength,
  ValidateNested,
  IsDefined,
} from "class-validator";
import { Type } from "class-transformer";
import type { FastifyRequest, FastifyReply } from "fastify";
import { Prisma, FirstCopyOrder, FulfillmentAttempt } from "@prisma/client";
import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type {
  FulfillmentView,
  FulfillmentAttemptView,
  FirstCopyBinding,
  FirstCopyAddress,
  FulfillmentMaterials,
  FulfillmentWechat,
} from "@timenook/contracts";
import { ADMIN_PERMISSIONS } from "@timenook/contracts";
import { Participation } from "../identity/participation";
import { AdminAccess } from "../admin/admin-access";
import { idempotencyKey } from "../payments/orders";
import { FirstCopies } from "./first-copy";
import { API_CONFIG, ApiConfig } from "../config";
import { ProjectServiceTerms } from "../projects/service-terms";
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const json = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value));
class BindingDto implements FirstCopyBinding {
  @ApiProperty() @IsUUID() bookVersionId!: string;
  @ApiProperty() @Matches(/^[a-f0-9]{64}$/) snapshotHash!: string;
  @ApiProperty() @Matches(/^[a-f0-9]{64}$/) pdfHash!: string;
  @ApiProperty() @Matches(/^[a-f0-9]{64}$/) addressHash!: string;
}
class AttemptDto extends BindingDto {
  @ApiProperty()
  @Matches(/^(synthetic|record):[^\r\n]{3,160}$/)
  supplierRef!: string;
  @ApiProperty() @IsISO8601() dueAt!: string;
}
class GrantDto extends BindingDto {
  @ApiProperty() @IsUUID() attemptId!: string;
  @ApiProperty() @IsISO8601() expiresAt!: string;
  @ApiProperty() @Equals("synthetic-d08-v1") noticeVersion!: string;
  @ApiProperty() @Matches(/^synthetic:[^\r\n]{3,160}$/) evidenceRef!: string;
  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  assistedSessionId?: string;
}
class EvidenceDto {
  @ApiProperty() @Matches(/^synthetic:[^\r\n]{3,160}$/) evidenceRef!: string;
}
class ReceiptDto extends EvidenceDto {
  @ApiProperty({
    enum: ["accepted", "unknown", "cancelled", "cancellation_rejected"],
  })
  @IsIn(["accepted", "unknown", "cancelled", "cancellation_rejected"])
  outcome!: "accepted" | "unknown" | "cancelled" | "cancellation_rejected";
}
class WechatDto implements FulfillmentWechat {
  @ApiProperty()
  @Equals("implemented_and_verified")
  handling!: "implemented_and_verified";
  @ApiProperty() @Matches(/^synthetic:[^\r\n]{3,160}$/) evidenceRef!: string;
  @ApiProperty({ enum: ["recorded", "pending", "failed"] })
  @IsIn(["recorded", "pending", "failed"])
  result!: "recorded" | "pending" | "failed";
}
class ShippingDto extends EvidenceDto {
  @ApiProperty() @IsString() @MaxLength(80) @Matches(/\S/) carrier!: string;
  @ApiProperty()
  @IsString()
  @MaxLength(80)
  @Matches(/^[A-Za-z0-9-]{3,80}$/)
  number!: string;
  @ApiProperty() @IsISO8601() shippedAt!: string;
  @ApiProperty({ type: WechatDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => WechatDto)
  wechat!: WechatDto;
}
class DeliveryDto extends EvidenceDto {
  @ApiProperty() @IsISO8601() deliveredAt!: string;
}
type SalesSnapshot = {
  admission?: {
    d08?: {
      platform?: { shippingManagement?: { requirementHandling?: string } };
      suppliers?: {
        printing?: {
          outcome?: string;
          providerRef?: string;
          dataKinds?: string[];
        };
      };
    };
  };
};
type Tx = Prisma.TransactionClient;
@Injectable()
export class Fulfillment implements OnModuleDestroy {
  private readonly terms: ProjectServiceTerms;
  constructor(
    private readonly participation: Participation,
    private readonly copies: FirstCopies,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {
    this.terms = new ProjectServiceTerms(config.databaseUrl);
  }
  private async supplierIn(tx: Tx, order: FirstCopyOrder) {
    const payment = await tx.paymentOrder.findUniqueOrThrow({
        where: { id: order.paymentOrderId },
      }),
      snapshot = payment.packageSnapshot as SalesSnapshot,
      supplier = snapshot.admission?.d08?.suppliers?.printing;
    return supplier?.outcome === "approved" &&
      supplier.providerRef &&
      isDeepStrictEqual([...(supplier.dataKinds ?? [])].sort(), [
        "production_pdf",
        "shipping_address",
      ])
      ? supplier.providerRef
      : null;
  }
  private binding(
    order: Pick<
      FirstCopyOrder,
      "bookId" | "snapshotHash" | "pdfHash" | "addressHash"
    >,
  ): FirstCopyBinding {
    return {
      bookVersionId: order.bookId,
      snapshotHash: order.snapshotHash,
      pdfHash: order.pdfHash,
      addressHash: order.addressHash,
    };
  }
  private matches(
    order: Pick<
      FirstCopyOrder,
      "bookId" | "snapshotHash" | "pdfHash" | "addressHash"
    >,
    body: FirstCopyBinding,
  ) {
    if (
      digest(this.binding(order)) !==
      digest({
        bookVersionId: body.bookVersionId,
        snapshotHash: body.snapshotHash,
        pdfHash: body.pdfHash,
        addressHash: body.addressHash,
      })
    )
      throw new ConflictException("Confirmed production binding required");
  }
  private async order(tx: Tx, id: string) {
    const row = await tx.firstCopyOrder.findUnique({ where: { id } });
    if (!row) throw new NotFoundException();
    await tx.$queryRaw`SELECT id FROM projects WHERE id=${row.projectId}::uuid FOR UPDATE`;
    return tx.firstCopyOrder.findUniqueOrThrow({ where: { id } });
  }
  private async command(
    tx: Tx,
    order: FirstCopyOrder,
    actorId: string,
    action: string,
    key: string,
    body: unknown,
    attemptId?: string,
  ) {
    if (!/^[-A-Za-z0-9_:]{8,128}$/.test(key)) throw new BadRequestException();
    const where = {
        projectId_actorId_action_key: {
          projectId: order.projectId,
          actorId,
          action,
          key,
        },
      },
      requestHash = digest(body),
      prior = await tx.fulfillmentCommand.findUnique({ where });
    if (prior) {
      if (prior.requestHash !== requestHash) throw new ConflictException();
      return { ...prior, fresh: false };
    }
    return {
      ...(await tx.fulfillmentCommand.create({
        data: { ...where.projectId_actorId_action_key, requestHash, attemptId },
      })),
      fresh: true,
    };
  }
  private async view(
    tx: Tx,
    projectId: string,
    actor?: {
      userId: string;
      subjectId: string;
      accessExpiresAt: string | null;
    },
  ): Promise<FulfillmentView> {
    const erased = await this.participation.activeDataPayloadExpiredIn(
      tx,
      projectId,
    );
    const order = await tx.firstCopyOrder.findUnique({ where: { projectId } }),
      terms = await this.terms.read(projectId, undefined, tx),
      subject = await tx.projectSubject.findUniqueOrThrow({
        where: { projectId },
      });
    const rows = order
      ? await tx.fulfillmentAttempt.findMany({
          where: { orderId: order.id },
          orderBy: { sequence: "desc" },
        })
      : [];
    const attempts: FulfillmentAttemptView[] = [];
    for (const row of rows) {
      const grant = await tx.fulfillmentGrant.findFirst({
        where: { attemptId: row.id },
        orderBy: { sequence: "desc" },
        select: { expiresAt: true },
      });
      attempts.push({
        id: row.id,
        sequence: row.sequence,
        handoffId: row.handoffId,
        state: row.state as FulfillmentAttemptView["state"],
        caseId: row.caseId,
        ownerAdminId: row.ownerAdminId,
        dueAt: row.dueAt.toISOString(),
        supplierRef: erased ? "资料已删除" : (row.supplierRef ?? "资料已删除"),
        receiptRef: erased ? null : row.receiptRef,
        ...this.binding(row),
        tracking: erased
          ? null
          : (row.tracking as unknown as FulfillmentAttemptView["tracking"]),
        wechat: erased
          ? null
          : (row.wechat as unknown as FulfillmentWechat | null),
        deliveredAt: row.deliveredAt?.toISOString() ?? null,
        grantExpiresAt: grant?.expiresAt.toISOString() ?? null,
        cancellationNotice:
          row.state === "cancellation_pending"
            ? "已请求取消，须人工核实印厂结果；不承诺撤回实物。"
            : "取消和实物状态以印厂核实回执为准。",
      });
    }
    return {
      projectId,
      orderId: order?.id ?? null,
      paymentOrderId: order?.paymentOrderId ?? null,
      approvedSupplierRef: order ? await this.supplierIn(tx, order) : null,
      entitlementState:
        (await tx.firstCopyEntitlement.findUnique({ where: { projectId } }))
          ?.state ?? null,
      reservation: order ? this.binding(order) : null,
      accessExpiresAt: actor?.accessExpiresAt ?? null,
      grantMaxMinutes: 30,
      canGrantNarrator:
        !erased && !!actor && subject.boundUserId === actor.userId,
      attempts,
      current: attempts[0] ?? null,
      creation: {
        state: terms.creation?.state ?? "pending",
        expiresAt: terms.creation?.expiresAt ?? null,
      },
      serviceTerms: { playback: terms.playback ?? null },
      canGrant:
        !erased &&
        !!actor &&
        attempts[0]?.state === "approved" &&
        (!!rows[0]?.qualityRequestId || terms.creation?.state === "active"),
    };
  }
  progress(projectId: string, authorization?: string) {
    return this.participation.withPlanAccess(
      projectId,
      authorization,
      undefined,
      (tx, actor) => this.view(tx, projectId, actor),
    );
  }
  async listIn(tx: Tx) {
    const orders = await tx.firstCopyOrder.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return Promise.all(orders.map((order) => this.view(tx, order.projectId)));
  }
  async readIn(tx: Tx, id: string) {
    const order = await this.order(tx, id);
    return this.view(tx, order.projectId);
  }
  private async preflight(
    tx: Tx,
    order: FirstCopyOrder,
    operatorId: string,
    key: string,
    attempt?: import("@prisma/client").FulfillmentAttempt,
  ) {
    if (attempt?.qualityRequestId) {
      await this.copies.qualityReviewIn(
        tx,
        attempt.qualityRequestId,
        this.binding(attempt),
        operatorId,
      );
      return true;
    }
    await this.copies.approveIn(
      tx,
      order.id,
      this.binding(order),
      operatorId,
      key,
    );
    const terms = await this.terms.read(order.projectId, undefined, tx);
    return terms.creation?.state === "active";
  }
  async createIn(
    tx: Tx,
    id: string,
    body: AttemptDto,
    operatorId: string,
    key: string,
  ) {
    const order = await this.order(tx, id);
    this.matches(order, body);
    if (body.supplierRef !== (await this.supplierIn(tx, order)))
      throw new ConflictException(
        "Purchased printing supplier admission required",
      );
    const prior = await tx.fulfillmentCommand.findUnique({
      where: {
        projectId_actorId_action_key: {
          projectId: order.projectId,
          actorId: operatorId,
          action: "attempt",
          key,
        },
      },
    });
    if (prior) {
      await this.command(tx, order, operatorId, "attempt", key, body);
      return this.view(tx, order.projectId);
    }
    if (!(await this.preflight(tx, order, operatorId, key)))
      return this.view(tx, order.projectId);
    if (Date.parse(body.dueAt) <= Date.now())
      throw new BadRequestException("Future operational deadline required");
    const current = await tx.fulfillmentAttempt.findFirst({
      where: { orderId: id },
      orderBy: { sequence: "desc" },
    });
    if (current?.state !== "cancelled" && current) {
      if (
        current.state !== "approved" ||
        current.supplierRef !== body.supplierRef
      )
        throw new ConflictException();
      await this.command(
        tx,
        order,
        operatorId,
        "attempt",
        key,
        body,
        current.id,
      );
      return this.view(tx, order.projectId);
    }
    const project = await tx.project.findUniqueOrThrow({
        where: { id: order.projectId },
      }),
      subject = await tx.projectSubject.findUniqueOrThrow({
        where: { projectId: order.projectId },
      }),
      attemptId = randomUUID(),
      caseId = randomUUID();
    await tx.careRequest.create({
      data: {
        id: caseId,
        projectId: order.projectId,
        requesterSubjectId: subject.id,
        operatorId,
        operatorRealm: "admin",
        sourceBindingVersion: subject.bindingVersion,
        sourceAccessEpoch: project.accessEpoch,
        idempotencyKey: `production:${attemptId}`,
        requestHash: digest(body),
        kind: "production_handoff",
      },
    });
    await tx.fulfillmentAttempt.create({
      data: {
        id: attemptId,
        reservationRevision: order.reservationRevision,
        bookId: order.bookId,
        snapshotHash: order.snapshotHash,
        pdfHash: order.pdfHash,
        addressHash: order.addressHash,
        address: json(order.address),
        narratorConfirmationId: order.narratorConfirmationId,
        initiatorConfirmationId: order.initiatorConfirmationId,
        orderId: id,
        projectId: order.projectId,
        sequence: (current?.sequence ?? 0) + 1,
        handoffId: randomUUID(),
        caseId,
        ownerAdminId: operatorId,
        dueAt: new Date(body.dueAt),
        supplierRef: body.supplierRef,
      },
    });
    await this.command(tx, order, operatorId, "attempt", key, body, attemptId);
    return this.view(tx, order.projectId);
  }
  async createQualityIn(
    tx: Tx,
    requestId: string,
    body: FirstCopyBinding,
    operatorId: string,
    key: string,
  ) {
    const quality = await tx.qualityRequest.findUniqueOrThrow({
        where: { id: requestId },
      }),
      order = await this.order(tx, quality.productionOrderId),
      frozen = await this.copies.qualityReviewIn(
        tx,
        requestId,
        body,
        operatorId,
      ),
      supplierRef = await this.supplierIn(tx, order);
    if (!supplierRef || !quality.dueAt)
      throw new ConflictException(
        "Purchased supplier and assigned deadline required",
      );
    if (
      await tx.fulfillmentAttempt.findFirst({
        where: {
          orderId: order.id,
          state: { notIn: ["cancelled", "delivered"] },
        },
      })
    )
      throw new ConflictException("An active original-order handoff remains");
    const latest = await tx.fulfillmentAttempt.findFirst({
        where: { orderId: order.id },
        orderBy: { sequence: "desc" },
      }),
      attemptId = randomUUID(),
      caseId = randomUUID(),
      project = await tx.project.findUniqueOrThrow({
        where: { id: order.projectId },
      }),
      subject = await tx.projectSubject.findUniqueOrThrow({
        where: { projectId: order.projectId },
      });
    await tx.careRequest.create({
      data: {
        id: caseId,
        projectId: order.projectId,
        requesterSubjectId: subject.id,
        operatorId,
        operatorRealm: "admin",
        sourceBindingVersion: subject.bindingVersion,
        sourceAccessEpoch: project.accessEpoch,
        idempotencyKey: `production:${attemptId}`,
        requestHash: digest(body),
        kind: "production_handoff",
      },
    });
    await tx.fulfillmentAttempt.create({
      data: {
        id: attemptId,
        qualityRequestId: requestId,
        ...frozen,
        address: json(frozen.address),
        orderId: order.id,
        projectId: order.projectId,
        sequence: (latest?.sequence ?? 0) + 1,
        handoffId: randomUUID(),
        caseId,
        ownerAdminId: operatorId,
        dueAt: quality.dueAt,
        supplierRef,
      },
    });
    await this.command(
      tx,
      order,
      operatorId,
      `quality:${requestId}`,
      key,
      body,
      attemptId,
    );
    return attemptId;
  }
  async grant(
    projectId: string,
    body: GrantDto,
    authorization: string | undefined,
    key: string,
  ) {
    return this.participation.withPlanAccess(
      projectId,
      authorization,
      undefined,
      async (tx, actor) => {
        const order = await tx.firstCopyOrder.findUnique({
          where: { projectId },
        });
        if (!order) throw new NotFoundException();
        const attempt = await tx.fulfillmentAttempt.findFirst({
          where: { projectId, id: body.attemptId, orderId: order.id },
        });
        if (!attempt || attempt.state !== "approved")
          throw new ConflictException();
        this.matches(attempt, body);
        const expiry = Date.parse(body.expiresAt);
        if (
          expiry <= Date.now() ||
          expiry > Date.now() + 30 * 60000 ||
          (actor.accessExpiresAt && expiry > Date.parse(actor.accessExpiresAt))
        )
          throw new BadRequestException(
            "Operational grant must expire within thirty minutes",
          );
        if (actor.subjectDecision !== "self") {
          if (!body.assistedSessionId) throw new ForbiddenException();
          await this.participation.recordAssistedVersionEvidence(tx, {
            projectId,
            sessionId: body.assistedSessionId,
            operatorUserId: actor.userId,
            content: {
              kind: "book",
              versionId: order.bookId,
              hash: order.snapshotHash,
            },
            action: "production_handoff_access",
            noticeVersion: body.noticeVersion,
            evidenceRef: body.evidenceRef,
            idempotencyKey: key,
          });
        }
        if (
          !(await this.preflight(
            tx,
            order,
            attempt.ownerAdminId,
            `grant:${digest(key)}`,
            attempt,
          ))
        )
          return this.view(tx, projectId, actor);
        const command = await this.command(
          tx,
          order,
          actor.userId,
          "grant",
          key,
          body,
          attempt.id,
        );
        if (!command.fresh) return this.view(tx, projectId, actor);
        await tx.fulfillmentGrant.create({
          data: {
            id: randomUUID(),
            projectId,
            attemptId: attempt.id,
            actorId: actor.userId,
            subjectId: actor.subjectId,
            bindingVersion: actor.bindingVersion,
            accessEpoch: actor.accessEpoch,
            expiresAt: new Date(body.expiresAt),
            noticeVersion: body.noticeVersion,
            evidenceRef: body.evidenceRef,
          },
        });
        return this.view(tx, projectId, actor);
      },
    );
  }
  private async attemptIn(tx: Tx, id: string, attemptId: string) {
    const order = await this.order(tx, id),
      attempt = await tx.fulfillmentAttempt.findFirst({
        where: { id: attemptId, orderId: id, projectId: order.projectId },
      });
    if (!attempt) throw new NotFoundException();
    return { order, attempt };
  }
  async materialsIn(
    tx: Tx,
    id: string,
    attemptId: string,
    operatorId: string,
  ): Promise<FulfillmentMaterials> {
    const { order, attempt } = await this.attemptIn(tx, id, attemptId);
    if (attempt.ownerAdminId !== operatorId || attempt.state !== "approved")
      throw new ForbiddenException();
    if (
      !attempt.qualityRequestId &&
      attempt.reservationRevision !== order.reservationRevision
    )
      throw new ConflictException(
        "Only the active frozen reservation may disclose materials",
      );
    if (!attempt.qualityRequestId) this.matches(order, this.binding(attempt));
    const grant = await tx.fulfillmentGrant.findFirst({
        where: { attemptId },
        orderBy: { sequence: "desc" },
      }),
      project = await tx.project.findUniqueOrThrow({
        where: { id: order.projectId },
      }),
      subject = await tx.projectSubject.findUniqueOrThrow({
        where: { projectId: order.projectId },
      }),
      care = await tx.careRequest.findUniqueOrThrow({
        where: { id: attempt.caseId },
      });
    if (
      !grant ||
      grant.expiresAt.getTime() <= Date.now() ||
      grant.accessEpoch !== project.accessEpoch ||
      grant.subjectId !== subject.id ||
      grant.bindingVersion !== subject.bindingVersion ||
      care.kind !== "production_handoff" ||
      care.state === "completed"
    )
      throw new ForbiddenException();
    if (
      !(await this.preflight(
        tx,
        order,
        operatorId,
        `materials:${attemptId}`,
        attempt,
      ))
    )
      throw new ConflictException("Creation period requires manual review");
    const output = await tx.bookOutput.findUniqueOrThrow({
      where: { bookId: attempt.bookId },
    });
    if (output.sha256 !== attempt.pdfHash) throw new ConflictException();
    return {
      address: attempt.address as unknown as FirstCopyAddress,
      pdf: { sha256: output.sha256, bytes: output.bytes },
      grantExpiresAt: grant.expiresAt.toISOString(),
      handoffId: attempt.handoffId,
    };
  }
  async pdfIn(tx: Tx, id: string, attemptId: string, operatorId: string) {
    const materials = await this.materialsIn(tx, id, attemptId, operatorId),
      attempt = await tx.fulfillmentAttempt.findUniqueOrThrow({
        where: { id: attemptId },
      }),
      output = await tx.bookOutput.findUniqueOrThrow({
        where: { bookId: attempt.bookId },
      });
    return {
      ...materials,
      projectId: attempt.projectId,
      path: join(this.config.books!.storageRoot, output.objectKey),
    };
  }
  async readPdf(path: string, pdf: { sha256: string; bytes: number }) {
    try {
      const bytes = await readFile(path);
      if (
        bytes.length !== pdf.bytes ||
        createHash("sha256").update(bytes).digest("hex") !== pdf.sha256
      )
        throw Error();
      return bytes;
    } catch {
      throw new UnprocessableEntityException();
    }
  }
  private async record(
    tx: Tx,
    attemptId: string,
    kind: string,
    evidence: unknown,
    operatorAdminId: string,
  ) {
    await tx.fulfillmentRecord.create({
      data: {
        id: randomUUID(),
        attemptId,
        kind,
        evidence: json(evidence),
        operatorAdminId,
      },
    });
  }
  async handoffIn(
    tx: Tx,
    id: string,
    attemptId: string,
    operatorId: string,
    key: string,
  ) {
    const { order, attempt } = await this.attemptIn(tx, id, attemptId);
    const prior = await this.command(
      tx,
      order,
      operatorId,
      `handoff:${attemptId}`,
      key,
      {},
      attemptId,
    );
    if (!prior.fresh) return this.view(tx, order.projectId);
    if (attempt.state !== "approved")
      throw new ConflictException(
        "Handoff outcome must be reconciled before retry",
      );
    await this.materialsIn(tx, id, attemptId, operatorId);
    await tx.fulfillmentAttempt.update({
      where: { id: attemptId },
      data: { state: "handoff_pending" },
    });
    await this.record(
      tx,
      attemptId,
      "handoff",
      {
        handoffId: attempt.handoffId,
        pdfHash: attempt.pdfHash,
        addressHash: attempt.addressHash,
      },
      operatorId,
    );
    return this.view(tx, order.projectId);
  }
  async cancelIn(
    tx: Tx,
    id: string,
    attemptId: string,
    body: EvidenceDto,
    operatorId: string,
    key: string,
  ) {
    const { order, attempt } = await this.attemptIn(tx, id, attemptId),
      prior = await this.command(
        tx,
        order,
        operatorId,
        `cancel:${attemptId}`,
        key,
        body,
        attemptId,
      );
    if (!prior.fresh) return this.view(tx, order.projectId);
    if (attempt.state === "delivered")
      throw new ConflictException(
        "Delivered physical copies require quality aftercare",
      );
    if (["cancelled", "cancellation_pending"].includes(attempt.state))
      return this.view(tx, order.projectId);
    const state =
      attempt.state === "approved" ? "cancelled" : "cancellation_pending";
    await tx.fulfillmentAttempt.update({
      where: { id: attemptId },
      data: { state },
    });
    if (state === "cancelled")
      await tx.careRequest.update({
        where: { id: attempt.caseId },
        data: { state: "completed", completedBy: operatorId },
      });
    await this.record(tx, attemptId, state, body, operatorId);
    return this.view(tx, order.projectId);
  }
  async receiptIn(
    tx: Tx,
    id: string,
    attemptId: string,
    body: ReceiptDto,
    operatorId: string,
    key: string,
  ) {
    const { order, attempt } = await this.attemptIn(tx, id, attemptId),
      prior = await this.command(
        tx,
        order,
        operatorId,
        `receipt:${attemptId}`,
        key,
        body,
        attemptId,
      );
    if (!prior.fresh) return this.view(tx, order.projectId);
    if (body.outcome === "unknown") {
      if (!["handoff_pending", "cancellation_pending"].includes(attempt.state))
        throw new ConflictException();
      await tx.fulfillmentAttempt.update({
        where: { id: attemptId },
        data: { receiptRef: body.evidenceRef },
      });
    } else if (body.outcome === "accepted") {
      if (["in_production", "shipped", "delivered"].includes(attempt.state)) {
        if (attempt.receiptRef !== body.evidenceRef)
          throw new ConflictException();
        return this.view(tx, order.projectId);
      }
      if (!["handoff_pending", "cancellation_pending"].includes(attempt.state))
        throw new ConflictException();
      const entitlement = await tx.firstCopyEntitlement.findUniqueOrThrow({
        where: { id: order.entitlementId },
      });
      if (
        !["reserved", "consumed", "suspended", "revoked"].includes(
          entitlement.state,
        )
      )
        throw new ConflictException();
      // Reconciliation records the physical fact without undoing a later Commerce freeze.
      await tx.firstCopyEntitlement.updateMany({
        where: { id: order.entitlementId, state: "reserved" },
        data: { state: "consumed" },
      });
      await tx.fulfillmentAttempt.update({
        where: { id: attemptId },
        data: {
          state:
            attempt.state === "cancellation_pending"
              ? "cancellation_pending"
              : "in_production",
          receiptRef: body.evidenceRef,
        },
      });
    } else if (body.outcome === "cancellation_rejected") {
      if (attempt.state !== "cancellation_pending")
        throw new ConflictException(
          "A pending cancellation must be verified first",
        );
      const accepted = await tx.fulfillmentRecord.findFirst({
        where: { attemptId, kind: "receipt_accepted" },
      });
      // Restore only known physical facts. Refusing cancellation is not itself
      // evidence that an unknown handoff was accepted or shipped.
      const state = attempt.tracking
        ? "shipped"
        : accepted
          ? "in_production"
          : "handoff_pending";
      await tx.fulfillmentAttempt.update({
        where: { id: attemptId },
        data: { state },
      });
    } else {
      if (attempt.state === "cancelled") {
        if (attempt.receiptRef !== body.evidenceRef)
          throw new ConflictException();
        return this.view(tx, order.projectId);
      }
      if (attempt.state !== "cancellation_pending")
        throw new ConflictException(
          "Request cancellation before confirming supplier outcome",
        );
      await tx.fulfillmentAttempt.update({
        where: { id: attemptId },
        data: { state: "cancelled", receiptRef: body.evidenceRef },
      });
      if (!attempt.qualityRequestId)
        await tx.firstCopyEntitlement.updateMany({
          where: { id: order.entitlementId, state: "consumed" },
          data: {
            state: (
              await tx.paymentOrder.findUniqueOrThrow({
                where: { id: order.paymentOrderId },
              })
            ).firstCopyCancellationRequired
              ? "revoked"
              : "reserved",
          },
        });
      await tx.careRequest.update({
        where: { id: attempt.caseId },
        data: { state: "completed", completedBy: operatorId },
      });
    }
    await this.record(
      tx,
      attemptId,
      `receipt_${body.outcome}`,
      body,
      operatorId,
    );
    return this.view(tx, order.projectId);
  }
  private occurred(at: string, earliest: Date) {
    const time = new Date(at);
    if (
      !Number.isFinite(time.getTime()) ||
      time.getTime() > Date.now() ||
      time < earliest
    )
      throw new BadRequestException("Actual event time required");
    return time;
  }
  async shippingIn(
    tx: Tx,
    id: string,
    attemptId: string,
    body: ShippingDto,
    operatorId: string,
    key: string,
  ) {
    const { order, attempt } = await this.attemptIn(tx, id, attemptId),
      prior = await this.command(
        tx,
        order,
        operatorId,
        `shipping:${attemptId}`,
        key,
        body,
        attemptId,
      );
    if (!prior.fresh) return this.view(tx, order.projectId);
    if (!["in_production", "shipped", "delivered"].includes(attempt.state))
      throw new ConflictException();
    const payment = await tx.paymentOrder.findUniqueOrThrow({
        where: { id: order.paymentOrderId },
      }),
      snapshot = payment.packageSnapshot as SalesSnapshot,
      handling =
        snapshot.admission?.d08?.platform?.shippingManagement
          ?.requirementHandling;
    if (
      handling !== "implemented_and_verified" ||
      body.wechat.handling !== handling
    )
      throw new ConflictException(
        "Applicable WeChat shipping path is not ready",
      );
    this.occurred(body.shippedAt, attempt.createdAt);
    const tracking = {
      carrier: body.carrier.trim(),
      number: body.number,
      shippedAt: new Date(body.shippedAt).toISOString(),
    };
    if (attempt.tracking && !isDeepStrictEqual(attempt.tracking, tracking))
      throw new ConflictException("Verified shipment cannot be overwritten");
    await tx.fulfillmentAttempt.update({
      where: { id: attemptId },
      data: {
        state: attempt.state === "delivered" ? "delivered" : "shipped",
        tracking: json(tracking),
        wechat: json(body.wechat),
      },
    });
    await this.record(tx, attemptId, "shipping", body, operatorId);
    return this.view(tx, order.projectId);
  }
  async deliveryIn(
    tx: Tx,
    id: string,
    attemptId: string,
    body: DeliveryDto,
    operatorId: string,
    key: string,
  ) {
    const { order, attempt } = await this.attemptIn(tx, id, attemptId),
      prior = await this.command(
        tx,
        order,
        operatorId,
        `delivery:${attemptId}`,
        key,
        body,
        attemptId,
      );
    if (!prior.fresh) return this.view(tx, order.projectId);
    const existing = await tx.fulfillmentDelivery.findUnique({
      where: { orderId: id },
    });
    if (existing && attempt.qualityRequestId) {
      if (attempt.state === "delivered") {
        const fact = await tx.fulfillmentRecord.findFirst({
          where: { attemptId, kind: "delivery" },
        });
        if (!fact || !isDeepStrictEqual(fact.evidence, body))
          throw new ConflictException("Delivery fact is immutable");
        return this.view(tx, order.projectId);
      }
      if (attempt.state !== "shipped" || !attempt.tracking)
        throw new ConflictException("Verified shipment required");
      const occurredAt = this.occurred(
        body.deliveredAt,
        new Date((attempt.tracking as { shippedAt: string }).shippedAt),
      );
      await tx.fulfillmentAttempt.update({
        where: { id: attemptId },
        data: { state: "delivered", deliveredAt: occurredAt },
      });
      const quality = await tx.qualityRequest.update({
        where: { id: attempt.qualityRequestId },
        data: { state: "completed", version: { increment: 1 } },
      });
      await tx.careRequest.updateMany({
        where: { id: { in: [attempt.caseId, quality.caseId] } },
        data: { state: "completed", completedBy: operatorId },
      });
      await this.record(tx, attemptId, "delivery", body, operatorId);
      return this.view(tx, order.projectId);
    }
    if (existing) {
      if (
        existing.attemptId !== attemptId ||
        existing.occurredAt.toISOString() !==
          new Date(body.deliveredAt).toISOString() ||
        existing.evidenceRef !== body.evidenceRef
      )
        throw new ConflictException("Delivery fact is immutable");
      return this.view(tx, order.projectId);
    }
    if (attempt.state !== "shipped" || !attempt.tracking)
      throw new ConflictException("Verified shipment required");
    const occurredAt = this.occurred(
      body.deliveredAt,
      new Date((attempt.tracking as { shippedAt: string }).shippedAt),
    );
    await tx.fulfillmentDelivery.create({
      data: {
        orderId: id,
        attemptId,
        occurredAt,
        evidenceRef: body.evidenceRef,
        operatorAdminId: operatorId,
      },
    });
    await this.terms.recordFact(
      {
        projectId: order.projectId,
        eventId: `delivery:${id}`,
        kind: "delivery_completed",
        occurredAt,
      },
      tx,
    );
    await tx.fulfillmentAttempt.update({
      where: { id: attemptId },
      data: { state: "delivered", deliveredAt: occurredAt },
    });
    await tx.careRequest.update({
      where: { id: attempt.caseId },
      data: { state: "completed", completedBy: operatorId },
    });
    await this.record(tx, attemptId, "delivery", body, operatorId);
    return this.view(tx, order.projectId);
  }
  async onModuleDestroy() {
    await this.terms.close();
  }
}
@Controller("v1/projects/:id/fulfillment")
@ApiTags("Fulfillment")
@ApiBearerAuth()
export class FulfillmentController {
  constructor(private readonly fulfillment: Fulfillment) {}
  @Post("grants")
  @Header("Cache-Control", "no-store")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  async grant(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: GrantDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.fulfillment.grant(
        id,
        body,
        req.headers.authorization,
        idempotencyKey(req),
      ),
      meta: { requestId: req.id },
    };
  }
  @Get() @Header("Cache-Control", "no-store") async progress(
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.fulfillment.progress(id, req.headers.authorization),
      meta: { requestId: req.id },
    };
  }
}
@Controller("v1/admin/fulfillment")
@ApiTags("Administration fulfillment")
@ApiCookieAuth("timenook-admin")
export class AdminFulfillmentController {
  constructor(
    private readonly fulfillment: Fulfillment,
    private readonly access: AdminAccess,
    private readonly streams: ProjectStreams,
  ) {}
  private async run<T>(
    req: FastifyRequest,
    action: string,
    work: (tx: Tx, id: string) => Promise<T>,
  ) {
    return this.access.run(action, req, async () => {
      const actor = await this.access.authorized(
        req,
        ADMIN_PERMISSIONS.writeFulfillment,
      );
      return this.access.command(
        req,
        ADMIN_PERMISSIONS.writeFulfillment,
        (tx) => work(tx, actor.adminId!),
        req.method === "GET",
      );
    });
  }
  @Get() @Header("Cache-Control", "no-store") async list(
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.run(req, "fulfillment.list", (tx) =>
        this.fulfillment.listIn(tx),
      ),
      meta: { requestId: req.id },
    };
  }
  @Get(":id") @Header("Cache-Control", "no-store") async read(
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.run(req, "fulfillment.read", (tx) =>
        this.fulfillment.readIn(tx, id),
      ),
      meta: { requestId: req.id },
    };
  }
  @Post(":id/attempts")
  @Header("Cache-Control", "no-store")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  async create(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: AttemptDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.run(req, "fulfillment.attempt", (tx, actor) =>
        this.fulfillment.createIn(tx, id, body, actor, idempotencyKey(req)),
      ),
      meta: { requestId: req.id },
    };
  }
  @Post(":id/attempts/:attemptId/handoff")
  @Header("Cache-Control", "no-store")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  async handoff(
    @Param("id", ParseUUIDPipe) id: string,
    @Param("attemptId", ParseUUIDPipe) attemptId: string,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.run(req, "fulfillment.handoff", (tx, actor) =>
        this.fulfillment.handoffIn(
          tx,
          id,
          attemptId,
          actor,
          idempotencyKey(req),
        ),
      ),
      meta: { requestId: req.id },
    };
  }
  @Post(":id/attempts/:attemptId/cancel")
  @Header("Cache-Control", "no-store")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  async cancel(
    @Param("id", ParseUUIDPipe) id: string,
    @Param("attemptId", ParseUUIDPipe) attemptId: string,
    @Body() body: EvidenceDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.run(req, "fulfillment.cancel", (tx, actor) =>
        this.fulfillment.cancelIn(
          tx,
          id,
          attemptId,
          body,
          actor,
          idempotencyKey(req),
        ),
      ),
      meta: { requestId: req.id },
    };
  }
  @Post(":id/attempts/:attemptId/receipt")
  @Header("Cache-Control", "no-store")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  async receipt(
    @Param("id", ParseUUIDPipe) id: string,
    @Param("attemptId", ParseUUIDPipe) attemptId: string,
    @Body() body: ReceiptDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.run(req, "fulfillment.receipt", (tx, actor) =>
        this.fulfillment.receiptIn(
          tx,
          id,
          attemptId,
          body,
          actor,
          idempotencyKey(req),
        ),
      ),
      meta: { requestId: req.id },
    };
  }
  @Post(":id/attempts/:attemptId/shipping")
  @Header("Cache-Control", "no-store")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  async shipping(
    @Param("id", ParseUUIDPipe) id: string,
    @Param("attemptId", ParseUUIDPipe) attemptId: string,
    @Body() body: ShippingDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.run(req, "fulfillment.shipping", (tx, actor) =>
        this.fulfillment.shippingIn(
          tx,
          id,
          attemptId,
          body,
          actor,
          idempotencyKey(req),
        ),
      ),
      meta: { requestId: req.id },
    };
  }
  @Post(":id/attempts/:attemptId/delivery")
  @Header("Cache-Control", "no-store")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  async delivery(
    @Param("id", ParseUUIDPipe) id: string,
    @Param("attemptId", ParseUUIDPipe) attemptId: string,
    @Body() body: DeliveryDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.run(req, "fulfillment.delivery", (tx, actor) =>
        this.fulfillment.deliveryIn(
          tx,
          id,
          attemptId,
          body,
          actor,
          idempotencyKey(req),
        ),
      ),
      meta: { requestId: req.id },
    };
  }
  @Get(":id/attempts/:attemptId/pdf")
  @Header("Cache-Control", "no-store")
  async pdf(
    @Param("id", ParseUUIDPipe) id: string,
    @Param("attemptId", ParseUUIDPipe) attemptId: string,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const scope = await this.run(req, "fulfillment.pdf", (tx, actor) =>
        this.fulfillment.pdfIn(tx, id, attemptId, actor),
      ),
      fence = await this.streams.fence(scope.projectId),
      bytes = await this.fulfillment.readPdf(scope.path, scope.pdf);
    await this.run(req, "fulfillment.pdf", (tx, actor) =>
      this.fulfillment.pdfIn(tx, id, attemptId, actor),
    );
    reply
      .header("Cache-Control", "no-store")
      .header("Content-Type", "application/pdf")
      .header(
        "Content-Disposition",
        `attachment; filename="production-${attemptId}.pdf"`,
      )
      .header("Content-Length", bytes.length)
      .send(
        await this.streams.guard(
          scope.projectId,
          fence.epoch,
          bytes,
          () =>
            this.run(req, "fulfillment.pdf", (tx, actor) =>
              this.fulfillment.pdfIn(tx, id, attemptId, actor),
            ),
          undefined,
          fence.sequence,
        ),
      );
  }
  @Get(":id/attempts/:attemptId/materials")
  @Header("Cache-Control", "no-store")
  async materials(
    @Param("id", ParseUUIDPipe) id: string,
    @Param("attemptId", ParseUUIDPipe) attemptId: string,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.run(req, "fulfillment.materials", (tx, actor) =>
        this.fulfillment.materialsIn(tx, id, attemptId, actor),
      ),
      meta: { requestId: req.id },
    };
  }
}
