import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  Req,
} from "@nestjs/common";
import { ApiBearerAuth, ApiProperty, ApiTags } from "@nestjs/swagger";
import { IsUUID } from "class-validator";
import type { FastifyRequest } from "fastify";
import { AudioProbe } from "./audio-probe";
class PrintEntryCommandDto {
  @IsUUID() @ApiProperty({ format: "uuid" }) clipId!: string;
}
@Controller("v1/probes/print")
@ApiTags("Non-production print probe")
@ApiBearerAuth("timenook-probe")
export class PrintProbeController {
  constructor(private readonly probe: AudioProbe) {}
  @Post("entries")
  @Header("Cache-Control", "private, no-store")
  async create(
    @Body() command: PrintEntryCommandDto,
    @Req() request: FastifyRequest,
  ) {
    const owner = await this.probe.identity(request.headers.authorization);
    return {
      data: await this.probe.reservePrintEntry(owner, command.clipId),
      meta: { requestId: request.id },
    };
  }
  @Get("entries/:id")
  @Header("Cache-Control", "private, no-store")
  async resolve(@Param("id") id: string, @Req() request: FastifyRequest) {
    const owner = await this.probe.identity(request.headers.authorization);
    return {
      data: await this.probe.resolvePrintEntry(owner, id),
      meta: { requestId: request.id },
    };
  }
}
