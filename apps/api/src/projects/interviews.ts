import { invalidateStoryRecordingIn } from "../stories/stories";
import {
  Body,
  Controller,
  Get,
  Header,
  Inject,
  Injectable,
  OnModuleDestroy,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  BadRequestException,
  ConflictException,
  NotFoundException,
  ForbiddenException,
} from "@nestjs/common";
import { ApiBearerAuth, ApiProperty, ApiTags } from "@nestjs/swagger";
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  IsIn,
  IsObject,
} from "class-validator";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { FastifyRequest } from "fastify";
import { API_CONFIG, ApiConfig } from "../config";
import { Participation } from "../identity/participation";
import { claimRecordingCommand } from "../media/recording-command";
import { ProjectServiceTerms } from "./service-terms";
import { ProjectPlans, ProjectPlanError } from "./project-plans";
class InterviewCollectionDto {
  @ApiProperty({ required: false, format: "uuid" })
  @IsOptional()
  @IsUUID()
  assistedSessionId?: string;
}
class StartInterviewDto {
  @ApiProperty({ format: "uuid" }) @IsUUID() clientInterviewId!: string;
  @ApiProperty()
  @IsInt()
  @Min(1)
  @Max(2147483647)
  expectedPlanRevision!: number;
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  questionKey?: string;
  @ApiProperty({ required: false, enum: ["photo", "free-narration"] })
  @IsOptional()
  @IsIn(["photo", "free-narration"])
  starterKind?: "photo" | "free-narration";
  @ApiProperty({ required: false, type: Object })
  @IsOptional()
  @IsObject()
  selfWritten?: { text: string; intent: string; rewritesQuestionKey?: string };
  @ApiProperty({ required: false, format: "uuid" })
  @IsOptional()
  @IsUUID()
  assistedSessionId?: string;
}
@Injectable()
export class Interviews implements OnModuleDestroy {
  private readonly plans: ProjectPlans;
  private readonly terms: ProjectServiceTerms;
  constructor(
    @Inject(API_CONFIG) config: ApiConfig,
    private readonly participation: Participation,
  ) {
    this.plans = new ProjectPlans(config.databaseUrl);
    this.terms = new ProjectServiceTerms(config.databaseUrl);
  }
  private async view(
    tx: Prisma.TransactionClient,
    projectId: string,
    id: string,
  ) {
    const row = await tx.interview.findFirst({ where: { id, projectId } });
    if (!row) throw new NotFoundException();
    const state = await this.plans.readPersonalState(projectId, tx);
    return {
      id: row.id,
      projectId: row.projectId,
      subjectId: row.subjectId,
      createdAt: row.createdAt.toISOString(),
      actualQuestion: state.actualQuestions.find(
        (q) => q.id === row.actualQuestionId,
      ),
      clips: await tx.recordingIntent.findMany({
        where: { projectId, interviewId: id, state: "sealed" },
        select: { id: true, clientClipId: true, state: true },
      }),
      usage: await tx.recordingIntent
        .aggregate({
          where: { projectId },
          _sum: { reservedMs: true, consumedMs: true },
        })
        .then((sum) => ({
          reservedMs: sum._sum.reservedMs ?? 0,
          consumedMs: sum._sum.consumedMs ?? 0,
        })),
    };
  }
  async start(
    projectId: string,
    body: StartInterviewDto,
    authorization?: string,
    key?: string,
  ) {
    try {
      return await this.participation.withCollectionAccess(
        projectId,
        authorization,
        body.assistedSessionId,
        async (tx, actor) => {
          await claimRecordingCommand(
            tx,
            projectId,
            actor.operatorUserId,
            key,
            {
              kind: "interview",
              clientInterviewId: body.clientInterviewId,
              expectedPlanRevision: body.expectedPlanRevision,
              questionKey: body.questionKey,
              starterKind: body.starterKind,
              selfWritten: body.selfWritten
                ? {
                    text: body.selfWritten.text,
                    intent: body.selfWritten.intent,
                    rewritesQuestionKey: body.selfWritten.rewritesQuestionKey,
                  }
                : undefined,
            },
          );
          const prior = await tx.interview.findUnique({
            where: {
              projectId_clientInterviewId: {
                projectId,
                clientInterviewId: body.clientInterviewId,
              },
            },
          });
          if (
            prior &&
            (prior.subjectId !== actor.subjectId ||
              prior.bindingVersion !== actor.bindingVersion ||
              prior.accessEpoch !== actor.accessEpoch)
          )
            throw new ForbiddenException();
          const actual = await this.plans.captureActualQuestion(
            {
              id: prior?.actualQuestionId ?? randomUUID(),
              projectId,
              expectedPlanRevision: body.expectedPlanRevision,
              capturedBy: actor.operatorUserId,
              questionKey: body.questionKey,
              starterKind: body.starterKind,
              selfWritten: body.selfWritten,
            },
            tx,
          );
          const row =
            prior ??
            (await tx.interview.create({
              data: {
                id: randomUUID(),
                projectId,
                clientInterviewId: body.clientInterviewId,
                actualQuestionId: actual.id,
                ...actor,
              },
            }));
          await this.plans.linkActualAnswer(
            { projectId, actualQuestionId: actual.id, answerRef: row.id },
            tx,
          );
          return this.view(tx, projectId, row.id);
        },
      );
    } catch (error) {
      if (error instanceof ProjectPlanError) {
        if (["VERSION_CONFLICT", "IDEMPOTENCY_CONFLICT"].includes(error.code))
          throw new ConflictException();
        throw new BadRequestException();
      }
      throw error;
    }
  }
  read(projectId: string, id: string, authorization?: string) {
    return this.participation.withPlanAccess(
      projectId,
      authorization,
      undefined,
      (tx) => this.view(tx, projectId, id),
    );
  }
  private async recordingPlan(projectId: string, tx: Prisma.TransactionClient) {
    const plan = await this.plans.getProjectPlan(projectId, tx),
      state = await this.plans.readPersonalState(projectId, tx);
    const unavailable = new Set(
      state.questionStates
        .filter((q) => q.state !== "ready")
        .map((q) => q.questionKey),
    );
    const defaultQuestion =
      plan.chapters
        .flatMap((c) => c.questions)
        .find(
          (q) =>
            !unavailable.has(q.key) &&
            ![q.key, ...q.sensitivityTags].some((tag) =>
              plan.preferences.blockedTopics.includes(tag),
            ),
        ) ?? null;
    return {
      revision: plan.revision,
      defaultQuestion,
      starters: plan.starters,
    };
  }
  list(projectId: string, authorization?: string) {
    return this.participation.withPlanAccess(
      projectId,
      authorization,
      undefined,
      async (tx) => ({
        canRecord: (await this.terms.read(projectId, undefined, tx)).canRecord,
        plan: await this.recordingPlan(projectId, tx),
        interviews: await Promise.all(
          (
            await tx.interview.findMany({
              where: { projectId },
              orderBy: { createdAt: "desc" },
            })
          ).map((i) => this.view(tx, projectId, i.id)),
        ),
      }),
    );
  }
  context(
    projectId: string,
    body: { assistedSessionId?: string },
    authorization?: string,
  ) {
    return this.participation.withCollectionAccess(
      projectId,
      authorization,
      body.assistedSessionId,
      async (tx) => ({
        canRecord: (await this.terms.read(projectId, undefined, tx)).canRecord,
        plan: await this.recordingPlan(projectId, tx),
        interviews: [],
      }),
      "existing",
    );
  }
  recordingStart(
    projectId: string,
    id: string,
    body: { assistedSessionId?: string },
    authorization?: string,
  ) {
    return this.participation.withCollectionAccess(
      projectId,
      authorization,
      body.assistedSessionId,
      async (tx, actor) => {
        const row = await tx.interview.findFirst({ where: { projectId, id } });
        if (!row) throw new NotFoundException();
        if (
          row.subjectId !== actor.subjectId ||
          row.bindingVersion !== actor.bindingVersion ||
          row.accessEpoch !== actor.accessEpoch
        )
          throw new ForbiddenException();
        await invalidateStoryRecordingIn(tx, projectId, id);
        return { allowed: true };
      },
    );
  }
  resume(
    projectId: string,
    id: string,
    body: { assistedSessionId?: string },
    authorization?: string,
  ) {
    return this.participation.withCollectionAccess(
      projectId,
      authorization,
      body.assistedSessionId,
      async (tx, actor) => {
        const row = await tx.interview.findFirst({ where: { projectId, id } });
        if (
          !row ||
          row.subjectId !== actor.subjectId ||
          row.operatorUserId !== actor.operatorUserId ||
          row.accessEpoch !== actor.accessEpoch ||
          row.bindingVersion !== actor.bindingVersion
        )
          throw new ForbiddenException();
        const state = await this.plans.readPersonalState(projectId, tx);
        return {
          id: row.id,
          projectId,
          subjectId: row.subjectId,
          actualQuestion: state.actualQuestions.find(
            (q) => q.id === row.actualQuestionId,
          ),
          clips: await tx.recordingIntent.findMany({
            where: {
              projectId,
              interviewId: id,
              operatorUserId: actor.operatorUserId,
              state: "pending",
            },
            select: { id: true, clientClipId: true, state: true },
          }),
        };
      },
      "existing",
    );
  }
  async onModuleDestroy() {
    await this.plans.close();
    await this.terms.close();
  }
}
@Controller("v1/projects/:id/interviews")
@ApiTags("Interview recording")
@ApiBearerAuth()
export class InterviewsController {
  constructor(private readonly interviews: Interviews) {}
  @Post()
  @Header("Cache-Control", "no-store")
  async start(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() body: StartInterviewDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.interviews.start(
        id,
        body,
        req.headers.authorization,
        req.headers["idempotency-key"] as string | undefined,
      ),
      meta: { requestId: req.id },
    };
  }
  @Get() @Header("Cache-Control", "no-store") async list(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.interviews.list(id, req.headers.authorization),
      meta: { requestId: req.id },
    };
  }
  @Post("context") @Header("Cache-Control", "no-store") async context(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() body: InterviewCollectionDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.interviews.context(id, body, req.headers.authorization),
      meta: { requestId: req.id },
    };
  }
  @Post(":interviewId/recording-start")
  @Header("Cache-Control", "no-store")
  async recordingStart(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Param("interviewId", new ParseUUIDPipe()) interview: string,
    @Body() body: InterviewCollectionDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.interviews.recordingStart(
        id,
        interview,
        body,
        req.headers.authorization,
      ),
      meta: { requestId: req.id },
    };
  }
  @Post(":interviewId/resume")
  @Header("Cache-Control", "no-store")
  async resume(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Param("interviewId", new ParseUUIDPipe()) interview: string,
    @Body() body: InterviewCollectionDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.interviews.resume(
        id,
        interview,
        body,
        req.headers.authorization,
      ),
      meta: { requestId: req.id },
    };
  }
  @Get(":interviewId")
  @Header("Cache-Control", "no-store")
  async read(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Param("interviewId", new ParseUUIDPipe()) interviewId: string,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.interviews.read(
        id,
        interviewId,
        req.headers.authorization,
      ),
      meta: { requestId: req.id },
    };
  }
}
