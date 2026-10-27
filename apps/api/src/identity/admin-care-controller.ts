import { Deletions } from "../care/deletions";
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
import {
  Participation,
  RebindDto,
  CareRequestDto,
  VerifyCareDto,
} from "./participation";
@Controller("v1/admin")
@ApiTags("Administration care")
@ApiCookieAuth("timenook-admin")
export class AdminCareController {
  constructor(
    private readonly access: AdminAccess,
    private readonly participation: Participation,
    private readonly deletions: Deletions,
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
  @Post("projects/:id/care-requests")
  @Header("Cache-Control", "no-store")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  async open(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: CareRequestDto,
    @Req() request: FastifyRequest,
  ) {
    return {
      data: await this.access.run("care.open", request, async () => {
        const actor = await this.access.authorized(
          request,
          ADMIN_PERMISSIONS.writeCare,
        );
        return this.access.command(request, ADMIN_PERMISSIONS.writeCare, (tx) =>
          this.participation.openCareCase(
            tx,
            id,
            body,
            idempotencyKey(request),
            actor.adminId!,
          ),
        );
      }),
      meta: { requestId: request.id },
    };
  }
  @Post("care-requests/:id/verify")
  @Header("Cache-Control", "no-store")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  async verify(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: VerifyCareDto,
    @Req() request: FastifyRequest,
  ) {
    return {
      data: await this.access.run("care.verify", request, async () => {
        const actor = await this.access.authorized(
          request,
          ADMIN_PERMISSIONS.writeCare,
        );
        const result = await this.access.command(
          request,
          ADMIN_PERMISSIONS.writeCare,
          (tx) =>
            this.participation.verifyCare(
              tx,
              id,
              body,
              idempotencyKey(request),
              actor.adminId!,
            ),
        );
        await this.participation.reconcileRevocations();
        if (result.fulfillment === "deletion-ledger")
          await this.deletions.reconcile(await this.deletions.caseProject(id));
        return result;
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
        const result = await this.access.command(
          request,
          ADMIN_PERMISSIONS.writeCare,
          (tx) =>
            this.participation.rebind(
              tx,
              id,
              body,
              idempotencyKey(request),
              operator.adminId!,
              request.id,
            ),
        );
        await this.participation.reconcileRevocations();
        return result;
      }),
      meta: { requestId: request.id },
    };
  }
}
