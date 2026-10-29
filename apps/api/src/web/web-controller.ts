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
import { IsString, Matches } from "class-validator";
import type { FastifyReply, FastifyRequest } from "fastify";
import { WebAccess, WEB_COOKIE, WEB_COOKIE_PATH } from "./web-access";

class WebLoginDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{43}$/)
  ticket!: string;
}

@Controller("v1/web")
export class WebController {
  constructor(private readonly access: WebAccess) {}
  @Post("session")
  @Header("Cache-Control", "no-store")
  async exchange(
    @Body() command: WebLoginDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    this.access.requireOrigin(request);
    await this.access.limit(request.ip);
    const result = await this.access.exchange(command.ticket);
    reply.setCookie(WEB_COOKIE, result.token, {
      path: WEB_COOKIE_PATH,
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      expires: new Date(result.data.session.expiresAt),
    });
    return { data: result.data, meta: { requestId: request.id } };
  }
  @Get("session")
  @Header("Cache-Control", "no-store")
  async current(@Req() request: FastifyRequest) {
    return {
      data: (await this.access.current(request)).data,
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
