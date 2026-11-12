import {
  acceptTermsIn,
  isProjectMemberIn,
  requireProjectMemberIn,
  TERMS_VERSION,
} from "./project-members";
import {
  E2E_NOTICE_VERSION,
  participationNotice,
} from "../catalog/e2e-package";
import { PrivacyRights } from "../care/privacy-rights";
import { isDeepStrictEqual } from "node:util";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  ParseUUIDPipe,
  Req,
  Header,
  Inject,
  Injectable,
  OnModuleDestroy,
  OnApplicationShutdown,
  OnModuleInit,
  ForbiddenException,
  BadRequestException,
  NotFoundException,
  ConflictException,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiTags,
  ApiProperty,
  ApiHeader,
  ApiOperation,
} from "@nestjs/swagger";
import {
  IsString,
  Matches,
  IsInt,
  Min,
  IsIn,
  IsBoolean,
  IsUUID,
  IsOptional,
  ValidateIf,
  MaxLength,
} from "class-validator";
import {
  Prisma,
  PrismaClient,
  type AssistedSession,
  type ConsentRecord,
} from "@prisma/client";
import type { FastifyRequest } from "fastify";
import { API_CONFIG, ApiConfig } from "../config";
import {
  IdentityAccess,
  readSelfMethodIn,
  readSessionContextIn,
} from "./identity-access";
import { readProjectAdmissionIn } from "../projects/project-admission";
import { INTERNAL_NOTICE_VERSION } from "../projects/internal-profile";
import { closeProjectStreams } from "../media/project-streams";
import { ProjectServiceTerms } from "../projects/service-terms";
import { idempotencyKey } from "../payments/orders";
import { CONSENT_PURPOSES, ASSISTED_PURPOSES } from "@timenook/contracts";
import type {
  ConsentPurpose,
  ParticipationState,
  CareBindingChangeView,
  CareCase,
  AssistedSessionView,
  AssistedPurpose,
  ProjectMembership,
  ProjectMemberProfile,
  GiftCategory,
} from "@timenook/contracts";
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const CARE_SELECT = {
  id: true,
  projectId: true,
  requesterId: true,
  requesterSubjectId: true,
  operatorId: true,
  operatorRealm: true,
  targetUserId: true,
  sourceBindingVersion: true,
  sourceAccessEpoch: true,
  kind: true,
  withdrawalPurpose: true,
  state: true,
  completedBy: true,
  createdAt: true,
} as const;
function careView(
  row: Prisma.CareRequestGetPayload<{ select: typeof CARE_SELECT }>,
): CareCase {
  return {
    id: row.id,
    projectId: row.projectId,
    requesterId: row.requesterId,
    requesterSubjectId: row.requesterSubjectId,
    operatorId: row.operatorId,
    operatorRealm: row.operatorRealm as CareCase["operatorRealm"],
    targetUserId: row.targetUserId,
    sourceBindingVersion: row.sourceBindingVersion,
    sourceAccessEpoch: row.sourceAccessEpoch,
    kind: row.kind as CareCase["kind"],
    withdrawalPurpose: row.withdrawalPurpose as ConsentPurpose | null,
    state: row.state as CareCase["state"],
    completedBy: row.completedBy,
    createdAt: row.createdAt.toISOString(),
  };
}
class MemberRelationshipDto {
  @ApiProperty({ description: "你是主讲人的谁", maxLength: 32 })
  @IsString()
  @MaxLength(32)
  @Matches(/^[^\r\n\x00-\x1f]+$/)
  relationship!: string;
}
class AcceptInvitationDto extends MemberRelationshipDto {
  @ApiProperty({ enum: [TERMS_VERSION] })
  @IsIn([TERMS_VERSION])
  termsVersion!: string;
}
class ParticipationNoticeDto {
  @ApiProperty({
    enum: ["synthetic-d08-v1", INTERNAL_NOTICE_VERSION, E2E_NOTICE_VERSION],
  })
  @IsIn(["synthetic-d08-v1", INTERNAL_NOTICE_VERSION, E2E_NOTICE_VERSION])
  noticeVersion!: string;
  @ApiProperty({
    description:
      "Explicit current notice choice; internal runtime records evidence from the actual authenticated session",
  })
  @IsString()
  @Matches(/^(?:synthetic:|internal:)[^\r\n]{3,160}$/)
  evidenceRef!: string;
}
class AssistedSessionDto extends ParticipationNoticeDto {
  @ApiProperty({
    format: "uuid",
    required: false,
    description:
      "Latest observed session for this purpose; omit only when none exists",
  })
  @IsOptional()
  @IsUUID()
  expectedSessionId?: string;
  @ApiProperty({ enum: ASSISTED_PURPOSES })
  @IsIn(ASSISTED_PURPOSES)
  purpose!: (typeof ASSISTED_PURPOSES)[number];
  @ApiProperty() @IsBoolean() granted!: boolean;
  @ApiProperty({ minimum: 0 }) @IsInt() @Min(0) expectedBindingVersion!: number;
  @ApiProperty({ minimum: 0 }) @IsInt() @Min(0) expectedAccessEpoch!: number;
}
class ApprovalDto {
  @ApiProperty({ minimum: 0 }) @IsInt() @Min(0) expectedBindingVersion!: number;
  @ApiProperty()
  @IsString()
  @Matches(/^(?:synthetic:|internal:)[^\r\n]{3,160}$/)
  evidenceRef!: string;
}
class StartConsentDto extends ParticipationNoticeDto {
  @ApiProperty({ minimum: 1 }) @IsInt() @Min(1) expectedBindingVersion!: number;
  @ApiProperty({ minimum: 0 }) @IsInt() @Min(0) expectedAccessEpoch!: number;
}
class RevokeDto extends StartConsentDto {
  @ApiProperty({ enum: CONSENT_PURPOSES })
  @IsIn(CONSENT_PURPOSES)
  purpose!: (typeof CONSENT_PURPOSES)[number];
}
class ConsentDto extends RevokeDto {
  @ApiProperty() @IsBoolean() granted!: boolean;
}
export class CareRequestDto {
  @ApiProperty({
    enum: ["rebind", "withdraw", "export", "delete", "correction"],
  })
  @IsIn(["rebind", "withdraw", "export", "delete", "correction"])
  kind!: "rebind" | "withdraw" | "export" | "delete" | "correction";
  @ApiProperty({ enum: CONSENT_PURPOSES, required: false })
  @IsOptional()
  @IsIn(CONSENT_PURPOSES)
  purpose?: ConsentPurpose;
  @ApiProperty({ format: "uuid", required: false })
  @ValidateIf((o) => o.kind === "rebind")
  @IsUUID()
  targetUserId?: string;
  @ApiProperty({ minimum: 0 }) @IsInt() @Min(0) expectedBindingVersion!: number;
}
export class VerifyCareDto extends ParticipationNoticeDto {
  @ApiProperty({
    minimum: 0,
    required: false,
    description: "Required for export subject verification",
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedAccessSequence?: number;
  @ApiProperty({ minimum: 0 }) @IsInt() @Min(0) expectedBindingVersion!: number;
  @ApiProperty({ minimum: 0 }) @IsInt() @Min(0) expectedAccessEpoch!: number;
}
export class RebindDto extends ParticipationNoticeDto {
  @ApiProperty({ pattern: "^record:[a-f0-9-]{36}$" })
  @Matches(/^record:[a-f0-9-]{36}$/)
  supportCaseRef!: string;
  @ApiProperty({ format: "uuid" }) @IsUUID() targetUserId!: string;
  @ApiProperty({ minimum: 0 }) @IsInt() @Min(0) expectedBindingVersion!: number;
}
@Injectable()
export class Participation
  implements OnModuleDestroy, OnModuleInit, OnApplicationShutdown
{
  private revocationSweep: ReturnType<typeof setInterval> | undefined;
  private sweeping?: Promise<void>;
  private readonly db: PrismaClient;
  private readonly terms: ProjectServiceTerms;
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly identity: IdentityAccess,
    private readonly rights: PrivacyRights,
  ) {
    this.db = new PrismaClient({ datasourceUrl: config.databaseUrl });
    this.terms = new ProjectServiceTerms(config.databaseUrl);
  }
  onModuleInit() {
    if (
      !this.config.acceptance &&
      this.config.participation?.mode !== "synthetic-d08"
    )
      return;
    this.revocationSweep = setInterval(() => {
      if (this.sweeping) return;
      this.sweeping = this.reconcileRevocations()
        .catch(() => {})
        .finally(() => {
          this.sweeping = undefined;
        });
    }, 1000);
    this.revocationSweep.unref();
  }
  private policy() {
    if (
      !this.config.acceptance &&
      (this.config.environment !== "test" ||
        this.config.participation?.mode !== "synthetic-d08")
    )
      throw new ServiceUnavailableException();
  }
  private async project(
    tx: Prisma.TransactionClient,
    id: string,
    lock = false,
  ) {
    if (lock)
      await tx.$queryRaw`SELECT id FROM projects WHERE id=${id}::uuid FOR UPDATE`;
    await this.rights.requireAvailableIn(tx, id);
    const admission = await readProjectAdmissionIn(tx, id);
    return {
      ...admission.project,
      initiatorUserId: admission.initiatorUserId,
      source: admission.source,
      snapshot: admission.snapshot,
    };
  }
  private validateNotice(
    body: { noticeVersion: string; evidenceRef?: string },
    snapshot: Prisma.JsonObject,
  ) {
    const notice = participationNotice(snapshot, !!this.config.acceptance);
    if (
      body.noticeVersion !== notice.noticeVersion ||
      (body.evidenceRef !== undefined &&
        !body.evidenceRef.startsWith(notice.evidencePrefix))
    )
      throw new BadRequestException();
  }
  private async evidenceIn(
    tx: Prisma.TransactionClient,
    authorization: string | undefined,
    supplied: string,
  ) {
    if (!this.config.acceptance) return supplied;
    const context = await readSessionContextIn(tx, authorization);
    return `${context.method}:${context.sessionId}:${supplied}`;
  }
  private async subject(tx: Prisma.TransactionClient, id: string) {
    await tx.$queryRaw`SELECT id FROM project_subjects WHERE project_id=${id}::uuid FOR UPDATE`;
    const subject = await tx.projectSubject.findUnique({
      where: { projectId: id },
    });
    if (!subject) throw new NotFoundException();
    return subject;
  }
  async invite(id: string, authorization?: string) {
    const user = await this.identity.current(authorization);
    this.policy();
    const token = randomBytes(32).toString("base64url");
    const invite = await this.db.$transaction(async (tx) => {
      const p = await this.project(tx, id, true);
      if (p.initiatorUserId !== user.id) throw new ForbiddenException();
      await tx.invitation.updateMany({
        where: { projectId: id, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      return tx.invitation.create({
        data: {
          id: randomUUID(),
          projectId: id,
          tokenHash: digest(token),
          expiresAt: new Date(Date.now() + 86400000),
        },
      });
    });
    return { token, expiresAt: invite.expiresAt.toISOString() };
  }
  private async invitation(tx: Prisma.TransactionClient, token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new NotFoundException();
    const invite = await tx.invitation.findUnique({
      where: { tokenHash: digest(token) },
    });
    if (
      !invite ||
      invite.consumedAt ||
      invite.expiresAt.getTime() <= Date.now()
    )
      throw new NotFoundException();
    return invite;
  }
  async preview(token: string) {
    const invite = await this.invitation(this.db, token);
    const p = await this.project(this.db, invite.projectId);
    const giver = await this.db.user.findUnique({
      where: { id: p.initiatorUserId },
    });
    return {
      projectId: p.id,
      bookTitle: p.bookTitle ?? "时光故事书",
      inviter: giver?.nickname ?? "家人",
      process: ["记录故事", "一起编辑", "成书与印刷"],
      purposes: [],
      ...participationNotice(p.snapshot, !!this.config.acceptance),
      noticeVersion: TERMS_VERSION,
      source: p.source,
      choice: "接受邀请即同意使用条款，加入后可使用全部项目功能。",
    };
  }
  async apply(
    token: string,
    body: AcceptInvitationDto,
    authorization?: string,
  ) {
    this.policy();
    if (body.termsVersion !== TERMS_VERSION)
      throw new BadRequestException("请阅读当前使用条款");
    const relationship = body.relationship.trim();
    if (!relationship) throw new BadRequestException("请填写你是主讲人的谁");
    return this.db.$transaction(async (tx) => {
      const user = await this.identity.current(authorization, tx);
      const found = await this.invitation(tx, token);
      const p = await this.project(tx, found.projectId, true);
      const invite = await this.invitation(tx, token);
      await acceptTermsIn(tx, user.id, "invitation");
      const subject = await this.subject(tx, p.id);
      await this.terms.ensureSubjectParticipation(tx, p.id, subject.id);
      await tx.projectMember.upsert({
        where: { projectId_userId: { projectId: p.id, userId: user.id } },
        create: {
          projectId: p.id,
          userId: user.id,
          invitationId: invite.id,
          termsVersion: TERMS_VERSION,
          relationship,
        },
        update: { relationship },
      });
      return { projectId: p.id, state: "active" };
    });
  }
  async memberships(authorization?: string) {
    const user = await this.identity.current(authorization);
    const projects = await this.db.project.findMany({
      where: {
        OR: [
          { createdBy: user.id },
          { members: { some: { userId: user.id } } },
        ],
      },
      orderBy: { id: "asc" },
      select: {
        id: true,
        bookTitle: true,
        createdBy: true,
        orderId: true,
        gift: { select: { claimedByUserId: true } },
        members: { where: { userId: user.id }, select: { invitationId: true } },
      },
    });
    const orders = await this.db.paymentOrder.findMany({
      where: {
        id: { in: projects.flatMap((p) => (p.orderId ? [p.orderId] : [])) },
      },
      select: {
        id: true,
        bookTitle: true,
        purchaseKind: true,
        recipient: true,
      },
    });
    const orderById = new Map(orders.map((order) => [order.id, order]));
    const [givers, stories] = await Promise.all([
      this.db.user.findMany({
        where: { id: { in: projects.map((p) => p.createdBy) } },
        select: { id: true, nickname: true },
      }),
      this.db.story.groupBy({
        by: ["projectId"],
        where: {
          projectId: { in: projects.map((p) => p.id) },
          currentRevisionId: { not: null },
        },
        _count: true,
      }),
    ]);
    const names = new Map(
      givers.map((giver) => [giver.id, giver.nickname ?? "家人"]),
    );
    const counts = new Map(
      stories.map((story) => [story.projectId, story._count]),
    );
    return {
      projects: projects.map((p): ProjectMembership => {
        const order = orderById.get(p.orderId ?? "");
        const isSelfGift = order?.purchaseKind === "self";
        const categories: GiftCategory[] = [];
        if (p.createdBy === user.id) categories.push("sent");
        if (
          (isSelfGift && p.createdBy === user.id) ||
          p.gift?.claimedByUserId === user.id
        )
          categories.push("received");
        if (
          p.createdBy !== user.id &&
          p.members.some((member) => member.invitationId !== null)
        )
          categories.push("participating");
        return {
          projectId: p.id,
          bookTitle: p.bookTitle ?? order?.bookTitle ?? "时光故事书",
          state: "active",
          categories,
          isSelfGift,
          giftState:
            !order || isSelfGift
              ? null
              : p.gift?.claimedByUserId
                ? "claimed"
                : p.gift
                  ? "unclaimed"
                  : "unissued",
          giverNickname: names.get(p.createdBy) ?? "家人",
          giftRelationship:
            (order?.recipient as { relationshipLabel?: string } | null)
              ?.relationshipLabel ?? null,
          storyCount: counts.get(p.id) ?? 0,
        };
      }),
    };
  }
  async memberProfile(
    id: string,
    authorization?: string,
    body?: MemberRelationshipDto,
  ): Promise<ProjectMemberProfile> {
    return this.db.$transaction(async (tx) => {
      const user = await this.identity.current(authorization, tx);
      await this.project(tx, id, !!body);
      await requireProjectMemberIn(tx, id, user.id);
      const subject = await tx.projectSubject.findUnique({
        where: { projectId: id },
      });
      const isNarrator = subject?.boundUserId === user.id;
      if (body) {
        const relationship = body.relationship.trim();
        if (!relationship)
          throw new BadRequestException("请填写你是主讲人的谁");
        if (isNarrator) throw new BadRequestException("主讲人的关系为本人");
        await tx.projectMember.upsert({
          where: { projectId_userId: { projectId: id, userId: user.id } },
          create: {
            projectId: id,
            userId: user.id,
            termsVersion: TERMS_VERSION,
            relationship,
          },
          update: { relationship },
        });
      }
      const member = await tx.projectMember.findUnique({
        where: { projectId_userId: { projectId: id, userId: user.id } },
      });
      return {
        projectId: id,
        userId: user.id,
        nickname: user.nickname ?? "家人",
        relationship: isNarrator ? "本人" : (member?.relationship ?? null),
        isNarrator,
      };
    });
  }
  async requests(id: string, authorization?: string) {
    const user = await this.identity.current(authorization);
    return this.db.$transaction(async (tx) => {
      const p = await this.project(tx, id, true);
      if (p.initiatorUserId !== user.id) throw new ForbiddenException();
      const invitations = await tx.invitation.findMany({
        where: {
          projectId: id,
          consumedAt: null,
          expiresAt: { gt: new Date() },
        },
      });
      return {
        requests: await tx.bindingRequest.findMany({
          where: {
            invitationId: { in: invitations.map((i) => i.id) },
            state: "pending",
          },
          select: { id: true, applicantUserId: true, state: true },
        }),
      };
    });
  }
  async approve(
    id: string,
    body: ApprovalDto,
    key: string,
    requestId: string,
    authorization?: string,
  ) {
    const user = await this.identity.current(authorization);
    this.policy();
    return this.db.$transaction(async (tx) => {
      const application = await tx.bindingRequest.findUnique({ where: { id } });
      const invite = application
        ? await tx.invitation.findUnique({
            where: { id: application.invitationId },
          })
        : null;
      if (!application || !invite) throw new NotFoundException();
      const p = await this.project(tx, invite.projectId, true);
      if (
        p.initiatorUserId !== user.id ||
        application.applicantUserId === user.id
      )
        throw new ForbiddenException();
      const subject = await this.subject(tx, p.id);
      const hash = digest(JSON.stringify({ id, ...body }));
      const prior = await tx.participationCommand.findUnique({
        where: {
          projectId_action_key: { projectId: p.id, action: "approve", key },
        },
      });
      if (prior) {
        if (
          prior.operatorId !== user.id ||
          prior.requestHash !== hash ||
          prior.bindingVersion !== subject.bindingVersion ||
          subject.boundUserId !== application.applicantUserId
        )
          throw new ConflictException();
        return {
          projectId: p.id,
          bindingVersion: subject.bindingVersion,
          accessEpoch: p.accessEpoch,
        };
      }
      if (
        subject.boundUserId ||
        subject.bindingVersion !== body.expectedBindingVersion ||
        application.state !== "pending" ||
        invite.consumedAt ||
        invite.expiresAt.getTime() <= Date.now()
      )
        throw new ConflictException();
      const bound = await tx.projectSubject.update({
        where: { id: subject.id },
        data: {
          boundUserId: application.applicantUserId,
          bindingVersion: { increment: 1 },
        },
      });
      const updated = await tx.project.update({
        where: { id: p.id },
        data: { accessEpoch: { increment: 1 } },
      });
      await tx.bindingRequest.update({
        where: { id },
        data: { state: "approved", approvedBy: user.id },
      });
      await tx.invitation.updateMany({
        where: { projectId: p.id, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      await this.terms.ensureSubjectParticipation(tx, p.id, subject.id);
      await tx.participationCommand.create({
        data: {
          projectId: p.id,
          action: "approve",
          key,
          operatorId: user.id,
          requestHash: hash,
          bindingVersion: bound.bindingVersion,
          accessEpoch: updated.accessEpoch,
        },
      });
      await tx.bindingChange.create({
        data: {
          id: randomUUID(),
          projectId: p.id,
          subjectId: subject.id,
          toUserId: application.applicantUserId,
          sourceBindingVersion: subject.bindingVersion,
          bindingVersion: bound.bindingVersion,
          accessEpoch: updated.accessEpoch,
          operatorId: user.id,
          operatorRealm: "product",
          noticeVersion: application.noticeVersion,
          method: "initiator_review",
          evidenceRef: (await this.activeDataDeletedIn(tx, p.id))
            ? null
            : await this.evidenceIn(tx, authorization, body.evidenceRef),
          requestId,
        },
      });
      return {
        projectId: p.id,
        bindingVersion: bound.bindingVersion,
        accessEpoch: updated.accessEpoch,
      };
    });
  }
  async state(id: string, authorization?: string) {
    const user = await this.identity.current(authorization);
    return this.db.$transaction(async (tx) => {
      const p = await this.project(tx, id, true);
      const subject = await this.subject(tx, id);
      await requireProjectMemberIn(tx, id, user.id);
      return this.status(tx, p, subject, user.id);
    });
  }
  private async effectiveConsentIn(
    tx: Prisma.TransactionClient,
    p: Awaited<ReturnType<Participation["project"]>>,
    subject: Awaited<ReturnType<Participation["subject"]>>,
    record: Pick<
      ConsentRecord,
      | "purpose"
      | "granted"
      | "method"
      | "evidenceRef"
      | "operatorUserId"
      | "accessEpoch"
    >,
  ) {
    const denied = await tx.$queryRaw<
      { denied: boolean }[]
    >`SELECT EXISTS(SELECT 1 FROM privacy_events WHERE project_id=${p.id}::uuid AND kind='revocation' AND payload->>'operation'='revoke' AND payload->>'purpose' IN (${record.purpose},'all','binding') AND (payload->>'accessEpoch')::integer>${record.accessEpoch}) AS denied`;
    if (denied[0].denied) return false;
    if (record.method === "assisted") {
      const session = await this.latestAssisted(
        tx,
        p.id,
        record.purpose as ConsentPurpose,
      );
      if (session) {
        const denied = await tx.$queryRaw<
          { denied: boolean }[]
        >`SELECT EXISTS(SELECT 1 FROM privacy_events WHERE project_id=${p.id}::uuid AND payload->>'sourceSessionId'=${session.id}) AS denied`;
        if (denied[0].denied) return false;
      }
      return (
        record.granted &&
        this.activeAssisted(session, p, subject) &&
        session.evidenceRef === record.evidenceRef &&
        session.operatorUserId === record.operatorUserId
      );
    }
    return (
      record.granted && ["self_wechat", "self_web"].includes(record.method)
    );
  }
  /** The caller holds the project lock; a verification may only consume the
   * exact authorization sequence observed during that subject encounter. */
  async exportAccessSequenceIn(
    tx: Prisma.TransactionClient,
    projectId: string,
  ) {
    await this.rights.assertReplayed(projectId);
    await this.rights.requireAvailableIn(tx, projectId);
    const latest = await tx.projectAccessRevocation.findFirst({
      where: {
        projectId,
        OR: [
          { reason: { not: "assisted" } },
          { purpose: { in: ["collection", "sharing", "all", "binding"] } },
        ],
      },
      orderBy: { sequence: "desc" },
      select: { sequence: true },
    });
    return latest?.sequence ?? 0;
  }
  private async collectionStampIn(
    tx: Prisma.TransactionClient,
    p: Awaited<ReturnType<Participation["project"]>>,
    subject: Awaited<ReturnType<Participation["subject"]>>,
  ) {
    const record = await tx.consentRecord.findFirst({
      where: {
        projectId: p.id,
        bindingVersion: subject.bindingVersion,
        purpose: "collection",
      },
      orderBy: { sequence: "desc" },
    });
    return {
      choiceId: record?.id ?? null,
      allowed: record
        ? await this.effectiveConsentIn(tx, p, subject, record)
        : null,
    };
  }
  /** A verified, explicit export request made under the current unavailable
   * collection fact authorizes only that case. A stream sequence is no grant. */
  async exportPurposeAllowedIn(
    tx: Prisma.TransactionClient,
    projectId: string,
    caseId: string,
  ) {
    this.policy();
    const p = await this.project(tx, projectId, true),
      subject = await this.subject(tx, projectId),
      care = await tx.careRequest.findUnique({ where: { id: caseId } });
    if (
      !care ||
      care.kind !== "export" ||
      care.projectId !== projectId ||
      care.sourceBindingVersion !== subject.bindingVersion ||
      care.sourceAccessEpoch !== p.accessEpoch
    )
      return false;
    const current = await this.collectionStampIn(tx, p, subject);
    // The separately verified export case supplies recipient authority, so
    // ordinary buyer sharing is not a prerequisite or a substitute for it.
    if (current.allowed !== false) return true;
    return (
      !!care.verifiedBy &&
      ["verified", "completed"].includes(care.state) &&
      isDeepStrictEqual(care.exportCollectionStamp, current)
    );
  }
  private async currentPurposesIn(
    tx: Prisma.TransactionClient,
    p: Awaited<ReturnType<Participation["project"]>>,
    subject: Awaited<ReturnType<Participation["subject"]>>,
  ) {
    const records = await tx.consentRecord.findMany({
      where: { projectId: p.id, bindingVersion: subject.bindingVersion },
      orderBy: { sequence: "asc" },
      select: {
        subjectId: true,
        operatorUserId: true,
        operatorAdminId: true,
        purpose: true,
        granted: true,
        noticeVersion: true,
        method: true,
        evidenceRef: true,
        bindingVersion: true,
        accessEpoch: true,
        createdAt: true,
      },
    });
    const decisions = new Map(
      records.map((record) => [record.purpose, record]),
    );
    const granted = Object.fromEntries(
      [...decisions].map(([purpose, record]) => [purpose, record.granted]),
    );
    const enabled =
      !!this.config.acceptance ||
      (this.config.environment === "test" &&
        this.config.participation?.mode === "synthetic-d08");
    const effective: Partial<Record<ConsentPurpose, boolean>> = {};
    // Sequence orders the actual purpose decisions. Assisted choices produce
    // permission only while their latest matching session remains valid.
    for (const [key, record] of decisions) {
      const purpose = key as ConsentPurpose;
      effective[purpose] = await this.effectiveConsentIn(
        tx,
        p,
        subject,
        record,
      );
    }
    return { records, granted, enabled, effective };
  }
  private async status(
    tx: Prisma.TransactionClient,
    p: Awaited<ReturnType<Participation["project"]>>,
    subject: Awaited<ReturnType<Participation["subject"]>>,
    userId: string,
  ): Promise<ParticipationState> {
    const member = await isProjectMemberIn(tx, p.id, userId);
    const deleted = await this.rights.deletedIn(tx, p.id);
    const terms = await this.terms.read(p.id, tx);
    const canRead = member && !deleted;
    return {
      projectId: p.id,
      bookTitle: canRead ? (p.bookTitle ?? "时光故事书") : undefined,
      subjectId: subject.id,
      bindingVersion: subject.bindingVersion,
      accessEpoch: p.accessEpoch,
      role: "member",
      canInvite: p.initiatorUserId === userId,
      ...participationNotice(p.snapshot, !!this.config.acceptance),
      noticeVersion: TERMS_VERSION,
      source: p.source,
      choices: CONSENT_PURPOSES.map((purpose) => ({
        purpose,
        granted: canRead,
      })),
      consent: [],
      careAvailable: true,
      canCollect:
        canRead &&
        terms.canRecord &&
        terms.retention?.activeData?.state !== "deleted",
      canProcessAi:
        canRead &&
        terms.canRecord &&
        terms.retention?.transcripts?.state !== "deleted",
      canRead,
    };
  }
  async consent(
    id: string,
    body: ConsentDto | StartConsentDto,
    key: string,
    authorization?: string,
    action = "consent",
  ) {
    const user = await this.identity.current(authorization);
    this.policy();
    const granted = action === "start" || (body as ConsentDto).granted;
    const purposes =
      action === "start" ? CONSENT_PURPOSES : [(body as ConsentDto).purpose];
    const result = await this.db.$transaction(async (tx) => {
      const p = await this.project(tx, id, true);
      await this.rights.requireAvailableIn(tx, id);
      const subject = await this.subject(tx, id);
      this.validateNotice(body, p.snapshot);
      if (
        subject.boundUserId !== user.id ||
        subject.bindingVersion !== body.expectedBindingVersion
      )
        throw new ForbiddenException();
      const hash = digest(JSON.stringify(body));
      const prior = await tx.participationCommand.findUnique({
        where: { projectId_action_key: { projectId: id, action, key } },
      });
      if (prior) {
        if (
          prior.operatorId !== user.id ||
          prior.bindingVersion !== subject.bindingVersion ||
          prior.accessEpoch !== p.accessEpoch
        )
          throw new ForbiddenException();
        if (prior.requestHash !== hash) throw new ConflictException();
        return this.status(tx, p, subject, user.id);
      }
      if (p.accessEpoch !== body.expectedAccessEpoch)
        throw new ConflictException();
      const payloadDeleted = await this.activeDataDeletedIn(tx, id);
      if (payloadDeleted && granted)
        throw new ForbiddenException(
          "Deleted activity cannot acquire new authorization payload",
        );
      const updated = await tx.project.update({
        where: { id },
        // New positive purpose choices do not revoke existing capabilities.
        // Withdrawals advance the revocation fence and cannot revive old work.
        data: { accessEpoch: granted ? p.accessEpoch : { increment: 1 } },
      });
      const evidenceRef = payloadDeleted
        ? null
        : await this.evidenceIn(tx, authorization, body.evidenceRef);
      const method = await readSelfMethodIn(tx, authorization);
      for (const purpose of purposes)
        await tx.consentRecord.create({
          data: {
            id: randomUUID(),
            projectId: id,
            subjectId: subject.id,
            bindingVersion: subject.bindingVersion,
            accessEpoch: updated.accessEpoch,
            operatorUserId: user.id,
            granteeUserId: purpose === "sharing" ? p.initiatorUserId : null,
            purpose,
            granted,
            noticeVersion: body.noticeVersion,
            evidenceRef,
            method,
          },
        });
      if (!granted)
        await this.recordRevocationIn(
          tx,
          id,
          updated.accessEpoch,
          (body as ConsentDto).purpose,
          await readSelfMethodIn(tx, authorization),
        );
      await tx.participationCommand.create({
        data: {
          projectId: id,
          action,
          key,
          operatorId: user.id,
          requestHash: hash,
          bindingVersion: subject.bindingVersion,
          accessEpoch: updated.accessEpoch,
        },
      });
      return this.status(
        tx,
        { ...p, accessEpoch: updated.accessEpoch },
        subject,
        user.id,
      );
    });
    if (!granted) await this.reconcileRevocations(id);
    return result;
  }
  async care(
    id: string,
    authorization?: string,
    body?: CareRequestDto,
    key?: string,
  ) {
    const user = await this.identity.current(authorization);
    return this.db.$transaction(async (tx) => {
      const p = await this.project(tx, id, true);
      const subject = await this.subject(tx, id);
      await requireProjectMemberIn(tx, id, user.id);
      if (body) {
        this.policy();
        return this.createCare(
          tx,
          p,
          subject,
          body,
          key!,
          user.id,
          "product",
          subject.boundUserId === user.id ? user.id : null,
        );
      }
      return {
        requests: await tx.careRequest.findMany({
          where: { projectId: id },
          orderBy: { createdAt: "desc" },
          select: { id: true, kind: true, state: true, createdAt: true },
        }),
      };
    });
  }
  private async createCare(
    tx: Prisma.TransactionClient,
    p: Awaited<ReturnType<Participation["project"]>>,
    subject: Awaited<ReturnType<Participation["subject"]>>,
    body: CareRequestDto,
    key: string,
    operatorId: string,
    operatorRealm: "product" | "admin",
    requesterId: string | null,
  ) {
    if (body.purpose && body.kind !== "withdraw")
      throw new BadRequestException();
    const hash = digest(JSON.stringify(body));
    const prior = await tx.careRequest.findUnique({
      where: {
        projectId_operatorId_operatorRealm_idempotencyKey: {
          projectId: p.id,
          operatorId,
          operatorRealm,
          idempotencyKey: key,
        },
      },
    });
    if (prior) {
      if (prior.requestHash !== hash) throw new ConflictException();
      return { ...careView(prior), supportCaseRef: `record:${prior.id}` };
    }
    if (subject.bindingVersion !== body.expectedBindingVersion)
      throw new ConflictException();
    if (body.kind === "rebind") {
      if (body.targetUserId === p.initiatorUserId)
        throw new ForbiddenException();
      if (subject.boundUserId === body.targetUserId)
        throw new ConflictException();
      if (
        !(await tx.wechatIdentity.findFirst({
          where: {
            userId: body.targetUserId,
            appId: this.config.wechat?.appId,
          },
        }))
      )
        throw new NotFoundException();
    } else if (body.targetUserId) throw new BadRequestException();
    const row = await tx.careRequest.create({
      data: {
        id: randomUUID(),
        projectId: p.id,
        requesterId,
        requesterSubjectId: requesterId ? null : subject.id,
        operatorId,
        operatorRealm,
        targetUserId: body.targetUserId ?? null,
        sourceBindingVersion: subject.bindingVersion,
        sourceAccessEpoch: p.accessEpoch,
        kind: body.kind,
        ...(body.kind === "export"
          ? {
              exportCollectionStamp: await this.collectionStampIn(
                tx,
                p,
                subject,
              ),
            }
          : {}),
        withdrawalPurpose: body.purpose ?? null,
        idempotencyKey: key,
        requestHash: hash,
      },
      select: CARE_SELECT,
    });
    return { ...careView(row), supportCaseRef: `record:${row.id}` };
  }
  async openCareCase(
    tx: Prisma.TransactionClient,
    id: string,
    body: CareRequestDto,
    key: string,
    operatorId: string,
  ) {
    this.policy();
    const p = await this.project(tx, id, true);
    const subject = await this.subject(tx, id);
    return this.createCare(
      tx,
      p,
      subject,
      body,
      key,
      operatorId,
      "admin",
      null,
    );
  }
  // Content owners call this only while holding the real product session and subject locks.
  async openCorrectionCaseIn(
    tx: Prisma.TransactionClient,
    projectId: string,
    operatorUserId: string,
    key: string,
  ) {
    this.policy();
    const p = await this.project(tx, projectId, true),
      subject = await this.subject(tx, projectId);
    return this.createCare(
      tx,
      p,
      subject,
      { kind: "correction", expectedBindingVersion: subject.bindingVersion },
      key,
      operatorUserId,
      "product",
      subject.boundUserId === operatorUserId ? operatorUserId : null,
    );
  }
  async openExportCaseIn(
    tx: Prisma.TransactionClient,
    projectId: string,
    operatorUserId: string,
    key: string,
  ) {
    this.policy();
    const p = await this.project(tx, projectId, true),
      subject = await this.subject(tx, projectId);
    await requireProjectMemberIn(tx, projectId, operatorUserId);
    return this.createCare(
      tx,
      p,
      subject,
      { kind: "export", expectedBindingVersion: subject.bindingVersion },
      key,
      operatorUserId,
      "product",
      operatorUserId,
    );
  }
  async authorizeCorrectionCareIn(
    tx: Prisma.TransactionClient,
    caseId: string,
    operatorAdminId: string,
  ) {
    this.policy();
    const found = await tx.careRequest.findUnique({ where: { id: caseId } });
    if (!found) throw new NotFoundException();
    const p = await this.project(tx, found.projectId, true),
      subject = await this.subject(tx, p.id);
    await tx.$queryRaw`SELECT id FROM care_requests WHERE id=${caseId}::uuid FOR UPDATE`;
    const care = await tx.careRequest.findUniqueOrThrow({
      where: { id: caseId },
    });
    if (
      care.kind !== "correction" ||
      care.state !== "verified" ||
      care.verifiedBy !== operatorAdminId ||
      care.sourceBindingVersion !== subject.bindingVersion ||
      care.sourceAccessEpoch !== p.accessEpoch
    )
      throw new ForbiddenException();
    if (
      !(
        await this.status(tx, p, subject, care.requesterId ?? p.initiatorUserId)
      ).canRead
    )
      throw new ForbiddenException();
    return {
      projectId: p.id,
      subjectId: subject.id,
      bindingVersion: subject.bindingVersion,
      accessEpoch: p.accessEpoch,
    };
  }
  async verifyCare(
    tx: Prisma.TransactionClient,
    id: string,
    body: VerifyCareDto,
    key: string,
    operatorId: string,
  ) {
    this.policy();
    const found = await tx.careRequest.findUnique({ where: { id } });
    if (!found) throw new NotFoundException();
    if (
      found.kind === "delete" &&
      (await this.rights.deletedIn(tx, found.projectId))
    ) {
      if (
        found.state !== "verified" ||
        found.verificationKey !== key ||
        found.verificationHash !== digest(JSON.stringify(body)) ||
        found.verifiedBy !== operatorId
      )
        throw new ConflictException();
      return {
        id,
        state: "verified",
        currentAccessRevoked: true,
        fulfillment: "deletion-ledger",
      };
    }
    const p = await this.project(tx, found.projectId, true);
    const subject = await this.subject(tx, p.id);
    await tx.$queryRaw`SELECT id FROM care_requests WHERE id=${id}::uuid FOR UPDATE`;
    const care = (await tx.careRequest.findUnique({ where: { id } }))!;
    // Operational review and production cases are not D08 subject-right requests.
    if (["production_handoff", "quality"].includes(care.kind))
      throw new ConflictException();
    const verificationAccessSequence =
      care.kind === "export"
        ? await this.exportAccessSequenceIn(tx, p.id)
        : null;
    if (
      care.kind === "export" &&
      body.expectedAccessSequence !== verificationAccessSequence
    )
      throw new ConflictException(
        "Subject authorization changed; verify the subject again",
      );
    const hash = digest(JSON.stringify(body));
    const result = () => ({
      id,
      state: "verified",
      currentAccessRevoked: ["withdraw", "delete"].includes(care.kind),
      fulfillment:
        care.kind === "delete" ? "deletion-ledger" : "pending-consumer",
    });
    if (care.state === "verified") {
      if (
        care.verificationKey !== key ||
        care.verificationHash !== hash ||
        care.verifiedBy !== operatorId
      )
        throw new ConflictException();
      return result();
    }
    if (
      care.kind === "rebind" ||
      care.state !== "open" ||
      subject.bindingVersion !== body.expectedBindingVersion ||
      care.sourceBindingVersion !== subject.bindingVersion ||
      p.accessEpoch !== body.expectedAccessEpoch ||
      care.sourceAccessEpoch !== p.accessEpoch
    )
      throw new ConflictException();
    let epoch: number | null = null;
    const payloadDeleted = await this.activeDataDeletedIn(tx, p.id);
    if (["withdraw", "delete"].includes(care.kind)) {
      epoch = (
        await tx.project.update({
          where: { id: p.id },
          data: { accessEpoch: { increment: 1 } },
        })
      ).accessEpoch;
      for (const purpose of care.withdrawalPurpose
        ? [care.withdrawalPurpose]
        : CONSENT_PURPOSES)
        await tx.consentRecord.create({
          data: {
            id: randomUUID(),
            projectId: p.id,
            subjectId: subject.id,
            operatorAdminId: operatorId,
            bindingVersion: subject.bindingVersion,
            accessEpoch: epoch,
            purpose,
            granted: false,
            noticeVersion: body.noticeVersion,
            evidenceRef: payloadDeleted ? null : body.evidenceRef,
            method: "care_verified",
          },
        });
    }
    await tx.careRequest.update({
      where: { id },
      data: {
        state: "verified",
        verifiedBy: operatorId,
        verifiedAt: new Date(),
        verificationAccessSequence,
        verificationKey: key,
        verificationHash: hash,
        verificationEvidence: payloadDeleted ? null : body.evidenceRef,
        verificationNotice: payloadDeleted ? null : body.noticeVersion,
        revokedAccessEpoch: epoch,
      },
    });
    if (epoch !== null && care.kind !== "delete")
      await this.recordRevocationIn(
        tx,
        p.id,
        epoch,
        care.withdrawalPurpose ?? "all",
        "care_verified",
      );
    if (care.kind === "delete")
      await this.rights.deleteVerifiedIn(tx, {
        projectId: p.id,
        requestId: id,
        accessEpoch: epoch!,
        verification: { key, hash, adminId: operatorId },
      });
    return result();
  }
  async careCases(id?: string) {
    if (!id)
      return {
        requests: (
          await this.db.careRequest.findMany({
            orderBy: { createdAt: "desc" },
            take: 100,
            select: CARE_SELECT,
          })
        ).map(careView),
      };
    return this.db.$transaction(async (tx) => {
      const row = await tx.careRequest.findUnique({
        where: { id },
        select: {
          ...CARE_SELECT,
          verifiedBy: true,
          verifiedAt: true,
          verificationEvidence: true,
          verificationNotice: true,
          verificationAccessSequence: true,
          revokedAccessEpoch: true,
        },
      });
      if (!row) throw new NotFoundException();
      const payloadDeleted = await this.activeDataDeletedIn(tx, row.projectId);
      // Page context is observed now. The later command must return this exact
      // sequence, never have the server upgrade an old verification body.
      let verificationScope: { accessSequence: number } | undefined;
      if (row.kind === "export" && !payloadDeleted) {
        await this.project(tx, row.projectId, true);
        verificationScope = {
          accessSequence: await this.exportAccessSequenceIn(tx, row.projectId),
        };
      }
      const changes: CareBindingChangeView[] = (
        await tx.bindingChange.findMany({
          where: { supportCaseId: id },
          select: {
            subjectId: true,
            sourceBindingVersion: true,
            bindingVersion: true,
            accessEpoch: true,
            operatorId: true,
            supportCaseId: true,
            noticeVersion: true,
            method: true,
            evidenceRef: true,
            requestId: true,
            createdAt: true,
          },
        })
      ).map((change) => ({
        ...change,
        evidenceRef: payloadDeleted ? null : change.evidenceRef,
        createdAt: change.createdAt.toISOString(),
      }));
      return {
        ...careView(row),
        ...(verificationScope ? { verificationScope } : {}),
        supportCaseRef: `record:${id}`,
        correctionGrant: await tx.storyCareGrant.findUnique({
          where: { caseId: id },
          select: { storyId: true, expiresAt: true },
        }),
        verification: row.verifiedBy
          ? {
              operatorAdminId: row.verifiedBy,
              createdAt: row.verifiedAt?.toISOString(),
              evidenceRef: payloadDeleted ? null : row.verificationEvidence,
              noticeVersion: payloadDeleted ? null : row.verificationNotice,
              method: "care_verified",
              accessEpoch: row.revokedAccessEpoch,
              accessSequence: row.verificationAccessSequence,
            }
          : null,
        changes,
        withdrawal: await this.withdrawalStatusIn(tx, row.projectId),
      };
    });
  }
  async rebind(
    tx: Prisma.TransactionClient,
    id: string,
    body: RebindDto,
    key: string,
    operatorId: string,
    requestId: string,
  ) {
    this.policy();
    const p = await this.project(tx, id, true);
    const subject = await this.subject(tx, id);
    if (body.targetUserId === p.initiatorUserId) throw new ForbiddenException();
    const hash = digest(JSON.stringify(body));
    const prior = await tx.participationCommand.findUnique({
      where: { projectId_action_key: { projectId: id, action: "rebind", key } },
    });
    if (prior) {
      if (
        prior.requestHash !== hash ||
        prior.operatorId !== operatorId ||
        prior.bindingVersion !== subject.bindingVersion ||
        subject.boundUserId !== body.targetUserId
      )
        throw new ConflictException();
      return {
        projectId: id,
        subjectId: subject.id,
        bindingVersion: subject.bindingVersion,
        accessEpoch: p.accessEpoch,
      };
    }
    const caseId = body.supportCaseRef.slice(7);
    await tx.$queryRaw`SELECT id FROM care_requests WHERE id=${caseId}::uuid FOR UPDATE`;
    const care = await tx.careRequest.findUnique({ where: { id: caseId } });
    if (!care || care.projectId !== id) throw new NotFoundException();
    if (
      care.kind !== "rebind" ||
      subject.bindingVersion !== body.expectedBindingVersion ||
      care.sourceBindingVersion !== subject.bindingVersion ||
      care.targetUserId !== body.targetUserId ||
      care.state !== "open" ||
      subject.boundUserId === body.targetUserId
    )
      throw new ConflictException();
    const target = await tx.wechatIdentity.findFirst({
      where: { userId: body.targetUserId, appId: this.config.wechat?.appId },
    });
    if (!target) throw new NotFoundException();
    await this.terms.ensureSubjectParticipation(tx, id, subject.id);
    const rebound = await tx.projectSubject.update({
      where: { id: subject.id },
      data: {
        boundUserId: body.targetUserId,
        bindingVersion: { increment: 1 },
      },
    });
    const updated = await tx.project.update({
      where: { id },
      data: { accessEpoch: { increment: 1 } },
    });
    await tx.invitation.updateMany({
      where: { projectId: id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    await tx.careRequest.update({
      where: { id: caseId },
      data: { state: "completed", completedBy: operatorId },
    });
    await tx.bindingChange.create({
      data: {
        id: randomUUID(),
        projectId: id,
        subjectId: subject.id,
        fromUserId: subject.boundUserId,
        toUserId: body.targetUserId,
        sourceBindingVersion: subject.bindingVersion,
        bindingVersion: rebound.bindingVersion,
        accessEpoch: updated.accessEpoch,
        operatorId,
        operatorRealm: "admin",
        supportCaseId: caseId,
        noticeVersion: body.noticeVersion,
        method: "care_verified",
        evidenceRef: (await this.activeDataDeletedIn(tx, id))
          ? null
          : body.evidenceRef,
        requestId,
      },
    });
    await tx.participationCommand.create({
      data: {
        projectId: id,
        action: "rebind",
        key,
        operatorId,
        requestHash: hash,
        bindingVersion: rebound.bindingVersion,
        accessEpoch: updated.accessEpoch,
      },
    });
    await this.recordRevocationIn(
      tx,
      id,
      updated.accessEpoch,
      "binding",
      "rebind",
    );
    return {
      projectId: id,
      subjectId: subject.id,
      bindingVersion: rebound.bindingVersion,
      accessEpoch: updated.accessEpoch,
    };
  }
  async view(id: string, authorization?: string) {
    const user = await this.identity.current(authorization);
    return this.db.$transaction(async (tx) => {
      const p = await this.project(tx, id, true);
      const subject = await this.subject(tx, id);
      await requireProjectMemberIn(tx, id, user.id);
      const state = await this.status(tx, p, subject, user.id);
      if (!state.canRead) throw new ForbiddenException();
      const active = await this.materialAvailableIn(tx, id, "activeData");
      return {
        ...state,
        bookTitle: active
          ? (p.bookTitle ?? p.snapshot.bookTitle ?? "时光故事书")
          : null,
        subjectName: active ? subject.name : null,
      };
    });
  }
  async requireCreationIn(tx: Prisma.TransactionClient, projectId: string) {
    await this.requireMaterialIn(tx, projectId, "activeData");
    if (!(await this.terms.read(projectId, tx)).canRecord)
      throw new ForbiddenException("当前项目已停止制作服务，已有资料仍可查看");
  }
  async activeDataDeletedIn(tx: Prisma.TransactionClient, projectId: string) {
    if (await this.rights.deletedIn(tx, projectId, "activeData")) return true;
    const terms = await this.terms.read(projectId, tx);
    return terms.retention?.activeData?.state === "deleted";
  }
  // Plan callers keep authentication, current purpose/epoch checks and writes
  // under the same Session -> Project -> Subject lock order.
  async materialAvailableIn(
    tx: Prisma.TransactionClient,
    projectId: string,
    category: string,
  ) {
    if (await this.rights.deletedIn(tx, projectId, category)) return false;
    const terms = await this.terms.read(projectId, tx),
      rule = terms.retention?.[category];
    return !!rule && rule.state !== "deleted";
  }
  async requireMaterialIn(
    tx: Prisma.TransactionClient,
    projectId: string,
    category: string,
  ) {
    if (!(await this.materialAvailableIn(tx, projectId, category)))
      throw new ForbiddenException("Material retention is unavailable");
  }
  async withPlanAccess<T>(
    projectId: string,
    authorization: string | undefined,
    subjectDecision: { assistedSessionId?: string } | undefined,
    work: (
      tx: Prisma.TransactionClient,
      actor: {
        userId: string;
        bindingVersion: number;
        accessEpoch: number;
        subjectId: string;
        method: "self_wechat" | "self_web" | "assisted" | "participant";
        assistedSessionId?: string;
        accessExpiresAt: string | null;
        subjectDecision: "member" | "self" | "assisted" | null;
        decisionSessionId: string | null;
      },
    ) => Promise<T>,
  ): Promise<T> {
    this.policy();
    return this.db.$transaction(async (tx) => {
      const user = await this.identity.current(authorization, tx);
      const p = await this.project(tx, projectId, true);
      const subject = await this.subject(tx, projectId);
      await requireProjectMemberIn(tx, projectId, user.id);
      const state = await this.status(tx, p, subject, user.id);
      if (!state.canRead) throw new ForbiddenException();
      const method = await readSelfMethodIn(tx, authorization);
      return work(tx, {
        userId: user.id,
        bindingVersion: subject.bindingVersion,
        accessEpoch: p.accessEpoch,
        subjectId: subject.id,
        method,
        subjectDecision: "member",
        decisionSessionId: null,
        accessExpiresAt: null,
      });
    });
  }

  // Collection does not require sharing or AI. The real session is locked
  // before the project/subject; callers commit protected facts in this tx.
  async withCollectionAccess<T>(
    projectId: string,
    authorization: string | undefined,
    assistedSessionId: string | undefined,
    work: (
      tx: Prisma.TransactionClient,
      actor: {
        subjectId: string;
        operatorUserId: string;
        bindingVersion: number;
        accessEpoch: number;
        method: "self_wechat" | "self_web" | "assisted";
        assistedSessionId?: string;
      },
    ) => Promise<T>,
    mode: "record" | "existing" = "record",
  ): Promise<T> {
    this.policy();
    return this.db.$transaction(async (tx) => {
      const user = await this.identity.current(authorization, tx);
      const p = await this.project(tx, projectId, true);
      await this.rights.requireAvailableIn(tx, projectId);
      if (mode === "record")
        await this.requireMaterialIn(tx, projectId, "activeData");
      const subject = await this.subject(tx, projectId);
      await requireProjectMemberIn(tx, projectId, user.id);
      const state = await this.status(tx, p, subject, user.id);
      if (!(mode === "record" ? state.canCollect : state.canRead))
        throw new ForbiddenException("当前项目暂不能新增记录");
      return work(tx, {
        subjectId: subject.id,
        operatorUserId: user.id,
        bindingVersion: subject.bindingVersion,
        accessEpoch: p.accessEpoch,
        method: await readSelfMethodIn(tx, authorization),
      });
    });
  }

  /** Captured task identities stay denied across leases and later reauthorization.
   * Authorization callers serialize this check with the project lock. */
  async taskRevokedIn(
    tx: Prisma.TransactionClient,
    projectId: string,
    taskId: string,
  ) {
    return (
      (await tx.projectAccessRevocation.count({
        where: {
          projectId,
          captureVersion: 1,
          taskFences: { array_contains: [{ id: taskId }] },
        },
      })) > 0
    );
  }

  // Background processing has no user session to inherit. Its first current
  // purpose grant is frozen by the task owner; later claims and result writes
  // must still match those actual assisted sessions, including their expiry.
  async processingGrant(
    tx: Prisma.TransactionClient,
    input: {
      projectId: string;
      subjectId: string;
      bindingVersion: number;
      accessEpoch: number;
      sourceAssistedSessionId?: string | null;
      taskId?: string;
      processingGrant?: Prisma.JsonValue;
    },
  ): Promise<Prisma.JsonObject | null> {
    this.policy();
    if (
      (await this.rights.deletedIn(tx, input.projectId)) ||
      (await this.rights.deletedIn(tx, input.projectId, "originalAudio")) ||
      (await this.rights.deletedIn(tx, input.projectId, "transcripts"))
    )
      return null;
    const p = await this.project(tx, input.projectId, true);
    const subject = await this.subject(tx, input.projectId);
    if (
      subject.id !== input.subjectId ||
      subject.bindingVersion !== input.bindingVersion ||
      p.accessEpoch !== input.accessEpoch ||
      (input.taskId &&
        (await this.taskRevokedIn(tx, input.projectId, input.taskId)))
    )
      return null;
    const terms = await this.terms.read(p.id, tx);
    if (
      terms.retention?.activeData?.state === "deleted" ||
      terms.retention?.originalAudio?.state === "deleted" ||
      terms.retention?.transcripts?.state === "deleted"
    )
      return null;
    if (!terms.canRecord) return null;
    const grant: Prisma.JsonObject = {
      method: "project_terms",
      version: TERMS_VERSION,
    };

    if (
      input.processingGrant &&
      !isDeepStrictEqual(input.processingGrant, grant)
    )
      return null;
    return grant;
  }
  async processingAllowed(
    tx: Prisma.TransactionClient,
    input: Parameters<Participation["processingGrant"]>[1],
  ) {
    return !!(await this.processingGrant(tx, input));
  }

  // A dedicated care grant names its actual subject decision. Sharing with the
  // buyer is a separate purpose and cannot stand in for (or negate) this grant.
  async subjectCareGrantIn(
    tx: Prisma.TransactionClient,
    input: {
      projectId: string;
      subjectId: string;
      bindingVersion: number;
      accessEpoch: number;
      operatorUserId: string;
      assistedSessionId?: string | null;
    },
  ): Promise<boolean> {
    this.policy();
    const project = await this.project(tx, input.projectId, true),
      subject = await this.subject(tx, input.projectId);
    if (
      subject.id !== input.subjectId ||
      subject.bindingVersion !== input.bindingVersion ||
      project.accessEpoch !== input.accessEpoch
    )
      return false;
    return isProjectMemberIn(tx, input.projectId, input.operatorUserId);
  }
  /** Book rendering is local material processing, not a new AI submission. */
  async bookGrantIn(
    tx: Prisma.TransactionClient,
    input: {
      projectId: string;
      subjectId: string;
      bindingVersion: number;
      accessEpoch: number;
      operatorId: string;
      taskId?: string;
      processingGrant?: Prisma.JsonValue;
    },
  ): Promise<Prisma.JsonObject | null> {
    this.policy();
    if (
      (await this.rights.deletedIn(tx, input.projectId)) ||
      (await this.rights.deletedIn(tx, input.projectId, "bookPdf"))
    )
      return null;
    const project = await this.project(tx, input.projectId, true),
      subject = await this.subject(tx, input.projectId);
    if (
      subject.id !== input.subjectId ||
      subject.bindingVersion !== input.bindingVersion ||
      project.accessEpoch !== input.accessEpoch ||
      (input.taskId &&
        (await this.taskRevokedIn(tx, input.projectId, input.taskId))) ||
      !(await this.status(tx, project, subject, input.operatorId)).canRead
    )
      return null;
    const grant: Prisma.JsonObject = {
      operatorId: input.operatorId,
      termsVersion: TERMS_VERSION,
    };
    return input.processingGrant &&
      !isDeepStrictEqual(grant, input.processingGrant)
      ? null
      : grant;
  }

  private latestAssisted(
    tx: Prisma.TransactionClient,
    projectId: string,
    purpose: AssistedPurpose,
  ) {
    return tx.assistedSession.findFirst({
      where: { projectId, purpose },
      orderBy: { sequence: "desc" },
    });
  }
  private activeAssisted(
    row: AssistedSession | null,
    p: Awaited<ReturnType<Participation["project"]>>,
    subject: Awaited<ReturnType<Participation["subject"]>>,
  ): row is AssistedSession {
    return (
      !!row &&
      row.projectId === p.id &&
      row.subjectId === subject.id &&
      row.operatorUserId === p.initiatorUserId &&
      row.granted &&
      !!row.evidenceRef &&
      row.bindingVersion === subject.bindingVersion &&
      row.accessEpoch === p.accessEpoch &&
      row.expiresAt.getTime() > Date.now()
    );
  }
  // Public transactional boundary for authenticated content owners. They must
  // pass their real logged-in operator and keep this transaction through the
  // protected write. There is no preflight HTTP grant for content operations.
  async authorizeAssisted(
    tx: Prisma.TransactionClient,
    command: {
      projectId: string;
      sessionId: string;
      operatorUserId: string;
      purpose: (typeof ASSISTED_PURPOSES)[number];
      requireRecording?: boolean;
    },
  ) {
    this.policy();
    const p = await this.project(tx, command.projectId, true);
    const subject = await this.subject(tx, p.id);
    const row = await this.latestAssisted(tx, p.id, command.purpose);
    const denied = await tx.$queryRaw<
      { denied: boolean }[]
    >`SELECT EXISTS(SELECT 1 FROM privacy_events WHERE project_id=${p.id}::uuid AND payload->>'sourceSessionId'=${command.sessionId}) AS denied`;
    if (denied[0].denied) throw new ForbiddenException();
    if (
      !this.activeAssisted(row, p, subject) ||
      row.id !== command.sessionId ||
      row.operatorUserId !== command.operatorUserId
    )
      throw new ForbiddenException();
    if (
      command.purpose === "collection" &&
      command.requireRecording !== false &&
      !(await this.terms.read(p.id, tx)).canRecord
    )
      throw new ForbiddenException();
    return {
      subjectId: subject.id,
      operatorUserId: row.operatorUserId,
      bindingVersion: subject.bindingVersion,
      accessEpoch: p.accessEpoch,
    };
  }
  // The content owner supplies the actual immutable version/hash it has read
  // and validated, then writes its own confirmation in this same transaction.
  // This stores evidence only; it cannot manufacture or confirm content.
  async recordAssistedVersionEvidence(
    tx: Prisma.TransactionClient,
    command: {
      projectId: string;
      sessionId: string;
      operatorUserId: string;
      content: { kind: "story" | "book"; versionId: string; hash: string };
      // Content owners distinguish their actions even for the same version.
      // Omitted only by the existing evidence-only caller contract.
      action?:
        | "story_decision"
        | "story_care_access"
        | "production_handoff_access"
        | "quality_care_access";
      noticeVersion: string;
      evidenceRef: string;
      idempotencyKey: string;
    },
  ) {
    await this.requireMaterialIn(tx, command.projectId, "activeData");
    const purpose =
      command.content.kind === "story"
        ? "story_confirmation"
        : "book_confirmation";
    const actor = await this.authorizeAssisted(tx, { ...command, purpose });
    if (
      !["story", "book"].includes(command.content.kind) ||
      !/^[-a-f0-9]{36}$/.test(command.content.versionId) ||
      !/^([a-f0-9]{64})$/.test(command.content.hash) ||
      command.noticeVersion !==
        participationNotice(
          (await this.project(tx, command.projectId)).snapshot,
          !!this.config.acceptance,
        ).noticeVersion ||
      !/^(?:synthetic:|internal:)[^\r\n]{3,160}$/.test(command.evidenceRef) ||
      !/^[-A-Za-z0-9_:]{8,128}$/.test(command.idempotencyKey)
    )
      throw new BadRequestException();
    const hash = digest(JSON.stringify(command));
    const view = (row: {
      id: string;
      subjectId: string;
      operatorUserId: string;
      contentKind: string;
      versionId: string;
      contentHash: string;
      evidenceRef: string | null;
    }) => ({
      id: row.id,
      subjectId: row.subjectId,
      operatorUserId: row.operatorUserId,
      content: {
        kind: row.contentKind,
        versionId: row.versionId,
        hash: row.contentHash,
      },
      evidenceRef: row.evidenceRef,
    });
    const prior = await tx.assistedVersionEvidence.findUnique({
      where: {
        projectId_idempotencyKey: {
          projectId: command.projectId,
          idempotencyKey: command.idempotencyKey,
        },
      },
    });
    if (prior) {
      if (prior.requestHash !== hash) throw new ConflictException();
      return view(prior);
    }
    if (
      (await tx.assistedSession.findFirst({
        where: {
          projectId: command.projectId,
          evidenceRef: command.evidenceRef,
        },
      })) ||
      (await tx.assistedVersionEvidence.findFirst({
        where: {
          projectId: command.projectId,
          evidenceRef: command.evidenceRef,
        },
      }))
    )
      throw new ConflictException();
    return view(
      await tx.assistedVersionEvidence.create({
        data: {
          id: randomUUID(),
          projectId: command.projectId,
          ...actor,
          sessionId: command.sessionId,
          contentKind: command.content.kind,
          versionId: command.content.versionId,
          contentHash: command.content.hash,
          noticeVersion: command.noticeVersion,
          evidenceRef: command.evidenceRef,
          idempotencyKey: command.idempotencyKey,
          requestHash: hash,
        },
      }),
    );
  }
  private assistedView(
    row: {
      id: string;
      projectId: string;
      subjectId: string;
      operatorUserId: string;
      purpose: string;
      granted: boolean;
      noticeVersion: string;
      evidenceRef: string | null;
      bindingVersion: number;
      accessEpoch: number;
      createdAt: Date;
      expiresAt: Date;
    },
    bindingVersion: number,
    accessEpoch: number,
    latestSessionId: string,
    payloadDeleted: boolean,
  ): AssistedSessionView {
    return {
      id: row.id,
      projectId: row.projectId,
      subjectId: row.subjectId,
      operatorUserId: row.operatorUserId,
      purpose: row.purpose as AssistedPurpose,
      granted: row.granted,
      noticeVersion: row.noticeVersion,
      evidenceRef: payloadDeleted ? null : row.evidenceRef,
      bindingVersion: row.bindingVersion,
      accessEpoch: row.accessEpoch,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      state: !row.granted
        ? "rejected"
        : row.id !== latestSessionId ||
            row.bindingVersion !== bindingVersion ||
            row.accessEpoch !== accessEpoch
          ? "revoked"
          : payloadDeleted || row.expiresAt.getTime() <= Date.now()
            ? "expired"
            : "active",
    };
  }
  async assisted(
    id: string,
    authorization?: string,
    body?: AssistedSessionDto,
    key?: string,
  ) {
    const user = await this.identity.current(authorization);
    this.policy();
    const result = await this.db.$transaction(async (tx) => {
      const p = await this.project(tx, id, true);
      if (p.initiatorUserId !== user.id) throw new ForbiddenException();
      const subject = await this.subject(tx, id);
      const payloadDeleted = await this.activeDataDeletedIn(tx, id);
      if (!body) {
        const sessions = await tx.assistedSession.findMany({
          where: { projectId: id, operatorUserId: user.id },
          orderBy: { sequence: "desc" },
        });
        const latest = new Map<string, string>();
        for (const row of sessions)
          if (!latest.has(row.purpose)) latest.set(row.purpose, row.id);
        return {
          sessions: sessions.map((row) =>
            this.assistedView(
              row,
              subject.bindingVersion,
              p.accessEpoch,
              latest.get(row.purpose)!,
              payloadDeleted,
            ),
          ),
        };
      }
      this.validateNotice(body, p.snapshot);
      const latest = await this.latestAssisted(tx, id, body.purpose);
      const hash = digest(JSON.stringify(body));
      const prior = await tx.assistedSession.findUnique({
        where: {
          projectId_operatorUserId_idempotencyKey: {
            projectId: id,
            operatorUserId: user.id,
            idempotencyKey: key!,
          },
        },
      });
      if (prior) {
        if (prior.requestHash !== hash) throw new ConflictException();
        return this.assistedView(
          prior,
          subject.bindingVersion,
          p.accessEpoch,
          latest!.id,
          payloadDeleted,
        );
      }
      if (payloadDeleted && body.granted)
        throw new ForbiddenException(
          "Deleted activity cannot acquire new authorization payload",
        );
      if (
        (await tx.assistedSession.findFirst({
          where: { projectId: id, evidenceRef: body.evidenceRef },
        })) ||
        (await tx.assistedVersionEvidence.findFirst({
          where: { projectId: id, evidenceRef: body.evidenceRef },
        }))
      )
        throw new ConflictException();
      if (
        subject.bindingVersion !== body.expectedBindingVersion ||
        p.accessEpoch !== body.expectedAccessEpoch ||
        (latest?.id ?? null) !== (body.expectedSessionId ?? null)
      )
        throw new ConflictException();
      if (
        !body.granted &&
        !CONSENT_PURPOSES.includes(body.purpose as ConsentPurpose) &&
        latest
      ) {
        await this.rights.publishIn(tx, {
          eventId: randomUUID(),
          projectId: id,
          kind: "revocation",
          occurredAt: new Date().toISOString(),
          payload: {
            operation: "assisted_session_end",
            sourceSessionId: latest.id,
            purpose: body.purpose,
          },
        });
      }
      if (
        !body.granted &&
        CONSENT_PURPOSES.includes(body.purpose as ConsentPurpose)
      ) {
        await this.recordRevocationIn(
          tx,
          id,
          p.accessEpoch,
          body.purpose,
          "assisted",
          latest?.id,
        );
      }
      const evidenceRef = payloadDeleted
        ? null
        : await this.evidenceIn(tx, authorization, body.evidenceRef);
      const row = await tx.assistedSession.create({
        data: {
          id: randomUUID(),
          projectId: id,
          subjectId: subject.id,
          operatorUserId: user.id,
          purpose: body.purpose,
          granted: body.granted,
          noticeVersion: body.noticeVersion,
          evidenceRef,
          bindingVersion: subject.bindingVersion,
          accessEpoch: p.accessEpoch,
          idempotencyKey: key!,
          requestHash: hash,
          expiresAt: new Date(Date.now() + 15 * 60000),
        },
      });
      if (CONSENT_PURPOSES.includes(body.purpose as ConsentPurpose))
        await tx.consentRecord.create({
          data: {
            id: randomUUID(),
            projectId: id,
            subjectId: subject.id,
            bindingVersion: subject.bindingVersion,
            accessEpoch: p.accessEpoch,
            operatorUserId: user.id,
            granteeUserId: body.purpose === "sharing" ? user.id : null,
            purpose: body.purpose,
            granted: body.granted,
            noticeVersion: body.noticeVersion,
            evidenceRef,
            method: "assisted",
          },
        });
      if (body.granted)
        await this.terms.ensureSubjectParticipation(tx, id, subject.id);
      return this.assistedView(
        row,
        subject.bindingVersion,
        p.accessEpoch,
        row.id,
        payloadDeleted,
      );
    });
    if (body && !body.granted) await this.reconcileRevocations(id);
    return result;
  }
  private async recordRevocationIn(
    tx: Prisma.TransactionClient,
    projectId: string,
    accessEpoch: number,
    purpose: string,
    reason: string,
    sourceSessionId?: string,
  ) {
    // The caller holds the project lock. Capture the actual old work now,
    // rather than reconstructing its intended scope after a later regrant.
    const kinds =
      reason === "assisted" && purpose === "sharing"
        ? []
        : reason === "assisted" && purpose === "ai"
          ? ["transcribe_audio", "ask_followup", "compose_story"]
          : [
              "transcribe_audio",
              "ask_followup",
              "compose_story",
              "render_book",
            ];
    const taskFences = await tx.productionTask.findMany({
      where: {
        projectId,
        accessEpoch:
          reason === "assisted" ? { lte: accessEpoch } : { lt: accessEpoch },
        kind: { in: kinds },
        state: {
          notIn: [
            "succeeded",
            "no_speech",
            "no_content",
            "invalidated",
            "obsolete",
          ],
        },
      },
      select: { id: true, fence: true },
    });
    const attempt = ["collection", "sharing", "all"].includes(purpose)
      ? await tx.fulfillmentAttempt.findFirst({
          where: { projectId },
          orderBy: { sequence: "desc" },
          select: { id: true },
        })
      : null;
    const revocation = await tx.projectAccessRevocation.create({
      data: {
        id: randomUUID(),
        projectId,
        accessEpoch,
        purpose,
        reason,
        taskFences,
        sourceSessionId: sourceSessionId ?? null,
        targetAttemptId: attempt?.id ?? null,
      },
    });
    const binding =
      reason === "rebind"
        ? await tx.projectSubject.findUniqueOrThrow({
            where: { projectId },
            select: { id: true, bindingVersion: true, boundUserId: true },
          })
        : null;
    await this.rights.publishIn(tx, {
      eventId: revocation.id,
      projectId,
      kind: "revocation",
      occurredAt: revocation.createdAt.toISOString(),
      payload: {
        operation: "revoke",
        revocationId: revocation.id,
        sequence: revocation.sequence,
        accessEpoch,
        purpose,
        reason,
        taskFences,
        sourceSessionId: sourceSessionId ?? null,
        targetAttemptId: attempt?.id ?? null,
        ...(binding ? { binding } : {}),
      },
    });
  }
  async recordStoryDenialIn(
    tx: Prisma.TransactionClient,
    decision: Omit<Prisma.StoryDecisionUncheckedCreateInput, "evidenceRef">,
  ) {
    await this.rights.publishIn(tx, {
      eventId: decision.id!,
      projectId: decision.projectId,
      kind: "revocation",
      occurredAt: new Date().toISOString(),
      payload: { operation: "story_decision", decision },
    });
  }
  /** Recoverable follow-up. The denied purpose and exact work targets have already committed. */
  async reconcileRevocations(projectId?: string) {
    const changes = await this.db.projectAccessRevocation.findMany({
      where: {
        ...(projectId ? { projectId } : {}),
        appliedAt: null,
        captureVersion: 1,
      },
      orderBy: { sequence: "asc" },
      take: 100,
    });
    for (const change of changes) {
      closeProjectStreams(
        change.projectId,
        change.sequence,
        change.purpose,
        change.reason === "assisted",
      );
      await this.db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM projects WHERE id=${change.projectId}::uuid FOR UPDATE`;
        await tx.project.findUniqueOrThrow({ where: { id: change.projectId } });
        const current = await tx.projectAccessRevocation.findUniqueOrThrow({
          where: { id: change.id },
        });
        if (current.appliedAt) return;
        for (const target of current.taskFences as {
          id: string;
          fence: number;
        }[]) {
          const task = await tx.productionTask.findUnique({
            where: { id: target.id },
          });
          if (!task || task.projectId !== change.projectId) continue;
          const invalidated = await tx.productionTask.updateMany({
            where: {
              // A captured task is permanently denied. A worker lease may
              // have advanced its fence since capture; it is still that task.
              id: target.id,
              fence: task.fence,
              state: {
                notIn: [
                  "succeeded",
                  "no_speech",
                  "no_content",
                  "invalidated",
                  "obsolete",
                ],
              },
            },
            data: {
              state:
                task.kind === "transcribe_audio" ? "invalidated" : "obsolete",
              errorCode: "AUTHORIZATION_CHANGED",
              leaseUntil: null,
              fence: { increment: 1 },
            },
          });
          if (invalidated.count)
            await tx.taskAttempt.deleteMany({
              where: { taskId: target.id, state: "preparing" },
            });
        }
        let productionAction = "not_required";
        if (["collection", "sharing", "all"].includes(change.purpose)) {
          const attempt = current.targetAttemptId
            ? await tx.fulfillmentAttempt.findUnique({
                where: { id: current.targetAttemptId },
              })
            : null;
          productionAction = !attempt
            ? "not_started"
            : attempt.state === "delivered"
              ? "already_delivered"
              : ["approved", "cancelled"].includes(attempt.state)
                ? "stopped_before_handoff"
                : "supplier_pending";
          if (attempt && !["cancelled", "delivered"].includes(attempt.state)) {
            await tx.fulfillmentAttempt.update({
              where: { id: attempt.id },
              data: {
                state:
                  attempt.state === "approved"
                    ? "cancelled"
                    : "cancellation_pending",
              },
            });
            if (attempt.state === "approved")
              await tx.careRequest.update({
                where: { id: attempt.caseId },
                data: { state: "completed" },
              });
          }
        }
        await tx.projectAccessRevocation.update({
          where: { id: change.id },
          data: { appliedAt: new Date(), productionAction },
        });
      });
    }
  }
  private async withdrawalStatusIn(
    tx: Prisma.TransactionClient,
    projectId: string,
  ) {
    const project = await tx.project.findUniqueOrThrow({
      where: { id: projectId },
    });
    const rows = await tx.projectAccessRevocation.findMany({
      where: { projectId },
      orderBy: { sequence: "desc" },
      take: 50,
    });
    const attempt = await tx.fulfillmentAttempt.findFirst({
      where: { projectId },
      orderBy: { sequence: "desc" },
    });
    return {
      projectId,
      accessEpoch: project.accessEpoch,
      changes: rows.map((row) => ({
        id: row.id,
        accessEpoch: row.accessEpoch,
        purpose: row.purpose,
        reason: row.reason,
        applied: !!row.appliedAt,
        productionAction: row.productionAction,
        createdAt: row.createdAt.toISOString(),
      })),
      production: attempt
        ? {
            state: attempt.state,
            ownerAdminId: attempt.ownerAdminId,
            dueAt: attempt.dueAt.toISOString(),
            caseId: attempt.caseId,
          }
        : null,
      boundary:
        "已停止相关在线访问与新处理。印厂已收到的文件须人工核实取消；已导出文件、设备已接收字节和纸书不能远程收回。撤回不等于资料删除。",
    };
  }
  async withdrawalStatus(projectId: string, authorization?: string) {
    const user = await this.identity.current(authorization);
    await this.db.$transaction(async (tx) => {
      const p = await this.project(tx, projectId, true),
        subject = await this.subject(tx, projectId);
      await requireProjectMemberIn(tx, projectId, user.id);
    });
    await this.reconcileRevocations(projectId);
    return this.db.$transaction((tx) => this.withdrawalStatusIn(tx, projectId));
  }
  async onModuleDestroy() {
    if (this.revocationSweep) clearInterval(this.revocationSweep);
    await this.sweeping;
  }
  async onApplicationShutdown() {
    await this.db.$disconnect();
    await this.terms.close();
  }
}
@Controller("v1")
@ApiTags("Participation")
@ApiBearerAuth()
export class ParticipationController {
  constructor(private readonly participation: Participation) {}
  @Get("projects/:id/withdrawal-status")
  @Header("Cache-Control", "no-store")
  async withdrawalStatus(
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.participation.withdrawalStatus(
        id,
        req.headers.authorization,
      ),
      meta: { requestId: req.id },
    };
  }
  @Get("participations")
  @Header("Cache-Control", "no-store")
  async memberships(@Req() req: FastifyRequest) {
    return {
      data: await this.participation.memberships(req.headers.authorization),
      meta: { requestId: req.id },
    };
  }

  @Get("projects/:id/member-profile")
  @Header("Cache-Control", "no-store")
  async memberProfile(
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.participation.memberProfile(
        id,
        req.headers.authorization,
      ),
      meta: { requestId: req.id },
    };
  }
  @Post("projects/:id/member-profile")
  @Header("Cache-Control", "no-store")
  async setMemberProfile(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: MemberRelationshipDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.participation.memberProfile(
        id,
        req.headers.authorization,
        body,
      ),
      meta: { requestId: req.id },
    };
  }

  @Post("projects/:id/invitations")
  @Header("Cache-Control", "no-store")
  async invite(
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.participation.invite(id, req.headers.authorization),
      meta: { requestId: req.id },
    };
  }
  @Get("invitations/:token")
  @Header("Cache-Control", "no-store")
  @ApiOperation({
    summary: "Read public invitation participation information only",
    security: [],
  })
  async preview(@Param("token") token: string, @Req() req: FastifyRequest) {
    return {
      data: await this.participation.preview(token),
      meta: { requestId: req.id },
    };
  }
  @Post("invitations/:token/accept")
  @Header("Cache-Control", "no-store")
  async apply(
    @Param("token") token: string,
    @Body() body: AcceptInvitationDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.participation.apply(
        token,
        body,
        req.headers.authorization,
      ),
      meta: { requestId: req.id },
    };
  }

  @Get("projects/:id/participation")
  @Header("Cache-Control", "no-store")
  async state(
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.participation.state(id, req.headers.authorization),
      meta: { requestId: req.id },
    };
  }

  @Post("projects/:id/care-requests")
  @Header("Cache-Control", "no-store")
  async openCare(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: CareRequestDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.participation.care(
        id,
        req.headers.authorization,
        body,
        idempotencyKey(req),
      ),
      meta: { requestId: req.id },
    };
  }
  @Get("projects/:id/care-requests")
  @Header("Cache-Control", "no-store")
  async listCare(
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.participation.care(id, req.headers.authorization),
      meta: { requestId: req.id },
    };
  }
  @Get("projects/:id")
  @Header("Cache-Control", "no-store")
  async view(
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.participation.view(id, req.headers.authorization),
      meta: { requestId: req.id },
    };
  }
}
