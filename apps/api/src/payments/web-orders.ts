import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Injectable,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Header,
} from "@nestjs/common";
import { IsIn } from "class-validator";
import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { Prisma, type PaymentOrder } from "@prisma/client";
import { API_CONFIG, ApiConfig } from "../config";
import { IdentityAccess } from "../identity/identity-access";
import { BUILTIN_TEMPLATE } from "../projects/builtin-template";
import { WebAccess } from "../web/web-access";
import {
  CreateOrderDto,
  EmptyPaymentCommand,
  Orders,
  PAYMENT_FETCH,
  hash,
  conflict,
  idempotencyKey,
  purchaseDetails,
} from "./orders";
import { AlipayService, type AlipayOrder } from "./alipay-service";
class WebCreateOrderDto extends CreateOrderDto {
  @IsIn(["alipay_page", "alipay_wap"]) channel!: "alipay_page" | "alipay_wap";
}
@Injectable()
export class WebOrders {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly identity: IdentityAccess,
    private readonly orders: Orders,
    @Inject(PAYMENT_FETCH) private readonly transport: typeof fetch,
  ) {}
  private enabled() {
    if (!this.config.alipay || !this.config.web) throw new ForbiddenException();
    return this.config.alipay;
  }
  private client() {
    return new AlipayService(this.enabled(), this.transport);
  }
  private get db() {
    return this.orders.database;
  }
  async catalog() {
    const cfg = this.enabled();
    const version = await this.db.packageVersion.findFirst({
      where: {
        realm:
          this.config.environment === "production" ? "production" : "local",
        purpose: cfg.e2eAmountFen === 1 ? "e2e" : "production",
      },
      orderBy: { sequence: "desc" },
    });
    return {
      purchasable: !!version,
      version: version
        ? { ...(version.publicOffer as Prisma.JsonObject), id: version.id }
        : null,
    };
  }
  async create(authorization: string, key: string, body: WebCreateOrderDto) {
    const cfg = this.enabled(),
      user = await this.identity.current(authorization);
    const requestHash = hash(body);
    const order = await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${user.id + ":create-order:" + key},0))`;
      const prior = await tx.paymentOrder.findUnique({
        where: {
          buyerId_idempotencyKey: { buyerId: user.id, idempotencyKey: key },
        },
      });
      if (prior) {
        if (prior.requestHash !== requestHash || prior.provider !== "alipay")
          throw conflict();
        return prior;
      }
      const version = await tx.packageVersion.findFirst({
        where: {
          id: body.packageVersionId,
          realm:
            this.config.environment === "production" ? "production" : "local",
          purpose: cfg.e2eAmountFen === 1 ? "e2e" : "production",
        },
      });
      if (!version || !body.recipient) throw new BadRequestException();
      const details = await purchaseDetails(tx, version.realm, body);
      return tx.paymentOrder.create({
        data: {
          id: randomUUID(),
          buyerId: user.id,
          provider: "alipay",
          channel: body.channel,
          mode: "alipay",
          outTradeNo: "TN" + randomUUID().replaceAll("-", "").slice(0, 30),
          idempotencyKey: key,
          requestHash,
          amount: cfg.e2eAmountFen === 1 ? 1 : 99900,
          listAmount: 99900,
          currency: "CNY",
          isE2e: cfg.e2eAmountFen === 1,
          packageVersionId: version.id,
          packageSnapshot: version.snapshot as Prisma.InputJsonValue,
          ...details,
          template: JSON.parse(JSON.stringify(BUILTIN_TEMPLATE)),
          subjectName: body.subjectName?.trim() || null,
        },
      });
    });
    return this.orders.view(order);
  }
  async owned(authorization: string, id: string) {
    this.enabled();
    const user = await this.identity.current(authorization);
    const order = await this.db.paymentOrder.findFirst({
      where: { id, buyerId: user.id, provider: "alipay", mode: "alipay" },
    });
    if (!order || order.amount === null) throw new NotFoundException();
    return { ...order, amount: order.amount };
  }
  private validate(order: PaymentOrder, remote: AlipayOrder, orderNo: string) {
    if (
      remote.orderNo !== orderNo ||
      remote.bizType !== "timenook_book" ||
      remote.bizRefId !== order.id ||
      remote.localOrderId !== order.id ||
      remote.packageVersionId !== order.packageVersionId ||
      remote.amountFen !== order.amount ||
      remote.currency !== order.currency ||
      remote.channel !== order.channel
    )
      throw new Error("Payment-service order binding mismatch");
    if (
      remote.status === "paid" &&
      (!remote.settledAt || !Number.isFinite(Date.parse(remote.settledAt)))
    )
      throw new Error("Invalid settlement time");
  }
  private async apply(order: PaymentOrder, remote: AlipayOrder) {
    if (remote.status === "paid")
      await this.orders.deliverVerifiedPayment(order, {
        transactionId: `alipay:${remote.orderNo}`,
        paidAt: remote.settledAt!,
      });
    else if (remote.status === "closed")
      await this.db.paymentOrder.updateMany({
        where: { id: order.id, state: "pending" },
        data: { state: "closed" },
      });
  }
  private async refresh(order: PaymentOrder) {
    if (order.state === "paid") return "paid";
    const submission = await this.db.paymentSubmission.findUnique({
      where: { orderId: order.id },
    });
    if (!submission) return order.state;
    if (!submission.remoteOrderNo) return "unknown";
    let remote: AlipayOrder;
    try {
      remote = await this.client().get(submission.remoteOrderNo);
      this.validate(order, remote, submission.remoteOrderNo);
    } catch {
      return "unknown";
    }
    await this.apply(order, remote);
    return remote.status === "paid" || remote.status === "closed"
      ? remote.status
      : remote.status === "pending" || remote.status === "processing"
        ? "pending"
        : "unknown";
  }
  async get(authorization: string, id: string) {
    const order = await this.owned(authorization, id),
      paymentStatus = await this.refresh(order);
    return {
      ...(await this.orders.view(await this.owned(authorization, id))),
      paymentStatus,
    };
  }
  async list(authorization: string) {
    this.enabled();
    const user = await this.identity.current(authorization);
    const list = await this.db.paymentOrder.findMany({
      where: { buyerId: user.id, provider: "alipay" },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    return {
      orders: await Promise.all(list.map((order) => this.orders.view(order))),
    };
  }
  async prepare(
    authorization: string,
    id: string,
    key: string,
    body: EmptyPaymentCommand,
    clientIp: string,
  ) {
    if (Object.keys(body).length) throw new BadRequestException();
    const order = await this.owned(authorization, id);
    if (order.state !== "pending") return { status: order.state, form: null };
    const reservation = await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM payment_orders WHERE id=${id}::uuid FOR UPDATE`;
      const current = await tx.paymentOrder.findUniqueOrThrow({
        where: { id },
      });
      if (current.state !== "pending") return null;
      await tx.paymentCommand.upsert({
        where: { orderId_action_key: { orderId: id, action: "prepare", key } },
        create: {
          orderId: id,
          action: "prepare",
          key,
          requestHash: hash(body),
        },
        update: {},
      });
      const prior = await tx.paymentSubmission.findUnique({
        where: { orderId: id },
      });
      if (prior) return { submission: prior, create: false };
      return {
        submission: await tx.paymentSubmission.create({
          data: { orderId: id },
        }),
        create: true,
      };
    });
    if (!reservation)
      return {
        status: (await this.owned(authorization, id)).state,
        form: null,
      };
    let orderNo = reservation.submission.remoteOrderNo;
    try {
      if (reservation.create) {
        const remote = await this.client().create(order);
        this.validate(order, remote, remote.orderNo);
        orderNo = remote.orderNo;
        await this.db.paymentSubmission.update({
          where: { orderId: id },
          data: { remoteOrderNo: orderNo },
        });
      }
      if (!orderNo) return { status: "unknown", form: null };
      const remote = await this.client().get(orderNo);
      this.validate(order, remote, orderNo);
      await this.apply(order, remote);
      if (!["pending", "processing"].includes(remote.status))
        return { status: remote.status, form: null };
      const form = await this.client().prepare(
        orderNo,
        order.channel,
        `${this.config.web!.origin}/app/purchase/return/${id}`,
        clientIp,
      );
      return { status: "prepared", form };
    } catch {
      return { status: "unknown", form: null };
    }
  }
  async close(authorization: string, id: string, body: EmptyPaymentCommand) {
    if (Object.keys(body).length) throw new BadRequestException();
    const order = await this.owned(authorization, id);
    const submission = await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM payment_orders WHERE id=${id}::uuid FOR UPDATE`;
      const submission = await tx.paymentSubmission.findUnique({
        where: { orderId: id },
      });
      if (!submission)
        await tx.paymentOrder.updateMany({
          where: { id, state: "pending" },
          data: { state: "closed" },
        });
      return submission;
    });
    if (submission?.remoteOrderNo && order.state === "pending") {
      try {
        const remote = await this.client().get(submission.remoteOrderNo);
        this.validate(order, remote, submission.remoteOrderNo);
        if (["pending", "processing"].includes(remote.status))
          await this.client().close(submission.remoteOrderNo);
      } catch {
        /* Keep an uncertain payment open until the shared ledger confirms. */
      }
    }
    return this.get(authorization, id);
  }
}
@Controller("v1/web/orders")
export class WebOrdersController {
  constructor(
    private readonly orders: WebOrders,
    private readonly web: WebAccess,
  ) {}
  private async authorization(req: FastifyRequest, mutation = false) {
    const current = mutation
      ? await this.web.requireMutation(req)
      : await this.web.current(req);
    return `Bearer ${current.token}`;
  }
  @Get("catalog")
  @Header("Cache-Control", "no-store")
  async catalog(@Req() req: FastifyRequest) {
    await this.authorization(req);
    return { data: await this.orders.catalog() };
  }
  @Post()
  @Header("Cache-Control", "no-store")
  async create(@Req() req: FastifyRequest, @Body() body: WebCreateOrderDto) {
    return {
      data: await this.orders.create(
        await this.authorization(req, true),
        idempotencyKey(req),
        body,
      ),
    };
  }
  @Get()
  @Header("Cache-Control", "no-store")
  async list(@Req() req: FastifyRequest) {
    return { data: await this.orders.list(await this.authorization(req)) };
  }
  @Get(":id")
  @Header("Cache-Control", "no-store")
  async get(
    @Req() req: FastifyRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return { data: await this.orders.get(await this.authorization(req), id) };
  }
  @Post(":id/payment")
  @Header("Cache-Control", "no-store")
  async prepare(
    @Req() req: FastifyRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: EmptyPaymentCommand,
  ) {
    return {
      data: await this.orders.prepare(
        await this.authorization(req, true),
        id,
        idempotencyKey(req),
        body,
        req.ip,
      ),
    };
  }
  @Post(":id/close")
  @Header("Cache-Control", "no-store")
  async close(
    @Req() req: FastifyRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: EmptyPaymentCommand,
  ) {
    idempotencyKey(req);
    return {
      data: await this.orders.close(
        await this.authorization(req, true),
        id,
        body,
      ),
    };
  }
}
