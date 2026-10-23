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
import { AdminTermsController } from "./payments/admin-terms-controller";
import {
  Participation,
  ParticipationController,
} from "./identity/participation";
import { AdminCareController } from "./identity/admin-care-controller";
import { validateWechatPayConfig } from "./payments/wechat-pay";
import {
  Orders,
  OrdersController,
  PaymentWebhookController,
  PAYMENT_FETCH,
} from "./payments/orders";
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
    OrdersController,
    AdminTermsController,
    PaymentWebhookController,
    HealthController,
    IdentityController,
    ParticipationController,
    AdminCareController,
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
    probeObjects?: ProbeObjects;
    aiFetch?: typeof fetch;
    paymentFetch?: typeof fetch;
    recordingObjects?: ProbeObjects;
  } = {},
): Promise<NestFastifyApplication> {
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
    (config.environment !== "test" ||
      !options.paymentFetch ||
      options.paymentFetch === fetch ||
      config.payments.mode !== "local-verification" ||
      config.payments.appId !== config.wechat?.appId)
  )
    throw new ConfigurationError(
      "Payments require test-only local verification and synthetic transport for this AppID",
    );
  if (config.payments) {
    try {
      validateWechatPayConfig(config.payments);
    } catch {
      throw new ConfigurationError(
        "Invalid isolated payment protocol configuration or callback path",
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
        fileSize: 2097152,
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
      ...(config.participation
        ? [PersonalPlanController, InterviewsController]
        : []),
      ...(config.recording
        ? [RecordingsController, RecordingObjectsController]
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
      { provide: API_CONFIG, useValue: config },
      Infrastructure,
      ...(config.recording
        ? [
            Recordings,
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
      Participation,
      PersonalPlans,
      Interviews,
      AdminAccess,
      Catalog,
      Orders,
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
