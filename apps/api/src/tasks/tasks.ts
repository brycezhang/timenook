import { Followups } from "../followups/followups";
import { Stories } from "../stories/stories";
import { probeStorageScope } from "../probe/storage-scope";
import { ApiProperty } from "@nestjs/swagger";
import { IsOptional, IsUUID } from "class-validator";
import {
  Body,
  Controller,
  Get,
  Post,
  Param,
  ParseUUIDPipe,
  Req,
  Header,
  HttpCode,
  Injectable,
  Inject,
  OnModuleDestroy,
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
  ForbiddenException,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags, ApiHeader } from "@nestjs/swagger";
import {
  Prisma,
  PrismaClient,
  RecordingClip,
  RecordingAsset,
  SealedInput,
  ProductionTask,
} from "@prisma/client";
import { randomUUID, createHash } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { API_CONFIG, ApiConfig } from "../config";
import { Participation } from "../identity/participation";
import {
  AI_FETCH,
  AsrSourcePreflightError,
  DoubaoFileAsr,
  DeepSeekText,
  StoryComposerInput,
} from "../probe/ai-providers";
import type { ProbeObjects } from "../probe/local-objects";
class InvalidSealedInput extends AsrSourcePreflightError {}
export const TASK_OBJECTS = Symbol("TASK_OBJECTS");
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const active = ["queued", "waiting_inputs", "waiting_provider", "submitting"];
function configuration(config: ApiConfig) {
  return config.transcription
    ? {
        version: config.transcription.configVersion,
        protocol: "bigmodel-async-v3-api-key",
        resourceId: config.transcription.doubao.resourceId,
        fetchWindowSeconds: config.transcription.doubao.fetchWindowSeconds,
        credentialHash: hash(config.transcription.doubao.apiKey),
        submissionReservationFen: config.transcription.submissionReservationFen,
        deadlineMs: config.transcription.deadlineMs,
      }
    : { version: "unconfigured" };
}
export async function createTranscription(
  tx: Prisma.TransactionClient,
  clip: RecordingClip,
  asset: RecordingAsset,
  input: SealedInput,
  config: ApiConfig,
) {
  const snapshot = configuration(config),
    id = randomUUID();
  const task = await tx.productionTask.create({
    data: {
      id,
      projectId: clip.projectId,
      clipId: clip.id,
      assetId: asset.id,
      sealedInputId: input.id,
      subjectId: clip.subjectId,
      bindingVersion: clip.bindingVersion,
      accessEpoch: clip.accessEpoch,
      inputHash: asset.sha256,
      providerRequestId: randomUUID(),
      deadline: config.transcription
        ? new Date(Date.now() + config.transcription.deadlineMs)
        : null,
      configuration: snapshot,
      configurationHash: hash(JSON.stringify(snapshot)),
    },
  });
  // This links the recording usage already settled by T14. ASR never charges it again.
  await tx.taskQuotaIntent.create({
    data: {
      clipId: clip.id,
      taskId: task.id,
      projectId: clip.projectId,
      recordingIntentId: clip.intentId,
      consumedMs: asset.durationMs,
    },
  });
  await tx.taskOutbox.create({ data: { id: randomUUID(), taskId: task.id } });
  return task;
}
class TaskStatusDto {
  @ApiProperty({ format: "uuid" }) @IsUUID() interviewId!: string;
  @ApiProperty({ format: "uuid", required: false })
  @IsOptional()
  @IsUUID()
  assistedSessionId?: string;
}
class TaskRetryDto {
  @ApiProperty({ format: "uuid", required: false })
  @IsOptional()
  @IsUUID()
  assistedSessionId?: string;
}
@Injectable()
export class ProductionTasks implements OnModuleDestroy {
  private readonly db: PrismaClient;
  private readonly asr?: DoubaoFileAsr;
  private readonly text?: DeepSeekText;
  constructor(
    private readonly participation: Participation,
    private readonly stories: Stories,
    private readonly followups: Followups,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(AI_FETCH) transport: typeof fetch,
    @Inject(TASK_OBJECTS) private readonly objects: ProbeObjects,
  ) {
    this.db = new PrismaClient({ datasourceUrl: config.databaseUrl });
    if (config.generation)
      this.text = new DeepSeekText(config.generation.deepseek, transport);
    if (config.transcription)
      this.asr = new DoubaoFileAsr(config.transcription.doubao, transport);
  }
  private textOwner(task: ProductionTask) {
    return task.kind === "ask_followup" ? this.followups : this.stories;
  }
  async due() {
    return (
      await this.db.productionTask.findMany({
        where: {
          state: { in: active },
          nextRunAt: { lte: new Date() },
          OR: [{ leaseUntil: null }, { leaseUntil: { lte: new Date() } }],
        },
        orderBy: { nextRunAt: "asc" },
        take: 100,
      })
    ).map((row) => row.id);
  }
  async delivered(id: string) {
    await this.db.taskOutbox.update({
      where: { taskId: id },
      data: { deliveredAt: new Date() },
    });
  }
  private async locked(tx: Prisma.TransactionClient, id: string) {
    await tx.$queryRaw`SELECT id FROM production_tasks WHERE id=${id}::uuid FOR UPDATE`;
    const task = await tx.productionTask.findUnique({ where: { id } });
    if (!task) throw new NotFoundException();
    return task;
  }
  private async invalidate(
    tx: Prisma.TransactionClient,
    task: ProductionTask,
    errorCode = "AUTHORIZATION_CHANGED",
  ) {
    const invalidated = await tx.productionTask.updateMany({
      where: {
        id: task.id,
        fence: task.fence,
        state: { notIn: ["succeeded", "no_speech", "invalidated", "obsolete"] },
      },
      data: {
        state: task.kind !== "transcribe_audio" ? "obsolete" : "invalidated",
        errorCode,
        leaseUntil: null,
        fence: { increment: 1 },
      },
    });
    if (invalidated.count)
      await tx.taskAttempt.deleteMany({
        where: { requestId: task.providerRequestId, state: "preparing" },
      });
  }
  private storageMatches(asset: RecordingAsset) {
    const recording = this.config.recording!;
    return (
      asset.storageScope === hash(`product:${probeStorageScope(recording)}`) &&
      asset.storage === (recording.oss ? "oss" : "local-simulator") &&
      asset.store ===
        (recording.oss
          ? `oss:${recording.oss.bucket}:${recording.oss.region}`
          : `local:${recording.storageRoot}`)
    );
  }
  private async budget(tx: Prisma.TransactionClient, projectId: string) {
    const p = await tx.project.findUniqueOrThrow({ where: { id: projectId } });
    const order = await tx.paymentOrder.findUniqueOrThrow({
      where: { id: p.orderId! },
    });
    const admission = (order.packageSnapshot as Prisma.JsonObject).admission as
      Prisma.JsonObject | undefined;
    const d04 = admission?.d04 as Prisma.JsonObject | undefined;
    const raw = d04?.providerBudget as Prisma.JsonObject | undefined;
    const count = (key: string, unit: string) => {
      const item = raw?.[key] as Prisma.JsonObject | undefined;
      if (
        item?.unit !== unit ||
        !Number.isSafeInteger(item.value) ||
        Number(item.value) < 0
      )
        throw new ServiceUnavailableException();
      return Number(item.value);
    };
    if (
      (d04?.review as Prisma.JsonObject)?.state !== "frozen" ||
      d04?.systemRetriesChargeUserQuota !== false ||
      raw?.scope !== "per_project" ||
      raw.exhausted !== "manual_review"
    )
      throw new ServiceUnavailableException();
    return {
      submissions: count("asrSubmissions", "count"),
      polls: count("asrPolls", "count"),
      retries: count("systemRetries", "count"),
      cost: count("costCap", "fen"),
    };
  }
  private async providerCapacity(
    tx: Prisma.TransactionClient,
    projectId: string,
    budget: { submissions: number; polls: number; cost: number },
    action: "new_submission" | "prepared_submission" | "query",
  ) {
    const total = await tx.taskAttempt.aggregate({
      where: { projectId },
      _sum: { polls: true, reservedCostFen: true },
      _count: true,
    });
    const ids = (
      await tx.productionTask.findMany({
        where: { projectId, kind: "transcribe_audio" },
        select: { id: true },
      })
    ).map((t) => t.id);
    const audio = await tx.taskAttempt.aggregate({
      where: { projectId, taskId: { in: ids } },
      _sum: { polls: true },
      _count: true,
    });
    if (action === "query") return (audio._sum.polls ?? 0) < budget.polls;
    // Preparing attempts already hold their one submission/cost reservation.
    const additional = action === "new_submission" ? 1 : 0;
    return (
      audio._count + additional <= budget.submissions &&
      (total._sum.reservedCostFen ?? 0) +
        additional * this.config.transcription!.submissionReservationFen <=
        budget.cost
    );
  }
  private async claim(id: string): Promise<{
    task: ProductionTask;
    submit: boolean;
    input?: StoryComposerInput;
  } | null> {
    const initial = await this.db.productionTask.findUnique({ where: { id } });
    if (!initial) return null;
    return this.db.$transaction(async (tx) => {
      const sourceClip =
        initial.kind === "transcribe_audio"
          ? await tx.recordingClip.findUniqueOrThrow({
              where: { id: initial.clipId! },
            })
          : null;
      const grant =
        initial.kind !== "transcribe_audio"
          ? await this.textOwner(initial).grantIn(tx, initial)
          : await this.participation.processingGrant(tx, {
              ...initial,
              sourceAssistedSessionId: sourceClip!.assistedSessionId,
            });
      const permitted = !!grant;
      const task = await this.locked(tx, id);
      if (
        !active.includes(task.state) ||
        task.nextRunAt.getTime() > Date.now() ||
        (task.leaseUntil && task.leaseUntil.getTime() > Date.now())
      )
        return null;
      if (task.deadline && task.deadline.getTime() <= Date.now()) {
        await tx.productionTask.update({
          where: { id },
          data: {
            state: "manual_review",
            errorCode: "DEADLINE_EXCEEDED",
            leaseUntil: null,
          },
        });
        await tx.taskAttempt.deleteMany({
          where: { requestId: task.providerRequestId, state: "preparing" },
        });
        return null;
      }
      if (!permitted) {
        const p = await tx.project.findUniqueOrThrow({
          where: { id: task.projectId },
        });
        if (
          task.kind !== "transcribe_audio" ||
          task.processingGrant ||
          p.accessEpoch !== task.accessEpoch
        )
          await this.invalidate(tx, task);
        else
          await tx.productionTask.update({
            where: { id },
            data: {
              errorCode: "AI_AUTHORIZATION_REQUIRED",
              // Let other due projects advance while this purpose is pending.
              nextRunAt: new Date(Date.now() + 1000),
            },
          });
        return null;
      }
      if (task.kind !== "transcribe_audio")
        return this.claimText(tx, task, grant!);
      if (
        !this.asr ||
        task.configurationHash !==
          hash(JSON.stringify(configuration(this.config)))
      ) {
        await tx.productionTask.update({
          where: { id },
          data: {
            state: "manual_review",
            errorCode: "CONFIGURATION_CHANGED",
            leaseUntil: null,
          },
        });
        return null;
      }
      const asset = await tx.recordingAsset.findUniqueOrThrow({
        where: { id: task.assetId! },
      });
      if (!this.storageMatches(asset)) {
        await this.invalidate(tx, task, "INPUT_CHANGED");
        return null;
      }
      const budget = await this.budget(tx, task.projectId);
      const attempt = await tx.taskAttempt.findUnique({
        where: { requestId: task.providerRequestId },
      });
      const submit = !attempt || attempt.state === "preparing";
      if (
        !(await this.providerCapacity(
          tx,
          task.projectId,
          budget,
          submit
            ? attempt
              ? "prepared_submission"
              : "new_submission"
            : "query",
        ))
      ) {
        await tx.productionTask.update({
          where: { id },
          data: {
            state: "manual_review",
            errorCode: "PROVIDER_BUDGET_EXHAUSTED",
            leaseUntil: null,
          },
        });
        return null;
      }
      if (!attempt)
        await tx.taskAttempt.create({
          data: {
            requestId: task.providerRequestId,
            taskId: id,
            projectId: task.projectId,
            number: (await tx.taskAttempt.count({ where: { taskId: id } })) + 1,
            configuration: task.configuration as Prisma.InputJsonObject,
            configurationHash: task.configurationHash,
            state: "preparing",
            submittedAt: new Date(),
            reservedCostFen:
              this.config.transcription!.submissionReservationFen,
          },
        });
      else if (!submit)
        await tx.taskAttempt.update({
          where: { requestId: task.providerRequestId },
          data: { polls: { increment: 1 } },
        });
      return {
        submit,
        task: await tx.productionTask.update({
          where: { id },
          data: {
            processingGrant: grant as Prisma.InputJsonObject,
            state: "submitting",
            errorCode: null,
            fence: { increment: 1 },
            leaseUntil: new Date(Date.now() + 30000),
            submittedAt: task.submittedAt ?? new Date(),
          },
        }),
      };
    });
  }
  private async claimText(
    tx: Prisma.TransactionClient,
    task: ProductionTask,
    grant: Prisma.JsonObject,
  ) {
    const config = this.config.generation;
    const stop = async (errorCode: string) => {
      await tx.productionTask.update({
        where: { id: task.id },
        data: { state: "manual_review", errorCode, leaseUntil: null },
      });
      return null;
    };
    if (
      !config ||
      !this.text ||
      task.configurationHash !==
        hash(JSON.stringify(this.textOwner(task).configuration()))
    )
      return stop("CONFIGURATION_CHANGED");
    const dependencies = await this.textOwner(task).inputsIn(tx, task);
    if (dependencies.state !== "ready") {
      await tx.productionTask.update({
        where: { id: task.id },
        data: {
          state: dependencies.state,
          errorCode: dependencies.errorCode,
          nextRunAt: new Date(Date.now() + 1000),
          ...(dependencies.state === "no_speech"
            ? { completedAt: new Date() }
            : {}),
        },
      });
      return null;
    }
    const attempt = await tx.taskAttempt.findUnique({
      where: { requestId: task.providerRequestId },
    });
    if (attempt && attempt.state !== "preparing")
      return stop("PROVIDER_UNKNOWN");
    if (!(await this.textCapacity(tx, task, attempt ? 0 : 1)))
      return stop("PROVIDER_BUDGET_EXHAUSTED");
    if (!attempt)
      await tx.taskAttempt.create({
        data: {
          requestId: task.providerRequestId,
          taskId: task.id,
          projectId: task.projectId,
          number:
            (await tx.taskAttempt.count({ where: { taskId: task.id } })) + 1,
          configuration: task.configuration as Prisma.InputJsonValue,
          configurationHash: task.configurationHash,
          state: "preparing",
          submittedAt: new Date(),
          reservedCostFen: config.submissionReservationFen,
        },
      });
    return {
      submit: true,
      input: dependencies.input!,
      task: await tx.productionTask.update({
        where: { id: task.id },
        data: {
          processingGrant: grant as Prisma.InputJsonObject,
          state: "submitting",
          errorCode: null,
          fence: { increment: 1 },
          leaseUntil: new Date(Date.now() + 30000),
          submittedAt: task.submittedAt ?? new Date(),
        },
      }),
    };
  }
  private async runText(id: string) {
    const claimed = await this.claim(id);
    if (!claimed?.input) return;
    const task = claimed.task;
    const maySend = await this.db.$transaction(async (tx) => {
      if (!(await this.currentClaim(tx, task))) return false;
      return (
        (
          await tx.taskAttempt.updateMany({
            where: { requestId: task.providerRequestId, state: "preparing" },
            data: { state: "submitting" },
          })
        ).count === 1
      );
    });
    if (!maySend) return;
    const result = await this.text!.generate(
      task.kind === "ask_followup" ? "question" : "story",
      claimed.input,
    );
    await this.db.$transaction(async (tx) => {
      const current = await this.currentClaim(tx, task);
      if (
        task.kind === "ask_followup" &&
        result.output &&
        !(await this.followups.acceptsIn(tx, task, result.output))
      ) {
        result.state = "failed";
        result.failure = "invalid_output";
      }
      await tx.taskAttemptObservation.upsert({
        where: {
          requestId_fence: {
            requestId: task.providerRequestId,
            fence: task.fence,
          },
        },
        create: {
          requestId: task.providerRequestId,
          fence: task.fence,
          action: "submit",
          state: result.state,
          providerCode: result.failure,
          superseded: !current,
        },
        update: {},
      });
      await tx.taskAttempt.update({
        where: { requestId: task.providerRequestId },
        data: {
          state: result.state,
          usage: result.usage,
          model: result.model,
          failure: result.failure,
        },
      });
      if (!current) return;
      const questionFinish =
        task.kind === "ask_followup" &&
        ["finished", "declined", "not_applicable"].includes(result.state);
      if ((result.state === "succeeded" || questionFinish) && result.output)
        await this.textOwner(task).applyIn(tx, task, result.output);
      const noContent =
        task.kind === "compose_story" &&
        ["declined", "not_applicable"].includes(result.state);
      await tx.productionTask.update({
        where: { id },
        data: {
          state: questionFinish
            ? "succeeded"
            : result.state === "unknown"
              ? "manual_review"
              : noContent
                ? "no_speech"
                : result.state,
          errorCode:
            result.state === "unknown"
              ? "PROVIDER_UNKNOWN"
              : result.state === "failed"
                ? "INVALID_OUTPUT"
                : noContent
                  ? "NO_CONTENT"
                  : null,
          completedAt:
            result.state === "succeeded" || noContent || questionFinish
              ? new Date()
              : null,
          failedAt: result.state === "failed" ? new Date() : null,
          leaseUntil: null,
        },
      });
    });
  }
  private async currentClaim(
    tx: Prisma.TransactionClient,
    claim: ProductionTask,
  ) {
    const sourceClip =
      claim.kind === "transcribe_audio"
        ? await tx.recordingClip.findUniqueOrThrow({
            where: { id: claim.clipId! },
          })
        : null;
    const allowed =
      claim.kind !== "transcribe_audio"
        ? !!(await this.textOwner(claim).grantIn(tx, claim))
        : await this.participation.processingAllowed(tx, {
            ...claim,
            sourceAssistedSessionId: sourceClip!.assistedSessionId,
          });
    const row = await this.locked(tx, claim.id);
    if (
      row.fence !== claim.fence ||
      !row.leaseUntil ||
      row.leaseUntil.getTime() <= Date.now() ||
      row.state !== "submitting"
    )
      return false;
    if (!allowed) {
      await this.invalidate(tx, row);
      return false;
    }
    if (row.deadline && row.deadline.getTime() <= Date.now()) {
      await tx.productionTask.update({
        where: { id: row.id },
        data: {
          state: "manual_review",
          errorCode: "DEADLINE_EXCEEDED",
          leaseUntil: null,
        },
      });
      await tx.taskAttempt.deleteMany({
        where: { requestId: row.providerRequestId, state: "preparing" },
      });
      return false;
    }
    if (row.kind !== "transcribe_audio") return true;
    const asset = await tx.recordingAsset.findUnique({
      where: { id: row.assetId! },
    });
    const clip = await tx.recordingClip.findFirst({
      where: {
        id: row.clipId!,
        projectId: row.projectId,
        assetId: row.assetId!,
        subjectId: row.subjectId,
      },
    });
    if (
      !asset ||
      !clip ||
      asset.sha256 !== row.inputHash ||
      !this.storageMatches(asset)
    ) {
      await this.invalidate(tx, row, "INPUT_CHANGED");
      return false;
    }
    return true;
  }
  async run(id: string) {
    const kind = await this.db.productionTask.findUnique({
      where: { id },
      select: { kind: true },
    });
    if (kind && kind.kind !== "transcribe_audio") return this.runText(id);
    const claimed = await this.claim(id);
    if (!claimed) return;
    const { task, submit } = claimed;
    let result;
    try {
      let source;
      if (submit) {
        try {
          const asset = await this.db.recordingAsset.findUniqueOrThrow({
            where: { id: task.assetId! },
          });
          const bytes = await this.objects.read(asset.objectKey);
          if (
            bytes.length !== asset.bytes ||
            createHash("sha256").update(bytes).digest("hex") !== task.inputHash
          )
            throw new InvalidSealedInput("Invalid sealed source");
          source = await this.objects.asrSource?.(
            asset.objectKey,
            this.config.transcription!.doubao.fetchWindowSeconds,
          );
          if (!source)
            throw new AsrSourcePreflightError("ASR source unavailable");
        } catch (error) {
          if (error instanceof AsrSourcePreflightError) throw error;
          throw new AsrSourcePreflightError(
            "Source operation failed before ASR transport",
          );
        }
      }
      const maySend = await this.db.$transaction(async (tx) => {
        if (!(await this.currentClaim(tx, task))) return false;
        if (submit) {
          // Only this current owner can cross the durable transport boundary.
          // A crash after this mark is uncertain and must query the original UUID.
          const marked = await tx.taskAttempt.updateMany({
            where: { requestId: task.providerRequestId, state: "preparing" },
            data: { state: "submitting" },
          });
          return marked.count === 1;
        }
        return true;
      });
      if (!maySend) return;
      result = submit
        ? await this.asr!.submit(task.providerRequestId, source!)
        : await this.asr!.query(task.providerRequestId);
    } catch (error) {
      if (!(error instanceof AsrSourcePreflightError)) throw error;
      // Only preflight proves the transport was never entered. Preserve this UUID
      // and release its unused budget reservation before a controlled retry.
      await this.db.$transaction(async (tx) => {
        if (!(await this.currentClaim(tx, task))) return;
        await tx.taskAttempt.delete({
          where: { requestId: task.providerRequestId },
        });
        await tx.productionTask.update({
          where: { id },
          data: {
            state:
              error instanceof InvalidSealedInput ? "invalidated" : "failed",
            errorCode:
              error instanceof InvalidSealedInput
                ? "INPUT_CHANGED"
                : "SOURCE_UNAVAILABLE",
            leaseUntil: null,
            failedAt: new Date(),
          },
        });
      });
      return;
    }
    await this.db.$transaction(async (tx) => {
      const current = await this.currentClaim(tx, task);
      // Observed external work remains accountable when its content has become
      // unusable. No transcript or raw response is retained in this ledger.
      await tx.taskAttemptObservation.upsert({
        where: {
          requestId_fence: {
            requestId: task.providerRequestId,
            fence: task.fence,
          },
        },
        create: {
          requestId: task.providerRequestId,
          fence: task.fence,
          action: submit ? "submit" : "query",
          state: result.state,
          providerCode: result.code,
          superseded: !current,
        },
        update: {},
      });
      if (!current) return;
      if (result.state === "succeeded" && result.transcript?.trim())
        await tx.formalTranscript.create({
          data: {
            taskId: id,
            projectId: task.projectId,
            clipId: task.clipId!,
            inputHash: task.inputHash,
            text: result.transcript,
            sha256: hash(result.transcript),
            providerRequestId: task.providerRequestId,
          },
        });
      await tx.taskAttempt.update({
        where: { requestId: task.providerRequestId },
        data: { state: result.state, providerCode: result.code },
      });
      await tx.productionTask.update({
        where: { id },
        data: {
          state: ["accepted", "queued", "processing", "unknown"].includes(
            result.state,
          )
            ? "waiting_provider"
            : result.state,
          providerCode: result.code,
          errorCode:
            result.state === "no_speech"
              ? "NO_SPEECH"
              : result.state === "failed"
                ? "PROVIDER_FAILED"
                : result.state === "unknown"
                  ? "PROVIDER_UNKNOWN"
                  : null,
          completedAt: ["succeeded", "no_speech"].includes(result.state)
            ? new Date()
            : null,
          failedAt: result.state === "failed" ? new Date() : task.failedAt,
          leaseUntil: null,
          nextRunAt: new Date(
            Date.now() + this.config.transcription!.pollIntervalMs,
          ),
        },
      });
      await tx.taskOutbox.update({
        where: { taskId: id },
        data: { deliveredAt: null },
      });
    });
  }
  private async textCapacity(
    tx: Prisma.TransactionClient,
    task: ProductionTask,
    additional: number,
  ) {
    const config = this.config.generation;
    if (!config) return false;
    const budget = await this.budget(tx, task.projectId),
      total = await tx.taskAttempt.aggregate({
        where: { projectId: task.projectId },
        _sum: { reservedCostFen: true },
      }),
      ids = (
        await tx.productionTask.findMany({
          where: {
            projectId: task.projectId,
            kind: { in: ["compose_story", "ask_followup"] },
          },
          select: { id: true },
        })
      ).map((t) => t.id);
    return (
      (await tx.taskAttempt.count({ where: { taskId: { in: ids } } })) +
        additional <=
        config.maxSubmissions &&
      (total._sum.reservedCostFen ?? 0) +
        additional * config.submissionReservationFen <=
        budget.cost
    );
  }
  private async retryAllowed(
    tx: Prisma.TransactionClient,
    task: ProductionTask,
  ) {
    if (task.kind !== "transcribe_audio") {
      if (
        task.state !== "failed" ||
        !this.config.generation ||
        task.configurationHash !==
          hash(JSON.stringify(this.textOwner(task).configuration())) ||
        (task.deadline && task.deadline.getTime() <= Date.now())
      )
        return false;
      const budget = await this.budget(tx, task.projectId),
        attempt = await tx.taskAttempt.findUnique({
          where: { requestId: task.providerRequestId },
        });
      return (
        attempt?.state === "failed" &&
        (await tx.taskRetryCommand.count({
          where: { projectId: task.projectId },
        })) < budget.retries &&
        this.textCapacity(tx, task, 1)
      );
    }
    if (
      !["failed", "manual_review"].includes(task.state) ||
      !this.config.transcription ||
      task.configurationHash !==
        hash(JSON.stringify(configuration(this.config))) ||
      (task.deadline && task.deadline.getTime() <= Date.now())
    )
      return false;
    const budget = await this.budget(tx, task.projectId);
    if (
      (await tx.taskRetryCommand.count({
        where: { projectId: task.projectId },
      })) >= budget.retries
    )
      return false;
    const attempt = await tx.taskAttempt.findUnique({
      where: { requestId: task.providerRequestId },
    });
    return this.providerCapacity(
      tx,
      task.projectId,
      budget,
      !attempt || attempt.state === "failed"
        ? "new_submission"
        : attempt.state === "preparing"
          ? "prepared_submission"
          : "query",
    );
  }
  async retryIn(
    tx: Prisma.TransactionClient,
    projectId: string,
    id: string,
    actorId: string,
    actorRealm: "product" | "admin",
    key: string | undefined,
  ) {
    if (!key || !/^[-A-Za-z0-9_:]{8,128}$/.test(key))
      throw new BadRequestException();
    const initial = await tx.productionTask.findFirst({
      where: { id, projectId },
    });
    if (!initial) throw new NotFoundException();
    if (
      !(initial.kind !== "transcribe_audio"
        ? await this.textOwner(initial).grantIn(tx, initial)
        : await this.participation.processingAllowed(tx, initial))
    )
      throw new ConflictException();
    const task = await this.locked(tx, id);
    const where = {
      taskId_actorRealm_actorId_key: { taskId: id, actorRealm, actorId, key },
    };
    if (await tx.taskRetryCommand.findUnique({ where }))
      return this.view(tx, task);
    if (!(await this.retryAllowed(tx, task))) throw new ConflictException();
    const attempt = await tx.taskAttempt.findUnique({
      where: { requestId: task.providerRequestId },
    });
    const newAttempt = attempt?.state === "failed";
    await tx.taskRetryCommand.create({
      data: { projectId, taskId: id, actorId, actorRealm, key },
    });
    const updated = await tx.productionTask.update({
      where: { id },
      data: {
        state: attempt && !newAttempt ? "waiting_provider" : "queued",
        providerRequestId: newAttempt ? randomUUID() : task.providerRequestId,
        fence: { increment: 1 },
        leaseUntil: null,
        errorCode: null,
        nextRunAt: new Date(),
      },
    });
    await tx.taskOutbox.update({
      where: { taskId: id },
      data: { deliveredAt: null },
    });
    return this.view(tx, updated);
  }
  status(projectId: string, body: TaskStatusDto, authorization?: string) {
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
            ...(actor.method === "assisted"
              ? { operatorUserId: actor.operatorUserId }
              : {}),
          },
        });
        if (!interview) throw new ForbiddenException();
        const clips = await tx.recordingClip.findMany({
          where: { projectId, interviewId: interview.id },
          select: { id: true },
        });
        return Promise.all(
          (
            await tx.productionTask.findMany({
              where: {
                projectId,
                clipId: { in: clips.map((clip) => clip.id) },
              },
              orderBy: { createdAt: "asc" },
            })
          ).map((task) => this.view(tx, task, false)),
        );
      },
      "existing",
    );
  }
  retry(
    projectId: string,
    id: string,
    authorization: string | undefined,
    key: string | undefined,
    body: TaskRetryDto = {},
  ) {
    if (body.assistedSessionId)
      return this.participation.withCollectionAccess(
        projectId,
        authorization,
        body.assistedSessionId,
        async (tx, actor) => {
          const task = await tx.productionTask.findFirst({
            where: { id, projectId },
          });
          const clip =
            task?.kind === "transcribe_audio"
              ? await tx.recordingClip.findFirst({
                  where: {
                    id: task.clipId!,
                    projectId,
                    operatorUserId: actor.operatorUserId,
                    subjectId: actor.subjectId,
                    bindingVersion: actor.bindingVersion,
                    accessEpoch: actor.accessEpoch,
                  },
                })
              : null;
          if (
            !task ||
            (task.kind === "transcribe_audio"
              ? !clip
              : !(await this.textOwner(task).grantIn(tx, task)))
          )
            throw new ForbiddenException();
          await this.retryIn(
            tx,
            projectId,
            id,
            actor.operatorUserId,
            "product",
            key,
          );
          return this.adminRead(tx, projectId, id);
        },
        "existing",
      );
    return this.participation.withPlanAccess(
      projectId,
      authorization,
      undefined,
      (tx, actor) =>
        this.retryIn(tx, projectId, id, actor.userId, "product", key),
    );
  }
  async view(
    tx: Prisma.TransactionClient,
    task: ProductionTask,
    privateContent = true,
  ) {
    const retryable = await this.retryAllowed(tx, task);
    const attempts = await tx.taskAttempt.findMany({
      where: { taskId: task.id },
      orderBy: { number: "asc" },
      select: {
        requestId: true,
        number: true,
        state: true,
        providerCode: true,
        polls: true,
        reservedCostFen: true,
        actualCostFen: true,
        usage: true,
        model: true,
        failure: true,
      },
    });
    return {
      id: task.id,
      projectId: task.projectId,
      clipId: task.clipId,
      kind: task.kind,
      state: task.state,
      inputHash: task.inputHash,
      queuedAt: task.createdAt.toISOString(),
      deadline: task.deadline?.toISOString() ?? null,
      providerRequestId: task.providerRequestId,
      configurationVersion: (task.configuration as Prisma.JsonObject).version,
      providerCode: task.providerCode,
      errorCode: task.errorCode,
      retryable,
      nextAction:
        task.state === "no_speech"
          ? "record_again"
          : task.state === "failed"
            ? retryable
              ? "retry"
              : "contact_support"
            : task.state === "manual_review" ||
                task.state === "invalidated" ||
                task.state === "obsolete"
              ? "contact_support"
              : task.state === "succeeded"
                ? "continue"
                : "leave_and_return",
      submittedAt: task.submittedAt?.toISOString() ?? null,
      completedAt: task.completedAt?.toISOString() ?? null,
      failedAt: task.failedAt?.toISOString() ?? null,
      ...(privateContent && task.kind === "transcribe_audio"
        ? {
            originalTranscript: await tx.formalTranscript.findUnique({
              where: { taskId: task.id },
              select: { text: true, sha256: true, inputHash: true },
            }),
          }
        : {}),
      attempts: await Promise.all(
        attempts.map(async (attempt) => ({
          ...attempt,
          observations: await tx.taskAttemptObservation.findMany({
            where: { requestId: attempt.requestId },
            orderBy: { fence: "asc" },
            select: {
              action: true,
              state: true,
              providerCode: true,
              superseded: true,
              observedAt: true,
            },
          }),
        })),
      ),
      recordingUsageMs:
        task.kind === "transcribe_audio"
          ? (
              await tx.taskQuotaIntent.findUniqueOrThrow({
                where: { taskId: task.id },
              })
            ).consumedMs
          : 0,
    };
  }
  list(projectId: string, authorization?: string, id?: string) {
    return this.participation.withPlanAccess(
      projectId,
      authorization,
      undefined,
      async (tx) => {
        const tasks = await tx.productionTask.findMany({
          where: { projectId, ...(id ? { id } : {}) },
          orderBy: { createdAt: "asc" },
        });
        if (id && !tasks.length) throw new NotFoundException();
        const views = await Promise.all(
          tasks.map((task) => this.view(tx, task)),
        );
        return id ? views[0] : views;
      },
    );
  }
  async adminList() {
    return this.db.$transaction(async (tx) =>
      Promise.all(
        (
          await tx.productionTask.findMany({
            orderBy: { createdAt: "desc" },
            take: 100,
          })
        ).map((task) => this.view(tx, task, false)),
      ),
    );
  }
  async adminRead(tx: Prisma.TransactionClient, projectId: string, id: string) {
    const task = await tx.productionTask.findFirst({
      where: { projectId, id },
    });
    if (!task) throw new NotFoundException();
    return this.view(tx, task, false);
  }
  async onModuleDestroy() {
    await this.db.$disconnect();
  }
}
@Controller("v1/projects/:id/tasks")
@ApiTags("Production tasks")
@ApiBearerAuth()
export class ProductionTasksController {
  constructor(private readonly tasks: ProductionTasks) {}
  @Post("status") @Header("Cache-Control", "no-store") async status(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() body: TaskStatusDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.tasks.status(id, body, req.headers.authorization),
      meta: { requestId: req.id },
    };
  }
  @Get() @Header("Cache-Control", "no-store") async list(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.tasks.list(id, req.headers.authorization),
      meta: { requestId: req.id },
    };
  }
  @Get(":taskId") @Header("Cache-Control", "no-store") async read(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Param("taskId", new ParseUUIDPipe()) taskId: string,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.tasks.list(id, req.headers.authorization, taskId),
      meta: { requestId: req.id },
    };
  }
  @Post(":taskId/retry")
  @HttpCode(202)
  @Header("Cache-Control", "no-store")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  async retry(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Param("taskId", new ParseUUIDPipe()) taskId: string,
    @Body() body: TaskRetryDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.tasks.retry(
        id,
        taskId,
        req.headers.authorization,
        req.headers["idempotency-key"] as string | undefined,
        body,
      ),
      meta: { requestId: req.id },
    };
  }
}
