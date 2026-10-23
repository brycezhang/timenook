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
import { ApiCookieAuth, ApiTags, ApiHeader } from "@nestjs/swagger";
import { ADMIN_PERMISSIONS } from "@timenook/contracts";
import type { FastifyRequest } from "fastify";
import { AdminAccess } from "../admin/admin-access";
import { idempotencyKey } from "../payments/orders";
import { Participation, RebindDto } from "./participation";
@Controller("v1/admin")
@ApiTags("Administration care")
@ApiCookieAuth("timenook-admin")
export class AdminCareController {
  constructor(
    private readonly access: AdminAccess,
    private readonly participation: Participation,
  ) {}
  @Get("care-requests")
  @Header("Cache-Control", "no-store")
  async list(@Req() request: FastifyRequest) {
    return {
      data: await this.access.run("care.list", request, async () => {
        await this.access.authorized(request, ADMIN_PERMISSIONS.writeCare);
        return this.participation.careCases();
      }),
      meta: { requestId: request.id },
    };
  }
  @Get("care-requests/:id")
  @Header("Cache-Control", "no-store")
  async read(
    @Param("id", ParseUUIDPipe) id: string,
    @Req() request: FastifyRequest,
  ) {
    return {
      data: await this.access.run("care.read", request, async () => {
        await this.access.authorized(request, ADMIN_PERMISSIONS.writeCare);
        return this.participation.careCases(id);
      }),
      meta: { requestId: request.id },
    };
  }
  @Post("projects/:id/rebind")
  @Header("Cache-Control", "no-store")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  async rebind(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: RebindDto,
    @Req() request: FastifyRequest,
  ) {
    return {
      data: await this.access.run("care.rebind", request, async () => {
        const operator = await this.access.authorized(
          request,
          ADMIN_PERMISSIONS.writeCare,
        );
        return this.access.command(request, ADMIN_PERMISSIONS.writeCare, (tx) =>
          this.participation.rebind(
            tx,
            id,
            body,
            idempotencyKey(request),
            operator.adminId!,
            request.id,
          ),
        );
      }),
      meta: { requestId: request.id },
    };
  }
}
