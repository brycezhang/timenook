import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  HttpException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { Prisma, PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import type {
  Account,
  LoginResult,
  WechatLoginProfile,
} from "@timenook/contracts";
import { API_CONFIG, ApiConfig } from "../config";
import { exchangeCode, exchangePhoneCode, wechatAccessToken } from "./wechat";
import { accountView, phoneAccountIn } from "./phone-account";
import { acceptTermsIn } from "./project-members";

export const WECHAT_FETCH = Symbol("WECHAT_FETCH");
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export async function readSessionContextIn(
  tx: Prisma.TransactionClient,
  authorization?: string,
) {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization ?? "");
  if (!match) throw new UnauthorizedException();
  const tokenHash = digest(match[1]);
  await tx.$queryRaw`SELECT id FROM sessions WHERE token_hash=${tokenHash} FOR SHARE`;
  const session = await tx.session.findUnique({
    where: { tokenHash },
    include: { webSession: true },
  });
  if (
    !session ||
    session.revokedAt ||
    session.expiresAt.getTime() <= Date.now()
  )
    throw new UnauthorizedException();
  return {
    id: session.userId,
    sessionId: session.id,
    method: session.webSession
      ? ("self_web" as const)
      : ("self_wechat" as const),
  };
}
export async function readSelfMethodIn(
  tx: Prisma.TransactionClient,
  authorization?: string,
) {
  return (await readSessionContextIn(tx, authorization)).method;
}

@Injectable()
export class IdentityAccess implements OnModuleDestroy {
  private readonly database: PrismaClient;
  private readonly redis: Redis;
  private connection?: Promise<void>;
  private accessToken?: Promise<{ token: string; expiresAt: number }>;

  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(WECHAT_FETCH) private readonly wechatFetch: typeof fetch,
  ) {
    this.database = new PrismaClient({ datasourceUrl: config.databaseUrl });
    this.redis = new Redis(config.redisUrl, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      connectTimeout: 1000,
      commandTimeout: 1000,
      retryStrategy: () => null,
    });
    this.redis.on("error", () => {});
  }

  async proveWechat(code: string, source: string) {
    const credentials = this.config.wechat;
    if (!credentials) throw new ServiceUnavailableException();
    let count: unknown;
    try {
      if (this.redis.status !== "ready") {
        this.connection ??= this.redis.connect().finally(() => {
          this.connection = undefined;
        });
        await this.connection;
      }
      count = await this.redis.eval(
        "local n = redis.call('INCR', KEYS[1]); if n == 1 then redis.call('EXPIRE', KEYS[1], 60) end; return n",
        1,
        `${this.config.redisKeyPrefix ?? "timenook"}:login:${digest(source)}`,
      );
    } catch {
      throw new ServiceUnavailableException();
    }
    if (Number(count) > (this.config.loginLimitPerMinute ?? 120))
      throw new HttpException("Rate limited", 429);
    await this.database.wechatCodeRedemption.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    try {
      await this.database.wechatCodeRedemption.create({
        data: {
          appId: credentials.appId,
          codeHash: digest(code),
          expiresAt: new Date(Date.now() + 600_000),
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      )
        throw new UnauthorizedException();
      throw error;
    }
    const openId = await exchangeCode(credentials, code, this.wechatFetch);
    return { appId: credentials.appId, openId };
  }

  async login(
    code: string,
    source: string,
    profile: WechatLoginProfile,
    expectedUserId?: string,
  ): Promise<LoginResult> {
    const { appId, openId } = await this.proveWechat(code, source);
    if (this.accessToken && (await this.accessToken).expiresAt <= Date.now())
      this.accessToken = undefined;
    this.accessToken ??= wechatAccessToken(
      this.config.wechat!,
      this.wechatFetch,
    ).catch((error) => {
      this.accessToken = undefined;
      throw error;
    });
    const { token: accessToken } = await this.accessToken;
    const phoneNumber = await exchangePhoneCode(
      accessToken,
      profile.phoneCode,
      openId,
      appId,
      this.wechatFetch,
    );
    const token = randomBytes(32).toString("base64url");
    const session = await this.database.$transaction(async (transaction) => {
      const user = await phoneAccountIn(transaction, phoneNumber, {
        appId,
        openId,
      });
      if (expectedUserId && user.id !== expectedUserId)
        throw new ConflictException();
      await acceptTermsIn(transaction, user.id, "wechat_login");
      return transaction.session.create({
        include: {
          user: { select: { id: true, nickname: true, phoneNumber: true } },
        },
        data: {
          id: randomUUID(),
          userId: user.id,
          tokenHash: digest(token),
          expiresAt: new Date(
            Date.now() + (this.config.sessionTtlSeconds ?? 604800) * 1000,
          ),
        },
      });
    });
    return {
      user: accountView(session.user),
      session: {
        id: session.id,
        token,
        expiresAt: session.expiresAt.toISOString(),
      },
    };
  }

  async current(
    authorization?: string,
    transaction?: Prisma.TransactionClient,
  ): Promise<Account> {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization ?? "");
    if (!match) throw new UnauthorizedException();
    const tokenHash = digest(match[1]);
    // A protected transactional command serializes with session revocation.
    if (transaction)
      await transaction.$queryRaw`SELECT id FROM sessions WHERE token_hash=${tokenHash} FOR SHARE`;
    const session = await (transaction ?? this.database).session.findUnique({
      where: { tokenHash },
      include: {
        user: { select: { id: true, nickname: true, phoneNumber: true } },
      },
    });
    if (
      !session ||
      session.revokedAt ||
      session.expiresAt.getTime() <= Date.now()
    )
      throw new UnauthorizedException();
    return accountView(session.user);
  }

  async updateNickname(
    nickname: string,
    authorization?: string,
  ): Promise<Account> {
    return this.database.$transaction(async (tx) => {
      const account = await this.current(authorization, tx);
      const user = await tx.user.update({
        where: { id: account.id },
        data: { nickname },
        select: { id: true, nickname: true, phoneNumber: true },
      });
      return accountView(user);
    });
  }

  async revoke(sessionId: string, authorization?: string): Promise<void> {
    const user = await this.current(authorization);
    const result = await this.database.session.updateMany({
      where: { id: sessionId, userId: user.id },
      data: { revokedAt: new Date() },
    });
    if (result.count === 0) throw new NotFoundException();
  }

  async onModuleDestroy(): Promise<void> {
    this.redis.disconnect();
    await this.database.$disconnect();
  }
}
