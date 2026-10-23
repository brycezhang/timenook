import {
  Body,
  Controller,
  Get,
  Post,
  Header,
  Param,
  ParseUUIDPipe,
  Req,
  Injectable,
  ConflictException,
  BadRequestException,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiHeader,
  ApiProperty,
  ApiTags,
} from "@nestjs/swagger";
import { IsInt, Min, IsString, MaxLength, MinLength } from "class-validator";
import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { Participation } from "../identity/participation";
import { Stories } from "../stories/stories";
import { Interviews } from "./interviews";
import { ProductionTasks } from "../tasks/tasks";
class ProjectMetadataDto {
  @ApiProperty() @IsInt() @Min(0) expectedVersion!: number;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(120) bookTitle!: string;
}
@Injectable()
export class ProjectOverview {
  constructor(
    private readonly participation: Participation,
    private readonly stories: Stories,
    private readonly interviews: Interviews,
    private readonly tasks: ProductionTasks,
  ) {}
  private async view(
    tx: Prisma.TransactionClient,
    projectId: string,
    actor: {
      subjectId: string;
      subjectDecision: string | null;
      accessExpiresAt: string | null;
    },
  ) {
    const p = await tx.project.findUniqueOrThrow({ where: { id: projectId } }),
      order = await tx.paymentOrder.findUniqueOrThrow({
        where: { id: p.orderId! },
      });
    const stories = await Promise.all(
      (
        await tx.story.findMany({
          where: { projectId },
          orderBy: { createdAt: "desc" },
        })
      ).map((s) => this.stories.view(tx, projectId, s.id)),
    );
    const confirmed = stories.filter((s) => s.decision?.confirmed).length,
      included = stories.filter(
        (s) => s.decision?.confirmed && s.decision.allowInBook,
      ).length,
      pending = stories.filter(
        (s) => s.revision && !s.decision?.confirmed,
      ).length;
    const failed = stories.some(
        (s) =>
          s.task &&
          ["failed", "manual_review", "no_speech", "obsolete"].includes(
            s.task.state,
          ),
      ),
      waiting = stories.some(
        (s) =>
          s.task &&
          [
            "queued",
            "waiting_inputs",
            "submitting",
            "waiting_provider",
          ].includes(s.task.state),
      );
    return {
      projectId,
      bookTitle: p.bookTitle ?? order.bookTitle,
      metadataVersion: p.metadataVersion,
      subjectId: actor.subjectId,
      role: actor.subjectDecision === "self" ? "narrator" : "initiator",
      canDecide: actor.subjectDecision === "self",
      stories,
      tasks: await Promise.all(
        (
          await tx.productionTask.findMany({
            where: { projectId },
            orderBy: { createdAt: "asc" },
          })
        ).map((task) => this.tasks.view(tx, task, false)),
      ),
      interviews: (await this.interviews.listIn(tx, projectId)).interviews,
      summary: { pending, confirmed, included },
      nextStep: failed
        ? "有故事需要恢复或人工协助，原声仍保留"
        : waiting
          ? "正在处理已保存的讲述，可离开后返回"
          : pending
            ? "请本人核对并确认故事，再单独决定是否入书"
            : stories.length
              ? "可继续讲述或查看已确认故事"
              : "从一段讲述开始",
      accessExpiresAt: actor.accessExpiresAt,
    };
  }
  read(projectId: string, authorization?: string) {
    return this.participation.withPlanAccess(
      projectId,
      authorization,
      undefined,
      (tx, actor) => this.view(tx, projectId, actor),
    );
  }
  rename(
    projectId: string,
    body: ProjectMetadataDto,
    authorization?: string,
    key?: string,
  ) {
    if (!key || !/^[-A-Za-z0-9_:]{8,128}$/.test(key) || !body.bookTitle.trim())
      throw new BadRequestException();
    return this.participation.withPlanAccess(
      projectId,
      authorization,
      undefined,
      async (tx, actor) => {
        const requestHash = createHash("sha256")
            .update(JSON.stringify(body))
            .digest("hex"),
          where = { projectId, actorId: actor.userId, key };
        const prior = await tx.projectMetadataCommand.findUnique({
          where: { projectId_actorId_key: where },
        });
        if (prior) {
          if (prior.requestHash !== requestHash) throw new ConflictException();
          return this.view(tx, projectId, actor);
        }
        const updated = await tx.project.updateMany({
          where: { id: projectId, metadataVersion: body.expectedVersion },
          data: {
            bookTitle: body.bookTitle.trim(),
            metadataVersion: { increment: 1 },
          },
        });
        if (updated.count !== 1) throw new ConflictException();
        await tx.projectMetadataCommand.create({
          data: { ...where, requestHash },
        });
        return this.view(tx, projectId, actor);
      },
    );
  }
}
@Controller("v1/projects/:id")
@ApiTags("Life project")
@ApiBearerAuth()
export class ProjectOverviewController {
  constructor(private readonly projects: ProjectOverview) {}
  @Get("overview")
  @Header("Cache-Control", "no-store")
  async overview(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.projects.read(id, req.headers.authorization),
      meta: { requestId: req.id },
    };
  }
  @Post("metadata")
  @Header("Cache-Control", "no-store")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  async metadata(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() body: ProjectMetadataDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.projects.rename(
        id,
        body,
        req.headers.authorization,
        req.headers["idempotency-key"] as string | undefined,
      ),
      meta: { requestId: req.id },
    };
  }
}
