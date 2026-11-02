import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Inject,
} from "@nestjs/common";
import { ApiCookieAuth, ApiTags } from "@nestjs/swagger";
import { Prisma } from "@prisma/client";
import type { FastifyRequest } from "fastify";
import { createHash, randomUUID } from "node:crypto";
import {
  ADMIN_PERMISSIONS,
  type AdminProjectSummary,
  type AdminUserDetail,
  type AdminProjectDetail,
  type AdminUserSummary,
  type AdminUsersPage,
} from "@timenook/contracts";
import { AdminAccess } from "./admin-access";
import { PaymentIdempotencyConflict } from "../payments/errors";
import { API_CONFIG, type ApiConfig } from "../config";
import { participationNotice } from "../catalog/e2e-package";

// The relationship includes requests and old bindings, so rebind does not hide a person's service history.
const related = (user: Prisma.Sql) =>
  Prisma.sql`(j.created_by=${user}::text OR s.bound_user_id=${user}::uuid OR EXISTS(SELECT 1 FROM care_requests c WHERE c.project_id=j.id AND (c.requester_id=${user}::uuid OR c.target_user_id=${user}::uuid)) OR EXISTS(SELECT 1 FROM binding_changes b WHERE b.project_id=j.id AND (b.from_user_id=${user}::uuid OR b.to_user_id=${user}::uuid)))`;
