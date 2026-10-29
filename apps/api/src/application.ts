import { PrivacyRights } from "./care/privacy-rights";
import {
  Deletions,
  DeletionController,
  AdminDeletionController,
  DELETION_OBJECTS,
} from "./care/deletions";
import {
  QualityCare,
  QualityCareController,
  AdminQualityCareController,
} from "./care/quality-care";
import {
  Fulfillment,
  FulfillmentController,
  AdminFulfillmentController,
} from "./books/fulfillment";
import {
  CompleteExports,
  CompleteExportsController,
  AdminCompleteExportsController,
} from "./care/complete-export";
import {
  FirstCopies,
  FirstCopyController,
  AdminFirstCopyController,
} from "./books/first-copy";
import { BookAudio, BookAudioController } from "./books/book-audio";
import { Books, BooksController, BOOK_OBJECTS } from "./books/books";
import { Followups, FollowupsController } from "./followups/followups";
import {
  StoryCare,
  StoryCareController,
  AdminStoryCareController,
} from "./stories/story-care";
import {
  ProjectOverview,
  ProjectOverviewController,
} from "./projects/project-overview";
import { Stories, StoriesController } from "./stories/stories";
import { AdminTasksController } from "./tasks/admin-tasks";
import {
  ProductionTasks,
  ProductionTasksController,
  TASK_OBJECTS,
} from "./tasks/tasks";
import {
  Photos,
  PhotosController,
  PhotoObjectsController,
  PHOTO_OBJECTS,
} from "./media/photos";
import {
  Recordings,
  RecordingsController,
  RecordingObjectsController,
  RECORDING_OBJECTS,
} from "./media/recordings";
import { Interviews, InterviewsController } from "./projects/interviews";
import {
  PersonalPlans,
  PersonalPlanController,
} from "./projects/personal-plan-controller";
import {
  Participation,
  ParticipationController,
} from "./identity/participation";
import { ProjectStreams } from "./media/project-streams";
import { AdminCareController } from "./identity/admin-care-controller";
import { validateWechatPayConfig } from "./payments/wechat-pay";
import {
  Orders,
  OrdersController,
  PaymentWebhookController,
  PAYMENT_FETCH,
} from "./payments/orders";
import {
  Refunds,
  RefundsController,
  AdminRefundsController,
  RefundWebhookController,
  REFUND_RUNTIME,
  type RefundRuntime,
} from "./payments/refunds";
import { AI_FETCH } from "./probe/ai-providers";
import { AiProbe } from "./probe/ai-probe";
import { AiProbeController } from "./probe/ai-probe-controller";
import {
  Catalog,
  CatalogController,
  AdminCatalogController,
} from "./catalog/catalog";
import "reflect-metadata";
import { AudioProbe } from "./probe/audio-probe";
import { PrintProbeController } from "./probe/print-probe-controller";
import { ProbeController } from "./probe/probe-controller";
import { probeStorageScope } from "./probe/storage-scope";
import { OssProbeObjects } from "./probe/oss-objects";
import multipart from "@fastify/multipart";
import {
  LocalProbeObjects,
  PROBE_OBJECTS,
  ProbeObjects,
} from "./probe/local-objects";
import cookie from "@fastify/cookie";
import { AdminAccess } from "./admin/admin-access";
import { ADMIN_FEISHU_FETCH } from "./admin/feishu";
import { AdminController } from "./admin/admin-controller";
import { randomUUID } from "node:crypto";
import {
  Controller,
  Get,
  Module,
  Req,
  ServiceUnavailableException,
  ValidationPipe,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  NestFastifyApplication,
} from "@nestjs/platform-fastify";
import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import type { ApiResponse, HealthStatus } from "@timenook/contracts";
import {
  API_CONFIG,
  ApiConfig,
  ConfigurationError,
  validateAiProbeConfig,
  validateWebConfig,
} from "./config";
import { Infrastructure } from "./infrastructure";
import { errorResponse, HttpErrorFilter } from "./http-error-filter";
import {
  ApiOkResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
  DocumentBuilder,
  SwaggerModule,
} from "@nestjs/swagger";
import { ErrorResponseDto, HealthResponseDto } from "./health-contract";
import { IdentityAccess, WECHAT_FETCH } from "./identity/identity-access";
import { IdentityController } from "./identity/identity-controller";
import { WebController } from "./web/web-controller";
import { WebAccess } from "./web/web-access";
import {
  WechatLinks,
  WebWechatLinkController,
  NativeWechatLinkController,
} from "./identity/wechat-link";
import { HttpException } from "@nestjs/common";

