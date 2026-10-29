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
  OnModuleDestroy,
  ForbiddenException,
  ConflictException,
  NotFoundException,
  Res,
  BadRequestException,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiHeader,
  ApiProperty,
  ApiTags,
  ApiCookieAuth,
  ApiProduces,
} from "@nestjs/swagger";
import {
  Equals,
  IsIn,
  Matches,
  IsISO8601,
  IsOptional,
  IsInt,
  Min,
} from "class-validator";
import { Prisma, PrismaClient, CareExport } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import type { FastifyRequest, FastifyReply } from "fastify";
import { ADMIN_PERMISSIONS } from "@timenook/contracts";
import { AdminAccess } from "../admin/admin-access";
import { BOOK_OBJECTS } from "../books/books";
import type { ProbeObjects } from "../probe/local-objects";
import { probeStorageScope } from "../probe/storage-scope";
import { exportZip, hashBytes, ExportFile } from "./export-zip";
import { PrivacyRights } from "./privacy-rights";
import {
  readFile,
  writeFile,
  mkdir,
  rm,
  stat,
  readdir,
} from "node:fs/promises";
import { join } from "node:path";
import type { CompleteExportView } from "@timenook/contracts";
import { API_CONFIG, ApiConfig } from "../config";
import { Participation } from "../identity/participation";
import { IdentityAccess } from "../identity/identity-access";
import { ProjectServiceTerms } from "../projects/service-terms";
import { idempotencyKey } from "../payments/orders";
import { ProjectStreams } from "../media/project-streams";
const digest = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
export class ExportRequestDto {
  @ApiProperty({ enum: ["self", "initiator"] })
  @IsIn(["self", "initiator"])
  recipient!: "self" | "initiator";
  @ApiProperty() @Equals("synthetic-d08-v1") noticeVersion!: string;
  @ApiProperty() @Matches(/^synthetic:[^\r\n]{3,160}$/) evidenceRef!: string;
}
export class ExportReviewDto {
  @ApiProperty() @IsISO8601() dueAt!: string;
  @ApiProperty() @Matches(/^synthetic:[^\r\n]{3,160}$/) evidenceRef!: string;
  @ApiProperty({ required: false })
  @IsOptional()
  @Matches(/^synthetic:[^\r\n]{3,160}$/)
  recipientRef?: string;
}
export class ExportDeliveryDto {
  @ApiProperty() @Matches(/^synthetic:[^\r\n]{3,160}$/) evidenceRef!: string;
}
export class ExportReceiptDto {
  @ApiProperty() @Matches(/^[a-f0-9]{64}$/) sha256!: string;
}
export class ExportStaffVerificationDto {
  @ApiProperty() @IsInt() @Min(0) expectedBindingVersion!: number;
  @ApiProperty() @IsInt() @Min(0) expectedAccessEpoch!: number;
  @ApiProperty() @IsISO8601() expiresAt!: string;
  @ApiProperty() @Equals("complete_export_delivery") purpose!: string;
  @ApiProperty() @Equals("synthetic-d08-v1") noticeVersion!: string;
  @ApiProperty() @Equals(true) identityVerified!: boolean;
  @ApiProperty() @Equals(true) subjectConsented!: boolean;
  @ApiProperty()
  @Matches(/^record:[-A-Za-z0-9_:]{3,120}$/)
  identityProcedureRef!: string;
  @ApiProperty()
  @Matches(/^record:[-A-Za-z0-9_:]{3,120}$/)
  confirmationChannelRef!: string;
  @ApiProperty()
  @Matches(/^record:synthetic-[-A-Za-z0-9_:]{3,120}$/)
  verificationRef!: string;
  @ApiProperty() @Matches(/^synthetic:[^\r\n]{3,160}$/) recipientRef!: string;
}
const STAFF_ACCESS_MS = 30 * 60000;
type ExportSource = {
  path: string;
  sha256: string;
  bytes: number;
  provenance: string;
  source: unknown;
  objectKey?: string;
  bookKey?: string;
  text?: string;
};
type ExportSales = {
  admission: {
    d06: {
      completeExport: {
        within: { value: number; unit: string };
        ownerRef: string;
      };
      businessCalendarRef: string;
    };
    d08?: {
      withoutWechat?: {
        export?: {
          identityVerificationRef: string;
          confirmationChannelRef: string;
          neverDefaultToInitiator: boolean;
          recipient: string;
          deliveryChannelRef: string;
        };
      };
    };
  };
};
type ExportBatch = {
  row: CareExport;
  sources: ExportSource[];
  counts: Record<string, number>;
};
class SourceDeleted extends ForbiddenException {
  constructor() {
    super("EXPORT_SOURCE_DELETED");
  }
}
@Injectable()
export class CompleteExports implements OnModuleDestroy {
  private readonly database: PrismaClient;
  private readonly terms: ProjectServiceTerms;
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly identity: IdentityAccess,
    private readonly participation: Participation,
    private readonly rights: PrivacyRights,
    private readonly streams: ProjectStreams,
    @Inject(BOOK_OBJECTS) private readonly objects: ProbeObjects,
  ) {
    this.database = new PrismaClient({ datasourceUrl: config.databaseUrl });
    this.terms = new ProjectServiceTerms(config.databaseUrl);
  }
  async onModuleDestroy() {
    await this.database.$disconnect();
    await this.terms.close();
  }
  private async projectIn(tx: Prisma.TransactionClient, id: string) {
    await tx.$queryRaw`SELECT id FROM projects WHERE id=${id}::uuid FOR UPDATE`;
    const project = await tx.project.findUnique({ where: { id } });
    if (!project) throw new NotFoundException();
    await tx.$queryRaw`SELECT id FROM project_subjects WHERE project_id=${id}::uuid FOR UPDATE`;
    const subject = await tx.projectSubject.findUniqueOrThrow({
        where: { projectId: id },
      }),
      order = await tx.paymentOrder.findUniqueOrThrow({
        where: { id: project.orderId! },
      });
    return { project, subject, order };
  }
  private user<T>(
    id: string,
    authorization: string | undefined,
    work: (
      tx: Prisma.TransactionClient,
      p: Awaited<ReturnType<CompleteExports["projectIn"]>>,
      userId: string,
    ) => Promise<T>,
  ) {
    return this.database.$transaction(async (tx) => {
      const user = await this.identity.current(authorization, tx),
        p = await this.projectIn(tx, id);
      if (user.id !== p.subject.boundUserId && user.id !== p.order.buyerId)
        throw new ForbiddenException();
      return work(tx, p, user.id);
    });
  }
  private async policy(tx: Prisma.TransactionClient, id: string) {
    const terms = await this.terms.read(id, tx);
    if (!terms.exportRequests) throw new ConflictException();
    return terms;
  }
  private view(
    row: CareExport,
    userId?: string,
    contentAllowed?: boolean | null,
  ): CompleteExportView {
    return {
      id: row.id,
      projectId: row.projectId,
      state: row.state as CompleteExportView["state"],
      recipientUserId: row.recipientUserId,
      recipient: row.recipient as CompleteExportView["recipient"],
      requestedAt: row.requestedAt.toISOString(),
      acceptedAt: row.acceptedAt?.toISOString() ?? null,
      dueAt: row.dueAt?.toISOString() ?? null,
      ownerId: row.ownerId,
      readyAt: row.readyAt?.toISOString() ?? null,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      sha256: row.sha256,
      bytes: row.bytes,
      missingReason:
        contentAllowed === false
          ? "EXPORT_CURRENT_AUTHORIZATION_REQUIRED"
          : row.missingReason,
      deliveredAt: row.deliveredAt?.toISOString() ?? null,
      canDownload:
        contentAllowed !== false &&
        !!userId &&
        row.recipientUserId === userId &&
        ["ready", "delivered"].includes(row.state),
    };
  }
  request(
    id: string,
    body: ExportRequestDto,
    authorization: string | undefined,
    key: string,
  ) {
    return this.user(id, authorization, async (tx, p, userId) => {
      if (p.subject.boundUserId !== userId) throw new ForbiddenException();
      const prior = await tx.careRequest.findUnique({
        where: {
          projectId_operatorId_operatorRealm_idempotencyKey: {
            projectId: id,
            operatorId: userId,
            operatorRealm: "product",
            idempotencyKey: key,
          },
        },
      });
      if (prior) {
        const row = await tx.careExport.findUnique({ where: { id: prior.id } });
        if (
          !row ||
          row.evidenceRef !== body.evidenceRef ||
          row.recipient !== body.recipient
        )
          throw new ConflictException();
        return this.view(
          row,
          userId,
          await this.participation.exportPurposeAllowedIn(tx, id, row.id),
        );
      }
      const terms = await this.policy(tx, id);
      if (terms.exportRequests!.state === "deleted")
        throw new ForbiddenException();
      const care = await this.participation.openExportCaseIn(
        tx,
        id,
        userId,
        key,
      );
      const row = await tx.careExport.create({
        data: {
          id: care.id,
          requestedAt: new Date(care.createdAt),
          projectId: id,
          subjectId: p.subject.id,
          bindingVersion: p.subject.bindingVersion,
          accessEpoch: p.project.accessEpoch,
          recipient: body.recipient,
          recipientUserId: body.recipient === "self" ? userId : p.order.buyerId,
          evidenceRef: body.evidenceRef,
        },
      });
      return this.view(
        row,
        userId,
        await this.participation.exportPurposeAllowedIn(tx, id, row.id),
      );
    });
  }
  async read(id: string, authorization?: string) {
    await this.cleanupTemporary();
    return this.user(id, authorization, async (tx, p, userId) => {
      const terms = await this.policy(tx, id),
        snapshot = p.order.packageSnapshot as unknown as ExportSales;
      const rows = await tx.careExport.findMany({
        where: {
          projectId: id,
          ...(p.subject.boundUserId === userId
            ? {}
            : { recipientUserId: userId }),
        },
        orderBy: { requestedAt: "desc" },
      });
      return {
        projectId: id,
        canRequest:
          p.subject.boundUserId === userId &&
          terms.exportRequests!.state !== "deleted",
        amountDueFen: 0,
        requestWindow: terms.exportRequests,
        service: {
          within: snapshot.admission.d06.completeExport.within.value,
          unit: "business_days",
          ownerRef: snapshot.admission.d06.completeExport.ownerRef,
          calendarRef: snapshot.admission.d06.businessCalendarRef,
        },
        accessEpoch: p.project.accessEpoch,
        requests: await Promise.all(
          rows.map(async (row) => {
            const contentAllowed =
              await this.participation.exportPurposeAllowedIn(tx, id, row.id);
            const value = this.view(
              row.accessEpoch === p.project.accessEpoch &&
                row.bindingVersion === p.subject.bindingVersion
                ? row
                : { ...row, state: "revoked" },
              userId,
              contentAllowed,
            );
            if (row.manifest) {
              try {
                this.assertSourceRetention(
                  terms,
                  (row.manifest as { files?: unknown }).files,
                );
              } catch (error) {
                if (!(error instanceof SourceDeleted)) throw error;
                value.canDownload = false;
                value.missingReason = "EXPORT_SOURCE_DELETED";
              }
            }
            return value;
          }),
        ),
      };
    });
  }
  private async scopeIn(
    tx: Prisma.TransactionClient,
    id: string,
    adminId?: string,
    requireContent = true,
  ) {
    const found = await tx.careRequest.findUnique({ where: { id } });
    if (!found || found.kind !== "export") throw new NotFoundException();
    const p = await this.projectIn(tx, found.projectId);
    await tx.$queryRaw`SELECT id FROM care_requests WHERE id=${id}::uuid FOR UPDATE`;
    const care = await tx.careRequest.findUniqueOrThrow({ where: { id } });
    if (
      !["verified", "completed"].includes(care.state) ||
      !care.verifiedBy ||
      (adminId && care.verifiedBy !== adminId) ||
      care.sourceBindingVersion !== p.subject.bindingVersion ||
      care.sourceAccessEpoch !== p.project.accessEpoch
    )
      throw new ForbiddenException();
    const terms = await this.policy(tx, p.project.id),
      contentAllowed = await this.participation.exportPurposeAllowedIn(
        tx,
        p.project.id,
        id,
      );
    if (requireContent && contentAllowed === false)
      throw new ForbiddenException("EXPORT_CURRENT_AUTHORIZATION_REQUIRED");
    const row = await tx.careExport.findUnique({ where: { id } });
    if (
      row &&
      (row.subjectId !== p.subject.id ||
        row.bindingVersion !== p.subject.bindingVersion ||
        row.accessEpoch !== p.project.accessEpoch ||
        ["revoked"].includes(row.state))
    )
      throw new ForbiddenException();
    if (row?.manifest) {
      await this.versionScopeIn(
        tx,
        row.projectId,
        (row.manifest as { files?: unknown }).files,
      );
      await this.sourceRetentionIn(
        tx,
        row.projectId,
        (row.manifest as { files?: unknown }).files,
      );
    }
    return { ...p, care, row, terms, contentAllowed };
  }
  private assertSourceRetention(
    terms: Awaited<ReturnType<ProjectServiceTerms["read"]>>,
    files: unknown,
  ) {
    if (!Array.isArray(files)) throw new ForbiddenException();
    const kinds = new Set<string>();
    for (const file of files) {
      const path = file?.path;
      if (path === "README.txt") continue;
      if (typeof path !== "string") throw new ForbiddenException();
      if (path.startsWith("audio/")) kinds.add("originalAudio");
      else if (path.startsWith("transcripts/")) kinds.add("transcripts");
      else if (path.startsWith("stories/")) kinds.add("confirmedStories");
      else if (path.startsWith("books/")) kinds.add("bookPdf");
      else if (
        path.startsWith("photos/") &&
        typeof file.source?.kind === "string"
      )
        kinds.add(
          file.source.kind === "original" ? "originalPhotos" : "derivedPhotos",
        );
      else throw new ForbiddenException();
    }
    for (const kind of kinds) {
      if (!terms.retention?.[kind]) throw new ForbiddenException();
      if (terms.retention[kind].state === "deleted") throw new SourceDeleted();
    }
  }
  private async sourceRetentionIn(
    tx: Prisma.TransactionClient,
    projectId: string,
    files: unknown,
  ) {
    this.assertSourceRetention(await this.terms.read(projectId, tx), files);
  }
  private async versionScopeIn(
    tx: Prisma.TransactionClient,
    projectId: string,
    files: unknown,
  ) {
    if (!Array.isArray(files)) throw new ForbiddenException();
    for (const file of files) {
      const source = file.source as {
        revisionId?: string;
        contentHash?: string;
        storyVersions?: { revisionId: string; contentHash: string }[];
      };
      const refs = source?.revisionId
        ? [{ revisionId: source.revisionId, contentHash: source.contentHash }]
        : (source?.storyVersions ?? []);
      for (const ref of refs) {
        const revision = await tx.storyRevision.findFirst({
            where: { id: ref.revisionId, projectId },
          }),
          decision = await tx.storyDecision.findFirst({
            where: { revisionId: ref.revisionId, projectId },
            orderBy: { sequence: "desc" },
          });
        if (
          !revision ||
          !decision?.confirmed ||
          decision.contentHash !== ref.contentHash ||
          (file.path.startsWith("books/") && !decision.allowInBook)
        )
          throw new ForbiddenException();
      }
    }
  }
  async reviewIn(
    tx: Prisma.TransactionClient,
    id: string,
    adminId: string,
    body: ExportReviewDto,
  ) {
    const p = await this.scopeIn(tx, id, adminId, false),
      reviewHash = digest(body);
    if (p.row?.acceptedAt) {
      if (p.row.reviewHash !== reviewHash || p.row.ownerId !== adminId)
        throw new ConflictException();
      return this.view(p.row, undefined, p.contentAllowed);
    }
    if (Date.parse(body.dueAt) <= Date.now()) throw new BadRequestException();
    const snapshot = p.order.packageSnapshot as unknown as ExportSales;
    if (
      !snapshot.admission?.d06?.completeExport ||
      !snapshot.admission.d06.businessCalendarRef
    )
      throw new ConflictException();
    let row = p.row;
    if (!row) {
      const alternative = snapshot.admission?.d08?.withoutWechat?.export;
      if (
        p.subject.boundUserId !== null ||
        !p.care.requesterSubjectId ||
        !alternative?.neverDefaultToInitiator ||
        alternative.recipient !==
          "verified_subject_or_explicitly_authorized_recipient" ||
        !alternative.deliveryChannelRef ||
        !body.recipientRef
      )
        throw new ForbiddenException();
      row = await tx.careExport.create({
        data: {
          id,
          projectId: p.project.id,
          subjectId: p.subject.id,
          bindingVersion: p.subject.bindingVersion,
          accessEpoch: p.project.accessEpoch,
          recipient: "verified_alternative",
          recipientRef: body.recipientRef,
          evidenceRef: body.evidenceRef,
          requestedAt: p.care.createdAt,
        },
      });
    } else if (body.recipientRef) throw new BadRequestException();
    row = await tx.careExport.update({
      where: { id },
      data: {
        state: "accepted",
        acceptedAt: new Date(),
        dueAt: new Date(body.dueAt),
        ownerId: adminId,
        reviewHash,
      },
    });
    if (row.recipient === "verified_alternative")
      await this.initialStaffGrantIn(tx, { ...p, row }, adminId);
    return this.view(row, undefined, p.contentAllowed);
  }
  private verificationPolicy(
    p: Awaited<ReturnType<CompleteExports["scopeIn"]>>,
  ) {
    const policy = (p.order.packageSnapshot as unknown as ExportSales).admission
      ?.d08?.withoutWechat?.export;
    if (
      !policy?.identityVerificationRef ||
      !policy.confirmationChannelRef ||
      !policy.neverDefaultToInitiator ||
      !policy.deliveryChannelRef ||
      p.subject.boundUserId !== null ||
      p.row?.recipient !== "verified_alternative" ||
      !p.row.recipientRef ||
      p.row.ownerId !== p.care.verifiedBy
    )
      throw new ForbiddenException();
    return policy;
  }
  private async staffAccessIn(
    tx: Prisma.TransactionClient,
    p: Awaited<ReturnType<CompleteExports["scopeIn"]>>,
    adminId: string,
  ) {
    const row = await tx.exportStaffGrant.findFirst({
      where: { caseId: p.care.id },
      orderBy: { sequence: "desc" },
    });
    const fence = await this.streams.fence(p.project.id);
    const available = !!(
      row &&
      p.contentAllowed !== false &&
      row.adminId === adminId &&
      p.row?.ownerId === adminId &&
      row.subjectId === p.subject.id &&
      row.bindingVersion === p.subject.bindingVersion &&
      row.accessEpoch === p.project.accessEpoch &&
      row.accessSequence === fence.sequence &&
      row.recipientHash === digest(p.row.recipientRef) &&
      row.expiresAt.getTime() > Date.now()
    );
    return {
      row,
      view: {
        id: row?.id ?? null,
        available,
        expiresAt: row?.expiresAt.toISOString() ?? null,
        purpose: "complete_export_delivery",
        identityProcedureRef:
          this.verificationPolicy(p).identityVerificationRef,
        confirmationChannelRef:
          this.verificationPolicy(p).confirmationChannelRef,
        bindingVersion: p.subject.bindingVersion,
        accessEpoch: p.project.accessEpoch,
      },
    };
  }
  private async initialStaffGrantIn(
    tx: Prisma.TransactionClient,
    p: Awaited<ReturnType<CompleteExports["scopeIn"]>>,
    adminId: string,
  ) {
    const policy = this.verificationPolicy(p);
    if (
      !p.care.verifiedAt ||
      !p.care.verificationNotice ||
      !p.care.verificationEvidence
    )
      throw new ForbiddenException();
    const fence = await this.streams.fence(p.project.id);
    await tx.exportStaffGrant.create({
      data: {
        id: randomUUID(),
        caseId: p.care.id,
        projectId: p.project.id,
        subjectId: p.subject.id,
        adminId,
        bindingVersion: p.subject.bindingVersion,
        accessEpoch: p.project.accessEpoch,
        accessSequence: fence.sequence,
        key: "initial-case-verification",
        requestHash: digest({
          verificationHash: p.care.verificationHash,
          recipient: p.row!.recipientRef,
        }),
        source: "case_verification",
        purpose: "complete_export_delivery",
        noticeVersion: p.care.verificationNotice,
        identityProcedureRef: policy.identityVerificationRef,
        confirmationChannelRef: policy.confirmationChannelRef,
        recipientHash: digest(p.row!.recipientRef),
        evidenceHash: digest({
          caseId: p.care.id,
          verification: p.care.verificationEvidence,
        }),
        verifiedAt: p.care.verifiedAt,
        expiresAt: new Date(p.care.verifiedAt.getTime() + STAFF_ACCESS_MS),
      },
    });
  }
  async verifyStaffAccessIn(
    tx: Prisma.TransactionClient,
    id: string,
    adminId: string,
    key: string,
    body: ExportStaffVerificationDto,
  ) {
    const p = await this.scopeIn(tx, id, adminId),
      policy = this.verificationPolicy(p);
    if (
      p.row!.ownerId !== adminId ||
      body.expectedBindingVersion !== p.subject.bindingVersion ||
      body.expectedAccessEpoch !== p.project.accessEpoch ||
      body.recipientRef !== p.row!.recipientRef ||
      body.identityProcedureRef !== policy.identityVerificationRef ||
      body.confirmationChannelRef !== policy.confirmationChannelRef ||
      body.noticeVersion !== p.care.verificationNotice
    )
      throw new ForbiddenException();
    const prior = await tx.exportStaffGrant.findUnique({
      where: { caseId_key: { caseId: id, key } },
    });
    if (prior) {
      if (prior.requestHash !== digest(body) || prior.adminId !== adminId)
        throw new ConflictException();
      return { id: prior.id, expiresAt: prior.expiresAt.toISOString() };
    }
    if (
      await tx.exportStaffGrant.findUnique({
        where: {
          source_evidenceHash: {
            source: "renewed_verification",
            evidenceHash: digest(body.verificationRef),
          },
        },
      })
    )
      throw new ConflictException(
        "A fresh recorded subject verification is required",
      );
    const now = new Date(),
      expiresAt = new Date(body.expiresAt);
    if (
      expiresAt <= now ||
      expiresAt.getTime() > now.getTime() + STAFF_ACCESS_MS
    )
      throw new BadRequestException();
    const fence = await this.streams.fence(p.project.id);
    const row = await tx.exportStaffGrant
      .create({
        data: {
          id: randomUUID(),
          projectId: p.project.id,
          caseId: id,
          subjectId: p.subject.id,
          adminId,
          bindingVersion: p.subject.bindingVersion,
          accessEpoch: p.project.accessEpoch,
          accessSequence: fence.sequence,
          key,
          requestHash: digest(body),
          source: "renewed_verification",
          purpose: body.purpose,
          noticeVersion: body.noticeVersion,
          identityProcedureRef: body.identityProcedureRef,
          confirmationChannelRef: body.confirmationChannelRef,
          recipientHash: digest(body.recipientRef),
          evidenceHash: digest(body.verificationRef),
          verifiedAt: now,
          expiresAt,
        },
      })
      .catch((error: unknown) => {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        )
          throw new ConflictException(
            "A fresh recorded subject verification is required",
          );
        throw error;
      });
    return { id: row.id, expiresAt: row.expiresAt.toISOString() };
  }
  async adminReadIn(tx: Prisma.TransactionClient, id: string, adminId: string) {
    const p = await this.scopeIn(tx, id, adminId, false);
    if (!p.row) return null;
    return {
      ...this.view(p.row, undefined, p.contentAllowed),
      ...(p.row.recipient === "verified_alternative"
        ? { staffAccess: (await this.staffAccessIn(tx, p, adminId)).view }
        : {}),
    };
  }
  async startIn(
    tx: Prisma.TransactionClient,
    id: string,
    adminId: string,
  ): Promise<ExportBatch | CompleteExportView> {
    const p = await this.scopeIn(tx, id, adminId);
    let row = p.row;
    if (!row || !row.acceptedAt || row.ownerId !== adminId)
      throw new ConflictException();
    if (["ready", "delivered"].includes(row.state)) return this.view(row);
    if (
      row.state === "packing" &&
      row.leaseUntil &&
      row.leaseUntil.getTime() > Date.now()
    )
      throw new ConflictException();
    const sources: ExportSource[] = [],
      scope = createHash("sha256")
        .update(`product:${probeStorageScope(this.config.recording)}`)
        .digest("hex"),
      counts = { audio: 0, transcripts: 0, stories: 0, photos: 0, pdfs: 0 };
    const text = (
      path: string,
      value: string,
      provenance: string,
      source: unknown,
    ) => {
      const bytes = Buffer.from(value);
      sources.push({
        path,
        text: value,
        bytes: bytes.length,
        sha256: hashBytes(bytes),
        provenance,
        source,
      });
    };
    try {
      for (const clip of await tx.recordingClip.findMany({
        where: { projectId: row.projectId },
        orderBy: { id: "asc" },
      })) {
        const asset = await tx.recordingAsset.findFirst({
            where: {
              id: clip.assetId,
              projectId: row.projectId,
              storageScope: scope,
            },
          }),
          transcript = await tx.formalTranscript.findUnique({
            where: { clipId: clip.id },
          });
        if (!asset) throw new ConflictException("EXPORT_AUDIO_MISSING");
        sources.push({
          path: `audio/${clip.id}.mp3`,
          objectKey: asset.objectKey,
          bytes: asset.bytes,
          sha256: asset.sha256,
          provenance: "原始录音（真实原声，非合成音频）",
          source: {
            clipId: clip.id,
            assetId: asset.id,
            interviewId: clip.interviewId,
          },
        });
        counts.audio++;
        if (!transcript || transcript.text === null)
          throw new ConflictException("EXPORT_TRANSCRIPT_PENDING");
        if (
          transcript.inputHash !== asset.sha256 ||
          hashBytes(Buffer.from(transcript.text)) !== transcript.sha256
        )
          throw new ConflictException("EXPORT_TRANSCRIPT_MISMATCH");
        text(
          `transcripts/${clip.id}.txt`,
          transcript.text,
          "文件 ASR 原始转录（可能有识别错误，不是本人确认稿）",
          {
            clipId: clip.id,
            transcriptionTaskId: transcript.taskId,
            inputHash: transcript.inputHash,
          },
        );
        counts.transcripts++;
      }
      for (const revision of await tx.storyRevision.findMany({
        where: { projectId: row.projectId },
        orderBy: [{ storyId: "asc" }, { version: "asc" }],
      })) {
        const decision = await tx.storyDecision.findFirst({
          where: { revisionId: revision.id, projectId: row.projectId },
          orderBy: { sequence: "desc" },
        });
        if (
          !decision?.confirmed ||
          decision.contentHash !== revision.contentHash ||
          decision.subjectId !== row.subjectId
        )
          continue;
        const provenance =
          revision.origin === "ai"
            ? "AI 整理，已由本人核对确认"
            : "AI 整理并经人工校对，已由本人核对确认";
        const paragraphs = revision.paragraphs as {
          text: string;
          sourceRefs: string[];
        }[];
        text(
          `stories/${revision.id}.txt`,
          `${revision.title}\n\n${provenance}\n确定故事版本：${revision.version}\n\n${paragraphs.map((p) => p.text).join("\n\n")}\n`,
          provenance,
          {
            storyId: revision.storyId,
            revisionId: revision.id,
            version: revision.version,
            contentHash: revision.contentHash,
            generationTaskId: revision.generationTaskId,
            sourceManifest: revision.sourceManifest,
            audioManifest: revision.audioManifest,
            origin: revision.origin,
            paragraphs: revision.paragraphs,
            photoSnapshotId: revision.photoSnapshotId,
            photoSnapshot: revision.photoSnapshot,
            reviewResolutions: revision.reviewResolutions,
            notes: revision.notes,
          },
        );
        counts.stories++;
      }
      for (const photo of await tx.photoAsset.findMany({
        where: {
          projectId: row.projectId,
          storageScope: scope,
        },
        orderBy: { id: "asc" },
      })) {
        const extension =
          photo.mime === "image/png"
            ? "png"
            : photo.mime === "image/jpeg"
              ? "jpg"
              : photo.mime === "image/heic"
                ? "heic"
                : "bin";
        sources.push({
          path: `photos/${photo.id}.${extension}`,
          objectKey: photo.objectKey,
          bytes: photo.bytes,
          sha256: photo.sha256,
          provenance:
            photo.kind === "original"
              ? "用户上传原始照片"
              : "从用户原图处理的照片衍生版本",
          source: {
            assetId: photo.id,
            intentId: photo.intentId,
            mime: photo.mime,
            kind: photo.kind,
            parentId: photo.parentId,
            processingVersion: photo.processingVersion,
          },
        });
        counts.photos++;
      }
      for (const book of await tx.bookVersion.findMany({
        where: { projectId: row.projectId },
        orderBy: { version: "asc" },
      })) {
        const output = await tx.bookOutput.findUnique({
            where: { bookId: book.id },
          }),
          task = await tx.productionTask.findUnique({
            where: { id: book.taskId },
          });
        if (!output || task?.state !== "succeeded") continue;
        const references = await tx.bookStoryReference.findMany({
          where: { bookId: book.id },
        });
        let allowed = true;
        for (const ref of references) {
          const decision = await tx.storyDecision.findFirst({
            where: { revisionId: ref.revisionId },
            orderBy: { sequence: "desc" },
          });
          if (
            !decision?.confirmed ||
            !decision.allowInBook ||
            decision.contentHash !== ref.contentHash
          )
            allowed = false;
        }
        if (!allowed) continue;
        if (!/^[a-f0-9-]{36}\/[0-9]+\/book\.pdf$/.test(output.objectKey))
          throw new ConflictException("EXPORT_PDF_KEY_INVALID");
        sources.push({
          path: `books/${book.id}.pdf`,
          bookKey: output.objectKey,
          bytes: output.bytes,
          sha256: output.sha256,
          provenance: "确定版本书稿 PDF（内含适用 AI 整理及人工校对来源标识）",
          source: {
            bookVersionId: book.id,
            version: book.version,
            snapshotHash: book.snapshotHash,
            storyVersions: references.map((r) => ({
              storyId: r.storyId,
              revisionId: r.revisionId,
              contentHash: r.contentHash,
            })),
          },
        });
        counts.pdfs++;
      }
      if (
        sources.length > 510 ||
        sources.reduce((n, f) => n + f.bytes, 0) > 134217728
      )
        throw new ConflictException("EXPORT_LIMIT_REQUIRES_CARE");
      await this.sourceRetentionIn(tx, row.projectId, sources);
    } catch (error) {
      if (
        error instanceof SourceDeleted ||
        (error instanceof ConflictException &&
          /^EXPORT_[A-Z_]+$/.test(error.message))
      )
        return this.view(
          await tx.careExport.update({
            where: { id },
            data: {
              state: "failed",
              missingReason: error.message,
              leaseUntil: null,
            },
          }),
        );
      throw error;
    }
    row = await tx.careExport.update({
      where: { id },
      data: {
        state: "packing",
        fence: { increment: 1 },
        leaseUntil: new Date(Date.now() + 120000),
        missingReason: null,
      },
    });
    return { row, sources, counts };
  }
  async build(batch: ExportBatch) {
    const files: ExportFile[] = [];
    for (const source of batch.sources) {
      let bytes: Buffer;
      if (source.text !== undefined) bytes = Buffer.from(source.text);
      else if (source.objectKey)
        bytes = await this.objects.read(source.objectKey);
      else {
        const path = join(this.config.books!.storageRoot, source.bookKey!);
        if ((await stat(path)).size !== source.bytes)
          throw new Error("EXPORT_SOURCE_MISSING_OR_CHANGED");
        bytes = await readFile(path);
      }
      if (bytes.length !== source.bytes || hashBytes(bytes) !== source.sha256)
        throw new Error("EXPORT_SOURCE_MISSING_OR_CHANGED");
      files.push({
        path: source.path,
        bytes,
        provenance: source.provenance,
        source: source.source,
      });
    }
    files.unshift({
      path: "README.txt",
      bytes: Buffer.from(
        "岁月成书 · 完整资料导出\n\n无需登录平台即可读取。audio/ 为原始录音，非合成音频；transcripts/ 为未经校对的文件 ASR 原始转录；stories/ 为指定版本本人确认稿，逐份标明 AI 整理及人工校对来源；photos/ 为原始照片；books/ 为当时可交付的固定 PDF。manifest.json 记录每份文件的相对路径、字节数、SHA256 与版本/来源关系。某类数量为 0 表示该类尚未创建或未获确认交付，不能据此认定已删除。\n\n录音是讲述者真实原声；当前测试素材为合成样本，不代表已取得真实私人素材。原始转录可能有识别错误，确认稿以本人核验的具体版本为准。使用任意 ZIP 工具解压后，核对 manifest.json 的全部路径与 SHA256；缺件或 hash 不一致请联系原服务方。manifest 本身由下载包的 SHA256 保护。\n\n下载后副本由接收人保管，平台撤回或到期不能收回已传输文件或纸书。包下载期限与原始资料保留期限分别执行；重试和重复领取不会延长下载期限。完整导出已包含，不额外收费。\n",
      ),
      provenance: "资料包可读说明",
      source: { counts: batch.counts },
    });
    const archive = exportZip(files, {
      projectId: batch.row.projectId,
      subjectId: batch.row.subjectId,
      exportId: batch.row.id,
      bindingVersion: batch.row.bindingVersion,
      accessEpoch: batch.row.accessEpoch,
      counts: batch.counts,
    });
    const objectKey = `exports/${batch.row.id}-${batch.row.fence}.zip`,
      path = this.path(objectKey);
    await mkdir(join(this.config.books!.storageRoot, "exports"), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(path, archive.bytes, { mode: 0o600, flag: "wx" });
    return { ...archive, objectKey, sha256: hashBytes(archive.bytes) };
  }
  private path(key: string) {
    if (!/^exports\/[a-f0-9-]{36}-[0-9]+\.zip$/.test(key))
      throw new NotFoundException();
    return join(this.config.books!.storageRoot, key);
  }
  async finishIn(
    tx: Prisma.TransactionClient,
    batch: ExportBatch,
    adminId: string,
    archive: Awaited<ReturnType<CompleteExports["build"]>>,
  ) {
    const p = await this.scopeIn(tx, batch.row.id, adminId),
      row = p.row;
    await this.versionScopeIn(tx, batch.row.projectId, archive.manifest.files);
    await this.sourceRetentionIn(
      tx,
      batch.row.projectId,
      archive.manifest.files,
    );
    if (
      !row ||
      row.state !== "packing" ||
      row.fence !== batch.row.fence ||
      !row.leaseUntil ||
      row.leaseUntil.getTime() <= Date.now()
    )
      throw new ConflictException();
    const readyAt = new Date();
    return this.view(
      await tx.careExport.update({
        where: { id: row.id },
        data: {
          state: "ready",
          readyAt,
          expiresAt: null,
          objectKey: archive.objectKey,
          sha256: archive.sha256,
          bytes: archive.bytes.length,
          manifest: archive.manifest as unknown as Prisma.InputJsonValue,
          leaseUntil: null,
        },
      }),
    );
  }
  async fail(batch: ExportBatch, reason: string) {
    await this.database.careExport.updateMany({
      where: { id: batch.row.id, state: "packing", fence: batch.row.fence },
      data: { state: "failed", leaseUntil: null, missingReason: reason },
    });
    await rm(this.path(`exports/${batch.row.id}-${batch.row.fence}.zip`), {
      force: true,
    });
  }
  async download(id: string, caseId: string, authorization?: string) {
    const check = () =>
      this.user(id, authorization, async (tx, _p, userId) => {
        const scope = await this.scopeIn(tx, caseId),
          row = scope.row;
        if (
          scope.project.id !== id ||
          !row ||
          row.recipientUserId !== userId ||
          !["ready", "delivered"].includes(row.state) ||
          !row.objectKey ||
          !row.sha256 ||
          !row.bytes
        )
          throw new ForbiddenException();
        return row;
      });
    await this.cleanupTemporary();
    const before = await check(),
      bytes = await this.readPackage(before),
      after = await check();
    if (after.objectKey !== before.objectKey || after.sha256 !== before.sha256)
      throw new ForbiddenException();
    return { bytes, row: after, check };
  }
  async receipt(
    id: string,
    caseId: string,
    body: ExportReceiptDto,
    authorization?: string,
  ) {
    return this.user(id, authorization, async (tx, _p, userId) => {
      const scope = await this.scopeIn(tx, caseId),
        row = scope.row;
      if (
        scope.project.id !== id ||
        !row ||
        row.recipientUserId !== userId ||
        !["ready", "delivered"].includes(row.state)
      )
        throw new ForbiddenException();
      if (row.sha256 !== body.sha256) throw new ConflictException();
      if (row.deliveredAt) return this.view(row, userId);
      await tx.careRequest.update({
        where: { id: caseId },
        data: { state: "completed", completedBy: row.ownerId },
      });
      return this.view(
        await tx.careExport.update({
          where: { id: caseId },
          data: {
            state: "delivered",
            deliveredAt: new Date(),
            deliveryEvidence: `subject-receipt:${body.sha256}`,
          },
        }),
        userId,
      );
    });
  }
  async alternativeIn(
    tx: Prisma.TransactionClient,
    id: string,
    adminId: string,
    body: ExportDeliveryDto,
  ) {
    const p = await this.scopeIn(tx, id, adminId),
      row = p.row;
    if (
      !row ||
      row.recipient !== "verified_alternative" ||
      !row.recipientRef ||
      !row.readyAt ||
      !["ready", "delivered"].includes(row.state)
    )
      throw new ForbiddenException();
    if (row.deliveredAt) {
      if (row.deliveryEvidence !== body.evidenceRef)
        throw new ConflictException();
      return this.view(row);
    }
    await tx.careRequest.update({
      where: { id },
      data: { state: "completed", completedBy: adminId },
    });
    return this.view(
      await tx.careExport.update({
        where: { id },
        data: {
          state: "delivered",
          deliveredAt: new Date(),
          deliveryEvidence: body.evidenceRef,
        },
      }),
    );
  }
  async alternativeDownloadIn(
    tx: Prisma.TransactionClient,
    id: string,
    adminId: string,
  ) {
    const p = await this.scopeIn(tx, id, adminId),
      row = p.row;
    if (
      !row ||
      row.recipient !== "verified_alternative" ||
      !row.objectKey ||
      !["ready", "delivered"].includes(row.state)
    )
      throw new ForbiddenException();
    const grant = await this.staffAccessIn(tx, p, adminId);
    if (!grant.view.available || !grant.row)
      throw new ForbiddenException("EXPORT_STAFF_ACCESS_REQUIRED");
    return { ...row, staffGrantId: grant.row.id };
  }
  async readPackage(row: CareExport) {
    const path = this.path(row.objectKey!);
    if ((await stat(path)).size !== row.bytes) throw new ConflictException();
    const bytes = await readFile(path);
    if (hashBytes(bytes) !== row.sha256) throw new ConflictException();
    return bytes;
  }
  /** T26 trusted composition: access changes commit before this removes package files. */
  async purgeProject(projectId: string) {
    const rows = await this.database.careExport.findMany({
      where: { projectId },
    });
    await this.database.careExport.updateMany({
      where: { projectId },
      data: {
        state: "revoked",
        fence: { increment: 1 },
        leaseUntil: null,
        manifest: Prisma.DbNull,
      },
    });
    for (const row of rows)
      if (row.objectKey) await rm(this.path(row.objectKey), { force: true });
    await this.removeOrphanPackages();
  }
  private async removeOrphanPackages() {
    const directory = join(this.config.books!.storageRoot, "exports");
    const files = await readdir(directory).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      },
    );
    let removed = 0;
    for (const file of files) {
      const match = /^([a-f0-9-]{36})-([0-9]+)\.zip$/.exec(file);
      if (!match) continue;
      const row = await this.database.careExport.findUnique({
        where: { id: match[1] },
      });
      const live =
        row &&
        ((row.objectKey === `exports/${file}` &&
          ["ready", "delivered"].includes(row.state)) ||
          (row.state === "packing" &&
            row.fence === Number(match[2]) &&
            !!row.leaseUntil &&
            row.leaseUntil.getTime() > Date.now()));
      if (!live) {
        await rm(this.path(`exports/${file}`), { force: true });
        removed++;
      }
    }
    return removed;
  }
  async cleanupTemporary() {
    await this.rights.assertHealthy();
    return { orphaned: await this.removeOrphanPackages() };
  }
}
@Controller("v1/projects/:id/exports")
@ApiTags("Complete export")
@ApiBearerAuth()
export class CompleteExportsController {
  constructor(
    private readonly exports: CompleteExports,
    private readonly streams: ProjectStreams,
  ) {}
  @Post(":caseId/receipt")
  @Header("Cache-Control", "no-store")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  async receipt(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Param("caseId", new ParseUUIDPipe()) caseId: string,
    @Body() body: ExportReceiptDto,
    @Req() req: FastifyRequest,
  ) {
    idempotencyKey(req);
    return {
      data: await this.exports.receipt(
        id,
        caseId,
        body,
        req.headers.authorization,
      ),
      meta: { requestId: req.id },
    };
  }
  @Get(":caseId/download")
  @Header("Cache-Control", "private, no-store")
  @ApiProduces("application/zip")
  async download(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Param("caseId", new ParseUUIDPipe()) caseId: string,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const fence = await this.streams.userFence(id, req.headers.authorization);
    const file = await this.exports.download(
      id,
      caseId,
      req.headers.authorization,
    );
    const stream = await this.streams.guard(
      id,
      fence.epoch,
      file.bytes,
      file.check,
      req.headers.authorization,
      fence.sequence,
    );
    reply
      .header("Content-Length", file.bytes.length)
      .header(
        "Content-Disposition",
        `attachment; filename="complete-export-${caseId}.zip"`,
      )
      .header("X-Content-Type-Options", "nosniff")
      .type("application/zip")
      .send(stream);
  }
  @Get() @Header("Cache-Control", "no-store") async read(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.exports.read(id, req.headers.authorization),
      meta: { requestId: req.id },
    };
  }
  @Post()
  @Header("Cache-Control", "no-store")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  async request(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() body: ExportRequestDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.exports.request(
        id,
        body,
        req.headers.authorization,
        idempotencyKey(req),
      ),
      meta: { requestId: req.id },
    };
  }
}

