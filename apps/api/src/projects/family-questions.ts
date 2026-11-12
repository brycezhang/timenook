import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Header,
  Injectable,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from "@nestjs/common";
import { ApiBearerAuth, ApiProperty, ApiTags } from "@nestjs/swagger";
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from "class-validator";
import type { FastifyRequest } from "fastify";
import type { Prisma } from "@prisma/client";
import type { FamilyQuestion, FamilyQuestions } from "@timenook/contracts";
import { Participation } from "../identity/participation";
import { placeStoryIn, readPlan } from "./project-plans";

class QuestionTextDto {
  @ApiProperty({ maxLength: 2000 }) @IsString() @MaxLength(2000) text!: string;
  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  chapterKey?: string | null;
}
class CreateQuestionDto extends QuestionTextDto {
  @ApiProperty({ format: "uuid" }) @IsUUID() clientQuestionId!: string;
}
class QuestionVersionDto {
  @ApiProperty({ minimum: 1 }) @IsInt() @Min(1) expectedVersion!: number;
}
class EditQuestionDto extends QuestionTextDto {
  @ApiProperty({ minimum: 1 }) @IsInt() @Min(1) expectedVersion!: number;
}
class QuestionStateDto extends QuestionVersionDto {
  @ApiProperty({ enum: ["ready", "later", "skipped"] })
  @IsIn(["ready", "later", "skipped"])
  state!: FamilyQuestion["state"];
}

import { familyAnswersIn } from "./family-question-answers";

@Injectable()
export class FamilyQuestionService {
  constructor(private readonly participation: Participation) {}
  private access<T>(
    projectId: string,
    authorization: string | undefined,
    work: (tx: Prisma.TransactionClient, userId: string) => Promise<T>,
  ) {
    return this.participation.withPlanAccess(
      projectId,
      authorization,
      undefined,
      async (tx, actor) => {
        await this.participation.requireMaterialIn(tx, projectId, "activeData");
        return work(tx, actor.userId);
      },
    );
  }
  private async view(
    tx: Prisma.TransactionClient,
    projectId: string,
    id: string,
  ): Promise<FamilyQuestion> {
    const row = await tx.familyQuestion.findFirst({
      where: { id, projectId, removed: false },
    });
    if (!row) throw new NotFoundException("问题已移除");
    const [plan, answers] = await Promise.all([
      readPlan(tx, projectId),
      familyAnswersIn(tx, projectId),
    ]);
    const answer = answers.find((a) => a.questionId === id);
    const canReadStory = await this.participation.materialAvailableIn(
      tx,
      projectId,
      "confirmedStories",
    );
    const story =
      answer && canReadStory
        ? await tx.storyRevision.findUniqueOrThrow({
            where: { id: answer.revisionId },
            select: { title: true },
          })
        : null;
    return {
      id,
      projectId,
      version: row.version,
      text: row.text!,
      authorId: row.authorId!,
      authorNickname: row.authorNickname!,
      authorRelationship: row.authorRelationship!,
      state: row.state as FamilyQuestion["state"],
      chapterKey: answer
        ? (plan.chapters.find((c) => c.storyRefs.includes(answer.storyId))
            ?.key ?? null)
        : (plan.chapters.find((c) => c.key === row.chapterKey)?.key ?? null),
      createdAt: row.createdAt.toISOString(),
      story: answer
        ? { id: answer.storyId, title: story?.title ?? "故事" }
        : null,
    };
  }
  async list(
    projectId: string,
    authorization?: string,
  ): Promise<FamilyQuestions> {
    return this.access(projectId, authorization, async (tx) => ({
      projectId,
      questions: await Promise.all(
        (
          await tx.familyQuestion.findMany({
            where: { projectId, removed: false },
            orderBy: { createdAt: "desc" },
          })
        ).map((q) => this.view(tx, projectId, q.id)),
      ),
    }));
  }
  async read(projectId: string, id: string, authorization?: string) {
    return this.access(projectId, authorization, (tx) =>
      this.view(tx, projectId, id),
    );
  }
  private async content(
    tx: Prisma.TransactionClient,
    projectId: string,
    body: QuestionTextDto,
  ) {
    const text = body.text.trim();
    if (!text) throw new BadRequestException("请填写问题");
    const chapterKey = body.chapterKey || null;
    if (
      chapterKey &&
      !(await readPlan(tx, projectId)).chapters.some(
        (c) => c.key === chapterKey,
      )
    )
      throw new BadRequestException("章节已移除，请重新选择");
    return { text, chapterKey };
  }
  async create(
    projectId: string,
    body: CreateQuestionDto,
    authorization?: string,
  ) {
    return this.access(projectId, authorization, async (tx, userId) => {
      await tx.$queryRaw`SELECT id FROM projects WHERE id=${projectId}::uuid FOR UPDATE`;
      const content = await this.content(tx, projectId, body);
      const prior = await tx.familyQuestion.findUnique({
        where: { id: body.clientQuestionId },
      });
      if (prior) {
        if (
          prior.removed ||
          prior.projectId !== projectId ||
          prior.authorId !== userId ||
          prior.text !== content.text ||
          prior.chapterKey !== content.chapterKey
        )
          throw new ConflictException();
        return this.view(tx, projectId, prior.id);
      }
      const [member, subject, user] = await Promise.all([
        tx.projectMember.findUnique({
          where: { projectId_userId: { projectId, userId } },
        }),
        tx.projectSubject.findUniqueOrThrow({ where: { projectId } }),
        tx.user.findUniqueOrThrow({ where: { id: userId } }),
      ]);
      const relationship =
        subject.boundUserId === userId ? "本人" : member?.relationship;
      if (!relationship)
        throw new BadRequestException("请先填写你是主讲人的谁");
      await tx.familyQuestion.create({
        data: {
          id: body.clientQuestionId,
          projectId,
          ...content,
          authorId: userId,
          authorNickname: user.nickname ?? "家人",
          authorRelationship: relationship,
        },
      });
      return this.view(tx, projectId, body.clientQuestionId);
    });
  }
  async edit(
    projectId: string,
    id: string,
    body: EditQuestionDto,
    authorization?: string,
  ) {
    return this.access(projectId, authorization, async (tx, userId) => {
      await tx.$queryRaw`SELECT id FROM projects WHERE id=${projectId}::uuid FOR UPDATE`;
      const prior = await this.view(tx, projectId, id);
      const content = await this.content(tx, projectId, body);
      const changed = await tx.familyQuestion.updateMany({
        where: { id, projectId, removed: false, version: body.expectedVersion },
        data: { ...content, version: { increment: 1 } },
      });
      if (!changed.count) throw new ConflictException("问题已更新，请重新打开");
      if (prior.chapterKey !== content.chapterKey) {
        for (const answer of await familyAnswersIn(tx, projectId))
          if (answer.questionId === id && answer.included)
            await placeStoryIn(
              tx,
              projectId,
              answer.storyId,
              content.chapterKey,
              userId,
            );
      }
      return this.view(tx, projectId, id);
    });
  }
  async state(
    projectId: string,
    id: string,
    body: QuestionStateDto,
    authorization?: string,
  ) {
    return this.access(projectId, authorization, async (tx) => {
      const changed = await tx.familyQuestion.updateMany({
        where: { id, projectId, removed: false, version: body.expectedVersion },
        data: { state: body.state, version: { increment: 1 } },
      });
      if (!changed.count) throw new ConflictException("问题已更新，请重新打开");
      return this.view(tx, projectId, id);
    });
  }
  async remove(
    projectId: string,
    id: string,
    body: QuestionVersionDto,
    authorization?: string,
  ) {
    return this.access(projectId, authorization, async (tx) => {
      const changed = await tx.familyQuestion.updateMany({
        where: { id, projectId, removed: false, version: body.expectedVersion },
        data: { removed: true, version: { increment: 1 } },
      });
      if (!changed.count) throw new ConflictException("问题已更新，请重新打开");
      return { removed: true };
    });
  }
}

