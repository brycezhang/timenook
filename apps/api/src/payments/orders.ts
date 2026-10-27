import { PrivacyRights } from "../care/privacy-rights";
import {
  PaymentOrderResponseDto,
  PaymentOrdersResponseDto,
  PreparedPaymentResponseDto,
} from "./payment-contract";
import { ProjectServiceTerms } from "../projects/service-terms";
import { ProjectPlans } from "../projects/project-plans";
import type { BuiltinTemplate } from "../projects/builtin-template";
import { WechatPay } from "./wechat-pay";
import { PaymentIdempotencyConflict } from "./errors";
import { createHash, randomUUID } from "node:crypto";
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
  ForbiddenException,
  NotFoundException,
  BadRequestException,
  ConflictException,
  HttpException,
  HttpCode,
  RawBodyRequest,
  OnModuleInit,
} from "@nestjs/common";
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiBearerAuth,
  ApiHeader,
  ApiTags,
  ApiProperty,
  ApiPropertyOptional,
} from "@nestjs/swagger";
import {
  IsUUID,
  IsOptional,
  IsString,
  Length,
  Matches,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { PrismaClient, Prisma, PaymentOrder } from "@prisma/client";
import type { FastifyRequest } from "fastify";
import { API_CONFIG, ApiConfig } from "../config";
import { IdentityAccess } from "../identity/identity-access";
import { BUILTIN_TEMPLATE } from "../projects/builtin-template";
class RecipientDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(/^[a-z][a-z0-9_-]{1,39}$/)
  typeCode?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 40)
  @Matches(/^[^\u0000-\u001f\u007f<>]+$/)
  relationshipLabel?: string;
}
export class CreateOrderDto {
  @ApiProperty() @IsUUID() packageVersionId!: string;
  @ApiProperty({ type: RecipientDto })
  @ValidateNested()
  @Type(() => RecipientDto)
  recipient!: RecipientDto;
  @ApiProperty() @IsString() @Length(1, 80) shippingRegionCode!: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 40)
  @Matches(/^[^\u0000-\u001f\u007f<>]+$/)
  subjectName?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 80)
  @Matches(/^[^\u0000-\u001f\u007f<>]+$/)
  bookTitle?: string;
}
export const PAYMENT_FETCH = Symbol("PAYMENT_FETCH");
export class EmptyPaymentCommand {}
export const hash = (value: unknown): string =>
  createHash("sha256")
    .update(
      JSON.stringify(value, (_key, value: unknown) =>
        value && typeof value === "object" && !Array.isArray(value)
          ? Object.fromEntries(
              Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
            )
          : value,
      ),
    )
    .digest("hex");
