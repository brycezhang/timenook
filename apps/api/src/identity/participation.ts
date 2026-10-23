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
  ForbiddenException,
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
} from "class-validator";
import { Prisma, PrismaClient } from "@prisma/client";
import type { FastifyRequest } from "fastify";
import { API_CONFIG, ApiConfig } from "../config";
import { IdentityAccess } from "./identity-access";
import { ProjectServiceTerms } from "../projects/service-terms";
import { idempotencyKey } from "../payments/orders";
import { CONSENT_PURPOSES } from "@timenook/contracts";
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const CARE_SELECT = {
  id: true,
  projectId: true,
  requesterId: true,
  targetUserId: true,
  sourceBindingVersion: true,
  kind: true,
  state: true,
  completedBy: true,
  createdAt: true,
} as const;
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
class CareRequestDto {
  @ApiProperty({ enum: ["rebind"] }) @Equals("rebind") kind!: "rebind";
  @ApiProperty({ format: "uuid" }) @IsUUID() targetUserId!: string;
  @ApiProperty({ minimum: 1 }) @IsInt() @Min(1) expectedBindingVersion!: number;
}
export class RebindDto extends ParticipationNoticeDto {
  @ApiProperty({ pattern: "^record:[a-f0-9-]{36}$" })
  @Matches(/^record:[a-f0-9-]{36}$/)
  supportCaseRef!: string;
  @ApiProperty({ format: "uuid" }) @IsUUID() targetUserId!: string;
  @ApiProperty({ minimum: 1 }) @IsInt() @Min(1) expectedBindingVersion!: number;
}
@Injectable()
export class Participation implements OnModuleDestroy {
  private readonly db: PrismaClient;
  private readonly terms: ProjectServiceTerms;
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly identity: IdentityAccess,
  ) {
    this.db = new PrismaClient({ datasourceUrl: config.databaseUrl });
    this.terms = new ProjectServiceTerms(config.databaseUrl);
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
      // The application explicitly records本人 participation; the server owns
      // both the stable fact key and timestamp, in this binding transaction.
      await this.terms.recordFact(
        {
          projectId: p.id,
          eventId: `subject-participation:${subject.id}`,
          kind: "subject_participation",
          occurredAt: new Date(),
        },
        tx,
      );
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
  private async status(
    tx: Prisma.TransactionClient,
    p: Awaited<ReturnType<Participation["project"]>>,
    subject: Awaited<ReturnType<Participation["subject"]>>,
    userId: string,
  ) {
    const narrator = subject.boundUserId === userId;
    const records = await tx.consentRecord.findMany({
      where: { projectId: p.id, bindingVersion: subject.bindingVersion },
      orderBy: { sequence: "asc" },
    });
    const granted = Object.fromEntries(
      records.map((record) => [record.purpose, record.granted]),
    );
    const enabled =
      this.config.environment === "test" &&
      this.config.participation?.mode === "synthetic-d08";
    const collection = enabled && granted.collection === true;
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
        granted: granted[purpose] ?? null,
      })),
      consent: narrator ? records : [],
      careAvailable: true,
      canCollect: narrator && collection && terms.canRecord,
      canProcessAi: narrator && collection && granted.ai === true,
      canRead:
        collection &&
        (narrator || (p.order.buyerId === userId && granted.sharing === true)),
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
    return this.db.$transaction(async (tx) => {
      const p = await this.project(tx, id, true);
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
      const updated = await tx.project.update({
        where: { id },
        data: { accessEpoch: { increment: 1 } },
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
          evidenceRef: body.evidenceRef,
          method: "self_wechat",
        },
      });
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
        const hash = digest(JSON.stringify(body));
        const prior = await tx.careRequest.findUnique({
          where: {
            projectId_requesterId_idempotencyKey: {
              projectId: id,
              requesterId: user.id,
              idempotencyKey: key!,
            },
          },
        });
        if (prior) {
          if (prior.requestHash !== hash) throw new ConflictException();
          return {
            id: prior.id,
            projectId: id,
            state: prior.state,
            supportCaseRef: `record:${prior.id}`,
          };
        }
        if (body.targetUserId === p.order.buyerId)
          throw new ForbiddenException();
        if (
          !subject.boundUserId ||
          subject.bindingVersion !== body.expectedBindingVersion ||
          body.targetUserId === subject.boundUserId
        )
          throw new ConflictException();
        const target = await tx.wechatIdentity.findFirst({
          where: {
            userId: body.targetUserId,
            appId: this.config.wechat?.appId,
          },
        });
        if (!target) throw new NotFoundException();
        const row = await tx.careRequest.create({
          data: {
            id: randomUUID(),
            projectId: id,
            requesterId: user.id,
            targetUserId: body.targetUserId,
            sourceBindingVersion: body.expectedBindingVersion,
            kind: "rebind",
            idempotencyKey: key!,
            requestHash: hash,
          },
          select: CARE_SELECT,
        });
        return { ...row, supportCaseRef: `record:${row.id}` };
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
  async careCases(id?: string) {
    if (!id)
      return {
        requests: await this.db.careRequest.findMany({
          orderBy: { createdAt: "desc" },
          take: 100,
          select: CARE_SELECT,
        }),
      };
    const row = await this.db.careRequest.findUnique({
      where: { id },
      select: CARE_SELECT,
    });
    if (!row) throw new NotFoundException();
    return {
      ...row,
      supportCaseRef: `record:${id}`,
      changes: await this.db.bindingChange.findMany({
        where: { supportCaseId: id },
      }),
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
      !subject.boundUserId ||
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
      return {
        ...state,
        bookTitle: p.order.bookTitle,
        subjectName: subject.name,
      };
    });
  }
  async onModuleDestroy() {
    await this.db.$disconnect();
    await this.terms.close();
  }
}
@Controller("v1")
@ApiTags("Participation")
@ApiBearerAuth()
export class ParticipationController {
  constructor(private readonly participation: Participation) {}
  @Get("participations")
  @Header("Cache-Control", "no-store")
  async memberships(@Req() req: FastifyRequest) {
    return {
      data: await this.participation.memberships(req.headers.authorization),
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
