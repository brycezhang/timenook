import { readSessionContextIn } from "../identity/identity-access";
import {
  Injectable,
  Controller,
  Post,
  Get,
  Body,
  Param,
  ParseUUIDPipe,
  Header,
  Req,
  ForbiddenException,
  ConflictException,
  BadRequestException,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiHeader,
  ApiProperty,
  ApiTags,
} from "@nestjs/swagger";
import {
  IsUUID,
  IsInt,
  Min,
  Matches,
  IsIn,
  IsISO8601,
  IsOptional,
} from "class-validator";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { FastifyRequest } from "fastify";
import { ADMIN_PERMISSIONS } from "@timenook/contracts";
import { Participation } from "../identity/participation";
import { AdminAccess } from "../admin/admin-access";
import { idempotencyKey } from "../payments/orders";
import { Stories, ReviseStoryDto } from "./stories";
class StoryCareDto {
  @ApiProperty({ format: "uuid" }) @IsUUID() revisionId!: string;
  @ApiProperty() @Matches(/^[a-f0-9]{64}$/) contentHash!: string;
  @ApiProperty() @IsInt() @Min(1) expectedVersion!: number;
  @ApiProperty() @IsISO8601() expiresAt!: string;
  @ApiProperty()
  @IsIn(["synthetic-d08-v1", "internal-participation-v1"])
  noticeVersion!: string;
  @ApiProperty()
  @Matches(/^(?:synthetic|internal):[^\r\n]{3,160}$/)
  evidenceRef!: string;
  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  assistedSessionId?: string;
}
@Injectable()
export class StoryCare {
  constructor(
    private readonly participation: Participation,
    private readonly stories: Stories,
  ) {}
  grant(
    projectId: string,
    id: string,
    body: StoryCareDto,
    authorization: string | undefined,
    key: string,
  ) {
    this.stories.validateNotice(body);
    return this.participation.withPlanAccess(
      projectId,
      authorization,
      undefined,
      async (tx, actor) => {
        await this.participation.requireMaterialIn(tx, projectId, "activeData");
        if (
          !Number.isFinite(Date.parse(body.expiresAt)) ||
          Date.parse(body.expiresAt) <= Date.now()
        )
          throw new BadRequestException();
        const story = await tx.story.findFirst({ where: { id, projectId } }),
          revision = await tx.storyRevision.findFirst({
            where: { id: body.revisionId, projectId, storyId: id },
          });
        if (
          !story ||
          !revision ||
          story.currentRevisionId !== revision.id ||
          story.version !== body.expectedVersion ||
          revision.contentHash !== body.contentHash
        )
          throw new ConflictException();
        if (actor.subjectDecision !== "self") {
          if (!body.assistedSessionId) throw new ForbiddenException();
          await this.participation.recordAssistedVersionEvidence(tx, {
            projectId,
            sessionId: body.assistedSessionId,
            operatorUserId: actor.userId,
            content: {
              kind: "story",
              versionId: revision.id,
              hash: revision.contentHash,
            },
            action: "story_care_access",
            noticeVersion: body.noticeVersion,
            evidenceRef: body.evidenceRef,
            idempotencyKey: key,
          });
        }
        const care = await this.participation.openCorrectionCaseIn(
            tx,
            projectId,
            actor.userId,
            key,
          ),
          requestHash = createHash("sha256")
            .update(JSON.stringify(body))
            .digest("hex");
        const prior = await tx.storyCareGrant.findUnique({
          where: { caseId: care.id },
        });
        if (prior) {
          if (prior.requestHash !== requestHash) throw new ConflictException();
          return prior;
        }
        const self =
          actor.subjectDecision === "self"
            ? await readSessionContextIn(tx, authorization)
            : null;
        const evidenceRef = body.evidenceRef.startsWith("internal:")
          ? self
            ? `${self.method}:${self.sessionId}:${body.evidenceRef}`
            : `assisted:${body.assistedSessionId}:${body.evidenceRef}`
          : body.evidenceRef;
        return tx.storyCareGrant.create({
          data: {
            caseId: care.id,
            projectId,
            storyId: id,
            revisionId: revision.id,
            subjectId: actor.subjectId,
            operatorUserId: actor.userId,
            bindingVersion: actor.bindingVersion,
            accessEpoch: actor.accessEpoch,
            expiresAt: new Date(body.expiresAt),
            noticeVersion: body.noticeVersion,
            evidenceRef,
            requestHash,
          },
        });
      },
    );
  }
  private async scope(
    tx: Prisma.TransactionClient,
    caseId: string,
    adminId: string,
  ) {
    const actor = await this.participation.authorizeCorrectionCareIn(
        tx,
        caseId,
        adminId,
      ),
      grant = await tx.storyCareGrant.findUnique({ where: { caseId } });
    if (
      !grant ||
      grant.projectId !== actor.projectId ||
      grant.subjectId !== actor.subjectId ||
      grant.bindingVersion !== actor.bindingVersion ||
      grant.accessEpoch !== actor.accessEpoch ||
      grant.expiresAt.getTime() <= Date.now()
    )
      throw new ForbiddenException();
    return grant;
  }
  async read(tx: Prisma.TransactionClient, caseId: string, adminId: string) {
    const grant = await this.scope(tx, caseId, adminId);
    return this.stories.view(tx, grant.projectId, grant.storyId);
  }
  async revise(
    tx: Prisma.TransactionClient,
    caseId: string,
    adminId: string,
    body: ReviseStoryDto,
    key: string,
  ) {
    const grant = await this.scope(tx, caseId, adminId);
    return this.stories.reviseIn(
      tx,
      grant.projectId,
      grant.storyId,
      body,
      { id: adminId, realm: "admin" },
      key,
    );
  }
}
@Controller("v1/projects/:id/stories/:storyId/care-access")
@ApiTags("Story correction access")
@ApiBearerAuth()
export class StoryCareController {
  constructor(private readonly care: StoryCare) {}
  @Post()
  @Header("Cache-Control", "no-store")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  async grant(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Param("storyId", new ParseUUIDPipe()) storyId: string,
    @Body() body: StoryCareDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.care.grant(
        id,
        storyId,
        body,
        req.headers.authorization,
        idempotencyKey(req),
      ),
      meta: { requestId: req.id },
    };
  }
}
@Controller("v1/admin/care-requests/:caseId/story")
@ApiTags("Administration story correction")
@ApiCookieAuth("timenook-admin")
export class AdminStoryCareController {
  constructor(
    private readonly care: StoryCare,
    private readonly access: AdminAccess,
  ) {}
  private run(
    req: FastifyRequest,
    action: string,
    work: (tx: Prisma.TransactionClient, id: string) => Promise<unknown>,
  ) {
    return this.access.run(action, req, async () => {
      const actor = await this.access.authorized(
        req,
        ADMIN_PERMISSIONS.writeCare,
      );
      return this.access.command(
        req,
        ADMIN_PERMISSIONS.writeCare,
        (tx) => work(tx, actor.adminId!),
        req.method === "GET",
      );
    });
  }
  @Get()
  @Header("Cache-Control", "no-store")
  async read(
    @Param("caseId", new ParseUUIDPipe()) caseId: string,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.run(req, "care.story.read", (tx, id) =>
        this.care.read(tx, caseId, id),
      ),
      meta: { requestId: req.id },
    };
  }
  @Post("revisions")
  @Header("Cache-Control", "no-store")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  async revise(
    @Param("caseId", new ParseUUIDPipe()) caseId: string,
    @Body() body: ReviseStoryDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.run(req, "care.story.revise", (tx, id) =>
        this.care.revise(tx, caseId, id, body, idempotencyKey(req)),
      ),
      meta: { requestId: req.id },
    };
  }
}
