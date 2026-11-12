import { ProjectStreams } from "../media/project-streams";
import {
  Injectable,
  Controller,
  Get,
  Post,
  Body,
  Query,
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
  IsIn,
  IsString,
  MaxLength,
} from "class-validator";
import type { FastifyRequest, FastifyReply } from "fastify";
import { Prisma, FirstCopyOrder } from "@prisma/client";
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
  AdminProductionPage,
  AdminProductionSummary,
} from "@timenook/contracts";
import { ADMIN_PERMISSIONS } from "@timenook/contracts";
import { Participation } from "../identity/participation";
import { AdminAccess } from "../admin/admin-access";
import { idempotencyKey } from "../payments/orders";
import { FirstCopies } from "./first-copy";
import { Books } from "./books";
import { API_CONFIG, ApiConfig } from "../config";
import { participationNotice } from "../catalog/e2e-package";
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
  @ApiProperty() @IsString() @MaxLength(100) noticeVersion!: string;
  @ApiProperty()
  @Matches(/^(synthetic|internal|record):[^\r\n]{3,160}$/)
  evidenceRef!: string;
  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  assistedSessionId?: string;
}
class EvidenceDto {
  @ApiProperty()
  @Matches(/^(synthetic|internal|record):[^\r\n]{3,160}$/)
  evidenceRef!: string;
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
  @Matches(/^(synthetic|internal|record):[^\r\n]{3,160}$/)
  evidenceRef!: string;
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
}
class PrintingDto extends EvidenceDto {
  @ApiProperty() @IsISO8601() printedAt!: string;
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
    private readonly books: Books,
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
    const erased = await this.participation.activeDataDeletedIn(tx, projectId);
    const order = await tx.firstCopyOrder.findUnique({ where: { projectId } }),
      terms = await this.terms.read(projectId, tx),
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
        printedAt: row.printedAt?.toISOString() ?? null,
        printedBy: row.printedBy,
        records: (
          await tx.fulfillmentRecord.findMany({
            where: { attemptId: row.id },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            select: { kind: true, operatorAdminId: true, createdAt: true },
          })
        ).map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
        deliveredAt: row.deliveredAt?.toISOString() ?? null,
        grantExpiresAt: grant?.expiresAt.toISOString() ?? null,
        cancellationNotice:
          !row.shippedAt && ["shipped", "delivered"].includes(row.state)
            ? "原实际发货时间待核实；请核对原发货记录，不能推测或改写时间。"
            : row.state === "cancellation_pending"
              ? "已请求取消，须人工核实印厂结果；不承诺撤回实物。"
              : "取消和实物状态以印厂核实回执为准。",
      });
    }
    const payment = order
      ? await tx.paymentOrder.findUniqueOrThrow({
          where: { id: order.paymentOrderId },
        })
      : null;
    const notice = participationNotice(
      (payment?.packageSnapshot ?? {}) as Prisma.JsonObject,
      this.config.books?.mode === "internal-acceptance",
    );
    const currentIndex = rows.findIndex(
      (row) => row.reservationRevision === order?.reservationRevision,
    );
    const current = attempts[currentIndex] ?? null;
    const fixedAddress =
      actor && !erased && order
        ? ((rows[currentIndex]?.address ??
            order.address) as unknown as FirstCopyAddress)
        : null;
    const regionLabels = (
      payment?.packageSnapshot as {
        shippingRegionLabels?: Record<string, string>;
      } | null
    )?.shippingRegionLabels;
    return {
      noticeVersion: notice.noticeVersion,
      evidencePrefix: notice.evidencePrefix,
      projectId,
      orderId: order?.id ?? null,
      paymentOrderId: order?.paymentOrderId ?? null,
      approvedSupplierRef: order ? await this.supplierIn(tx, order) : null,
      entitlementState:
        (await tx.firstCopyEntitlement.findUnique({ where: { projectId } }))
          ?.state ?? null,
      reservation: order ? this.binding(order) : null,
      deliveryAddress: fixedAddress
        ? {
            ...fixedAddress,
            regionLabel:
              regionLabels?.[fixedAddress.regionCode] ??
              fixedAddress.regionCode,
          }
        : null,
      accessExpiresAt: actor?.accessExpiresAt ?? null,
      grantMaxMinutes: 30,
      canGrantNarrator:
        !erased && !!actor && subject.boundUserId === actor.userId,
      attempts,
      current,
      creation: {
        state: terms.creation?.state ?? "pending",
        expiresAt: terms.creation?.expiresAt ?? null,
      },
      serviceTerms: { playback: terms.playback ?? null },
      canGrant:
        !erased &&
        !!actor &&
        current?.state === "approved" &&
        (!!rows[currentIndex]?.qualityRequestId ||
          terms.creation?.state === "active"),
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
  bookScope(projectId: string, authorization?: string, expectedId?: string) {
    return this.participation.withPlanAccess(
      projectId,
      authorization,
      undefined,
      async (tx, actor) => {
        const progress = await this.view(tx, projectId, actor);
        const binding = progress.current ?? progress.reservation;
        if (!binding) throw new NotFoundException();
        if (expectedId && expectedId !== binding.bookVersionId)
          throw new ConflictException("Production reservation changed");
        const output = await this.books.frozenOutputIn(
          tx,
          projectId,
          binding.bookVersionId,
          binding.pdfHash,
        );
        const version = await this.books.frozenViewIn(
          tx,
          projectId,
          binding.bookVersionId,
          binding.snapshotHash,
          actor.accessExpiresAt,
        );
        return { ...output, version };
      },
    );
  }
  async listIn(
    tx: Tx,
    query: Record<string, unknown> = {},
  ): Promise<AdminProductionPage> {
    const integer = (value: unknown, fallback: number, max: number) => {
      if (value === undefined || value === "") return fallback;
      if (
        typeof value !== "string" ||
        !/^[1-9]\d*$/.test(value) ||
        Number(value) > max
      )
        throw new BadRequestException("Invalid pagination");
      return Number(value);
    };
    const page = integer(query.page, 1, 1000000),
      pageSize = integer(query.pageSize, 20, 100);
    const q = typeof query.q === "string" ? query.q.trim() : "";
    const states = [
      "pdf_ready",
      "approved",
      "handoff_pending",
      "in_production",
      "printed",
      "shipped",
      "delivered",
      "cancellation_pending",
      "cancelled",
    ];
    if (
      Object.keys(query).some(
        (k) =>
          !["q", "state", "pending", "exception", "page", "pageSize"].includes(
            k,
          ),
      ) ||
      (query.q !== undefined && typeof query.q !== "string") ||
      q.length > 200 ||
      (query.state && !states.includes(String(query.state))) ||
      [query.pending, query.exception].some(
        (v) =>
          v !== undefined && v !== "" && !["true", "false"].includes(String(v)),
      )
    )
      throw new BadRequestException("Invalid production filter");
    const base = Prisma.sql`WITH production AS (
      SELECT o.id, o.project_id AS "projectId", o.payment_order_id AS "paymentOrderId", p.out_trade_no AS "outTradeNo", COALESCE(s.name,p.subject_name) AS "subjectName", COALESCE(j.book_title,p.book_title) AS "bookTitle", o.created_at AS "createdAt", a.printed_at AS "printedAt",
      CASE WHEN a.state='in_production' AND a.printed_at IS NOT NULL THEN 'printed' ELSE COALESCE(a.state,'pdf_ready') END AS state,
      COALESCE(a.state NOT IN ('delivered','cancelled'),true) AS pending,
      COALESCE(a.state IN ('handoff_pending','cancellation_pending') OR (a.due_at < now() AND a.state NOT IN ('delivered','cancelled')),false) AS exception
      FROM first_copy_orders o JOIN payment_orders p ON p.id=o.payment_order_id JOIN projects j ON j.id=o.project_id LEFT JOIN project_subjects s ON s.project_id=j.id
      LEFT JOIN LATERAL (SELECT state,printed_at,due_at FROM fulfillment_attempts WHERE order_id=o.id ORDER BY sequence DESC LIMIT 1) a ON true
    ), filtered AS (SELECT * FROM production WHERE
      (${q}='' OR concat_ws(' ',id::text,"projectId"::text,"paymentOrderId"::text,"outTradeNo","subjectName","bookTitle") ILIKE ${"%" + q.replace(/[\\%_]/g, "\\$&") + "%"})
      AND (${String(query.state ?? "")}='' OR state=${String(query.state ?? "")})
      AND (${String(query.pending ?? "")}='' OR pending::text=${String(query.pending ?? "")})
      AND (${String(query.exception ?? "")}='' OR exception::text=${String(query.exception ?? "")}))`;
    const count = await tx.$queryRaw<{ total: bigint }[]>(
      Prisma.sql`${base} SELECT count(*) AS total FROM filtered`,
    );
    const rows = await tx.$queryRaw<
      (Omit<AdminProductionSummary, "createdAt" | "printedAt"> & {
        createdAt: Date;
        printedAt: Date | null;
      })[]
    >(
      Prisma.sql`${base} SELECT * FROM filtered ORDER BY "createdAt" DESC,id DESC OFFSET ${(page - 1) * pageSize} LIMIT ${pageSize}`,
    );
    return {
      items: rows.map((r) => ({
        ...r,
        createdAt: r.createdAt.toISOString(),
        printedAt: r.printedAt?.toISOString() ?? null,
      })),
      total: Number(count[0].total),
      page,
      pageSize,
    };
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
    const terms = await this.terms.read(order.projectId, tx);
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
        const payment = await tx.paymentOrder.findUniqueOrThrow({
          where: { id: order.paymentOrderId },
        });
        const notice = participationNotice(
          payment.packageSnapshot as Prisma.JsonObject,
          this.config.books?.mode === "internal-acceptance",
        );
        if (
          body.noticeVersion !== notice.noticeVersion ||
          !body.evidenceRef.startsWith(notice.evidencePrefix)
        )
          throw new BadRequestException(
            "Applicable production authorization evidence required",
          );
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
    const care = await tx.careRequest.findUniqueOrThrow({
      where: { id: attempt.caseId },
    });
    if (care.kind !== "production_handoff" || care.state === "completed")
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
      grantExpiresAt: null,
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
    const attempt = await tx.fulfillmentAttempt.findUniqueOrThrow({
      where: { id: attemptId },
      select: { projectId: true },
    });
    const expired = await this.participation.activeDataDeletedIn(
      tx,
      attempt.projectId,
    );
    await tx.fulfillmentRecord.create({
      data: {
        id: randomUUID(),
        attemptId,
        kind,
        evidence: expired ? Prisma.DbNull : json(evidence),
        operatorAdminId,
      },
    });
  }
  private async originalInputIn(
    tx: Tx,
    order: FirstCopyOrder,
    attemptId: string,
    kind: string,
    actorId: string,
    key: string,
    body: unknown,
  ) {
    const original = await tx.fulfillmentCommand.findFirst({
      where: {
        projectId: order.projectId,
        attemptId,
        action: `${kind}:${attemptId}`,
        requestHash: digest(body),
        NOT: { actorId, key },
      },
      select: { key: true },
    });
    if (!original)
      throw new ConflictException("Original verified input required");
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
    const expired = await this.participation.activeDataDeletedIn(
      tx,
      order.projectId,
    );
    if (body.outcome === "unknown") {
      if (!["handoff_pending", "cancellation_pending"].includes(attempt.state))
        throw new ConflictException();
      await tx.fulfillmentAttempt.update({
        where: { id: attemptId },
        data: { receiptRef: expired ? undefined : body.evidenceRef },
      });
    } else if (body.outcome === "accepted") {
      if (["in_production", "shipped", "delivered"].includes(attempt.state)) {
        if (expired)
          await this.originalInputIn(
            tx,
            order,
            attemptId,
            "receipt",
            operatorId,
            key,
            body,
          );
        else if (attempt.receiptRef !== body.evidenceRef)
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
          receiptRef: expired ? undefined : body.evidenceRef,
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
      const state = attempt.shippedAt
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
        if (expired)
          await this.originalInputIn(
            tx,
            order,
            attemptId,
            "receipt",
            operatorId,
            key,
            body,
          );
        else if (attempt.receiptRef !== body.evidenceRef)
          throw new ConflictException();
        return this.view(tx, order.projectId);
      }
      if (attempt.state !== "cancellation_pending")
        throw new ConflictException(
          "Request cancellation before confirming supplier outcome",
        );
      await tx.fulfillmentAttempt.update({
        where: { id: attemptId },
        data: {
          state: "cancelled",
          receiptRef: expired ? undefined : body.evidenceRef,
        },
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
  async printingIn(
    tx: Tx,
    id: string,
    attemptId: string,
    body: PrintingDto,
    operatorId: string,
    key: string,
  ) {
    const { order, attempt } = await this.attemptIn(tx, id, attemptId);
    const prior = await this.command(
      tx,
      order,
      operatorId,
      `printing:${attemptId}`,
      key,
      body,
      attemptId,
    );
    if (!prior.fresh) return this.view(tx, order.projectId);
    if (attempt.printedAt) {
      const fact = await tx.fulfillmentRecord.findFirst({
        where: { attemptId, kind: "printing_completed" },
      });
      if (!fact || !isDeepStrictEqual(fact.evidence, body))
        throw new ConflictException("Completed printing fact is immutable");
      return this.view(tx, order.projectId);
    }
    if (attempt.state !== "in_production")
      throw new ConflictException(
        "Verify printer acceptance before completing printing",
      );
    const printedAt = this.occurred(body.printedAt, attempt.createdAt);
    await tx.fulfillmentAttempt.update({
      where: { id: attemptId },
      data: { printedAt, printedBy: operatorId },
    });
    await this.record(tx, attemptId, "printing_completed", body, operatorId);
    return this.view(tx, order.projectId);
  }
  async wechatIn(
    tx: Tx,
    id: string,
    attemptId: string,
    body: WechatDto,
    operatorId: string,
    key: string,
  ) {
    const { order, attempt } = await this.attemptIn(tx, id, attemptId);
    const prior = await this.command(
      tx,
      order,
      operatorId,
      `wechat:${attemptId}`,
      key,
      body,
      attemptId,
    );
    if (!prior.fresh) return this.view(tx, order.projectId);
    if (!attempt.shippedAt)
      throw new ConflictException("Actual shipment required");
    await this.participation.requireMaterialIn(
      tx,
      order.projectId,
      "activeData",
    );
    await tx.fulfillmentAttempt.update({
      where: { id: attemptId },
      data: { wechat: json(body) },
    });
    await this.record(tx, attemptId, "wechat", body, operatorId);
    return this.view(tx, order.projectId);
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
    if (!attempt.printedAt)
      throw new ConflictException(
        "Actual completed printing is required before shipment",
      );
    const shippedAt = this.occurred(body.shippedAt, attempt.printedAt),
      expired = await this.participation.activeDataDeletedIn(
        tx,
        order.projectId,
      );
    if (
      attempt.shippedAt &&
      attempt.shippedAt.getTime() !== shippedAt.getTime()
    )
      throw new ConflictException("Actual shipment time is immutable");
    if (expired && attempt.shippedAt)
      await this.originalInputIn(
        tx,
        order,
        attemptId,
        "shipping",
        operatorId,
        key,
        body,
      );
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
        shippedAt,
        tracking: expired ? undefined : json(tracking),
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
    const expired = await this.participation.activeDataDeletedIn(
      tx,
      order.projectId,
    );
    const existing = await tx.fulfillmentDelivery.findUnique({
      where: { orderId: id },
    });
    if (existing && attempt.qualityRequestId) {
      if (attempt.state === "delivered") {
        if (expired) {
          if (
            attempt.deliveredAt?.toISOString() !==
            new Date(body.deliveredAt).toISOString()
          )
            throw new ConflictException("Delivery fact is immutable");
          await this.originalInputIn(
            tx,
            order,
            attemptId,
            "delivery",
            operatorId,
            key,
            body,
          );
          return this.view(tx, order.projectId);
        }
        const fact = await tx.fulfillmentRecord.findFirst({
          where: { attemptId, kind: "delivery" },
        });
        if (!fact || !isDeepStrictEqual(fact.evidence, body))
          throw new ConflictException("Delivery fact is immutable");
        return this.view(tx, order.projectId);
      }
      if (attempt.state !== "shipped" || !attempt.shippedAt)
        throw new ConflictException(
          "Actual shipment time requires verification",
        );
      const occurredAt = this.occurred(body.deliveredAt, attempt.shippedAt);
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
        (!expired && existing.evidenceRef !== body.evidenceRef)
      )
        throw new ConflictException("Delivery fact is immutable");
      if (expired)
        await this.originalInputIn(
          tx,
          order,
          attemptId,
          "delivery",
          operatorId,
          key,
          body,
        );
      return this.view(tx, order.projectId);
    }
    if (attempt.state !== "shipped" || !attempt.shippedAt)
      throw new ConflictException("Actual shipment time requires verification");
    const occurredAt = this.occurred(body.deliveredAt, attempt.shippedAt);
    await tx.fulfillmentDelivery.create({
      data: {
        orderId: id,
        attemptId,
        occurredAt,
        evidenceRef: expired ? null : body.evidenceRef,
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
  constructor(
    private readonly fulfillment: Fulfillment,
    private readonly streams: ProjectStreams,
  ) {}

  @Get() @Header("Cache-Control", "no-store") async progress(
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.fulfillment.progress(id, req.headers.authorization),
      meta: { requestId: req.id },
    };
  }
  @Get("book") @Header("Cache-Control", "no-store") async book(
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: (await this.fulfillment.bookScope(id, req.headers.authorization))
        .version,
      meta: { requestId: req.id },
    };
  }
  @Get("book/pdf") async pdf(
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const authorization = req.headers.authorization;
    const fence = await this.streams.userFence(id, authorization);
    const scope = await this.fulfillment.bookScope(id, authorization);
    const bytes = await this.fulfillment.readPdf(scope.path, scope.pdf);
    reply
      .header("Cache-Control", "private, no-store")
      .header("X-Content-Type-Options", "nosniff")
      .header(
        "Content-Disposition",
        `attachment; filename="production-${scope.version.id}.pdf"`,
      )
      .type("application/pdf")
      .header("Content-Length", bytes.length)
      .send(
        await this.streams.guard(
          id,
          fence.epoch,
          bytes,
          () => this.fulfillment.bookScope(id, authorization, scope.version.id),
          authorization,
          fence.sequence,
        ),
      );
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
    const id = (req.params as { id?: string }).id;
    if (id) {
      Object.assign(req, {
        adminResourceType: "production",
        adminResourceId: id,
      });
    }
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
    @Query() query: Record<string, unknown>,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.run(req, "fulfillment.list", (tx) =>
        this.fulfillment.listIn(tx, query),
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
  @Post(":id/attempts/:attemptId/printing")
  @Header("Cache-Control", "no-store")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  async printing(
    @Param("id", ParseUUIDPipe) id: string,
    @Param("attemptId", ParseUUIDPipe) attemptId: string,
    @Body() body: PrintingDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.run(req, "fulfillment.printing", (tx, actor) =>
        this.fulfillment.printingIn(
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
  @Post(":id/attempts/:attemptId/wechat")
  @Header("Cache-Control", "no-store")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  async wechat(
    @Param("id", ParseUUIDPipe) id: string,
    @Param("attemptId", ParseUUIDPipe) attemptId: string,
    @Body() body: WechatDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.run(req, "fulfillment.wechat", (tx, actor) =>
        this.fulfillment.wechatIn(
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
