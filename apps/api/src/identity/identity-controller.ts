import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from "@nestjs/common";
import { IsString, Length, Matches } from "class-validator";
import type { FastifyRequest } from "fastify";
import type { LoginCommand } from "@timenook/contracts";
import { IdentityAccess } from "./identity-access";
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProperty,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { AccountResponseDto, LoginResponseDto } from "./identity-contract";
import { ErrorResponseDto } from "../health-contract";

export class WechatLoginDto implements LoginCommand {
  @IsString()
  @Length(1, 256)
  @Matches(/^\S+$/)
  @ApiProperty({
    minLength: 1,
    maxLength: 256,
    description: "Fresh wx.login code; clients must not send openid or AppID.",
  })
  code!: string;
}

@Controller("v1")
@ApiTags("Identity")
@ApiResponse({ status: 400, type: ErrorResponseDto })
@ApiResponse({ status: 401, type: ErrorResponseDto })
export class IdentityController {
  constructor(private readonly identity: IdentityAccess) {}

  @Post("sessions/wechat")
  @Header("Cache-Control", "no-store")
  @ApiOperation({ summary: "Exchange one WeChat code for a product session" })
  @ApiCreatedResponse({ type: LoginResponseDto })
  @ApiResponse({ status: 403, type: ErrorResponseDto })
  @ApiResponse({ status: 429, type: ErrorResponseDto })
  @ApiResponse({ status: 502, type: ErrorResponseDto })
  @ApiResponse({ status: 503, type: ErrorResponseDto })
  async login(@Body() command: WechatLoginDto, @Req() request: FastifyRequest) {
    return {
      data: await this.identity.login(command.code, request.ip),
      meta: { requestId: request.id },
    };
  }

  @Get("users/me")
  @Header("Cache-Control", "no-store")
  @ApiBearerAuth()
  @ApiOkResponse({ type: AccountResponseDto })
  async me(@Req() request: FastifyRequest) {
    return {
      data: await this.identity.current(request.headers.authorization),
      meta: { requestId: request.id },
    };
  }

  @Delete("sessions/:sessionId")
  @HttpCode(204)
  @Header("Cache-Control", "no-store")
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Revoke an owned session; foreign and unknown IDs are hidden",
  })
  @ApiParam({ name: "sessionId", format: "uuid" })
  @ApiNoContentResponse()
  @ApiResponse({ status: 404, type: ErrorResponseDto })
  async revoke(
    @Param("sessionId", new ParseUUIDPipe()) sessionId: string,
    @Req() request: FastifyRequest,
  ) {
    await this.identity.revoke(sessionId, request.headers.authorization);
  }
}
