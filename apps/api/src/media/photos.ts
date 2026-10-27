import { PrivacyRights } from "../care/privacy-rights";
import { join } from "node:path";
import { ProjectStreams } from "./project-streams";
import { Type } from "class-transformer";
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
import {
  IsArray,
  ArrayMaxSize,
  ValidateNested,
  IsString,
  MaxLength,
  IsInt,
  IsOptional,
  IsUUID,
  Matches,
  Max,
  Min,
} from "class-validator";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { Prisma, PhotoIntent } from "@prisma/client";
import Redis from "ioredis";
import type { FastifyRequest, FastifyReply } from "fastify";
import { API_CONFIG, ApiConfig } from "../config";
import { Participation } from "../identity/participation";
import { ProbeObjects } from "../probe/local-objects";
import { claimRecordingCommand } from "./recording-command";
import { ProjectServiceTerms } from "../projects/service-terms";
import { probeStorageScope } from "../probe/storage-scope";
import { sealPhoto, PhotoBusyError } from "./seal-photo";
export const PHOTO_OBJECTS = Symbol("PHOTO_OBJECTS");
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
class CollectionDto {
  @ApiProperty({ required: false, format: "uuid" })
  @IsOptional()
  @IsUUID()
  assistedSessionId?: string;
}
class PhotoDto extends CollectionDto {
  @ApiProperty({ format: "uuid" }) @IsUUID() clientPhotoId!: string;
  @ApiProperty({ minimum: 1, maximum: 16777216 })
  @IsInt()
  @Min(1)
  @Max(16777216)
  bytes!: number;
  @ApiProperty() @Matches(/^[a-f0-9]{64}$/) sha256!: string;
}
class MaterialEntryDto {
  @ApiProperty({ format: "uuid" }) @IsUUID() photoId!: string;
  @ApiProperty() @IsString() @MaxLength(1000) caption!: string;
}
class MaterialsDto extends CollectionDto {
  @ApiProperty() @IsInt() @Min(0) @Max(2147483646) expectedRevision!: number;
  @ApiProperty({ type: [MaterialEntryDto] })
  @IsArray()
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => MaterialEntryDto)
  entries!: MaterialEntryDto[];
}
class CropDto extends CollectionDto {
  @ApiProperty() @IsInt() @Min(1) expectedRevision!: number;
  @ApiProperty() @IsInt() @Min(0) left!: number;
  @ApiProperty() @IsInt() @Min(0) top!: number;
  @ApiProperty() @IsInt() @Min(1) @Max(16000000) width!: number;
  @ApiProperty() @IsInt() @Min(1) @Max(16000000) height!: number;
}
@Injectable()
export class Photos implements OnModuleDestroy {
  private readonly redis: Redis;
  private readonly terms: ProjectServiceTerms;
  private readonly scope: string;
  private readonly storage: "oss" | "local-simulator";
  private readonly store: string;
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly participation: Participation,
    private readonly rights: PrivacyRights,
    @Inject(PHOTO_OBJECTS) private readonly objects: ProbeObjects,
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
    await this.participation.requireMaterialIn(tx, projectId, "originalPhotos");
    await this.participation.requireMaterialIn(tx, projectId, "derivedPhotos");
    const row = await tx.photoIntent.findFirst({
      where: { projectId, interviewId, id, storageScope: this.scope },
    });
    if (!row) throw new NotFoundException();
    return row;
  }
  private sameActor(
    row: Pick<
      PhotoIntent,
      "subjectId" | "operatorUserId" | "bindingVersion" | "accessEpoch"
    >,
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
  async view(tx: Prisma.TransactionClient, row: PhotoIntent) {
    const assets = await tx.photoAsset.findMany({
      where: { intentId: row.id },
    });
    const metadata = assets.find((a) => a.kind === "original")?.metadata as
      Prisma.JsonObject | undefined;
    return {
      id: row.id,
      projectId: row.projectId,
      interviewId: row.interviewId,
      actualQuestionId: row.actualQuestionId,
      clientPhotoId: row.clientPhotoId,
      bytes: row.bytes,
      sha256: row.sha256,
      state: row.state,
      storage: this.storage,
      lowResolution: metadata?.lowResolution ?? null,
      orientedPixels: metadata?.orientedPixels ?? null,
      assets: assets.map((a) => ({
        id: a.id,
        kind: a.kind,
        parentId: a.parentId,
        processingVersion: a.processingVersion,
        bytes: a.bytes,
        sha256: a.sha256,
        mime: a.mime,
        width: a.width,
        height: a.height,
      })),
    };
  }

  async usage(tx: Prisma.TransactionClient, projectId: string) {
    const sum = await tx.photoIntent.aggregate({
      where: { projectId },
      _sum: { reservedCount: true, consumedCount: true },
    });
    return {
      reservedCount: sum._sum.reservedCount ?? 0,
      consumedCount: sum._sum.consumedCount ?? 0,
    };
  }
  private async quota(tx: Prisma.TransactionClient, projectId: string) {
    await this.participation.requireMaterialIn(tx, projectId, "originalPhotos");
    await this.participation.requireMaterialIn(tx, projectId, "derivedPhotos");
    const p = await tx.project.findUniqueOrThrow({ where: { id: projectId } });
    const order = await tx.paymentOrder.findUniqueOrThrow({
      where: { id: p.orderId! },
    });
    const admission = (order.packageSnapshot as Prisma.JsonObject).admission as
      Prisma.JsonObject | undefined;
    const d04 = admission?.d04 as Prisma.JsonObject | undefined;
    const quotas = d04?.userQuotas as Prisma.JsonObject | undefined;
    const photos = quotas?.photos as Prisma.JsonObject | undefined;
    if (
      (d04?.review as Prisma.JsonObject)?.state !== "frozen" ||
      photos?.unit !== "count" ||
      !Number.isSafeInteger(photos.value) ||
      Number(photos.value) < 1
    )
      throw new ServiceUnavailableException();
    return Number(photos.value);
  }

  create(
    projectId: string,
    interviewId: string,
    body: PhotoDto,
    authorization?: string,
    key?: string,
  ) {
    return this.participation.withCollectionAccess(
      projectId,
      authorization,
      body.assistedSessionId,
      async (tx, actor) => {
        await claimRecordingCommand(tx, projectId, actor.operatorUserId, key, {
          kind: "photo",
          interviewId,
          clientPhotoId: body.clientPhotoId,
          bytes: body.bytes,
          sha256: body.sha256,
        });
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
        const prior = await tx.photoIntent.findUnique({
          where: {
            projectId_clientPhotoId: {
              projectId,
              clientPhotoId: body.clientPhotoId,
            },
          },
        });
        if (prior) {
          if (
            prior.interviewId !== interviewId ||
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
        if (usage.reservedCount + usage.consumedCount >= quota)
          throw new ConflictException();
        const row = await tx.photoIntent.create({
          data: {
            id: randomUUID(),
            projectId,
            interviewId,
            actualQuestionId: interview.actualQuestionId,
            ...actor,
            clientPhotoId: body.clientPhotoId,
            bytes: body.bytes,
            sha256: body.sha256,
            storageScope: this.scope,
            reservedCount: 1,
          },
        });
        return this.view(tx, row);
      },
    );
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
      key = `photos/staging/${id}.bin`;
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
      `${this.config.redisKeyPrefix ?? "timenook"}:photo:upload:${digest(capability)}`,
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
      url: "/v1/photos/objects",
      storage: "local-simulator",
      expiresAt,
      fields: { key, policy, "x-photo-capability": capability },
    };
  }
  async upload(
    fields: Record<string, string>,
    bytes: Buffer,
    authorization?: string,
  ) {
    if (this.storage !== "local-simulator") throw new NotFoundException();
    if (
      Object.keys(fields).sort().join(",") !== "key,policy,x-photo-capability"
    )
      throw new ForbiddenException();
    const raw = await this.redis.get(
      `${this.config.redisKeyPrefix ?? "timenook"}:photo:upload:${digest(fields["x-photo-capability"] ?? "")}`,
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

  private async ownedPhotoRun(
    tx: Prisma.TransactionClient,
    projectId: string,
    target: string,
    crop = false,
  ) {
    const run = randomUUID(),
      snapshots: Record<string, string> = {
        original: `photos/staging/${randomUUID()}.bin`,
        preview: `photos/staging/${randomUUID()}.jpg`,
        print: `photos/staging/${randomUUID()}.png`,
      };
    if (!crop)
      await this.rights.registerOwnedIn(
        tx,
        projectId,
        "originalPhotos",
        this.scope,
        [snapshots.original, `photos/sealed/${target}/original.bin`],
        run,
      );
    await this.rights.registerOwnedIn(
      tx,
      projectId,
      "derivedPhotos",
      this.scope,
      [
        snapshots.preview,
        snapshots.print,
        `photos/sealed/${target}/preview.jpg`,
        `photos/sealed/${target}/print.png`,
      ],
      run,
    );
    return {
      root: join(this.config.recording!.storageRoot, ".privacy-runs", run),
      snapshots,
    };
  }
  async seal(
    projectId: string,
    interviewId: string,
    id: string,
    body: CollectionDto,
    authorization?: string,
  ) {
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
    if (existing.state === "sealed")
      return this.status(projectId, interviewId, id, body, authorization);
    const owned = await this.participation.withCollectionAccess(
      projectId,
      authorization,
      body.assistedSessionId,
      async (tx, actor) => {
        this.sameActor(
          await this.intent(tx, projectId, interviewId, id),
          actor,
        );
        return this.ownedPhotoRun(tx, projectId, id);
      },
    );
    let verified: Awaited<ReturnType<typeof sealPhoto>>;
    try {
      verified = await sealPhoto(this.objects, {
        owned,
        id,
        bytes: existing.bytes,
        sha256: existing.sha256,
        placement: this.config.photos!.placement,
      });
    } catch (error) {
      if (error instanceof PhotoBusyError)
        throw new ServiceUnavailableException();
      throw new UnprocessableEntityException(
        "照片暂未封存，请保留原文件并重试；不支持的格式请转换为JPEG或PNG",
      );
    }
    return this.participation.withCollectionAccess(
      projectId,
      authorization,
      body.assistedSessionId,
      async (tx, actor) => {
        const row = await this.intent(tx, projectId, interviewId, id);
        this.sameActor(row, actor);
        if (row.state === "sealed") return this.view(tx, row);
        if (row.state !== "pending") throw new ConflictException();
        const usage = await this.usage(tx, projectId);
        if (
          usage.reservedCount + usage.consumedCount >
          (await this.quota(tx, projectId))
        )
          throw new ConflictException();
        const parentId = randomUUID();
        for (const a of verified.assets)
          await tx.photoAsset.create({
            data: {
              ...a,
              id: a.kind === "original" ? parentId : randomUUID(),
              projectId,
              intentId: id,
              parentId: a.kind === "original" ? null : parentId,
              processingVersion: "t04-pixels-v1",
              storage: this.storage,
              store: this.store,
              storageScope: this.scope,
              metadata: verified.metadata,
            },
          });
        const sealed = await tx.photoIntent.update({
          where: { id },
          data: { state: "sealed", reservedCount: 0, consumedCount: 1 },
        });
        const prior = await this.readSnapshot(tx, projectId, interviewId);
        await this.appendSnapshot(
          tx,
          projectId,
          interviewId,
          actor.operatorUserId,
          [
            ...(prior?.entries.map((e) => ({
              photoId: e.photoId,
              caption: e.caption ?? "",
            })) ?? []),
            { photoId: id, caption: "" },
          ],
        );
        return this.view(tx, sealed);
      },
    );
  }
  authorizeContent(
    projectId: string,
    interviewId: string,
    id: string,
    kind: string,
    authorization?: string,
    assetId?: string,
  ) {
    if (!["original", "preview", "thumbnail", "print"].includes(kind))
      throw new NotFoundException();
    return this.participation.withPlanAccess(
      projectId,
      authorization,
      undefined,
      async (tx) => {
        const row = await this.intent(tx, projectId, interviewId, id);
        if (row.state !== "sealed") throw new ConflictException();
        const terms = await this.terms.read(projectId, undefined, tx);
        const snapshot = await this.readSnapshot(tx, projectId, interviewId);
        const selected = snapshot?.entries
          .find((e) => e.photoId === id)
          ?.assets.find(
            (a) => a.kind === (kind === "thumbnail" ? "preview" : kind),
          );
        const asset = await tx.photoAsset.findFirst({
          where: {
            projectId,
            intentId: id,
            ...(assetId
              ? { id: assetId }
              : {
                  id: selected?.id,
                  kind: kind === "thumbnail" ? "preview" : kind,
                }),
          },
        });
        if (!asset) throw new NotFoundException();
        const retention =
          terms.retention?.[
            asset.kind === "original" ? "originalPhotos" : "derivedPhotos"
          ];
        if (!retention || retention.state === "expired")
          throw new ForbiddenException();
        if (
          asset.storageScope !== this.scope ||
          asset.storage !== this.storage ||
          asset.store !== this.store
        )
          throw new NotFoundException();
        return asset;
      },
    );
  }
  async content(
    projectId: string,
    interviewId: string,
    id: string,
    kind: string,
    authorization?: string,
    assetId?: string,
  ) {
    if (!["original", "preview", "thumbnail", "print"].includes(kind))
      throw new NotFoundException();
    const authorized = () =>
      this.authorizeContent(
        projectId,
        interviewId,
        id,
        kind,
        authorization,
        assetId,
      );
    const asset = await authorized();
    let bytes: Buffer;
    try {
      bytes = await this.objects.read(asset.objectKey);
      if (
        bytes.length !== asset.bytes ||
        createHash("sha256").update(bytes).digest("hex") !== asset.sha256
      )
        throw new Error();
    } catch {
      throw new UnprocessableEntityException();
    }
    await authorized();
    return { bytes, mime: asset.mime };
  }

  // Version consumers read these exact immutable references/hash inside their own
  // currently-authorized transaction, never a caller-claimed confirmed version.
  async readSnapshot(
    tx: Prisma.TransactionClient,
    projectId: string,
    interviewId: string,
    id?: string,
  ) {
    const row = await tx.photoSnapshot.findFirst({
      where: { projectId, interviewId, ...(id ? { id } : {}) },
      orderBy: { revision: "desc" },
    });
    if (!row) {
      if (id) throw new NotFoundException();
      return null;
    }
    const entries = await tx.photoReference.findMany({
      where: { snapshotId: row.id },
      orderBy: { position: "asc" },
    });
    return {
      id: row.id,
      projectId,
      interviewId,
      revision: row.revision,
      hash: row.hash,
      entries: await Promise.all(
        entries.map(async (e) => {
          const assets = await tx.photoAsset.findMany({
            where: {
              projectId,
              intentId: e.photoId,
              id: { in: [e.originalId, e.previewId, e.printId] },
            },
          });
          return {
            photoId: e.photoId,
            caption: e.caption ?? "",
            assets: assets
              .sort((a, b) => a.kind.localeCompare(b.kind))
              .map((a) => ({
                id: a.id,
                kind: a.kind,
                sha256: a.sha256,
                processingVersion: a.processingVersion,
                bytes: a.bytes,
                mime: a.mime,
                width: a.width,
                height: a.height,
              })),
          };
        }),
      ),
    };
  }
  private async appendSnapshot(
    tx: Prisma.TransactionClient,
    projectId: string,
    interviewId: string,
    operatorUserId: string,
    entries: { photoId: string; caption: string }[],
    replacement?: { photoId: string; previewId: string; printId: string },
    commandKey?: string,
  ) {
    if (new Set(entries.map((e) => e.photoId)).size !== entries.length)
      throw new BadRequestException();
    const current = await this.readSnapshot(tx, projectId, interviewId);
    const refs = [];
    for (const [position, e] of entries.entries()) {
      const photo = await this.intent(tx, projectId, interviewId, e.photoId);
      if (photo.state !== "sealed") throw new ConflictException();
      const assets = await tx.photoAsset.findMany({
        where: { projectId, intentId: e.photoId },
      });
      const prior = current?.entries.find((ref) => ref.photoId === e.photoId);
      const selected =
        replacement?.photoId === e.photoId ? replacement : undefined;
      const original = assets.find((a) => a.kind === "original"),
        preview = assets.find(
          (a) =>
            a.kind === "preview" &&
            a.id ===
              (selected?.previewId ??
                prior?.assets.find((a) => a.kind === "preview")?.id ??
                a.id),
        ),
        print = assets.find(
          (a) =>
            a.kind === "print" &&
            a.id ===
              (selected?.printId ??
                prior?.assets.find((a) => a.kind === "print")?.id ??
                a.id),
        );
      if (!original || !preview || !print) throw new ConflictException();
      refs.push({
        ...e,
        position,
        originalId: original.id,
        previewId: preview.id,
        printId: print.id,
        hashes: [original.sha256, preview.sha256, print.sha256],
      });
    }
    const id = randomUUID();
    await tx.photoSnapshot.create({
      data: {
        id,
        projectId,
        interviewId,
        revision: (current?.revision ?? 0) + 1,
        operatorUserId,
        hash: digest(JSON.stringify(refs)),
        commandKey,
      },
    });
    for (const { hashes, ...ref } of refs)
      await tx.photoReference.create({
        data: { ...ref, projectId, interviewId, snapshotId: id },
      });
    return this.readSnapshot(tx, projectId, interviewId, id);
  }
  list(projectId: string, interviewId: string, authorization?: string) {
    return this.participation.withPlanAccess(
      projectId,
      authorization,
      undefined,
      async (tx) => {
        if (
          !(await tx.interview.findFirst({
            where: { projectId, id: interviewId },
          }))
        )
          throw new NotFoundException();
        return {
          photos: await Promise.all(
            (
              await tx.photoIntent.findMany({
                where: { projectId, interviewId, storageScope: this.scope },
                orderBy: { createdAt: "asc" },
              })
            ).map((p) => this.view(tx, p)),
          ),
          snapshot: await this.readSnapshot(tx, projectId, interviewId),
          usage: await this.usage(tx, projectId),
        };
      },
    );
  }

  context(
    projectId: string,
    interviewId: string,
    body: CollectionDto,
    authorization?: string,
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
        this.sameActor(
          { ...interview, operatorUserId: actor.operatorUserId },
          actor,
        );
        const rows = await tx.photoIntent.findMany({
          where: {
            projectId,
            interviewId,
            operatorUserId: actor.operatorUserId,
            bindingVersion: actor.bindingVersion,
            accessEpoch: actor.accessEpoch,
            storageScope: this.scope,
          },
          orderBy: { createdAt: "asc" },
        });
        return {
          photos: await Promise.all(rows.map((row) => this.view(tx, row))),
          snapshot: null,
          usage: await this.usage(tx, projectId),
        };
      },
      "existing",
    );
  }
  snapshot(
    projectId: string,
    interviewId: string,
    id: string,
    authorization?: string,
  ) {
    return this.participation.withPlanAccess(
      projectId,
      authorization,
      undefined,
      (tx) => this.readSnapshot(tx, projectId, interviewId, id),
    );
  }
  revise(
    projectId: string,
    interviewId: string,
    body: MaterialsDto,
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
        this.sameActor(
          { ...interview, operatorUserId: actor.operatorUserId },
          actor,
        );
        const current = await this.readSnapshot(tx, projectId, interviewId);
        const command = {
          kind: "photo-materials",
          interviewId,
          expectedRevision: body.expectedRevision,
          entries: body.entries.map((e) => ({
            photoId: e.photoId,
            caption: e.caption ?? "",
          })),
        };
        await claimRecordingCommand(
          tx,
          projectId,
          actor.operatorUserId,
          key,
          command,
        );
        const replay = await tx.photoSnapshot.findFirst({
          where: {
            projectId,
            interviewId,
            operatorUserId: actor.operatorUserId,
            commandKey: key!,
          },
        });
        if (replay)
          return this.readSnapshot(tx, projectId, interviewId, replay.id);
        if ((current?.revision ?? 0) !== body.expectedRevision)
          throw new ConflictException();
        return this.appendSnapshot(
          tx,
          projectId,
          interviewId,
          actor.operatorUserId,
          body.entries,
          undefined,
          key,
        );
      },
    );
  }

  async crop(
    projectId: string,
    interviewId: string,
    id: string,
    body: CropDto,
    authorization?: string,
    key?: string,
  ) {
    const rect = {
      left: body.left,
      top: body.top,
      width: body.width,
      height: body.height,
    };
    const fingerprint = digest(
      JSON.stringify({ id, expectedRevision: body.expectedRevision, ...rect }),
    );
    const target = `${fingerprint.slice(0, 8)}-${fingerprint.slice(8, 12)}-4${fingerprint.slice(13, 16)}-8${fingerprint.slice(17, 20)}-${fingerprint.slice(20, 32)}`;
    const source = await this.participation.withCollectionAccess(
      projectId,
      authorization,
      body.assistedSessionId,
      async (tx, actor) => {
        const row = await this.intent(tx, projectId, interviewId, id);
        this.sameActor(row, actor);
        if (row.state !== "sealed") throw new ConflictException();
        await claimRecordingCommand(tx, projectId, actor.operatorUserId, key, {
          kind: "photo-crop",
          id,
          expectedRevision: body.expectedRevision,
          ...rect,
        });
        const replay = await tx.photoSnapshot.findFirst({
          where: {
            projectId,
            interviewId,
            operatorUserId: actor.operatorUserId,
            commandKey: key!,
          },
        });
        if (replay)
          return {
            done: await this.readSnapshot(
              tx,
              projectId,
              interviewId,
              replay.id,
            ),
          };
        const current = await this.readSnapshot(tx, projectId, interviewId);
        if (current?.revision !== body.expectedRevision) {
          if (
            current?.revision === body.expectedRevision + 1 &&
            current.entries.some(
              (e) =>
                e.photoId === id &&
                e.assets.some(
                  (a) => a.processingVersion === `crop:${fingerprint}`,
                ),
            )
          )
            return { done: current };
          throw new ConflictException();
        }
        const asset = await tx.photoAsset.findFirstOrThrow({
          where: { intentId: id, kind: "original" },
        });
        return {
          asset,
          owned: await this.ownedPhotoRun(tx, projectId, target, true),
        };
      },
    );
    if (source.done) return source.done;
    let verified: Awaited<ReturnType<typeof sealPhoto>>;
    try {
      verified = await sealPhoto(this.objects, {
        owned: source.owned,
        id: target,
        bytes: source.asset!.bytes,
        sha256: source.asset!.sha256,
        sourceKey: source.asset!.objectKey,
        placement: this.config.photos!.placement,
        crop: rect,
      });
    } catch (error) {
      if (error instanceof PhotoBusyError)
        throw new ServiceUnavailableException();
      throw new UnprocessableEntityException();
    }
    return this.participation.withCollectionAccess(
      projectId,
      authorization,
      body.assistedSessionId,
      async (tx, actor) => {
        this.sameActor(
          await this.intent(tx, projectId, interviewId, id),
          actor,
        );
        const replay = await tx.photoSnapshot.findFirst({
          where: {
            projectId,
            interviewId,
            operatorUserId: actor.operatorUserId,
            commandKey: key!,
          },
        });
        if (replay)
          return this.readSnapshot(tx, projectId, interviewId, replay.id);
        const current = await this.readSnapshot(tx, projectId, interviewId);
        if (current?.revision !== body.expectedRevision) {
          if (
            current?.revision === body.expectedRevision + 1 &&
            current.entries.some(
              (e) =>
                e.photoId === id &&
                e.assets.some(
                  (a) => a.processingVersion === `crop:${fingerprint}`,
                ),
            )
          )
            return current;
          throw new ConflictException();
        }
        const assets = [];
        for (const a of verified.assets)
          assets.push(
            await tx.photoAsset.create({
              data: {
                ...a,
                id: randomUUID(),
                projectId,
                intentId: id,
                parentId: source.asset!.id,
                processingVersion: `crop:${fingerprint}`,
                storage: this.storage,
                store: this.store,
                storageScope: this.scope,
                metadata: verified.metadata,
              },
            }),
          );
        return this.appendSnapshot(
          tx,
          projectId,
          interviewId,
          actor.operatorUserId,
          current.entries.map((e) => ({
            photoId: e.photoId,
            caption: e.caption ?? "",
          })),
          {
            photoId: id,
            previewId: assets.find((a) => a.kind === "preview")!.id,
            printId: assets.find((a) => a.kind === "print")!.id,
          },
          key,
        );
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
          await tx.photoIntent.update({
            where: { id },
            data: { state: "released", reservedCount: 0 },
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
@Controller("v1/projects/:id/interviews/:interviewId/photos")
@ApiTags("Story photos")
@ApiBearerAuth()
export class PhotosController {
  constructor(
    private readonly streams: ProjectStreams,
    private readonly photos: Photos,
  ) {}
  @Get() @Header("Cache-Control", "no-store") async list(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Param("interviewId", new ParseUUIDPipe()) interview: string,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.photos.list(id, interview, req.headers.authorization),
      meta: { requestId: req.id },
    };
  }
  @Post("materials") @Header("Cache-Control", "no-store") async revise(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Param("interviewId", new ParseUUIDPipe()) interview: string,
    @Body() body: MaterialsDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.photos.revise(
        id,
        interview,
        body,
        req.headers.authorization,
        req.headers["idempotency-key"] as string | undefined,
      ),
      meta: { requestId: req.id },
    };
  }
  @Get("materials/:snapshotId")
  @Header("Cache-Control", "no-store")
  async snapshot(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Param("interviewId", new ParseUUIDPipe()) interview: string,
    @Param("snapshotId", new ParseUUIDPipe()) snapshot: string,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.photos.snapshot(
        id,
        interview,
        snapshot,
        req.headers.authorization,
      ),
      meta: { requestId: req.id },
    };
  }

  @Post(":photoId/crop") @Header("Cache-Control", "no-store") async crop(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Param("interviewId", new ParseUUIDPipe()) interview: string,
    @Param("photoId", new ParseUUIDPipe()) photo: string,
    @Body() body: CropDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.photos.crop(
        id,
        interview,
        photo,
        body,
        req.headers.authorization,
        req.headers["idempotency-key"] as string | undefined,
      ),
      meta: { requestId: req.id },
    };
  }
  @Get(":photoId/assets/:assetId/content") async asset(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Param("interviewId", new ParseUUIDPipe()) interview: string,
    @Param("photoId", new ParseUUIDPipe()) photo: string,
    @Param("assetId", new ParseUUIDPipe()) asset: string,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const fence = await this.streams.userFence(id, req.headers.authorization);
    const result = await this.photos.content(
      id,
      interview,
      photo,
      "print",
      req.headers.authorization,
      asset,
    );
    return reply
      .header("Cache-Control", "private, no-store")
      .header("X-Content-Type-Options", "nosniff")
      .type(result.mime)
      .header("Content-Length", result.bytes.length)
      .send(
        await this.streams.guard(
          id,
          fence.epoch,
          result.bytes,
          () =>
            this.photos.authorizeContent(
              id,
              interview,
              photo,
              "print",
              req.headers.authorization,
              asset,
            ),
          req.headers.authorization,
          fence.sequence,
        ),
      );
  }

  @Post(":photoId/release") @Header("Cache-Control", "no-store") async release(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Param("interviewId", new ParseUUIDPipe()) interview: string,
    @Param("photoId", new ParseUUIDPipe()) photo: string,
    @Body() body: CollectionDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.photos.release(
        id,
        interview,
        photo,
        body,
        req.headers.authorization,
      ),
      meta: { requestId: req.id },
    };
  }

  @Post("context") @Header("Cache-Control", "no-store") async context(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Param("interviewId", new ParseUUIDPipe()) interview: string,
    @Body() body: CollectionDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.photos.context(
        id,
        interview,
        body,
        req.headers.authorization,
      ),
      meta: { requestId: req.id },
    };
  }
  @Post() @Header("Cache-Control", "no-store") async create(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Param("interviewId", new ParseUUIDPipe()) interview: string,
    @Body() body: PhotoDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.photos.create(
        id,
        interview,
        body,
        req.headers.authorization,
        req.headers["idempotency-key"] as string | undefined,
      ),
      meta: { requestId: req.id },
    };
  }
  @Post(":photoId/status") @Header("Cache-Control", "no-store") async status(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Param("interviewId", new ParseUUIDPipe()) interview: string,
    @Param("photoId", new ParseUUIDPipe()) photo: string,
    @Body() body: CollectionDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.photos.status(
        id,
        interview,
        photo,
        body,
        req.headers.authorization,
      ),
      meta: { requestId: req.id },
    };
  }
  @Post(":photoId/upload") @Header("Cache-Control", "no-store") async form(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Param("interviewId", new ParseUUIDPipe()) interview: string,
    @Param("photoId", new ParseUUIDPipe()) photo: string,
    @Body() body: CollectionDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.photos.form(
        id,
        interview,
        photo,
        body,
        req.headers.authorization,
      ),
      meta: { requestId: req.id },
    };
  }
  @Post(":photoId/seal") @Header("Cache-Control", "no-store") async seal(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Param("interviewId", new ParseUUIDPipe()) interview: string,
    @Param("photoId", new ParseUUIDPipe()) photo: string,
    @Body() body: CollectionDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.photos.seal(
        id,
        interview,
        photo,
        body,
        req.headers.authorization,
      ),
      meta: { requestId: req.id },
    };
  }
  @Get(":photoId/content/:kind") async content(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Param("interviewId", new ParseUUIDPipe()) interview: string,
    @Param("photoId", new ParseUUIDPipe()) photo: string,
    @Param("kind") kind: string,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const fence = await this.streams.userFence(id, req.headers.authorization);
    const result = await this.photos.content(
      id,
      interview,
      photo,
      kind,
      req.headers.authorization,
    );
    return reply
      .header("Cache-Control", "private, no-store")
      .header("X-Content-Type-Options", "nosniff")
      .type(result.mime)
      .header("Content-Length", result.bytes.length)
      .send(
        await this.streams.guard(
          id,
          fence.epoch,
          result.bytes,
          () =>
            this.photos.authorizeContent(
              id,
              interview,
              photo,
              kind,
              req.headers.authorization,
            ),
          req.headers.authorization,
          fence.sequence,
        ),
      );
  }
}

@Controller("v1/photos")
@ApiTags("Story photos")
export class PhotoObjectsController {
  constructor(private readonly photos: Photos) {}
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
    await this.photos.upload(fields, bytes, req.headers.authorization);
  }
}
