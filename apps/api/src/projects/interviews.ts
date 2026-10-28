import { Followups, invalidateFollowupIn } from "../followups/followups";
import { invalidateStoryRecordingIn } from "../stories/stories";
import {
  Body,
  Controller,
  Get,
  Header,
  Inject,
  Injectable,
  OnModuleDestroy,
  Optional,
  ServiceUnavailableException,
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
class DisplayActualQuestionDto extends InterviewCollectionDto {
  @ApiProperty({ format: "uuid" }) @IsUUID() clientQuestionId!: string;
  @ApiProperty({ minimum: 1 }) @IsInt() @Min(1) expectedVersion!: number;
  @ApiProperty({ format: "uuid" }) @IsUUID() expectedActualQuestionId!: string;
  @ApiProperty({ minimum: 1 }) @IsInt() @Min(1) expectedPlanRevision!: number;
  @ApiProperty({ required: false, type: Object })
  @IsObject()
  @IsOptional()
  selfWritten?: { text: string; intent: string; rewritesQuestionKey?: string };
  @ApiProperty({ required: false, format: "uuid" })
  @IsOptional()
  @IsUUID()
  followupTaskId?: string;
}
class RecordingStartDto extends InterviewCollectionDto {
  @ApiProperty({ required: false, format: "uuid" })
  @IsOptional()
  @IsUUID()
  actualQuestionId?: string;
  @ApiProperty({ required: false, minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  expectedQuestionVersion?: number;
}
@Injectable()
export class Interviews implements OnModuleDestroy {
  private readonly plans: ProjectPlans;
  private readonly terms: ProjectServiceTerms;
  constructor(
    @Inject(API_CONFIG) config: ApiConfig,
    private readonly participation: Participation,
    @Optional() private readonly followups?: Followups,
  ) {
    this.plans = new ProjectPlans(config.databaseUrl);
    this.terms = new ProjectServiceTerms(config.databaseUrl);
  }
  private async view(
    tx: Prisma.TransactionClient,
    projectId: string,
    id: string,
    collectionOperatorId?: string,
  ) {
    await this.participation.requireMaterialIn(tx, projectId, "activeData");
    const row = await tx.interview.findFirst({ where: { id, projectId } });
    if (!row) throw new NotFoundException();
    const state = await this.plans.readPersonalState(projectId, tx);
    const history = await tx.interviewActualQuestion.findMany({
      where: { projectId, interviewId: id },
      orderBy: { sequence: "asc" },
    });
    return {
      id: row.id,
      projectId: row.projectId,
      subjectId: row.subjectId,
      createdAt: row.createdAt.toISOString(),
      actualQuestion: state.actualQuestions.find(
        (q) => q.id === row.actualQuestionId,
      ),
      currentQuestion: state.actualQuestions.find(
        (q) => q.id === history.at(-1)?.actualQuestionId,
      ),
      questionVersion: history.at(-1)?.sequence,
      ...(!collectionOperatorId
        ? {
            questionHistory: history.map((item) => ({
              sequence: item.sequence,
              parentActualQuestionId: item.parentActualQuestionId,
              question: state.actualQuestions.find(
                (q) => q.id === item.actualQuestionId,
              ),
            })),
          }
        : {}),
      clips: await tx.recordingIntent.findMany({
        where: {
          projectId,
          interviewId: id,
          ...(collectionOperatorId
            ? { state: "pending", operatorUserId: collectionOperatorId }
            : { state: "sealed" }),
        },
        select: {
          id: true,
          clientClipId: true,
          state: true,
          actualQuestionId: true,
        },
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
          if (!prior) {
            const owned = await tx.interview.findMany({
              where: {
                projectId,
                operatorUserId: actor.operatorUserId,
                id: { not: row.id },
              },
              select: { id: true },
            });
            await tx.followupSession.updateMany({
              where: {
                projectId,
                interviewId: { in: owned.map((i) => i.id) },
                ended: false,
              },
              data: { version: { increment: 1 }, ended: true },
            });
          }
          await this.plans.linkActualAnswer(
            { projectId, actualQuestionId: actual.id, answerRef: row.id },
            tx,
          );
          await tx.interviewActualQuestion.upsert({
            where: {
              projectId_interviewId_actualQuestionId: {
                projectId,
                interviewId: row.id,
                actualQuestionId: actual.id,
              },
            },
            create: {
              projectId,
              interviewId: row.id,
              actualQuestionId: actual.id,
              sequence: 1,
            },
            update: {},
          });
          return this.view(
            tx,
            projectId,
            row.id,
            actor.method === "assisted" ? actor.operatorUserId : undefined,
          );
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
  async displayQuestion(
    projectId: string,
    interviewId: string,
    body: DisplayActualQuestionDto,
    authorization?: string,
    key?: string,
  ) {
    try {
      return await this.participation.withCollectionAccess(
        projectId,
        authorization,
        body.assistedSessionId,
        async (tx, actor) => {
          const row = await tx.interview.findFirst({
            where: { projectId, id: interviewId },
          });
          if (!row) throw new NotFoundException();
          if (
            row.subjectId !== actor.subjectId ||
            row.bindingVersion !== actor.bindingVersion ||
            row.accessEpoch !== actor.accessEpoch ||
            (actor.method === "assisted" &&
              row.operatorUserId !== actor.operatorUserId)
          )
            throw new ForbiddenException();
          await claimRecordingCommand(
            tx,
            projectId,
            actor.operatorUserId,
            key,
            {
              kind: "display-question",
              interviewId,
              clientQuestionId: body.clientQuestionId,
              expectedVersion: body.expectedVersion,
              expectedActualQuestionId: body.expectedActualQuestionId,
              expectedPlanRevision: body.expectedPlanRevision,
              followupTaskId: body.followupTaskId,
              selfWritten: body.selfWritten
                ? {
                    text: body.selfWritten.text,
                    intent: body.selfWritten.intent,
                    ...(body.selfWritten.rewritesQuestionKey !== undefined
                      ? {
                          rewritesQuestionKey:
                            body.selfWritten.rewritesQuestionKey,
                        }
                      : {}),
                  }
                : undefined,
            },
          );
          const prior = await tx.interviewActualQuestion.findUnique({
            where: { actualQuestionId: body.clientQuestionId },
          });
          if (prior) {
            if (
              prior.projectId !== projectId ||
              prior.interviewId !== interviewId ||
              prior.sequence !== body.expectedVersion + 1 ||
              prior.parentActualQuestionId !== body.expectedActualQuestionId
            )
              throw new ConflictException();
          } else {
            const current = await tx.interviewActualQuestion.findFirst({
              where: { projectId, interviewId },
              orderBy: { sequence: "desc" },
            });
            if (
              current?.sequence !== body.expectedVersion ||
              current.actualQuestionId !== body.expectedActualQuestionId
            )
              throw new ConflictException();
          }
          if (body.followupTaskId && !this.followups)
            throw new ServiceUnavailableException();
          const source = body.followupTaskId
            ? await this.followups!.displaySourceIn(
                tx,
                projectId,
                interviewId,
                body.followupTaskId,
                !!prior,
                !!body.selfWritten,
              )
            : undefined;
          const selfWritten =
            body.selfWritten ??
            (source
              ? {
                  text: String(source.original.question),
                  intent: String(source.original.intent),
                }
              : undefined);
          if (!selfWritten) throw new BadRequestException();
          const actual = await this.plans.captureActualQuestion(
            {
              id: body.clientQuestionId,
              projectId,
              expectedPlanRevision: body.expectedPlanRevision,
              capturedBy: actor.operatorUserId,
              selfWritten,
              followupSource: source,
            },
            tx,
          );
          await this.plans.linkActualAnswer(
            { projectId, actualQuestionId: actual.id, answerRef: interviewId },
            tx,
          );
          if (!prior)
            await tx.interviewActualQuestion.create({
              data: {
                projectId,
                interviewId,
                actualQuestionId: actual.id,
                parentActualQuestionId: body.expectedActualQuestionId,
                sequence: body.expectedVersion + 1,
                followupTaskId: body.followupTaskId,
                followupSourceQuestionId: source?.sourceActualQuestionId,
              },
            });
          if (!prior) await invalidateFollowupIn(tx, projectId, interviewId);
          return this.view(
            tx,
            projectId,
            interviewId,
            actor.method === "assisted" ? actor.operatorUserId : undefined,
          );
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
      (tx) => this.listIn(tx, projectId),
    );
  }
  async listIn(tx: Prisma.TransactionClient, projectId: string) {
    await this.participation.requireMaterialIn(tx, projectId, "activeData");
    return {
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
    };
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
  private async assertCollectionInterviewIn(
    tx: Prisma.TransactionClient,
    projectId: string,
    id: string,
    actor: { subjectId: string; bindingVersion: number; accessEpoch: number },
  ) {
    const row = await tx.interview.findFirst({ where: { projectId, id } });
    if (!row) throw new NotFoundException();
    if (
      row.subjectId !== actor.subjectId ||
      row.bindingVersion !== actor.bindingVersion ||
      row.accessEpoch !== actor.accessEpoch
    )
      throw new ForbiddenException();
    return row;
  }
  collectionCheck(
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
        await this.assertCollectionInterviewIn(tx, projectId, id, actor);
        return { allowed: true };
      },
    );
  }
  recordingStart(
    projectId: string,
    id: string,
    body: RecordingStartDto,
    authorization?: string,
  ) {
    return this.participation.withCollectionAccess(
      projectId,
      authorization,
      body.assistedSessionId,
      async (tx, actor) => {
        const row = await this.assertCollectionInterviewIn(
          tx,
          projectId,
          id,
          actor,
        );
        const current = await tx.interviewActualQuestion.findFirst({
          where: { projectId, interviewId: id },
          orderBy: { sequence: "desc" },
        });
        if (
          !current ||
          (body.actualQuestionId ?? row.actualQuestionId) !==
            current.actualQuestionId ||
          (body.expectedQuestionVersion ?? 1) !== current.sequence
        )
          throw new ConflictException();
        await invalidateFollowupIn(tx, projectId, id);
        await invalidateStoryRecordingIn(tx, projectId, id);
        return {
          allowed: true,
          actualQuestionId: current.actualQuestionId,
          questionVersion: current.sequence,
        };
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
        return this.view(tx, projectId, row.id, actor.operatorUserId);
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
  @Post(":interviewId/actual-question")
  @Header("Cache-Control", "no-store")
  async displayQuestion(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Param("interviewId", new ParseUUIDPipe()) interviewId: string,
    @Body() body: DisplayActualQuestionDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.interviews.displayQuestion(
        id,
        interviewId,
        body,
        req.headers.authorization,
        req.headers["idempotency-key"] as string | undefined,
      ),
      meta: { requestId: req.id },
    };
  }
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
  @Post(":interviewId/collection-check")
  @Header("Cache-Control", "no-store")
  async collectionCheck(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Param("interviewId", new ParseUUIDPipe()) interview: string,
    @Body() body: InterviewCollectionDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.interviews.collectionCheck(
        id,
        interview,
        body,
        req.headers.authorization,
      ),
      meta: { requestId: req.id },
    };
  }
  @Post(":interviewId/recording-start")
  @Header("Cache-Control", "no-store")
  async recordingStart(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Param("interviewId", new ParseUUIDPipe()) interview: string,
    @Body() body: RecordingStartDto,
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
