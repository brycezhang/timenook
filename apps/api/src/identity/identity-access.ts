import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { Prisma, PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import type { Account, LoginResult } from "@timenook/contracts";
import { API_CONFIG, ApiConfig } from "../config";
import { exchangeCode } from "./wechat";

export const WECHAT_FETCH = Symbol("WECHAT_FETCH");
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

@Injectable()
export class IdentityAccess implements OnModuleDestroy {
  private readonly database: PrismaClient;
  private readonly redis: Redis;
  private connection?: Promise<void>;

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

  async login(code: string, source: string): Promise<LoginResult> {
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
    const token = randomBytes(32).toString("base64url");
    const session = await this.database.$transaction(async (transaction) => {
      // Serialize first-account creation for the same WeChat identity across processes.
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([credentials.appId, openId])}, 0))`;
      let stored = await transaction.wechatIdentity.findUnique({
        where: { appId_openId: { appId: credentials.appId, openId: openId } },
      });
      if (!stored) {
        const user = await transaction.user.create({
          data: { id: randomUUID() },
        });
        stored = await transaction.wechatIdentity.create({
          data: { appId: credentials.appId, openId, userId: user.id },
        });
      }
      return transaction.session.create({
        data: {
          id: randomUUID(),
          userId: stored.userId,
          tokenHash: digest(token),
          expiresAt: new Date(
            Date.now() + (this.config.sessionTtlSeconds ?? 604800) * 1000,
          ),
        },
      });
    });
    return {
      user: { id: session.userId },
      session: {
        id: session.id,
        token,
        expiresAt: session.expiresAt.toISOString(),
      },
    };
  }

  async current(authorization?: string): Promise<Account> {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization ?? "");
    if (!match) throw new UnauthorizedException();
    const session = await this.database.session.findUnique({
      where: { tokenHash: digest(match[1]) },
    });
    if (
      !session ||
      session.revokedAt ||
      session.expiresAt.getTime() <= Date.now()
    )
      throw new UnauthorizedException();
    return { id: session.userId };
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
