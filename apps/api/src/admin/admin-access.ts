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
  AdminFeishuLogin,
  AdminPermission,
  AdminState,
} from "@timenook/contracts";
import { API_CONFIG, ApiConfig } from "../config";
import {
  ADMIN_FEISHU_FETCH,
  FEISHU_AUTHORIZE_URL,
  feishuIdentity,
} from "./feishu";

const COOKIE = "__Secure-timenook_admin";
const PATH = "/api/v1/admin";
const FLOW_COOKIE = "__Secure-timenook_oauth";
const CALLBACK_PATH = `${PATH}/feishu/callback`;
const ROUTE_ACTIONS: Record<string, string> = {
  "POST /v1/admin/care-requests/:caseId/export/access-verification": "care.export.access-verification",
  "POST /v1/admin/quality/cases/:caseId/review": "quality.review",
  "POST /v1/admin/quality/cases/:caseId/reprints": "quality.reprint",
  "GET /v1/admin/quality/cases/:caseId": "quality.read",
  "POST /v1/admin/quality/cases/:caseId/assign": "quality.assign",
  "GET /v1/admin/quality/cases/:caseId/materials": "quality.materials",
  "GET /v1/admin/quality/cases/:caseId/pdf": "quality.pdf",
  "GET /v1/admin/refunds/cases/:caseId": "refund.read",
  "GET /v1/admin/refunds/:id": "refund.read",
  "POST /v1/admin/refunds/:id/approve": "refund.approve",
  "POST /v1/admin/refunds/:id/reject": "refund.reject",
  "POST /v1/admin/refunds/:id/production-review": "refund.production-review",
  "POST /v1/admin/refunds/:id/submit": "refund.submit",
  "POST /v1/admin/refunds/:id/reconcile": "refund.reconcile",
  "GET /v1/admin/fulfillment": "fulfillment.list",
  "GET /v1/admin/fulfillment/:id": "fulfillment.read",
  "POST /v1/admin/fulfillment/:id/attempts": "fulfillment.attempt",
  "GET /v1/admin/fulfillment/:id/attempts/:attemptId/materials":
    "fulfillment.materials",
  "GET /v1/admin/fulfillment/:id/attempts/:attemptId/pdf": "fulfillment.pdf",
  "POST /v1/admin/fulfillment/:id/attempts/:attemptId/handoff":
    "fulfillment.handoff",
  "POST /v1/admin/fulfillment/:id/attempts/:attemptId/receipt":
    "fulfillment.receipt",
  "POST /v1/admin/fulfillment/:id/attempts/:attemptId/cancel":
    "fulfillment.cancel",
  "POST /v1/admin/fulfillment/:id/attempts/:attemptId/shipping":
    "fulfillment.shipping",
  "POST /v1/admin/fulfillment/:id/attempts/:attemptId/delivery":
    "fulfillment.delivery",
  "POST /v1/admin/first-copy/:id/approve": "fulfillment.approve",
  "GET /v1/admin/tasks": "tasks.list",
  "POST /v1/admin/projects/:id/tasks/:taskId/retry": "tasks.retry",
  "GET /v1/admin/care-requests/:caseId/story": "care.story.read",
  "POST /v1/admin/care-requests/:caseId/story/revisions": "care.story.revise",
  "GET /v1/admin/care-requests": "care.list",
  "GET /v1/admin/care-requests/:id": "care.read",
  "POST /v1/admin/projects/:id/rebind": "care.rebind",
  "POST /v1/admin/projects/:id/care-requests": "care.open",
  "POST /v1/admin/care-requests/:id/verify": "care.verify",
  "GET /v1/admin/session": "admin.session",
  "POST /v1/admin/feishu/login": "admin.feishu.login",
  "GET /v1/admin/feishu/callback": "admin.feishu.callback",
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
  private get realm() {
    return this.config.environment === "production" ? "production" : "local";
  }
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(ADMIN_FEISHU_FETCH) private readonly feishuFetch: typeof fetch,
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
  async run<T>(
    action: string,
    request: AdminRequest,
    work: () => Promise<T>,
  ): Promise<T> {
    request.adminAction = action;
    try {
      if (
        request.headers["sec-fetch-site"] === "cross-site" &&
        !(action === "admin.feishu.callback" && request.method === "GET")
      )
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
    return createHmac("sha256", this.settings().sessionKey)
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
      (session.phase === "authenticated" && !session.account) ||
      (session.account && !this.currentIdentity(session)) ||
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
      loginAvailable: !!this.config.admin?.feishu,
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
        identityHash: adminId
          ? await this.accountIdentityHash(adminId, tx)
          : null,
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
  private identityHash(account: {
    realm: string;
    feishuAppId: string | null;
    tenantKey: string | null;
    feishuOpenId: string | null;
  }) {
    return digest(
      JSON.stringify([
        account.realm,
        account.feishuAppId,
        account.tenantKey,
        account.feishuOpenId,
      ]),
    );
  }
  private currentIdentity(session: Session) {
    const account = session.account,
      feishu = this.settings().feishu;
    return (
      !!account &&
      !!feishu &&
      account.realm === this.realm &&
      account.feishuAppId === feishu.appId &&
      account.tenantKey === feishu.tenantKey &&
      session.identityHash === this.identityHash(account)
    );
  }
  private async accountIdentityHash(id: string, tx: Prisma.TransactionClient) {
    const account = await tx.adminAccount.findUniqueOrThrow({ where: { id } });
    return this.identityHash(account);
  }
  private flowKey(state: string) {
    return `${this.config.redisKeyPrefix ?? "timenook"}:admin:oauth:${digest(state)}`;
  }
  async feishuLogin(
    request: AdminRequest,
    reply: FastifyReply,
  ): Promise<AdminFeishuLogin> {
    const settings = this.settings(),
      feishu = settings.feishu;
    if (!feishu) throw new ServiceUnavailableException();
    const anonymous = await this.session(request, "anonymous");
    this.assertCsrf(request);
    await this.limit("oauth-start", request.ip, 20);
    const state = randomBytes(32).toString("base64url");
    const browser = randomBytes(32).toString("base64url");
    const flow = {
      browserHash: digest(browser),
      sessionId: anonymous.id,
      appId: feishu.appId,
      tenantKey: feishu.tenantKey,
      realm: this.realm,
    };
    try {
      await this.redis.set(
        this.flowKey(state),
        JSON.stringify(flow),
        "EX",
        settings.challengeTtlSeconds,
      );
    } catch {
      throw new ServiceUnavailableException();
    }
    await this.audit(request.adminAction!, request, "success");
    request.auditRecorded = true;
    reply.setCookie(FLOW_COOKIE, browser, {
      path: CALLBACK_PATH,
      secure: true,
      httpOnly: true,
      sameSite: "lax",
      maxAge: settings.challengeTtlSeconds,
    });
    const url = new URL(FEISHU_AUTHORIZE_URL);
    url.searchParams.set("client_id", feishu.appId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", settings.origin + CALLBACK_PATH);
    url.searchParams.set("state", state);
    return { authorizationUrl: url.toString() };
  }
  async feishuCallback(
    request: AdminRequest,
    reply: FastifyReply,
    query: { state?: string; code?: string; error?: string },
  ) {
    const settings = this.settings(),
      feishu = settings.feishu;
    if (!feishu) throw new ServiceUnavailableException();
    await this.limit("oauth-callback", request.ip, 60);
    const browser = request.cookies?.[FLOW_COOKIE];
    if (
      typeof query.state !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(query.state) ||
      !browser ||
      !/^[A-Za-z0-9_-]{43}$/.test(browser)
    )
      throw new UnauthorizedException();
    let stored: unknown;
    try {
      stored = await this.redis.eval(
        "local v=redis.call('GET',KEYS[1]); if not v then return nil end; local p=cjson.decode(v); if p.browserHash~=ARGV[1] then return nil end; redis.call('DEL',KEYS[1]); return v",
        1,
        this.flowKey(query.state),
        digest(browser),
      );
    } catch {
      throw new ServiceUnavailableException();
    }
    if (typeof stored !== "string") throw new UnauthorizedException();
    const flow = JSON.parse(stored) as {
      sessionId: string;
      appId: string;
      tenantKey: string;
      realm: string;
    };
    if (
      flow.appId !== feishu.appId ||
      flow.tenantKey !== feishu.tenantKey ||
      flow.realm !== this.realm ||
      query.error ||
      typeof query.code !== "string" ||
      !query.code ||
      query.code.length > 2048 ||
      /[\r\n]/.test(query.code)
    )
      throw new UnauthorizedException();
    const user = await feishuIdentity(
      feishu,
      query.code,
      settings.origin + CALLBACK_PATH,
      this.feishuFetch,
    );
    if (user.tenantKey !== feishu.tenantKey) throw new ForbiddenException();
    const issued = await this.database.$transaction(async (tx) => {
      const account = await tx.adminAccount.findUnique({
        where: {
          realm_feishuAppId_tenantKey_feishuOpenId: {
            realm: this.realm,
            feishuAppId: feishu.appId,
            tenantKey: user.tenantKey,
            feishuOpenId: user.openId,
          },
        },
      });
      if (!account || account.disabled) throw new ForbiddenException();
      request.adminOperator = account.id;
      // Lock the anonymous session before the account, matching command/logout lock order.
      const previous = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM admin_sessions WHERE id = ${flow.sessionId}::uuid AND phase = 'anonymous' AND realm = ${this.realm} AND revoked_at IS NULL AND expires_at > now() FOR UPDATE`;
      if (!previous.length) throw new UnauthorizedException();
      await tx.$queryRaw`SELECT id FROM admin_accounts WHERE id = ${account.id}::uuid FOR NO KEY UPDATE`;
      const current = await tx.adminAccount.findUniqueOrThrow({
        where: { id: account.id },
      });
      if (
        current.disabled ||
        current.feishuAppId !== feishu.appId ||
        current.tenantKey !== user.tenantKey ||
        current.feishuOpenId !== user.openId
      )
        throw new ForbiddenException();
      return this.issue(
        request,
        "authenticated",
        current.id,
        flow.sessionId,
        tx,
      );
    });
    this.finish(request, reply, issued);
  }
  clearOAuthCookie(reply: FastifyReply) {
    reply.clearCookie(FLOW_COOKIE, {
      path: CALLBACK_PATH,
      secure: true,
      httpOnly: true,
      sameSite: "lax",
    });
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
    readOnly = false,
  ): Promise<T> {
    const session = await this.authorized(request, permission);
    if (readOnly && request.method !== "GET") throw new ForbiddenException();
    if (!readOnly) this.assertCsrf(request);
    const result = await this.database.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM admin_sessions WHERE id = ${session.id}::uuid FOR UPDATE`;
      // Serialize authority changes while allowing callback foreign-key checks.
      await tx.$queryRaw`SELECT id FROM admin_accounts WHERE id = ${session.adminId!}::uuid FOR NO KEY UPDATE`;
      const current = await tx.adminSession.findUnique({
        where: { id: session.id },
        include: { account: true },
      });
      if (
        !current ||
        current.revokedAt ||
        current.expiresAt.getTime() <= Date.now() ||
        current.account?.disabled ||
        !this.currentIdentity(current) ||
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
      // A concurrent OAuth callback may already have consumed this
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
