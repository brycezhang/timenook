import {
  Body,
  Controller,
  Get,
  Post,
  Param,
  ParseUUIDPipe,
  Req,
  Header,
} from "@nestjs/common";
import {
  ApiCookieAuth,
  ApiHeader,
  ApiProperty,
  ApiTags,
} from "@nestjs/swagger";
import { IsIn, IsString, Matches } from "class-validator";
import type { FastifyRequest } from "fastify";
import { AdminAccess } from "../admin/admin-access";
import { ADMIN_PERMISSIONS } from "@timenook/contracts";
import { Orders, idempotencyKey } from "./orders";
class PauseDto {
  @ApiProperty({ enum: ["pause", "resume"] })
  @IsIn(["pause", "resume"])
  action!: "pause" | "resume";
  @ApiProperty()
  @IsString()
  @Matches(/^record:[A-Za-z0-9_:-]{3,120}$/)
  supportCaseRef!: string;
}
@Controller("v1/admin/service-terms")
@ApiTags("Administration service terms")
@ApiCookieAuth("timenook-admin")
export class AdminTermsController {
  constructor(
    private readonly orders: Orders,
    private readonly access: AdminAccess,
  ) {}
  @Get(":id") @Header("Cache-Control", "no-store") async read(
    @Req() request: FastifyRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return {
      data: await this.access.run("service-terms.read", request, async () => {
        await this.access.authorized(
          request,
          ADMIN_PERMISSIONS.writeServiceTerms,
        );
        return this.orders.readTerms(id);
      }),
      meta: { requestId: request.id },
    };
  }
  @Post(":id/pause")
  @Header("Cache-Control", "no-store")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  async pause(
    @Req() request: FastifyRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: PauseDto,
  ) {
    const data = await this.access.run(
      "service-terms.pause",
      request,
      async () => {
        const operator = await this.access.authorized(
          request,
          ADMIN_PERMISSIONS.writeServiceTerms,
        );
        await this.access.command(
          request,
          ADMIN_PERMISSIONS.writeServiceTerms,
          (tx) =>
            this.orders.changePause(tx, {
              projectId: id,
              eventId: idempotencyKey(request),
              kind: body.action,
              supportCaseRef: body.supportCaseRef,
              operatorId: operator.adminId!,
            }),
        );
        return this.orders.readTerms(id);
      },
    );
    return { data, meta: { requestId: request.id } };
  }
}