const pending = Prisma.sql`EXISTS(SELECT 1 FROM care_requests c WHERE c.project_id=j.id AND c.kind IN ('export','delete','withdraw','rebind','correction') AND c.state IN ('open','verified'))`;
const projectSelect = Prisma.sql`SELECT j.id,COALESCE(j.book_title,p.book_title) AS "bookTitle",j.created_by AS "initiatorUserId",s.id AS "subjectId",s.name AS "subjectName",s.bound_user_id AS "narratorUserId",COALESCE(s.binding_version,0) AS "bindingVersion",j.order_id AS "orderId",CASE WHEN j.order_id IS NOT NULL THEN 'payment' WHEN i.id IS NOT NULL THEN 'internal-acceptance' ELSE 'unlinked' END AS source,CASE WHEN j.order_id IS NULL THEN FALSE ELSE COALESCE((p.package_snapshot->>'physicalProduction')::boolean,FALSE) END AS "physicalProduction",${pending} AS pending FROM projects j LEFT JOIN project_subjects s ON s.project_id=j.id LEFT JOIN payment_orders p ON p.id=j.order_id LEFT JOIN internal_project_admissions i ON i.project_id=j.id`;
const requestSelect = {
  id: true,
  projectId: true,
  kind: true,
  state: true,
  createdAt: true,
} as const;
function integer(v: unknown, fallback: number, max: number) {
  if (v === undefined) return fallback;
  if (typeof v !== "string" || !/^\d+$/.test(v) || +v < 1 || +v > max)
    throw new BadRequestException();
  return +v;
}
@Controller("v1/admin/users")
@ApiTags("Admin users")
@ApiCookieAuth("timenook-admin")
export class AdminUsersController {
  constructor(
    private readonly access: AdminAccess,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}
  private run<T>(
    action: string,
    req: FastifyRequest,
    work: (tx: Prisma.TransactionClient) => Promise<T>,
    read = true,
  ) {
    return this.access.run(action, req, () =>
      this.access.command(
        req,
        ADMIN_PERMISSIONS.writeCare,
        async (tx) => ({ data: await work(tx), meta: { requestId: req.id } }),
        read,
      ),
    );
  }
  private resource(req: FastifyRequest, type: string, id: string) {
    Object.assign(req, { adminResourceType: type, adminResourceId: id });
  }
  @Get()
  @Header("Cache-Control", "no-store")
  list(@Req() req: FastifyRequest, @Query() query: Record<string, unknown>) {
    return this.run("users.list", req, async (tx) => {
      if (
        Object.keys(query).some(
          (k) => !["q", "pending", "page", "pageSize"].includes(k),
        ) ||
        (query.q !== undefined &&
          (typeof query.q !== "string" || query.q.length > 200)) ||
        (query.pending !== undefined &&
          !["true", "false"].includes(String(query.pending)))
      )
        throw new BadRequestException();
      const page = integer(query.page, 1, 1000000),
        pageSize = integer(query.pageSize, 20, 100);
      const q = typeof query.q === "string" ? query.q.trim() : "",
        search = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
      const projectMatch = Prisma.sql`(j.id::text ILIKE ${search} OR s.id::text ILIKE ${search} OR s.name ILIKE ${search} OR s.bound_user_id::text ILIKE ${search} OR j.book_title ILIKE ${search} OR p.book_title ILIKE ${search} OR p.subject_name ILIKE ${search} OR p.id::text ILIKE ${search} OR p.out_trade_no ILIKE ${search})`;
      const joins = Prisma.sql`FROM projects j LEFT JOIN project_subjects s ON s.project_id=j.id LEFT JOIN payment_orders p ON p.id=j.order_id`;
      const accountPending = Prisma.sql`EXISTS(SELECT 1 ${joins} WHERE ${related(Prisma.sql`u.id`)} AND ${pending})`;
      const accountSearch = q
        ? Prisma.sql`(u.id::text ILIKE ${search} OR EXISTS(SELECT 1 ${joins} WHERE ${related(Prisma.sql`u.id`)} AND ${projectMatch}) OR EXISTS(SELECT 1 FROM payment_orders o WHERE o.buyer_id=u.id AND (o.id::text ILIKE ${search} OR o.out_trade_no ILIKE ${search} OR o.subject_name ILIKE ${search} OR o.book_title ILIKE ${search})))`
        : Prisma.sql`TRUE`;
      const narratorSearch = q ? projectMatch : Prisma.sql`TRUE`;
      const base = Prisma.sql`WITH results AS (SELECT u.id,'account' AS kind,NULL::text AS name,NULL::uuid AS "projectId",u.created_at AS "createdAt",${accountPending} AS pending FROM users u WHERE ${accountSearch} UNION ALL SELECT s.id,'narrator' AS kind,s.name,j.id AS "projectId",COALESCE(i.created_at,p.created_at,'1970-01-01'::timestamptz) AS "createdAt",${pending} AS pending FROM project_subjects s JOIN projects j ON j.id=s.project_id LEFT JOIN payment_orders p ON p.id=j.order_id LEFT JOIN internal_project_admissions i ON i.project_id=j.id WHERE s.bound_user_id IS NULL AND ${narratorSearch})`;
      const filter =
        query.pending === undefined
          ? Prisma.sql`TRUE`
          : Prisma.sql`pending=${query.pending === "true"}`;
      const [count] = await tx.$queryRaw<
        { total: bigint }[]
      >`${base} SELECT count(*) AS total FROM results WHERE ${filter}`;
      const rows = await tx.$queryRaw<
        (Omit<AdminUserSummary, "createdAt"> & { createdAt: Date })[]
      >`${base} SELECT * FROM results WHERE ${filter} ORDER BY "createdAt" DESC,id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`;
      return {
        items: rows.map((r) => ({
          ...r,
          createdAt: r.createdAt.toISOString(),
        })),
        total: Number(count.total),
        page,
        pageSize,
      } satisfies AdminUsersPage;
    });
  }
  @Get("projects/:projectId")
  @Header("Cache-Control", "no-store")
  project(
    @Req() req: FastifyRequest,
    @Param("projectId", new ParseUUIDPipe()) id: string,
  ) {
    this.resource(req, "project", id);
    return this.run("users.project", req, async (tx) => {
      const [project] = await tx.$queryRaw<
        AdminProjectSummary[]
      >`${projectSelect} WHERE j.id=${id}::uuid`;
      if (!project) throw new NotFoundException();
      const [requests, productionOrder, history, order, internal] =
        await Promise.all([
          tx.careRequest.findMany({
            where: {
              projectId: id,
              kind: {
                in: ["export", "delete", "withdraw", "rebind", "correction"],
              },
            },
            select: requestSelect,
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          }),
          tx.firstCopyOrder.findFirst({
            where: { projectId: id },
            select: { id: true, state: true },
          }),
          tx.adminAudit.findMany({
            where: { resourceType: "project", resourceId: id },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: 100,
          }),
          project.orderId
            ? tx.paymentOrder.findUnique({
                where: { id: project.orderId },
                select: { packageSnapshot: true },
              })
            : null,
          tx.internalProjectAdmission.findUnique({
            where: { projectId: id },
            select: { snapshot: true },
          }),
        ]);
      const snapshot = (order?.packageSnapshot ??
        internal?.snapshot ??
        {}) as Prisma.JsonObject;
      const exportPolicy = (snapshot.admission as Prisma.JsonObject | undefined)
        ?.d08 as Prisma.JsonObject | undefined;
      const alternate = (
        exportPolicy?.withoutWechat as Prisma.JsonObject | undefined
      )?.export as Prisma.JsonObject | undefined;
      const exportAlternativeAvailable = !!(
        alternate?.identityVerificationRef &&
        alternate.confirmationChannelRef &&
        alternate.deliveryChannelRef &&
        alternate.neverDefaultToInitiator === true
      );
      return {
        ...project,
        exportAlternativeAvailable,
        requests: requests.map((r) => ({
          ...r,
          createdAt: r.createdAt.toISOString(),
        })),
        productionOrder,
        ...participationNotice(snapshot, !!this.config.acceptance),
        history: history.map((h) => ({
          ...h,
          createdAt: h.createdAt.toISOString(),
        })),
      } satisfies AdminProjectDetail;
    });
  }
  @Get(":id")
  @Header("Cache-Control", "no-store")
  read(
    @Req() req: FastifyRequest,
    @Param("id", new ParseUUIDPipe()) id: string,
  ) {
    this.resource(req, "user", id);
    return this.run("users.read", req, async (tx) => {
      const user = await tx.user.findUnique({
        where: { id },
        include: {
          identities: { select: { appId: true } },
          webLoginTickets: { select: { id: true }, take: 1 },
        },
      });
      if (!user) throw new NotFoundException();
      const projects = await tx.$queryRaw<
        AdminProjectSummary[]
      >`${projectSelect} WHERE ${related(Prisma.sql`${id}`)} ORDER BY j.id DESC`;
      const [orders, requests, notes, history] = await Promise.all([
        tx.paymentOrder.findMany({
          where: {
            OR: [
              { buyerId: id },
              {
                id: {
                  in: projects.flatMap((p) => (p.orderId ? [p.orderId] : [])),
                },
              },
            ],
          },
          select: { id: true, outTradeNo: true, state: true },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        }),
        tx.careRequest.findMany({
          where: {
            projectId: { in: projects.map((p) => p.id) },
            kind: {
              in: ["export", "delete", "withdraw", "rebind", "correction"],
            },
          },
          select: requestSelect,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        }),
        tx.adminUserNote.findMany({
          where: { userId: id },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        }),
        tx.adminAudit.findMany({
          where: { resourceType: "user", resourceId: id },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 100,
        }),
      ]);
      const operators = await tx.adminAccount.findMany({
        where: { id: { in: notes.map((n) => n.operatorId) } },
        select: { id: true, username: true },
      });
      return {
        id,
        createdAt: user.createdAt.toISOString(),
        loginMethods: [
          ...(user.identities.length ? ["微信"] : []),
          ...(user.webLoginTickets.length ? ["网页"] : []),
        ],
        projects,
        orders,
        requests: requests.map((r) => ({
          ...r,
          createdAt: r.createdAt.toISOString(),
        })),
        notes: notes.map((n) => ({
          id: n.id,
          content: n.content,
          operatorId: n.operatorId,
          operatorName:
            operators.find((o) => o.id === n.operatorId)?.username ??
            n.operatorId,
          createdAt: n.createdAt.toISOString(),
        })),
        history: history.map((h) => ({
          ...h,
          createdAt: h.createdAt.toISOString(),
        })),
      } satisfies AdminUserDetail;
    });
  }
  @Post(":id/notes")
  @Header("Cache-Control", "no-store")
  note(
    @Req() req: FastifyRequest,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
  ) {
    this.resource(req, "user", id);
    return this.run(
      "users.note",
      req,
      async (tx) => {
        const key = req.headers["idempotency-key"];
        if (
          typeof key !== "string" ||
          !/^[-A-Za-z0-9_:]{8,128}$/.test(key) ||
          !body ||
          typeof body !== "object" ||
          Array.isArray(body) ||
          Object.keys(body).some((k) => k !== "content")
        )
          throw new BadRequestException();
        const content = (body as { content?: unknown }).content;
        if (
          typeof content !== "string" ||
          !content.trim() ||
          content.trim().length > 2000
        )
          throw new BadRequestException();
        if (
          !(await tx.user.findUnique({ where: { id }, select: { id: true } }))
        )
          throw new NotFoundException();
        const operatorId = (req as FastifyRequest & { adminOperator: string })
            .adminOperator,
          hash = createHash("sha256").update(content.trim()).digest("hex");
        const old = await tx.adminUserNote.findUnique({
          where: { userId_operatorId_key: { userId: id, operatorId, key } },
        });
        if (old && old.requestHash !== hash)
          throw new PaymentIdempotencyConflict();
        const note =
          old ??
          (await tx.adminUserNote.create({
            data: {
              id: randomUUID(),
              userId: id,
              operatorId,
              key,
              content: content.trim(),
              requestHash: hash,
            },
          }));
        const operator = await tx.adminAccount.findUniqueOrThrow({
          where: { id: operatorId },
        });
        return {
          id: note.id,
          content: note.content,
          operatorId,
          operatorName: operator.username,
          createdAt: note.createdAt.toISOString(),
        };
      },
      false,
    );
  }
}
