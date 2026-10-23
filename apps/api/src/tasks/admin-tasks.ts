import {
  Body,
  Controller,
  Get,
  Post,
  Param,
  ParseUUIDPipe,
  Req,
  Header,
  HttpCode,
} from "@nestjs/common";
import { ApiCookieAuth, ApiTags, ApiHeader } from "@nestjs/swagger";
import type { FastifyRequest } from "fastify";
import { ADMIN_PERMISSIONS } from "@timenook/contracts";
import { AdminAccess } from "../admin/admin-access";
import { ProductionTasks } from "./tasks";
class RetryTaskDto {}
@Controller("v1/admin")
@ApiTags("Administration tasks")
@ApiCookieAuth("timenook-admin")
export class AdminTasksController {
  constructor(
    private readonly access: AdminAccess,
    private readonly tasks: ProductionTasks,
  ) {}
  @Get("tasks") @Header("Cache-Control", "no-store") async list(
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.access.run("tasks.list", req, async () => {
        await this.access.authorized(req, ADMIN_PERMISSIONS.readRuntime);
        return this.tasks.adminList();
      }),
      meta: { requestId: req.id },
    };
  }
  @Post("projects/:id/tasks/:taskId/retry")
  @HttpCode(202)
  @Header("Cache-Control", "no-store")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  async retry(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Param("taskId", new ParseUUIDPipe()) taskId: string,
    @Body() _body: RetryTaskDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.access.run("tasks.retry", req, async () => {
        const actor = await this.access.authorized(
          req,
          ADMIN_PERMISSIONS.retryTasks,
        );
        return this.access.command(
          req,
          ADMIN_PERMISSIONS.retryTasks,
          async (tx) => {
            await this.tasks.retryIn(
              tx,
              id,
              taskId,
              actor.adminId!,
              "admin",
              req.headers["idempotency-key"] as string | undefined,
            );
            return this.tasks.adminRead(tx, id, taskId);
          },
        );
      }),
      meta: { requestId: req.id },
    };
  }
}
