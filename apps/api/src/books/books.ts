import {
  Controller,
  Get,
  Post,
  Body,
  Injectable,
  Inject,
  OnModuleDestroy,
  Param,
  ParseUUIDPipe,
  Req,
  Res,
  Header,
  HttpCode,
  ConflictException,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  UnprocessableEntityException,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiTags,
  ApiProperty,
  ApiHeader,
  ApiProduces,
  ApiOperation,
  ApiOkResponse,
} from "@nestjs/swagger";
import {
  IsInt,
  Min,
  Max,
  IsArray,
  Matches,
  IsString,
  MaxLength,
  IsUUID,
  ValidateIf,
} from "class-validator";
import {
  Prisma,
  PrismaClient,
  BookVersion,
  ProductionTask,
} from "@prisma/client";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import { readFile, mkdir, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { FastifyRequest, FastifyReply } from "fastify";
import type {
  BookContext,
  BookSnapshot,
  BookStory,
  BookVersionView,
  PlanDirectory,
  PhotoMaterials,
  BookCoverSettings,
} from "@timenook/contracts";
import { API_CONFIG, ApiConfig } from "../config";
import { Participation } from "../identity/participation";
import { ProjectPlans, ProjectPlanError } from "../projects/project-plans";
import { ProjectServiceTerms } from "../projects/service-terms";
import { probeStorageScope } from "../probe/storage-scope";
import type { ProbeObjects } from "../probe/local-objects";
import { renderBook } from "./render-book";
export const BOOK_OBJECTS = Symbol("BOOK_OBJECTS");
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, value]) => [k, canonical(value)]),
    );
  return v;
}
const digest = (v: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(v)))
    .digest("hex");
