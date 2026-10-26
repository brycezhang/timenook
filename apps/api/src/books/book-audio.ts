import { ProjectStreams } from "../media/project-streams";
import {
  Controller,
  Get,
  Header,
  Inject,
  Injectable,
  OnModuleDestroy,
  Param,
  Req,
  Res,
  Query,
  ParseIntPipe,
  ParseUUIDPipe,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags, ApiProduces, ApiQuery } from "@nestjs/swagger";
import { PrismaClient } from "@prisma/client";
import type { FastifyRequest, FastifyReply } from "fastify";
import type { BookAudioEntryView } from "@timenook/contracts";
import { createHash } from "node:crypto";
import { API_CONFIG, ApiConfig } from "../config";
import { IdentityAccess } from "../identity/identity-access";
import { Participation } from "../identity/participation";
import { ProjectServiceTerms } from "../projects/service-terms";
import { probeStorageScope } from "../probe/storage-scope";
import { Recordings } from "../media/recordings";
import { sendAudio } from "../media/send-audio";

type FrozenAudio = {
  clipId: string;
  assetId: string;
  inputHash: string;
  sequence: number;
};
@Injectable()
export class BookAudio implements OnModuleDestroy {
  private readonly db: PrismaClient;
  private readonly terms: ProjectServiceTerms;
  private readonly scope: string;
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly identity: IdentityAccess,
    private readonly participation: Participation,
    private readonly recordings: Recordings,
  ) {
    this.db = new PrismaClient({ datasourceUrl: config.databaseUrl });
    this.terms = new ProjectServiceTerms(config.databaseUrl);
    this.scope = createHash("sha256")
      .update(`product:${probeStorageScope(config.recording)}`)
      .digest("hex");
  }
  async read(id: string, authorization?: string): Promise<BookAudioEntryView> {
    // Authenticate before looking up the locator, including unknown locators.
    await this.identity.current(authorization);
    if (
      this.scope !==
      createHash("sha256")
        .update(`product:${probeStorageScope(this.config.recording)}`)
        .digest("hex")
    )
      throw new ForbiddenException();
    if (!/^[A-Za-z0-9_-]{22}$/.test(id)) throw new NotFoundException();
    const locator = await this.db.bookAudioEntry.findUnique({ where: { id } });
    if (!locator) throw new NotFoundException();
    return this.participation.withPlanAccess(
      locator.projectId,
      authorization,
      undefined,
      async (tx, actor) => {
        const entry = await tx.bookAudioEntry.findUnique({ where: { id } });
        if (!entry || entry.projectId !== locator.projectId)
          throw new NotFoundException();
        const terms = await this.terms.read(entry.projectId, undefined, tx);
        const playback = terms.playback,
          retention = terms.retention?.originalAudio;
        if (
          !playback ||
          !retention ||
          playback.state === "expired" ||
          retention.state === "expired"
        )
          throw new ForbiddenException();
        const revision = await tx.storyRevision.findFirst({
          where: {
            projectId: entry.projectId,
            storyId: entry.storyId,
            id: entry.revisionId,
          },
        });
        const reference = await tx.bookStoryReference.findFirst({
          where: {
            projectId: entry.projectId,
            storyId: entry.storyId,
            revisionId: entry.revisionId,
            contentHash: entry.contentHash,
          },
        });
        if (
          !revision ||
          !reference ||
          revision.contentHash !== entry.contentHash
        )
          throw new NotFoundException();
        // Online editing does not overwrite a historical entry. A decision about
        // this exact revision can still withdraw it independently of the current draft.
        const decision = await tx.storyDecision.findFirst({
          where: {
            projectId: entry.projectId,
            storyId: entry.storyId,
            revisionId: entry.revisionId,
          },
          orderBy: { sequence: "desc" },
        });
        if (
          !decision?.confirmed ||
          !decision.allowInBook ||
          decision.contentHash !== entry.contentHash ||
          decision.subjectId !== actor.subjectId
        )
          throw new ForbiddenException();
        const audio = entry.audio as unknown as FrozenAudio[];
        if (
          !Array.isArray(audio) ||
          !audio.length ||
          new Set(audio.map((a) => a.clipId)).size !== audio.length
        )
          throw new NotFoundException();
        const clips: BookAudioEntryView["clips"] = [];
        for (const [sequence, frozen] of audio.entries()) {
          if (frozen.sequence !== sequence) throw new NotFoundException();
          const clip = await tx.recordingClip.findFirst({
            where: {
              id: frozen.clipId,
              projectId: entry.projectId,
              assetId: frozen.assetId,
              subjectId: actor.subjectId,
            },
          });
          const asset =
            clip &&
            (await tx.recordingAsset.findFirst({
              where: {
                id: clip.assetId,
                projectId: entry.projectId,
                storageScope: this.scope,
                sha256: frozen.inputHash,
              },
            }));
          const intent =
            clip &&
            (await tx.recordingIntent.findFirst({
              where: {
                id: clip.intentId,
                projectId: entry.projectId,
                storageScope: this.scope,
                state: "sealed",
              },
            }));
          if (
            !clip ||
            !asset ||
            !intent ||
            asset.bytes !== intent.bytes ||
            asset.sha256 !== intent.sha256 ||
            asset.objectKey !== `sealed/${intent.id}.mp3`
          )
            throw new NotFoundException();
          clips.push({
            clipId: clip.id,
            sequence,
            assetId: asset.id,
            sha256: asset.sha256,
            bytes: asset.bytes,
            durationMs: asset.durationMs,
          });
        }
        const expiries = [
          actor.accessExpiresAt,
          playback.expiresAt,
          retention.expiresAt,
        ].filter((v): v is string => !!v);
        return {
          id: entry.id,
          projectId: entry.projectId,
          story: {
            id: entry.storyId,
            revisionId: entry.revisionId,
            version: revision.version,
            title: revision.title,
          },
          clips,
          accessEpoch: actor.accessEpoch,
          accessExpiresAt: expiries.length
            ? new Date(Math.min(...expiries.map(Date.parse))).toISOString()
            : null,
        };
      },
    );
  }
  async content(
    id: string,
    clipId: string,
    epoch: number,
    authorization?: string,
  ) {
    if (!Number.isSafeInteger(epoch) || epoch < 0)
      throw new BadRequestException();
    const before = await this.read(id, authorization);
    if (before.accessEpoch !== epoch) throw new ForbiddenException();
    const source = before.clips.find((c) => c.clipId === clipId);
    if (!source) throw new NotFoundException();
    const clip = await this.db.recordingClip.findFirst({
      where: {
        id: clipId,
        projectId: before.projectId,
        assetId: source.assetId,
      },
    });
    if (!clip) throw new NotFoundException();
    let bytes: Buffer;
    try {
      // Media owns the bounded private storage read, checksum, session and
      // current authorization checks. Book adds immutable membership and epoch.
      bytes = await this.recordings.content(
        before.projectId,
        clip.interviewId,
        clip.intentId,
        authorization,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT")
        throw new NotFoundException();
      throw error;
    }
    const after = await this.read(id, authorization);
    const current = after.clips.find((c) => c.clipId === clipId);
    if (
      after.accessEpoch !== epoch ||
      !current ||
      current.assetId !== source.assetId ||
      current.sha256 !== source.sha256 ||
      current.bytes !== source.bytes
    )
      throw new ForbiddenException();
    return bytes;
  }
  async onModuleDestroy() {
    await this.db.$disconnect();
    await this.terms.close();
  }
}
@ApiTags("Book original audio")
@ApiBearerAuth()
@Controller("v1/book-audio")
export class BookAudioController {
  constructor(
    private readonly audio: BookAudio,
    private readonly streams: ProjectStreams,
  ) {}
  @Get(":entryId/clips/:clipId/content")
  @Header("Cache-Control", "private, no-store")
  @Header("Pragma", "no-cache")
  @ApiProduces("audio/mpeg")
  @ApiQuery({
    name: "epoch",
    required: true,
    schema: { type: "integer", minimum: 0 },
  })
  async content(
    @Param("entryId") id: string,
    @Param("clipId", ParseUUIDPipe) clipId: string,
    @Query("epoch", ParseIntPipe) epoch: number,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const entry = await this.audio.read(id, req.headers.authorization);
    return sendAudio(
      await this.audio.content(id, clipId, epoch, req.headers.authorization),
      clipId,
      req.headers.range,
      reply,
      (bytes) =>
        this.streams.guard(
          entry.projectId,
          epoch,
          bytes,
          () => this.audio.read(id, req.headers.authorization),
          req.headers.authorization,
        ),
    );
  }
  @Get(":entryId")
  @Header("Cache-Control", "private, no-store")
  @Header("Pragma", "no-cache")
  async read(@Param("entryId") id: string, @Req() req: FastifyRequest) {
    return {
      data: await this.audio.read(id, req.headers.authorization),
      meta: { requestId: req.id },
    };
  }
}