const json = (value: unknown) =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
export function idempotencyKey(request: FastifyRequest) {
  const key = request.headers["idempotency-key"];
  if (typeof key !== "string" || !/^[A-Za-z0-9_-]{8,100}$/.test(key))
    throw new BadRequestException();
  return key;
}
export function conflict() {
  return new PaymentIdempotencyConflict();
}
@Injectable()
export class Orders implements OnModuleDestroy, OnModuleInit {
  readonly database: PrismaClient;
  private scan?: NodeJS.Timeout;
  private recovery?: Promise<void>;
  private stopped = false;
  private readonly plans: ProjectPlans;
  private readonly terms: ProjectServiceTerms;
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly identity: IdentityAccess,
    private readonly rights: PrivacyRights,
    @Inject(PAYMENT_FETCH) private readonly paymentFetch: typeof fetch,
  ) {
    this.database = new PrismaClient({ datasourceUrl: config.databaseUrl });
    this.plans = new ProjectPlans(config.databaseUrl);
    this.terms = new ProjectServiceTerms(config.databaseUrl);
  }
  async buyer(authorization?: string) {
    const user = await this.identity.current(authorization);
    const identity = await this.database.wechatIdentity.findFirst({
      where: { userId: user.id, appId: this.config.wechat?.appId ?? "" },
    });
    if (!identity) throw new ForbiddenException();
    return identity;
  }
  enabled() {
    if (!this.config.payments || this.config.environment !== "test")
      throw new ForbiddenException();
    return this.config.payments;
  }
  async create(
    authorization: string | undefined,
    key: string,
    body: CreateOrderDto,
  ) {
    const buyer = await this.buyer(authorization);
    const cfg = this.enabled();
    const requestHash = hash(body);
    const order = await this.database.$transaction(async (tx) => {
      // Same actor + create-order operation + order collection + key. The order
      // is the durable idempotency record, never an expiring Redis entry.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${buyer.userId + ":create-order:" + key},0))`;
      const existing = await tx.paymentOrder.findUnique({
        where: {
          buyerId_idempotencyKey: {
            buyerId: buyer.userId,
            idempotencyKey: key,
          },
        },
      });
      if (existing) {
        if (existing.requestHash !== requestHash) throw conflict();
        return existing;
      }
      const version = await tx.packageVersion.findFirst({
        where: {
          id: body.packageVersionId,
          realm: "local",
          purpose: "local_preview",
        },
      });
      if (!version) throw new BadRequestException();
      const snapshot = version.snapshot as {
        admission?: { d05?: { includedRegionCodes?: string[] } };
      };
      if (
        !snapshot.admission?.d05?.includedRegionCodes?.includes(
          body.shippingRegionCode,
        )
      )
        throw new BadRequestException();
      if (!body.recipient) throw new BadRequestException();
      const relationship = body.recipient.typeCode
        ? await tx.recipientType.findFirst({
            where: {
              realm: "local",
              code: body.recipient.typeCode,
              active: true,
            },
          })
        : null;
      if (body.recipient.typeCode && !relationship)
        throw new ConflictException();
      const recipient = {
        typeCode: relationship?.code ?? null,
        relationshipLabel:
          body.recipient.relationshipLabel?.trim() ||
          relationship?.label ||
          "讲述者",
      };
      const order = await tx.paymentOrder.create({
        data: {
          id: randomUUID(),
          buyerId: buyer.userId,
          appId: buyer.appId,
          openId: buyer.openId,
          merchantId: cfg.merchantId,
          outTradeNo: "TN" + randomUUID().replaceAll("-", "").slice(0, 30),
          idempotencyKey: key,
          requestHash,
          amount: 99900,
          currency: "CNY",
          mode: "local-verification",
          packageVersionId: version.id,
          packageSnapshot: version.snapshot as Prisma.InputJsonValue,
          recipient,
          template: json(BUILTIN_TEMPLATE),
          shippingRegionCode: body.shippingRegionCode,
          subjectName: body.subjectName?.trim() || null,
          bookTitle: body.bookTitle?.trim() || "我的时光手记",
        },
      });
      return order;
    });
    // Release the transaction connection and lock before loading the response.
    // view() uses the regular client and must not borrow from a pool held here.
    return this.view(order);
  }
  async prepare(
    authorization: string | undefined,
    id: string,
    key: string,
    body: EmptyPaymentCommand,
  ) {
    const order = await this.owned(authorization, id);
    const cfg = this.enabled();
    if (order.state !== "pending") throw new ConflictException();
    if (Object.keys(body).length) throw new BadRequestException();
    const reservation = await this.database.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM payment_orders WHERE id=${id}::uuid FOR UPDATE`;
      const current = await tx.paymentOrder.findUniqueOrThrow({
        where: { id },
      });
      if (current.state !== "pending") throw new ConflictException();
      const prior = await tx.paymentCommand.findUnique({
        where: { orderId_action_key: { orderId: id, action: "prepare", key } },
      });
      if (prior && prior.requestHash !== hash(body)) throw conflict();
      if (!prior)
        await tx.paymentCommand.create({
          data: {
            orderId: id,
            action: "prepare",
            key,
            requestHash: hash(body),
          },
        });
      const submission = await tx.paymentSubmission.findUnique({
        where: { orderId: id },
      });
      if (submission) return { submission, submit: false };
      return {
        submission: await tx.paymentSubmission.create({
          data: { orderId: id },
        }),
        submit: true,
      };
    });
    const submission = reservation.submission;
    const age = Date.now() - submission.submittedAt.getTime();
    if (submission.parameters && age < 7200000)
      return {
        mode: "local-verification",
        status: "prepared",
        parameters: submission.parameters,
      };
    let result: Prisma.InputJsonValue = {
      mode: "local-verification",
      status: "unknown",
      parameters: null,
    };
    const provider = new WechatPay(cfg, this.paymentFetch);
    try {
      let submit = reservation.submit;
      if (!submit) {
        const transaction = await provider.query(order.outTradeNo);
        if (transaction) {
          this.validateBinding(order, transaction);
          if (transaction.trade_state === "SUCCESS") {
            await this.applyVerifiedPayment(order, transaction);
            result = {
              mode: "local-verification",
              status: "paid",
              parameters: null,
            };
          } else if (transaction.trade_state === "CLOSED") {
            await this.database.paymentOrder.updateMany({
              where: { id, state: "pending" },
              data: { state: "closed" },
            });
            result = {
              mode: "local-verification",
              status: "closed",
              parameters: null,
            };
          } else if (transaction.trade_state === "NOTPAY") {
            result = {
              mode: "local-verification",
              status: "pending",
              parameters: null,
            };
            // The provider has positively identified the original unpaid order.
            // Expired/unknown attempts reuse its original number and frozen fields.
            if (age >= (submission.parameters ? 7200000 : 10000)) {
              const claimed = await this.database.paymentSubmission.updateMany({
                where: { orderId: id, submittedAt: submission.submittedAt },
                data: { submittedAt: new Date(), parameters: Prisma.DbNull },
              });
              submit = claimed.count === 1;
            }
          }
        }
      }
      if (submit) {
        const parameters = await provider.prepare(order);
        await this.database.paymentSubmission.update({
          where: { orderId: id },
          data: { parameters },
        });
        result = { mode: "local-verification", status: "prepared", parameters };
      }
    } catch {
      /* Unknown or unauthenticated results never grant entitlement or replace the order. */
    }
    await this.database.paymentCommand.update({
      where: { orderId_action_key: { orderId: id, action: "prepare", key } },
      data: { result },
    });
    return result;
  }
  async closeOrder(
    authorization: string | undefined,
    id: string,
    key: string,
    body: EmptyPaymentCommand,
  ) {
    const order = await this.owned(authorization, id);
    const cfg = this.enabled();
    if (Object.keys(body).length) throw new BadRequestException();
    await this.database.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM payment_orders WHERE id=${id}::uuid FOR UPDATE`;
      const prior = await tx.paymentCommand.findUnique({
        where: { orderId_action_key: { orderId: id, action: "close", key } },
      });
      if (prior && prior.requestHash !== hash(body)) throw conflict();
      if (!prior)
        await tx.paymentCommand.create({
          data: { orderId: id, action: "close", key, requestHash: hash(body) },
        });
    });
    await this.refresh(order);
    const current = await this.owned(authorization, id);
    if (current.state === "pending") {
      try {
        await new WechatPay(cfg, this.paymentFetch).close(order.outTradeNo);
      } catch {
        /* An uncertain close or paid error is resolved by the original order query. */
      }
      await this.refresh(order);
    }
    return this.view(await this.owned(authorization, id));
  }
  async owned(authorization: string | undefined, id: string) {
    const cfg = this.enabled();
    const buyer = await this.buyer(authorization);
    const order = await this.database.paymentOrder.findFirst({
      where: {
        id,
        buyerId: buyer.userId,
        appId: buyer.appId,
        merchantId: cfg.merchantId,
        mode: "local-verification",
      },
    });
    if (!order) throw new NotFoundException();
    return order;
  }
  async get(authorization: string | undefined, id: string) {
    const order = await this.owned(authorization, id);
    if (order.state !== "paid") await this.refresh(order);
    return this.view(await this.owned(authorization, id));
  }
  async list(authorization?: string) {
    const cfg = this.enabled();
    const buyer = await this.buyer(authorization);
    return {
      orders: await Promise.all(
        (
          await this.database.paymentOrder.findMany({
            where: {
              buyerId: buyer.userId,
              appId: buyer.appId,
              merchantId: cfg.merchantId,
              mode: "local-verification",
            },
            orderBy: { createdAt: "desc" },
            take: 50,
          })
        ).map((row) => this.view(row)),
      ),
    };
  }
  async view(order: PaymentOrder) {
    const project = await this.database.project.findUnique({
      where: { orderId: order.id },
    });
    const subject = project
      ? await this.database.projectSubject.findUnique({
          where: { projectId: project.id },
        })
      : null;
    const entitlement = project
      ? await this.database.firstCopyEntitlement.findUnique({
          where: { projectId: project.id },
        })
      : null;
    const deleted = project
      ? await this.rights.deletedIn(this.database as never, project.id)
      : false;
    const template = order.template as {
      id: string;
      version: number;
      reviewStatus: string;
    };
    return {
      id: order.id,
      outTradeNo: order.outTradeNo,
      amount: order.amount,
      currency: order.currency,
      mode: order.mode,
      state: order.state,
      packageVersionId: order.packageVersionId,
      materialsUnavailable: deleted,
      recipient: deleted
        ? { typeCode: null, relationshipLabel: "资料已删除" }
        : order.recipient,
      template: {
        id: template.id,
        version: template.version,
        reviewStatus: template.reviewStatus,
      },
      subjectName: deleted ? null : order.subjectName,
      bookTitle: deleted ? "资料已删除" : order.bookTitle,
      project:
        project && subject && entitlement && !deleted
          ? {
              id: project.id,
              subject: {
                id: subject.id,
                name: subject.name,
                consent: "not_granted",
              },
              bookTitle: order.bookTitle,
              recipient: order.recipient,
              plan: await this.plans.getProjectPlan(project.id),
              terms: await this.terms.read(project.id),
              entitlement: {
                id: entitlement.id,
                state: entitlement.state,
                copies: 1,
              },
            }
          : null,
    };
  }
  validateBinding(order: PaymentOrder, transaction: Record<string, unknown>) {
    const amount = transaction.amount as
      { total?: unknown; currency?: unknown } | undefined;
    const payer = transaction.payer as { openid?: unknown } | undefined;
    if (
      transaction.appid !== order.appId ||
      transaction.mchid !== order.merchantId ||
      transaction.out_trade_no !== order.outTradeNo ||
      amount?.total !== order.amount ||
      amount.currency !== order.currency ||
      (payer?.openid !== undefined && payer.openid !== order.openId)
    )
      throw new BadRequestException();
  }
  validatePayment(order: PaymentOrder, transaction: Record<string, unknown>) {
    this.validateBinding(order, transaction);
    if (
      transaction.trade_state !== "SUCCESS" ||
      typeof transaction.transaction_id !== "string" ||
      !transaction.transaction_id ||
      transaction.transaction_id.length > 128 ||
      typeof transaction.success_time !== "string" ||
      !Number.isFinite(Date.parse(transaction.success_time))
    )
      throw new BadRequestException();
    return {
      appid: order.appId,
      mchid: order.merchantId,
      out_trade_no: order.outTradeNo,
      amount: { total: order.amount, currency: order.currency },
      trade_state: "SUCCESS",
      transaction_id: transaction.transaction_id,
      success_time: transaction.success_time,
    };
  }
  async applyVerifiedPayment(
    order: PaymentOrder,
    transaction: Record<string, unknown>,
    eventId?: string,
  ) {
    const verified = this.validatePayment(order, transaction);
    const plans = new ProjectPlans(
      this.config.databaseUrl,
      order.template as unknown as BuiltinTemplate,
    );
    try {
      await this.database.$transaction(async (tx) => {
        // Global order -> project -> entitlement lock order. No provider I/O here.
        await tx.$queryRaw`SELECT id FROM payment_orders WHERE id=${order.id}::uuid FOR UPDATE`;
        const existing = await tx.paymentTransaction.findUnique({
          where: { orderId: order.id },
        });
        if (
          existing &&
          existing.providerTransactionId !== verified.transaction_id
        )
          throw new ConflictException();
        if (!existing) {
          await tx.paymentTransaction.create({
            data: {
              orderId: order.id,
              providerTransactionId: verified.transaction_id,
              paidAt: new Date(verified.success_time),
              amount: order.amount,
              currency: order.currency,
            },
          });
          const projectId = randomUUID();
          await plans.createProject(
            { projectId, createdBy: order.buyerId },
            tx,
          );
          await tx.project.update({
            where: { id: projectId },
            data: { orderId: order.id },
          });
          await tx.projectSubject.create({
            data: { id: randomUUID(), projectId, name: order.subjectName },
          });
          await tx.firstCopyEntitlement.create({
            data: { id: randomUUID(), orderId: order.id, projectId },
          });
          await this.terms.activate(
            tx,
            projectId,
            order.packageVersionId,
            order.packageSnapshot,
            new Date(verified.success_time),
          );
          await tx.paymentOrder.update({
            where: { id: order.id },
            data: { state: "paid" },
          });
        }
        if (eventId)
          await tx.paymentInbox.update({
            where: { eventId },
            data: { processedAt: new Date() },
          });
      });
    } finally {
      await plans.close();
    }
  }
  async refresh(order: PaymentOrder) {
    const cfg = this.enabled();
    if (
      !(await this.database.paymentSubmission.findUnique({
        where: { orderId: order.id },
      }))
    )
      return;
    const transaction = await new WechatPay(cfg, this.paymentFetch).query(
      order.outTradeNo,
    );
    if (transaction) {
      this.validateBinding(order, transaction);
      if (transaction.trade_state === "SUCCESS")
        await this.applyVerifiedPayment(order, transaction);
      else if (transaction.trade_state === "CLOSED")
        await this.database.paymentOrder.updateMany({
          where: { id: order.id, state: "pending" },
          data: { state: "closed" },
        });
    }
  }
  async notification(raw: string, headers: Headers) {
    const cfg = this.enabled();
    let notification: ReturnType<WechatPay["decrypt"]>;
    try {
      notification = new WechatPay(cfg, this.paymentFetch).decrypt(
        raw,
        headers,
      );
    } catch {
      throw new BadRequestException();
    }
    const order = await this.database.paymentOrder.findFirst({
      where: {
        outTradeNo: String(notification.transaction.out_trade_no),
        appId: cfg.appId,
        merchantId: cfg.merchantId,
        mode: "local-verification",
      },
    });
    if (!order) throw new BadRequestException();
    const verified = this.validatePayment(order, notification.transaction);
    const payloadHash = hash(verified);
    await this.database.$transaction(async (tx) => {
      await tx.paymentInbox.createMany({
        data: {
          eventId: notification.eventId,
          orderId: order.id,
          payloadHash,
          verifiedPayment: verified,
        },
        skipDuplicates: true,
      });
      const existing = await tx.paymentInbox.findUniqueOrThrow({
        where: { eventId: notification.eventId },
      });
      if (existing.orderId !== order.id || existing.payloadHash !== payloadHash)
        throw new ConflictException();
    });
    // ACK only after durable verification. A process crash is recovered by scan.
    void this.recover();
  }
  recover() {
    if (this.stopped) return Promise.resolve();
    return (this.recovery ??= this.scanInbox().finally(() => {
      this.recovery = undefined;
    }));
  }
  private async scanInbox() {
    const cfg = this.enabled();
    try {
      await this.rights.assertHealthy();
      const events = await this.database.paymentInbox.findMany({
        where: { processedAt: null },
        orderBy: { verifiedAt: "asc" },
        take: 50,
      });
      for (const event of events) {
        if (this.stopped) return;
        try {
          const order = await this.database.paymentOrder.findFirst({
            where: {
              id: event.orderId,
              appId: cfg.appId,
              merchantId: cfg.merchantId,
              mode: "local-verification",
            },
          });
          if (order)
            await this.applyVerifiedPayment(
              order,
              event.verifiedPayment as Record<string, unknown>,
              event.eventId,
            );
        } catch {
          /* Keep the verified fact pending for a later bounded scan. */
        }
      }
    } catch {
      /* Database readiness is reported by health; no payloads in logs. */
    }
  }
  async readTerms(projectId: string) {
    const cfg = this.enabled();
    const project = await this.database.project.findUnique({
      where: { id: projectId },
    });
    if (!project?.orderId) throw new NotFoundException();
    const order = await this.database.paymentOrder.findFirst({
      where: {
        id: project.orderId,
        appId: cfg.appId,
        merchantId: cfg.merchantId,
        mode: "local-verification",
      },
    });
    if (!order) throw new NotFoundException();
    return this.terms.read(projectId);
  }
  async changePause(
    tx: Prisma.TransactionClient,
    command: Parameters<ProjectServiceTerms["changePause"]>[0],
  ) {
    await this.readTerms(command.projectId);
    return this.terms.changePause(command, tx);
  }
  async onModuleInit() {
    if (!this.config.payments) return;
    this.enabled();
    await this.recover();
    this.scan = setInterval(() => {
      void this.recover();
    }, 1000);
    this.scan.unref();
  }
  async onModuleDestroy() {
    this.stopped = true;
    if (this.scan) clearInterval(this.scan);
    await this.recovery;
    await this.plans.close();
    await this.terms.close();
    await this.database.$disconnect();
  }
}
@Controller("v1/orders")
@ApiTags("Orders")
@ApiBearerAuth()
export class OrdersController {
  constructor(private readonly orders: Orders) {}
  @Header("Cache-Control", "no-store")
  @Post()
  @ApiCreatedResponse({ type: PaymentOrderResponseDto })
  @ApiHeader({ name: "Idempotency-Key", required: true })
  async create(@Req() request: FastifyRequest, @Body() body: CreateOrderDto) {
    return {
      data: await this.orders.create(
        request.headers.authorization,
        idempotencyKey(request),
        body,
      ),
      meta: { requestId: request.id },
    };
  }
  @Header("Cache-Control", "no-store")
  @Post(":id/payment")
  @ApiCreatedResponse({ type: PreparedPaymentResponseDto })
  @ApiHeader({ name: "Idempotency-Key", required: true })
  async prepare(
    @Req() request: FastifyRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: EmptyPaymentCommand,
  ) {
    return {
      data: await this.orders.prepare(
        request.headers.authorization,
        id,
        idempotencyKey(request),
        body,
      ),
      meta: { requestId: request.id },
    };
  }
  @Header("Cache-Control", "no-store")
  @Post(":id/close")
  @ApiCreatedResponse({ type: PaymentOrderResponseDto })
  @ApiHeader({ name: "Idempotency-Key", required: true })
  async closeOrder(
    @Req() request: FastifyRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: EmptyPaymentCommand,
  ) {
    return {
      data: await this.orders.closeOrder(
        request.headers.authorization,
        id,
        idempotencyKey(request),
        body,
      ),
      meta: { requestId: request.id },
    };
  }
  @Header("Cache-Control", "no-store")
  @Get()
  @ApiOkResponse({ type: PaymentOrdersResponseDto })
  async list(@Req() request: FastifyRequest) {
    return {
      data: await this.orders.list(request.headers.authorization),
      meta: { requestId: request.id },
    };
  }
  @Header("Cache-Control", "no-store")
  @Get(":id")
  @ApiOkResponse({ type: PaymentOrderResponseDto })
  async get(
    @Req() request: FastifyRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return {
      data: await this.orders.get(request.headers.authorization, id),
      meta: { requestId: request.id },
    };
  }
}

@Controller("v1/webhooks/wechat-pay")
@ApiTags("Wechat Pay")
export class PaymentWebhookController {
  constructor(private readonly orders: Orders) {}
  @Post("payments") @HttpCode(204) async notification(
    @Req() request: RawBodyRequest<FastifyRequest>,
  ) {
    if (!request.rawBody) throw new BadRequestException();
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers))
      if (typeof value === "string") headers.set(name, value);
    await this.orders.notification(request.rawBody.toString("utf8"), headers);
  }
}
