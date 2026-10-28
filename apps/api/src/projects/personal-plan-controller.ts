import {
  Body,
  Controller,
  Get,
  Header,
  Injectable,
  Inject,
  OnModuleDestroy,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  BadRequestException,
  ConflictException,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiProperty,
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiOkResponse,
  ApiCreatedResponse,
} from "@nestjs/swagger";
import {
  IsInt,
  Min,
  Max,
  IsObject,
  IsArray,
  IsOptional,
  IsUUID,
  ArrayMaxSize,
  IsString,
  MaxLength,
} from "class-validator";
import type { FastifyRequest } from "fastify";
import type {
  PlanContent,
  PlanQuestionState,
  PersonalPlan,
} from "@timenook/contracts";
import { ErrorResponseDto } from "../health-contract";
import { API_CONFIG, ApiConfig } from "../config";
import { Participation } from "../identity/participation";
import { ProjectPlans, ProjectPlanError } from "./project-plans";

class RevisePlanDto {
  @ApiProperty({ minimum: 1 })
  @IsInt()
  @Min(1)
  @Max(2147483646)
  expectedVersion!: number;
  @ApiProperty({
    type: Object,
    description:
      "Complete chapters and starters; IDs, authors and preferences are server-owned",
  })
  @IsObject()
  content!: PlanContent;
}

class PreferencesDto {
  @ApiProperty({ minimum: 1 })
  @IsInt()
  @Min(1)
  @Max(2147483646)
  expectedVersion!: number;
  @ApiProperty({ type: [String], maxItems: 200 })
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  blockedTopics!: string[];
  @ApiProperty({ type: [Object], maxItems: 500 })
  @IsArray()
  @ArrayMaxSize(500)
  questionStates!: PlanQuestionState[];
  @ApiProperty({ format: "uuid", required: false })
  @IsOptional()
  @IsUUID()
  assistedSessionId?: string;
}

@Injectable()
export class PersonalPlans implements OnModuleDestroy {
  private readonly plans: ProjectPlans;
  constructor(
    @Inject(API_CONFIG) config: ApiConfig,
    private readonly participation: Participation,
  ) {
    this.plans = new ProjectPlans(config.databaseUrl);
  }
  private withActivePlanAccess<T>(
    projectId: string,
    authorization: string | undefined,
    decision: Parameters<Participation["withPlanAccess"]>[2],
    work: (
      tx: import("@prisma/client").Prisma.TransactionClient,
      actor: Parameters<Parameters<Participation["withPlanAccess"]>[3]>[1],
    ) => Promise<T>,
  ): Promise<T> {
    return this.participation.withPlanAccess(
      projectId,
      authorization,
      decision,
      async (tx, actor) => {
        await this.participation.requireMaterialIn(tx, projectId, "activeData");
        return work(tx, actor);
      },
    );
  }
  async read(projectId: string, authorization?: string): Promise<PersonalPlan> {
    return this.withActivePlanAccess(
      projectId,
      authorization,
      undefined,
      async (tx, actor) => ({
        ...(await this.plans.getProjectPlan(projectId, tx)),
        ...(await this.plans.readPersonalState(projectId, tx)),
        accessExpiresAt: actor.accessExpiresAt,
        subjectDecision: actor.subjectDecision,
        decisionSessionId: actor.decisionSessionId,
      }),
    );
  }
  async revise(
    projectId: string,
    body: RevisePlanDto,
    authorization?: string,
  ): Promise<PersonalPlan> {
    try {
      return await this.withActivePlanAccess(
        projectId,
        authorization,
        undefined,
        async (tx, actor) => ({
          ...(await this.plans.revisePlan(
            {
              projectId,
              expectedVersion: body.expectedVersion,
              content: body.content,
              createdBy: actor.userId,
            },
            tx,
          )),
          ...(await this.plans.readPersonalState(projectId, tx)),
          accessExpiresAt: actor.accessExpiresAt,
          subjectDecision: actor.subjectDecision,
          decisionSessionId: actor.decisionSessionId,
        }),
      );
    } catch (error) {
      if (error instanceof ProjectPlanError) {
        if (error.code === "VERSION_CONFLICT") throw new ConflictException();
        throw new BadRequestException();
      }
      throw error;
    }
  }
  async preferences(
    projectId: string,
    body: PreferencesDto,
    authorization?: string,
  ) {
    try {
      return await this.withActivePlanAccess(
        projectId,
        authorization,
        { assistedSessionId: body.assistedSessionId },
        async (tx, actor) => {
          if (actor.method === "participant")
            throw new Error("Subject decision required");
          await this.plans.decidePreferences(
            {
              ...body,
              projectId,
              subjectId: actor.subjectId,
              operatorUserId: actor.userId,
              method: actor.method,
              assistedSessionId: actor.assistedSessionId,
            },
            tx,
          );
          return {
            ...(await this.plans.getProjectPlan(projectId, tx)),
            ...(await this.plans.readPersonalState(projectId, tx)),
            accessExpiresAt: actor.accessExpiresAt,
            subjectDecision: actor.subjectDecision,
            decisionSessionId: actor.decisionSessionId,
          };
        },
      );
    } catch (error) {
      if (error instanceof ProjectPlanError) {
        if (error.code === "VERSION_CONFLICT") throw new ConflictException();
        throw new BadRequestException();
      }
      throw error;
    }
  }
  async onModuleDestroy() {
    await this.plans.close();
  }
}

@Controller("v1/projects/:id/plan")
@ApiTags("Personal plan")
@ApiBearerAuth()
@ApiResponse({ status: 400, type: ErrorResponseDto })
@ApiResponse({ status: 401, type: ErrorResponseDto })
@ApiResponse({ status: 403, type: ErrorResponseDto })
@ApiResponse({ status: 409, type: ErrorResponseDto })
@ApiResponse({ status: 503, type: ErrorResponseDto })
export class PersonalPlanController {
  constructor(private readonly plans: PersonalPlans) {}
  @Get()
  @ApiOperation({
    summary:
      "Read the currently authorized personal plan, preferences and actual-question history",
  })
  @ApiOkResponse({
    description:
      "Current personal plan; independent preference version and access expiry are included",
  })
  @Header("Cache-Control", "no-store")
  async read(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.plans.read(id, req.headers.authorization),
      meta: { requestId: req.id },
    };
  }
  @Post()
  @ApiOperation({
    summary:
      "Atomically append a future plan revision; subject preferences and actual questions remain separate",
  })
  @ApiCreatedResponse({
    description: "New plan revision; stale expectedVersion returns 409",
  })
  @Header("Cache-Control", "no-store")
  async revise(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() body: RevisePlanDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.plans.revise(id, body, req.headers.authorization),
      meta: { requestId: req.id },
    };
  }
  @Post("preferences")
  @ApiOperation({
    summary:
      "Record an explicit subject decision using self identity or latest active assisted collection evidence",
  })
  @ApiCreatedResponse({
    description:
      "New preference version and immutable subject/operator evidence history",
  })
  @Header("Cache-Control", "no-store")
  async preferences(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() body: PreferencesDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.plans.preferences(id, body, req.headers.authorization),
      meta: { requestId: req.id },
    };
  }
}