@ApiTags("family-questions")
@ApiBearerAuth()
@Controller("v1/projects/:projectId/family-questions")
export class FamilyQuestionsController {
  constructor(private readonly questions: FamilyQuestionService) {}
  @Get() @Header("Cache-Control", "no-store") async list(
    @Param("projectId", ParseUUIDPipe) project: string,
    @Req() req: FastifyRequest,
  ) {
    return {
      meta: { requestId: req.id },
      data: await this.questions.list(project, req.headers.authorization),
    };
  }
  @Post() async create(
    @Param("projectId", ParseUUIDPipe) project: string,
    @Body() body: CreateQuestionDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      meta: { requestId: req.id },
      data: await this.questions.create(
        project,
        body,
        req.headers.authorization,
      ),
    };
  }
  @Get(":id") @Header("Cache-Control", "no-store") async read(
    @Param("projectId", ParseUUIDPipe) project: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: FastifyRequest,
  ) {
    return {
      meta: { requestId: req.id },
      data: await this.questions.read(project, id, req.headers.authorization),
    };
  }
  @Post(":id") async edit(
    @Param("projectId", ParseUUIDPipe) project: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: EditQuestionDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      meta: { requestId: req.id },
      data: await this.questions.edit(
        project,
        id,
        body,
        req.headers.authorization,
      ),
    };
  }
  @Post(":id/state") async state(
    @Param("projectId", ParseUUIDPipe) project: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: QuestionStateDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      meta: { requestId: req.id },
      data: await this.questions.state(
        project,
        id,
        body,
        req.headers.authorization,
      ),
    };
  }
  @Post(":id/remove") async remove(
    @Param("projectId", ParseUUIDPipe) project: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: QuestionVersionDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      meta: { requestId: req.id },
      data: await this.questions.remove(
        project,
        id,
        body,
        req.headers.authorization,
      ),
    };
  }
}