@Controller("v1/admin")
@ApiTags("Administration complete export")
@ApiCookieAuth("timenook-admin")
export class AdminCompleteExportsController {
  constructor(
    private readonly exports: CompleteExports,
    private readonly access: AdminAccess,
    private readonly streams: ProjectStreams,
  ) {}
  private run<T>(
    req: FastifyRequest,
    action: string,
    work: (adminId: string) => Promise<T>,
  ) {
    return this.access.run(action, req, async () => {
      const actor = await this.access.authorized(
        req,
        ADMIN_PERMISSIONS.writeCare,
      );
      return work(actor.adminId!);
    });
  }
  private command<T>(
    req: FastifyRequest,
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ) {
    return this.access.command(
      req,
      ADMIN_PERMISSIONS.writeCare,
      work,
      req.method === "GET",
    );
  }
  @Get("care-requests/:caseId/export")
  @Header("Cache-Control", "no-store")
  async read(
    @Param("caseId", new ParseUUIDPipe()) id: string,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.run(req, "care.export.read", (admin) =>
        this.command(req, (tx) => this.exports.adminReadIn(tx, id, admin)),
      ),
      meta: { requestId: req.id },
    };
  }
  @Post("care-requests/:caseId/export/accept")
  @Header("Cache-Control", "no-store")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  async accept(
    @Param("caseId", new ParseUUIDPipe()) id: string,
    @Body() body: ExportReviewDto,
    @Req() req: FastifyRequest,
  ) {
    idempotencyKey(req);
    return {
      data: await this.run(req, "care.export.accept", (admin) =>
        this.command(req, (tx) => this.exports.reviewIn(tx, id, admin, body)),
      ),
      meta: { requestId: req.id },
    };
  }
  @Post("care-requests/:caseId/export/pack")
  @Header("Cache-Control", "no-store")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  async pack(
    @Param("caseId", new ParseUUIDPipe()) id: string,
    @Req() req: FastifyRequest,
  ) {
    idempotencyKey(req);
    const data = await this.run(req, "care.export.pack", async (admin) => {
      const batch = await this.command(req, (tx) =>
        this.exports.startIn(tx, id, admin),
      );
      if (!("sources" in batch)) return batch;
      try {
        const archive = await this.exports.build(batch);
        return await this.command(req, (tx) =>
          this.exports.finishIn(tx, batch, admin, archive),
        );
      } catch (error) {
        await this.exports.fail(
          batch,
          error instanceof SourceDeleted
            ? error.message
            : "EXPORT_SOURCE_MISSING_OR_PERMISSION_CHANGED",
        );
        if (error instanceof ForbiddenException) throw error;
        throw new ConflictException();
      }
    });
    return { data, meta: { requestId: req.id } };
  }
  @Post("care-requests/:caseId/export/delivery")
  @Header("Cache-Control", "no-store")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  async delivered(
    @Param("caseId", new ParseUUIDPipe()) id: string,
    @Body() body: ExportDeliveryDto,
    @Req() req: FastifyRequest,
  ) {
    idempotencyKey(req);
    return {
      data: await this.run(req, "care.export.delivery", (admin) =>
        this.command(req, (tx) =>
          this.exports.alternativeIn(tx, id, admin, body),
        ),
      ),
      meta: { requestId: req.id },
    };
  }
  @Post("care-requests/:caseId/export/access-verification")
  @Header("Cache-Control", "no-store")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  async accessVerification(
    @Param("caseId", new ParseUUIDPipe()) id: string,
    @Body() body: ExportStaffVerificationDto,
    @Req() req: FastifyRequest,
  ) {
    const key = idempotencyKey(req);
    return {
      data: await this.run(req, "care.export.access-verification", (admin) =>
        this.command(req, (tx) =>
          this.exports.verifyStaffAccessIn(tx, id, admin, key, body),
        ),
      ),
      meta: { requestId: req.id },
    };
  }
  @Get("care-requests/:caseId/export/download")
  @Header("Cache-Control", "private, no-store")
  @ApiProduces("application/zip")
  async download(
    @Param("caseId", new ParseUUIDPipe()) id: string,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const result = await this.run(
      req,
      "care.export.alternative-download",
      async (admin) => {
        let capturedGrant: string | undefined;
        const check = async () => {
            const row = await this.command(req, (tx) =>
              this.exports.alternativeDownloadIn(tx, id, admin),
            );
            if (capturedGrant && row.staffGrantId !== capturedGrant)
              throw new ForbiddenException();
            capturedGrant = row.staffGrantId;
            return row;
          },
          before = await check(),
          fence = await this.streams.fence(before.projectId);
        const bytes = await this.exports.readPackage(before);
        const after = await check();
        if (
          before.objectKey !== after.objectKey ||
          before.sha256 !== after.sha256
        )
          throw new ForbiddenException();
        return {
          length: bytes.length,
          stream: await this.streams.guard(
            before.projectId,
            fence.epoch,
            bytes,
            check,
            undefined,
            fence.sequence,
          ),
        };
      },
    );
    reply
      .header("Content-Length", result.length)
      .header(
        "Content-Disposition",
        `attachment; filename="complete-export-${id}.zip"`,
      )
      .type("application/zip")
      .send(result.stream);
  }
  @Post("exports/cleanup") @Header("Cache-Control", "no-store") async cleanup(
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.run(req, "care.export.cleanup", async () => {
        await this.command(req, async () => undefined);
        return this.exports.cleanupTemporary();
      }),
      meta: { requestId: req.id },
    };
  }
}
