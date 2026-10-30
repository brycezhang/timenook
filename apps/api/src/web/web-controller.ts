import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import { IsString, IsUUID, Length, Matches } from "class-validator";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  WebAccess,
  WEB_COOKIE,
  WEB_COOKIE_PATH,
  MOCK_ACCOUNT_COOKIE,
} from "./web-access";

class WebLoginDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{43}$/)
  ticket!: string;
}
class MockPurchaseDto {
  @IsUUID() purchaseKey!: string;
  @IsString() @Length(1, 80) bookTitle!: string;
  @IsString() @Length(1, 40) subjectName!: string;
}

@Controller("v1/web")
export class WebController {
  constructor(private readonly access: WebAccess) {}
  @Get("experience")
  @Header("Cache-Control", "no-store")
  experience(@Req() request: FastifyRequest) {
    return {
      data: { mockEnabled: this.access.mockEnabled() },
      meta: { requestId: request.id },
    };
  }
  @Post("mock-session")
  @Header("Cache-Control", "no-store")
  async mockLogin(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const result = await this.access.mockLogin(request);
    this.setCookie(reply, result);
    reply.setCookie(MOCK_ACCOUNT_COOKIE, result.ticket, {
      path: "/api/v1/web",
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      expires: new Date(result.data.session.expiresAt),
    });
    return { data: result.data, meta: { requestId: request.id } };
  }
  @Post("mock-purchases")
  @Header("Cache-Control", "no-store")
  async mockPurchase(
    @Body() input: MockPurchaseDto,
    @Req() request: FastifyRequest,
  ) {
    return {
      data: await this.access.mockPurchase(request, input),
      meta: { requestId: request.id },
    };
  }
  private setCookie(
    reply: FastifyReply,
    result: Awaited<ReturnType<WebAccess["current"]>>,
  ) {
    reply.setCookie(WEB_COOKIE, result.token, {
      path: WEB_COOKIE_PATH,
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      expires: new Date(result.data.session.expiresAt),
    });
  }
  @Post("session")
  @Header("Cache-Control", "no-store")
  async exchange(
    @Body() command: WebLoginDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    this.access.requireOrigin(request);
    await this.access.limit(request.ip);
    const result = await this.access.exchange(
      command.ticket,
      request.cookies[WEB_COOKIE],
    );
    this.setCookie(reply, result);
    return { data: result.data, meta: { requestId: request.id } };
  }
  @Get("session")
  @Header("Cache-Control", "no-store")
  async current(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const result = await this.access.current(request);
    // Refresh the browser's bounded persistent-cookie retention on real use.
    this.setCookie(reply, result);
    return {
      data: result.data,
      meta: { requestId: request.id },
    };
  }
  @Delete("session")
  @HttpCode(204)
  @Header("Cache-Control", "no-store")
  async logout(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    await this.access.logout(request);
    reply.clearCookie(WEB_COOKIE, {
      path: WEB_COOKIE_PATH,
      httpOnly: true,
      secure: true,
      sameSite: "strict",
    });
  }
  @Get("projects")
  @Header("Cache-Control", "no-store")
  async projects(@Req() request: FastifyRequest) {
    return {
      data: await this.access.projects(request),
      meta: { requestId: request.id },
    };
  }
}
