import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from "@nestjs/common";
import { IsISO8601, IsIn, IsUUID, Matches } from "class-validator";
import { ApiBearerAuth, ApiProperty, ApiTags } from "@nestjs/swagger";
import type { FastifyRequest } from "fastify";
import { AudioProbe } from "./audio-probe";
import { AiProbe, AiRunCommand } from "./ai-probe";
class AiRunDto implements AiRunCommand {
  @IsUUID() @ApiProperty({ format: "uuid" }) requestId!: string;
  @IsUUID() @ApiProperty({ format: "uuid" }) clipId!: string;
  @Matches(/^[A-Za-z0-9._-]{1,80}$/) @ApiProperty() inputVersion!: string;
  @IsIn(["synthetic", "authorized-sample"])
  @ApiProperty({ enum: ["synthetic", "authorized-sample"] })
  sampleKind!: string;
  @IsISO8601({ strict: true })
  @ApiProperty({
    format: "date-time",
    description:
      "Caller-declared recording stop time; not verified device telemetry",
  })
  stoppedAt!: string;
}
class GenerationDto {
  @IsUUID() @ApiProperty({ format: "uuid" }) requestId!: string;
  @IsIn(["question", "story"])
  @ApiProperty({ enum: ["question", "story"] })
  kind!: "question" | "story";
}
@Controller("v1/probes/ai")
@ApiTags("Non-production AI probe")
@ApiBearerAuth("timenook-probe")
export class AiProbeController {
  constructor(
    private readonly probe: AiProbe,
    private readonly audio: AudioProbe,
  ) {}
  @Get("metrics")
  @Header("Cache-Control", "no-store")
  async metrics(@Req() request: FastifyRequest) {
    return {
      data: await this.probe.metrics(
        await this.audio.identity(request.headers.authorization),
      ),
      meta: { requestId: request.id },
    };
  }
  @Post("runs")
  @Header("Cache-Control", "no-store")
  async create(@Body() command: AiRunDto, @Req() request: FastifyRequest) {
    return {
      data: await this.probe.create(
        await this.audio.identity(request.headers.authorization),
        command,
      ),
      meta: { requestId: request.id },
    };
  }
  @Post("runs/:id/advance")
  @Header("Cache-Control", "no-store")
  async advance(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Req() request: FastifyRequest,
  ) {
    return {
      data: await this.probe.advance(
        await this.audio.identity(request.headers.authorization),
        id,
        request.headers.authorization!,
      ),
      meta: { requestId: request.id },
    };
  }
  @Post("runs/:id/invalidate")
  @Header("Cache-Control", "no-store")
  async invalidate(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Req() request: FastifyRequest,
  ) {
    return {
      data: await this.probe.invalidate(
        await this.audio.identity(request.headers.authorization),
        id,
      ),
      meta: { requestId: request.id },
    };
  }
  @Post("runs/:id/generations")
  @Header("Cache-Control", "no-store")
  async generate(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() command: GenerationDto,
    @Req() request: FastifyRequest,
  ) {
    return {
      data: await this.probe.generate(
        await this.audio.identity(request.headers.authorization),
        id,
        request.headers.authorization!,
        command,
      ),
      meta: { requestId: request.id },
    };
  }
  @Get("runs/:id")
  @Header("Cache-Control", "no-store")
  async get(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Req() request: FastifyRequest,
  ) {
    return {
      data: await this.probe.get(
        await this.audio.identity(request.headers.authorization),
        id,
      ),
      meta: { requestId: request.id },
    };
  }
}
