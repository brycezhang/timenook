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
import { Equals, IsString, IsUUID, Matches } from "class-validator";
import type { FastifyReply, FastifyRequest } from "fastify";
import { USER_TERMS_VERSION } from "@timenook/contracts";
import { WebAccess, WEB_COOKIE, WEB_COOKIE_PATH } from "./web-access";
import { SmsCodes } from "../sms/sms-codes";
class SmsCodeDto {
  @IsString() @Matches(/^(?:\+86|86)?1[3-9]\d{9}$/) phone!: string;
  @Equals(USER_TERMS_VERSION) termsVersion!: string;
}
class SmsLoginDto {
  @IsUUID() challengeId!: string;
  @IsString() @Matches(/^\d{6}$/) code!: string;
  @Equals(USER_TERMS_VERSION) termsVersion!: string;
}
@Controller("v1/web")
export class WebController {
  constructor(
    private readonly access: WebAccess,
    private readonly codes: SmsCodes,
  ) {}
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
  @Post("sms-codes")
  @Header("Cache-Control", "no-store")
  async sendCode(@Body() input: SmsCodeDto, @Req() request: FastifyRequest) {
    this.access.requireOrigin(request);
    await this.access.limit(`sms-send:${request.ip}`, 20);
    return {
      data: await this.codes.send(input.phone, request.ip),
      meta: { requestId: request.id },
    };
  }
  @Post("session")
  @Header("Cache-Control", "no-store")
  async login(
    @Body() input: SmsLoginDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    this.access.requireOrigin(request);
    await this.access.limit(`sms-login:${request.ip}`, 30);
    const phone = await this.codes.consume(input.challengeId, input.code);
    const result = await this.access.login(phone, request.cookies[WEB_COOKIE]);
    this.setCookie(reply, result);
    return { data: result.data, meta: { requestId: request.id } };
  }
  @Get("session")
  @Header("Cache-Control", "no-store")
  async current(@Req() request: FastifyRequest) {
    const result = await this.access.current(request);
    return { data: result.data, meta: { requestId: request.id } };
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
}
