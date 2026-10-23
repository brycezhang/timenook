import {
  Inject,
  Injectable,
  OnModuleDestroy,
  UnauthorizedException,
  ConflictException,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import type {
  ProbeClipCommand,
  ProbeClip,
  ProbeUploadForm,
} from "@timenook/contracts";
import { sealAudio } from "../media/seal-audio";
import { PROBE_OBJECTS, ProbeObjects } from "./local-objects";
import { API_CONFIG, ApiConfig } from "../config";
import { probeStorageScope } from "./storage-scope";

@Injectable()
export class AudioProbe implements OnModuleDestroy {
  private readonly db: PrismaClient;
  private readonly redis: Redis;
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(PROBE_OBJECTS) private readonly objects: ProbeObjects,
  ) {
    this.db = new PrismaClient({ datasourceUrl: config.databaseUrl });
    this.redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 0 });
    this.redis.on("error", () => {});
  }
  async identity(authorization?: string): Promise<string> {
    if (!/^Bearer p2_[A-Za-z0-9_-]{43}$/.test(authorization ?? ""))
      throw new UnauthorizedException();
    const hash = createHash("sha256")
      .update(authorization!.slice(7))
      .digest("hex");
    const value = await this.redis.get(
      `${this.config.redisKeyPrefix ?? "timenook"}:probe:session:${hash}`,
    );
    if (!value) throw new UnauthorizedException();
    const session = JSON.parse(value) as { id: string; expiresAt: string };
    if (Date.parse(session.expiresAt) <= Date.now())
      throw new UnauthorizedException();
    return session.id;
  }
  async create(ownerId: string, command: ProbeClipCommand): Promise<ProbeClip> {
    const clip = await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ownerId}, 0))`;
      const existing = await tx.probeClip.findUnique({
        where: {
          ownerId_clientClipId: { ownerId, clientClipId: command.clientClipId },
        },
      });
      return (
        existing ??
        tx.probeClip.create({
          data: {
            id: randomUUID(),
            ownerId,
            storageScope: probeStorageScope(this.config.audioProbe),
            ...command,
          },
        })
      );
    });
    if (
      clip.storageScope !== probeStorageScope(this.config.audioProbe) ||
      clip.bytes !== command.bytes ||
      clip.sha256 !== command.sha256
    )
      throw new ConflictException();
    return this.present(clip);
  }
  async seal(ownerId: string, id: string) {
    return this.db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT id FROM probe_clips WHERE id = ${id}::uuid FOR UPDATE`;
        const clip = await tx.probeClip.findFirst({
          where: {
            id,
            ownerId,
            storageScope: probeStorageScope(this.config.audioProbe),
          },
        });
        if (!clip) throw new NotFoundException();
        if (clip.state === "sealed") return this.present(clip);
        const source = `staging/${id}.mp3`;
        const target = `sealed/${id}.mp3`;
        let durationMs: number;
        try {
          ({ durationMs } = await sealAudio(this.objects, {
            source,
            target,
            bytes: clip.bytes,
            sha256: clip.sha256,
          }));
        } catch {
          await this.objects.remove(target).catch(() => {});
          throw new UnprocessableEntityException();
        }
        return this.present(
          await tx.probeClip.update({
            where: { id },
            data: { state: "sealed", durationMs },
          }),
        );
      },
      { timeout: 40000, maxWait: 45000 },
    );
  }
  async content(ownerId: string, id: string) {
    const clip = await this.get(ownerId, id);
    if (clip.state !== "sealed") throw new ConflictException();
    const bytes = await this.objects.read(`sealed/${id}.mp3`);
    if (
      bytes.length !== clip.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== clip.sha256
    )
      throw new UnprocessableEntityException();
    return bytes;
  }
  async reservePrintEntry(ownerId: string, clipId: string) {
    return this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM probe_clips WHERE id = ${clipId}::uuid FOR UPDATE`;
      const clip = await tx.probeClip.findFirst({
        where: {
          id: clipId,
          ownerId,
          storageScope: probeStorageScope(this.config.audioProbe),
        },
      });
      if (!clip) throw new NotFoundException();
      if (clip.state !== "sealed") throw new ConflictException();
      const entry = await tx.probePrintEntry.upsert({
        where: { clipId },
        create: { id: randomBytes(16).toString("base64url"), clipId },
        update: {},
      });
      return { id: entry.id };
    });
  }
  async resolvePrintEntry(ownerId: string, id: string) {
    if (!/^[A-Za-z0-9_-]{22}$/.test(id)) throw new NotFoundException();
    const entry = await this.db.probePrintEntry.findFirst({
      where: {
        id,
        clip: {
          ownerId,
          state: "sealed",
          storageScope: probeStorageScope(this.config.audioProbe),
        },
      },
    });
    if (!entry) throw new NotFoundException();
    return { clipId: entry.clipId };
  }
  private prefix() {
    return `${this.config.redisKeyPrefix ?? "timenook"}:probe:`;
  }
  async get(ownerId: string, id: string) {
    const clip = await this.db.probeClip.findFirst({
      where: {
        id,
        ownerId,
        storageScope: probeStorageScope(this.config.audioProbe),
      },
    });
    if (!clip) throw new NotFoundException();
    return this.present(clip);
  }
  async uploadForm(
    ownerId: string,
    id: string,
    authorization: string,
  ): Promise<ProbeUploadForm> {
    const clip = await this.get(ownerId, id);
    if (clip.state !== "pending") throw new ConflictException();
    const ttl = Math.min(this.config.audioProbe?.uploadTtlSeconds ?? 120, 300);
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
    const key = `staging/${id}.mp3`;
    if (this.objects.uploadForm)
      return this.objects.uploadForm(key, clip.bytes, new Date(expiresAt));
    const policy = Buffer.from(
      JSON.stringify({
        expiration: expiresAt,
        conditions: [
          ["eq", "$key", key],
          ["content-length-range", clip.bytes, clip.bytes],
        ],
      }),
    ).toString("base64");
    const capability = randomBytes(32).toString("base64url");
    await this.redis.set(
      `${this.prefix()}upload:${createHash("sha256").update(capability).digest("hex")}`,
      JSON.stringify({
        id,
        ownerId,
        key,
        policy,
        expiresAt,
        bytes: clip.bytes,
        sessionHash: createHash("sha256")
          .update(authorization.slice(7))
          .digest("hex"),
      }),
      "EX",
      ttl,
    );
    return {
      url: "/v1/probes/audio/objects",
      fields: { key, policy, "x-probe-capability": capability },
      expiresAt,
      storage: "local-simulator",
    };
  }
  async upload(fields: Record<string, string>, bytes: Buffer) {
    if (this.config.audioProbe?.oss) throw new NotFoundException();
    const capability = fields["x-probe-capability"];
    if (
      !capability ||
      Object.keys(fields).sort().join(",") !== "key,policy,x-probe-capability"
    )
      throw new ForbiddenException();
    const value = await this.redis.get(
      `${this.prefix()}upload:${createHash("sha256").update(capability).digest("hex")}`,
    );
    if (!value) throw new ForbiddenException();
    const permission = JSON.parse(value);
    if (
      permission.key !== fields.key ||
      permission.policy !== fields.policy ||
      Date.parse(permission.expiresAt) <= Date.now() ||
      !(await this.redis.exists(
        `${this.prefix()}session:${permission.sessionHash}`,
      ))
    )
      throw new ForbiddenException();
    if (bytes.length !== permission.bytes) throw new BadRequestException();
    await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM probe_clips WHERE id = ${permission.id}::uuid FOR UPDATE`;
      const clip = await tx.probeClip.findFirst({
        where: {
          id: permission.id,
          ownerId: permission.ownerId,
          storageScope: probeStorageScope(this.config.audioProbe),
        },
      });
      if (!clip || clip.state !== "pending") throw new ConflictException();
      await this.objects.put(permission.key, bytes);
    });
  }
  private present(clip: {
    id: string;
    clientClipId: string;
    bytes: number;
    sha256: string;
    state: string;
    durationMs: number | null;
  }): ProbeClip {
    return {
      id: clip.id,
      clientClipId: clip.clientClipId,
      bytes: clip.bytes,
      sha256: clip.sha256,
      state: clip.state as ProbeClip["state"],
      durationMs: clip.durationMs,
      storage: this.config.audioProbe?.oss ? "oss" : "local-simulator",
    };
  }
  async onModuleDestroy() {
    this.redis.disconnect();
    await this.db.$disconnect();
  }
}
