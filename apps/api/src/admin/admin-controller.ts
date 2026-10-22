import {
  Body,
  Controller,
  Get,
  Header,
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
  ApiProperty,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { IsString, Length, Matches } from "class-validator";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ADMIN_PERMISSIONS } from "@timenook/contracts";
import type {
  AdminLoginCommand,
  AdminMfaCommand,
  AdminRuntime,
  ApiResponse as ApiEnvelope,
} from "@timenook/contracts";
import {
  AdminStateResponseDto,
  AdminEnrollmentResponseDto,
  AdminRuntimeResponseDto,
  AdminAuditResponseDto,
} from "./admin-contract";
import { AdminAccess } from "./admin-access";
import { Infrastructure } from "../infrastructure";
import { ErrorResponseDto } from "../health-contract";
class AdminLoginDto implements AdminLoginCommand {
  @ApiProperty({ minLength: 3, maxLength: 64 })
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9._-]{2,63}$/)
  username!: string;
  @ApiProperty({
    minLength: 16,
    maxLength: 128,
    format: "password",
    writeOnly: true,
  })
  @IsString()
  @Length(16, 128)
  password!: string;
}
class MfaDto implements AdminMfaCommand {
  @ApiProperty({ pattern: "^[0-9]{6}$", writeOnly: true })
  @IsString()
  @Matches(/^\d{6}$/)
  code!: string;
}
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
  @Post("login")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  @ApiOperation({
    summary:
      "Verify password only; requires Origin and X-CSRF-Token; does not grant admin access",
  })
  @ApiOkResponse({ type: AdminStateResponseDto })
  login(
    @Body() body: AdminLoginDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.response("admin.password", req, () =>
      this.access.login(req, reply, body.username, body.password),
    );
  }
  @Get("mfa/enrollment")
  @Header("Cache-Control", "no-store")
  @ApiOperation({
    summary:
      "Password challenge only: retrieve first enrollment secret for the operator authenticator",
  })
  @ApiOkResponse({ type: AdminEnrollmentResponseDto })
  enrollment(@Req() req: FastifyRequest) {
    return this.response("admin.mfa.enrollment", req, () =>
      this.access.enrollment(req),
    );
  }
  @Post("mfa")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  @ApiOperation({
    summary:
      "Verify a fresh TOTP and rotate to a full session; requires Origin and X-CSRF-Token",
  })
  @ApiOkResponse({ type: AdminStateResponseDto })
  mfa(
    @Body() body: MfaDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.response("admin.mfa", req, () =>
      this.access.mfa(req, reply, body.code),
    );
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
      "Revoke current challenge or session and clear cookie; requires Origin and X-CSRF-Token",
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
