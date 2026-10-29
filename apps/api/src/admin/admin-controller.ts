import {
  Controller,
  Get,
  Header,
  HttpException,
  Query,
  HttpCode,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiNoContentResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ADMIN_PERMISSIONS } from "@timenook/contracts";
import type {
  AdminFeishuLogin,
  AdminRuntime,
  ApiResponse as ApiEnvelope,
} from "@timenook/contracts";
import {
  AdminStateResponseDto,
  AdminFeishuLoginResponseDto,
  AdminRuntimeResponseDto,
  AdminAuditResponseDto,
} from "./admin-contract";
import { AdminAccess } from "./admin-access";
import { Infrastructure } from "../infrastructure";
import { ErrorResponseDto } from "../health-contract";
@Controller("v1/admin")
@ApiTags("Administration")
@ApiCookieAuth("timenook-admin")
@ApiResponse({ status: 401, type: ErrorResponseDto })
@ApiResponse({ status: 403, type: ErrorResponseDto })
@ApiResponse({ status: 429, type: ErrorResponseDto })
export class AdminController {
  constructor(
    private readonly access: AdminAccess,
    private readonly infrastructure: Infrastructure,
  ) {}
  private async response<T>(
    action: string,
    request: FastifyRequest,
    work: () => Promise<T>,
  ): Promise<ApiEnvelope<T>> {
    return {
      data: await this.access.run(action, request, work),
      meta: { requestId: request.id },
    };
  }
  @Get("session")
  @Header("Cache-Control", "no-store")
  @ApiOperation({
    summary:
      "Get admin session state and session-bound CSRF token; create anonymous challenge when needed",
  })
  @ApiOkResponse({ type: AdminStateResponseDto })
  session(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.response("admin.session", req, () =>
      this.access.bootstrap(req, reply),
    );
  }
  @Post("feishu/login")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  @ApiOperation({
    summary:
      "Start browser-bound Feishu authorization; requires anonymous session, Origin and CSRF",
  })
  @ApiOkResponse({ type: AdminFeishuLoginResponseDto })
  login(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ApiEnvelope<AdminFeishuLogin>> {
    return this.response("admin.feishu.login", req, () =>
      this.access.feishuLogin(req, reply),
    );
  }
  @Get("feishu/callback")
  @Header("Cache-Control", "no-store")
  @Header("Referrer-Policy", "no-referrer")
  @ApiOperation({
    summary:
      "Consume a browser-bound one-time OAuth state, verify whitelisted Feishu identity and issue an independent admin session",
  })
  async callback(
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
    @Query() query: { state?: string; code?: string; error?: string },
  ) {
    let destination = "/admin/";
    try {
      await this.access.run("admin.feishu.callback", req, () =>
        this.access.feishuCallback(req, reply, query),
      );
    } catch (error) {
      destination +=
        "?login_error=" +
        (error instanceof HttpException && error.getStatus() === 503
          ? "unavailable"
          : "denied");
    }
    this.access.clearOAuthCookie(reply);
    return reply.code(303).redirect(destination);
  }
  @Get("runtime")
  @Header("Cache-Control", "no-store")
  @ApiOperation({ summary: "ops:read only: minimal runtime dependency state" })
  @ApiOkResponse({ type: AdminRuntimeResponseDto })
  runtime(@Req() req: FastifyRequest) {
    return this.response(
      "admin.runtime",
      req,
      async (): Promise<AdminRuntime> => {
        await this.access.authorized(req, ADMIN_PERMISSIONS.readRuntime);
        return {
          service: "timenook-api",
          status: (await this.infrastructure.ready()) ? "ready" : "unavailable",
        };
      },
    );
  }
  @Get("audit")
  @Header("Cache-Control", "no-store")
  @ApiOperation({
    summary: "audit:read only: last 100 credential-free operation facts",
  })
  @ApiOkResponse({ type: AdminAuditResponseDto })
  audit(@Req() req: FastifyRequest) {
    return this.response("admin.audit", req, () => this.access.audits(req));
  }
  @Post("logout")
  @HttpCode(204)
  @Header("Cache-Control", "no-store")
  @ApiOperation({
    summary:
      "Revoke current session and clear cookie; requires Origin and X-CSRF-Token",
  })
  @ApiNoContentResponse()
  async logout(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    await this.access.run("admin.logout", req, () =>
      this.access.logout(req, reply),
    );
  }
}
