import {
  Body,
  Controller,
  Get,
  Post,
  Param,
  ParseUUIDPipe,
  Req,
  Header,
  Injectable,
  Inject,
  Optional,
  OnModuleDestroy,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from "@nestjs/common";
import {
  ApiProperty,
  ApiTags,
  ApiBearerAuth,
  ApiCookieAuth,
  ApiHeader,
} from "@nestjs/swagger";
import { IsIn, Matches, IsISO8601, IsOptional } from "class-validator";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyRequest } from "fastify";
import type { DeletionStatus, DeletionItemView } from "@timenook/contracts";
import { ADMIN_PERMISSIONS } from "@timenook/contracts";
import { API_CONFIG, ApiConfig } from "../config";
import { AdminAccess } from "../admin/admin-access";
import { IdentityAccess } from "../identity/identity-access";
import { Participation } from "../identity/participation";
import { ProjectServiceTerms } from "../projects/service-terms";
import { idempotencyKey } from "../payments/orders";
import type { ProbeObjects } from "../probe/local-objects";
import { probeStorageScope } from "../probe/storage-scope";
import { createHash } from "node:crypto";
import {
  PrivacyRights,
  type DeletionPayload,
  type PrivateFileTarget,
} from "./privacy-rights";
import { ERASURE_REGISTRY } from "./erasure-registry";
export const DELETION_OBJECTS = Symbol("DELETION_OBJECTS");
class EvidenceDto {
  @ApiProperty({ enum: ["confirmed", "pending"] })
  @IsIn(["confirmed", "pending"])
  state!: "confirmed" | "pending";
  @ApiProperty({ pattern: "^record:synthetic-" })
  @Matches(/^record:synthetic-[-A-Za-z0-9_:]{3,120}$/)
  evidenceRef!: string;
  @ApiProperty({ required: false })
  @IsOptional()
  @IsISO8601()
  deadline?: string;
}
type Item = {
  id: string;
  event_id: string;
  project_id: string;
  category: string;
  layer: string;
  target_table: string | null;
  target_key: Record<string, unknown> | null;
  target_columns: string[] | null;
  locator: { targets?: PrivateFileTarget[] };
  state: string;
  deadline: Date | null;
  completed_at: Date | null;
  reason: string | null;
  evidence_ref: string | null;
};
@Injectable()
export class Deletions implements OnModuleDestroy {
  private readonly terms: ProjectServiceTerms;
  private running?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly rights: PrivacyRights,
    private readonly identity: IdentityAccess,
    private readonly participation: Participation,
    @Optional()
    @Inject(DELETION_OBJECTS)
    private readonly objects?: ProbeObjects,
  ) {
    this.terms = new ProjectServiceTerms(config.databaseUrl);
  }
  async sweep(at = new Date()) {
    await this.rights.assertHealthy();
    if (this.running) return this.running;
    this.running = (async () => {
      await this.scanRetention(at);
      await this.participation.reconcileRevocations();
      const events = await this.rights.db.$queryRaw<
        { project_id: string }[]
      >`SELECT DISTINCT project_id FROM privacy_deletions`;
      for (const e of events) await this.reconcile(e.project_id);
    })().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  onModuleInit() {
    if (this.rights.enabled) {
      this.timer = setInterval(() => {
        void this.sweep().catch(() => {});
      }, 1000);
      this.timer.unref();
    }
  }
  async scanRetention(at = new Date()) {
    // The selected fixed D03 rules retain their original anchor. D02/refunds never create these events.
    let cursor: string | undefined;
    for (;;) {
      const projects = await this.rights.db.projectServiceTerms.findMany({
        take: 100,
        orderBy: { projectId: "asc" },
        ...(cursor ? { cursor: { projectId: cursor }, skip: 1 } : {}),
      });
      if (!projects.length) break;
      for (const p of projects) {
        const terms = await this.terms.read(p.projectId, at);
        if (!terms.retention) continue;
        for (const [category, value] of Object.entries(terms.retention)) {
          if (
            value.state !== "expired" ||
            !value.expiresAt ||
            Date.parse(value.expiresAt) > at.getTime()
          )
            continue;
          if (
            ![
              "originalAudio",
              "originalPhotos",
              "derivedAudio",
              "derivedPhotos",
              "transcripts",
              "confirmedStories",
              "bookPdf",
              "exportPackages",
              "activeData",
              "historicalObjects",
              "backupCopies",
              "supplierCopies",
            ].includes(category)
          )
            throw new Error("Unknown D03 retention category");
          await this.rights.db.$transaction(
            async (tx) => {
              await tx.$queryRaw`SELECT id FROM projects WHERE id=${p.projectId}::uuid FOR UPDATE`;
              const prior = await tx.$queryRaw<
                { id: string }[]
              >`SELECT id FROM privacy_deletions WHERE project_id=${p.projectId}::uuid AND categories ? ${category}`;
              if (prior.length) return;
              const project = await tx.project.findUniqueOrThrow({
                where: { id: p.projectId },
              });
              const rule = (p.policy as any).d03.retention[category];
              const payload: DeletionPayload = {
                operation: "erase",
                requestId: null,
                trigger: "retention_expiry",
                categories: [category],
                effectiveAt: value.expiresAt!,
                deadlines: {
                  active_database: value.expiresAt!,
                  active_files: value.expiresAt!,
                  cache: value.expiresAt!,
                },
                accessEpoch: project.accessEpoch,
                targets: await this.rights.fileTargetsIn(tx, p.projectId, [
                  category,
                ]),
                rule: {
                  anchor: value.startsAt,
                  startsAt: rule.startsAt,
                  duration: rule.duration,
                  policyVersion: p.packageVersionId,
                },
                taskFences: [],
                targetAttemptId: null,
              };
              await this.rights.publishIn(tx, {
                eventId: randomUUID(),
                projectId: p.projectId,
                kind: "deletion",
                occurredAt: new Date().toISOString(),
                payload: payload as unknown as Record<string, unknown>,
              });
            },
            { timeout: 30000 },
          );
        }
      }
      cursor = projects[projects.length - 1].projectId;
    }
  }
  async reconcile(projectId: string) {
    const items = await this.rights.db.$queryRaw<
      Item[]
    >`SELECT * FROM privacy_deletion_items WHERE project_id=${projectId}::uuid ORDER BY CASE layer WHEN 'active_database' THEN 1 WHEN 'cache' THEN 2 ELSE 3 END,id`;
    for (const item of items) {
      if (
        !["active_database", "active_files", "cache"].includes(item.layer) ||
        (item.state === "completed" && item.layer !== "active_files")
      )
        continue;
      try {
        if (item.layer === "active_database") await this.erase(item);
        else if (item.layer === "active_files") {
          for (const target of item.locator.targets || [])
            await this.remove(target);
        }
        // Redis stores only rate counters. Payment capability caches live in registered PG payload columns;
        // client cache eviction follows the user's permanent status fence.
        await this.rights.db
          .$executeRaw`UPDATE privacy_deletion_items SET state='completed',completed_at=COALESCE(completed_at,now()),reason=${item.layer === "active_files" && !item.locator.targets?.length ? "NO_PLATFORM_TARGETS" : null} WHERE id=${item.id}::uuid`;
      } catch {
        await this.rights.db
          .$executeRaw`UPDATE privacy_deletion_items SET state='pending',completed_at=NULL,reason='RETRY_REQUIRED' WHERE id=${item.id}::uuid`;
      }
    }
  }
  private async erase(item: Item) {
    const entry = ERASURE_REGISTRY.find(
      (e) => e.table === item.target_table && e.category === item.category,
    );
    if (
      !entry ||
      !item.target_key ||
      !item.target_columns ||
      item.target_columns.some(
        (c) => !(entry.columns as readonly string[]).includes(c),
      )
    )
      throw new Error("Unknown erasure target");
    const columns = item.target_columns;
    // Scope and exact PK are rechecked by SQL's existing immutable and privacy guards.
    await this.rights.db.$executeRawUnsafe(
      `UPDATE "${entry.table}" r SET ${columns.map((c) => `"${c}"=NULL`).join(",")},privacy_erased_columns=ARRAY(SELECT DISTINCT unnest(privacy_erased_columns || $2::text[])) WHERE privacy_row_key('${entry.table}',to_jsonb(r))=$1::jsonb AND ${entry.owner}=$3::uuid AND ${"filter" in entry ? entry.filter : "true"}`,
      JSON.stringify(item.target_key),
      columns,
      item.project_id,
    );
  }
  private async remove(target: PrivateFileTarget) {
    if (target.kind === "object") {
      const scope = this.config.recording
        ? createHash("sha256")
            .update(`product:${probeStorageScope(this.config.recording)}`)
            .digest("hex")
        : null;
      if (!this.objects || scope !== target.scope)
        throw new Error("Storage scope is unresolved");
      await this.objects.remove(target.key);
      return;
    }
    if (target.kind === "temporary") {
      if (
        !this.config.recording ||
        target.scope !== this.config.recording.storageRoot ||
        !/^[-a-f0-9]{36}$/.test(target.key)
      )
        throw new Error("Unknown temporary owner");
      await rm(join(target.scope, ".privacy-runs", target.key), {
        recursive: true,
        force: true,
      });
      return;
    }
    if (
      !this.config.books ||
      target.scope !== this.config.books.storageRoot ||
      !/^[-a-f0-9]{36}$/.test(target.key)
    )
      throw new Error("Unknown book/export owner");
    if (target.kind === "book_directory")
      await rm(join(target.scope, target.key), {
        recursive: true,
        force: true,
      });
    else if (target.kind === "export") {
      const directory = join(target.scope, "exports");
      let files: string[] = [];
      try {
        files = await readdir(directory);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      for (const file of files)
        if (new RegExp(`^${target.key}-[0-9]+\\.zip$`).test(file))
          await rm(join(directory, file), { force: true });
    } else throw new Error("Unknown private file target");
  }
  private async participant(projectId: string, authorization?: string) {
    const user = await this.identity.current(authorization);
    const p = await this.rights.db.project.findUnique({
      where: { id: projectId },
    });
    const subject = await this.rights.db.projectSubject.findUnique({
      where: { projectId },
    });
    const order = p?.orderId
      ? await this.rights.db.paymentOrder.findUnique({
          where: { id: p.orderId },
          select: { buyerId: true },
        })
      : null;
    if (!p || !subject || !order) throw new NotFoundException();
    if (user.id !== order.buyerId && user.id !== subject.boundUserId)
      throw new ForbiddenException();
  }
  async userStatus(projectId: string, authorization?: string) {
    await this.participant(projectId, authorization);
    await this.reconcile(projectId);
    return this.status(projectId);
  }
  async caseProject(caseId: string) {
    const care = await this.rights.db.careRequest.findUnique({
      where: { id: caseId },
    });
    if (!care || care.kind !== "delete") throw new NotFoundException();
    return care.projectId;
  }
  async status(projectId: string): Promise<DeletionStatus> {
    const project = await this.rights.db.project.findUnique({
      where: { id: projectId },
    });
    if (!project) throw new NotFoundException();
    const events = await this.rights.db.$queryRaw<
      {
        id: string;
        request_id: string | null;
        trigger: "verified_request" | "retention_expiry";
        categories: string[];
        effective_at: Date;
        created_at: Date;
      }[]
    >`SELECT * FROM privacy_deletions WHERE project_id=${projectId}::uuid ORDER BY effective_at,id`;
    const items = await this.rights.db.$queryRaw<
      Item[]
    >`SELECT * FROM privacy_deletion_items WHERE project_id=${projectId}::uuid ORDER BY layer,category,id`;
    const permanent = events.some((e) => e.categories.includes("all"));
    return {
      projectId,
      onlineAccessStopped: permanent,
      permanentProjectDeletion: permanent,
      accessEpoch: project.accessEpoch,
      changes: events.map((e) => ({
        id: e.id,
        requestId: e.request_id,
        trigger: e.trigger,
        categories: e.categories,
        effectiveAt: e.effective_at.toISOString(),
        createdAt: e.created_at.toISOString(),
        items: items
          .filter((i) => i.event_id === e.id)
          .map((i) => ({
            id: i.id,
            category: i.category,
            layer: i.layer as DeletionItemView["layer"],
            state: i.state as DeletionItemView["state"],
            deadline: i.deadline?.toISOString() || null,
            completedAt: i.completed_at?.toISOString() || null,
            reason: i.reason,
            evidenceRef: i.evidence_ref,
          })),
      })),
      boundary:
        "已传输到设备、已交付导出与纸书不能由平台收回；供应商与备份按各自证据处理。",
    };
  }
  async commandIn(
    tx: Prisma.TransactionClient,
    caseId: string,
    actorId: string,
    action: string,
    key: string,
    payload: unknown,
  ) {
    const projectId = await this.caseProject(caseId),
      hash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    const prior = await tx.$queryRaw<
      { request_hash: string }[]
    >`SELECT request_hash FROM privacy_item_commands WHERE case_id=${caseId}::uuid AND actor_id=${actorId}::uuid AND action=${action} AND key=${key}`;
    if (prior.length) {
      if (prior[0].request_hash !== hash) throw new ConflictException();
      return false;
    }
    await tx.$executeRaw`INSERT INTO privacy_item_commands(project_id,case_id,actor_id,action,key,request_hash) VALUES(${projectId}::uuid,${caseId}::uuid,${actorId}::uuid,${action},${key},${hash})`;
    return true;
  }
  async evidenceIn(
    tx: Prisma.TransactionClient,
    caseId: string,
    itemId: string,
    body: EvidenceDto,
  ) {
    const projectId = await this.caseProject(caseId);
    await tx.$queryRaw`SELECT id FROM projects WHERE id=${projectId}::uuid FOR UPDATE`;
    const items = await tx.$queryRaw<
      Item[]
    >`SELECT * FROM privacy_deletion_items WHERE id=${itemId}::uuid AND project_id=${projectId}::uuid FOR UPDATE`;
    const item = items[0];
    if (!item || !["object_history", "backup", "supplier"].includes(item.layer))
      throw new BadRequestException();
    if (
      body.deadline &&
      (!item.deadline ||
        new Date(body.deadline).getTime() !== item.deadline.getTime())
    )
      throw new ConflictException(
        "A receipt cannot establish or extend an unfrozen deadline",
      );
    await tx.$executeRaw`UPDATE privacy_deletion_items SET state=${body.state === "confirmed" ? "completed" : "awaiting_evidence"},evidence_ref=${body.evidenceRef},completed_at=${body.state === "confirmed" ? new Date() : null},reason=${body.state === "confirmed" ? null : "EXTERNAL_RECEIPT_REQUIRED"} WHERE id=${itemId}::uuid`;
  }
  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.terms.close();
  }
}
@Controller("v1/projects/:id/deletion-status")
@ApiTags("Deletion")
@ApiBearerAuth()
export class DeletionController {
  constructor(private readonly deletions: Deletions) {}
  @Get() @Header("Cache-Control", "no-store") async read(
    @Param("id", ParseUUIDPipe) id: string,
    @Req() r: FastifyRequest,
  ) {
    return {
      data: await this.deletions.userStatus(id, r.headers.authorization),
      meta: { requestId: r.id },
    };
  }
}
@Controller("v1/admin/care-requests/:id")
@ApiTags("Deletion care")
@ApiCookieAuth("timenook-admin")
export class AdminDeletionController {
  constructor(
    private readonly access: AdminAccess,
    private readonly deletions: Deletions,
  ) {}
  private async command(
    r: FastifyRequest,
    caseId: string,
    action: string,
    payload: unknown,
    work: (tx: Prisma.TransactionClient) => Promise<unknown>,
  ) {
    const actor = await this.access.authorized(r, ADMIN_PERMISSIONS.writeCare);
    return this.access.command(r, ADMIN_PERMISSIONS.writeCare, async (tx) => {
      const projectId = await this.deletions.caseProject(caseId);
      await tx.$queryRaw`SELECT id FROM projects WHERE id=${projectId}::uuid FOR UPDATE`;
      if (
        await this.deletions.commandIn(
          tx,
          caseId,
          actor.adminId!,
          action,
          idempotencyKey(r),
          payload,
        )
      )
        return work(tx);
    });
  }
  @Get("deletion-status") @Header("Cache-Control", "no-store") async read(
    @Param("id", ParseUUIDPipe) id: string,
    @Req() r: FastifyRequest,
  ) {
    return {
      data: await this.access.run("deletion.read", r, async () => {
        await this.access.authorized(r, ADMIN_PERMISSIONS.writeCare);
        return this.deletions.status(await this.deletions.caseProject(id));
      }),
      meta: { requestId: r.id },
    };
  }
  @Post("deletion/reconcile")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @Header("Cache-Control", "no-store")
  async reconcile(
    @Param("id", ParseUUIDPipe) id: string,
    @Req() r: FastifyRequest,
  ) {
    return {
      data: await this.access.run("deletion.reconcile", r, async () => {
        await this.command(r, id, "reconcile", {}, async () => {});
        const p = await this.deletions.caseProject(id);
        await this.deletions.reconcile(p);
        return this.deletions.status(p);
      }),
      meta: { requestId: r.id },
    };
  }
  @Post("deletion/items/:itemId/evidence")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @Header("Cache-Control", "no-store")
  async evidence(
    @Param("id", ParseUUIDPipe) id: string,
    @Param("itemId", ParseUUIDPipe) itemId: string,
    @Body() body: EvidenceDto,
    @Req() r: FastifyRequest,
  ) {
    return {
      data: await this.access.run("deletion.evidence", r, async () => {
        await this.command(r, id, `evidence:${itemId}`, body, (tx) =>
          this.deletions.evidenceIn(tx, id, itemId, body),
        );
        return this.deletions.status(await this.deletions.caseProject(id));
      }),
      meta: { requestId: r.id },
    };
  }
}
