import { initializePurchasedProjectIn } from "../projects/purchased-project";
import { randomUUID } from "node:crypto";
import {
  Body,
  ConflictException,
  Controller,
  Get,
  Header,
  Inject,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from "@nestjs/common";
import { OmitType } from "@nestjs/swagger";
import { ArrayMaxSize, IsArray, IsUUID } from "class-validator";
import { Prisma, PrismaClient } from "@prisma/client";
import type { FastifyRequest } from "fastify";
import { API_CONFIG, ApiConfig } from "../config";
import { IdentityAccess } from "../identity/identity-access";
import { CreateOrderDto, hash, purchaseDetails } from "../payments/orders";
import { ProjectPlans } from "../projects/project-plans";
import { ProjectServiceTerms } from "../projects/service-terms";
import { BUILTIN_TEMPLATE } from "../projects/builtin-template";
import { lockChannelGiftIn } from "./record";
export class ActivateChannelGiftDto extends OmitType(CreateOrderDto, [
  "packageVersionId",
  "subjectName",
] as const) {}
export class HandleChannelRemindersDto {
  @IsArray() @ArrayMaxSize(500) @IsUUID("4", { each: true }) ids!: string[];
}
@Injectable()
export class ChannelGiftActivation implements OnModuleDestroy {
  private readonly db: PrismaClient;
  private readonly plans: ProjectPlans;
  private readonly terms: ProjectServiceTerms;
  constructor(
    @Inject(API_CONFIG) config: ApiConfig,
    private readonly identity: IdentityAccess,
  ) {
    this.db = new PrismaClient({ datasourceUrl: config.databaseUrl });
    this.plans = new ProjectPlans(config.databaseUrl);
    this.terms = new ProjectServiceTerms(config.databaseUrl);
  }
  async onModuleDestroy() {
    await Promise.all([
      this.db.$disconnect(),
      this.plans.close(),
      this.terms.close(),
    ]);
  }
  async activate(
    authorization: string | undefined,
    id: string,
    body: ActivateChannelGiftDto,
  ) {
    const buyer = await this.identity.current(authorization);
    return this.db.$transaction(async (tx) => {
      const gift = await lockChannelGiftIn(tx, id);
      if (gift.buyerId !== buyer.id) throw new NotFoundException();
      if (gift.state !== "active") throw new ConflictException();
      const version = await tx.packageVersion.findUniqueOrThrow({
        where: { id: gift.packageVersionId },
      });
      const details = await purchaseDetails(tx, version.realm, {
        ...body,
        packageVersionId: gift.packageVersionId,
      });
      const requestHash = hash(details);
      let order = gift.orderId
        ? await tx.paymentOrder.findUniqueOrThrow({
            where: { id: gift.orderId },
          })
        : null;
      if (order && order.requestHash !== requestHash)
        throw new ConflictException();
      let projectId = gift.projectId;
      if (!projectId) {
        order = await tx.paymentOrder.create({
          data: {
            id: randomUUID(),
            buyerId: buyer.id,
            provider: "channel",
            mode: "channel",
            channel: "manual",
            outTradeNo: gift.internalNumber,
            idempotencyKey: `channel:${gift.id}`,
            requestHash,
            listAmount: gift.listAmount,
            amount: gift.paidAmount,
            currency: "CNY",
            state: "paid",
            packageVersionId: gift.packageVersionId,
            packageSnapshot: gift.packageSnapshot as Prisma.InputJsonValue,
            template: JSON.parse(JSON.stringify(BUILTIN_TEMPLATE)),
            ...details,
          },
        });
        projectId = await initializePurchasedProjectIn(
          tx,
          this.plans,
          this.terms,
          order,
          new Date(),
        );
        await tx.channelGift.update({
          where: { id },
          data: { projectId, orderId: order.id },
        });
      }
      const entitlement = await tx.firstCopyEntitlement.findUniqueOrThrow({
        where: { projectId },
      });
      return {
        id,
        projectId,
        orderId: order!.id,
        entitlementId: entitlement.id,
        purchaseKind: order!.purchaseKind,
        paidAmount: gift.paidAmount,
      };
    });
  }
  async reminders(authorization: string | undefined) {
    const buyer = await this.identity.current(authorization);
    const rows = await this.db.channelGift.findMany({
      where: { buyerId: buyer.id, state: "active" },
    });
    const projects = await this.db.project.findMany({
      where: { createdBy: buyer.id, orderId: { not: null } },
      select: { id: true, orderId: true },
    });
    const orders = await this.db.paymentOrder.findMany({
      where: { buyerId: buyer.id, state: "paid", purchaseKind: "gift" },
      select: { id: true },
    });
    const cards = await this.db.projectGift.findMany({
      where: { projectId: { in: projects.map((p) => p.id) } },
      select: { projectId: true },
    });
    const issued = new Set(cards.map((c) => c.projectId)),
      giftOrders = new Set(orders.map((o) => o.id));
    const pendingProjects = new Set(
      projects
        .filter((p) => giftOrders.has(p.orderId!) && !issued.has(p.id))
        .map((p) => p.id),
    );
    const newGiftIds = rows
      .filter(
        (r) =>
          (!r.projectId || pendingProjects.has(r.projectId)) &&
          r.reminderHandledBy !== buyer.id,
      )
      .map((r) => r.id);
    return {
      newGiftIds,
      newCount: newGiftIds.length,
      pendingCount:
        rows.filter((r) => !r.projectId).length + pendingProjects.size,
    };
  }
  async handle(authorization: string | undefined, ids: string[]) {
    const buyer = await this.identity.current(authorization);
    await this.db.channelGift.updateMany({
      where: { id: { in: ids }, buyerId: buyer.id, state: "active" },
      data: { reminderHandledBy: buyer.id, reminderHandledAt: new Date() },
    });
    return this.reminders(authorization);
  }
}
@Controller("v1/channel-gifts")
export class ChannelGiftActivationController {
  constructor(private readonly service: ChannelGiftActivation) {}
  @Post(":id/activate")
  @Header("Cache-Control", "no-store")
  async activate(
    @Req() req: FastifyRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: ActivateChannelGiftDto,
  ) {
    return {
      data: await this.service.activate(req.headers.authorization, id, body),
      meta: { requestId: req.id },
    };
  }
  @Get("reminders")
  @Header("Cache-Control", "no-store")
  async reminders(@Req() req: FastifyRequest) {
    return {
      data: await this.service.reminders(req.headers.authorization),
      meta: { requestId: req.id },
    };
  }
  @Post("reminders/handle")
  @Header("Cache-Control", "no-store")
  async handle(
    @Req() req: FastifyRequest,
    @Body() body: HandleChannelRemindersDto,
  ) {
    return {
      data: await this.service.handle(req.headers.authorization, body.ids),
      meta: { requestId: req.id },
    };
  }
}