const bytesHash = (v: Buffer) => createHash("sha256").update(v).digest("hex");
const json = (v: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(v));
const active = ["queued", "submitting"];
class GenerateBookDto {
  @ApiProperty({ pattern: "^[a-f0-9]{64}$" })
  @Matches(/^[a-f0-9]{64}$/)
  expectedInputHash!: string;
}
class SaveBookCoverDto {
  @ApiProperty({ minimum: 0 })
  @IsInt()
  @Min(0)
  @Max(2147483646)
  expectedVersion!: number;
  @ApiProperty({ maxLength: 120 })
  @IsString()
  @MaxLength(120)
  salutation!: string;
  @ApiProperty({ nullable: true, format: "uuid" })
  @ValidateIf((_o, value) => value !== null)
  @IsUUID()
  photoAssetId!: string | null;
}
class BookDirectoryDto {
  @ApiProperty() @IsInt() @Min(1) @Max(2147483646) expectedVersion!: number;
  @ApiProperty({ type: [Object] })
  @IsArray()
  chapters!: PlanDirectory["chapters"];
}
@Injectable()
export class Books implements OnModuleDestroy {
  private readonly plans: ProjectPlans;
  private readonly db: PrismaClient;
  private readonly terms: ProjectServiceTerms;
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly participation: Participation,
    @Inject(BOOK_OBJECTS) private readonly objects: ProbeObjects,
  ) {
    this.plans = new ProjectPlans(config.databaseUrl);
    this.db = new PrismaClient({ datasourceUrl: config.databaseUrl });
    this.terms = new ProjectServiceTerms(config.databaseUrl);
  }
  configuration() {
    const c = this.config.books;
    const runtime = resolve(
        __dirname,
        __dirname.includes("dist-test") ? "../../../runtime" : "../../runtime",
      ),
      scripts = resolve(runtime, "../../../scripts/print-probe");
    const sources = {
      ...Object.fromEntries(
        [
          "template.mjs",
          "book-worker.mjs",
          "inspect-worker.mjs",
          "font.mjs",
        ].map((file) => [file, bytesHash(readFileSync(join(scripts, file)))]),
      ),
      boundedRunner: bytesHash(
        readFileSync(join(runtime, "bounded-process.mjs")),
      ),
      adapter: bytesHash(readFileSync(join(__dirname, "render-book.js"))),
    };
    return {
      version: "t20-v1",
      specification: c?.specificationVersion,
      provenance: c?.provenanceVersion,
      entryBaseUrl: c?.entryBaseUrl,
      rendererSources: sources,
      resourceLimits: {
        photoCount: 128,
        photoBytes: this.config.books?.maxPhotoBytes ?? 33554432,
        individualPhotoBytes: 16777216,
      },
      storageScope: probeStorageScope(this.config.recording),
      outputStore: c?.storageRoot,
      template: "t20-a5-v3",
      chromium: "145.0.7632.6",
      fontSha256:
        "2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b",
    };
  }
  private async materialTerms(tx: Prisma.TransactionClient, projectId: string) {
    const terms = await this.terms.read(projectId, undefined, tx);
    for (const name of ["confirmedStories", "bookPdf"])
      if (!terms.retention?.[name] || terms.retention[name].state === "expired")
        throw new ForbiddenException();
    return terms;
  }
  private async renderMaterialTerms(
    tx: Prisma.TransactionClient,
    projectId: string,
    snapshot: BookSnapshot,
  ) {
    if (
      snapshot.cover.photo ||
      snapshot.chapters.some((c) => c.stories.some((s) => s.photos.length))
    ) {
      const terms = await this.terms.read(projectId, undefined, tx);
      if (
        !terms.retention?.derivedPhotos ||
        terms.retention.derivedPhotos.state === "expired"
      )
        throw new ForbiddenException();
    }
  }
  private expiry(
    actor: string | null,
    retention: string | null,
  ): string | null {
    const dates = [actor, retention].filter((v): v is string => !!v);
    return dates.length
      ? new Date(Math.min(...dates.map(Date.parse))).toISOString()
      : null;
  }
  private async draftIn(tx: Prisma.TransactionClient, projectId: string) {
    const terms = await this.materialTerms(tx, projectId);
    const project = await tx.project.findUniqueOrThrow({
        where: { id: projectId },
      }),
      order = await tx.paymentOrder.findUniqueOrThrow({
        where: { id: project.orderId! },
      }),
      subject = await tx.projectSubject.findUniqueOrThrow({
        where: { projectId },
      }),
      stored = await this.plans.directory(projectId, tx),
      plan = await this.plans.getProjectPlan(projectId, tx),
      eligible: BookStory[] = [];
    for (const story of await tx.story.findMany({
      where: { projectId },
      orderBy: { createdAt: "asc" },
    })) {
      if (!story.currentRevisionId) continue;
      const revision = await tx.storyRevision.findUniqueOrThrow({
          where: { id: story.currentRevisionId },
        }),
        decision = await tx.storyDecision.findFirst({
          where: {
            projectId,
            storyId: story.id,
            revisionId: revision.id,
            bindingVersion: subject.bindingVersion,
            accessEpoch: project.accessEpoch,
          },
          orderBy: { sequence: "desc" },
        });
      if (
        !decision?.confirmed ||
        !decision.allowInBook ||
        (revision.reviewItems as string[]).some(
          (item) =>
            !(
              revision.reviewResolutions as { item: string; reason: string }[]
            ).some((resolution) => resolution.item === item),
        )
      )
        continue;
      const photo = revision.photoSnapshot as unknown as PhotoMaterials | null;
      const audio = (revision.audioManifest ??
        revision.sourceManifest) as unknown as {
        clipId: string;
        assetId: string;
        inputHash: string;
        sequence: number;
      }[];
      eligible.push({
        id: story.id,
        revisionId: revision.id,
        version: revision.version,
        contentHash: revision.contentHash,
        title: revision.title,
        paragraphs: (revision.paragraphs as unknown as { text: string }[]).map(
          (p) => p.text,
        ),
        notes: revision.notes as unknown as { id: string; text: string }[],
        provenance: {
          origin: revision.origin as "ai" | "participant",
          label:
            revision.origin === "ai"
              ? "根据本人讲述经AI整理"
              : "根据本人讲述经AI整理，并经人工校对",
        },
        photos: (photo?.entries ?? []).map((p) => {
          const asset = p.assets.find((a) => a.kind === "print");
          if (!asset) throw new ConflictException();
          return {
            id: p.photoId,
            interviewId: story.interviewId,
            assetId: asset.id,
            sha256: asset.sha256,
            bytes: asset.bytes,
            caption: p.caption,
            width: asset.width,
            height: asset.height,
          };
        }),
        audio: audio.map((a, i) => ({
          clipId: a.clipId,
          assetId: a.assetId,
          inputHash: a.inputHash,
          sequence: i,
        })),
        entry: null,
      });
    }
    const chapters =
      stored.version === 1 && !stored.chapters.length && eligible.length
        ? [
            {
              key: "life-stories",
              title: "我的故事",
              storyRefs: eligible.map((s) => s.id),
            },
          ]
        : stored.chapters;
    const directory = { ...stored, chapters, contentHash: digest(chapters) };
    const coverRow = await tx.bookCoverVersion.findFirst({
        where: { projectId },
        orderBy: { version: "desc" },
      }),
      cover: BookCoverSettings = {
        version: coverRow?.version ?? 0,
        salutation: coverRow?.salutation ?? "",
        photoAssetId: coverRow?.photoAssetId ?? null,
      },
      coverPhotoOptions = [
        ...new Map(
          eligible
            .flatMap((story) => story.photos)
            .map((photo) => [photo.assetId, photo]),
        ).values(),
      ],
      coverPhoto =
        coverPhotoOptions.find(
          (photo) => photo.assetId === cover.photoAssetId,
        ) ?? null;
    const selected = chapters.flatMap((c) => c.storyRefs),
      invalid =
        selected.some((id) => !eligible.some((s) => s.id === id)) ||
        !!(cover.photoAssetId && !coverPhoto);
    const actual = chapters
      .map((c) => ({
        key: c.key,
        title: c.title,
        stories: c.storyRefs
          .map((id) => eligible.find((s) => s.id === id))
          .filter((s): s is BookStory => !!s),
      }))
      .filter((c) => c.stories.length);
    const snapshot: BookSnapshot = {
      schemaVersion: "t20-v1",
      cover: {
        title: project.bookTitle ?? order.bookTitle,
        template: "t20-a5-v3",
        version: cover.version,
        salutation: cover.salutation,
        photo: coverPhoto,
      },
      plan: {
        revision: plan.revision,
        contentHash: plan.contentHash,
        content: { chapters: plan.chapters, starters: plan.starters },
      },
      directory,
      chapters: actual,
      specification: {
        version: this.config.books!.specificationVersion,
        widthMm: 148,
        heightMm: 210,
        bleedMm: 0,
        productionReady: false,
        status: "synthetic-unfrozen",
      },
      provenance: {
        version: this.config.books!.provenanceVersion,
        notice:
          "根据本人讲述经AI整理；人工校对来源逐篇标注。原声入口关联讲述者原始录音。",
      },
    };
    // Future interview questions are captured for audit but do not invalidate an already frozen book.
    const inputHash = digest({
      cover: snapshot.cover,
      metadataVersion: project.metadataVersion,
      directory,
      chapters: actual,
      specification: snapshot.specification,
      provenance: snapshot.provenance,
      configuration: this.configuration(),
    });
    const expiries = ["confirmedStories", "bookPdf"]
      .map((name) => terms.retention![name].expiresAt)
      .filter((v): v is string => !!v);
    return {
      snapshot,
      eligible,
      cover,
      coverPhotoOptions,
      inputHash,
      invalid,
      project,
      subject,
      retentionExpiresAt: expiries.length
        ? new Date(Math.min(...expiries.map(Date.parse))).toISOString()
        : null,
    };
  }
  private async viewIn(
    tx: Prisma.TransactionClient,
    row: BookVersion,
    currentHash: string,
    accessExpiresAt: string | null,
  ): Promise<BookVersionView> {
    let task = await tx.productionTask.findUniqueOrThrow({
      where: { id: row.taskId },
    });
    if (row.inputHash !== currentHash && task.state !== "obsolete")
      task = await tx.productionTask.update({
        where: { id: task.id },
        data: {
          state: "obsolete",
          errorCode: "BOOK_INPUT_CHANGED",
          fence: { increment: 1 },
          leaseUntil: null,
        },
      });
    const output = await tx.bookOutput.findUnique({
      where: { bookId: row.id },
    });
    const state: BookVersionView["state"] =
      task.state === "obsolete"
        ? "obsolete"
        : task.state === "succeeded"
          ? "ready"
          : task.state === "submitting"
            ? "rendering"
            : task.state === "queued"
              ? "queued"
              : "failed";
    const snapshot = row.snapshot as unknown as BookSnapshot,
      coverRule = snapshot.cover.photo
        ? (await this.terms.read(row.projectId, undefined, tx)).retention
            ?.derivedPhotos
        : undefined,
      coverExpiresAt = this.expiry(
        accessExpiresAt,
        coverRule?.expiresAt ?? null,
      ),
      canPreviewCover = !!(
        snapshot.cover.photo &&
        coverRule &&
        coverRule.state !== "expired" &&
        (!coverExpiresAt || Date.parse(coverExpiresAt) > Date.now())
      );
    return {
      id: row.id,
      projectId: row.projectId,
      version: row.version,
      state,
      inputHash: row.inputHash,
      snapshotHash: row.snapshotHash,
      snapshot,
      task: { id: task.id, state: task.state, errorCode: task.errorCode },
      pageCount: output?.pageCount ?? null,
      pdf: output ? { sha256: output.sha256, bytes: output.bytes } : null,
      toc: output ? (output.manifest as any).toc.entries : null,
      renderer: output ? (output.manifest as any).renderer : null,
      accessExpiresAt,
      coverPhotoAccess: {
        allowed: canPreviewCover,
        expiresAt: canPreviewCover ? coverExpiresAt : null,
      },
    };
  }
  private async contextIn(
    tx: Prisma.TransactionClient,
    projectId: string,
    accessExpiresAt: string | null,
  ): Promise<BookContext> {
    const draft = await this.draftIn(tx, projectId),
      row = await tx.bookVersion.findFirst({
        where: { projectId },
        orderBy: { version: "desc" },
      });
    accessExpiresAt = this.expiry(accessExpiresAt, draft.retentionExpiresAt);
    return {
      projectId,
      inputHash: draft.inputHash,
      directory: draft.snapshot.directory,
      cover: draft.cover,
      coverPhotoOptions: draft.coverPhotoOptions,
      eligibleStories: draft.eligible.map(
        ({ id, revisionId, version, contentHash, title }) => ({
          id,
          revisionId,
          version,
          contentHash,
          title,
        }),
      ),
      current: row
        ? await this.viewIn(tx, row, draft.inputHash, accessExpiresAt)
        : null,
      accessExpiresAt,
    };
  }
  context(projectId: string, authorization?: string) {
    return this.participation.withPlanAccess(
      projectId,
      authorization,
      undefined,
      (tx, actor) => this.contextIn(tx, projectId, actor.accessExpiresAt),
    );
  }
  saveCover(
    projectId: string,
    body: SaveBookCoverDto,
    authorization?: string,
    key?: string,
  ) {
    key = this.key(key);
    return this.participation.withPlanAccess(
      projectId,
      authorization,
      undefined,
      async (tx, actor) => {
        const where = {
            projectId,
            actorId: actor.userId,
            action: "cover",
            key: key!,
          },
          requestHash = digest(body),
          prior = await tx.bookCommand.findUnique({
            where: { projectId_actorId_action_key: where },
          });
        if (prior) {
          if (prior.requestHash !== requestHash) throw new ConflictException();
          return this.contextIn(tx, projectId, actor.accessExpiresAt);
        }
        const draft = await this.draftIn(tx, projectId);
        if (draft.cover.version !== body.expectedVersion)
          throw new ConflictException();
        if (
          body.photoAssetId &&
          !draft.coverPhotoOptions.some(
            (photo) => photo.assetId === body.photoAssetId,
          )
        )
          throw new BadRequestException();
        const salutation = body.salutation.trim();
        const changed =
          salutation !== draft.cover.salutation ||
          body.photoAssetId !== draft.cover.photoAssetId;
        if (changed)
          await tx.bookCoverVersion.create({
            data: {
              projectId,
              version: draft.cover.version + 1,
              salutation,
              photoAssetId: body.photoAssetId,
              createdBy: actor.userId,
            },
          });
        await tx.bookCommand.create({
          data: {
            ...where,
            requestHash,
            resultId: String(draft.cover.version + (changed ? 1 : 0)),
          },
        });
        return this.contextIn(tx, projectId, actor.accessExpiresAt);
      },
    );
  }
  private key(key?: string) {
    if (!key || !/^[-A-Za-z0-9_:]{8,128}$/.test(key))
      throw new BadRequestException();
    return key;
  }
  generate(
    projectId: string,
    body: GenerateBookDto,
    authorization?: string,
    key?: string,
  ) {
    key = this.key(key);
    return this.participation.withPlanAccess(
      projectId,
      authorization,
      undefined,
      async (tx, actor) => {
        const where = {
            projectId,
            actorId: actor.userId,
            action: "generate",
            key: key!,
          },
          requestHash = digest(body),
          command = await tx.bookCommand.findUnique({
            where: { projectId_actorId_action_key: where },
          }),
          draft = await this.draftIn(tx, projectId);
        if (command) {
          if (command.requestHash !== requestHash)
            throw new ConflictException();
          const row = await tx.bookVersion.findUniqueOrThrow({
            where: { id: command.resultId },
          });
          return this.viewIn(
            tx,
            row,
            draft.inputHash,
            this.expiry(actor.accessExpiresAt, draft.retentionExpiresAt),
          );
        }
        if (
          body.expectedInputHash !== draft.inputHash ||
          draft.invalid ||
          !draft.snapshot.chapters.length
        )
          throw new ConflictException();
        await this.renderMaterialTerms(tx, projectId, draft.snapshot);
        const previous = await tx.bookVersion.findFirst({
            where: { projectId },
            orderBy: { version: "desc" },
          }),
          id = randomUUID(),
          taskId = randomUUID(),
          snapshot = structuredClone(draft.snapshot);
        for (const chapter of snapshot.chapters)
          for (const story of chapter.stories)
            if (story.audio.length) {
              const prior = await tx.bookAudioEntry.findUnique({
                where: {
                  projectId_storyId_revisionId: {
                    projectId,
                    storyId: story.id,
                    revisionId: story.revisionId,
                  },
                },
              });
              const entry =
                prior ??
                (await tx.bookAudioEntry.create({
                  data: {
                    id: randomBytes(16).toString("base64url"),
                    projectId,
                    storyId: story.id,
                    revisionId: story.revisionId,
                    contentHash: story.contentHash,
                    audio: json(story.audio),
                  },
                }));
              story.entry = {
                id: entry.id,
                url: this.config.books!.entryBaseUrl + entry.id,
                kind: "original-audio",
              };
            }
        const taskData = {
          id: taskId,
          projectId,
          subjectId: actor.subjectId,
          bindingVersion: actor.bindingVersion,
          accessEpoch: actor.accessEpoch,
          inputHash: draft.inputHash,
          kind: "render_book",
          configuration: json(this.configuration()),
          configurationHash: digest(this.configuration()),
          providerRequestId: randomUUID(),
          deadline: new Date(Date.now() + 600000),
        };
        const grant = await this.participation.bookGrantIn(tx, {
          ...taskData,
          operatorId: actor.userId,
        });
        if (!grant) throw new ForbiddenException();
        await tx.productionTask.create({
          data: { ...taskData, processingGrant: grant },
        });
        const row = await tx.bookVersion.create({
          data: {
            id,
            projectId,
            taskId,
            version: (previous?.version ?? 0) + 1,
            subjectId: actor.subjectId,
            operatorId: actor.userId,
            bindingVersion: actor.bindingVersion,
            accessEpoch: actor.accessEpoch,
            inputHash: draft.inputHash,
            snapshotHash: digest(snapshot),
            snapshot: json(snapshot),
          },
        });
        for (const chapter of snapshot.chapters)
          for (const story of chapter.stories)
            await tx.bookStoryReference.create({
              data: {
                projectId,
                bookId: id,
                storyId: story.id,
                revisionId: story.revisionId,
                contentHash: story.contentHash,
              },
            });
        await tx.taskOutbox.create({ data: { id: randomUUID(), taskId } });
        await tx.bookCommand.create({
          data: { ...where, requestHash, resultId: id },
        });
        if (previous)
          await tx.productionTask.updateMany({
            where: {
              projectId,
              kind: "render_book",
              id: { not: taskId },
              state: { not: "obsolete" },
            },
            data: {
              state: "obsolete",
              errorCode: "BOOK_SUPERSEDED",
              fence: { increment: 1 },
              leaseUntil: null,
            },
          });
        return this.viewIn(
          tx,
          row,
          draft.inputHash,
          this.expiry(actor.accessExpiresAt, draft.retentionExpiresAt),
        );
      },
    );
  }
  directory(
    projectId: string,
    body: BookDirectoryDto,
    authorization?: string,
    key?: string,
  ) {
    key = this.key(key);
    return this.participation.withPlanAccess(
      projectId,
      authorization,
      undefined,
      async (tx, actor) => {
        const where = {
            projectId,
            actorId: actor.userId,
            action: "directory",
            key: key!,
          },
          requestHash = digest(body),
          prior = await tx.bookCommand.findUnique({
            where: { projectId_actorId_action_key: where },
          });
        if (prior) {
          if (prior.requestHash !== requestHash) throw new ConflictException();
          return this.contextIn(tx, projectId, actor.accessExpiresAt);
        }
        if (
          body.chapters.length > 64 ||
          body.chapters.some(
            (c) =>
              typeof c?.key !== "string" ||
              c.key.length > 120 ||
              typeof c.title !== "string" ||
              c.title.length > 120 ||
              !Array.isArray(c.storyRefs) ||
              c.storyRefs.length > 128,
          )
        )
          throw new BadRequestException();
        for (const id of body.chapters.flatMap((c) => c.storyRefs))
          if (
            typeof id !== "string" ||
            !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
              id,
            ) ||
            !(await tx.story.findFirst({ where: { projectId, id } }))
          )
            throw new BadRequestException();
        try {
          await this.plans.reviseDirectory(
            { ...body, projectId, createdBy: actor.userId },
            tx,
          );
        } catch (error) {
          if (error instanceof ProjectPlanError) {
            if (error.code === "VERSION_CONFLICT")
              throw new ConflictException();
            throw new BadRequestException();
          }
          throw error;
        }
        await tx.bookCommand.create({
          data: {
            ...where,
            requestHash,
            resultId: String(body.expectedVersion + 1),
          },
        });
        return this.contextIn(tx, projectId, actor.accessExpiresAt);
      },
    );
  }
  read(projectId: string, id: string, authorization?: string) {
    return this.participation.withPlanAccess(
      projectId,
      authorization,
      undefined,
      async (tx, actor) => {
        const row = await tx.bookVersion.findFirst({
          where: { projectId, id },
        });
        if (!row) throw new NotFoundException();
        const draft = await this.draftIn(tx, projectId);
        return this.viewIn(
          tx,
          row,
          draft.inputHash,
          this.expiry(actor.accessExpiresAt, draft.retentionExpiresAt),
        );
      },
    );
  }
  async download(projectId: string, id: string, authorization?: string) {
    const authorize = () =>
      this.participation.withPlanAccess(
        projectId,
        authorization,
        undefined,
        async (tx, actor) => {
          const row = await tx.bookVersion.findFirst({
            where: { projectId, id },
          });
          if (!row) throw new NotFoundException();
          const draft = await this.draftIn(tx, projectId),
            view = await this.viewIn(
              tx,
              row,
              draft.inputHash,
              actor.accessExpiresAt,
            ),
            output = await tx.bookOutput.findUnique({ where: { bookId: id } });
          if (view.state !== "ready" || !output) throw new ConflictException();
          return output;
        },
      );
    const output = await authorize();
    let bytes: Buffer;
    try {
      bytes = await readFile(
        join(this.config.books!.storageRoot, output.objectKey),
      );
      if (bytes.length !== output.bytes || bytesHash(bytes) !== output.sha256)
        throw Error();
    } catch {
      throw new UnprocessableEntityException();
    }
    await authorize();
    return bytes;
  }
  async retryIn(
    tx: Prisma.TransactionClient,
    task: ProductionTask,
    actorId: string,
    actorRealm: string,
    key?: string,
  ) {
    key = this.key(key);
    const row = await tx.bookVersion.findUnique({ where: { taskId: task.id } });
    if (!row) throw new NotFoundException();
    const grant = await this.participation.bookGrantIn(tx, {
        ...row,
        processingGrant: task.processingGrant ?? undefined,
      }),
      draft = await this.draftIn(tx, row.projectId);
    if (!grant || draft.inputHash !== row.inputHash)
      throw new ConflictException();
    await tx.$queryRaw`SELECT id FROM production_tasks WHERE id=${task.id}::uuid FOR UPDATE`;
    const current = await tx.productionTask.findUniqueOrThrow({
        where: { id: task.id },
      }),
      where = { taskId: task.id, actorRealm, actorId, key };
    if (
      await tx.taskRetryCommand.findUnique({
        where: { taskId_actorRealm_actorId_key: where },
      })
    )
      return;
    if (!(await this.retryAllowed(tx, current))) throw new ConflictException();
    await tx.taskRetryCommand.create({
      data: { ...where, projectId: task.projectId },
    });
    await tx.productionTask.update({
      where: { id: task.id },
      data: {
        state: "queued",
        errorCode: null,
        leaseUntil: null,
        fence: { increment: 1 },
        nextRunAt: new Date(),
      },
    });
    await tx.taskOutbox.update({
      where: { taskId: task.id },
      data: { deliveredAt: null },
    });
  }
  async retryAllowed(tx: Prisma.TransactionClient, task: ProductionTask) {
    return (
      task.state === "failed" &&
      task.configurationHash === digest(this.configuration()) &&
      !!task.deadline &&
      task.deadline.getTime() > Date.now() &&
      (await tx.taskRetryCommand.count({ where: { taskId: task.id } })) < 2
    );
  }
  retry(projectId: string, id: string, authorization?: string, key?: string) {
    return this.participation.withPlanAccess(
      projectId,
      authorization,
      undefined,
      async (tx, actor) => {
        const row = await tx.bookVersion.findFirst({
          where: { projectId, id },
        });
        if (!row) throw new NotFoundException();
        await this.retryIn(
          tx,
          await tx.productionTask.findUniqueOrThrow({
            where: { id: row.taskId },
          }),
          actor.userId,
          "product",
          key,
        );
        const draft = await this.draftIn(tx, projectId);
        return this.viewIn(
          tx,
          row,
          draft.inputHash,
          this.expiry(actor.accessExpiresAt, draft.retentionExpiresAt),
        );
      },
    );
  }
  private async currentIn(
    tx: Prisma.TransactionClient,
    row: BookVersion,
    task: ProductionTask,
  ) {
    if (
      !(await this.participation.bookGrantIn(tx, {
        ...row,
        processingGrant: task.processingGrant ?? undefined,
      }))
    )
      return false;
    if (
      task.configurationHash !== digest(this.configuration()) ||
      digest(row.snapshot) !== row.snapshotHash
    )
      return false;
    try {
      const draft = await this.draftIn(tx, row.projectId);
      await this.renderMaterialTerms(tx, row.projectId, draft.snapshot);
      return draft.inputHash === row.inputHash;
    } catch (error) {
      if (
        error instanceof ForbiddenException ||
        error instanceof NotFoundException
      )
        return false;
      throw error;
    }
  }
  async run(id: string) {
    const initial = await this.db.bookVersion.findUnique({
      where: { taskId: id },
    });
    if (!initial) return;
    const claim = await this.db.$transaction(async (tx) => {
      const initialTask = await tx.productionTask.findUniqueOrThrow({
        where: { id },
      });
      const current = await this.currentIn(tx, initial, initialTask);
      await tx.$queryRaw`SELECT id FROM production_tasks WHERE id=${id}::uuid FOR UPDATE`;
      const task = await tx.productionTask.findUniqueOrThrow({ where: { id } });
      if (
        !active.includes(task.state) ||
        task.nextRunAt.getTime() > Date.now() ||
        (task.leaseUntil && task.leaseUntil.getTime() > Date.now())
      )
        return null;
      if (!current) {
        await tx.productionTask.update({
          where: { id },
          data: {
            state: "obsolete",
            errorCode: "BOOK_INPUT_OR_AUTHORIZATION_CHANGED",
            fence: { increment: 1 },
            leaseUntil: null,
          },
        });
        return null;
      }
      if (task.deadline && task.deadline.getTime() <= Date.now()) {
        await tx.productionTask.update({
          where: { id },
          data: {
            state: "manual_review",
            errorCode: "DEADLINE_EXCEEDED",
            leaseUntil: null,
          },
        });
        return null;
      }
      return tx.productionTask.update({
        where: { id },
        data: {
          state: "submitting",
          fence: { increment: 1 },
          leaseUntil: new Date(Date.now() + 180000),
          submittedAt: task.submittedAt ?? new Date(),
        },
      });
    });
    if (!claim) return;
    const attemptKey = `${initial.id}/${claim.fence}`;
    try {
      const snapshot = initial.snapshot as unknown as BookSnapshot,
        photos: Record<string, Buffer> = {};
      const references = [
        ...(snapshot.cover.photo ? [snapshot.cover.photo] : []),
        ...snapshot.chapters.flatMap((chapter) =>
          chapter.stories.flatMap((story) => story.photos),
        ),
      ];
      if (references.length > 128) throw Error("BOOK_IMAGE_INPUT_LIMIT");
      const assets: {
        id: string;
        bytes: number;
        sha256: string;
        objectKey: string;
      }[] = [];
      const loadedIds = new Set<string>();
      let totalBytes = 0;
      for (const photo of references) {
        const asset = await this.db.photoAsset.findFirst({
            where: {
              id: photo.assetId,
              projectId: initial.projectId,
              intentId: photo.id,
              kind: "print",
            },
          }),
          scope = createHash("sha256")
            .update(`product:${probeStorageScope(this.config.recording)}`)
            .digest("hex");
        if (
          !asset ||
          asset.sha256 !== photo.sha256 ||
          asset.storageScope !== scope
        )
          throw Error("BOOK_PHOTO_CHANGED");
        if (loadedIds.has(asset.id)) continue;
        totalBytes += asset.bytes;
        if (
          asset.bytes > 16777216 ||
          totalBytes > (this.config.books!.maxPhotoBytes ?? 33554432)
        )
          throw Error("BOOK_IMAGE_INPUT_LIMIT");
        assets.push(asset);
        loadedIds.add(asset.id);
      }
      // Metadata limits are checked for the entire input before the first object is read.
      for (const asset of assets) {
        const bytes = await this.objects.read(asset.objectKey);
        if (bytes.length !== asset.bytes || bytesHash(bytes) !== asset.sha256)
          throw Error("BOOK_PHOTO_INTEGRITY");
        photos[asset.id] = bytes;
      }
      await mkdir(this.config.books!.storageRoot, {
        recursive: true,
        mode: 0o700,
      });
      const rendered = await renderBook(
        snapshot,
        photos,
        join(this.config.books!.storageRoot, attemptKey),
        initial.snapshotHash,
      );
      const accepted = await this.db.$transaction(async (tx) => {
        const before = await tx.productionTask.findUniqueOrThrow({
            where: { id },
          }),
          current = await this.currentIn(tx, initial, before);
        await tx.$queryRaw`SELECT id FROM production_tasks WHERE id=${id}::uuid FOR UPDATE`;
        const task = await tx.productionTask.findUniqueOrThrow({
          where: { id },
        });
        if (
          task.fence !== claim.fence ||
          task.state !== "submitting" ||
          !task.leaseUntil ||
          task.leaseUntil.getTime() <= Date.now()
        )
          return false;
        if (
          !current ||
          (task.deadline && task.deadline.getTime() <= Date.now())
        ) {
          await tx.productionTask.update({
            where: { id },
            data: {
              state: "obsolete",
              errorCode: "BOOK_INPUT_OR_AUTHORIZATION_CHANGED",
              leaseUntil: null,
              fence: { increment: 1 },
            },
          });
          return false;
        }
        await tx.bookOutput.create({
          data: {
            bookId: initial.id,
            objectKey: `${attemptKey}/book.pdf`,
            sha256: rendered.sha256,
            bytes: rendered.bytes,
            pageCount: rendered.pageCount,
            manifest: json(rendered.manifest),
            inspection: json(rendered.inspection),
          },
        });
        await tx.productionTask.update({
          where: { id },
          data: {
            state: "succeeded",
            completedAt: new Date(),
            leaseUntil: null,
            errorCode: null,
          },
        });
        return true;
      });
      if (!accepted)
        await rm(join(this.config.books!.storageRoot, attemptKey), {
          recursive: true,
          force: true,
        });
    } catch (error) {
      await rm(join(this.config.books!.storageRoot, attemptKey), {
        recursive: true,
        force: true,
      });
      await this.db.$transaction(async (tx) => {
        await tx.productionTask.updateMany({
          where: { id, fence: claim.fence, state: "submitting" },
          data: {
            state: "failed",
            errorCode:
              error instanceof Error && /^[A-Z_]{1,80}$/.test(error.message)
                ? error.message
                : "BOOK_RENDER_FAILED",
            failedAt: new Date(),
            leaseUntil: null,
          },
        });
      });
    }
  }
  async onModuleDestroy() {
    await Promise.all([
      this.plans.close(),
      this.db.$disconnect(),
      this.terms.close(),
    ]);
  }
}
@Controller("v1/projects/:id/book")
@ApiTags("Book")
@ApiBearerAuth()
export class BooksController {
  constructor(private readonly books: Books) {}
  @Get()
  @Header("Cache-Control", "no-store")
  async context(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.books.context(id, req.headers.authorization),
      meta: { requestId: req.id },
    };
  }
  @Post("cover")
  @Header("Cache-Control", "no-store")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  async cover(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() body: SaveBookCoverDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.books.saveCover(
        id,
        body,
        req.headers.authorization,
        req.headers["idempotency-key"] as string,
      ),
      meta: { requestId: req.id },
    };
  }
  @Post("directory")
  @Header("Cache-Control", "no-store")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  async directory(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() body: BookDirectoryDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.books.directory(
        id,
        body,
        req.headers.authorization,
        req.headers["idempotency-key"] as string,
      ),
      meta: { requestId: req.id },
    };
  }
  @Post("versions")
  @HttpCode(202)
  @Header("Cache-Control", "no-store")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  async generate(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() body: GenerateBookDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.books.generate(
        id,
        body,
        req.headers.authorization,
        req.headers["idempotency-key"] as string,
      ),
      meta: { requestId: req.id },
    };
  }
  @Get("versions/:versionId")
  @Header("Cache-Control", "no-store")
  async read(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Param("versionId", new ParseUUIDPipe()) versionId: string,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.books.read(id, versionId, req.headers.authorization),
      meta: { requestId: req.id },
    };
  }
  @Post("versions/:versionId/retry")
  @HttpCode(202)
  @Header("Cache-Control", "no-store")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  async retry(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Param("versionId", new ParseUUIDPipe()) versionId: string,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.books.retry(
        id,
        versionId,
        req.headers.authorization,
        req.headers["idempotency-key"] as string,
      ),
      meta: { requestId: req.id },
    };
  }
  @Get("versions/:versionId/pdf")
  @ApiProduces("application/pdf")
  @ApiOkResponse({ schema: { type: "string", format: "binary" } })
  @ApiOperation({
    summary: "Download the complete currently authorized frozen book PDF",
  })
  async pdf(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Param("versionId", new ParseUUIDPipe()) versionId: string,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const bytes = await this.books.download(
      id,
      versionId,
      req.headers.authorization,
    );
    reply
      .header("Cache-Control", "private, no-store")
      .header("X-Content-Type-Options", "nosniff")
      .header(
        "Content-Disposition",
        `attachment; filename="book-${versionId}.pdf"`,
      )
      .type("application/pdf")
      .send(bytes);
  }
}
