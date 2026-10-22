import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  Prisma,
  PrismaClient,
  ProbeAiRun,
  ProbeAiGeneration,
} from "@prisma/client";
import { API_CONFIG, ApiConfig } from "../config";
import { AudioProbe } from "./audio-probe";
import { PROBE_OBJECTS, ProbeObjects } from "./local-objects";
import { probeStorageScope } from "./storage-scope";
import {
  AI_FETCH,
  AsrSource,
  AsrSourcePreflightError,
  DoubaoConfig,
  DoubaoFileAsr,
  DeepSeekText,
} from "./ai-providers";

export interface AiProbeConfig {
  configVersion: string;
  doubao: DoubaoConfig;
  deepseek: { apiKey: string; model: string; maxTokens: number };
}
export interface AiRunCommand {
  requestId: string;
  clipId: string;
  inputVersion: string;
  sampleKind: string;
  stoppedAt: string;
}
function configuration(config: AiProbeConfig) {
  return {
    version: config.configVersion,
    doubao: {
      protocol: "bigmodel-async-v3-api-key",
      resourceId: config.doubao.resourceId,
      fetchWindowSeconds: config.doubao.fetchWindowSeconds,
    },
    deepseek: {
      model: config.deepseek.model,
      maxTokens: config.deepseek.maxTokens,
      thinking: "disabled",
    },
    promptVersion: "t03-v2",
    outputContract: "t03-v2",
  };
}
const terminal = ["succeeded", "no_speech", "failed", "invalidated"];
@Injectable()
export class AiProbe implements OnModuleDestroy {
  private readonly db: PrismaClient;
  private readonly text: DeepSeekText;
  private readonly asr: DoubaoFileAsr;
  private readonly configurationHash: string;
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly audio: AudioProbe,
    @Inject(PROBE_OBJECTS) private readonly objects: ProbeObjects,
    @Inject(AI_FETCH) transport: typeof fetch,
  ) {
    this.db = new PrismaClient({ datasourceUrl: config.databaseUrl });
    this.text = new DeepSeekText(config.aiProbe!.deepseek, transport);
    this.asr = new DoubaoFileAsr(config.aiProbe!.doubao, transport);
    // Conservative account binding: even a credential change requires a new run.
    this.configurationHash = createHash("sha256")
      .update(
        JSON.stringify({
          configuration: configuration(config.aiProbe!),
          credentials: {
            doubao: config.aiProbe!.doubao.apiKey,
            deepseek: config.aiProbe!.deepseek.apiKey,
          },
        }),
      )
      .digest("hex");
  }
  private where(ownerId: string, id: string) {
    return {
      id,
      clip: {
        ownerId,
        state: "sealed",
        storageScope: probeStorageScope(this.config.audioProbe),
      },
    };
  }
  private async load(ownerId: string, id: string) {
    const run = await this.db.probeAiRun.findFirst({
      where: this.where(ownerId, id),
    });
    if (!run) throw new NotFoundException();
    const clip = await this.audio.get(ownerId, run.clipId);
    if (clip.sha256 !== (run.input as Record<string, unknown>).sha256)
      throw new ConflictException();
    return run;
  }
  async create(ownerId: string, command: AiRunCommand) {
    const clip = await this.audio.get(ownerId, command.clipId);
    if (clip.state !== "sealed" || Date.parse(command.stoppedAt) > Date.now())
      throw new ConflictException();
    const input = {
      clipId: clip.id,
      sha256: clip.sha256,
      storageScope: probeStorageScope(this.config.audioProbe),
      audioDurationMs: clip.durationMs,
      inputVersion: command.inputVersion,
      sampleKind: command.sampleKind,
      stoppedAt: command.stoppedAt,
    };
    await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${command.requestId}, 0))`;
      const existing = await tx.probeAiRun.findUnique({
        where: { id: command.requestId },
      });
      if (existing) {
        if (
          !isDeepStrictEqual(existing.input, input) ||
          existing.configurationHash !== this.configurationHash
        )
          throw new ConflictException();
      } else
        await tx.probeAiRun.create({
          data: {
            id: command.requestId,
            clipId: clip.id,
            input,
            configuration: configuration(this.config.aiProbe!),
            configurationHash: this.configurationHash,
          },
        });
    });
    return this.get(ownerId, command.requestId);
  }
  async get(ownerId: string, id: string) {
    const run = await this.load(ownerId, id);
    const generations = await this.db.probeAiGeneration.findMany({
      where: { runId: id },
      orderBy: { startedAt: "asc" },
    });
    return {
      ...this.present(run),
      generations: generations.map((g) => this.presentGeneration(g, run)),
    };
  }
  private presentGeneration(g: ProbeAiGeneration, run: ProbeAiRun) {
    return {
      id: g.id,
      runId: g.runId,
      kind: g.kind,
      state: this.effectiveGenerationState(g),
      transcriptHash: g.transcriptHash,
      output: g.output,
      usage: g.usage,
      model: g.model,
      failure: g.failure,
      startedAt: g.startedAt,
      completedAt: g.completedAt,
      cost: null,
      usable: run.state === "succeeded" && g.state === "succeeded",
      latency: {
        transcriptToQuestionMs:
          g.kind === "question" &&
          g.state === "succeeded" &&
          g.completedAt &&
          run.completedAt
            ? g.completedAt.getTime() - run.completedAt.getTime()
            : null,
        submitToStoryMs:
          g.kind === "story" && g.state === "succeeded" && g.completedAt
            ? g.completedAt.getTime() - g.startedAt.getTime()
            : null,
      },
    };
  }
  private present(run: ProbeAiRun) {
    return {
      id: run.id,
      clipId: run.clipId,
      input: run.input,
      configuration: run.configuration,
      state: this.effectiveAsrState(run),
      originalTranscript: run.originalTranscript,
      createdAt: run.createdAt,
      submittedAt: run.submittedAt,
      completedAt: run.completedAt,
      providerCode: run.providerCode,
      submitAttempts: run.attempts,
      cost: null,
      latency: {
        stopToTranscriptMs:
          run.state === "succeeded" && run.completedAt
            ? run.completedAt.getTime() -
              Date.parse(
                String((run.input as Record<string, unknown>).stoppedAt),
              )
            : null,
        stopTimeSource: "caller-declared",
      },
    };
  }
  async advance(ownerId: string, id: string, authorization: string) {
    const initial = await this.load(ownerId, id);
    if (terminal.includes(initial.state)) return this.present(initial);
    if (initial.configurationHash !== this.configurationHash)
      throw new ConflictException();
    let source: AsrSource | undefined;
    if (initial.state === "ready") {
      if (!this.objects.asrSource)
        throw new ConflictException("Public OSS source required");
      // Verify the sealed bytes before releasing a provider capability.
      await this.audio.content(ownerId, initial.clipId);
      source = await this.objects.asrSource(
        `sealed/${initial.clipId}.mp3`,
        this.config.aiProbe!.doubao.fetchWindowSeconds,
      );
    }
    await this.audio.identity(authorization);
    const claimed = await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM probe_ai_runs WHERE id = ${id}::uuid FOR UPDATE`;
      const run = await tx.probeAiRun.findFirst({
        where: this.where(ownerId, id),
      });
      if (!run) throw new NotFoundException();
      if (
        terminal.includes(run.state) ||
        (run.leaseUntil && run.leaseUntil.getTime() > Date.now())
      )
        return null;
      const submit = run.state === "ready";
      if (submit && !source) throw new ConflictException();
      return {
        submit,
        run: await tx.probeAiRun.update({
          where: { id },
          data: {
            state: submit ? "submitting" : "querying",
            fence: { increment: 1 },
            leaseUntil: new Date(Date.now() + 30000),
            ...(submit
              ? { submittedAt: new Date(), attempts: { increment: 1 } }
              : {}),
          },
        }),
      };
    });
    if (!claimed) return this.get(ownerId, id);
    try {
      await this.audio.identity(authorization);
      const current = await this.load(ownerId, id);
      if (
        current.fence !== claimed.run.fence ||
        current.state === "invalidated"
      )
        return this.get(ownerId, id);
    } catch {
      await this.invalidateAsrClaim(id, claimed.run.fence);
      throw new ConflictException();
    }
    let result;
    try {
      result = claimed.submit
        ? await this.asr.submit(id, source!)
        : await this.asr.query(id);
    } catch (error) {
      if (!claimed.submit || !(error instanceof AsrSourcePreflightError))
        throw error;
      // No transport was entered. Only this claim may undo its submit marker;
      // a later command signs a fresh source for the same persisted UUID.
      await this.db.probeAiRun.updateMany({
        where: {
          ...this.where(ownerId, id),
          fence: claimed.run.fence,
          state: "submitting",
        },
        data: {
          state: "ready",
          fence: { increment: 1 },
          attempts: { decrement: 1 },
          submittedAt: null,
          leaseUntil: null,
        },
      });
      return this.get(ownerId, id);
    }
    try {
      await this.audio.identity(authorization);
      await this.load(ownerId, id);
    } catch {
      await this.invalidateAsrClaim(id, claimed.run.fence);
      throw new ConflictException();
    }
    await this.db.probeAiRun.updateMany({
      where: {
        ...this.where(ownerId, id),
        fence: claimed.run.fence,
        state: { not: "invalidated" },
      },
      data: {
        state: result.state,
        providerCode: result.code,
        leaseUntil: null,
        ...(terminal.includes(result.state) ? { completedAt: new Date() } : {}),
        ...(result.transcript !== undefined
          ? { originalTranscript: result.transcript }
          : {}),
      },
    });
    return this.get(ownerId, id);
  }
  private invalidateAsrClaim(id: string, fence: number) {
    return this.db.probeAiRun.updateMany({
      where: { id, fence },
      data: {
        state: "invalidated",
        fence: { increment: 1 },
        leaseUntil: null,
      },
    });
  }
  async metrics(ownerId: string) {
    const runs = await this.db.probeAiRun.findMany({
      where: {
        clip: {
          ownerId,
          storageScope: probeStorageScope(this.config.audioProbe),
        },
      },
      include: { generations: true },
    });
    const grouped = new Map<string, typeof runs>();
    for (const run of runs) {
      const key = `${(run.input as Record<string, unknown>).sampleKind}:${run.configurationHash}`;
      const rows = grouped.get(key) ?? [];
      rows.push(run);
      grouped.set(key, rows);
    }
    function summary(states: string[], finalStates: string[]) {
      const counts: Record<string, number> = {};
      for (const state of states) counts[state] = (counts[state] ?? 0) + 1;
      const finalCount = states.filter((s) => finalStates.includes(s)).length;
      return {
        counts,
        total: states.length,
        finalCount,
        failureRateAmongFinal: finalCount
          ? (counts.failed ?? 0) / finalCount
          : null,
      };
    }
    return {
      groups: [...grouped.values()].map((rows) => {
        const generations = rows.flatMap((r) => r.generations);
        const knownUsage = generations.filter((g) => g.usage !== null);
        return {
          sampleKind: (rows[0].input as Record<string, unknown>).sampleKind,
          configuration: rows[0].configuration,
          asr: summary(
            rows.map((r) => this.effectiveAsrState(r)),
            ["succeeded", "no_speech", "failed"],
          ),
          generation: summary(
            generations.map((g) => this.effectiveGenerationState(g)),
            ["succeeded", "finished", "declined", "not_applicable", "failed"],
          ),
          usage: {
            sealedAudioMs: rows.reduce(
              (total, r) =>
                total +
                Number(
                  (r.input as Record<string, unknown>).audioDurationMs ?? 0,
                ),
              0,
            ),
            generationAttemptsWithUsage: knownUsage.length,
            generationAttemptsWithoutUsage:
              generations.length - knownUsage.length,
            reportedTotalTokens: knownUsage.reduce(
              (total, g) =>
                total +
                Number((g.usage as Record<string, unknown>).total_tokens ?? 0),
              0,
            ),
          },
          cost: null,
        };
      }),
    };
  }
  private effectiveAsrState(run: ProbeAiRun) {
    return ["submitting", "querying"].includes(run.state) &&
      run.leaseUntil &&
      run.leaseUntil.getTime() < Date.now()
      ? "unknown"
      : run.state;
  }
  private effectiveGenerationState(g: ProbeAiGeneration) {
    return g.state === "generating" &&
      g.startedAt.getTime() + 30000 < Date.now()
      ? "unknown"
      : g.state;
  }
  async invalidate(ownerId: string, id: string) {
    await this.load(ownerId, id);
    await this.db.$transaction(async (tx) => {
      await tx.probeAiRun.update({
        where: { id },
        data: {
          state: "invalidated",
          fence: { increment: 1 },
          leaseUntil: null,
        },
      });
      await tx.probeAiGeneration.updateMany({
        where: { runId: id, state: { in: ["generating", "unknown"] } },
        data: { state: "invalidated" },
      });
    });
    return this.get(ownerId, id);
  }
  async generate(
    ownerId: string,
    id: string,
    authorization: string,
    command: { requestId: string; kind: "question" | "story" },
  ) {
    const run = await this.load(ownerId, id);
    if (
      run.state !== "succeeded" ||
      !run.originalTranscript?.trim() ||
      run.configurationHash !== this.configurationHash
    )
      throw new ConflictException();
    const transcriptHash = createHash("sha256")
      .update(run.originalTranscript)
      .digest("hex");
    const claim = await this.db.$transaction(async (tx) => {
      // Parent run first, then the generation command: invalidation uses the same order.
      await tx.$executeRaw`SELECT id FROM probe_ai_runs WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.probeAiRun.findFirst({
        where: this.where(ownerId, id),
      });
      if (
        !current ||
        current.state !== "succeeded" ||
        current.fence !== run.fence ||
        current.configurationHash !== this.configurationHash ||
        current.originalTranscript !== run.originalTranscript
      )
        throw new ConflictException();
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${command.requestId}, 0))`;
      const existing = await tx.probeAiGeneration.findUnique({
        where: { id: command.requestId },
      });
      if (existing) {
        if (
          existing.runId !== id ||
          existing.kind !== command.kind ||
          existing.transcriptHash !== transcriptHash
        )
          throw new ConflictException();
        return { execute: false, generation: existing };
      }
      return {
        execute: true,
        generation: await tx.probeAiGeneration.create({
          data: {
            id: command.requestId,
            runId: id,
            kind: command.kind,
            transcriptHash,
          },
        }),
      };
    });
    if (!claim.execute) return this.presentGeneration(claim.generation, run);
    try {
      await this.audio.identity(authorization);
      const current = await this.load(ownerId, id);
      if (
        current.state !== "succeeded" ||
        current.fence !== run.fence ||
        current.originalTranscript !== run.originalTranscript
      )
        throw new ConflictException();
    } catch {
      await this.invalidateGeneration(command.requestId);
      throw new ConflictException();
    }
    const result = await this.text.generate(command.kind, {
      clipId: run.clipId,
      transcript: run.originalTranscript,
      transcriptHash,
    });
    // Provider accounting is independent of whether content is still eligible to apply.
    await this.db.probeAiGeneration.updateMany({
      where: { id: command.requestId, runId: id },
      data: {
        usage: result.usage,
        model: result.model,
        failure: result.failure,
      },
    });
    try {
      await this.audio.identity(authorization);
      await this.load(ownerId, id);
    } catch {
      await this.invalidateGeneration(command.requestId);
      throw new ConflictException();
    }
    await this.db.probeAiGeneration.updateMany({
      where: {
        id: command.requestId,
        state: "generating",
        run: {
          ...this.where(ownerId, id),
          state: "succeeded",
          fence: run.fence,
        },
      },
      data: {
        state: result.state,
        output: result.output as Prisma.InputJsonValue | undefined,
        usage: result.usage,
        model: result.model,
        failure: result.failure,
        ...(result.state !== "unknown" ? { completedAt: new Date() } : {}),
      },
    });
    return this.presentGeneration(
      await this.db.probeAiGeneration.findUniqueOrThrow({
        where: { id: command.requestId },
      }),
      await this.load(ownerId, id),
    );
  }
  private invalidateGeneration(id: string) {
    return this.db.probeAiGeneration.updateMany({
      where: { id, state: "generating" },
      data: { state: "invalidated" },
    });
  }
  async onModuleDestroy() {
    await this.db.$disconnect();
  }
}
