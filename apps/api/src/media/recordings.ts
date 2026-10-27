import { PrivacyRights } from "../care/privacy-rights";
import { ProjectStreams } from "./project-streams";
import { createTranscription } from "../tasks/tasks";
import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Injectable,
  OnModuleDestroy,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ApiBearerAuth, ApiProperty, ApiTags } from "@nestjs/swagger";
import { IsInt, IsOptional, IsUUID, Matches, Max, Min } from "class-validator";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { Prisma, RecordingIntent } from "@prisma/client";
import Redis from "ioredis";
import type { FastifyRequest, FastifyReply } from "fastify";
import { API_CONFIG, ApiConfig } from "../config";
import { Participation } from "../identity/participation";
import { ProbeObjects } from "../probe/local-objects";
import { claimRecordingCommand } from "./recording-command";
import { sendAudio } from "./send-audio";
import { ProjectServiceTerms } from "../projects/service-terms";
import { probeStorageScope } from "../probe/storage-scope";
import { sealAudio } from "./seal-audio";
export const RECORDING_OBJECTS = Symbol("RECORDING_OBJECTS");
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
class CollectionDto {
  @ApiProperty({ required: false, format: "uuid" })
  @IsOptional()
  @IsUUID()
  assistedSessionId?: string;
}
class ClipDto extends CollectionDto {
  @ApiProperty({ format: "uuid" }) @IsUUID() clientClipId!: string;
  @ApiProperty({ required: false, format: "uuid" })
  @IsOptional()
  @IsUUID()
  actualQuestionId?: string;
  @ApiProperty({ minimum: 1, maximum: 2097152 })
  @IsInt()
  @Min(1)
  @Max(2097152)
  bytes!: number;
  @ApiProperty() @Matches(/^[a-f0-9]{64}$/) sha256!: string;
}
@Injectable()
export class Recordings implements OnModuleDestroy {
  private readonly redis: Redis;
  private readonly scope: string;
  private readonly storage: "oss" | "local-simulator";
  private readonly store: string;
  private readonly terms: ProjectServiceTerms;
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly participation: Participation,
    private readonly rights: PrivacyRights,
    @Inject(RECORDING_OBJECTS) private readonly objects: ProbeObjects,
  ) {
    this.redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 0 });
    this.redis.on("error", () => {});
    this.terms = new ProjectServiceTerms(config.databaseUrl);
    this.scope = digest(`product:${probeStorageScope(config.recording)}`);
    this.storage = config.recording?.oss ? "oss" : "local-simulator";
    this.store = config.recording?.oss
      ? `oss:${config.recording.oss.bucket}:${config.recording.oss.region}`
      : `local:${config.recording?.storageRoot}`;
  }
  private async intent(
    tx: Prisma.TransactionClient,
    projectId: string,
    interviewId: string,
    id: string,
  ) {
    const row = await tx.recordingIntent.findFirst({
      where: { projectId, interviewId, id, storageScope: this.scope },
    });
    if (!row) throw new NotFoundException();
    return row;
  }
  private sameActor(
    row: RecordingIntent,
    actor: {
      subjectId: string;
      operatorUserId: string;
      bindingVersion: number;
      accessEpoch: number;
    },
  ) {
    if (
      row.subjectId !== actor.subjectId ||
      row.operatorUserId !== actor.operatorUserId ||
      row.bindingVersion !== actor.bindingVersion ||
      row.accessEpoch !== actor.accessEpoch
    )
      throw new ForbiddenException();
  }
  async view(tx: Prisma.TransactionClient, row: RecordingIntent) {
    const clip = await tx.recordingClip.findUnique({
      where: { intentId: row.id },
    });
    const asset = clip
      ? await tx.recordingAsset.findUniqueOrThrow({
          where: { id: clip.assetId },
        })
      : null;
    const event = clip
      ? await tx.sealedInput.findUniqueOrThrow({ where: { clipId: clip.id } })
      : null;
    return {
      id: row.id,
      projectId: row.projectId,
      interviewId: row.interviewId,
      actualQuestionId: row.actualQuestionId,
      clientClipId: row.clientClipId,
      bytes: row.bytes,
      sha256: row.sha256,
      state: row.state,
      durationMs: asset?.durationMs ?? null,
      storage: asset?.storage ?? this.storage,
      asset: asset
        ? {
            storage: asset.storage,
            id: asset.id,
            sha256: asset.sha256,
            bytes: asset.bytes,
            mime: asset.mime,
          }
        : null,
      sealedInput: event ? { id: event.id, kind: event.kind } : null,
    };
  }
  async usage(tx: Prisma.TransactionClient, projectId: string) {
    const sum = await tx.recordingIntent.aggregate({
      where: { projectId },
      _sum: { reservedMs: true, consumedMs: true },
    });
    return {
      reservedMs: sum._sum.reservedMs ?? 0,
      consumedMs: sum._sum.consumedMs ?? 0,
    };
  }
  private async quota(tx: Prisma.TransactionClient, projectId: string) {
    const p = await tx.project.findUniqueOrThrow({ where: { id: projectId } });
    const order = await tx.paymentOrder.findUniqueOrThrow({
      where: { id: p.orderId! },
    });
    const admission = (order.packageSnapshot as Prisma.JsonObject).admission as
      Prisma.JsonObject | undefined;
    const d04 = admission?.d04 as Prisma.JsonObject | undefined;
    const quotas = d04?.userQuotas as Prisma.JsonObject | undefined;
    const per = quotas?.recordingPerClip as Prisma.JsonObject | undefined,
      total = quotas?.recordingTotal as Prisma.JsonObject | undefined;
    if (
      (d04?.review as Prisma.JsonObject)?.state !== "frozen" ||
      per?.unit !== "seconds" ||
      total?.unit !== "seconds" ||
      !Number.isSafeInteger(per.value) ||
      !Number.isSafeInteger(total.value) ||
      Number(per.value) < 1 ||
      Number(total.value) < 1
    )
      throw new ServiceUnavailableException();
    return {
      perClipMs: Math.min(Number(per.value) * 1000, 300000),
      totalMs: Number(total.value) * 1000,
    };
  }
  create(
    projectId: string,
    interviewId: string,
    body: ClipDto,
    authorization?: string,
    key?: string,
  ) {
    return this.participation.withCollectionAccess(
      projectId,
      authorization,
      body.assistedSessionId,
      async (tx, actor) => {
        const interview = await tx.interview.findFirst({
          where: { projectId, id: interviewId },
        });
        if (!interview) throw new NotFoundException();
        if (
          interview.subjectId !== actor.subjectId ||
          interview.bindingVersion !== actor.bindingVersion ||
          interview.accessEpoch !== actor.accessEpoch
        )
          throw new ForbiddenException();
        // Older local manifests only ever recorded the immutable starting question.
        const actualQuestionId =
          body.actualQuestionId ?? interview.actualQuestionId;
        if (
          !(await tx.interviewActualQuestion.findUnique({
            where: {
              projectId_interviewId_actualQuestionId: {
                projectId,
                interviewId,
                actualQuestionId,
              },
            },
          }))
        )
          throw new BadRequestException();
        await claimRecordingCommand(tx, projectId, actor.operatorUserId, key, {
          kind: "clip",
          interviewId,
          clientClipId: body.clientClipId,
          bytes: body.bytes,
          sha256: body.sha256,
          // Preserve pre-T17 idempotency hashes for the original question.
          ...(actualQuestionId !== interview.actualQuestionId
            ? { actualQuestionId }
            : {}),
        });
        const prior = await tx.recordingIntent.findUnique({
          where: {
            projectId_clientClipId: {
              projectId,
              clientClipId: body.clientClipId,
            },
          },
        });
        if (prior) {
          if (
            prior.interviewId !== interviewId ||
            prior.actualQuestionId !== actualQuestionId ||
            prior.bytes !== body.bytes ||
            prior.sha256 !== body.sha256 ||
            prior.storageScope !== this.scope
          )
            throw new ConflictException();
          this.sameActor(prior, actor);
          return this.view(tx, prior);
        }
        const quota = await this.quota(tx, projectId),
          usage = await this.usage(tx, projectId);
        const reservation = Math.min(
          quota.perClipMs,
          quota.totalMs - usage.reservedMs - usage.consumedMs,
        );
        if (reservation < 1) throw new ConflictException();
        const row = await tx.recordingIntent.create({
          data: {
            id: randomUUID(),
            projectId,
            interviewId,
            actualQuestionId,
            ...actor,
            clientClipId: body.clientClipId,
            bytes: body.bytes,
            sha256: body.sha256,
            storageScope: this.scope,
            reservedMs: reservation,
          },
        });
        return this.view(tx, row);
      },
    );
  }
  read(
    projectId: string,
    interviewId: string,
    id: string,
    authorization?: string,
  ) {
    return this.participation.withPlanAccess(
      projectId,
      authorization,
      undefined,
      async (tx) =>
        this.view(tx, await this.intent(tx, projectId, interviewId, id)),
    );
  }
  authorizeContent(
    projectId: string,
    interviewId: string,
    id: string,
    authorization?: string,
  ) {
    return this.participation.withPlanAccess(
      projectId,
      authorization,
      undefined,
      async (tx) => {
        const row = await this.intent(tx, projectId, interviewId, id);
        if (row.state !== "sealed") throw new ConflictException();
        const terms = await this.terms.read(projectId, undefined, tx);
        if (
          terms.playback?.state === "expired" ||
          terms.retention?.originalAudio?.state === "expired"
        )
          throw new ForbiddenException();
        return row;
      },
    );
  }
  async content(
    projectId: string,
    interviewId: string,
    id: string,
    authorization?: string,
  ) {
    const authorized = () =>
      this.authorizeContent(projectId, interviewId, id, authorization);
    const row = await authorized();
    const bytes = await this.objects.read(`sealed/${id}.mp3`);
    if (
      bytes.length !== row.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== row.sha256
    )
      throw new UnprocessableEntityException();
    await authorized();
    return bytes;
  }
  status(
    projectId: string,
    interviewId: string,
    id: string,
    body: CollectionDto,
    authorization?: string,
  ) {
    return this.participation.withCollectionAccess(
      projectId,
      authorization,
      body.assistedSessionId,
      async (tx, actor) => {
        const row = await this.intent(tx, projectId, interviewId, id);
        this.sameActor(row, actor);
        return this.view(tx, row);
      },
      "existing",
    );
  }
  async form(
    projectId: string,
    interviewId: string,
    id: string,
    body: CollectionDto,
    authorization?: string,
  ) {
    const row = await this.participation.withCollectionAccess(
      projectId,
      authorization,
      body.assistedSessionId,
      async (tx, actor) => {
        const row = await this.intent(tx, projectId, interviewId, id);
        this.sameActor(row, actor);
        if (row.state !== "pending") throw new ConflictException();
        return row;
      },
    );
    const expiresAt = new Date(Date.now() + 120000).toISOString(),
      key = `staging/${id}.mp3`;
    if (this.objects.uploadForm) {
      const form = await this.objects.uploadForm(
        key,
        row.bytes,
        new Date(expiresAt),
      );
      if (form.storage !== this.storage) throw new ConflictException();
      await this.participation.withCollectionAccess(
        projectId,
        authorization,
        body.assistedSessionId,
        async (tx, actor) =>
          this.sameActor(
            await this.intent(tx, projectId, interviewId, id),
            actor,
          ),
      );
      return form;
    }
    if (this.storage !== "local-simulator")
      throw new ServiceUnavailableException();
    const policy = Buffer.from(
      JSON.stringify({
        expiration: expiresAt,
        conditions: [
          ["eq", "$key", key],
          ["content-length-range", row.bytes, row.bytes],
        ],
      }),
    ).toString("base64");
    const capability = randomBytes(32).toString("base64url");
    await this.redis.set(
      `${this.config.redisKeyPrefix ?? "timenook"}:recording:upload:${digest(capability)}`,
      JSON.stringify({
        projectId,
        interviewId,
        id,
        bytes: row.bytes,
        key,
        policy,
        expiresAt,
        authorizationHash: digest(authorization ?? ""),
        assistedSessionId: body.assistedSessionId,
      }),
      "EX",
      120,
    );
    return {
      url: "/v1/recordings/objects",
      storage: "local-simulator",
      expiresAt,
      fields: { key, policy, "x-recording-capability": capability },
    };
  }
  async upload(
    fields: Record<string, string>,
    bytes: Buffer,
    authorization?: string,
  ) {
    if (this.storage !== "local-simulator") throw new NotFoundException();
    if (
      Object.keys(fields).sort().join(",") !==
      "key,policy,x-recording-capability"
    )
      throw new ForbiddenException();
    const raw = await this.redis.get(
      `${this.config.redisKeyPrefix ?? "timenook"}:recording:upload:${digest(fields["x-recording-capability"] ?? "")}`,
    );
    if (!raw) throw new ForbiddenException();
    const permission = JSON.parse(raw);
    if (
      permission.key !== fields.key ||
      permission.policy !== fields.policy ||
      permission.authorizationHash !== digest(authorization ?? "") ||
      Date.parse(permission.expiresAt) <= Date.now()
    )
      throw new ForbiddenException();
    if (bytes.length !== permission.bytes) throw new BadRequestException();
    await this.participation.withCollectionAccess(
      permission.projectId,
      authorization,
      permission.assistedSessionId,
      async (tx, actor) => {
        const row = await this.intent(
          tx,
          permission.projectId,
          permission.interviewId,
          permission.id,
        );
        this.sameActor(row, actor);
        if (row.state !== "pending") throw new ConflictException();
        await this.objects.put(permission.key, bytes);
      },
    );
  }
  async seal(
    projectId: string,
    interviewId: string,
    id: string,
    body: CollectionDto,
    authorization?: string,
  ) {
    // Check existing durable status first. Sealed reads do not use canRecord.
    const existing = await this.participation.withCollectionAccess(
      projectId,
      authorization,
      body.assistedSessionId,
      async (tx, actor) => {
        const row = await this.intent(tx, projectId, interviewId, id);
        this.sameActor(row, actor);
        return row;
      },
      "existing",
    );
    if (existing.state === "released") throw new ConflictException();
    if (existing.state !== "pending")
      return this.participation.withCollectionAccess(
        projectId,
        authorization,
        body.assistedSessionId,
        async (tx, actor) => {
          const row = await this.intent(tx, projectId, interviewId, id);
          this.sameActor(row, actor);
          return this.view(tx, row);
        },
        "existing",
      );
    const snapshotKey = `staging/${randomUUID()}.mp3`;
    await this.participation.withCollectionAccess(
      projectId,
      authorization,
      body.assistedSessionId,
      async (tx, actor) => {
        this.sameActor(
          await this.intent(tx, projectId, interviewId, id),
          actor,
        );
        await this.rights.registerOwnedIn(
          tx,
          projectId,
          "originalAudio",
          this.scope,
          [snapshotKey, `sealed/${id}.mp3`],
        );
      },
    );
    let verified: Awaited<ReturnType<typeof sealAudio>>;
    try {
      verified = await sealAudio(this.objects, {
        snapshotKey,
        source: `staging/${id}.mp3`,
        target: `sealed/${id}.mp3`,
        bytes: existing.bytes,
        sha256: existing.sha256,
      });
    } catch {
      throw new UnprocessableEntityException();
    }
    // Storage I/O cannot hold identity locks. Recheck current session/purpose,
    // epoch, deadline and quota in the transaction that writes every durable fact.
    return this.participation.withCollectionAccess(
      projectId,
      authorization,
      body.assistedSessionId,
      async (tx, actor) => {
        const row = await this.intent(tx, projectId, interviewId, id);
        this.sameActor(row, actor);
        if (row.state === "sealed") return this.view(tx, row);
        if (row.state !== "pending") throw new ConflictException();
        const quota = await this.quota(tx, projectId),
          usage = await this.usage(tx, projectId);
        if (
          verified.durationMs > quota.perClipMs ||
          verified.durationMs > row.reservedMs ||
          usage.consumedMs +
            usage.reservedMs -
            row.reservedMs +
            verified.durationMs >
            quota.totalMs
        )
          throw new ConflictException();
        const asset = await tx.recordingAsset.create({
          data: {
            id: randomUUID(),
            projectId,
            storageScope: this.scope,
            storage: this.storage,
            store: this.store,
            ...verified,
          },
        });
        const sequence =
          (await tx.recordingClip.count({ where: { interviewId } })) + 1;
        const clip = await tx.recordingClip.create({
          data: {
            id: randomUUID(),
            projectId,
            interviewId,
            actualQuestionId: row.actualQuestionId,
            intentId: row.id,
            assetId: asset.id,
            clientClipId: row.clientClipId,
            sequence,
            ...actor,
          },
        });
        const input = await tx.sealedInput.create({
          data: { id: randomUUID(), projectId, clipId: clip.id },
        });
        await createTranscription(tx, clip, asset, input, this.config);
        const sealed = await tx.recordingIntent.update({
          where: { id: row.id },
          data: {
            state: "sealed",
            reservedMs: 0,
            consumedMs: verified.durationMs,
          },
        });
        return this.view(tx, sealed);
      },
    );
  }
  release(
    projectId: string,
    interviewId: string,
    id: string,
    body: CollectionDto,
    authorization?: string,
  ) {
    return this.participation.withCollectionAccess(
      projectId,
      authorization,
      body.assistedSessionId,
      async (tx, actor) => {
        const row = await this.intent(tx, projectId, interviewId, id);
        this.sameActor(row, actor);
        if (row.state === "sealed") throw new ConflictException();
        return this.view(
          tx,
          await tx.recordingIntent.update({
            where: { id },
            data: { state: "released", reservedMs: 0 },
          }),
        );
      },
      "existing",
    );
  }
  async onModuleDestroy() {
    this.redis.disconnect();
    await this.terms.close();
  }
}
@Controller("v1/projects/:id/interviews/:interviewId/clips")
@ApiTags("Interview recording")
@ApiBearerAuth()
export class RecordingsController {
  constructor(
    private readonly streams: ProjectStreams,
    private readonly recordings: Recordings,
  ) {}
  @Post() @Header("Cache-Control", "no-store") async create(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Param("interviewId", new ParseUUIDPipe()) interview: string,
    @Body() body: ClipDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.recordings.create(
        id,
        interview,
        body,
        req.headers.authorization,
        req.headers["idempotency-key"] as string | undefined,
      ),
      meta: { requestId: req.id },
    };
  }
  @Post(":clipId/release") @Header("Cache-Control", "no-store") async release(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Param("interviewId", new ParseUUIDPipe()) interview: string,
    @Param("clipId", new ParseUUIDPipe()) clip: string,
    @Body() body: CollectionDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.recordings.release(
        id,
        interview,
        clip,
        body,
        req.headers.authorization,
      ),
      meta: { requestId: req.id },
    };
  }
  @Get(":clipId") @Header("Cache-Control", "no-store") async read(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Param("interviewId", new ParseUUIDPipe()) interview: string,
    @Param("clipId", new ParseUUIDPipe()) clip: string,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.recordings.read(
        id,
        interview,
        clip,
        req.headers.authorization,
      ),
      meta: { requestId: req.id },
    };
  }
  @Get(":clipId/content") async content(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Param("interviewId", new ParseUUIDPipe()) interview: string,
    @Param("clipId", new ParseUUIDPipe()) clip: string,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const fence = await this.streams.userFence(id, req.headers.authorization);
    return sendAudio(
      await this.recordings.content(
        id,
        interview,
        clip,
        req.headers.authorization,
      ),
      clip,
      req.headers.range,
      reply,
      (bytes) =>
        this.streams.guard(
          id,
          fence.epoch,
          bytes,
          () =>
            this.recordings.authorizeContent(
              id,
              interview,
              clip,
              req.headers.authorization,
            ),
          req.headers.authorization,
          fence.sequence,
        ),
    );
  }
  @Post(":clipId/status") @Header("Cache-Control", "no-store") async status(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Param("interviewId", new ParseUUIDPipe()) interview: string,
    @Param("clipId", new ParseUUIDPipe()) clip: string,
    @Body() body: CollectionDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.recordings.status(
        id,
        interview,
        clip,
        body,
        req.headers.authorization,
      ),
      meta: { requestId: req.id },
    };
  }
  @Post(":clipId/upload") @Header("Cache-Control", "no-store") async form(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Param("interviewId", new ParseUUIDPipe()) interview: string,
    @Param("clipId", new ParseUUIDPipe()) clip: string,
    @Body() body: CollectionDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.recordings.form(
        id,
        interview,
        clip,
        body,
        req.headers.authorization,
      ),
      meta: { requestId: req.id },
    };
  }
  @Post(":clipId/seal") @Header("Cache-Control", "no-store") async seal(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Param("interviewId", new ParseUUIDPipe()) interview: string,
    @Param("clipId", new ParseUUIDPipe()) clip: string,
    @Body() body: CollectionDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.recordings.seal(
        id,
        interview,
        clip,
        body,
        req.headers.authorization,
      ),
      meta: { requestId: req.id },
    };
  }
}
@Controller("v1/recordings")
@ApiTags("Interview recording")
export class RecordingObjectsController {
  constructor(private readonly recordings: Recordings) {}
  @Post("objects")
  @HttpCode(204)
  @Header("Cache-Control", "no-store")
  async upload(@Req() req: FastifyRequest) {
    const fields: Record<string, string> = {};
    let bytes: Buffer | undefined;
    try {
      for await (const part of req.parts()) {
        if (part.type === "file") {
          if (part.fieldname !== "file" || bytes) throw new Error();
          bytes = await part.toBuffer();
        } else {
          if (
            bytes ||
            fields[part.fieldname] !== undefined ||
            typeof part.value !== "string"
          )
            throw new Error();
          fields[part.fieldname] = part.value;
        }
      }
    } catch {
      throw new BadRequestException();
    }
    if (!bytes) throw new BadRequestException();
    await this.recordings.upload(fields, bytes, req.headers.authorization);
  }
}
