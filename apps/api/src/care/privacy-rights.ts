import { importLegacyPrivacy } from "./privacy-legacy";
import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnApplicationShutdown,
  ForbiddenException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Prisma, PrismaClient } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { API_CONFIG, ApiConfig } from "../config";
import {
  PrivacyJournal,
  type JournalEvent,
  type PublishedPrivacyEvent,
} from "../privacy-journal/privacy-journal";
import { ERASURE_REGISTRY } from "./erasure-registry";
export const privacyAuthorityId = (
  databaseUrl: string,
  installation: string,
) => {
  const u = new URL(databaseUrl);
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        u.protocol,
        u.hostname.toLowerCase(),
        u.port || "5432",
        u.pathname,
        u.searchParams.get("schema") || "public",
        installation,
      ]),
    )
    .digest("hex")
    .slice(0, 32);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20)}`;
};
export type PrivateFileTarget = {
  kind: "object" | "book_directory" | "export" | "temporary" | "temporary_file";
  category: string;
  scope: string;
  key: string;
};
export type DeletionPayload = {
  operation: "erase";
  requestId: string | null;
  scopedExportId?: string;
  trigger: "verified_request" | "retention_expiry";
  categories: string[];
  effectiveAt: string;
  accessEpoch: number;
  targets: PrivateFileTarget[];
  rule?: unknown;
  taskFences: { id: string; fence: number }[];
  targetAttemptId: string | null;
  deadlines?: Record<string, string | null>;
};
@Injectable()
export class PrivacyRights implements OnModuleDestroy, OnApplicationShutdown {
  readonly db: PrismaClient;
  private journal?: PrivacyJournal;
  private syncing?: Promise<void>;
  private failed = false;
  constructor(@Inject(API_CONFIG) readonly config: ApiConfig) {
    this.db = new PrismaClient({ datasourceUrl: config.databaseUrl });
  }
  get enabled() {
    return !!this.config.privacyJournal;
  }
  private async validateStorageSeparation() {
    if (!this.config.privacyJournal)
      throw new Error("Independent privacy source required");
    const canonical = async (path: string): Promise<string> => {
      const absolute = resolve(path);
      try {
        return await realpath(absolute);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return join(await canonical(dirname(absolute)), basename(absolute));
      }
    };
    const source = await canonical(this.config.privacyJournal.root);
    const contains = (parent: string, child: string) => {
      const path = relative(parent, child);
      return (
        path === "" ||
        (path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path))
      );
    };
    for (const configured of [
      this.config.books?.storageRoot,
      this.config.recording?.storageRoot,
      this.config.audioProbe?.storageRoot,
    ]) {
      if (!configured) continue;
      const storage = await canonical(configured);
      if (contains(storage, source) || contains(source, storage))
        throw new Error(
          "Independent privacy source must be separate from business storage roots",
        );
    }
  }
  async initialize() {
    if (!this.enabled) return;
    await this.validateStorageSeparation();
    const rows = await this.db.$queryRaw<
      { database_id: string; authority_generation: number }[]
    >`SELECT database_id,authority_generation FROM privacy_recovery_state WHERE singleton`;
    if (rows.length !== 1)
      throw new Error("Privacy recovery installation is missing");
    this.journal = new PrivacyJournal({
      ...this.config.privacyJournal!,
      expectedAuthority: {
        databaseId: privacyAuthorityId(
          this.config.databaseUrl,
          rows[0].database_id,
        ),
        generation: rows[0].authority_generation,
      },
    });
    await this.synchronize();
    await importLegacyPrivacy(this);
    await this.synchronize();
  }
  async replayOnly() {
    if (!this.config.privacyJournal)
      throw new Error("Independent source required");
    await this.validateStorageSeparation();
    this.journal = new PrivacyJournal(this.config.privacyJournal);
    await this.synchronize();
  }
  async assertHealthy() {
    if (!this.journal || this.failed)
      throw new ServiceUnavailableException(
        "Privacy recovery has not opened private capabilities",
      );
    try {
      await this.journal.assertHealthy();
      await this.synchronize();
    } catch {
      this.failed = true;
      throw new ServiceUnavailableException(
        "Privacy recovery integrity requires attention",
      );
    }
  }
  /** Integrity/checkpoint check usable inside a caller's project transaction.
   * It never starts replay or waits for another transaction holding that project. */
  async assertReplayed(projectId?: string) {
    if (!this.journal || this.failed) throw new ServiceUnavailableException();
    let snapshot;
    try {
      snapshot = await this.journal.snapshot();
    } catch {
      this.failed = true;
      throw new ServiceUnavailableException(
        "Independent source integrity requires attention",
      );
    }
    const [state] = await this.db.$queryRaw<
      {
        source_id: string | null;
        checkpoint_generation: bigint;
        checkpoint_hash: string | null;
      }[]
    >`SELECT source_id,checkpoint_generation,checkpoint_hash FROM privacy_recovery_state WHERE singleton`;
    // Another project can publish and commit after our snapshot releases flock.
    // Re-read the authenticated head before treating a newer DB receipt as rollback.
    if (state && Number(state.checkpoint_generation) > snapshot.generation) {
      try {
        snapshot = await this.journal.snapshot();
      } catch {
        this.failed = true;
        throw new ServiceUnavailableException(
          "Independent source integrity requires attention",
        );
      }
    }
    const checkpoint = Number(state?.checkpoint_generation);
    const prefix =
      checkpoint === 0 ? "0".repeat(64) : snapshot.events[checkpoint - 1]?.hash;
    if (
      !state ||
      state.source_id !== snapshot.sourceId ||
      !Number.isSafeInteger(checkpoint) ||
      checkpoint < 0 ||
      checkpoint > snapshot.generation ||
      state.checkpoint_hash !== prefix
    ) {
      this.failed = true;
      throw new ServiceUnavailableException(
        "Independent source checkpoint conflicts",
      );
    }
    if (checkpoint === snapshot.generation) return;
    if (projectId) {
      // A caller may already hold its project lock. Never start nested replay.
      // A different project's uncommitted PG receipt cannot change this scope;
      // our own suffix must have authenticated, atomically committed receipts.
      const scopeId = projectId.toLowerCase();
      const pending = snapshot.events
        .slice(checkpoint)
        .filter((e) => e.projectId.toLowerCase() === scopeId);
      const receipts = pending.length
        ? await this.db.$queryRaw<
            { id: string; hash: string; generation: bigint }[]
          >`SELECT id,hash,generation FROM privacy_events WHERE source_id=${snapshot.sourceId}::uuid AND project_id=${scopeId}::uuid AND generation>${BigInt(checkpoint)}`
        : [];
      const committed = new Map(receipts.map((r) => [r.id, r]));
      for (const event of pending) {
        const receipt = committed.get(event.eventId);
        if (!receipt)
          throw new ServiceUnavailableException(
            "Independent source replay is pending",
          );
        if (
          receipt.hash !== event.hash ||
          Number(receipt.generation) !== event.generation
        ) {
          this.failed = true;
          throw new ServiceUnavailableException(
            "Independent source receipt conflicts",
          );
        }
      }
      return;
    }
    throw new ServiceUnavailableException(
      "Independent source replay is pending",
    );
  }
  async synchronize() {
    if (!this.journal) throw new Error("Privacy journal is not configured");
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      for (;;) {
        const snapshot = await this.journal!.snapshot();
        const [binding] = await this.db.$queryRaw<
          {
            source_id: string | null;
            checkpoint_generation: bigint;
            checkpoint_hash: string | null;
          }[]
        >`SELECT source_id,checkpoint_generation,checkpoint_hash FROM privacy_recovery_state WHERE singleton`;
        if (!binding)
          throw new Error("Privacy recovery installation is missing");
        if (binding.source_id && binding.source_id !== snapshot.sourceId)
          throw new Error("Independent source identity changed");
        const checkpoint = Number(binding.checkpoint_generation);
        if (
          !Number.isSafeInteger(checkpoint) ||
          checkpoint < 0 ||
          (!binding.source_id && checkpoint !== 0)
        )
          throw new Error("Invalid privacy checkpoint");
        if (checkpoint > snapshot.generation) {
          const latest = await this.journal!.snapshot();
          if (latest.generation >= checkpoint) continue;
          throw new Error("Independent source is behind durable checkpoint");
        }
        const prefix =
          checkpoint === 0
            ? "0".repeat(64)
            : snapshot.events[checkpoint - 1]?.hash;
        if (
          (binding.checkpoint_hash !== null &&
            binding.checkpoint_hash !== prefix) ||
          (checkpoint > 0 && !binding.checkpoint_hash)
        )
          throw new Error(
            "Independent source disagrees with durable checkpoint",
          );
        const receipts = await this.db.$queryRaw<
          { id: string; hash: string; source_id: string; generation: bigint }[]
        >`SELECT id,hash,source_id,generation FROM privacy_events WHERE source_id=${snapshot.sourceId}::uuid`;
        const projected = new Map(receipts.map((r) => [r.id, r]));
        for (const event of snapshot.events) {
          const receipt = projected.get(event.eventId);
          if (receipt) {
            if (
              receipt.hash !== event.hash ||
              Number(receipt.generation) !== event.generation
            )
              throw new Error("Privacy receipt conflicts with source");
            continue;
          }

          await this.db.$transaction(
            async (tx) => {
              await tx.$queryRaw`SELECT id FROM projects WHERE id=${event.projectId}::uuid FOR UPDATE`;
              await this.projectIn(tx, event);
              await this.advanceCheckpointIn(tx, event.sourceId);
            },
            { timeout: 30000 },
          );
        }
        if (!binding.source_id || checkpoint < snapshot.generation)
          await this.db.$transaction((tx) =>
            this.advanceCheckpointIn(tx, snapshot.sourceId),
          );
        const after = await this.journal!.snapshot();
        if (
          after.generation === snapshot.generation &&
          after.hash === snapshot.hash
        )
          return;
      }
    })().finally(() => {
      this.syncing = undefined;
    });
    return this.syncing;
  }
  async publishIn(tx: Prisma.TransactionClient, event: JournalEvent) {
    if (!this.journal)
      throw new ServiceUnavailableException(
        "Independent privacy source is required",
      );
    const published = await this.journal.append(event);
    await this.projectIn(tx, published);
    await this.advanceCheckpointIn(tx, published.sourceId);
    return published;
  }
  private async advanceCheckpointIn(
    tx: Prisma.TransactionClient,
    sourceId: string,
  ) {
    const [current] = await tx.$queryRaw<
      { source_id: string | null; checkpoint_generation: bigint }[]
    >`SELECT source_id,checkpoint_generation FROM privacy_recovery_state WHERE singleton FOR UPDATE`;
    if (!current || (current.source_id && current.source_id !== sourceId))
      throw new Error("Privacy checkpoint source conflicts");
    let generation = Number(current.checkpoint_generation),
      hash = generation === 0 ? "0".repeat(64) : null;
    const rows = await tx.$queryRaw<
      { generation: bigint; hash: string }[]
    >`SELECT generation,hash FROM privacy_events WHERE source_id=${sourceId}::uuid AND generation>${BigInt(generation)} ORDER BY generation`;
    for (const row of rows) {
      if (Number(row.generation) !== generation + 1) break;
      generation++;
      hash = row.hash;
    }
    if (hash !== null)
      await tx.$executeRaw`UPDATE privacy_recovery_state SET source_id=${sourceId}::uuid,checkpoint_generation=${BigInt(generation)},checkpoint_hash=${hash} WHERE singleton`;
  }
  async projectIn(tx: Prisma.TransactionClient, event: PublishedPrivacyEvent) {
    const existing = await tx.$queryRaw<
      { hash: string }[]
    >`SELECT hash FROM privacy_events WHERE id=${event.eventId}::uuid`;
    if (existing.length) {
      if (existing[0].hash !== event.hash)
        throw new Error("Privacy event projection conflicts");
      return;
    }
    if (!(await tx.project.findUnique({ where: { id: event.projectId } })))
      throw new Error(
        "Independent privacy event target is absent; recovery remains closed",
      );
    if (
      !event.payload ||
      ![
        "revoke",
        "erase",
        "story_decision",
        "assisted_session_end",
        "legacy_hold",
      ].includes(String(event.payload.operation))
    )
      throw new Error("Unknown privacy event operation");
    await tx.$executeRaw`INSERT INTO privacy_events(id,project_id,kind,source_id,generation,hash,payload,occurred_at) VALUES(${event.eventId}::uuid,${event.projectId}::uuid,${event.kind},${event.sourceId}::uuid,${BigInt(event.generation)},${event.hash},${JSON.stringify(event.payload)}::jsonb,${new Date(event.occurredAt)})`;
    if (event.payload.operation === "legacy_hold") {
      await this.holdIn(tx, event, String(event.payload.reason));
      if (event.payload.permanentDeletion === true) {
        await tx.$executeRaw`INSERT INTO privacy_deletions(id,project_id,request_id,trigger,categories,effective_at) VALUES(${event.eventId}::uuid,${event.projectId}::uuid,${String(event.payload.requestId)}::uuid,'verified_request','["all"]'::jsonb,${new Date(String(event.payload.effectiveAt))})`;
        for (const [layer, category] of [
          ["active_database", "activeData"],
          ["active_files", "activeData"],
          ["cache", "activeData"],
          ["object_history", "historicalObjects"],
          ["backup", "backupCopies"],
          ["supplier", "supplierCopies"],
        ])
          await this.itemIn(
            tx,
            event,
            layer,
            category,
            {},
            "awaiting_evidence",
            "LEGACY_SCOPE_REVIEW_REQUIRED",
          );
      }
      return;
    }
    if (event.payload.operation === "story_decision") {
      const d = event.payload
        .decision as Prisma.StoryDecisionUncheckedCreateInput;
      if (
        !d ||
        d.projectId !== event.projectId ||
        (d.confirmed && d.allowInBook)
      )
        throw new Error("Invalid exact story denial");
      const actual = await tx.storyDecision.findUnique({ where: { id: d.id } });
      if (actual) {
        for (const field of [
          "projectId",
          "storyId",
          "revisionId",
          "contentHash",
          "subjectId",
          "operatorUserId",
          "bindingVersion",
          "accessEpoch",
          "confirmed",
          "allowInBook",
        ] as const)
          if (actual[field] !== d[field])
            throw new Error("Original story denial conflicts with source");
        return;
      }
      if ((await this.recoveryHoldsIn(tx, event.projectId)).length) {
        await this.holdIn(tx, event, "STORY_DENIAL_TARGET_REVIEW_REQUIRED");
        return;
      }
      const basis = d.confirmed
        ? await tx.storyDecision.findFirst({
            where: {
              projectId: event.projectId,
              revisionId: d.revisionId,
              subjectId: d.subjectId,
              contentHash: d.contentHash,
              bindingVersion: d.bindingVersion,
              accessEpoch: d.accessEpoch,
              confirmed: true,
              method: { not: "journal_denial" },
            },
          })
        : true;
      if (!basis) {
        await this.holdIn(
          tx,
          event,
          "STORY_CONFIRMATION_BASIS_REVIEW_REQUIRED",
        );
        return;
      }
      await tx.storyDecision.upsert({
        where: { id: d.id },
        create: {
          ...d,
          method: "journal_denial",
          assistedEvidenceId: null,
          evidenceRef: `journal:${event.hash}`,
          createdAt: new Date(event.occurredAt),
        },
        update: {},
      });
      return;
    }
    const p = event.payload;
    if (p.operation === "assisted_session_end") {
      if (typeof p.sourceSessionId !== "string")
        throw new Error("Invalid assisted session denial");
      return;
    }
    if (!Number.isSafeInteger(p.accessEpoch) || !Array.isArray(p.taskFences))
      throw new Error("Invalid privacy fence");
    await tx.project.updateMany({
      where: {
        id: event.projectId,
        accessEpoch: { lt: Number(p.accessEpoch) },
      },
      data: { accessEpoch: Number(p.accessEpoch) },
    });
    if (p.operation === "revoke" && p.reason === "rebind") {
      const binding = p.binding as
        | { id: string; bindingVersion: number; boundUserId: string | null }
        | undefined;
      if (
        !binding ||
        !Number.isSafeInteger(binding.bindingVersion) ||
        !binding.boundUserId
      )
        throw new Error(
          "Binding recovery requires exact independently witnessed identity",
        );
      const subject = await tx.projectSubject.findUniqueOrThrow({
        where: { projectId: event.projectId },
      });
      if (subject.id !== binding.id)
        throw new Error("Binding subject differs from independent source");
      if (subject.bindingVersion < binding.bindingVersion) {
        if (!(await tx.user.findUnique({ where: { id: binding.boundUserId } })))
          throw new Error(
            "Validated replacement identity absent from backup; recovery remains closed",
          );
        await tx.projectSubject.update({
          where: { id: subject.id },
          data: {
            bindingVersion: binding.bindingVersion,
            boundUserId: binding.boundUserId,
          },
        });
      } else if (
        subject.bindingVersion === binding.bindingVersion &&
        subject.boundUserId !== binding.boundUserId
      )
        throw new Error("Binding recovery conflicts");
    }

    if (p.operation === "erase") {
      const d = p as unknown as DeletionPayload;
      if (
        !Array.isArray(d.categories) ||
        !d.categories.length ||
        d.categories.some(
          (c) =>
            ![
              "all",
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
            ].includes(c),
        ) ||
        !Array.isArray(d.targets) ||
        !["verified_request", "retention_expiry"].includes(d.trigger)
      )
        throw new Error("Invalid deletion scope");
      if (
        d.scopedExportId &&
        (d.trigger !== "retention_expiry" ||
          d.categories.length !== 1 ||
          d.categories[0] !== "exportPackages" ||
          !d.targets.every(
            (t) => t.kind === "export" && t.key === d.scopedExportId,
          ))
      )
        throw new Error("Invalid exact package expiry");
      await tx.$executeRaw`INSERT INTO privacy_deletions(id,project_id,request_id,scoped_export_id,trigger,categories,effective_at) VALUES(${event.eventId}::uuid,${event.projectId}::uuid,${d.requestId}::uuid,${d.scopedExportId || null}::uuid,${d.trigger},${JSON.stringify(d.categories)}::jsonb,${new Date(d.effectiveAt)})`;
      if (d.requestId && p.verification) {
        const v = p.verification as {
          key: string;
          hash: string;
          adminId: string;
        };
        await tx.careRequest.updateMany({
          where: {
            id: d.requestId,
            projectId: event.projectId,
            kind: "delete",
            state: "open",
          },
          data: {
            state: "verified",
            verificationKey: v.key,
            verificationHash: v.hash,
            verifiedBy: v.adminId,
            verifiedAt: new Date(event.occurredAt),
            revokedAccessEpoch: d.accessEpoch,
          },
        });
      }
      for (const e of ERASURE_REGISTRY) {
        if (!d.categories.includes("all") && !d.categories.includes(e.category))
          continue;
        const rows = await tx.$queryRawUnsafe<
          { key: Record<string, unknown> }[]
        >(
          `SELECT privacy_row_key('${e.table}',to_jsonb(r)) AS key FROM "${e.table}" r WHERE ${e.owner}=$1::uuid AND ${"filter" in e ? e.filter : "true"}${d.scopedExportId ? " AND r.id=$2::uuid" : ""}`,
          event.projectId,
          ...(d.scopedExportId ? [d.scopedExportId] : []),
        );
        for (const row of rows)
          await tx.$executeRaw`INSERT INTO privacy_deletion_items(id,event_id,project_id,category,layer,target_table,target_key,target_columns,deadline) VALUES(${randomUUID()}::uuid,${event.eventId}::uuid,${event.projectId}::uuid,${e.category},'active_database',${e.table},${JSON.stringify(row.key)}::jsonb,${[...e.columns]}::text[],${d.deadlines?.active_database ? new Date(d.deadlines.active_database) : null}) ON CONFLICT DO NOTHING`;
      }
      const affectedExports = await this.exportIdsIn(
        tx,
        event.projectId,
        d.categories,
      );
      if (affectedExports.length)
        await tx.careExport.updateMany({
          where: {
            projectId: event.projectId,
            id: { in: affectedExports },
            // A request that has never produced a package keeps its minimum
            // failure/acceptance facts. NULL alone is not proof: a previously
            // ready package can have its locator/manifest erased later.
            ...(d.trigger === "retention_expiry"
              ? {
                  NOT: {
                    state: { in: ["requested", "accepted", "failed"] },
                    objectKey: null,
                    readyAt: null,
                    sha256: null,
                    bytes: null,
                  },
                }
              : {}),
            ...(d.scopedExportId ? { id: d.scopedExportId } : {}),
            state: d.scopedExportId
              ? { in: ["ready", "delivered"] }
              : { not: "revoked" },
          },
          data: {
            state: d.scopedExportId ? "expired" : "revoked",
            fence: { increment: 1 },
            leaseUntil: null,
          },
        });
      const discovered = d.scopedExportId
        ? []
        : await this.fileTargetsIn(tx, event.projectId, d.categories);
      const targets = [
        ...new Map(
          [...d.targets, ...discovered].map((t) => [JSON.stringify(t), t]),
        ).values(),
      ];
      const external: Record<string, string> = {
        historicalObjects: "object_history",
        backupCopies: "backup",
        supplierCopies: "supplier",
      };
      const externalOnly =
        d.categories.length === 1 && external[d.categories[0]];
      if (externalOnly)
        await this.itemIn(
          tx,
          event,
          externalOnly,
          d.categories[0],
          {},
          "awaiting_evidence",
          "EXTERNAL_RECEIPT_REQUIRED",
          d.effectiveAt,
        );
      else {
        await this.itemIn(
          tx,
          event,
          "active_files",
          d.categories.includes("all") ? "activeData" : d.categories[0],
          { targets },
          "pending",
          null,
          d.deadlines?.active_files || null,
        );
        await this.itemIn(
          tx,
          event,
          "cache",
          "activeData",
          { categories: d.categories },
          "pending",
          null,
          d.deadlines?.cache || null,
        );
        for (const [category, layer] of Object.entries(external))
          await this.itemIn(
            tx,
            event,
            layer,
            category,
            {},
            "awaiting_evidence",
            d.deadlines?.[layer] || layer === "supplier"
              ? "EXTERNAL_RECEIPT_REQUIRED"
              : "RULE_NOT_FROZEN",
            d.deadlines?.[layer] || null,
          );
      }
    }
    // The original captured target IDs survive all later leases and regrants.
    if (
      p.operation === "revoke" ||
      (p.operation === "erase" &&
        (p as unknown as DeletionPayload).categories.includes("all"))
    ) {
      const id =
        typeof p.revocationId === "string" ? p.revocationId : event.eventId;
      await tx.projectAccessRevocation.upsert({
        where: { id },
        create: {
          id,
          projectId: event.projectId,
          accessEpoch: Number(p.accessEpoch),
          purpose: String(p.purpose || "all"),
          reason: String(p.reason || "care_verified"),
          taskFences: p.taskFences as Prisma.InputJsonValue,
          sourceSessionId:
            typeof p.sourceSessionId === "string" ? p.sourceSessionId : null,
          targetAttemptId:
            typeof p.targetAttemptId === "string" ? p.targetAttemptId : null,
          createdAt: new Date(event.occurredAt),
        },
        update: {},
      });
    }
  }
  private async holdIn(
    tx: Prisma.TransactionClient,
    event: PublishedPrivacyEvent,
    reason: string,
  ) {
    await tx.$executeRaw`INSERT INTO privacy_recovery_holds(event_id,project_id,reason) VALUES(${event.eventId}::uuid,${event.projectId}::uuid,${reason}) ON CONFLICT DO NOTHING`;
  }
  async recoveryHoldsIn(
    tx: Pick<Prisma.TransactionClient, "$queryRaw">,
    projectId: string,
  ) {
    return tx.$queryRaw<
      { reason: string }[]
    >`SELECT reason FROM privacy_recovery_holds WHERE project_id=${projectId}::uuid`;
  }
  private async itemIn(
    tx: Prisma.TransactionClient,
    event: PublishedPrivacyEvent,
    layer: string,
    category: string,
    locator: unknown,
    state = "pending",
    reason: string | null = null,
    deadline: string | null = null,
  ) {
    await tx.$executeRaw`INSERT INTO privacy_deletion_items(id,event_id,project_id,category,layer,locator,state,reason,deadline) VALUES(${randomUUID()}::uuid,${event.eventId}::uuid,${event.projectId}::uuid,${category},${layer},${JSON.stringify(locator)}::jsonb,${state},${reason},${deadline ? new Date(deadline) : null})`;
  }
  async deletedIn(
    tx: Pick<Prisma.TransactionClient, "$queryRaw">,
    projectId: string,
    category = "all",
  ) {
    const rows = await tx.$queryRaw<
      { denied: boolean }[]
    >`SELECT EXISTS(SELECT 1 FROM privacy_deletions WHERE project_id=${projectId}::uuid AND scoped_export_id IS NULL AND (categories ? 'all' OR categories ? ${category})) OR EXISTS(SELECT 1 FROM privacy_recovery_holds WHERE project_id=${projectId}::uuid) AS denied`;
    return rows[0].denied;
  }
  async requireAvailableIn(
    tx: Prisma.TransactionClient,
    projectId: string,
    category = "all",
  ) {
    if (await this.deletedIn(tx, projectId, category))
      throw new ForbiddenException(
        "Project materials are permanently unavailable",
      );
  }
  /** D03 export_ready belongs to one immutable package, not the project clock. */
  async expireExports(at = new Date()) {
    let cursor: string | undefined;
    for (;;) {
      const packages = await this.db.careExport.findMany({
        where: { expiresAt: { lte: at } },
        take: 100,
        orderBy: { id: "asc" },
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (!packages.length) break;
      for (const pack of packages)
        await this.db.$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT id FROM projects WHERE id=${pack.projectId}::uuid FOR UPDATE`;
            if (
              (
                await tx.$queryRaw<
                  { id: string }[]
                >`SELECT id FROM privacy_deletions WHERE project_id=${pack.projectId}::uuid AND (scoped_export_id=${pack.id}::uuid OR categories ? 'all')`
              ).length
            )
              return;
            const project = await tx.project.findUniqueOrThrow({
              where: { id: pack.projectId },
            });
            const payload: DeletionPayload = {
              operation: "erase",
              requestId: null,
              scopedExportId: pack.id,
              trigger: "retention_expiry",
              categories: ["exportPackages"],
              effectiveAt: pack.expiresAt!.toISOString(),
              accessEpoch: project.accessEpoch,
              targets: [
                {
                  kind: "export",
                  category: "exportPackages",
                  scope: this.config.books?.storageRoot || "",
                  key: pack.id,
                },
              ],
              taskFences: [],
              targetAttemptId: null,
              rule: {
                startsAt: "export_ready",
                anchor: pack.readyAt?.toISOString(),
                expiresAt: pack.expiresAt!.toISOString(),
              },
              deadlines: {
                active_database: pack.expiresAt!.toISOString(),
                active_files: pack.expiresAt!.toISOString(),
                cache: pack.expiresAt!.toISOString(),
              },
            };
            await this.publishIn(tx, {
              eventId: randomUUID(),
              projectId: pack.projectId,
              kind: "deletion",
              occurredAt: at.toISOString(),
              payload: payload as unknown as Record<string, unknown>,
            });
          },
          { timeout: 30000 },
        );
      cursor = packages[packages.length - 1].id;
    }
  }
  async fileTargetsIn(
    tx: Prisma.TransactionClient,
    projectId: string,
    categories: string[],
  ): Promise<PrivateFileTarget[]> {
    const all = categories.includes("all");
    const targets: PrivateFileTarget[] = [];
    const scope = this.config.recording
      ? createHash("sha256")
          .update(
            `product:${require("../probe/storage-scope").probeStorageScope(this.config.recording)}`,
          )
          .digest("hex")
      : "";
    if (all || categories.includes("originalAudio")) {
      const intents = await tx.recordingIntent.findMany({
        where: { projectId },
      });
      for (const i of intents)
        for (const prefix of ["staging", "sealed"])
          targets.push({
            kind: "object",
            category: "originalAudio",
            scope: i.storageScope,
            key: `${prefix}/${i.id}.mp3`,
          });
      for (const a of await tx.recordingAsset.findMany({
        where: { projectId },
      }))
        targets.push({
          kind: "object",
          category: "originalAudio",
          scope: a.storageScope,
          key: a.objectKey,
        });
    }
    if (
      all ||
      categories.some((c) => ["originalPhotos", "derivedPhotos"].includes(c))
    ) {
      for (const i of await tx.photoIntent.findMany({ where: { projectId } }))
        if (all || categories.includes("originalPhotos"))
          targets.push({
            kind: "object",
            category: "originalPhotos",
            scope: i.storageScope,
            key: `photos/staging/${i.id}.bin`,
          });
      for (const a of await tx.photoAsset.findMany({ where: { projectId } })) {
        const category =
          a.kind === "original" ? "originalPhotos" : "derivedPhotos";
        if (all || categories.includes(category))
          targets.push({
            kind: "object",
            category,
            scope: a.storageScope,
            key: a.objectKey,
          });
      }
    }
    if (all || categories.includes("bookPdf"))
      for (const b of await tx.bookVersion.findMany({ where: { projectId } }))
        targets.push({
          kind: "book_directory",
          category: "bookPdf",
          scope: this.config.books?.storageRoot || "",
          key: b.id,
        });
    // A package carries copies from multiple source categories, so any relevant erasure revokes it.
    if (
      all ||
      categories.some((c) =>
        [
          "originalAudio",
          "transcripts",
          "confirmedStories",
          "originalPhotos",
          "derivedPhotos",
          "bookPdf",
          "exportPackages",
          "activeData",
        ].includes(c),
      )
    )
      for (const id of await this.exportIdsIn(tx, projectId, categories))
        targets.push({
          kind: "export",
          category: "exportPackages",
          scope: this.config.books?.storageRoot || "",
          key: id,
        });
    const owned = await tx.$queryRaw<
      {
        category: string;
        storage_scope: string;
        object_keys: string[];
        directory: string | null;
      }[]
    >`SELECT category,storage_scope,object_keys,directory FROM privacy_owned_resources WHERE project_id=${projectId}::uuid`;
    for (const o of owned)
      if (all || categories.includes(o.category)) {
        for (const key of o.object_keys)
          targets.push({
            kind: "object",
            category: o.category,
            scope: o.storage_scope,
            key,
          });
        if (o.directory)
          targets.push({
            kind: o.directory.includes("/") ? "temporary_file" : "temporary",
            category: o.category,
            scope: this.config.recording?.storageRoot || "",
            key: o.directory,
          });
      }
    return targets;
  }
  private async exportIdsIn(
    tx: Prisma.TransactionClient,
    projectId: string,
    categories: string[],
  ) {
    return (
      await tx.$queryRaw<
        { id: string }[]
      >`SELECT r.id FROM care_exports r WHERE r.project_id=${projectId}::uuid AND EXISTS(SELECT 1 FROM unnest(${categories}::text[]) category WHERE privacy_export_has_category(r.manifest,category))`
    ).map((r) => r.id);
  }
  async registerOwnedIn(
    tx: Prisma.TransactionClient,
    projectId: string,
    category: string,
    scope: string,
    keys: string[],
    directory: string | null = null,
  ) {
    await this.requireAvailableIn(tx, projectId, category);
    const id = randomUUID();
    await tx.$executeRaw`INSERT INTO privacy_owned_resources(id,project_id,category,storage_scope,object_keys,directory) VALUES(${id}::uuid,${projectId}::uuid,${category},${scope},${JSON.stringify(keys)}::jsonb,${directory})`;
    return id;
  }
  async deleteVerifiedIn(
    tx: Prisma.TransactionClient,
    input: {
      projectId: string;
      requestId: string;
      accessEpoch: number;
      verification?: { key: string; hash: string; adminId: string };
    },
  ) {
    const tasks = await tx.productionTask.findMany({
      where: {
        projectId: input.projectId,
        state: { notIn: ["succeeded", "no_speech", "invalidated", "obsolete"] },
      },
      select: { id: true, fence: true },
    });
    const attempt = await tx.fulfillmentAttempt.findFirst({
      where: { projectId: input.projectId },
      orderBy: { sequence: "desc" },
      select: { id: true },
    });
    const effectiveAt = new Date().toISOString(),
      terms = await tx.projectServiceTerms.findUnique({
        where: { projectId: input.projectId },
      }),
      policy = (terms?.policy as any)?.d03;
    const deadlines: Record<string, string | null> = {};
    for (const [layer, category] of [
      ["active_database", "activeData"],
      ["active_files", "activeData"],
      ["cache", "activeData"],
      ["object_history", "historicalObjects"],
      ["backup", "backupCopies"],
      ["supplier", "supplierCopies"],
    ]) {
      const r = policy?.deletion?.[category];
      deadlines[layer] =
        policy?.review?.state === "frozen" &&
        r?.startsAt === "verified_deletion_request" &&
        r.within?.unit === "calendar_days" &&
        Number.isSafeInteger(r.within.value) &&
        r.within.value > 0
          ? new Date(
              Date.parse(effectiveAt) + r.within.value * 86400000,
            ).toISOString()
          : null;
    }
    const payload: DeletionPayload = {
      operation: "erase",
      requestId: input.requestId,
      trigger: "verified_request",
      categories: ["all"],
      effectiveAt,
      deadlines,
      accessEpoch: input.accessEpoch,
      targets: await this.fileTargetsIn(tx, input.projectId, ["all"]),
      ...(input.verification ? { verification: input.verification } : {}),
      taskFences: tasks,
      targetAttemptId: attempt?.id || null,
    };
    await this.publishIn(tx, {
      eventId: input.requestId,
      projectId: input.projectId,
      kind: "deletion",
      occurredAt: payload.effectiveAt,
      payload: payload as unknown as Record<string, unknown>,
    });
  }
  async onModuleDestroy() {
    await this.syncing?.catch(() => {});
  }
  async onApplicationShutdown() {
    await this.onModuleDestroy();
    await this.db.$disconnect();
  }
}
