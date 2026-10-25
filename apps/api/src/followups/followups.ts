import {
  Injectable,
  Inject,
  Controller,
  Post,
  Body,
  Param,
  Req,
  Header,
  HttpCode,
  ParseUUIDPipe,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ApiBearerAuth, ApiProperty, ApiTags } from "@nestjs/swagger";
import { IsUUID, IsInt, Min, IsOptional } from "class-validator";
import { Prisma, ProductionTask } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { FastifyRequest } from "fastify";
import { API_CONFIG, ApiConfig } from "../config";
import { Participation } from "../identity/participation";
import type {
  ActualPlanQuestion,
  PlanQuestionState,
  PlanContent,
} from "@timenook/contracts";
import { claimRecordingCommand } from "../media/recording-command";
import {
  effectiveDeepSeekBaseUrl,
  type StoryComposerInput,
} from "../probe/ai-providers";
type FollowupInput = Omit<StoryComposerInput, "transcripts" | "preferences"> & {
  currentQuestion: ActualPlanQuestion;
  history: ActualPlanQuestion[];
  transcripts: (StoryComposerInput["transcripts"][number] & {
    question: ActualPlanQuestion;
  })[];
  preferences: {
    version: number;
    blockedTopics: string[];
    questionStates: PlanQuestionState[];
  };
  planRevision: number;
};
const normalize = (v: string) =>
  v
    .normalize("NFKC")
    .replace(/[\p{P}\p{Z}\s]/gu, "")
    .toLowerCase();
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
class FollowupAccessDto {
  @ApiProperty({ required: false, format: "uuid" })
  @IsOptional()
  @IsUUID()
  assistedSessionId?: string;
}
class FinishFollowupDto extends FollowupAccessDto {
  @ApiProperty({ format: "uuid" }) @IsUUID() actualQuestionId!: string;
  @ApiProperty() @IsInt() @Min(1) expectedQuestionVersion!: number;
}
class RequestFollowupDto extends FollowupAccessDto {
  @ApiProperty({ format: "uuid" }) @IsUUID() clientRequestId!: string;
  @ApiProperty({ format: "uuid" }) @IsUUID() actualQuestionId!: string;
  @ApiProperty() @IsInt() @Min(1) expectedQuestionVersion!: number;
}
@Injectable()
export class Followups {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly participation: Participation,
  ) {}
  configuration() {
    const g = this.config.generation;
    return g
      ? {
          version: g.configVersion,
          baseUrl: effectiveDeepSeekBaseUrl(g.deepseek.baseUrl),
          model: g.deepseek.model,
          maxTokens: g.deepseek.maxTokens,
          credentialHash: hash(g.deepseek.apiKey),
          submissionReservationFen: g.submissionReservationFen,
          maxSubmissions: g.maxSubmissions,
          deadlineMs: g.deadlineMs,
          promptVersion: "t17-v1",
          outputContract: "t03-question-multiple-v1",
        }
      : { version: "unconfigured" };
  }
  private async interviewIn(
    tx: Prisma.TransactionClient,
    projectId: string,
    interviewId: string,
    actor: {
      subjectId: string;
      operatorUserId: string;
      bindingVersion: number;
      accessEpoch: number;
      method: string;
    },
  ) {
    const row = await tx.interview.findFirst({
      where: { projectId, id: interviewId },
    });
    if (
      !row ||
      row.subjectId !== actor.subjectId ||
      row.bindingVersion !== actor.bindingVersion ||
      row.accessEpoch !== actor.accessEpoch ||
      (actor.method === "assisted" &&
        row.operatorUserId !== actor.operatorUserId)
    )
      throw new ForbiddenException();
    return row;
  }
  async request(
    projectId: string,
    interviewId: string,
    body: RequestFollowupDto,
    authorization?: string,
    key?: string,
  ) {
    if (!this.config.generation) throw new ServiceUnavailableException();
    return this.participation.withCollectionAccess(
      projectId,
      authorization,
      body.assistedSessionId,
      async (tx, actor) => {
        const interview = await this.interviewIn(
          tx,
          projectId,
          interviewId,
          actor,
        );
        const session = await tx.followupSession.upsert({
          where: { projectId_interviewId: { projectId, interviewId } },
          create: { projectId, interviewId },
          update: {},
        });
        await claimRecordingCommand(tx, projectId, actor.operatorUserId, key, {
          kind: "followup",
          interviewId,
          clientRequestId: body.clientRequestId,
          actualQuestionId: body.actualQuestionId,
          expectedQuestionVersion: body.expectedQuestionVersion,
        });
        const prior = await tx.followupGeneration.findUnique({
          where: { taskId: body.clientRequestId },
        });
        if (prior) {
          if (
            prior.projectId !== projectId ||
            prior.interviewId !== interviewId ||
            prior.actualQuestionId !== body.actualQuestionId ||
            prior.questionVersion !== body.expectedQuestionVersion
          )
            throw new ConflictException();
          return this.viewIn(tx, projectId, interviewId, prior.taskId);
        }
        const history = await tx.interviewActualQuestion.findMany({
            where: { projectId, interviewId },
            orderBy: { sequence: "asc" },
          }),
          current = history.at(-1);
        if (
          current?.actualQuestionId !== body.actualQuestionId ||
          current.sequence !== body.expectedQuestionVersion
        )
          throw new ConflictException();
        if (
          !session.ended &&
          (await tx.recordingIntent.count({
            where: { projectId, interviewId, state: "pending" },
          }))
        )
          throw new ConflictException("Recordings are not all saved");
        const clips = session.ended
          ? []
          : await tx.recordingClip.findMany({
              where: { projectId, interviewId },
              orderBy: { sequence: "asc" },
            });
        if (
          !session.ended &&
          !clips.some((c) => c.actualQuestionId === current.actualQuestionId)
        )
          throw new ConflictException("Current answer transcript required");
        const transcripts = [],
          sources = [];
        let readyAt = 0;
        for (const clip of clips) {
          const transcript = await tx.formalTranscript.findUnique({
              where: { clipId: clip.id },
            }),
            task = transcript
              ? await tx.productionTask.findUnique({
                  where: { id: transcript.taskId },
                })
              : null;
          if (
            !transcript ||
            task?.state !== "succeeded" ||
            !transcript.text.trim()
          )
            throw new ConflictException("Transcript required");
          const question = await tx.actualPlanQuestion.findUniqueOrThrow({
            where: { id: clip.actualQuestionId },
          });
          transcripts.push({
            clipId: clip.id,
            transcript: transcript.text,
            transcriptHash: transcript.sha256,
            question,
          });
          sources.push({
            projectId,
            clipId: clip.id,
            interviewId,
            actualQuestionId: clip.actualQuestionId,
            assetId: clip.assetId,
            sequence: clip.sequence,
            transcriptionTaskId: transcript.taskId,
            inputHash: transcript.inputHash,
            transcriptHash: transcript.sha256,
          });
          readyAt = Math.max(readyAt, task.completedAt!.getTime());
        }
        const preferences = await tx.interviewPreferences.findUniqueOrThrow({
            where: { projectId },
          }),
          plan = await tx.project.findUniqueOrThrow({
            where: { id: projectId },
          });
        const questions = await Promise.all(
          history.map((h) =>
            tx.actualPlanQuestion.findUniqueOrThrow({
              where: { id: h.actualQuestionId },
            }),
          ),
        );
        const revision = await tx.planRevision.findUniqueOrThrow({
          where: {
            projectId_revision: { projectId, revision: plan.currentRevision },
          },
        });
        const relatedKeys = new Set(
          questions
            .flatMap((q) => [
              q.questionKey,
              (q.source as Prisma.JsonObject | null)?.rewritesQuestionKey,
            ])
            .filter((k) => typeof k === "string"),
        );
        const relatedChapters = (
          revision.content as unknown as PlanContent
        ).chapters
          .filter((c) => c.questions.some((q) => relatedKeys.has(q.key)))
          .map((c) => ({ key: c.key, title: c.title }));
        const input = {
          transcripts,
          relatedChapters,
          currentQuestion: questions.at(-1)!,
          history: questions,
          preferences,
          planRevision: plan.currentRevision,
        } as unknown as FollowupInput;
        const finishReason = session.ended
          ? "USER_FINISHED"
          : this.ruleFinish(input);
        const inputHash = hash(JSON.stringify(input));
        if (!finishReason) {
          const order = await tx.paymentOrder.findUniqueOrThrow({
              where: { id: plan.orderId! },
            }),
            d04 = (order.packageSnapshot as Prisma.JsonObject)
              .admission as Prisma.JsonObject;
          const policy = d04.d04 as Prisma.JsonObject,
            quota = (policy.userQuotas as Prisma.JsonObject)
              .followUps as Prisma.JsonObject;
          if (
            (policy.review as Prisma.JsonObject).state !== "frozen" ||
            quota.unit !== "count" ||
            !Number.isSafeInteger(quota.value)
          )
            throw new ServiceUnavailableException();

          const unresolved = await tx.productionTask.findFirst({
            where: {
              projectId,
              kind: "ask_followup",
              inputHash,
              state: {
                in: [
                  "queued",
                  "submitting",
                  "waiting_provider",
                  "manual_review",
                ],
              },
            },
            orderBy: { createdAt: "desc" },
          });
          if (unresolved)
            return this.viewIn(tx, projectId, interviewId, unresolved.id);
          if (
            (await tx.followupGeneration.count({
              where: { projectId, charged: true },
            })) >= Number(quota.value)
          )
            throw new ConflictException("Follow-up quota exhausted");
        }
        const selection = await tx.followupSession.update({
          where: { projectId_interviewId: { projectId, interviewId } },
          data: { version: { increment: 1 } },
        });
        const snapshot = this.configuration(),
          taskId = body.clientRequestId;
        const task = await tx.productionTask.create({
          data: {
            id: taskId,
            projectId,
            kind: "ask_followup",
            state: finishReason ? "succeeded" : "queued",
            completedAt: finishReason ? new Date() : undefined,
            subjectId: interview.subjectId,
            bindingVersion: interview.bindingVersion,
            accessEpoch: interview.accessEpoch,
            inputHash,
            providerRequestId: randomUUID(),
            configuration: snapshot,
            configurationHash: hash(JSON.stringify(snapshot)),
            deadline: new Date(Date.now() + this.config.generation!.deadlineMs),
          },
        });
        await tx.followupGeneration.create({
          data: {
            taskId,
            followupVersion: selection.version,
            projectId,
            interviewId,
            actualQuestionId: current.actualQuestionId,
            questionVersion: current.sequence,
            planRevision: plan.currentRevision,
            preferenceVersion: preferences.version,
            input: JSON.parse(JSON.stringify(input)),
            transcriptsReadyAt: readyAt ? new Date(readyAt) : null,
            finishReason,
            charged: !finishReason,
          },
        });
        for (const source of sources)
          await tx.followupSource.create({ data: { taskId, ...source } });
        if (!finishReason) {
          const grant = await this.grantIn(tx, task);
          if (!grant) throw new ForbiddenException();
          await tx.productionTask.update({
            where: { id: taskId },
            data: { processingGrant: grant },
          });
          await tx.taskOutbox.create({ data: { id: randomUUID(), taskId } });
        }
        return this.viewIn(tx, projectId, interviewId, taskId);
      },
      "existing",
    );
  }
  private ruleFinish(input: FollowupInput): string | null {
    const q = input.currentQuestion,
      snapshot = q.snapshot;
    const key = q.questionKey ?? q.source?.rewritesQuestionKey;
    const state = input.preferences.questionStates.find(
      (s) => s.questionKey === key,
    )?.state;
    if (state === "not-applicable") return "NOT_APPLICABLE";
    if (state === "skipped" || state === "later") return "DECLINED";
    // D09 has no reviewed topic classifier or fallback candidates yet. Keep optional generation closed when any topic is blocked.
    if (input.preferences.blockedTopics.length) return "BLOCKED_TOPIC";
    if (
      input.history
        .slice(0, -1)
        .some((h) => normalize(h.snapshot.text) === normalize(snapshot.text))
    )
      return "REPEATED_QUESTION";
    // A later segment such as a water break cannot erase an explicit stop in this story's frozen input.
    if (
      input.transcripts.some((t) =>
        /(?:不想|不愿(?:意)?)(?:再)?(?:说|谈|回答|聊)|不要(?:再)?(?:问|追问)/.test(
          t.transcript,
        ),
      )
    )
      return "DECLINED";
    if (
      input.transcripts.some((t) =>
        /(?:说完了|讲完了|就到这里|结束吧)/.test(t.transcript),
      )
    )
      return "USER_FINISHED";
    return null;
  }
  async grantIn(
    tx: Prisma.TransactionClient,
    task: ProductionTask,
  ): Promise<Prisma.JsonObject | null> {
    if (
      !(await this.participation.processingGrant(tx, {
        ...task,
        processingGrant: undefined,
      }))
    )
      return null;
    const g = await tx.followupGeneration.findUniqueOrThrow({
        where: { taskId: task.id },
      }),
      p = await tx.project.findUniqueOrThrow({ where: { id: task.projectId } }),
      prefs = await tx.interviewPreferences.findUniqueOrThrow({
        where: { projectId: task.projectId },
      }),
      q = await tx.interviewActualQuestion.findFirst({
        where: { projectId: task.projectId, interviewId: g.interviewId },
        orderBy: { sequence: "desc" },
      });
    const session = await tx.followupSession.findUniqueOrThrow({
      where: {
        projectId_interviewId: {
          projectId: task.projectId,
          interviewId: g.interviewId,
        },
      },
    });
    if (
      session.ended ||
      session.version !== g.followupVersion ||
      p.currentRevision !== g.planRevision ||
      prefs.version !== g.preferenceVersion ||
      q?.actualQuestionId !== g.actualQuestionId ||
      q.sequence !== g.questionVersion ||
      (await tx.recordingIntent.count({
        where: {
          projectId: task.projectId,
          interviewId: g.interviewId,
          state: "pending",
        },
      }))
    )
      return null;
    const sources = await tx.followupSource.findMany({
        where: { taskId: task.id },
        orderBy: { sequence: "asc" },
      }),
      clips = await tx.recordingClip.findMany({
        where: { projectId: task.projectId, interviewId: g.interviewId },
        orderBy: { sequence: "asc" },
      });
    if (
      !isDeepStrictEqual(
        clips.map((c) => c.id),
        sources.map((s) => s.clipId),
      )
    )
      return null;
    const grants: Prisma.JsonObject[] = [];
    for (const clip of clips) {
      const grant = await this.participation.processingGrant(tx, {
        ...task,
        processingGrant: undefined,
        sourceAssistedSessionId: clip.assistedSessionId,
      });
      if (!grant) return null;
      grants.push({ clipId: clip.id, grant });
    }
    const grant = { sources: grants };
    return task.processingGrant &&
      !isDeepStrictEqual(task.processingGrant, grant)
      ? null
      : grant;
  }
  async inputsIn(tx: Prisma.TransactionClient, task: ProductionTask) {
    const row = await tx.followupGeneration.findUniqueOrThrow({
      where: { taskId: task.id },
    });
    return {
      state: "ready",
      errorCode: null,
      input: row.input as unknown as StoryComposerInput,
    };
  }
  async displaySourceIn(
    tx: Prisma.TransactionClient,
    projectId: string,
    interviewId: string,
    taskId: string,
    replay = false,
    userRewrite = false,
  ) {
    const g = await tx.followupGeneration.findUnique({ where: { taskId } }),
      task = await tx.productionTask.findUnique({ where: { id: taskId } });
    const result = g?.result as Prisma.JsonObject | null;
    const current = userRewrite
      ? await tx.interviewActualQuestion.findFirst({
          where: { projectId, interviewId },
          orderBy: { sequence: "desc" },
        })
      : null;
    // An explicit rewrite of the already displayed question preserves provenance;
    // it does not reapply an expired AI result or change any prior recording source.
    const rewritingDisplayed =
      userRewrite && current?.followupTaskId === taskId;
    if (
      !g ||
      g.projectId !== projectId ||
      g.interviewId !== interviewId ||
      task?.state !== "succeeded" ||
      result?.action !== "ask" ||
      (!replay && !rewritingDisplayed && !(await this.grantIn(tx, task)))
    )
      throw new ConflictException();
    return {
      generationTaskId: taskId,
      sourceActualQuestionId: g.actualQuestionId,
      original: result as Record<string, unknown>,
    };
  }
  async acceptsIn(
    tx: Prisma.TransactionClient,
    task: ProductionTask,
    output: object,
  ) {
    const result = output as { action: string; question: string };
    if (result.action !== "ask") return true;
    const g = await tx.followupGeneration.findUniqueOrThrow({
        where: { taskId: task.id },
      }),
      input = g.input as unknown as FollowupInput;
    const text = result.question;
    if (
      this.ruleFinish(input) ||
      input.history.some((q) => normalize(q.snapshot.text) === normalize(text))
    )
      return false;
    // Reject common presuppositions; semantic quality still requires D09 human evaluation.
    return (
      !/(?:是不是|难道|一定|肯定|对不对|难忘的|最幸福的|最痛苦的|想必|既然|为何不|为什么不)/.test(
        text,
      ) &&
      !/[;；\n]/.test(text) &&
      (
        text.match(
          /(?:什么时候|为什么|为何|何时|谁|什么|怎样|如何|哪里|哪儿|哪[一件个些年]|多久|多少|几[岁年个次]|是否)/g,
        ) ?? []
      ).length <= 1
    );
  }
  async applyIn(
    tx: Prisma.TransactionClient,
    task: ProductionTask,
    output: object,
  ) {
    await tx.followupGeneration.update({
      where: { taskId: task.id },
      data: { result: output as Prisma.InputJsonObject },
    });
  }
  private async viewIn(
    tx: Prisma.TransactionClient,
    projectId: string,
    interviewId: string,
    id?: string,
  ) {
    const g = await tx.followupGeneration.findFirst({
      where: { projectId, interviewId, ...(id ? { taskId: id } : {}) },
      orderBy: { followupVersion: "desc" },
    });
    const session = await tx.followupSession.findUnique({
      where: { projectId_interviewId: { projectId, interviewId } },
    });
    const finishReason =
      g?.finishReason ?? (session?.ended ? "USER_FINISHED" : null);
    if (!g || g.finishReason)
      return {
        finishReason,
        interviewId,
        task: null,
        result: null,
        canFinish: true,
        usage: await tx.followupGeneration.count({
          where: { projectId, charged: true },
        }),
      };
    const task = await tx.productionTask.findUniqueOrThrow({
        where: { id: g.taskId },
      }),
      allowed = await this.grantIn(tx, task);
    return {
      interviewId,
      actualQuestionId: g.actualQuestionId,
      questionVersion: g.questionVersion,
      planRevision: g.planRevision,
      finishReason,
      canFinish: true,
      latencyMs:
        task.completedAt && g.transcriptsReadyAt
          ? Math.max(
              0,
              task.completedAt.getTime() - g.transcriptsReadyAt.getTime(),
            )
          : null,
      task: {
        id: task.id,
        kind: task.kind,
        state: allowed ? task.state : "obsolete",
        errorCode: task.errorCode,
        queuedAt: task.createdAt,
        completedAt: task.completedAt,
        attempts: await tx.taskAttempt.findMany({
          where: { taskId: task.id },
          select: {
            requestId: true,
            state: true,
            usage: true,
            model: true,
            reservedCostFen: true,
            actualCostFen: true,
          },
        }),
      },
      result: allowed ? g.result : null,
      usage: await tx.followupGeneration.count({
        where: { projectId, charged: true },
      }),
    };
  }
  finish(
    projectId: string,
    interviewId: string,
    body: FinishFollowupDto,
    authorization?: string,
    key?: string,
  ) {
    return this.participation.withCollectionAccess(
      projectId,
      authorization,
      body.assistedSessionId,
      async (tx, actor) => {
        await this.interviewIn(tx, projectId, interviewId, actor);
        const prior = key
          ? await tx.recordingCommand.findUnique({
              where: {
                projectId_operatorUserId_idempotencyKey: {
                  projectId,
                  operatorUserId: actor.operatorUserId,
                  idempotencyKey: key,
                },
              },
            })
          : null;
        await claimRecordingCommand(tx, projectId, actor.operatorUserId, key, {
          kind: "finish-followup",
          interviewId,
          actualQuestionId: body.actualQuestionId,
          expectedQuestionVersion: body.expectedQuestionVersion,
        });
        if (!prior) {
          const current = await tx.interviewActualQuestion.findFirst({
            where: { projectId, interviewId },
            orderBy: { sequence: "desc" },
          });
          if (
            current?.actualQuestionId !== body.actualQuestionId ||
            current.sequence !== body.expectedQuestionVersion
          )
            throw new ConflictException();
          await invalidateFollowupIn(tx, projectId, interviewId, true);
        }
        return this.viewIn(tx, projectId, interviewId);
      },
      "existing",
    );
  }
  status(
    projectId: string,
    interviewId: string,
    body: FollowupAccessDto,
    authorization?: string,
  ) {
    return this.participation.withCollectionAccess(
      projectId,
      authorization,
      body.assistedSessionId,
      async (tx, actor) => {
        await this.interviewIn(tx, projectId, interviewId, actor);
        return this.viewIn(tx, projectId, interviewId);
      },
      "existing",
    );
  }
}
@Controller("v1/projects/:id/interviews/:interviewId/follow-up")
@ApiTags("Optional follow-up")
@ApiBearerAuth()
export class FollowupsController {
  constructor(private readonly followups: Followups) {}
  @Post()
  @HttpCode(202)
  @Header("Cache-Control", "no-store")
  async request(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Param("interviewId", new ParseUUIDPipe()) interviewId: string,
    @Body() body: RequestFollowupDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.followups.request(
        id,
        interviewId,
        body,
        req.headers.authorization,
        req.headers["idempotency-key"] as string | undefined,
      ),
      meta: { requestId: req.id },
    };
  }
  @Post("finish")
  @Header("Cache-Control", "no-store")
  async finish(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Param("interviewId", new ParseUUIDPipe()) interviewId: string,
    @Body() body: FinishFollowupDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.followups.finish(
        id,
        interviewId,
        body,
        req.headers.authorization,
        req.headers["idempotency-key"] as string | undefined,
      ),
      meta: { requestId: req.id },
    };
  }
  @Post("status")
  @Header("Cache-Control", "no-store")
  async status(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Param("interviewId", new ParseUUIDPipe()) interviewId: string,
    @Body() body: FollowupAccessDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.followups.status(
        id,
        interviewId,
        body,
        req.headers.authorization,
      ),
      meta: { requestId: req.id },
    };
  }
}

/** Caller holds the collection/project lock. Real input changes close the previous suggestion. */
export async function invalidateFollowupIn(
  tx: Prisma.TransactionClient,
  projectId: string,
  interviewId: string,
  ended = false,
) {
  await tx.followupSession.upsert({
    where: { projectId_interviewId: { projectId, interviewId } },
    create: { projectId, interviewId, version: 1, ended },
    update: { version: { increment: 1 }, ended },
  });
}
