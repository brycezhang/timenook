import "reflect-metadata";
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
import { API_CONFIG, ApiConfig, ConfigurationError } from "./config";
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

@Module({ controllers: [HealthController, IdentityController] })
class AppModule {}

export async function createApplication(
  config: ApiConfig,
  options: { wechatFetch?: typeof fetch } = {},
): Promise<NestFastifyApplication> {
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
  adapter.getInstance().addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });
  const module = {
    module: AppModule,
    providers: [
      { provide: API_CONFIG, useValue: config },
      Infrastructure,
      { provide: WECHAT_FETCH, useValue: options.wechatFetch ?? fetch },
      IdentityAccess,
    ],
  };
  const app = await NestFactory.create<NestFastifyApplication>(
    module,
    adapter,
    {
      logger: false,
      abortOnError: false,
    },
  );
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
      .addBearerAuth({
        type: "http",
        scheme: "bearer",
        bearerFormat: "opaque",
        description: "Opaque TimeNook session token",
      })
      .build(),
  );
}
