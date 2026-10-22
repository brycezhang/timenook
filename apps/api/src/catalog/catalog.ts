import { InvalidPackageException } from "./errors";
import { ErrorResponseDto } from "../health-contract";
import {
  RecipientCatalogResponseDto,
  CurrentPackageResponseDto,
  ManagedRecipientResponseDto,
  ManagedRecipientsResponseDto,
  PackageVersionResponseDto,
  PackageVersionsResponseDto,
  PackageDraftResponseDto,
  PackageDraftsResponseDto,
} from "./catalog-contract";
import { createHash, randomUUID } from "node:crypto";
import { publicTerms, validatePackage } from "./package-terms";
import type { CurrentPackage, PackageVersion } from "@timenook/contracts";
import {
  Body,
  ForbiddenException,
  ConflictException,
  Controller,
  Get,
  Header,
  Inject,
  Injectable,
  OnModuleDestroy,
  Post,
  Req,
  Put,
  Param,
  ParseUUIDPipe,
} from "@nestjs/common";
import {
  ApiCookieAuth,
  ApiHeader,
  ApiOkResponse,
  ApiCreatedResponse,
  ApiResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
  OmitType,
} from "@nestjs/swagger";
import {
  IsOptional,
  IsObject,
  IsBoolean,
  IsInt,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from "class-validator";
import { Prisma, PrismaClient } from "@prisma/client";
import type { FastifyRequest } from "fastify";
import { ADMIN_PERMISSIONS } from "@timenook/contracts";
import { API_CONFIG, ApiConfig } from "../config";
import { AdminAccess } from "../admin/admin-access";
class CreateRecipientDto {
  @ApiProperty() @IsString() @Matches(/^[a-z][a-z0-9_-]{1,39}$/) code!: string;
  @ApiProperty()
  @IsString()
  @Length(1, 40)
  @Matches(/\S/)
  @Matches(/^[^\u0000-\u001f\u007f<>]+$/)
  label!: string;
  @ApiProperty() @IsInt() @Min(0) @Max(100000) sortOrder!: number;
  @ApiProperty() @IsBoolean() active!: boolean;
}
class UpdateRecipientDto extends OmitType(CreateRecipientDto, [
  "code",
] as const) {
  @ApiProperty() @IsInt() @Min(1) expectedRevision!: number;
}
class DraftDto {
  @ApiProperty({
    required: false,
    type: Object,
    additionalProperties: { type: "string" },
  })
  @IsOptional()
  @IsObject()
  shippingRegionLabels?: Record<string, string>;
  @ApiProperty() @IsString() @Length(1, 100) @Matches(/\S/) title!: string;
  @ApiProperty({ type: Object, additionalProperties: true })
  @IsObject()
  d01!: Record<string, unknown>;
  @ApiProperty({ type: Object, additionalProperties: true })
  @IsObject()
  admission!: Record<string, unknown>;
}
class UpdateDraftDto extends DraftDto {
  @ApiProperty() @IsInt() @Min(1) expectedRevision!: number;
}
class RevisionDto {
  @ApiProperty() @IsInt() @Min(1) expectedRevision!: number;
}
@Injectable()
export class Catalog implements OnModuleDestroy {
  readonly database: PrismaClient;
  readonly realm: "local" | "production";
  constructor(@Inject(API_CONFIG) config: ApiConfig) {
    this.database = new PrismaClient({ datasourceUrl: config.databaseUrl });
    this.realm = config.environment === "production" ? "production" : "local";
  }
  async recipients() {
    const types = await this.database.recipientType.findMany({
      where: { realm: this.realm, active: true },
      orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
      select: { code: true, label: true, revision: true },
    });
    return {
      types,
      customLabelAllowed: true,
      scope: "one_adult_subject_one_initiator",
    };
  }
  async createRecipient(
    tx: Prisma.TransactionClient,
    body: CreateRecipientDto,
  ) {
    try {
      const row = await tx.recipientType.create({
        data: { ...body, label: body.label.trim(), realm: this.realm },
      });
      return {
        code: row.code,
        label: row.label,
        sortOrder: row.sortOrder,
        active: row.active,
        revision: row.revision,
      };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      )
        throw new ConflictException();
      throw error;
    }
  }
  async allRecipients() {
    return this.database.recipientType.findMany({
      where: { realm: this.realm },
      orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
      select: {
        code: true,
        label: true,
        sortOrder: true,
        active: true,
        revision: true,
      },
    });
  }
  async updateRecipient(
    tx: Prisma.TransactionClient,
    code: string,
    body: UpdateRecipientDto,
  ) {
    const { expectedRevision, ...data } = body;
    const result = await tx.recipientType.updateMany({
      where: { realm: this.realm, code, revision: expectedRevision },
      data: { ...data, label: data.label.trim(), revision: { increment: 1 } },
    });
    if (!result.count) throw new ConflictException();
    return tx.recipientType.findUniqueOrThrow({
      where: { realm_code: { realm: this.realm, code } },
      select: {
        code: true,
        label: true,
        sortOrder: true,
        active: true,
        revision: true,
      },
    });
  }
  private draftView(row: {
    id: string;
    title: string;
    revision: number;
    d01: Prisma.JsonValue;
    admission: Prisma.JsonValue;
    shippingRegionLabels: Prisma.JsonValue;
  }) {
    const report = validatePackage(
      row.d01,
      row.admission,
      row.shippingRegionLabels,
    );
    return {
      id: row.id,
      title: row.title,
      revision: row.revision,
      d01: row.d01,
      admission: row.admission,
      shippingRegionLabels: row.shippingRegionLabels,
      validation: { ...report, approval: "not_verified", previewOnly: true },
    };
  }
  async createDraft(tx: Prisma.TransactionClient, body: DraftDto) {
    return this.draftView(
      await tx.packageDraft.create({
        data: {
          id: randomUUID(),
          realm: this.realm,
          title: body.title.trim(),
          d01: body.d01 as Prisma.InputJsonObject,
          shippingRegionLabels: body.shippingRegionLabels ?? {},
          admission: body.admission as Prisma.InputJsonObject,
        },
      }),
    );
  }
  async updateDraft(
    tx: Prisma.TransactionClient,
    id: string,
    body: UpdateDraftDto,
  ) {
    const changed = await tx.packageDraft.updateMany({
      where: { id, realm: this.realm, revision: body.expectedRevision },
      data: {
        title: body.title.trim(),
        d01: body.d01 as Prisma.InputJsonObject,
        shippingRegionLabels: body.shippingRegionLabels ?? {},
        admission: body.admission as Prisma.InputJsonObject,
        revision: { increment: 1 },
      },
    });
    if (!changed.count) throw new ConflictException();
    return this.draftView(
      await tx.packageDraft.findUniqueOrThrow({ where: { id } }),
    );
  }
  async drafts() {
    return (
      await this.database.packageDraft.findMany({
        where: { realm: this.realm },
        orderBy: { createdAt: "desc" },
      })
    ).map((row) => this.draftView(row));
  }
  private versionView(row: {
    id: string;
    sequence: number;
    publicOffer: Prisma.JsonValue;
  }): PackageVersion {
    return {
      ...(row.publicOffer as unknown as Omit<
        PackageVersion,
        "id" | "sequence"
      >),
      id: row.id,
      sequence: row.sequence,
    };
  }
  async freeze(tx: Prisma.TransactionClient, id: string, body: RevisionDto) {
    if (this.realm === "production") throw new ForbiddenException();
    await tx.$queryRaw`SELECT id FROM package_drafts WHERE id = ${id}::uuid FOR UPDATE`;
    const row = await tx.packageDraft.findFirst({
      where: { id, realm: this.realm },
    });
    if (!row) throw new ConflictException();
    const existing = await tx.packageVersion.findUnique({
      where: {
        realm_draftId_draftRevision: {
          realm: this.realm,
          draftId: id,
          draftRevision: body.expectedRevision,
        },
      },
    });
    if (existing) return this.versionView(existing);
    if (row.revision !== body.expectedRevision) throw new ConflictException();
    if (
      validatePackage(row.d01, row.admission, row.shippingRegionLabels)
        .completeness !== "complete"
    )
      throw new InvalidPackageException();
    const snapshot = {
      title: row.title,
      d01: row.d01,
      admission: row.admission,
      shippingRegionLabels: row.shippingRegionLabels,
    };
    const contentHash = createHash("sha256")
      .update(JSON.stringify(snapshot))
      .digest("hex");
    const publicOffer = {
      contentHash,
      purpose: "local_preview",
      title: row.title,
      price: { value: 99900, unit: "fen", currency: "CNY" },
      scope: {
        projects: 1,
        adultSubjects: 1,
        initiators: 1,
        firstCopies: 1,
        agreedShippingIncluded: true,
        completeExportIncluded: true,
      },
      terms: publicTerms(row.d01, row.admission, row.shippingRegionLabels).map(
        (term) => ({ label: term.label, text: term.text }),
      ),
    };
    return this.versionView(
      await tx.packageVersion.create({
        data: {
          id: randomUUID(),
          realm: this.realm,
          purpose: "local_preview",
          draftId: id,
          draftRevision: row.revision,
          snapshot,
          publicOffer,
        },
      }),
    );
  }
  async versions() {
    return (
      await this.database.packageVersion.findMany({
        where: { realm: this.realm, purpose: "local_preview" },
        orderBy: { sequence: "desc" },
      })
    ).map((row) => this.versionView(row));
  }
  async current(): Promise<CurrentPackage> {
    const row =
      this.realm === "local"
        ? await this.database.packageVersion.findFirst({
            where: { realm: "local", purpose: "local_preview" },
            orderBy: { sequence: "desc" },
          })
        : null;
    return {
      purchasable: false,
      reason: row ? "PREVIEW_ONLY" : "PACKAGE_PREPARING",
      version: row ? this.versionView(row) : null,
    };
  }
  async onModuleDestroy() {
    await this.database.$disconnect();
  }
}
@Controller("v1")
@ApiTags("Catalog")
export class CatalogController {
  constructor(private readonly catalog: Catalog) {}
  @Get("packages/current")
  @Header("Cache-Control", "no-store")
  @ApiOkResponse({ type: CurrentPackageResponseDto })
  async current(@Req() req: FastifyRequest) {
    return { data: await this.catalog.current(), meta: { requestId: req.id } };
  }
  @Get("recipient-types")
  @Header("Cache-Control", "no-store")
  @ApiOkResponse({ type: RecipientCatalogResponseDto })
  @ApiOperation({
    summary:
      "Active gift relationships; custom labels stay local to selection, confer no identity or authority",
  })
  async recipients(@Req() req: FastifyRequest) {
    return {
      data: await this.catalog.recipients(),
      meta: { requestId: req.id },
    };
  }
}
@Controller("v1/admin/catalog")
@ApiTags("Administration catalog")
@ApiCookieAuth("timenook-admin")
@ApiResponse({ status: 400, type: ErrorResponseDto })
@ApiResponse({ status: 401, type: ErrorResponseDto })
@ApiResponse({ status: 403, type: ErrorResponseDto })
@ApiResponse({ status: 409, type: ErrorResponseDto })
@ApiResponse({ status: 422, type: ErrorResponseDto })
export class AdminCatalogController {
  constructor(
    private readonly catalog: Catalog,
    private readonly access: AdminAccess,
  ) {}
  @Get("recipient-types")
  @Header("Cache-Control", "no-store")
  @ApiOkResponse({ type: ManagedRecipientsResponseDto })
  async recipients(@Req() req: FastifyRequest) {
    return {
      data: await this.access.run("catalog.recipient.list", req, async () => {
        await this.access.authorized(req, ADMIN_PERMISSIONS.readCatalog);
        return this.catalog.allRecipients();
      }),
      meta: { requestId: req.id },
    };
  }
  @Put("recipient-types/:code")
  @Header("Cache-Control", "no-store")
  @ApiOkResponse({ type: ManagedRecipientResponseDto })
  @ApiHeader({
    name: "X-CSRF-Token",
    required: true,
    description: "Session-bound token from admin session",
  })
  @ApiHeader({
    name: "Origin",
    required: true,
    description: "Configured same-origin administration origin",
  })
  async updateRecipient(
    @Param("code") code: string,
    @Body() body: UpdateRecipientDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.access.run("catalog.recipient.update", req, () =>
        this.access.command(req, ADMIN_PERMISSIONS.writeCatalog, (tx) =>
          this.catalog.updateRecipient(tx, code, body),
        ),
      ),
      meta: { requestId: req.id },
    };
  }
  @Get("package-versions")
  @Header("Cache-Control", "no-store")
  @ApiOkResponse({ type: PackageVersionsResponseDto })
  async versions(@Req() req: FastifyRequest) {
    return {
      data: await this.access.run("catalog.version.list", req, async () => {
        await this.access.authorized(req, ADMIN_PERMISSIONS.readCatalog);
        return this.catalog.versions();
      }),
      meta: { requestId: req.id },
    };
  }
  @Get("package-drafts")
  @Header("Cache-Control", "no-store")
  @ApiOkResponse({ type: PackageDraftsResponseDto })
  async drafts(@Req() req: FastifyRequest) {
    return {
      data: await this.access.run("catalog.draft.list", req, async () => {
        await this.access.authorized(req, ADMIN_PERMISSIONS.readCatalog);
        return this.catalog.drafts();
      }),
      meta: { requestId: req.id },
    };
  }
  @Post("package-drafts")
  @Header("Cache-Control", "no-store")
  @ApiCreatedResponse({ type: PackageDraftResponseDto })
  @ApiHeader({
    name: "X-CSRF-Token",
    required: true,
    description: "Session-bound token from admin session",
  })
  @ApiHeader({
    name: "Origin",
    required: true,
    description: "Configured same-origin administration origin",
  })
  async createDraft(@Body() body: DraftDto, @Req() req: FastifyRequest) {
    return {
      data: await this.access.run("catalog.draft.create", req, () =>
        this.access.command(req, ADMIN_PERMISSIONS.writeCatalog, (tx) =>
          this.catalog.createDraft(tx, body),
        ),
      ),
      meta: { requestId: req.id },
    };
  }
  @Put("package-drafts/:id")
  @Header("Cache-Control", "no-store")
  @ApiOkResponse({ type: PackageDraftResponseDto })
  @ApiHeader({
    name: "X-CSRF-Token",
    required: true,
    description: "Session-bound token from admin session",
  })
  @ApiHeader({
    name: "Origin",
    required: true,
    description: "Configured same-origin administration origin",
  })
  async updateDraft(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() body: UpdateDraftDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.access.run("catalog.draft.update", req, () =>
        this.access.command(req, ADMIN_PERMISSIONS.writeCatalog, (tx) =>
          this.catalog.updateDraft(tx, id, body),
        ),
      ),
      meta: { requestId: req.id },
    };
  }
  @Post("package-drafts/:id/preview-versions")
  @Header("Cache-Control", "no-store")
  @ApiCreatedResponse({ type: PackageVersionResponseDto })
  @ApiHeader({
    name: "X-CSRF-Token",
    required: true,
    description: "Session-bound token from admin session",
  })
  @ApiHeader({
    name: "Origin",
    required: true,
    description: "Configured same-origin administration origin",
  })
  async freeze(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() body: RevisionDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.access.run("catalog.preview.freeze", req, () =>
        this.access.command(req, ADMIN_PERMISSIONS.freezeCatalog, (tx) =>
          this.catalog.freeze(tx, id, body),
        ),
      ),
      meta: { requestId: req.id },
    };
  }
  @Post("recipient-types")
  @Header("Cache-Control", "no-store")
  @ApiCreatedResponse({ type: ManagedRecipientResponseDto })
  @ApiHeader({
    name: "X-CSRF-Token",
    required: true,
    description: "Session-bound token from admin session",
  })
  @ApiHeader({
    name: "Origin",
    required: true,
    description: "Configured same-origin administration origin",
  })
  async createRecipient(
    @Body() body: CreateRecipientDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.access.run("catalog.recipient.create", req, () =>
        this.access.command(req, ADMIN_PERMISSIONS.writeCatalog, (tx) =>
          this.catalog.createRecipient(tx, body),
        ),
      ),
      meta: { requestId: req.id },
    };
  }
}
