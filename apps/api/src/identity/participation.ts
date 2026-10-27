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
  Equals,
  Matches,
  IsInt,
  Min,
  IsIn,
  IsBoolean,
  IsUUID,
  IsOptional,
  ValidateIf,
} from "class-validator";
import {
  Prisma,
  PrismaClient,
  type AssistedSession,
  type ConsentRecord,
} from "@prisma/client";
import type { FastifyRequest } from "fastify";
import { API_CONFIG, ApiConfig } from "../config";
import { IdentityAccess } from "./identity-access";
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
class ParticipationNoticeDto {
  @ApiProperty({ enum: ["synthetic-d08-v1"] })
  @Equals("synthetic-d08-v1")
  noticeVersion!: string;
  @ApiProperty({
    description:
      "Isolated synthetic evidence only; no real identity verification",
  })
  @IsString()
  @Matches(/^synthetic:[^\r\n]{3,160}$/)
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
  @Matches(/^synthetic:[^\r\n]{3,160}$/)
  evidenceRef!: string;
}
class RevokeDto extends ParticipationNoticeDto {
  @ApiProperty({ enum: CONSENT_PURPOSES })
  @IsIn(CONSENT_PURPOSES)
  purpose!: (typeof CONSENT_PURPOSES)[number];
  @ApiProperty({ minimum: 1 }) @IsInt() @Min(1) expectedBindingVersion!: number;
  @ApiProperty({ minimum: 0 }) @IsInt() @Min(0) expectedAccessEpoch!: number;
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
    if (this.config.participation?.mode !== "synthetic-d08") return;
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
      this.config.environment !== "test" ||
      this.config.participation?.mode !== "synthetic-d08"
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
    const p = await tx.project.findUnique({ where: { id } });
    await this.rights.requireAvailableIn(tx, id);
    const order = p?.orderId
      ? await tx.paymentOrder.findUnique({ where: { id: p.orderId } })
      : null;
    if (!p || !order || order.state !== "paid") throw new NotFoundException();
    return { ...p, order };
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
      if (p.order.buyerId !== user.id) throw new ForbiddenException();
      if ((await this.subject(tx, id)).boundUserId)
        throw new ConflictException();
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
    return {
      inviter: `发起人账号尾号 ${p.order.buyerId.slice(-6)}`,
      process: ["说一段", "保存后看看故事", "确认成书"],
      purposes: [...CONSENT_PURPOSES],
      noticeVersion: "synthetic-d08-v1",
      policyStatus: this.config.participation ? "synthetic-only" : "pending",
      choice:
        "采集保存讲述与照片；AI处理素材；向本项目发起人共享。可分别拒绝或撤回；入书须另行确认。请向邀请人核对账号尾号，提示不能替代本人核验。",
    };
  }
  async apply(
    token: string,
    body: ParticipationNoticeDto,
    authorization?: string,
  ) {
    const user = await this.identity.current(authorization);
    this.policy();
    return this.db.$transaction(async (tx) => {
      const found = await this.invitation(tx, token);
      const p = await this.project(tx, found.projectId, true);
      const invite = await this.invitation(tx, token);
      if (user.id === p.order.buyerId) throw new ForbiddenException();
      const application = await tx.bindingRequest.upsert({
        where: {
          invitationId_applicantUserId: {
            invitationId: invite.id,
            applicantUserId: user.id,
          },
        },
        create: {
          id: randomUUID(),
          invitationId: invite.id,
          applicantUserId: user.id,
          ...body,
        },
        update: {},
        select: { id: true, state: true },
      });
      return { ...application, projectId: p.id };
    });
  }
  async memberships(authorization?: string) {
    const user = await this.identity.current(authorization);
    const bound = await this.db.projectSubject.findMany({
      where: { boundUserId: user.id },
      select: { projectId: true },
    });
    const pending = await this.db.bindingRequest.findMany({
      where: { applicantUserId: user.id, state: "pending" },
    });
    const invitations = await this.db.invitation.findMany({
      where: {
        id: { in: pending.map((p) => p.invitationId) },
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { projectId: true },
    });
    return {
      projects: [
        ...bound.map((p) => ({ ...p, state: "bound" })),
        ...invitations
          .filter((p) => !bound.some((b) => b.projectId === p.projectId))
          .map((p) => ({ ...p, state: "pending" })),
      ],
    };
  }
  async requests(id: string, authorization?: string) {
    const user = await this.identity.current(authorization);
    return this.db.$transaction(async (tx) => {
      const p = await this.project(tx, id, true);
      if (p.order.buyerId !== user.id) throw new ForbiddenException();
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
        p.order.buyerId !== user.id ||
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
          evidenceRef: body.evidenceRef,
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
      if (p.order.buyerId !== user.id && subject.boundUserId !== user.id)
        throw new ForbiddenException();
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
    return record.granted && record.method === "self_wechat";
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
      this.config.environment === "test" &&
      this.config.participation?.mode === "synthetic-d08";
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
    const narrator = subject.boundUserId === userId;
    const { records, granted, enabled, effective } =
      await this.currentPurposesIn(tx, p, subject);
    const deleted = await this.rights.deletedIn(tx, p.id);
    const collection = !deleted && enabled && effective.collection === true;
    const terms = await this.terms.read(p.id, undefined, tx);
    return {
      projectId: p.id,
      subjectId: subject.id,
      bindingVersion: subject.bindingVersion,
      accessEpoch: p.accessEpoch,
      role: narrator ? "narrator" : "initiator",
      noticeVersion: "synthetic-d08-v1",
      policyStatus: enabled ? "synthetic-only" : "pending",
      choices: CONSENT_PURPOSES.map((purpose) => ({
        purpose,
        granted:
          effective[purpose] === false ? false : (granted[purpose] ?? null),
      })),
      consent: narrator
        ? records.map(({ operatorAdminId, ...record }) => ({
            ...record,
            ...(operatorAdminId ? { operatorAdminId } : {}),
            evidenceRef:
              terms.retention?.activeData?.state === "expired"
                ? null
                : record.evidenceRef,
            purpose: record.purpose as ConsentPurpose,
            createdAt: record.createdAt.toISOString(),
          }))
        : [],
      careAvailable: true,
      canCollect:
        narrator &&
        collection &&
        terms.canRecord &&
        terms.retention?.activeData?.state !== "expired",
      canProcessAi: narrator && collection && effective.ai === true,
      canRead:
        collection &&
        (narrator ||
          (p.order.buyerId === userId && effective.sharing === true)),
    };
  }
  async consent(
    id: string,
    body: ConsentDto,
    key: string,
    authorization?: string,
    action = "consent",
  ) {
    const user = await this.identity.current(authorization);
    this.policy();
    const result = await this.db.$transaction(async (tx) => {
      const p = await this.project(tx, id, true);
      await this.rights.requireAvailableIn(tx, id);
      const subject = await this.subject(tx, id);
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
      const payloadExpired = await this.rights.deletedIn(tx, id, "activeData");
      if (payloadExpired && body.granted)
        throw new ForbiddenException(
          "Expired activity cannot acquire new authorization payload",
        );
      const updated = await tx.project.update({
        where: { id },
        // New positive purpose choices do not revoke existing capabilities.
        // Withdrawals advance the revocation fence and cannot revive old work.
        data: { accessEpoch: body.granted ? p.accessEpoch : { increment: 1 } },
      });
      await tx.consentRecord.create({
        data: {
          id: randomUUID(),
          projectId: id,
          subjectId: subject.id,
          bindingVersion: subject.bindingVersion,
          accessEpoch: updated.accessEpoch,
          operatorUserId: user.id,
          granteeUserId: body.purpose === "sharing" ? p.order.buyerId : null,
          purpose: body.purpose,
          granted: body.granted,
          noticeVersion: body.noticeVersion,
          evidenceRef: payloadExpired ? null : body.evidenceRef,
          method: "self_wechat",
        },
      });
      if (!body.granted)
        await this.recordRevocationIn(
          tx,
          id,
          updated.accessEpoch,
          body.purpose,
          "self_wechat",
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
    if (!body.granted) await this.reconcileRevocations(id);
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
      if (p.order.buyerId !== user.id && subject.boundUserId !== user.id)
        throw new ForbiddenException();
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
      if (body.targetUserId === p.order.buyerId) throw new ForbiddenException();
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
    if (subject.boundUserId !== operatorUserId) throw new ForbiddenException();
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
      !(await this.status(tx, p, subject, care.requesterId ?? p.order.buyerId))
        .canRead
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
    if (
      ["first_copy_expiry", "production_handoff", "quality"].includes(care.kind)
    )
      throw new ConflictException();
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
    const payloadExpired = await this.rights.deletedIn(tx, p.id, "activeData");
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
            evidenceRef: payloadExpired ? null : body.evidenceRef,
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
        verificationKey: key,
        verificationHash: hash,
        verificationEvidence: payloadExpired ? null : body.evidenceRef,
        verificationNotice: payloadExpired ? null : body.noticeVersion,
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
    const row = await this.db.careRequest.findUnique({
      where: { id },
      select: {
        ...CARE_SELECT,
        verifiedBy: true,
        verifiedAt: true,
        verificationEvidence: true,
        verificationNotice: true,
        revokedAccessEpoch: true,
      },
    });
    if (!row) throw new NotFoundException();
    const changes: CareBindingChangeView[] = (
      await this.db.bindingChange.findMany({
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
      createdAt: change.createdAt.toISOString(),
    }));
    return {
      ...careView(row),
      supportCaseRef: `record:${id}`,
      correctionGrant: await this.db.storyCareGrant.findUnique({
        where: { caseId: id },
        select: { storyId: true, expiresAt: true },
      }),
      verification: row.verifiedBy
        ? {
            operatorAdminId: row.verifiedBy,
            createdAt: row.verifiedAt?.toISOString(),
            evidenceRef: row.verificationEvidence,
            noticeVersion: row.verificationNotice,
            method: "care_verified",
            accessEpoch: row.revokedAccessEpoch,
          }
        : null,
      changes,
      withdrawal: await this.db.$transaction((tx) =>
        this.withdrawalStatusIn(tx, row.projectId),
      ),
    };
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
    if (body.targetUserId === p.order.buyerId) throw new ForbiddenException();
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
        evidenceRef: body.evidenceRef,
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
      if (user.id !== p.order.buyerId && user.id !== subject.boundUserId)
        throw new ForbiddenException();
      const state = await this.status(tx, p, subject, user.id);
      if (!state.canRead) throw new ForbiddenException();
      const active = await this.materialAvailableIn(tx, id, "activeData");
      return {
        ...state,
        bookTitle: active ? p.order.bookTitle : null,
        subjectName: active ? subject.name : null,
      };
    });
  }
  // Plan callers keep authentication, current purpose/epoch checks and writes
  // under the same Session -> Project -> Subject lock order.
  async materialAvailableIn(
    tx: Prisma.TransactionClient,
    projectId: string,
    category: string,
  ) {
    if (await this.rights.deletedIn(tx, projectId, category)) return false;
    const terms = await this.terms.read(projectId, undefined, tx),
      rule = terms.retention?.[category];
    return !!rule && rule.state !== "expired";
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
        method: "self_wechat" | "assisted" | "participant";
        assistedSessionId?: string;
        accessExpiresAt: string | null;
        subjectDecision: "self" | "assisted" | null;
        decisionSessionId: string | null;
      },
    ) => Promise<T>,
  ): Promise<T> {
    this.policy();
    return this.db.$transaction(async (tx) => {
      const user = await this.identity.current(authorization, tx);
      const p = await this.project(tx, projectId, true);
      const subject = await this.subject(tx, projectId);
      if (user.id !== p.order.buyerId && user.id !== subject.boundUserId)
        throw new ForbiddenException();
      const state = await this.status(tx, p, subject, user.id);
      if (!state.canRead) throw new ForbiddenException();
      let method: "self_wechat" | "assisted" | "participant" = "participant";
      if (subjectDecision) {
        if (subject.boundUserId === user.id) method = "self_wechat";
        else {
          if (!subjectDecision.assistedSessionId)
            throw new ForbiddenException();
          await this.authorizeAssisted(tx, {
            projectId,
            sessionId: subjectDecision.assistedSessionId,
            operatorUserId: user.id,
            purpose: "collection",
          });
          method = "assisted";
        }
      }
      const sessions = await Promise.all(
        ["collection", "sharing"].map((purpose) =>
          this.latestAssisted(tx, projectId, purpose as AssistedPurpose),
        ),
      );
      const expiries = sessions
        .filter((row) => this.activeAssisted(row, p, subject))
        .map((row) => row!.expiresAt.getTime());
      const collectionSession = sessions[0];
      return work(tx, {
        userId: user.id,
        bindingVersion: subject.bindingVersion,
        accessEpoch: p.accessEpoch,
        subjectId: subject.id,
        method,
        subjectDecision:
          subject.boundUserId === user.id
            ? "self"
            : this.activeAssisted(collectionSession, p, subject)
              ? "assisted"
              : null,
        decisionSessionId: this.activeAssisted(collectionSession, p, subject)
          ? collectionSession.id
          : null,
        ...(method === "assisted"
          ? { assistedSessionId: subjectDecision!.assistedSessionId }
          : {}),
        accessExpiresAt: expiries.length
          ? new Date(Math.min(...expiries)).toISOString()
          : null,
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
        method: "self_wechat" | "assisted";
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
      let method: "self_wechat" | "assisted";
      if (subject.boundUserId === user.id) {
        const state = await this.status(tx, p, subject, user.id);
        if (!(mode === "record" ? state.canCollect : state.canRead))
          throw new ForbiddenException();
        method = "self_wechat";
      } else {
        if (!assistedSessionId || user.id !== p.order.buyerId)
          throw new ForbiddenException();
        await this.authorizeAssisted(tx, {
          projectId,
          sessionId: assistedSessionId,
          operatorUserId: user.id,
          purpose: "collection",
          requireRecording: mode === "record",
        });
        method = "assisted";
      }
      return work(tx, {
        subjectId: subject.id,
        operatorUserId: user.id,
        bindingVersion: subject.bindingVersion,
        accessEpoch: p.accessEpoch,
        method,
        ...(method === "assisted" ? { assistedSessionId } : {}),
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
    const terms = await this.terms.read(p.id, undefined, tx);
    if (
      terms.retention?.activeData?.state === "expired" ||
      terms.retention?.originalAudio?.state === "expired" ||
      terms.retention?.transcripts?.state === "expired"
    )
      return null;
    let grant: Prisma.JsonObject;
    if (subject.boundUserId) {
      if (
        !(await this.status(tx, p, subject, subject.boundUserId)).canProcessAi
      )
        return null;
      grant = { method: "self_wechat" };
    } else {
      const collection = await this.latestAssisted(tx, p.id, "collection");
      const ai = await this.latestAssisted(tx, p.id, "ai");
      if (
        !this.activeAssisted(collection, p, subject) ||
        !this.activeAssisted(ai, p, subject) ||
        (input.sourceAssistedSessionId &&
          collection.id !== input.sourceAssistedSessionId)
      )
        return null;
      await this.authorizeAssisted(tx, {
        projectId: p.id,
        sessionId: collection.id,
        operatorUserId: collection.operatorUserId,
        purpose: "collection",
      });
      await this.authorizeAssisted(tx, {
        projectId: p.id,
        sessionId: ai.id,
        operatorUserId: ai.operatorUserId,
        purpose: "ai",
      });
      grant = {
        method: "assisted",
        collectionSessionId: collection.id,
        aiSessionId: ai.id,
      };
    }
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
    const { enabled, effective } = await this.currentPurposesIn(
      tx,
      project,
      subject,
    );
    if (!enabled || effective.collection !== true) return false;
    if (subject.boundUserId === input.operatorUserId) return true;
    if (
      project.order.buyerId !== input.operatorUserId ||
      !input.assistedSessionId
    )
      return false;
    try {
      await this.authorizeAssisted(tx, {
        projectId: project.id,
        sessionId: input.assistedSessionId,
        operatorUserId: input.operatorUserId,
        purpose: "book_confirmation",
        requireRecording: false,
      });
      return true;
    } catch (error) {
      if (error instanceof ForbiddenException) return false;
      throw error;
    }
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
    const sessions = await Promise.all(
      ["collection", "sharing"].map((purpose) =>
        this.latestAssisted(tx, project.id, purpose as AssistedPurpose),
      ),
    );
    const grant: Prisma.JsonObject = {
      operatorId: input.operatorId,
      sessions: sessions
        .filter((row) => this.activeAssisted(row, project, subject))
        .map((row) => row!.id),
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
      row.operatorUserId === p.order.buyerId &&
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
      !(await this.terms.read(p.id, undefined, tx)).canRecord
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
    const purpose =
      command.content.kind === "story"
        ? "story_confirmation"
        : "book_confirmation";
    const actor = await this.authorizeAssisted(tx, { ...command, purpose });
    if (
      !["story", "book"].includes(command.content.kind) ||
      !/^[-a-f0-9]{36}$/.test(command.content.versionId) ||
      !/^([a-f0-9]{64})$/.test(command.content.hash) ||
      command.noticeVersion !== "synthetic-d08-v1" ||
      !/^synthetic:[^\r\n]{3,160}$/.test(command.evidenceRef) ||
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
  ): AssistedSessionView {
    return {
      id: row.id,
      projectId: row.projectId,
      subjectId: row.subjectId,
      operatorUserId: row.operatorUserId,
      purpose: row.purpose as AssistedPurpose,
      granted: row.granted,
      noticeVersion: row.noticeVersion,
      evidenceRef: row.evidenceRef,
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
          : row.expiresAt.getTime() <= Date.now()
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
      if (p.order.buyerId !== user.id) throw new ForbiddenException();
      const subject = await this.subject(tx, id);
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
            ),
          ),
        };
      }
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
        );
      }
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
      const row = await tx.assistedSession.create({
        data: {
          id: randomUUID(),
          projectId: id,
          subjectId: subject.id,
          operatorUserId: user.id,
          purpose: body.purpose,
          granted: body.granted,
          noticeVersion: body.noticeVersion,
          evidenceRef: body.evidenceRef,
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
            evidenceRef: body.evidenceRef,
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
        state: { notIn: ["succeeded", "no_speech", "invalidated", "obsolete"] },
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
                notIn: ["succeeded", "no_speech", "invalidated", "obsolete"],
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
      if (user.id !== p.order.buyerId && user.id !== subject.boundUserId)
        throw new ForbiddenException();
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
  @Post("projects/:id/assisted-sessions")
  @Header("Cache-Control", "no-store")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  async assisted(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: AssistedSessionDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.participation.assisted(
        id,
        req.headers.authorization,
        body,
        idempotencyKey(req),
      ),
      meta: { requestId: req.id },
    };
  }
  @Get("projects/:id/assisted-sessions")
  @Header("Cache-Control", "no-store")
  async assistedState(
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.participation.assisted(id, req.headers.authorization),
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
  @Post("invitations/:token/requests")
  @Header("Cache-Control", "no-store")
  async apply(
    @Param("token") token: string,
    @Body() body: ParticipationNoticeDto,
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
  @Get("projects/:id/binding-requests")
  @Header("Cache-Control", "no-store")
  async requests(
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.participation.requests(id, req.headers.authorization),
      meta: { requestId: req.id },
    };
  }
  @Post("binding-requests/:id/approve")
  @Header("Cache-Control", "no-store")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  async approve(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: ApprovalDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.participation.approve(
        id,
        body,
        idempotencyKey(req),
        req.id,
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
  @Post("projects/:id/consents")
  @Header("Cache-Control", "no-store")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  async consent(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: ConsentDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.participation.consent(
        id,
        body,
        idempotencyKey(req),
        req.headers.authorization,
      ),
      meta: { requestId: req.id },
    };
  }
  @Post("projects/:id/consents/revoke")
  @Header("Cache-Control", "no-store")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  async revoke(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: RevokeDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.participation.consent(
        id,
        { ...body, granted: false },
        idempotencyKey(req),
        req.headers.authorization,
        "revoke",
      ),
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
