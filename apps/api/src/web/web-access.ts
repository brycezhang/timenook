import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  OnModuleDestroy,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import type { FastifyRequest } from "fastify";
import { API_CONFIG, ApiConfig } from "../config";
import { accountView, phoneAccountIn } from "../identity/phone-account";
import { acceptTermsIn } from "../identity/project-members";
import { IdentityAccess } from "../identity/identity-access";
import {
  PERSISTENT_WEB_EXPIRY,
  webCredentialExpiry,
  webDigest,
} from "./web-provisioning";

export const WEB_COOKIE = "__Secure-timenook_web";
export const WEB_COOKIE_PATH = "/api/v1";

@Injectable()
export class WebAccess implements OnModuleDestroy {
  private readonly db: PrismaClient;
  private readonly redis: Redis;
  private connection?: Promise<void>;
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly identity: IdentityAccess,
  ) {
    this.db = new PrismaClient({ datasourceUrl: config.databaseUrl });
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
  private view(
    token: string,
    session: {
      id: string;
      userId: string;
      expiresAt: Date;
      user: { id: string; nickname: string | null; phoneNumber: string | null };
    },
  ) {
    return {
      user: accountView(session.user),
      session: { id: session.id, expiresAt: session.expiresAt.toISOString() },
      csrfToken: createHmac(
        "sha256",
        Buffer.from(this.config.web!.sessionKey, "base64"),
      )
        .update(`web:${session.id}:${token}`)
        .digest("base64url"),
    };
  }
  requireOrigin(request: FastifyRequest) {
    if (
      request.headers.origin !== this.config.web!.origin ||
      request.headers["x-timenook-web"] !== "1"
    )
      throw new ForbiddenException();
  }
  async limit(
    source: string,
    maximum = this.config.loginLimitPerMinute ?? 120,
  ) {
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
        `${this.config.redisKeyPrefix ?? "timenook"}:web-login:${webDigest(source)}`,
      );
    } catch {
      throw new ServiceUnavailableException();
    }
    if (Number(count) > maximum) throw new HttpException("Rate limited", 429);
  }
  async login(phoneNumber: string, previousToken?: string) {
    const token = randomBytes(32).toString("base64url");
    const session = await this.db.$transaction(async (tx) => {
      const user = await phoneAccountIn(tx, phoneNumber);
      await acceptTermsIn(tx, user.id, "web_login");
      if (previousToken && /^[A-Za-z0-9_-]{43}$/.test(previousToken))
        await tx.session.updateMany({
          where: {
            tokenHash: webDigest(previousToken),
            webSession: {
              is: { keyHash: webDigest(this.config.web!.sessionKey) },
            },
            revokedAt: null,
          },
          data: { revokedAt: new Date() },
        });
      return tx.session.create({
        include: {
          user: { select: { id: true, nickname: true, phoneNumber: true } },
        },
        data: {
          id: randomUUID(),
          userId: user.id,
          tokenHash: webDigest(token),
          expiresAt: new Date(
            Date.now() + this.config.web!.sessionTtlSeconds * 1000,
          ),
          webSession: {
            create: { keyHash: webDigest(this.config.web!.sessionKey) },
          },
        },
      });
    });
    return { token, data: this.view(token, session) };
  }
  async exchange(ticket: string, previousToken?: string) {
    const token = randomBytes(32).toString("base64url"),
      now = new Date();
    const session = await this.db.$transaction(async (tx) => {
      const changed = await tx.webLoginTicket.updateMany({
        where: {
          tokenHash: webDigest(ticket),
          // Internal acceptance links remain reusable until explicitly revoked.
          consumedAt:
            this.config.acceptance?.mode === "internal-acceptance"
              ? undefined
              : null,
          revokedAt: null,
          expiresAt: { gt: now },
        },
        data: { consumedAt: now },
      });
      if (changed.count !== 1) throw new UnauthorizedException();
      const issued = await tx.webLoginTicket.findUniqueOrThrow({
        where: { tokenHash: webDigest(ticket) },
      });
      if (previousToken && /^[A-Za-z0-9_-]{43}$/.test(previousToken))
        await tx.session.updateMany({
          where: {
            tokenHash: webDigest(previousToken),
            revokedAt: null,
            webSession: {
              is: { keyHash: webDigest(this.config.web!.sessionKey) },
            },
          },
          data: { revokedAt: now },
        });
      return tx.session.create({
        include: {
          user: { select: { id: true, nickname: true, phoneNumber: true } },
        },
        data: {
          id: randomUUID(),
          userId: issued.userId,
          tokenHash: webDigest(token),
          expiresAt: webCredentialExpiry(
            this.config,
            this.config.web!.sessionTtlSeconds,
          ),
          webSession: {
            create: { keyHash: webDigest(this.config.web!.sessionKey) },
          },
        },
      });
    });
    return { token, data: this.view(token, session) };
  }
  async current(request: FastifyRequest) {
    if (
      request.headers.authorization ||
      (request.headers.origin &&
        request.headers.origin !== this.config.web!.origin)
    )
      throw new ForbiddenException();
    const occurrences = (request.headers.cookie ?? "")
      .split(";")
      .filter((part) => part.trim().startsWith(`${WEB_COOKIE}=`));
    if (occurrences.length !== 1) throw new UnauthorizedException();
    const token = request.cookies[WEB_COOKIE];
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new UnauthorizedException();
    const session = await this.db.session.findUnique({
      where: { tokenHash: webDigest(token) },
      include: {
        webSession: true,
        user: { select: { id: true, nickname: true, phoneNumber: true } },
      },
    });
    if (
      !session ||
      session.revokedAt ||
      session.expiresAt.getTime() <= Date.now() ||
      session.webSession?.keyHash !== webDigest(this.config.web!.sessionKey)
    )
      throw new UnauthorizedException();
    return { token, data: this.view(token, session) };
  }
  async requireMutation(request: FastifyRequest) {
    this.requireOrigin(request);
    const current = await this.current(request);
    const supplied = request.headers["x-csrf-token"];
    const expected = current.data.csrfToken;
    if (
      typeof supplied !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(supplied) ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
    )
      throw new ForbiddenException();
    return current;
  }
  async logout(request: FastifyRequest) {
    const current = await this.requireMutation(request);
    await this.identity.revoke(
      current.data.session.id,
      `Bearer ${current.token}`,
    );
  }
  async bridge(request: FastifyRequest) {
    const route = request.routeOptions.url;
    if (
      !route?.startsWith("/v1/") ||
      /^\/v1\/(?:web|wechat-links|admin|webhooks|probes)(?:\/|$)/.test(route) ||
      route === "/v1/sessions/wechat" ||
      !request.cookies[WEB_COOKIE]
    )
      return;
    const current = ["GET", "HEAD", "OPTIONS"].includes(request.method)
      ? await this.current(request)
      : await this.requireMutation(request);
    request.headers.authorization = `Bearer ${current.token}`;
  }
  async onModuleDestroy() {
    this.redis.disconnect();
    await this.db.$disconnect();
  }
}
