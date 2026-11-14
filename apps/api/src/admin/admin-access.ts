import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import {
  ForbiddenException,
  NotFoundException,
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
import { ADMIN_PERMISSIONS } from "@timenook/contracts";
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

const passwordKey = (password: string, salt: string) =>
  new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
const partnerPermissions = [
  ADMIN_PERMISSIONS.channelGiftsRead,
  ADMIN_PERMISSIONS.channelGiftsWrite,
];
const permissionsFor = (role: string) =>
  role === "super_admin"
    ? Object.values(ADMIN_PERMISSIONS)
    : role === "partner"
      ? partnerPermissions
      : [];
const COOKIE = "__Secure-timenook_admin";
const PATH = "/api/v1/admin";
const FLOW_COOKIE = "__Secure-timenook_oauth";
const CALLBACK_PATH = `${PATH}/feishu/callback`;
const ROUTE_ACTIONS: Record<string, string> = {
  "GET /v1/admin/users": "users.list",
  "GET /v1/admin/users/:id": "users.read",
  "GET /v1/admin/users/projects/:projectId": "users.project",
  "POST /v1/admin/users/:id/notes": "users.note",
  "GET /v1/admin/orders": "orders.list",
  "GET /v1/admin/orders/:id": "orders.read",
  "POST /v1/admin/orders/:id/notes": "orders.note",
  "POST /v1/admin/care-requests/:caseId/export/access-verification":
    "care.export.access-verification",
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
  "POST /v1/admin/fulfillment/:id/attempts/:attemptId/printing":
    "fulfillment.printing",
  "POST /v1/admin/fulfillment/:id/attempts/:attemptId/wechat":
    "fulfillment.wechat",
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
  "POST /v1/admin/partner/login": "admin.partner.login",
  "GET /v1/admin/partners": "admin.partners.list",
  "POST /v1/admin/partners": "admin.partners.create",
  "POST /v1/admin/partners/:id/revoke": "admin.partners.revoke",
  "POST /v1/admin/partners/:id/password": "admin.partners.password",
  "POST /v1/admin/partners/:id/reset-password": "admin.partners.reset-password",
  "DELETE /v1/admin/partners/:id": "admin.partners.delete",
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
  adminRole?: "super_admin" | "partner";
  adminAction?: string;
  adminResourceType?: string;
  adminResourceId?: string;
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
        resourceType: request.adminResourceType,
        resourceId: request.adminResourceId,
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
    if (session.account) {
      request.adminOperator = session.account.id;
      request.adminRole = session.account.role as "super_admin" | "partner";
    }
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
              role: session.account!.role as "super_admin" | "partner",
              id: session.account!.id,
              username: session.account!.username,
              permissions: permissionsFor(session.account!.role),
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
    role: string;
    feishuAppId: string | null;
    tenantKey: string | null;
    feishuOpenId: string | null;
    passwordHash: string | null;
    passwordCiphertext: string | null;
  }) {
    return digest(
      JSON.stringify([
        account.realm,
        account.role,
        account.feishuAppId,
        account.tenantKey,
        account.feishuOpenId,
        // Hash-only accounts retain their sessions until the password is reset.
        ...(account.passwordCiphertext ? [account.passwordHash] : []),
      ]),
    );
  }
  private currentIdentity(session: Session) {
    const account = session.account,
      feishu = this.settings().feishu;
    if (account?.role === "partner")
      return (
        account.realm === this.realm &&
        !!account.passwordHash &&
        session.identityHash === this.identityHash(account)
      );
    return (
      !!account &&
      account.role === "super_admin" &&
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
      if (!account || account.disabled || account.role !== "super_admin")
        throw new ForbiddenException();
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
        current.role !== "super_admin" ||
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
    if (!permissionsFor(session.account?.role ?? "").includes(permission))
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
      if (!permissionsFor(current.account?.role ?? "").includes(permission))
        throw new ForbiddenException();
      const value = await work(tx);
      await this.audit(request.adminAction!, request, "success", tx);
      return value;
    });
    request.auditRecorded = true;
    return result;
  }
  async partnerLogin(
    request: AdminRequest,
    reply: FastifyReply,
    input: { username: string; password: string },
  ) {
    const anonymous = await this.session(request, "anonymous");
    this.assertCsrf(request);
    await this.limit("password-ip", request.ip, 30);
    await this.limit("password-account", input.username, 10);
    const account = await this.database.adminAccount.findUnique({
      where: {
        realm_username: { realm: this.realm, username: input.username },
      },
    });
    const [salt, expected] = account?.passwordHash?.split(":") ?? [
      "unavailable",
      "00".repeat(64),
    ];
    const actual = await passwordKey(input.password, salt);
    if (
      !account ||
      account.role !== "partner" ||
      account.disabled ||
      !timingSafeEqual(actual, Buffer.from(expected, "hex"))
    )
      throw new UnauthorizedException();
    const issued = await this.database.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM admin_sessions WHERE id = ${anonymous.id}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM admin_accounts WHERE id = ${account.id}::uuid FOR NO KEY UPDATE`;
      const current = await tx.adminAccount.findUniqueOrThrow({
        where: { id: account.id },
      });
      if (
        current.disabled ||
        current.role !== "partner" ||
        current.passwordHash !== account.passwordHash
      )
        throw new UnauthorizedException();
      request.adminOperator = current.id;
      return this.issue(request, "authenticated", current.id, anonymous.id, tx);
    });
    return this.finish(request, reply, issued);
  }
  async partners(request: AdminRequest) {
    return this.command(
      request,
      ADMIN_PERMISSIONS.managePartners,
      async (tx) => {
        const accounts = await tx.adminAccount.findMany({
          where: { realm: this.realm, role: "partner", deletedAt: null },
          select: {
            id: true,
            username: true,
            disabled: true,
            passwordCiphertext: true,
          },
          orderBy: { username: "asc" },
        });
        return accounts.map(({ passwordCiphertext, ...account }) => ({
          ...account,
          passwordAvailable: !account.disabled && !!passwordCiphertext,
        }));
      },
      true,
    );
  }
  async createPartner(request: AdminRequest) {
    await this.authorized(request, ADMIN_PERMISSIONS.managePartners);
    this.assertCsrf(request);
    const id = randomUUID();
    const { password, ...credentials } = await this.generatePartnerPassword(id);
    return this.command(
      request,
      ADMIN_PERMISSIONS.managePartners,
      async (tx) => {
        const account = await tx.adminAccount.create({
          data: {
            id,
            username: `sales_${randomBytes(8).toString("hex")}`,
            realm: this.realm,
            role: "partner",
            ...credentials,
            permissions: [],
          },
          select: { id: true, username: true, disabled: true },
        });
        request.adminResourceType = "admin-account";
        request.adminResourceId = account.id;
        return { ...account, passwordAvailable: true, password };
      },
    );
  }
  async revokePartner(request: AdminRequest, id: string) {
    return this.disablePartner(request, id, { disabled: true });
  }
  async deletePartner(request: AdminRequest, id: string) {
    return this.disablePartner(request, id, {
      disabled: true,
      deletedAt: new Date(),
      passwordHash: null,
      passwordCiphertext: null,
    });
  }
  private async disablePartner(
    request: AdminRequest,
    id: string,
    data: Prisma.AdminAccountUpdateManyMutationInput,
  ) {
    return this.command(
      request,
      ADMIN_PERMISSIONS.managePartners,
      async (tx) => {
        // Account disable is checked by every session access. No account->session lock inversion with commands/login.
        const changed = await tx.adminAccount.updateMany({
          where: { id, realm: this.realm, role: "partner", deletedAt: null },
          data,
        });
        if (!changed.count) throw new NotFoundException();
        request.adminResourceType = "admin-account";
        request.adminResourceId = id;
        return { id, disabled: true };
      },
    );
  }
  private partnerPasswordKey() {
    return createHmac(
      "sha256",
      Buffer.from(this.settings().sessionKey, "base64"),
    )
      .update("timenook:partner-password:v1")
      .digest();
  }
  private async generatePartnerPassword(id: string) {
    const password = randomBytes(24).toString("base64url");
    const salt = randomBytes(16).toString("hex");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.partnerPasswordKey(), iv);
    cipher.setAAD(Buffer.from(id));
    const encrypted = Buffer.concat([
      cipher.update(password, "utf8"),
      cipher.final(),
    ]);
    return {
      password,
      passwordHash: `${salt}:${(await passwordKey(password, salt)).toString("hex")}`,
      passwordCiphertext: Buffer.concat([
        iv,
        cipher.getAuthTag(),
        encrypted,
      ]).toString("base64"),
    };
  }
  async partnerPassword(request: AdminRequest, id: string) {
    return this.command(
      request,
      ADMIN_PERMISSIONS.managePartners,
      async (tx) => {
        request.adminResourceType = "admin-account";
        request.adminResourceId = id;
        const account = await tx.adminAccount.findFirst({
          where: {
            id,
            realm: this.realm,
            role: "partner",
            disabled: false,
            deletedAt: null,
          },
          select: { username: true, passwordCiphertext: true },
        });
        if (!account) throw new NotFoundException();
        if (!account.passwordCiphertext)
          throw new HttpException("Partner password unavailable", 409);
        try {
          const stored = Buffer.from(account.passwordCiphertext, "base64");
          const decipher = createDecipheriv(
            "aes-256-gcm",
            this.partnerPasswordKey(),
            stored.subarray(0, 12),
          );
          decipher.setAAD(Buffer.from(id));
          decipher.setAuthTag(stored.subarray(12, 28));
          const password = Buffer.concat([
            decipher.update(stored.subarray(28)),
            decipher.final(),
          ]).toString("utf8");
          return {
            id,
            username: account.username,
            disabled: false,
            passwordAvailable: true,
            password,
          };
        } catch {
          throw new HttpException("Partner password unavailable", 409);
        }
      },
    );
  }
  async resetPartnerPassword(request: AdminRequest, id: string) {
    return this.command(
      request,
      ADMIN_PERMISSIONS.managePartners,
      async (tx) => {
        request.adminResourceType = "admin-account";
        request.adminResourceId = id;
        const where = {
          id,
          realm: this.realm,
          role: "partner",
          disabled: false,
          deletedAt: null,
        };
        const account = await tx.adminAccount.findFirst({
          where,
          select: { username: true },
        });
        if (!account) throw new NotFoundException();
        const { password, ...credentials } =
          await this.generatePartnerPassword(id);
        const changed = await tx.adminAccount.updateMany({
          where,
          data: credentials,
        });
        if (!changed.count) throw new NotFoundException();
        return {
          id,
          username: account.username,
          disabled: false,
          passwordAvailable: true,
          password,
        };
      },
    );
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
