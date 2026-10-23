import {
  createHash,
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
import { Prisma, PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ADMIN_PERMISSIONS, isAdminPermission } from "@timenook/contracts";
import type {
  AdminAuditEntry,
  AdminEnrollment,
  AdminPermission,
  AdminState,
} from "@timenook/contracts";
import { verify, generateURI } from "otplib";
import { API_CONFIG, ApiConfig } from "../config";
import { decryptSecret, hashPassword, verifyPassword } from "./secrets";

const COOKIE = "__Secure-timenook_admin";
const PATH = "/timenook/v1/admin";
const ROUTE_ACTIONS: Record<string, string> = {
  "GET /v1/admin/care-requests": "care.list",
  "GET /v1/admin/care-requests/:id": "care.read",
  "POST /v1/admin/projects/:id/rebind": "care.rebind",
  "POST /v1/admin/projects/:id/care-requests": "care.open",
  "POST /v1/admin/care-requests/:id/verify": "care.verify",
  "GET /v1/admin/service-terms/:id": "service-terms.read",
  "POST /v1/admin/service-terms/:id/pause": "service-terms.pause",
  "GET /v1/admin/session": "admin.session",
  "POST /v1/admin/login": "admin.password",
  "GET /v1/admin/mfa/enrollment": "admin.mfa.enrollment",
  "POST /v1/admin/mfa": "admin.mfa",
  "GET /v1/admin/runtime": "admin.runtime",
  "GET /v1/admin/audit": "admin.audit",
  "POST /v1/admin/logout": "admin.logout",
  "GET /v1/admin/catalog/recipient-types": "catalog.recipient.list",
  "POST /v1/admin/catalog/recipient-types": "catalog.recipient.create",
  "PUT /v1/admin/catalog/recipient-types/:code": "catalog.recipient.update",
  "GET /v1/admin/catalog/package-drafts": "catalog.draft.list",
  "POST /v1/admin/catalog/package-drafts": "catalog.draft.create",
  "PUT /v1/admin/catalog/package-drafts/:id": "catalog.draft.update",
  "POST /v1/admin/catalog/package-drafts/:id/preview-versions":
    "catalog.preview.freeze",
  "GET /v1/admin/catalog/package-versions": "catalog.version.list",
};
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
type Session = Prisma.AdminSessionGetPayload<{ include: { account: true } }>;
type AdminRequest = FastifyRequest & {
  adminOperator?: string;
  adminAction?: string;
  auditRecorded?: boolean;
};
@Injectable()
export class AdminAccess implements OnModuleDestroy {
  private readonly database: PrismaClient;
  private readonly redis: Redis;
  private connection?: Promise<void>;
  private dummyHash = hashPassword(randomBytes(32).toString("hex"));
  private get realm() {
    return this.config.environment === "production" ? "production" : "local";
  }
  constructor(@Inject(API_CONFIG) private readonly config: ApiConfig) {
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
  async run<T>(
    action: string,
    request: AdminRequest,
    work: () => Promise<T>,
  ): Promise<T> {
    request.adminAction = action;
    try {
      if (request.headers["sec-fetch-site"] === "cross-site")
        throw new ForbiddenException();
      const result = await work();
      if (!request.auditRecorded) await this.audit(action, request, "success");
      return result;
    } catch (error) {
      await this.auditFailure(
        action,
        request,
        error instanceof HttpException
          ? `denied:${error.getStatus()}`
          : "error",
      );
      throw error;
    }
  }
  private async audit(
    action: string,
    request: AdminRequest,
    result: string,
    tx: Prisma.TransactionClient = this.database,
  ) {
    await tx.adminAudit.create({
      data: {
        id: randomUUID(),
        operatorId: request.adminOperator,
        action,
        requestId: request.id,
        result,
      },
    });
  }
  private settings() {
    if (!this.config.admin) throw new ServiceUnavailableException();
    return this.config.admin;
  }
  private token(request: FastifyRequest) {
    const value = request.cookies?.[COOKIE];
    if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value))
      throw new UnauthorizedException();
    return value;
  }
  private csrf(token: string) {
    return createHmac("sha256", this.settings().encryptionKey)
      .update(`csrf:${token}`)
      .digest("base64url");
  }
  async session(request: AdminRequest, phase?: string) {
    const token = this.token(request);
    const session = await this.database.adminSession.findUnique({
      where: { tokenHash: digest(token) },
      include: { account: true },
    });
    if (
      !session ||
      session.realm !== this.realm ||
      session.revokedAt ||
      session.expiresAt.getTime() <= Date.now() ||
      session.account?.disabled ||
      (phase && session.phase !== phase)
    )
      throw new UnauthorizedException();
    if (session.account) request.adminOperator = session.account.id;
    return session;
  }
  private assertCsrf(request: FastifyRequest) {
    const supplied = request.headers["x-csrf-token"];
    const expected = this.csrf(this.token(request));
    if (
      request.headers.origin !== this.settings().origin ||
      typeof supplied !== "string" ||
      supplied.length !== expected.length ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
    )
      throw new ForbiddenException();
  }
  private result(session: Session, token: string): AdminState {
    return {
      authenticated: session.phase === "authenticated",
      mfaRequired: session.phase === "password",
      enrollmentRequired:
        session.phase === "password" && !session.account?.mfaEnrolled,
      operator:
        session.phase === "authenticated"
          ? {
              id: session.account!.id,
              username: session.account!.username,
              permissions:
                session.account!.permissions.filter(isAdminPermission),
            }
          : null,
      csrfToken: this.csrf(token),
      expiresAt: session.expiresAt.toISOString(),
    };
  }
  private setCookie(reply: FastifyReply, token: string, ttl: number) {
    reply.setCookie(COOKIE, token, {
      path: PATH,
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      maxAge: ttl,
    });
  }
  private async issue(
    request: AdminRequest,
    phase: string,
    adminId: string | undefined,
    previousId: string | undefined,
    tx: Prisma.TransactionClient,
  ) {
    const ttl =
      phase === "authenticated"
        ? this.settings().sessionTtlSeconds
        : this.settings().challengeTtlSeconds;
    if (previousId) {
      const consumed = await tx.adminSession.updateMany({
        where: {
          id: previousId,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { revokedAt: new Date() },
      });
      if (!consumed.count) throw new UnauthorizedException();
    }
    const token = randomBytes(32).toString("base64url");
    const session = await tx.adminSession.create({
      data: {
        id: randomUUID(),
        realm: this.realm,
        phase,
        adminId,
        tokenHash: digest(token),
        expiresAt: new Date(Date.now() + ttl * 1000),
      },
      include: { account: true },
    });
    await this.audit(request.adminAction!, request, "success", tx);
    return { session, token, ttl };
  }
  private finish(
    request: AdminRequest,
    reply: FastifyReply,
    issued: { session: Session; token: string; ttl: number },
  ) {
    request.auditRecorded = true;
    this.setCookie(reply, issued.token, issued.ttl);
    return this.result(issued.session, issued.token);
  }
  async auditUnhandled(request: AdminRequest, status: number) {
    if (request.adminAction) return;
    await this.auditFailure(
      ROUTE_ACTIONS[`${request.method} ${request.routeOptions.url}`] ??
        "admin.invalid",
      request,
      `denied:${status}`,
    );
  }
  private async auditFailure(
    action: string,
    request: AdminRequest,
    result: string,
  ) {
    try {
      if (!request.adminOperator) {
        try {
          // Validation, cross-site or phase checks may reject before identity
          // resolution. Only a valid cookie can identify the operator here.
          await this.session(request);
        } catch (error) {
          if (!(error instanceof UnauthorizedException)) throw error;
        }
      }
      await this.audit(action, request, result);
    } catch {
      // Failure auditing is best effort. Preserve the original safe response,
      // including when this runs in onSend after the exception filter.
    }
  }
  private async limit(scope: string, value: string, maximum: number) {
    try {
      if (this.redis.status !== "ready") {
        this.connection ??= this.redis.connect().finally(() => {
          this.connection = undefined;
        });
        await this.connection;
      }
      const count = Number(
        await this.redis.eval(
          "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],60) end; return n",
          1,
          `${this.config.redisKeyPrefix ?? "timenook"}:admin:${scope}:${digest(value)}`,
        ),
      );
      if (count > maximum) throw new HttpException("Rate limited", 429);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException();
    }
  }
  async bootstrap(request: AdminRequest, reply: FastifyReply) {
    this.settings();
    try {
      return this.result(await this.session(request), this.token(request));
    } catch (error) {
      if (!(error instanceof UnauthorizedException)) throw error;
    }
    await this.limit("bootstrap", request.ip, 120);
    return this.finish(
      request,
      reply,
      await this.database.$transaction((tx) =>
        this.issue(request, "anonymous", undefined, undefined, tx),
      ),
    );
  }
  async login(
    request: AdminRequest,
    reply: FastifyReply,
    username: string,
    password: string,
  ) {
    const old = await this.session(request, "anonymous");
    this.assertCsrf(request);
    await this.limit("password-ip", request.ip, 30);
    await this.limit("password-account", username, 5);
    const account = await this.database.adminAccount.findUnique({
      where: { realm_username: { realm: this.realm, username } },
    });
    const valid = await verifyPassword(
      password,
      account?.passwordHash ?? (await this.dummyHash),
    );
    if (!valid || !account || account.disabled)
      throw new UnauthorizedException();
    request.adminOperator = account.id;
    return this.finish(
      request,
      reply,
      await this.database.$transaction((tx) =>
        this.issue(request, "password", account.id, old.id, tx),
      ),
    );
  }
  async enrollment(request: AdminRequest): Promise<AdminEnrollment> {
    const session = await this.session(request, "password");
    if (!session.account || session.account.mfaEnrolled)
      throw new ForbiddenException();
    const secret = decryptSecret(
      session.account.mfaSecret,
      this.settings().encryptionKey,
    );
    return {
      secret,
      uri: generateURI({
        issuer: "TimeNook",
        label: session.account.username,
        secret,
      }),
    };
  }
  async mfa(request: AdminRequest, reply: FastifyReply, code: string) {
    const session = await this.session(request, "password");
    this.assertCsrf(request);
    await this.limit("mfa", session.adminId!, 5);
    const issued = await this.database.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${session.adminId!}, 0))`;
      const account = await tx.adminAccount.findUniqueOrThrow({
        where: { id: session.adminId! },
      });
      if (account.disabled) throw new UnauthorizedException();
      const result = await verify({
        secret: decryptSecret(account.mfaSecret, this.settings().encryptionKey),
        token: code,
        epochTolerance: [30, 0],
        afterTimeStep:
          account.lastTotpStep < 0 ? undefined : account.lastTotpStep,
      });
      if (!result.valid || !("timeStep" in result))
        throw new UnauthorizedException();
      await tx.adminAccount.update({
        where: { id: account.id },
        data: { mfaEnrolled: true, lastTotpStep: result.timeStep },
      });
      return this.issue(request, "authenticated", account.id, session.id, tx);
    });
    return this.finish(request, reply, issued);
  }
  async authorized(request: AdminRequest, permission: AdminPermission) {
    const session = await this.session(request, "authenticated");
    if (!session.account?.permissions.includes(permission))
      throw new ForbiddenException();
    return session;
  }
  /** Catalog writes and their audit commit together; recheck authority after locking. */
  async command<T>(
    request: AdminRequest,
    permission: AdminPermission,
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    const session = await this.authorized(request, permission);
    this.assertCsrf(request);
    const result = await this.database.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM admin_sessions WHERE id = ${session.id}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM admin_accounts WHERE id = ${session.adminId!}::uuid FOR UPDATE`;
      const current = await tx.adminSession.findUnique({
        where: { id: session.id },
        include: { account: true },
      });
      if (
        !current ||
        current.revokedAt ||
        current.expiresAt.getTime() <= Date.now() ||
        current.account?.disabled ||
        current.phase !== "authenticated" ||
        current.realm !== this.realm
      )
        throw new UnauthorizedException();
      if (!current.account?.permissions.includes(permission))
        throw new ForbiddenException();
      const value = await work(tx);
      await this.audit(request.adminAction!, request, "success", tx);
      return value;
    });
    request.auditRecorded = true;
    return result;
  }
  async audits(request: AdminRequest): Promise<AdminAuditEntry[]> {
    await this.authorized(request, ADMIN_PERMISSIONS.readAudit);
    const records = await this.database.adminAudit.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return records.map((record) => ({
      ...record,
      createdAt: record.createdAt.toISOString(),
    }));
  }
  async logout(request: AdminRequest, reply: FastifyReply) {
    const session = await this.session(request);
    this.assertCsrf(request);
    await this.database.$transaction(async (tx) => {
      const revoked = await tx.adminSession.updateMany({
        where: {
          id: session.id,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { revokedAt: new Date() },
      });
      // A concurrent password/MFA rotation may already have consumed this
      // cookie. Do not claim logout succeeded or clear the newer cookie.
      if (!revoked.count) throw new UnauthorizedException();
      await this.audit(request.adminAction!, request, "success", tx);
    });
    request.auditRecorded = true;
    reply.clearCookie(COOKIE, {
      path: PATH,
      httpOnly: true,
      secure: true,
      sameSite: "strict",
    });
  }
  async onModuleDestroy() {
    this.redis.disconnect();
    await this.database.$disconnect();
  }
}
