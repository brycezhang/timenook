import { randomBytes, randomInt, randomUUID } from "node:crypto";
import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Header,
  Inject,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  Optional,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { Prisma, PrismaClient, type WechatLink } from "@prisma/client";
import { IsString, Matches } from "class-validator";
import type { FastifyRequest } from "fastify";
import { API_CONFIG, ApiConfig } from "../config";
import { WebAccess } from "../web/web-access";
import { webDigest } from "../web/web-provisioning";
import { IdentityAccess } from "./identity-access";
import { WechatLoginDto } from "./identity-controller";

class ClaimDto extends WechatLoginDto {
  @IsString() @Matches(/^\d{8}$/) linkCode!: string;
}
class ProofDto {
  @IsString() @Matches(/^[A-Za-z0-9_-]{43}$/) proof!: string;
}
class ConfirmDto {
  @IsString() @Matches(/^\d{6}$/) verificationCode!: string;
}
class NativeConfirmDto extends WechatLoginDto {
  @IsString() @Matches(/^[A-Za-z0-9_-]{43}$/) proof!: string;
  @IsString() @Matches(/^\d{6}$/) verificationCode!: string;
}

@Injectable()
export class WechatLinks implements OnModuleDestroy {
  private readonly db: PrismaClient;
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly identity: IdentityAccess,
    @Optional() private readonly web?: WebAccess,
  ) {
    this.db = new PrismaClient({ datasourceUrl: config.databaseUrl });
  }
  available() {
    return { available: !!(this.config.web && this.config.wechat) };
  }
  private ready() {
    if (!this.available().available || !this.web)
      throw new ServiceUnavailableException();
    return this.web;
  }
  private view(row: WechatLink) {
    return {
      id: row.id,
      targetUser: { id: row.userId },
      expiresAt: row.expiresAt.toISOString(),
      state:
        row.state !== "linked" &&
        row.state !== "cancelled" &&
        row.expiresAt.getTime() <= Date.now()
          ? "expired"
          : row.state,
      verificationCode: row.verificationCode,
      webConfirmed: row.webConfirmed,
      nativeConfirmed: row.nativeConfirmed,
    };
  }
  private async session(
    tx: Prisma.TransactionClient,
    sessionId: string,
    userId: string,
  ) {
    await tx.$queryRaw`SELECT id FROM sessions WHERE id=${sessionId}::uuid FOR SHARE`;
    const session = await tx.session.findUnique({
      where: { id: sessionId },
      include: { webSession: true },
    });
    if (
      !session ||
      session.userId !== userId ||
      session.revokedAt ||
      session.expiresAt.getTime() <= Date.now() ||
      session.webSession?.keyHash !== webDigest(this.config.web!.sessionKey)
    )
      throw new UnauthorizedException();
  }
  private async lock(tx: Prisma.TransactionClient, row: WechatLink) {
    await tx.$queryRaw`SELECT id FROM wechat_links WHERE id=${row.id}::uuid FOR UPDATE`;
    return tx.wechatLink.findUniqueOrThrow({ where: { id: row.id } });
  }
  private active(row: WechatLink) {
    if (
      !["waiting", "paired"].includes(row.state) ||
      row.expiresAt.getTime() <= Date.now()
    )
      throw new ConflictException();
  }
  async create(request: FastifyRequest) {
    const web = this.ready(),
      current = await web.requireMutation(request);
    await web.limit(`link-create:${current.data.session.id}`, 5);
    const code = String(randomInt(100000000)).padStart(8, "0");
    const row = await this.db.$transaction(async (tx) => {
      // Every command takes the originating session before the challenge.
      // Revocation (exclusive session lock) cannot race final attachment.
      await tx.$queryRaw`SELECT id FROM sessions WHERE id=${current.data.session.id}::uuid FOR UPDATE`;
      await this.session(tx, current.data.session.id, current.data.user.id);
      await tx.wechatLink.updateMany({
        where: {
          sessionId: current.data.session.id,
          state: { in: ["waiting", "paired"] },
        },
        data: { state: "cancelled" },
      });
      return tx.wechatLink.create({
        data: {
          id: randomUUID(),
          userId: current.data.user.id,
          sessionId: current.data.session.id,
          codeHash: webDigest(code),
          expiresAt: new Date(Date.now() + 300000),
        },
      });
    });
    return { challenge: { ...this.view(row), code } };
  }
  async webAction(
    request: FastifyRequest,
    id: string,
    action: "status" | "confirm" | "cancel",
    verificationCode?: string,
  ) {
    const web = this.ready();
    const current =
      action === "status"
        ? await web.current(request)
        : await web.requireMutation(request);
    await web.limit(`link-web:${current.data.session.id}`, 120);
    const found = await this.db.wechatLink.findUnique({ where: { id } });
    if (
      !found ||
      found.sessionId !== current.data.session.id ||
      found.userId !== current.data.user.id
    )
      throw new NotFoundException();
    return this.change(found, action, verificationCode);
  }
  async claim(request: FastifyRequest, command: ClaimDto) {
    const web = this.ready();
    await web.limit(
      `link-claim:${request.ip}`,
      Math.min(this.config.loginLimitPerMinute ?? 20, 20),
    );
    const found = await this.db.wechatLink.findUnique({
      where: { codeHash: webDigest(command.linkCode) },
    });
    if (!found) throw new NotFoundException();
    // Code is consumed before the external call, shared with normal login.
    const proven = await this.identity.proveWechat(command.code, request.ip);
    const proof = randomBytes(32).toString("base64url");
    const row = await this.db.$transaction(async (tx) => {
      await this.session(tx, found.sessionId, found.userId);
      const row = await this.lock(tx, found);
      this.active(row);
      if (row.state !== "waiting") throw new ConflictException();
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([proven.appId, proven.openId])}, 0))`;
      const existing = await tx.wechatIdentity.findUnique({
        where: { appId_openId: proven },
      });
      if (existing && existing.userId !== row.userId)
        throw new ConflictException();
      return tx.wechatLink.update({
        where: { id: row.id },
        data: {
          ...proven,
          proofHash: webDigest(proof),
          state: "paired",
          verificationCode: String(randomInt(1000000)).padStart(6, "0"),
        },
      });
    });
    return { proof, challenge: this.view(row) };
  }
  async nativeAction(
    request: FastifyRequest,
    command: ProofDto | NativeConfirmDto,
    action: "status" | "confirm" | "cancel",
  ) {
    const web = this.ready();
    await web.limit(`link-native:${request.ip}`, 120);
    const found = await this.db.wechatLink.findUnique({
      where: { proofHash: webDigest(command.proof) },
    });
    if (!found) throw new UnauthorizedException();
    const proven =
      action === "confirm"
        ? await this.identity.proveWechat(
            (command as NativeConfirmDto).code,
            request.ip,
          )
        : undefined;
    return this.change(
      found,
      action,
      (command as NativeConfirmDto).verificationCode,
      proven,
    );
  }
  private async change(
    found: WechatLink,
    action: "status" | "confirm" | "cancel",
    verificationCode?: string,
    proven?: { appId: string; openId: string },
  ) {
    const result = await this.db.$transaction(async (tx) => {
      await this.session(tx, found.sessionId, found.userId);
      let row = await this.lock(tx, found);
      if (action === "status") return { challenge: this.view(row) };
      this.active(row);
      if (action === "cancel") {
        row = await tx.wechatLink.update({
          where: { id: row.id },
          data: { state: "cancelled" },
        });
        return { challenge: this.view(row) };
      }
      if (row.state !== "paired") throw new ConflictException();
      if (
        (proven &&
          (row.appId !== proven.appId || row.openId !== proven.openId)) ||
        verificationCode !== row.verificationCode
      ) {
        const attempts = row.attempts + 1;
        await tx.wechatLink.update({
          where: { id: row.id },
          data: {
            attempts,
            ...(attempts >= 5 || (proven && row.openId !== proven.openId)
              ? { state: "cancelled" }
              : {}),
          },
        });
        return { rejected: true };
      }
      if (proven ? row.nativeConfirmed : row.webConfirmed)
        throw new ConflictException();
      row = await tx.wechatLink.update({
        where: { id: row.id },
        data: proven ? { nativeConfirmed: true } : { webConfirmed: true },
      });
      if (row.webConfirmed && row.nativeConfirmed) {
        const identity = { appId: row.appId!, openId: row.openId! };
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([identity.appId, identity.openId])}, 0))`;
        const existing = await tx.wechatIdentity.findUnique({
          where: { appId_openId: identity },
        });
        if (existing && existing.userId !== row.userId)
          throw new ConflictException();
        // Recheck wall clock after waiting for the identity lock.
        this.active(row);
        await this.session(tx, row.sessionId, row.userId);
        if (!existing)
          await tx.wechatIdentity.create({
            data: { ...identity, userId: row.userId },
          });
        row = await tx.wechatLink.update({
          where: { id: row.id },
          data: { state: "linked" },
        });
      }
      return { challenge: this.view(row) };
    });
    if ("rejected" in result) throw new ConflictException();
    return result;
  }
  async onModuleDestroy() {
    await this.db.$disconnect();
  }
}
const response = (request: FastifyRequest, data: unknown) => ({
  data,
  meta: { requestId: request.id },
});
@Controller("v1/web/wechat-link")
export class WebWechatLinkController {
  constructor(
    private readonly links: WechatLinks,
    private readonly web: WebAccess,
  ) {}
  @Get()
  @Header("Cache-Control", "no-store")
  async availability(@Req() request: FastifyRequest) {
    await this.web.current(request);
    return response(request, this.links.available());
  }
  @Post()
  @Header("Cache-Control", "no-store")
  async create(@Req() request: FastifyRequest) {
    return response(request, await this.links.create(request));
  }
  @Get(":id")
  @Header("Cache-Control", "no-store")
  async status(
    @Req() request: FastifyRequest,
    @Param("id", new ParseUUIDPipe()) id: string,
  ) {
    return response(request, await this.links.webAction(request, id, "status"));
  }
  @Post(":id/confirm")
  @Header("Cache-Control", "no-store")
  async confirm(
    @Req() request: FastifyRequest,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() command: ConfirmDto,
  ) {
    return response(
      request,
      await this.links.webAction(
        request,
        id,
        "confirm",
        command.verificationCode,
      ),
    );
  }
  @Delete(":id")
  @Header("Cache-Control", "no-store")
  async cancel(
    @Req() request: FastifyRequest,
    @Param("id", new ParseUUIDPipe()) id: string,
  ) {
    return response(request, await this.links.webAction(request, id, "cancel"));
  }
}
@Controller("v1/wechat-links")
export class NativeWechatLinkController {
  constructor(private readonly links: WechatLinks) {}
  @Get()
  @Header("Cache-Control", "no-store")
  availability(@Req() request: FastifyRequest) {
    return response(request, this.links.available());
  }
  @Post("claim")
  @Header("Cache-Control", "no-store")
  async claim(@Req() request: FastifyRequest, @Body() command: ClaimDto) {
    return response(request, await this.links.claim(request, command));
  }
  @Post("status")
  @Header("Cache-Control", "no-store")
  async status(@Req() request: FastifyRequest, @Body() command: ProofDto) {
    return response(
      request,
      await this.links.nativeAction(request, command, "status"),
    );
  }
  @Post("confirm")
  @Header("Cache-Control", "no-store")
  async confirm(
    @Req() request: FastifyRequest,
    @Body() command: NativeConfirmDto,
  ) {
    return response(
      request,
      await this.links.nativeAction(request, command, "confirm"),
    );
  }
  @Post("cancel")
  @Header("Cache-Control", "no-store")
  async cancel(@Req() request: FastifyRequest, @Body() command: ProofDto) {
    return response(
      request,
      await this.links.nativeAction(request, command, "cancel"),
    );
  }
}
