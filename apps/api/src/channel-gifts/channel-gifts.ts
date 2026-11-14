import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Header,
  Inject,
  Injectable,
  OnModuleDestroy,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Prisma, PrismaClient, type ChannelGift } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import {
  ADMIN_PERMISSIONS,
  type AdminChannelGiftView,
  type AdminChannelGiftDetail,
  type ChannelGiftView,
  type CreateChannelGiftCommand,
} from "@timenook/contracts";
import { API_CONFIG, ApiConfig } from "../config";
import { AdminAccess } from "../admin/admin-access";
import { readSessionContextIn } from "../identity/identity-access";
import { mainlandPhone } from "../identity/phone-account";

import { lockChannelGiftIn } from "./record";

const maskedPhone = (phone: string) =>
  phone.slice(3, 6) + "****" + phone.slice(-4);

function command(value: unknown): CreateChannelGiftCommand {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (k) =>
        !["buyerPhone", "externalOrderNo", "paidAmount", "paidAt"].includes(k),
    )
  )
    throw new BadRequestException();
  const v = value as CreateChannelGiftCommand;
  if (typeof v.buyerPhone !== "string") throw new BadRequestException();
  const buyerPhone = mainlandPhone(v.buyerPhone);
  if (
    v.externalOrderNo !== undefined &&
    (typeof v.externalOrderNo !== "string" ||
      !v.externalOrderNo.trim() ||
      v.externalOrderNo.length > 200 ||
      /[\u0000-\u001f\u007f]/u.test(v.externalOrderNo))
  )
    throw new BadRequestException();
  if (
    v.paidAmount !== undefined &&
    (!Number.isSafeInteger(v.paidAmount) ||
      v.paidAmount < 0 ||
      v.paidAmount > 2147483647)
  )
    throw new BadRequestException();
  if (
    v.paidAt !== undefined &&
    (typeof v.paidAt !== "string" ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(
        v.paidAt,
      ) ||
      !Number.isFinite(Date.parse(v.paidAt)))
  )
    throw new BadRequestException();
  return {
    buyerPhone,
    ...(v.externalOrderNo !== undefined
      ? { externalOrderNo: v.externalOrderNo }
      : {}),
    ...(v.paidAmount !== undefined ? { paidAmount: v.paidAmount } : {}),
    ...(v.paidAt !== undefined
      ? { paidAt: new Date(v.paidAt).toISOString() }
      : {}),
  };
}
export function channelGiftView(gift: ChannelGift): ChannelGiftView {
  return {
    id: gift.id,
    internalNumber: gift.internalNumber,
    packageTitle: gift.packageTitle,
    listAmount: gift.listAmount,
    paidAmount: gift.paidAmount,
    paidAt: gift.paidAt?.toISOString() ?? null,
    createdAt: gift.createdAt.toISOString(),
    state: gift.state as "active" | "void",
    projectId: gift.projectId,
    orderId: gift.orderId,
  };
}
@Injectable()
export class ChannelGifts implements OnModuleDestroy {
  readonly database: PrismaClient;
  constructor(@Inject(API_CONFIG) private readonly config: ApiConfig) {
    this.database = new PrismaClient({ datasourceUrl: config.databaseUrl });
  }
  async adminView(
    tx: Prisma.TransactionClient,
    row: ChannelGift,
  ): Promise<AdminChannelGiftView> {
    const operator = await tx.adminAccount.findUniqueOrThrow({
      where: { id: row.operatorId },
    });
    return {
      ...channelGiftView(row),
      buyerPhone: row.buyerPhone,
      maskedBuyerPhone:
        row.buyerPhone.slice(3, 6) + "****" + row.buyerPhone.slice(-4),
      buyerId: row.buyerId,
      operatorId: row.operatorId,
      operatorName: operator.username,
      externalOrderNo: row.externalOrderNo,
      associatedAt: row.associatedAt?.toISOString() ?? null,
    };
  }
  async createIn(
    tx: Prisma.TransactionClient,
    operatorId: string,
    key: unknown,
    input: unknown,
  ) {
    if (typeof key !== "string" || !/^[-A-Za-z0-9_:]{8,128}$/.test(key))
      throw new BadRequestException();
    const body = command(input),
      requestHash = createHash("sha256")
        .update(JSON.stringify(body))
        .digest("hex");
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`channel-gift:${operatorId}:${key}`},0))`;
    const prior = await tx.channelGift.findUnique({
      where: { operatorId_idempotencyKey: { operatorId, idempotencyKey: key } },
    });
    if (prior) {
      if (prior.requestHash !== requestHash) throw new ConflictException();
      return this.adminView(tx, prior);
    }
    const realm =
      this.config.environment === "production" ? "production" : "local";
    const version =
      (this.config.checkoutE2e?.enabled
        ? await tx.packageVersion.findFirst({
            where: { realm, purpose: "e2e" },
            orderBy: { sequence: "desc" },
          })
        : null) ??
      (await tx.packageVersion.findFirst({
        where: { realm, purpose: "production" },
        orderBy: { sequence: "desc" },
      })) ??
      (realm === "local"
        ? await tx.packageVersion.findFirst({
            where: { realm, purpose: "local_preview" },
            orderBy: { sequence: "desc" },
          })
        : null);
    if (!version) throw new ServiceUnavailableException("Package unavailable");
    const offer = version.publicOffer as Prisma.JsonObject;
    if (typeof offer.title !== "string")
      throw new ServiceUnavailableException("Package unavailable");
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`phone:${body.buyerPhone}`},0))`;
    const buyer = await tx.user.findUnique({
      where: { phoneNumber: body.buyerPhone },
    });
    const row = await tx.channelGift.create({
      data: {
        id: randomUUID(),
        internalNumber: "CG" + randomUUID().replaceAll("-", ""),
        operatorId,
        idempotencyKey: key,
        requestHash,
        buyerPhone: body.buyerPhone,
        buyerId: buyer?.id,
        associatedAt: buyer ? new Date() : null,
        packageVersionId: version.id,
        packageSnapshot: version.snapshot as Prisma.InputJsonValue,
        packageTitle: offer.title,
        listAmount: 99900,
        paidAmount: body.paidAmount,
        paidAt: body.paidAt ? new Date(body.paidAt) : null,
        externalOrderNo: body.externalOrderNo,
      },
    });
    return this.adminView(tx, row);
  }
  async listIn(tx: Prisma.TransactionClient, operatorId?: string) {
    const rows = await tx.channelGift.findMany({
      where: operatorId ? { operatorId } : {},
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    return Promise.all(rows.map((row) => this.adminView(tx, row)));
  }
  async detailIn(
    tx: Prisma.TransactionClient,
    id: string,
    actor: ChannelAdminRequest,
  ): Promise<AdminChannelGiftDetail> {
    const row = await tx.channelGift.findUnique({ where: { id } });
    if (
      !row ||
      (actor.adminRole === "partner" && row.operatorId !== actor.adminOperator)
    )
      throw new NotFoundException();
    const operations = await tx.channelGiftOperation.findMany({
      where: { giftId: id },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    return {
      ...scopedAdminGift(
        await this.adminView(tx, row),
        actor.adminRole === "partner",
      ),
      operations: await Promise.all(
        operations.map(async (operation) => ({
          ...operation,
          action: operation.action as "correct" | "void",
          operatorName: (
            await tx.adminAccount.findUniqueOrThrow({
              where: { id: operation.operatorId },
            })
          ).username,
          beforePhone:
            actor.adminRole === "partner"
              ? maskedPhone(operation.beforePhone)
              : operation.beforePhone,
          afterPhone:
            actor.adminRole === "partner"
              ? maskedPhone(operation.afterPhone)
              : operation.afterPhone,
          createdAt: operation.createdAt.toISOString(),
        })),
      ),
    };
  }
  async changeIn(
    tx: Prisma.TransactionClient,
    id: string,
    actor: ChannelAdminRequest,
    action: "correct" | "void",
    input: unknown,
  ) {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new BadRequestException();
    const body = input as Record<string, unknown>;
    if (
      Object.keys(body).some(
        (k) =>
          !["reason", ...(action === "correct" ? ["buyerPhone"] : [])].includes(
            k,
          ),
      ) ||
      typeof body.reason !== "string" ||
      !body.reason.trim() ||
      body.reason.trim().length > 500 ||
      /[\u0000-\u001f\u007f]/u.test(body.reason)
    )
      throw new BadRequestException();
    const phone =
      action === "correct"
        ? typeof body.buyerPhone === "string"
          ? mainlandPhone(body.buyerPhone)
          : null
        : null;
    if (action === "correct" && !phone) throw new BadRequestException();
    // Registration takes phone then gift locks: preserve that order to avoid inversion.
    if (phone)
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`phone:${phone}`},0))`;
    const row = await lockChannelGiftIn(tx, id);
    if (actor.adminRole === "partner" && row.operatorId !== actor.adminOperator)
      throw new NotFoundException();
    if (row.projectId || row.state !== "active")
      throw new ConflictException("This gift can no longer be changed");
    if (phone === row.buyerPhone)
      throw new BadRequestException("Use a different buyer phone");
    const buyer = phone
      ? await tx.user.findUnique({ where: { phoneNumber: phone } })
      : null;
    await tx.channelGift.update({
      where: { id },
      data: phone
        ? {
            buyerPhone: phone,
            buyerId: buyer?.id ?? null,
            associatedAt: buyer ? new Date() : null,
            reminderHandledBy: null,
            reminderHandledAt: null,
          }
        : { state: "void" },
    });
    await tx.channelGiftOperation.create({
      data: {
        id: randomUUID(),
        giftId: id,
        operatorId: actor.adminOperator,
        action,
        reason: body.reason.trim(),
        beforePhone: row.buyerPhone,
        afterPhone: phone ?? row.buyerPhone,
      },
    });
    return this.detailIn(tx, id, actor);
  }
  async mine(authorization?: string) {
    return this.database.$transaction(async (tx) => {
      const user = await readSessionContextIn(tx, authorization);
      return (
        await tx.channelGift.findMany({
          where: { buyerId: user.id },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        })
      ).map(channelGiftView);
    });
  }
  async onModuleDestroy() {
    await this.database.$disconnect();
  }
}
type ChannelAdminRequest = FastifyRequest & {
  adminOperator: string;
  adminRole: "super_admin" | "partner";
};
export function scopedAdminGift(
  row: AdminChannelGiftView,
  partner: boolean,
): AdminChannelGiftView {
  return partner
    ? {
        ...row,
        buyerPhone: null,
        buyerId: null,
        associatedAt: null,
        projectId: null,
        orderId: null,
        usageStatus: row.projectId
          ? "activated"
          : row.state === "void"
            ? "void"
            : "pending",
      }
    : {
        ...row,
        usageStatus: row.projectId
          ? "activated"
          : row.state === "void"
            ? "void"
            : "pending",
      };
}
@Controller("v1/admin/channel-gifts")
export class AdminChannelGiftsController {
  constructor(
    private readonly access: AdminAccess,
    private readonly gifts: ChannelGifts,
  ) {}
  @Get()
  @Header("Cache-Control", "no-store")
  list(@Req() req: FastifyRequest) {
    return this.access.run("channel-gifts.list", req, async () => ({
      data: await this.access.command(
        req,
        ADMIN_PERMISSIONS.channelGiftsRead,
        async (tx) => {
          const actor = req as ChannelAdminRequest;
          return (
            await this.gifts.listIn(
              tx,
              actor.adminRole === "partner" ? actor.adminOperator : undefined,
            )
          ).map((row) => scopedAdminGift(row, actor.adminRole === "partner"));
        },
        true,
      ),
      meta: { requestId: req.id },
    }));
  }
  @Get(":id")
  @Header("Cache-Control", "no-store")
  detail(@Req() req: FastifyRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.access.run("channel-gifts.detail", req, async () => ({
      data: await this.access.command(
        req,
        ADMIN_PERMISSIONS.channelGiftsRead,
        (tx) => this.gifts.detailIn(tx, id, req as ChannelAdminRequest),
        true,
      ),
      meta: { requestId: req.id },
    }));
  }
  @Post(":id/correct")
  @Header("Cache-Control", "no-store")
  correct(
    @Req() req: FastifyRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return this.change(req, id, "correct", body);
  }
  @Post(":id/void")
  @Header("Cache-Control", "no-store")
  void(
    @Req() req: FastifyRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return this.change(req, id, "void", body);
  }
  private change(
    req: FastifyRequest,
    id: string,
    action: "correct" | "void",
    body: unknown,
  ) {
    Object.assign(req, {
      adminResourceType: "channel-gift",
      adminResourceId: id,
    });
    return this.access.run(`channel-gifts.${action}`, req, async () => ({
      data: await this.access.command(
        req,
        ADMIN_PERMISSIONS.channelGiftsWrite,
        (tx) =>
          this.gifts.changeIn(tx, id, req as ChannelAdminRequest, action, body),
      ),
      meta: { requestId: req.id },
    }));
  }
  @Post()
  @Header("Cache-Control", "no-store")
  create(@Req() req: FastifyRequest, @Body() body: unknown) {
    return this.access.run("channel-gifts.create", req, async () => ({
      data: await this.access.command(
        req,
        ADMIN_PERMISSIONS.channelGiftsWrite,
        async (tx) => {
          const row = await this.gifts.createIn(
            tx,
            (req as FastifyRequest & { adminOperator: string }).adminOperator,
            req.headers["idempotency-key"],
            body,
          );
          Object.assign(req, {
            adminResourceType: "channel-gift",
            adminResourceId: row.id,
          });
          return scopedAdminGift(
            row,
            (req as ChannelAdminRequest).adminRole === "partner",
          );
        },
      ),
      meta: { requestId: req.id },
    }));
  }
}
@Controller("v1/channel-gifts")
export class ChannelGiftsController {
  constructor(private readonly gifts: ChannelGifts) {}
  @Get()
  @Header("Cache-Control", "no-store")
  async list(@Req() req: FastifyRequest) {
    return {
      data: await this.gifts.mine(req.headers.authorization),
      meta: { requestId: req.id },
    };
  }
}