@Controller("health")
@ApiTags("Health")
class HealthController {
  constructor(private readonly infrastructure: Infrastructure) {}

  @Get("live")
  @ApiOkResponse({ type: HealthResponseDto })
  live(@Req() request: FastifyRequest): ApiResponse<HealthStatus> {
    return {
      data: { status: "ok", service: "timenook-api", version: "0.1.0" },
      meta: { requestId: request.id },
    };
  }

  @Get("ready")
  @ApiOkResponse({ type: HealthResponseDto })
  @ApiServiceUnavailableResponse({ type: ErrorResponseDto })
  async ready(
    @Req() request: FastifyRequest,
  ): Promise<ApiResponse<HealthStatus>> {
    if (!(await this.infrastructure.ready()))
      throw new ServiceUnavailableException();
    return {
      data: { status: "ready", service: "timenook-api", version: "0.1.0" },
      meta: { requestId: request.id },
    };
  }
}

@Module({
  controllers: [
    HealthController,
    IdentityController,
    AdminController,
    CatalogController,
    AdminCatalogController,
  ],
})
class AppModule {}

export async function createApplication(
  config: ApiConfig,
  options: {
    wechatFetch?: typeof fetch;
    feishuFetch?: typeof fetch;
    probeObjects?: ProbeObjects;
    aiFetch?: typeof fetch;
    paymentFetch?: typeof fetch;
    recordingObjects?: ProbeObjects;
    refundRuntime?: Partial<RefundRuntime>;
  } = {},
): Promise<NestFastifyApplication> {
  if (
    config.acceptance &&
    (config.acceptance.mode !== "internal-acceptance" ||
      config.acceptance.profileVersion !== "internal-acceptance-v1" ||
      !config.web ||
      !config.privacyJournal ||
      config.payments)
  )
    throw new ConfigurationError(
      "Internal acceptance requires its profile, web sessions, independent privacy journal and no payments",
    );
  if (config.web) {
    validateWebConfig(config.web);
    if (
      config.environment !== "test" &&
      !config.acceptance &&
      (config.payments ||
        config.participation ||
        config.recording ||
        config.photos ||
        config.transcription ||
        config.generation ||
        config.books)
    )
      throw new ConfigurationError(
        "Web product runtime requires the separate controlled acceptance assembly and lifetime-service verification",
      );
  }
  if (options.feishuFetch && config.environment !== "test")
    throw new ConfigurationError(
      "Feishu transport overrides require isolated tests",
    );
  if (options.refundRuntime && config.environment !== "test")
    throw new ConfigurationError(
      "Refund scheduling and clock overrides require isolated tests",
    );
  if (config.books) {
    let url: URL;
    try {
      url = new URL(config.books.entryBaseUrl);
    } catch {
      throw new ConfigurationError("Book original-entry URL is invalid");
    }
    if (
      config.environment !== "test" ||
      config.books.mode !== "synthetic-local" ||
      !config.recording ||
      !config.books.storageRoot.startsWith("/") ||
      !/^synthetic-/.test(config.books.specificationVersion) ||
      !/^synthetic-/.test(config.books.provenanceVersion) ||
      (config.books.maxPhotoBytes !== undefined &&
        (!Number.isSafeInteger(config.books.maxPhotoBytes) ||
          config.books.maxPhotoBytes < 1 ||
          config.books.maxPhotoBytes > 33554432)) ||
      url.protocol !== "https:" ||
      !url.hostname.endsWith(".invalid") ||
      url.pathname !== "/timenook/audio/" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new ConfigurationError(
        "Book rendering requires explicit isolated synthetic specification and provenance",
      );
  }
  const generation = config.generation;
  if (
    generation &&
    (config.environment !== "test" ||
      !config.recording ||
      !config.participation ||
      generation.mode !== "synthetic-local" ||
      !options.aiFetch ||
      options.aiFetch === fetch ||
      !/^synthetic-[a-z0-9-]+$/.test(generation.configVersion) ||
      !/^synthetic-[a-z0-9-]+$/.test(generation.deepseek.model) ||
      !generation.deepseek.apiKey.startsWith("synthetic-") ||
      !Number.isSafeInteger(generation.deepseek.maxTokens) ||
      generation.deepseek.maxTokens < 1 ||
      generation.deepseek.maxTokens > 32768 ||
      !Number.isSafeInteger(generation.submissionReservationFen) ||
      generation.submissionReservationFen < 0 ||
      !Number.isSafeInteger(generation.maxSubmissions) ||
      generation.maxSubmissions < 1 ||
      !Number.isSafeInteger(generation.deadlineMs) ||
      generation.deadlineMs < 30000 ||
      generation.deadlineMs > 86400000)
  )
    throw new ConfigurationError(
      "Generation requires explicit isolated synthetic recording, configuration, budget and transport",
    );
  if (
    config.photos &&
    (config.environment !== "test" ||
      config.photos.mode !== "synthetic-local" ||
      !config.recording ||
      ![
        config.photos.placement.widthMm,
        config.photos.placement.heightMm,
      ].every((n) => Number.isFinite(n) && n >= 1 && n <= 300))
  )
    throw new ConfigurationError(
      "Photos require isolated recording and explicit candidate placement",
    );
  if (
    config.transcription &&
    (config.environment !== "test" ||
      !config.recording ||
      config.transcription.mode !== "synthetic-local" ||
      !options.aiFetch ||
      options.aiFetch === fetch ||
      !/^synthetic-[a-z0-9-]+$/.test(config.transcription.configVersion) ||
      !Number.isInteger(config.transcription.pollIntervalMs) ||
      config.transcription.pollIntervalMs < 0 ||
      config.transcription.pollIntervalMs > 60000 ||
      !Number.isSafeInteger(config.transcription.submissionReservationFen) ||
      config.transcription.submissionReservationFen < 0 ||
      !Number.isSafeInteger(config.transcription.deadlineMs) ||
      config.transcription.deadlineMs < 30000 ||
      config.transcription.deadlineMs > 86400000 ||
      !config.transcription.doubao.apiKey.startsWith("synthetic-") ||
      !config.transcription.doubao.resourceId.startsWith("synthetic-") ||
      !Number.isInteger(config.transcription.doubao.fetchWindowSeconds) ||
      config.transcription.doubao.fetchWindowSeconds < 1 ||
      config.transcription.doubao.fetchWindowSeconds > 3600)
  )
    throw new ConfigurationError(
      "Transcription requires explicit isolated synthetic recording and transport",
    );
  if (
    config.recording &&
    (config.environment !== "test" ||
      config.recording.mode !== "synthetic-local" ||
      !config.participation ||
      !config.recording.storageRoot.startsWith("/"))
  )
    throw new ConfigurationError(
      "Recording requires isolated synthetic participation and private local storage",
    );
  if (
    options.recordingObjects &&
    (!config.recording || config.environment !== "test")
  )
    throw new ConfigurationError(
      "Custom recording storage requires isolated test recording",
    );
  if (
    config.recording &&
    config.audioProbe &&
    probeStorageScope(config.recording) === probeStorageScope(config.audioProbe)
  )
    throw new ConfigurationError(
      "Product recording and probe require separate object storage",
    );
  if (
    config.participation &&
    (config.environment !== "test" ||
      config.participation.mode !== "synthetic-d08" ||
      config.payments?.mode !== "local-verification")
  )
    throw new ConfigurationError(
      "D08 synthetic participation requires isolated local payment verification tests",
    );
  if (
    config.payments &&
    ((config.payments.mode === "local-verification"
      ? config.environment !== "test" ||
        !options.paymentFetch ||
        options.paymentFetch === fetch
      : config.payments.mode !== "ordinary-merchant" ||
        config.environment === "test" ||
        !!options.paymentFetch) ||
      config.payments.appId !== config.wechat?.appId)
  )
    throw new ConfigurationError(
      "Payments require isolated local verification transport or ordinary merchant native transport for this AppID",
    );
  if (config.payments) {
    try {
      validateWechatPayConfig(config.payments);
    } catch {
      throw new ConfigurationError(
        "Invalid payment protocol configuration or callback path",
      );
    }
  }
  if (config.aiProbe) validateAiProbeConfig(config.aiProbe);
  if (options.aiFetch && config.environment !== "test")
    throw new ConfigurationError("Custom AI transport is only allowed in test");
  if (
    config.aiProbe &&
    (!config.audioProbe || config.environment === "production")
  )
    throw new ConfigurationError(
      "AI probe requires non-production audio probe",
    );
  if (options.probeObjects && config.environment !== "test")
    throw new ConfigurationError(
      "Custom probe storage is only allowed in test",
    );
  if (config.audioProbe && config.environment === "production")
    throw new ConfigurationError("Audio probe cannot be enabled in production");
  if (options.wechatFetch && config.environment !== "test") {
    throw new ConfigurationError(
      "Custom WeChat transport is only allowed in test",
    );
  }
  const productEnabled = !!(
    config.acceptance ||
    config.payments ||
    config.participation ||
    config.recording ||
    config.books
  );
  const privateEnabled = productEnabled || !!config.web;
  if (privateEnabled && !config.privacyJournal)
    throw new ConfigurationError(
      "Product private capabilities require an independent privacy journal",
    );
  const adapter = new FastifyAdapter({
    logger: false,
    // Only the local Nginx hop can supply X-Forwarded-For. It must append or
    // replace the actual peer address; arbitrary Internet peers are untrusted.
    trustProxy: ["127.0.0.1", "::1"],
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    frameworkErrors: (
      error: FastifyError,
      request: FastifyRequest,
      reply: FastifyReply,
    ) => {
      // Malformed URLs fail before onRequest and the Nest exception filter.
      const status = error.code === "FST_ERR_BAD_URL" ? 400 : 500;
      reply.header("x-request-id", request.id);
      reply.status(status).send(errorResponse(status, request.id));
    },
  });
  await adapter.getInstance().register(cookie);
  if (config.audioProbe || config.recording)
    await adapter.getInstance().register(multipart, {
      limits: {
        fileSize: config.photos ? 16777216 : 2097152,
        fields: 3,
        files: 1,
        parts: 4,
        fieldSize: 4096,
      },
    });
  adapter.getInstance().addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });
  const module = {
    module: AppModule,
    controllers: [
      ...(config.web ? [WebController, WebWechatLinkController] : []),
      NativeWechatLinkController,
      PaymentWebhookController,
      RefundWebhookController,
      ...(config.payments
        ? [RefundsController, AdminRefundsController, OrdersController]
        : []),
      ...(productEnabled
        ? [
            ParticipationController,
            AdminCareController,
            DeletionController,
            AdminDeletionController,
          ]
        : []),
      ...(config.participation || config.acceptance
        ? [PersonalPlanController, InterviewsController]
        : []),
      ...(config.recording || config.acceptance
        ? [ProjectOverviewController]
        : []),
      ...(config.photos ? [PhotosController, PhotoObjectsController] : []),
      ...(config.recording
        ? [
            RecordingsController,
            StoriesController,
            ...(config.books
              ? [
                  QualityCareController,
                  AdminQualityCareController,
                  BooksController,
                  CompleteExportsController,
                  AdminCompleteExportsController,
                  BookAudioController,
                  FirstCopyController,
                  FulfillmentController,
                  AdminFulfillmentController,
                  AdminFirstCopyController,
                ]
              : []),
            FollowupsController,
            StoryCareController,
            AdminStoryCareController,
            RecordingObjectsController,
            ProductionTasksController,
            AdminTasksController,
          ]
        : []),
      ...(config.audioProbe
        ? [
            ProbeController,
            PrintProbeController,
            ...(config.aiProbe ? [AiProbeController] : []),
          ]
        : []),
    ],
    providers: [
      ...(config.web ? [WebAccess] : []),
      { provide: API_CONFIG, useValue: config },
      { provide: ADMIN_FEISHU_FETCH, useValue: options.feishuFetch ?? fetch },
      Infrastructure,
      PrivacyRights,
      Deletions,
      ...(config.recording
        ? [
            {
              provide: DELETION_OBJECTS,
              useValue:
                options.recordingObjects ??
                (config.recording.oss
                  ? new OssProbeObjects(config.recording.oss)
                  : new LocalProbeObjects(config.recording.storageRoot)),
            },
          ]
        : []),
      ...(config.photos
        ? [
            Photos,
            {
              provide: PHOTO_OBJECTS,
              useValue:
                options.recordingObjects ??
                (config.recording!.oss
                  ? new OssProbeObjects(config.recording!.oss)
                  : new LocalProbeObjects(config.recording!.storageRoot)),
            },
          ]
        : []),
      ...(config.recording || config.acceptance ? [ProjectOverview] : []),
      { provide: AI_FETCH, useValue: options.aiFetch ?? fetch },
      ...(config.recording
        ? [
            ...(config.books
              ? [
                  QualityCare,
                  Books,
                  FirstCopies,
                  CompleteExports,
                  Fulfillment,
                  BookAudio,
                  {
                    provide: BOOK_OBJECTS,
                    useValue:
                      options.recordingObjects ??
                      (config.recording!.oss
                        ? new OssProbeObjects(config.recording!.oss)
                        : new LocalProbeObjects(config.recording!.storageRoot)),
                  },
                ]
              : []),
            Recordings,
            Stories,
            Followups,
            StoryCare,
            ProductionTasks,
            {
              provide: TASK_OBJECTS,
              useValue:
                options.recordingObjects ??
                (config.recording.oss
                  ? new OssProbeObjects(config.recording.oss)
                  : new LocalProbeObjects(config.recording.storageRoot)),
            },
            {
              provide: RECORDING_OBJECTS,
              useValue:
                options.recordingObjects ??
                (config.recording.oss
                  ? new OssProbeObjects(config.recording.oss)
                  : new LocalProbeObjects(config.recording.storageRoot)),
            },
          ]
        : []),
      ...(config.audioProbe
        ? [
            AudioProbe,
            ...(config.aiProbe
              ? [
                  AiProbe,
                  { provide: AI_FETCH, useValue: options.aiFetch ?? fetch },
                ]
              : []),
            {
              provide: PROBE_OBJECTS,
              useValue:
                options.probeObjects ??
                (config.audioProbe.oss
                  ? new OssProbeObjects(config.audioProbe.oss)
                  : new LocalProbeObjects(config.audioProbe.storageRoot)),
            },
          ]
        : []),
      { provide: WECHAT_FETCH, useValue: options.wechatFetch ?? fetch },
      IdentityAccess,
      WechatLinks,
      ProjectStreams,
      Participation,
      PersonalPlans,
      Interviews,
      AdminAccess,
      Catalog,
      Orders,
      Refunds,
      {
        provide: REFUND_RUNTIME,
        useValue: {
          now: options.refundRuntime?.now ?? (() => new Date()),
          beforeExecution:
            options.refundRuntime?.beforeExecution ?? (async () => {}),
        },
      },
      { provide: PAYMENT_FETCH, useValue: options.paymentFetch ?? fetch },
    ],
  };
  const app = await NestFactory.create<NestFastifyApplication>(
    module,
    adapter,
    {
      logger: false,
      rawBody: true,
      abortOnError: false,
    },
  );
  if (config.web)
    adapter.getInstance().addHook("onRequest", async (request, reply) => {
      try {
        await app.get(WebAccess).bridge(request);
      } catch (error) {
        const status = error instanceof HttpException ? error.getStatus() : 503;
        return reply
          .header("Cache-Control", "no-store")
          .status(status)
          .send(errorResponse(status, request.id));
      }
    });
  adapter.getInstance().addHook("onSend", async (request, reply, payload) => {
    if (request.routeOptions.url?.startsWith("/v1/admin/")) {
      // Validation rejects before the controller; only the fixed action, generated
      // request ID and status are retained, never a raw URL/body/header.
      await app.get(AdminAccess).auditUnhandled(request, reply.statusCode);
    }
    return payload;
  });
  app.useGlobalFilters(new HttpErrorFilter());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  if (config.environment !== "production") {
    SwaggerModule.setup("docs", app, createOpenApiDocument(app), {
      jsonDocumentUrl: "openapi.json",
    });
  }
  try {
    if (privateEnabled) {
      await app.get(PrivacyRights).initialize();
      if (productEnabled) await app.get(Deletions).sweep();
    }
  } catch (error) {
    await app.close();
    throw error;
  }
  adapter.getInstance().addHook("onRequest", async (request) => {
    if (
      privateEnabled &&
      !request.url.startsWith("/health/live") &&
      !request.url.startsWith("/docs") &&
      !request.url.startsWith("/openapi")
    )
      await app.get(PrivacyRights).assertHealthy();
  });
  await app.init();
  await adapter.getInstance().ready();
  return app;
}

export function createOpenApiDocument(app: NestFastifyApplication) {
  return SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle("TimeNook API")
      .setDescription(
        "Public transport contracts. Health readiness checks PostgreSQL migrations and Redis.",
      )
      .setVersion("0.1.0")
      .addCookieAuth(
        "__Secure-timenook_admin",
        { type: "apiKey", in: "cookie" },
        "timenook-admin",
      )
      .addBearerAuth(
        {
          type: "http",
          scheme: "bearer",
          description:
            "Independent operator-provisioned non-production probe token",
        },
        "timenook-probe",
      )
      .addBearerAuth({
        type: "http",
        scheme: "bearer",
        bearerFormat: "opaque",
        description: "Opaque TimeNook session token",
      })
      .build(),
  );
}
