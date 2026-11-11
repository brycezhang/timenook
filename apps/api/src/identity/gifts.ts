import { createHash, randomBytes } from "node:crypto";
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
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { IsString, Length, Matches, Equals } from "class-validator";
import { Transform } from "class-transformer";
import { ApiBearerAuth, ApiTags, ApiProperty } from "@nestjs/swagger";
import { Prisma, PrismaClient, type ProjectGift } from "@prisma/client";
import type { FastifyRequest } from "fastify";
import {
  USER_TERMS_VERSION,
  type GiftPreview,
  type OwnedGift,
  type GiftSetup,
  type GiftVerification,
} from "@timenook/contracts";
import { API_CONFIG, ApiConfig } from "../config";
import { IdentityAccess } from "./identity-access";
import { mainlandPhone, accountView } from "./phone-account";
import { acceptTermsIn } from "./project-members";
import { PrivacyRights } from "../care/privacy-rights";

const digest = (token: string) =>
  createHash("sha256").update(token).digest("hex");
class IssueGiftDto {
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @Length(1, 32)
  @Matches(/^[^\u0000-\u001f\u007f]+$/u)
  @ApiProperty()
  recipientName!: string;
  @IsString()
  @Length(11, 14)
  @ApiProperty()
  recipientPhone!: string;
}
class ClaimGiftDto {
  @Equals(USER_TERMS_VERSION)
  @ApiProperty({ enum: [USER_TERMS_VERSION] })
  termsVersion!: string;
}

@Injectable()
export class Gifts implements OnModuleDestroy {
  private readonly db: PrismaClient;
  constructor(
    @Inject(API_CONFIG) config: ApiConfig,
    private readonly identity: IdentityAccess,
    private readonly rights: PrivacyRights,
  ) {
    this.db = new PrismaClient({ datasourceUrl: config.databaseUrl });
  }
  onModuleDestroy() {
    return this.db.$disconnect();
  }

