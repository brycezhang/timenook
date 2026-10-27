import { PrivacyRights } from "../care/privacy-rights";
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
  BadRequestException,
  ConflictException,
  HttpCode,
  RawBodyRequest,
  OnModuleInit,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiTags,
  ApiProperty,
  ApiHeader,
} from "@nestjs/swagger";
import {
  IsIn,
  Matches,
  IsInt,
  Min,
  Max,
  IsOptional,
  IsISO8601,
  IsUUID,
} from "class-validator";
import { Prisma, PrismaClient, Refund, PaymentOrder } from "@prisma/client";
import type { FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { REFUND_REASONS, ADMIN_PERMISSIONS } from "@timenook/contracts";
import type {
  RefundReason,
  RefundView,
  OrderRefundsView,
  RefundRule,
} from "@timenook/contracts";
import { API_CONFIG, ApiConfig } from "../config";
import { IdentityAccess } from "../identity/identity-access";
import {
  Orders,
  hash,
  idempotencyKey,
  conflict,
  PAYMENT_FETCH,
  EmptyPaymentCommand,
} from "./orders";
import { WechatPay } from "./wechat-pay";
import { AdminAccess } from "../admin/admin-access";
type Tx = Prisma.TransactionClient;
const RESERVED_REFUND_STATES = [
  "approved",
  "unknown",
  "processing",
  "abnormal",
];
const isReservedRefund = (state: string) =>
  RESERVED_REFUND_STATES.includes(state);
export const REFUND_RUNTIME = Symbol("REFUND_RUNTIME");
export interface RefundRuntime {
  now: () => Date;
  beforeExecution: (id: string) => Promise<void>;
}
export class RequestRefundDto {
  @ApiProperty({ enum: REFUND_REASONS })
  @IsIn(REFUND_REASONS)
  reason!: RefundReason;
  @ApiProperty() @Matches(/^synthetic:[^\r\n]{3,160}$/) evidenceRef!: string;
}
export class ApproveRefundDto {
  @ApiProperty() @IsInt() @Min(1) @Max(99900) amountFen!: number;
  @ApiProperty() @Matches(/^synthetic:[^\r\n]{3,160}$/) evidenceRef!: string;
  @ApiProperty({ required: false })
  @IsOptional()
  @IsISO8601()
  failureNotifiedAt?: string;
}
export class RefundEvidenceDto {
  @ApiProperty() @Matches(/^synthetic:[^\r\n]{3,160}$/) evidenceRef!: string;
}
export class RefundProductionReviewDto extends RefundEvidenceDto {
  @ApiProperty() @IsUUID() attemptId!: string;
}
@Injectable()
export class Refunds implements OnModuleDestroy, OnModuleInit {
  readonly database: PrismaClient;
  private scan?: NodeJS.Timeout;
  private recovery?: Promise<void>;
  private stopped = false;
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly identity: IdentityAccess,
    private readonly rights: PrivacyRights,
    private readonly orders: Orders,
    @Inject(PAYMENT_FETCH) private readonly paymentFetch: typeof fetch,
    @Inject(REFUND_RUNTIME) private readonly runtime: RefundRuntime,
  ) {
    this.database = new PrismaClient({ datasourceUrl: config.databaseUrl });
  }
  private enabled() {
    this.orders.enabled();
  }
  beforeExecution(id: string) {
    return this.runtime.beforeExecution(id);
  }
  private view(row: Refund, materialsDeleted = false): RefundView {
    return {
      requestWindowStartedAt: row.requestWindowStartedAt?.toISOString() ?? null,
      requestWindowEndsAt: row.requestWindowEndsAt?.toISOString() ?? null,
      processingState: !row.approvedAt
        ? "not_started"
        : ["succeeded", "closed", "rejected"].includes(row.state)
          ? "completed"
          : row.dueAt && this.runtime.now() >= row.dueAt
            ? "overdue"
            : "active",
      id: row.id,
      caseId: row.caseId,
      orderId: row.orderId,
      projectId: row.projectId,
      reason: row.reason as RefundReason,
      state: row.state as RefundView["state"],
      amountFen: row.amount,
      outRefundNo: row.outRefundNo,
      approvedBy: row.approvedBy,
      createdAt: row.createdAt.toISOString(),
      approvedAt: row.approvedAt?.toISOString() ?? null,
      dueAt: row.dueAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
      rule: row.rule as unknown as RefundView["rule"],
      deleteData: false,
      productionReviewRequired: false,
      requestDescription: materialsDeleted
        ? "资料已删除；仅保留退款事实"
        : (row.evidenceRef?.replace(/^synthetic:/, "") ??
          "资料已删除；仅保留退款事实"),
      productionAttemptId: null,
    };
  }
  async readIn(tx: Tx, id: string) {
    const row = await tx.refund.findUnique({ where: { id } });
    if (!row) throw new NotFoundException();
    const attempt = await tx.fulfillmentAttempt.findFirst({
      where: { projectId: row.projectId },
      orderBy: { createdAt: "desc" },
    });
    let rule = row.rule as unknown as RefundRule | null;
    if (!rule)
      try {
        rule = this.rule(
          await tx.paymentOrder.findUniqueOrThrow({
            where: { id: row.orderId },
          }),
          row.reason,
        );
      } catch {
        /* Unfrozen or unsupported policies remain visibly unavailable. */
      }
    return {
      ...this.view(row, await this.rights.deletedIn(tx, row.projectId)),
      rule,
      productionAttemptId: attempt?.id ?? null,
      productionReviewRequired:
        !!attempt &&
        [
          "handoff_pending",
          "in_production",
          "shipped",
          "cancellation_pending",
        ].includes(attempt.state) &&
        !row.productionEvidence &&
        !row.productionEvidenceHash,
    };
  }
  async listIn(tx: Tx, order: PaymentOrder): Promise<OrderRefundsView> {
    const rows = await tx.refund.findMany({
        where: { orderId: order.id },
        orderBy: { createdAt: "desc" },
      }),
      paid = await tx.paymentTransaction.findUnique({
        where: { orderId: order.id },
      });
    const refunded = rows
        .filter((r) => r.state === "succeeded")
        .reduce((sum, r) => sum + (r.amount ?? 0), 0),
      reserved = rows
        .filter((r) => isReservedRefund(r.state))
        .reduce((sum, r) => sum + (r.amount ?? 0), 0);
    return {
      orderId: order.id,
      paidAmountFen: paid?.amount ?? 0,
      refundedAmountFen: refunded,
      reservedAmountFen: reserved,
      availableAmountFen: (paid?.amount ?? 0) - refunded - reserved,
      productionFrozen: order.productionFrozen,
      creationState: order.creationState,
      refunds: await Promise.all(rows.map((r) => this.readIn(tx, r.id))),
    };
  }
  async list(orderId: string, authorization?: string) {
    this.enabled();
    const order = await this.orders.owned(authorization, orderId);
    return this.database.$transaction((tx) => this.listIn(tx, order));
  }
  async request(
    orderId: string,
    authorization: string | undefined,
    key: string,
    body: RequestRefundDto,
  ) {
    this.enabled();
    const requestedAt = this.runtime.now();
    const user = await this.identity.current(authorization);
    return this.database.$transaction(async (tx) => {
      await this.identity.current(authorization, tx);
      return this.requestIn(tx, orderId, user.id, key, body, requestedAt);
    });
  }
  // Trusted T28 composition: caller keeps the buyer's real session locked.
  async requestIn(
    tx: Tx,
    orderId: string,
    buyerId: string,
    key: string,
    body: RequestRefundDto,
    requestedAt = this.runtime.now(),
  ) {
    this.enabled();
    const order = await tx.paymentOrder.findUnique({
      where: { id: orderId },
    });
    if (!order || order.buyerId !== buyerId) throw new NotFoundException();
    await tx.$queryRaw`SELECT id FROM payment_orders WHERE id=${orderId}::uuid FOR UPDATE`;
    const project = await tx.project.findUnique({ where: { orderId } });
    if (order.state !== "paid" || !project) throw new ConflictException();
    await tx.$queryRaw`SELECT id FROM projects WHERE id=${project.id}::uuid FOR UPDATE`;
    const prior = await tx.refund.findUnique({
      where: {
        orderId_requesterId_requestKey: {
          orderId,
          requesterId: buyerId,
          requestKey: key,
        },
      },
    });
    if (prior) {
      if (prior.requestHash !== hash(body)) throw conflict();
      return this.view(prior, await this.rights.deletedIn(tx, project.id));
    }
    const subject = await tx.projectSubject.findUniqueOrThrow({
        where: { projectId: project.id },
      }),
      id = randomUUID(),
      caseId = randomUUID();
    await tx.careRequest.create({
      data: {
        id: caseId,
        projectId: project.id,
        requesterId: buyerId,
        requesterSubjectId: subject.id,
        operatorId: buyerId,
        operatorRealm: "product",
        sourceBindingVersion: subject.bindingVersion,
        sourceAccessEpoch: project.accessEpoch,
        idempotencyKey: `refund-${key}`,
        requestHash: hash(body),
        kind: "refund",
        createdAt: requestedAt,
      },
    });
    const materialsDeleted = await this.rights.deletedIn(tx, project.id);
    return this.view(
      await tx.refund.create({
        data: {
          id,
          caseId,
          orderId,
          projectId: project.id,
          requesterId: buyerId,
          requestKey: key,
          requestHash: hash(body),
          reason: body.reason,
          evidenceRef: materialsDeleted ? null : body.evidenceRef,
          outRefundNo: "TNR" + id.replaceAll("-", ""),
          createdAt: requestedAt,
        },
      }),
      materialsDeleted,
    );
  }
  private rule(order: PaymentOrder, reason: string): RefundRule {
    const admission = (
      order.packageSnapshot as { admission?: { d07?: Record<string, unknown> } }
    ).admission?.d07;
    const rule = admission?.[reason] as RefundRule | undefined;
    const review = admission?.review as { state?: string } | undefined;
    if (
      review?.state !== "frozen" ||
      admission?.refundDeletesData !== false ||
      !rule ||
      !Number.isSafeInteger(rule.refundAmount?.value) ||
      rule.refundAmount.value <= 0 ||
      rule.refundAmount.unit !== "fen" ||
      !Number.isSafeInteger(rule.requestWindow?.duration?.value) ||
      rule.requestWindow.duration.value <= 0 ||
      rule.requestWindow.duration.unit !== "calendar_days" ||
      !Number.isSafeInteger(rule.processing?.within?.value) ||
      rule.processing.within.value <= 0 ||
      rule.processing.within.unit !== "calendar_days" ||
      rule.processing.startsAt !== "verified_refund_request" ||
      !["refund", "reprint_or_refund", "resend_or_refund"].includes(
        rule.remedy,
      ) ||
      !["retain", "suspend", "terminate"].includes(
        rule.entitlementEffect?.creation,
      ) ||
      !["retain", "cancel", "consumed", "quality_remedy"].includes(
        rule.entitlementEffect?.firstCopy,
      ) ||
      ![
        "none",
        "check_and_stop_if_possible",
        "remedy_original_order",
        "already_produced",
      ].includes(rule.productionAction) ||
      !rule.policyRef ||
      !rule.ownerRef
    )
      throw new ConflictException("Frozen D07 policy required");
    return rule;
  }
  private async lock(tx: Tx, id: string) {
    const refund = await tx.refund.findUnique({ where: { id } });
    if (!refund) throw new NotFoundException();
    await tx.$queryRaw`SELECT id FROM payment_orders WHERE id=${refund.orderId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM projects WHERE id=${refund.projectId}::uuid FOR UPDATE`;
    return {
      refund: await tx.refund.findUniqueOrThrow({ where: { id } }),
      order: await tx.paymentOrder.findUniqueOrThrow({
        where: { id: refund.orderId },
      }),
    };
  }
  // The order lock must cover both state validation and the final claim. An
  // earlier authorized command is not a reservation once another actor ends it.
  private async assertReservationIn(
    tx: Tx,
    refund: Refund,
    order: PaymentOrder,
  ) {
    if (
      !isReservedRefund(refund.state) ||
      !refund.approvedAt ||
      !refund.amount ||
      !refund.rule ||
      order.state !== "paid"
    )
      throw new ConflictException(
        "Current approved refund reservation required",
      );
    const payment = await tx.paymentTransaction.findUnique({
        where: { orderId: order.id },
      }),
      rows = await tx.refund.findMany({
        where: { orderId: order.id },
        select: { state: true, amount: true },
      });
    const committed = rows
      .filter((row) => row.state === "succeeded" || isReservedRefund(row.state))
      .reduce((sum, row) => sum + (row.amount ?? 0), 0);
    const rule = refund.rule as unknown as RefundRule;
    if (
      !payment ||
      payment.currency !== order.currency ||
      refund.amount !== rule.refundAmount?.value ||
      refund.amount > payment.amount ||
      committed > payment.amount
    )
      throw new ConflictException("Approved refund funds are not reserved");
  }
  private async command(
    tx: Tx,
    refundId: string,
    actorId: string,
    action: string,
    key: string,
    body: unknown,
  ) {
    const where = {
        refundId_actorId_action_key: { refundId, actorId, action, key },
      },
      prior = await tx.refundCommand.findUnique({ where }),
      requestHash = hash(body);
    if (prior) {
      if (prior.requestHash !== requestHash) throw conflict();
      return false;
    }
    const refund = await tx.refund.findUniqueOrThrow({
      where: { id: refundId },
      select: { projectId: true },
    });
    const erased = await this.rights.deletedIn(tx, refund.projectId);
    await tx.refundCommand.create({
      data: {
        refundId,
        actorId,
        action,
        key,
        requestHash,
        payload: erased
          ? Prisma.DbNull
          : (JSON.parse(JSON.stringify(body)) as Prisma.InputJsonValue),
      },
    });
    return true;
  }
  private async eligibility(
    tx: Tx,
    row: Refund,
    rule: RefundRule,
    body: ApproveRefundDto,
  ) {
    const payment = await tx.paymentTransaction.findUniqueOrThrow({
        where: { orderId: row.orderId },
      }),
      events = await tx.projectServiceEvent.findMany({
        where: { projectId: row.projectId, occurredAt: { lte: row.createdAt } },
      }),
      attempts = await tx.fulfillmentAttempt.findMany({
        where: { projectId: row.projectId, createdAt: { lte: row.createdAt } },
        orderBy: { createdAt: "asc" },
      }),
      used = await tx.interview.findFirst({
        where: { projectId: row.projectId, createdAt: { lte: row.createdAt } },
        orderBy: { createdAt: "asc" },
      });
    const participation = events.find(
        (e) => e.kind === "subject_participation",
      ),
      delivery = events.find((e) => e.kind === "delivery_completed");
    const accepted = await tx.fulfillmentRecord.findFirst({
      where: {
        attemptId: { in: attempts.map((a) => a.id) },
        kind: "receipt_accepted",
        createdAt: { lte: row.createdAt },
      },
      orderBy: { createdAt: "asc" },
    });
    let start: Date | undefined;
    if (row.reason === "notParticipated") {
      if (
        participation ||
        used ||
        attempts.some((a) => a.state !== "cancelled") ||
        rule.requestWindow.startsAt !== "payment_verified"
      )
        throw new ConflictException("Participation has started");
      start = payment.paidAt;
    } else if (row.reason === "usedNotProduced") {
      if (
        !used ||
        accepted ||
        rule.requestWindow.startsAt !== "service_first_used"
      )
        throw new ConflictException(
          "Used without production evidence required",
        );
      start = used.createdAt;
    } else if (row.reason === "inProduction") {
      if (!accepted || rule.requestWindow.startsAt !== "production_accepted")
        throw new ConflictException("Production acceptance required");
      start = accepted.createdAt;
    } else if (row.reason.startsWith("quality")) {
      if (!delivery || rule.requestWindow.startsAt !== "delivered")
        throw new ConflictException("Delivery required");
      start = delivery.occurredAt;
    } else if (row.reason === "platformUnableDeliver") {
      if (
        !body.failureNotifiedAt ||
        rule.requestWindow.startsAt !== "failure_notified"
      )
        throw new ConflictException("Verified failure notice required");
      start = new Date(body.failureNotifiedAt);
    }
    const expiresAt = start
      ? new Date(start.getTime() + rule.requestWindow.duration.value * 86400000)
      : null;
    if (
      !start ||
      !expiresAt ||
      start > row.createdAt ||
      row.createdAt >= expiresAt
    )
      throw new ConflictException("Refund request window unavailable");
    return { requestWindowStartedAt: start, requestWindowEndsAt: expiresAt };
  }
  async approveIn(
    tx: Tx,
    id: string,
    body: ApproveRefundDto,
    actorId: string,
    key: string,
  ) {
    this.enabled();
    const { refund, order } = await this.lock(tx, id);
    const fresh = await this.command(tx, id, actorId, "approve", key, body);
    if (!fresh) return this.readIn(tx, id);
    if (refund.state !== "requested") throw new ConflictException();
    const rule = this.rule(order, refund.reason);
    if (body.amountFen !== rule.refundAmount.value)
      throw new ConflictException("Exact purchased policy amount required");
    const window = await this.eligibility(tx, refund, rule, body);
    const balance = await this.listIn(tx, order);
    if (body.amountFen > balance.availableAmountFen)
      throw new ConflictException("Insufficient refundable balance");
    const now = this.runtime.now();
    await tx.refund.update({
      where: { id },
      data: {
        amount: body.amountFen,
        state: "approved",
        rule: JSON.parse(JSON.stringify(rule)) as Prisma.InputJsonValue,
        approvedBy: actorId,
        approvedAt: now,
        ...window,
        dueAt: new Date(
          now.getTime() + rule.processing.within.value * 86400000,
        ),
      },
    });
    await tx.paymentOrder.update({
      where: { id: order.id },
      data: { productionFrozen: true },
    });
    await tx.careRequest.update({
      where: { id: refund.caseId },
      data: {
        state: "verified",
        verifiedBy: actorId,
        verifiedAt: now,
        verificationEvidence: (await this.rights.deletedIn(
          tx,
          refund.projectId,
        ))
          ? null
          : body.evidenceRef,
      },
    });
    return this.readIn(tx, id);
  }
  async forCaseIn(tx: Tx, caseId: string) {
    const row = await tx.refund.findUnique({ where: { caseId } });
    if (!row) throw new NotFoundException();
    return this.readIn(tx, row.id);
  }
  async rejectIn(
    tx: Tx,
    id: string,
    body: RefundEvidenceDto,
    actorId: string,
    key: string,
  ) {
    const { refund, order } = await this.lock(tx, id);
    const fresh = await this.command(tx, id, actorId, "reject", key, body);
    if (!fresh) return this.readIn(tx, id);
    if (refund.submittedAt || !["requested", "approved"].includes(refund.state))
      throw new ConflictException(
        "Submitted money requires provider reconciliation",
      );
    await tx.refund.update({
      where: { id },
      data: { state: "rejected", completedAt: this.runtime.now() },
    });
    await tx.careRequest.update({
      where: { id: refund.caseId },
      data: { state: "completed", completedBy: actorId },
    });
    const active = await tx.refund.count({
      where: {
        orderId: order.id,
        state: { in: RESERVED_REFUND_STATES },
      },
    });
    await tx.paymentOrder.update({
      where: { id: order.id },
      data: {
        productionFrozen: active > 0 || order.creationState !== "active",
      },
    });
    return this.readIn(tx, id);
  }
  async reviewProductionIn(
    tx: Tx,
    id: string,
    body: RefundProductionReviewDto,
    actorId: string,
    key: string,
  ) {
    const { refund } = await this.lock(tx, id);
    await this.command(tx, id, actorId, "production-review", key, body);
    if (!refund.approvedAt || refund.submittedAt) throw new ConflictException();
    const latest = await tx.fulfillmentAttempt.findFirst({
      where: { projectId: refund.projectId },
      orderBy: { createdAt: "desc" },
    });
    if (
      !latest ||
      latest.id !== body.attemptId ||
      !["in_production", "shipped", "delivered", "cancelled"].includes(
        latest.state,
      )
    )
      throw new ConflictException("Original handoff still unknown");
    await tx.refund.update({
      where: { id },
      data: {
        productionEvidence: (await this.rights.deletedIn(tx, refund.projectId))
          ? null
          : body.evidenceRef,
        productionEvidenceHash: hash(body.evidenceRef),
      },
    });
    return this.readIn(tx, id);
  }
  async executionIn(
    tx: Tx,
    id: string,
    actorId: string,
    key: string,
    action: string,
    body: EmptyPaymentCommand,
  ) {
    if (Object.keys(body).length) throw new BadRequestException();
    const { refund } = await this.lock(tx, id);
    await this.command(tx, id, actorId, action, key, body);
    if (
      !isReservedRefund(refund.state) &&
      !["succeeded", "closed"].includes(refund.state)
    )
      throw new ConflictException();
    if ((await this.readIn(tx, id)).productionReviewRequired)
      throw new ConflictException(
        "Verify original handoff before refund execution",
      );
    return id;
  }
  private verified(
    order: PaymentOrder,
    row: Refund,
    transactionId: string,
    data: Record<string, unknown>,
    notification = false,
    eventType?: string,
  ) {
    const amount = data.amount as
      | {
          total?: unknown;
          refund?: unknown;
          currency?: unknown;
          payer_total?: unknown;
          payer_refund?: unknown;
        }
      | undefined;
    const status = notification ? data.refund_status : data.status;
    if (
      data.out_trade_no !== order.outTradeNo ||
      data.out_refund_no !== row.outRefundNo ||
      data.transaction_id !== transactionId ||
      typeof data.refund_id !== "string" ||
      !data.refund_id ||
      data.refund_id.length > 128 ||
      amount?.total !== order.amount ||
      amount.refund !== row.amount ||
      (amount.currency !== undefined && amount.currency !== order.currency) ||
      (amount.payer_total !== undefined &&
        amount.payer_total !== order.amount) ||
      (amount.payer_refund !== undefined &&
        amount.payer_refund !== row.amount) ||
      !["SUCCESS", "CLOSED", "PROCESSING", "ABNORMAL"].includes(
        String(status),
      ) ||
      (notification &&
        (data.mchid !== order.merchantId ||
          eventType !== `REFUND.${status}`)) ||
      (status === "SUCCESS" &&
        (typeof data.success_time !== "string" ||
          !Number.isFinite(Date.parse(data.success_time)) ||
          Date.parse(data.success_time) > Date.now() + 300000))
    )
      throw new BadRequestException(
        "Refund result did not match approved money",
      );
    return {
      out_trade_no: order.outTradeNo,
      out_refund_no: row.outRefundNo,
      transaction_id: transactionId,
      refund_id: data.refund_id,
      status: status as string,
      amount: {
        total: order.amount,
        refund: row.amount,
        currency: order.currency,
      },
      success_time: status === "SUCCESS" ? (data.success_time as string) : null,
    };
  }
  private async apply(
    id: string,
    value: ReturnType<Refunds["verified"]>,
    eventId?: string,
  ) {
    await this.database.$transaction(async (tx) => {
      const { refund, order } = await this.lock(tx, id);
      if (!refund.approvedAt || !refund.amount) throw new ConflictException();
      if (
        refund.providerRefundId &&
        refund.providerRefundId !== value.refund_id
      )
        throw new ConflictException();
      if (refund.state === "succeeded" && value.status !== "SUCCESS") {
        if (eventId)
          await tx.refundInbox.update({
            where: { eventId },
            data: { processedAt: new Date() },
          });
        return;
      }
      if (refund.state === "closed" && value.status !== "CLOSED")
        throw new ConflictException();
      if (!["succeeded", "closed"].includes(refund.state))
        await this.assertReservationIn(tx, refund, order);
      const state = {
        SUCCESS: "succeeded",
        CLOSED: "closed",
        PROCESSING: "processing",
        ABNORMAL: "abnormal",
      }[value.status]!;
      if (state === "succeeded" && refund.state !== "succeeded") {
        const balances = await this.listIn(tx, order);
        if (
          balances.refundedAmountFen + balances.reservedAmountFen >
          order.amount
        )
          throw new ConflictException();
        const rule = refund.rule as unknown as RefundRule;
        // Physical facts remain intact; only a confirmed cancellation can release
        // a reserved/consumed original first-copy. Money never deletes content.
        const effect = rule.entitlementEffect;
        await tx.paymentOrder.update({
          where: { id: order.id },
          data: {
            firstCopyCancellationRequired:
              order.firstCopyCancellationRequired ||
              effect.firstCopy === "cancel",
            creationState:
              effect.creation === "terminate"
                ? "terminated"
                : effect.creation === "suspend" &&
                    order.creationState !== "terminated"
                  ? "suspended"
                  : order.creationState,
          },
        });
        if (effect.firstCopy === "cancel")
          await tx.firstCopyEntitlement.updateMany({
            where: {
              orderId: order.id,
              state: { in: ["available", "reserved", "suspended"] },
            },
            data: { state: "revoked" },
          });
        else if (effect.firstCopy === "consumed")
          await tx.firstCopyEntitlement.updateMany({
            where: {
              orderId: order.id,
              state: { in: ["available", "reserved"] },
            },
            data: { state: "consumed" },
          });
      }
      await tx.refund.update({
        where: { id },
        data: {
          state,
          providerRefundId: value.refund_id,
          completedAt: ["succeeded", "closed"].includes(state)
            ? (refund.completedAt ??
              (value.success_time ? new Date(value.success_time) : new Date()))
            : null,
        },
      });
      if (["succeeded", "closed"].includes(state))
        await tx.careRequest.update({
          where: { id: refund.caseId },
          data: { state: "completed", completedBy: refund.approvedBy },
        });
      const active = await tx.refund.count({
          where: {
            orderId: order.id,
            state: { in: RESERVED_REFUND_STATES },
          },
        }),
        final = await tx.paymentOrder.findUniqueOrThrow({
          where: { id: order.id },
        });
      await tx.paymentOrder.update({
        where: { id: order.id },
        data: {
          productionFrozen: active > 0 || final.creationState !== "active",
        },
      });
      if (eventId)
        await tx.refundInbox.update({
          where: { eventId },
          data: { processedAt: new Date() },
        });
    });
  }
  async execute(id: string, submit: boolean) {
    await this.rights.assertHealthy();
    this.enabled();
    const provider = new WechatPay(this.config.payments!, this.paymentFetch);
    const claim = await this.database.$transaction(async (tx) => {
      const { refund, order } = await this.lock(tx, id);
      if (["succeeded", "closed"].includes(refund.state))
        return { refund, order, first: false, terminal: true };
      await this.assertReservationIn(tx, refund, order);
      if ((await this.readIn(tx, id)).productionReviewRequired)
        throw new ConflictException();
      const first = submit && !refund.submittedAt;
      if (first)
        await tx.refund.update({
          where: { id },
          data: { submittedAt: this.runtime.now(), state: "unknown" },
        });
      return { refund, order, first, terminal: false };
    });
    if (!claim.terminal)
      try {
        let result: Record<string, unknown> | null = null;
        if (claim.first)
          result = await provider.refund(claim.order, {
            outRefundNo: claim.refund.outRefundNo,
            amount: claim.refund.amount!,
          });
        else {
          result = await provider.queryRefund(claim.refund.outRefundNo);
          if (
            !result &&
            submit &&
            claim.refund.submittedAt &&
            this.runtime.now().getTime() - claim.refund.submittedAt.getTime() >=
              10000
          ) {
            const retry = await this.database.$transaction(async (tx) => {
              const { refund, order } = await this.lock(tx, id);
              if (
                refund.submittedAt?.getTime() !==
                  claim.refund.submittedAt!.getTime() ||
                ["succeeded", "closed"].includes(refund.state)
              )
                return false;
              await this.assertReservationIn(tx, refund, order);
              await tx.refund.update({
                where: { id },
                data: { submittedAt: this.runtime.now(), state: "unknown" },
              });
              return true;
            });
            if (retry)
              result = await provider.refund(claim.order, {
                outRefundNo: claim.refund.outRefundNo,
                amount: claim.refund.amount!,
              });
          }
        }
        if (result) {
          const payment =
            await this.database.paymentTransaction.findUniqueOrThrow({
              where: { orderId: claim.order.id },
            });
          await this.apply(
            id,
            this.verified(
              claim.order,
              claim.refund,
              payment.providerTransactionId,
              result,
            ),
          );
        }
      } catch {
        /* Unknown network, signature and validation results keep the original reservation. */
      }
    return this.database.$transaction((tx) => this.readIn(tx, id));
  }
  async notification(raw: string, headers: Headers) {
    this.enabled();
    let notice: ReturnType<WechatPay["decryptRefund"]>;
    try {
      notice = new WechatPay(
        this.config.payments!,
        this.paymentFetch,
      ).decryptRefund(raw, headers);
    } catch {
      throw new BadRequestException();
    }
    const refund = await this.database.refund.findUnique({
      where: { outRefundNo: String(notice.transaction.out_refund_no) },
    });
    if (!refund || !refund.approvedAt || !refund.submittedAt)
      throw new BadRequestException();
    const order = await this.database.paymentOrder.findUniqueOrThrow({
        where: { id: refund.orderId },
      }),
      payment = await this.database.paymentTransaction.findUniqueOrThrow({
        where: { orderId: refund.orderId },
      }),
      verified = this.verified(
        order,
        refund,
        payment.providerTransactionId,
        notice.transaction,
        true,
        notice.eventType,
      ),
      payloadHash = hash(verified);
    await this.database.$transaction(async (tx) => {
      await tx.refundInbox.createMany({
        data: {
          eventId: notice.eventId,
          refundId: refund.id,
          payloadHash,
          verifiedRefund: verified,
        },
        skipDuplicates: true,
      });
      const prior = await tx.refundInbox.findUniqueOrThrow({
        where: { eventId: notice.eventId },
      });
      if (prior.refundId !== refund.id || prior.payloadHash !== payloadHash)
        throw conflict();
    });
    await this.apply(refund.id, verified, notice.eventId);
  }
  onModuleInit() {
    if (!this.config.payments) return;
    this.scan = setInterval(() => {
      if (this.stopped || this.recovery) return;
      this.recovery = this.recover()
        .catch(() => {})
        .finally(() => {
          this.recovery = undefined;
        });
    }, 1000);
    this.scan.unref();
  }
  async recover() {
    await this.rights.assertHealthy();
    const inbox = await this.database.refundInbox.findMany({
      where: { processedAt: null },
      take: 25,
    });
    for (const row of inbox)
      try {
        await this.apply(
          row.refundId,
          row.verifiedRefund as unknown as ReturnType<Refunds["verified"]>,
          row.eventId,
        );
      } catch {}
    const rows = await this.database.refund.findMany({
      where: {
        state: { in: ["unknown", "processing", "abnormal"] },
        submittedAt: { lt: new Date(this.runtime.now().getTime() - 10000) },
      },
      take: 25,
    });
    for (const row of rows)
      try {
        await this.execute(row.id, false);
      } catch {}
  }
  async onModuleDestroy() {
    this.stopped = true;
    if (this.scan) clearInterval(this.scan);
    await this.recovery;
    await this.database.$disconnect();
  }
}
@Controller("v1/admin/refunds")
@ApiTags("Administration refunds")
@ApiCookieAuth("timenook-admin")
export class AdminRefundsController {
  constructor(
    private readonly refunds: Refunds,
    private readonly access: AdminAccess,
  ) {}
  private run<T>(
    req: FastifyRequest,
    action: string,
    work: (tx: Tx, actorId: string) => Promise<T>,
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
  @Get("cases/:caseId") @Header("Cache-Control", "no-store") async forCase(
    @Param("caseId", ParseUUIDPipe) id: string,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.run(req, "refund.read", (tx) =>
        this.refunds.forCaseIn(tx, id),
      ),
      meta: { requestId: req.id },
    };
  }
  @Get(":id") @Header("Cache-Control", "no-store") async read(
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.run(req, "refund.read", (tx) =>
        this.refunds.readIn(tx, id),
      ),
      meta: { requestId: req.id },
    };
  }
  @Post(":id/approve")
  @Header("Cache-Control", "no-store")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  async approve(
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: FastifyRequest,
    @Body() body: ApproveRefundDto,
  ) {
    return {
      data: await this.run(req, "refund.approve", (tx, actor) =>
        this.refunds.approveIn(tx, id, body, actor, idempotencyKey(req)),
      ),
      meta: { requestId: req.id },
    };
  }
  @Post(":id/reject")
  @Header("Cache-Control", "no-store")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  async reject(
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: FastifyRequest,
    @Body() body: RefundEvidenceDto,
  ) {
    return {
      data: await this.run(req, "refund.reject", (tx, actor) =>
        this.refunds.rejectIn(tx, id, body, actor, idempotencyKey(req)),
      ),
      meta: { requestId: req.id },
    };
  }
  @Post(":id/production-review")
  @Header("Cache-Control", "no-store")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  async review(
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: FastifyRequest,
    @Body() body: RefundProductionReviewDto,
  ) {
    return {
      data: await this.run(req, "refund.production-review", (tx, actor) =>
        this.refunds.reviewProductionIn(
          tx,
          id,
          body,
          actor,
          idempotencyKey(req),
        ),
      ),
      meta: { requestId: req.id },
    };
  }
  @Post(":id/submit")
  @Header("Cache-Control", "no-store")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  async submit(
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: FastifyRequest,
    @Body() body: EmptyPaymentCommand,
  ) {
    await this.run(req, "refund.submit", (tx, actor) =>
      this.refunds.executionIn(
        tx,
        id,
        actor,
        idempotencyKey(req),
        "submit",
        body,
      ),
    );
    await this.refunds.beforeExecution(id);
    return {
      data: await this.refunds.execute(id, true),
      meta: { requestId: req.id },
    };
  }
  @Post(":id/reconcile")
  @Header("Cache-Control", "no-store")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  async reconcile(
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: FastifyRequest,
    @Body() body: EmptyPaymentCommand,
  ) {
    await this.run(req, "refund.reconcile", (tx, actor) =>
      this.refunds.executionIn(
        tx,
        id,
        actor,
        idempotencyKey(req),
        "reconcile",
        body,
      ),
    );
    return {
      data: await this.refunds.execute(id, false),
      meta: { requestId: req.id },
    };
  }
}
@Controller("v1/webhooks/wechat-pay")
@ApiTags("Wechat Pay refunds")
export class RefundWebhookController {
  constructor(private readonly refunds: Refunds) {}
  @Post("refunds") @HttpCode(204) async notification(
    @Req() req: RawBodyRequest<FastifyRequest>,
  ) {
    if (!req.rawBody) throw new BadRequestException();
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers))
      if (typeof value === "string") headers.set(key, value);
    await this.refunds.notification(req.rawBody.toString("utf8"), headers);
  }
}
@Controller("v1/orders/:orderId/refunds")
@ApiTags("Refunds")
@ApiBearerAuth()
export class RefundsController {
  constructor(private readonly refunds: Refunds) {}
  @Get() @Header("Cache-Control", "no-store") async list(
    @Param("orderId", ParseUUIDPipe) id: string,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.refunds.list(id, req.headers.authorization),
      meta: { requestId: req.id },
    };
  }
  @Post()
  @Header("Cache-Control", "no-store")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  async request(
    @Param("orderId", ParseUUIDPipe) id: string,
    @Req() req: FastifyRequest,
    @Body() body: RequestRefundDto,
  ) {
    return {
      data: await this.refunds.request(
        id,
        req.headers.authorization,
        idempotencyKey(req),
        body,
      ),
      meta: { requestId: req.id },
    };
  }
}
