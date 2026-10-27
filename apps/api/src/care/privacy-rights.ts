import {
  Inject,
  Injectable,
  OnModuleDestroy,
  ForbiddenException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Prisma, PrismaClient } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
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
  kind: "object" | "book_directory" | "export" | "temporary";
  category: string;
  scope: string;
  key: string;
};
export type DeletionPayload = {
  operation: "erase";
  requestId: string | null;
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
export class PrivacyRights implements OnModuleDestroy {
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
  async initialize() {
    if (!this.enabled) return;
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
  }
  async replayOnly() {
    if (!this.config.privacyJournal)
      throw new Error("Independent source required");
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
  async assertReplayed() {
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
    if (
      !state ||
      state.source_id !== snapshot.sourceId ||
      Number(state.checkpoint_generation) > snapshot.generation
    ) {
      this.failed = true;
      throw new ServiceUnavailableException(
        "Independent source checkpoint conflicts",
      );
    }
    if (
      Number(state.checkpoint_generation) !== snapshot.generation ||
      state.checkpoint_hash !== snapshot.hash
    )
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
      !["revoke", "erase", "story_decision", "assisted_session_end"].includes(
        String(event.payload.operation),
      )
    )
      throw new Error("Unknown privacy event operation");
    await tx.$executeRaw`INSERT INTO privacy_events(id,project_id,kind,source_id,generation,hash,payload,occurred_at) VALUES(${event.eventId}::uuid,${event.projectId}::uuid,${event.kind},${event.sourceId}::uuid,${BigInt(event.generation)},${event.hash},${JSON.stringify(event.payload)}::jsonb,${new Date(event.occurredAt)})`;
    if (event.payload.operation === "story_decision") {
      const d = event.payload
        .decision as Prisma.StoryDecisionUncheckedCreateInput;
      if (
        !d ||
        d.projectId !== event.projectId ||
        (d.confirmed && d.allowInBook)
      )
        throw new Error("Invalid exact story denial");
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
      await tx.$executeRaw`INSERT INTO privacy_deletions(id,project_id,request_id,trigger,categories,effective_at) VALUES(${event.eventId}::uuid,${event.projectId}::uuid,${d.requestId}::uuid,${d.trigger},${JSON.stringify(d.categories)}::jsonb,${new Date(d.effectiveAt)})`;
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
          `SELECT privacy_row_key('${e.table}',to_jsonb(r)) AS key FROM "${e.table}" r WHERE ${e.owner}=$1::uuid AND ${"filter" in e ? e.filter : "true"}`,
          event.projectId,
        );
        for (const row of rows)
          await tx.$executeRaw`INSERT INTO privacy_deletion_items(id,event_id,project_id,category,layer,target_table,target_key,target_columns,deadline) VALUES(${randomUUID()}::uuid,${event.eventId}::uuid,${event.projectId}::uuid,${e.category},'active_database',${e.table},${JSON.stringify(row.key)}::jsonb,${[...e.columns]}::text[],${d.deadlines?.active_database ? new Date(d.deadlines.active_database) : null}) ON CONFLICT DO NOTHING`;
      }
      if (
        d.categories.includes("all") ||
        d.categories.some((c) =>
          [
            "originalAudio",
            "originalPhotos",
            "derivedPhotos",
            "transcripts",
            "confirmedStories",
            "bookPdf",
            "exportPackages",
            "activeData",
          ].includes(c),
        )
      )
        await tx.careExport.updateMany({
          where: { projectId: event.projectId, state: { not: "revoked" } },
          data: { state: "revoked", fence: { increment: 1 }, leaseUntil: null },
        });
      const discovered = await this.fileTargetsIn(
        tx,
        event.projectId,
        d.categories,
      );
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
          {},
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
    tx: Prisma.TransactionClient,
    projectId: string,
    category = "all",
  ) {
    const rows = await tx.$queryRaw<
      { denied: boolean }[]
    >`SELECT EXISTS(SELECT 1 FROM privacy_deletions WHERE project_id=${projectId}::uuid AND (categories ? 'all' OR categories ? ${category})) AS denied`;
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
      for (const e of await tx.careExport.findMany({ where: { projectId } }))
        targets.push({
          kind: "export",
          category: "exportPackages",
          scope: this.config.books?.storageRoot || "",
          key: e.id,
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
            kind: "temporary",
            category: o.category,
            scope: this.config.recording?.storageRoot || "",
            key: o.directory,
          });
      }
    return targets;
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
    await this.db.$disconnect();
  }
}
