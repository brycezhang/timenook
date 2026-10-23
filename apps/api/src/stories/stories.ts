import {
  Injectable,
  Inject,
  Controller,
  Post,
  Get,
  Body,
  Param,
  Req,
  Header,
  HttpCode,
  ParseUUIDPipe,
  BadRequestException,
  ServiceUnavailableException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiTags,
  ApiProperty,
  ApiHeader,
} from "@nestjs/swagger";
import { IsUUID, IsInt, Min, IsOptional } from "class-validator";
import { Prisma, ProductionTask } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { API_CONFIG, ApiConfig } from "../config";
import { isDeepStrictEqual } from "node:util";
import { StoryComposerInput, validateStoryOutput } from "../probe/ai-providers";
import { Participation } from "../identity/participation";
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
class StoryContextDto {
  @ApiProperty({ format: "uuid" }) @IsUUID() interviewId!: string;
  @ApiProperty({ format: "uuid", required: false })
  @IsUUID()
  @IsOptional()
  assistedSessionId?: string;
}
class OrganizeDto extends StoryContextDto {
  @ApiProperty() @IsInt() @Min(0) baseVersion!: number;
}
/** Existing recording-start caller holds the project/subject authorization lock. */
export async function invalidateStoryRecordingIn(
  tx: Prisma.TransactionClient,
  projectId: string,
  interviewId: string,
) {
  const story = await tx.story.findUnique({ where: { interviewId } });
  if (!story || story.projectId !== projectId) return;
  const ids = (
    await tx.storyGeneration.findMany({
      where: { projectId, storyId: story.id },
      select: { taskId: true },
    })
  ).map((g) => g.taskId);
  const active = await tx.productionTask.findMany({
      where: {
        id: { in: ids },
        kind: "compose_story",
        state: {
          in: ["queued", "waiting_inputs", "submitting", "waiting_provider"],
        },
      },
      select: { id: true },
    }),
    taskIds = active.map((t) => t.id);
  await tx.productionTask.updateMany({
    where: { id: { in: taskIds } },
    data: {
      state: "obsolete",
      errorCode: "INPUT_CHANGED",
      fence: { increment: 1 },
      leaseUntil: null,
    },
  });
  await tx.taskAttempt.deleteMany({
    where: { taskId: { in: taskIds }, state: "preparing" },
  });
}
@Injectable()
export class Stories {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly participation: Participation,
  ) {}
  async organize(
    projectId: string,
    body: OrganizeDto,
    authorization?: string,
    key?: string,
  ) {
    if (!this.config.generation) throw new ServiceUnavailableException();
    if (!key || !/^[-A-Za-z0-9_:]{8,128}$/.test(key))
      throw new BadRequestException();
    return this.participation.withCollectionAccess(
      projectId,
      authorization,
      body.assistedSessionId,
      async (tx, actor) => {
        const requestHash = hash(
          JSON.stringify({
            interviewId: body.interviewId,
            baseVersion: body.baseVersion,
          }),
        );
        const prior = await tx.storyCommand.findUnique({
          where: {
            projectId_actorId_key: {
              projectId,
              actorId: actor.operatorUserId,
              key,
            },
          },
        });
        const interview = await tx.interview.findFirst({
          where: {
            id: body.interviewId,
            projectId,
            subjectId: actor.subjectId,
            bindingVersion: actor.bindingVersion,
            accessEpoch: actor.accessEpoch,
          },
        });
        if (!interview) throw new ForbiddenException();
        const clips = await tx.recordingClip.findMany({
          where: { projectId, interviewId: interview.id },
          orderBy: { sequence: "asc" },
        });
        if (!clips.length) throw new ConflictException("No saved audio");
        if (
          await tx.recordingIntent.count({
            where: { projectId, interviewId: interview.id, state: "pending" },
          })
        )
          throw new ConflictException("Save all audio first");
        for (const clip of clips)
          if (
            !(await this.participation.processingGrant(tx, {
              ...clip,
              sourceAssistedSessionId: clip.assistedSessionId,
            }))
          )
            throw new ForbiddenException();
        if (prior) {
          if (prior.requestHash !== requestHash) throw new ConflictException();
          const generation = await tx.storyGeneration.findUniqueOrThrow({
            where: { taskId: prior.taskId },
          });
          return this.view(
            tx,
            projectId,
            generation.storyId,
            prior.taskId,
            false,
          );
        }
        let story = await tx.story.findUnique({
          where: { interviewId: interview.id },
        });
        if ((story?.version ?? 0) !== body.baseVersion)
          throw new ConflictException();
        const project = await tx.project.findUniqueOrThrow({
            where: { id: projectId },
          }),
          order = await tx.paymentOrder.findUniqueOrThrow({
            where: { id: project.orderId! },
          }),
          admission = (order.packageSnapshot as Prisma.JsonObject)
            .admission as Prisma.JsonObject,
          d04 = admission.d04 as Prisma.JsonObject,
          quotaKind = body.baseVersion === 0 ? "organization" : "regeneration",
          quota = (d04.userQuotas as Prisma.JsonObject)[
            quotaKind === "organization"
              ? "storyOrganizations"
              : "activeRegenerations"
          ] as Prisma.JsonObject;
        if (
          (d04.review as Prisma.JsonObject).state !== "frozen" ||
          d04.systemRetriesChargeUserQuota !== false ||
          quota.unit !== "count" ||
          !Number.isSafeInteger(quota.value) ||
          Number(quota.value) < 1
        )
          throw new ServiceUnavailableException();
        if (
          (await tx.storyGeneration.count({
            where: { projectId, quotaKind },
          })) >= Number(quota.value)
        )
          throw new ConflictException("Story quota exhausted");
        story ??= await tx.story.create({
          data: { id: randomUUID(), projectId, interviewId: interview.id },
        });
        const sources = await Promise.all(
          clips.map(async (clip) => {
            const asset = await tx.recordingAsset.findUniqueOrThrow({
                where: { id: clip.assetId },
              }),
              sealed = await tx.sealedInput.findUniqueOrThrow({
                where: { clipId: clip.id },
              }),
              transcription = await tx.productionTask.findFirstOrThrow({
                where: { projectId, clipId: clip.id, kind: "transcribe_audio" },
              }),
              question = await tx.actualPlanQuestion.findUniqueOrThrow({
                where: { id: clip.actualQuestionId },
              });
            return {
              projectId,
              clipId: clip.id,
              intentId: clip.intentId,
              interviewId: interview.id,
              assetId: asset.id,
              sealedInputId: sealed.id,
              inputHash: asset.sha256,
              transcriptionTaskId: transcription.id,
              actualQuestionId: question.id,
              question: {
                id: question.id,
                planRevision: question.planRevision,
                snapshot: question.snapshot,
                source: question.source ?? {
                  kind: question.questionKey ? "plan" : question.starterKind,
                },
              },
              sequence: clip.sequence,
              savedAt: sealed.createdAt,
            };
          }),
        );
        const preferences = await tx.interviewPreferences.findUniqueOrThrow({
            where: { projectId },
          }),
          id = randomUUID(),
          now = new Date();
        const inputHash = hash(
          JSON.stringify({
            sources,
            preferences,
            baseVersion: body.baseVersion,
          }),
        );
        // A new HTTP key is not proof that an unresolved provider request failed.
        const matching = await tx.productionTask.findMany({
          where: { projectId, kind: "compose_story", inputHash },
          select: { id: true, state: true },
        });
        if (
          matching.some((t) => t.state === "submitting") ||
          (await tx.taskAttempt.count({
            where: {
              taskId: { in: matching.map((t) => t.id) },
              state: { in: ["submitting", "unknown"] },
            },
          }))
        )
          throw new ConflictException("Original provider outcome is unknown");
        await tx.productionTask.create({
          data: {
            id,
            projectId,
            subjectId: actor.subjectId,
            bindingVersion: actor.bindingVersion,
            accessEpoch: actor.accessEpoch,
            inputHash,
            kind: "compose_story",
            state: "waiting_inputs",
            configuration: this.configuration(),
            configurationHash: hash(JSON.stringify(this.configuration())),
            deadline: this.config.generation
              ? new Date(now.getTime() + this.config.generation.deadlineMs)
              : null,
            providerRequestId: randomUUID(),
          },
        });
        await tx.storyGeneration.create({
          data: {
            taskId: id,
            projectId,
            storyId: story.id,
            baseVersion: body.baseVersion,
            preferences: JSON.parse(JSON.stringify(preferences)),
            quotaKind: body.baseVersion === 0 ? "organization" : "regeneration",
            userSubmittedAt: now,
            allSavedAt: new Date(
              Math.max(...sources.map((s) => s.savedAt.getTime())),
            ),
          },
        });
        for (const { savedAt, ...source } of sources)
          await tx.storySource.create({
            data: {
              taskId: id,
              ...source,
              question: source.question as Prisma.InputJsonObject,
            },
          });
        await tx.taskOutbox.create({ data: { id: randomUUID(), taskId: id } });
        await tx.storyCommand.create({
          data: {
            projectId,
            actorId: actor.operatorUserId,
            key,
            requestHash,
            taskId: id,
          },
        });
        return this.view(tx, projectId, story.id, id, false);
      },
      "existing",
    );
  }
  configuration() {
    const g = this.config.generation;
    return g
      ? {
          version: g.configVersion,
          model: g.deepseek.model,
          maxTokens: g.deepseek.maxTokens,
          credentialHash: hash(g.deepseek.apiKey),
          submissionReservationFen: g.submissionReservationFen,
          maxSubmissions: g.maxSubmissions,
          deadlineMs: g.deadlineMs,
          promptVersion: "t18-v1",
          outputContract: "t03-story-multiple-v1",
        }
      : { version: "unconfigured" };
  }
  async grantIn(
    tx: Prisma.TransactionClient,
    task: ProductionTask,
  ): Promise<Prisma.JsonObject | null> {
    // Acquire the real project/subject purpose locks before reading mutable
    // Story, preference or clip selection. A grant read is not a later lock.
    if (
      !(await this.participation.processingGrant(tx, {
        ...task,
        processingGrant: undefined,
      }))
    )
      return null;
    const generation = await tx.storyGeneration.findUniqueOrThrow({
        where: { taskId: task.id },
      }),
      story = await tx.story.findUniqueOrThrow({
        where: { id: generation.storyId },
      });
    const prefs = await tx.interviewPreferences.findUniqueOrThrow({
        where: { projectId: task.projectId },
      }),
      frozen = generation.preferences as Prisma.JsonObject;
    if (
      story.version !== generation.baseVersion ||
      prefs.version !== frozen.version ||
      (await tx.recordingIntent.count({
        where: {
          projectId: task.projectId,
          interviewId: story.interviewId,
          state: "pending",
        },
      }))
    )
      return null;
    const sources = await tx.storySource.findMany({
        where: { taskId: task.id },
        orderBy: { sequence: "asc" },
      }),
      clips = await tx.recordingClip.findMany({
        where: { projectId: task.projectId, interviewId: story.interviewId },
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
    for (const source of sources) {
      const clip = clips.find((c) => c.id === source.clipId)!;
      if (
        clip.assetId !== source.assetId ||
        clip.actualQuestionId !== source.actualQuestionId
      )
        return null;
      const grant = await this.participation.processingGrant(tx, {
        ...task,
        processingGrant: undefined,
        sourceAssistedSessionId: clip.assistedSessionId,
      });
      if (!grant) return null;
      grants.push({ clipId: clip.id, grant });
    }
    const result = { sources: grants };
    return task.processingGrant &&
      !isDeepStrictEqual(task.processingGrant, result)
      ? null
      : result;
  }
  async inputsIn(tx: Prisma.TransactionClient, task: ProductionTask) {
    const sources = await tx.storySource.findMany({
      where: { taskId: task.id },
      orderBy: { sequence: "asc" },
    });
    const manifest = [];
    let waiting = false,
      failed = false;
    for (const source of sources) {
      const dependency = await tx.productionTask.findUniqueOrThrow({
          where: { id: source.transcriptionTaskId },
        }),
        transcript = await tx.formalTranscript.findUnique({
          where: { taskId: dependency.id },
        });
      if (
        dependency.state !== "no_speech" &&
        !(dependency.state === "succeeded" && transcript?.text.trim())
      ) {
        waiting = true;
        failed ||= ["failed", "manual_review", "invalidated"].includes(
          dependency.state,
        );
      }
      manifest.push({
        ...source,
        transcript: transcript
          ? {
              taskId: transcript.taskId,
              text: transcript.text,
              sha256: transcript.sha256,
              inputHash: transcript.inputHash,
            }
          : null,
        state: dependency.state,
        completedAt: dependency.completedAt?.toISOString() ?? null,
      });
    }
    if (waiting)
      return {
        state: "waiting_inputs",
        errorCode: failed ? "DEPENDENCY_FAILED" : null,
        input: null,
      };
    const usable = manifest.filter((s) => s.transcript);
    if (!usable.length)
      return { state: "no_speech", errorCode: "NO_SPEECH", input: null };
    const generation = await tx.storyGeneration.findUniqueOrThrow({
      where: { taskId: task.id },
    });
    if (!generation.resolvedManifest)
      await tx.storyGeneration.update({
        where: { taskId: task.id },
        data: {
          resolvedManifest: JSON.parse(JSON.stringify(manifest)),
          dependenciesReadyAt: new Date(
            Math.max(...manifest.map((s) => Date.parse(s.completedAt!))),
          ),
        },
      });
    const input: StoryComposerInput = {
      transcripts: usable.map((s) => ({
        clipId: s.clipId,
        transcript: s.transcript!.text,
        transcriptHash: s.transcript!.sha256,
        question: s.question as object,
      })),
      preferences: generation.preferences as object,
    };
    return { state: "ready", errorCode: null, input };
  }
  /** Caller holds real Participation/processing authorization and the project lock in this transaction. */
  async appendIn(
    tx: Prisma.TransactionClient,
    command: {
      projectId: string;
      storyId: string;
      expectedVersion: number;
      generationTaskId: string;
      origin: "ai" | "participant";
      content: {
        title: string;
        theme: string;
        paragraphs: Prisma.InputJsonValue;
        reviewItems: Prisma.InputJsonValue;
      };
    },
  ) {
    const story = await tx.story.findFirst({
        where: { id: command.storyId, projectId: command.projectId },
      }),
      generation = await tx.storyGeneration.findFirst({
        where: {
          taskId: command.generationTaskId,
          projectId: command.projectId,
          storyId: command.storyId,
        },
      });
    if (
      !story ||
      story.version !== command.expectedVersion ||
      !generation?.resolvedManifest
    )
      throw new ConflictException();
    if (
      command.origin === "ai" &&
      generation.baseVersion !== command.expectedVersion
    )
      throw new ConflictException("Generation already superseded");
    const task = await tx.productionTask.findUniqueOrThrow({
        where: { id: generation.taskId },
      }),
      inputs = await this.inputsIn(tx, task);
    if (!inputs.input) throw new ConflictException();
    try {
      validateStoryOutput(command.content, inputs.input);
    } catch {
      throw new ConflictException("Invalid story content or sources");
    }
    const content = {
        ...command.content,
        sourceManifest: generation.resolvedManifest,
      },
      revision = await tx.storyRevision.create({
        data: {
          id: randomUUID(),
          projectId: story.projectId,
          storyId: story.id,
          version: story.version + 1,
          generationTaskId: generation.taskId,
          baseRevisionId: story.currentRevisionId,
          origin: command.origin,
          ...content,
          sourceManifest: generation.resolvedManifest as Prisma.InputJsonValue,
          contentHash: hash(JSON.stringify(content)),
        },
      });
    await tx.story.update({
      where: { id: story.id },
      data: { version: revision.version, currentRevisionId: revision.id },
    });
    return revision;
  }
  async applyIn(
    tx: Prisma.TransactionClient,
    task: ProductionTask,
    output: object,
  ) {
    const generation = await tx.storyGeneration.findUniqueOrThrow({
      where: { taskId: task.id },
    });
    return this.appendIn(tx, {
      projectId: task.projectId,
      storyId: generation.storyId,
      expectedVersion: generation.baseVersion,
      generationTaskId: task.id,
      origin: "ai",
      content: output as Parameters<Stories["appendIn"]>[1]["content"],
    });
  }
  context(projectId: string, body: StoryContextDto, authorization?: string) {
    return this.participation.withCollectionAccess(
      projectId,
      authorization,
      body.assistedSessionId,
      async (tx, actor) => {
        const interview = await tx.interview.findFirst({
          where: {
            id: body.interviewId,
            projectId,
            subjectId: actor.subjectId,
            bindingVersion: actor.bindingVersion,
            accessEpoch: actor.accessEpoch,
          },
        });
        if (!interview) throw new ForbiddenException();
        const pendingCount = await tx.recordingIntent.count({
            where: { projectId, interviewId: interview.id, state: "pending" },
          }),
          clipCount = await tx.recordingClip.count({
            where: { projectId, interviewId: interview.id },
          }),
          story = await tx.story.findUnique({
            where: { interviewId: interview.id },
          });
        return {
          interviewId: interview.id,
          clipCount,
          pendingCount,
          cloudSaved: clipCount > 0 && pendingCount === 0,
          story: story
            ? await this.view(tx, projectId, story.id, undefined, false)
            : null,
        };
      },
      "existing",
    );
  }
  async view(
    tx: Prisma.TransactionClient,
    projectId: string,
    id: string,
    taskId?: string,
    privateContent = true,
  ) {
    const story = await tx.story.findFirst({ where: { id, projectId } });
    if (!story) throw new NotFoundException();
    const generation = await tx.storyGeneration.findFirst({
      where: { storyId: id, ...(taskId ? { taskId } : {}) },
      orderBy: { userSubmittedAt: "desc" },
    });
    const task = generation
      ? await tx.productionTask.findUniqueOrThrow({
          where: { id: generation.taskId },
        })
      : null;
    const sources = generation
      ? await tx.storySource.findMany({
          where: { taskId: generation.taskId },
          orderBy: { sequence: "asc" },
        })
      : [];
    return {
      ...story,
      usage: {
        organizations: await tx.storyGeneration.count({
          where: { projectId, quotaKind: "organization" },
        }),
        regenerations: await tx.storyGeneration.count({
          where: { projectId, quotaKind: "regeneration" },
        }),
      },
      revision:
        privateContent && story.currentRevisionId
          ? await tx.storyRevision.findUniqueOrThrow({
              where: { id: story.currentRevisionId },
            })
          : null,
      task: task
        ? {
            id: task.id,
            kind: task.kind,
            state: task.state,
            inputHash: task.inputHash,
            queuedAt: task.createdAt,
            userSubmittedAt: generation!.userSubmittedAt,
            allSavedAt: generation!.allSavedAt,
            dependenciesReadyAt: generation!.dependenciesReadyAt,
            errorCode: task.errorCode,
            completedAt: task.completedAt,
            submittedAt: task.submittedAt,
            failedAt: task.failedAt,
            attempts: await Promise.all(
              (
                await tx.taskAttempt.findMany({
                  where: { taskId: task.id },
                  orderBy: { number: "asc" },
                  select: {
                    requestId: true,
                    number: true,
                    state: true,
                    usage: true,
                    model: true,
                    failure: true,
                    reservedCostFen: true,
                    actualCostFen: true,
                  },
                })
              ).map(async (a) => ({
                ...a,
                observations: await tx.taskAttemptObservation.findMany({
                  where: { requestId: a.requestId },
                  orderBy: { observedAt: "asc" },
                  select: {
                    state: true,
                    superseded: true,
                    action: true,
                    observedAt: true,
                  },
                }),
              })),
            ),
            sources: await Promise.all(
              sources.map(async (source) => ({
                ...source,
                question: privateContent ? source.question : undefined,
                state: (
                  await tx.productionTask.findUniqueOrThrow({
                    where: { id: source.transcriptionTaskId },
                    select: { state: true },
                  })
                ).state,
                transcript: privateContent
                  ? await tx.formalTranscript.findUnique({
                      where: { taskId: source.transcriptionTaskId },
                      select: {
                        taskId: true,
                        text: true,
                        sha256: true,
                        inputHash: true,
                      },
                    })
                  : null,
              })),
            ),
          }
        : null,
    };
  }
  read(projectId: string, id: string, authorization?: string) {
    return this.participation.withPlanAccess(
      projectId,
      authorization,
      undefined,
      (tx) => this.view(tx, projectId, id),
    );
  }
}
@Controller("v1/projects/:id/stories")
@ApiTags("Stories")
@ApiBearerAuth()
export class StoriesController {
  constructor(private readonly stories: Stories) {}
  @Post("context")
  @Header("Cache-Control", "no-store")
  async context(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() body: StoryContextDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.stories.context(id, body, req.headers.authorization),
      meta: { requestId: req.id },
    };
  }
  @Post("organize")
  @HttpCode(202)
  @Header("Cache-Control", "no-store")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  async organize(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() body: OrganizeDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.stories.organize(
        id,
        body,
        req.headers.authorization,
        req.headers["idempotency-key"] as string | undefined,
      ),
      meta: { requestId: req.id },
    };
  }
  @Get(":storyId")
  @Header("Cache-Control", "no-store")
  async read(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Param("storyId", new ParseUUIDPipe()) storyId: string,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.stories.read(id, storyId, req.headers.authorization),
      meta: { requestId: req.id },
    };
  }
}