  private async project(tx: Prisma.TransactionClient, id: string) {
    await tx.$queryRaw`SELECT id FROM projects WHERE id=${id}::uuid FOR UPDATE`;
    await this.rights.requireAvailableIn(tx, id, "activeData");
    const project = await tx.project.findUnique({ where: { id } });
    if (!project) throw new NotFoundException();
    return project;
  }
  private async purchaser(
    tx: Prisma.TransactionClient,
    projectId: string,
    authorization?: string,
  ) {
    const user = await this.identity.current(authorization, tx);
    const project = await this.project(tx, projectId);
    if (project.createdBy !== user.id) throw new ForbiddenException();
    const order = project.orderId
      ? await tx.paymentOrder.findUnique({ where: { id: project.orderId } })
      : null;
    if (!order || order.state !== "paid" || order.purchaseKind !== "gift")
      throw new ForbiddenException("这本书不需要领取礼物");
    return { project, order };
  }
  private previewOf(gift: ProjectGift, bookTitle: string): GiftPreview {
    return {
      state: gift.claimedAt ? "claimed" : "unclaimed",
      bookTitle,
      recipientName: gift.recipientName!,
      maskedPhone: accountView({
        id: "",
        nickname: null,
        phoneNumber: gift.recipientPhone,
      }).maskedPhone!,
    };
  }
  private owned(gift: ProjectGift, title: string): OwnedGift {
    return {
      ...this.previewOf(gift, title),
      projectId: gift.projectId,
      recipientPhone: gift.recipientPhone!.slice(3),
      version: gift.version,
      token: gift.token!,
    };
  }
  async current(projectId: string, authorization?: string): Promise<GiftSetup> {
    return this.db.$transaction(async (tx) => {
      const { project, order } = await this.purchaser(
        tx,
        projectId,
        authorization,
      );
      const gift = await tx.projectGift.findUnique({ where: { projectId } });
      const bookTitle = project.bookTitle ?? order.bookTitle!;
      return {
        projectId,
        bookTitle,
        recipientName:
          ((order.recipient as Prisma.JsonObject)
            ?.relationshipLabel as string) ?? "",
        gift: gift ? this.owned(gift, bookTitle) : null,
      };
    });
  }
  async issue(
    projectId: string,
    command: IssueGiftDto,
    authorization?: string,
  ): Promise<OwnedGift> {
    const recipientPhone = mainlandPhone(command.recipientPhone);
    return this.db.$transaction(async (tx) => {
      const { project, order } = await this.purchaser(
        tx,
        projectId,
        authorization,
      );
      const prior = await tx.projectGift.findUnique({ where: { projectId } });
      if (prior?.claimedAt)
        throw new ConflictException("礼物已领取，不能更改收礼人");
      const token = randomBytes(32).toString("base64url");
      const fields = {
        recipientName: command.recipientName,
        recipientPhone,
        token,
        tokenHash: digest(token),
        issuedAt: new Date(),
      };
      const gift = await tx.projectGift.upsert({
        where: { projectId },
        create: { projectId, ...fields },
        update: { ...fields, version: { increment: 1 } },
      });
      return this.owned(gift, project.bookTitle ?? order.bookTitle!);
    });
  }
  private async card(tx: Prisma.TransactionClient, token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new NotFoundException();
    const gift = await tx.projectGift.findUnique({
      where: { tokenHash: digest(token) },
    });
    if (!gift) throw new NotFoundException();
    const project = await this.project(tx, gift.projectId);
    // Re-read after the project lock: a simultaneous reissue may have replaced this card.
    const current = await tx.projectGift.findUnique({
      where: { tokenHash: digest(token) },
    });
    if (!current) throw new NotFoundException();
    return { gift: current, project };
  }
  async preview(token: string): Promise<GiftPreview> {
    return this.db.$transaction(async (tx) => {
      const { gift, project } = await this.card(tx, token);
      return this.previewOf(gift, project.bookTitle!);
    });
  }
  async verify(
    token: string,
    authorization?: string,
  ): Promise<GiftVerification> {
    return this.db.$transaction(async (tx) => {
      const account = await this.identity.current(authorization, tx);
      const { gift, project } = await this.card(tx, token);
      const user = await tx.user.findUniqueOrThrow({
        where: { id: account.id },
      });
      return {
        state: gift.claimedAt
          ? "claimed"
          : user.phoneNumber && user.phoneNumber === gift.recipientPhone
            ? "ready"
            : "mismatch",
        gift: this.previewOf(gift, project.bookTitle!),
        currentMaskedPhone: account.maskedPhone ?? null,
        ...(gift.claimedByUserId === user.id ? { projectId: project.id } : {}),
      };
    });
  }
  async claim(token: string, authorization?: string) {
    return this.db.$transaction(async (tx) => {
      const account = await this.identity.current(authorization, tx);
      const { gift, project } = await this.card(tx, token);
      if (gift.claimedAt) {
        if (gift.claimedByUserId !== account.id)
          throw new ForbiddenException("礼物已由指定收礼人领取");
        return { projectId: project.id, state: "claimed" as const };
      }
      const user = await tx.user.findUniqueOrThrow({
        where: { id: account.id },
      });
      if (!user.phoneNumber || user.phoneNumber !== gift.recipientPhone)
        throw new ForbiddenException("手机号不匹配");
      await acceptTermsIn(tx, user.id, "gift");
      await tx.projectMember.upsert({
        where: { projectId_userId: { projectId: project.id, userId: user.id } },
        create: {
          projectId: project.id,
          userId: user.id,
          termsVersion: USER_TERMS_VERSION,
        },
        update: {},
      });
      // Initial designated claim preserves all pre-claim material versions and payer rights.
      await tx.projectSubject.update({
        where: { projectId: project.id },
        data: { boundUserId: user.id },
      });
      await tx.projectGift.update({
        where: { projectId: project.id },
        data: { claimedAt: new Date(), claimedByUserId: user.id },
      });
      return { projectId: project.id, state: "claimed" as const };
    });
  }
}

@Controller("v1")
@ApiTags("Gifts")
export class GiftsController {
  constructor(private readonly gifts: Gifts) {}
  @Get("projects/:id/gift")
  @Header("Cache-Control", "no-store")
  @ApiBearerAuth()
  async current(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.gifts.current(id, req.headers.authorization),
      meta: { requestId: req.id },
    };
  }
  @Post("projects/:id/gift")
  @Header("Cache-Control", "no-store")
  @ApiBearerAuth()
  async issue(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() body: IssueGiftDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.gifts.issue(id, body, req.headers.authorization),
      meta: { requestId: req.id },
    };
  }
  @Get("gifts/:token")
  @Header("Cache-Control", "no-store")
  async preview(@Param("token") token: string, @Req() req: FastifyRequest) {
    return {
      data: await this.gifts.preview(token),
      meta: { requestId: req.id },
    };
  }
  @Get("gifts/:token/verification")
  @Header("Cache-Control", "no-store")
  @ApiBearerAuth()
  async verify(@Param("token") token: string, @Req() req: FastifyRequest) {
    return {
      data: await this.gifts.verify(token, req.headers.authorization),
      meta: { requestId: req.id },
    };
  }
  @Post("gifts/:token/claim")
  @Header("Cache-Control", "no-store")
  @ApiBearerAuth()
  async claim(
    @Param("token") token: string,
    @Body() _body: ClaimGiftDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.gifts.claim(token, req.headers.authorization),
      meta: { requestId: req.id },
    };
  }
}
