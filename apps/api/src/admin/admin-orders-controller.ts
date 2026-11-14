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
} from "@nestjs/common";
import { ApiCookieAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Prisma } from "@prisma/client";
import type { FastifyRequest } from "fastify";
import { createHash, randomUUID } from "node:crypto";
import {
  ADMIN_PERMISSIONS,
  type AdminOrderDetail,
  type AdminOrderNote,
  type AdminOrderSummary,
  type AdminOrdersPage,
} from "@timenook/contracts";
import { AdminAccess } from "./admin-access";
import { PaymentIdempotencyConflict } from "../payments/errors";
import { adminOrderState } from "./order-state";

type SummaryRow = Omit<AdminOrderSummary, "createdAt"> & { createdAt: Date };
const pending = Prisma.sql`(EXISTS(SELECT 1 FROM refunds r WHERE r.order_id=p.id AND r.state NOT IN ('succeeded','closed','rejected')) OR EXISTS(SELECT 1 FROM quality_requests q WHERE q.order_id=p.id AND q.state NOT IN ('completed','rejected','cancelled')))`;
const summary = Prisma.sql`SELECT p.id, p.out_trade_no AS "outTradeNo",p.buyer_id AS "buyerId",j.id AS "projectId",s.id AS "subjectId",COALESCE(s.name,p.subject_name) AS "subjectName",s.bound_user_id AS "narratorUserId",COALESCE(j.book_title,p.book_title) AS "bookTitle",${adminOrderState} AS state,p.mode,p.is_e2e AS "isE2e",p.list_amount AS "listAmount",p.amount AS "payableAmount",CASE WHEN p.provider='channel' THEN p.amount ELSE COALESCE(t.amount,0)::int END AS "paidAmount",COALESCE((SELECT sum(amount) FROM refunds WHERE order_id=p.id AND state='succeeded'),0)::int AS "refundedAmount",p.currency,p.created_at AS "createdAt",${pending} AS pending FROM payment_orders p LEFT JOIN projects j ON j.order_id=p.id LEFT JOIN project_subjects s ON s.project_id=j.id LEFT JOIN payment_transactions t ON t.order_id=p.id`;
const serialize = (r: SummaryRow): AdminOrderSummary => ({
  ...r,
  createdAt: r.createdAt.toISOString(),
});
function integer(value: unknown, fallback: number, max: number) {
  if (value === undefined) return fallback;
  if (
    typeof value !== "string" ||
    !/^\d+$/.test(value) ||
    Number(value) < 1 ||
    Number(value) > max
  )
    throw new BadRequestException();
  return Number(value);
}
@Controller("v1/admin/orders")
@ApiTags("Admin orders")
@ApiCookieAuth("timenook-admin")
export class AdminOrdersController {
  constructor(private readonly access: AdminAccess) {}
  private run<T>(
    action: string,
    request: FastifyRequest,
    work: () => Promise<T>,
  ) {
    return this.access.run(action, request, async () => ({
      data: await work(),
      meta: { requestId: request.id },
    }));
  }
  private resource(request: FastifyRequest, id: string) {
    Object.assign(request, { adminResourceType: "order", adminResourceId: id });
  }
  @Header("Cache-Control", "no-store")
  @Get()
  @ApiOperation({
    summary:
      "orders:read: search all orders with stable pagination; money is in fen",
  })
  list(@Req() req: FastifyRequest, @Query() query: Record<string, unknown>) {
    return this.run("orders.list", req, () =>
      this.access.command(
        req,
        ADMIN_PERMISSIONS.readOrders,
        async (tx) => {
          if (
            Object.keys(query).some(
              (k) => !["q", "state", "pending", "page", "pageSize"].includes(k),
            )
          )
            throw new BadRequestException();
          const page = integer(query.page, 1, 1000000),
            pageSize = integer(query.pageSize, 20, 100);
          if (
            query.q !== undefined &&
            (typeof query.q !== "string" || query.q.length > 200)
          )
            throw new BadRequestException();
          if (
            query.state !== undefined &&
            ![
              "pending",
              "paid",
              "closed",
              "refunded",
              "partially_refunded",
            ].includes(String(query.state))
          )
            throw new BadRequestException();
          if (
            query.pending !== undefined &&
            !["true", "false"].includes(String(query.pending))
          )
            throw new BadRequestException();
          const q = typeof query.q === "string" ? query.q.trim() : "";
          const filters = [Prisma.sql`TRUE`];
          if (q) {
            const search = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
            filters.push(
              Prisma.sql`(p.out_trade_no ILIKE ${search} OR p.id::text ILIKE ${search} OR p.buyer_id::text ILIKE ${search} OR j.id::text ILIKE ${search} OR s.id::text ILIKE ${search} OR s.bound_user_id::text ILIKE ${search} OR s.name ILIKE ${search} OR p.subject_name ILIKE ${search} OR p.book_title ILIKE ${search} OR j.book_title ILIKE ${search})`,
            );
          }
          if (query.state)
            filters.push(Prisma.sql`${adminOrderState}=${String(query.state)}`);
          if (query.pending !== undefined)
            filters.push(Prisma.sql`${pending}=${query.pending === "true"}`);
          const where = Prisma.join(filters, " AND ");
          const [count] = await tx.$queryRaw<
            { total: bigint }[]
          >`SELECT count(*) AS total FROM payment_orders p LEFT JOIN projects j ON j.order_id=p.id LEFT JOIN project_subjects s ON s.project_id=j.id WHERE ${where}`;
          const rows = await tx.$queryRaw<
            SummaryRow[]
          >`${summary} WHERE ${where} ORDER BY p.created_at DESC,p.id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`;
          return {
            items: rows.map(serialize),
            total: Number(count.total),
            page,
            pageSize,
          } satisfies AdminOrdersPage;
        },
        true,
      ),
    );
  }
  private async detail(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<AdminOrderDetail> {
    const [row] = await tx.$queryRaw<
      SummaryRow[]
    >`${summary} WHERE p.id=${id}::uuid`;
    if (!row) throw new NotFoundException();
    const [
      payment,
      entitlement,
      productionOrder,
      refunds,
      qualityRequests,
      notes,
      history,
    ] = await Promise.all([
      tx.paymentTransaction.findUnique({ where: { orderId: id } }),
      tx.firstCopyEntitlement.findUnique({
        where: { orderId: id },
        select: { id: true, state: true },
      }),
      tx.firstCopyOrder.findUnique({
        where: { paymentOrderId: id },
        select: { id: true, state: true },
      }),
      tx.refund.findMany({
        where: { orderId: id },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: {
          id: true,
          caseId: true,
          state: true,
          amount: true,
          completedAt: true,
        },
      }),
      tx.qualityRequest.findMany({
        where: { orderId: id },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { id: true, caseId: true, state: true },
      }),
      tx.adminOrderNote.findMany({
        where: { orderId: id },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      }),
      tx.adminAudit.findMany({
        where: { resourceType: "order", resourceId: id },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 100,
      }),
    ]);
    const operators = await tx.adminAccount.findMany({
      where: { id: { in: notes.map((n) => n.operatorId) } },
      select: { id: true, username: true },
    });
    return {
      ...serialize(row),
      payment: payment
        ? {
            providerTransactionId: payment.providerTransactionId,
            paidAt: payment.paidAt.toISOString(),
            amount: payment.amount,
          }
        : null,
      entitlement,
      productionOrder,
      refunds: refunds.map((r) => ({
        ...r,
        completedAt: r.completedAt?.toISOString() ?? null,
      })),
      qualityRequests,
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
    };
  }
  @Header("Cache-Control", "no-store")
  @Get(":id")
  @ApiOperation({
    summary:
      "orders:read: payment, refund, entitlement and resource identities without private file access",
  })
  read(
    @Req() req: FastifyRequest,
    @Param("id", new ParseUUIDPipe()) id: string,
  ) {
    this.resource(req, id);
    return this.run("orders.read", req, () =>
      this.access.command(
        req,
        ADMIN_PERMISSIONS.readOrders,
        (tx) => this.detail(tx, id),
        true,
      ),
    );
  }
  @Header("Cache-Control", "no-store")
  @Post(":id/notes")
  @ApiOperation({
    summary:
      "orders:write: append an internal note once per operator/idempotency key, with transactional audit",
  })
  note(
    @Req() req: FastifyRequest,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
  ) {
    this.resource(req, id);
    return this.run("orders.note", req, () =>
      this.access.command(req, ADMIN_PERMISSIONS.writeOrders, async (tx) => {
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
          !(await tx.paymentOrder.findUnique({
            where: { id },
            select: { id: true },
          }))
        )
          throw new NotFoundException();
        const operatorId = (req as FastifyRequest & { adminOperator: string })
          .adminOperator;
        const hash = createHash("sha256").update(content.trim()).digest("hex");
        const old = await tx.adminOrderNote.findUnique({
          where: { orderId_operatorId_key: { orderId: id, operatorId, key } },
        });
        if (old && old.requestHash !== hash)
          throw new PaymentIdempotencyConflict();
        const note =
          old ??
          (await tx.adminOrderNote.create({
            data: {
              id: randomUUID(),
              orderId: id,
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
        } satisfies AdminOrderNote;
      }),
    );
  }
}
