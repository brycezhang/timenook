import {
  Body,
  Controller,
  Header,
  Post,
  Req,
  Get,
  Param,
  ParseUUIDPipe,
  HttpCode,
  BadRequestException,
  Res,
} from "@nestjs/common";
import { IsHash, Matches, IsInt, IsUUID, Max, Min } from "class-validator";
import {
  ApiProperty,
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
} from "@nestjs/swagger";
import type { FastifyRequest, FastifyReply } from "fastify";
import type { ProbeClipCommand } from "@timenook/contracts";
import { AudioProbe } from "./audio-probe";
class ClipCommandDto implements ProbeClipCommand {
  @IsUUID() @ApiProperty({ format: "uuid" }) clientClipId!: string;
  @IsInt()
  @Min(1)
  @Max(2097152)
  @ApiProperty({ minimum: 1, maximum: 2097152 })
  bytes!: number;
  @Matches(/^[0-9a-f]{64}$/) @IsHash("sha256") @ApiProperty() sha256!: string;
}
@Controller("v1/probes/audio")
@ApiTags("Non-production audio probe")
export class ProbeController {
  constructor(private readonly probe: AudioProbe) {}
  @ApiBearerAuth("timenook-probe")
  @Post("clips")
  @Header("Cache-Control", "no-store")
  async create(
    @Body() command: ClipCommandDto,
    @Req() request: FastifyRequest,
  ) {
    const ownerId = await this.probe.identity(request.headers.authorization);
    return {
      data: await this.probe.create(ownerId, command),
      meta: { requestId: request.id },
    };
  }
  @ApiBearerAuth("timenook-probe")
  @Get("clips/:id")
  @Header("Cache-Control", "no-store")
  async get(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Req() request: FastifyRequest,
  ) {
    return {
      data: await this.probe.get(
        await this.probe.identity(request.headers.authorization),
        id,
      ),
      meta: { requestId: request.id },
    };
  }
  @ApiBearerAuth("timenook-probe")
  @Post("clips/:id/upload")
  @Header("Cache-Control", "no-store")
  async uploadForm(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Req() request: FastifyRequest,
  ) {
    return {
      data: await this.probe.uploadForm(
        await this.probe.identity(request.headers.authorization),
        id,
        request.headers.authorization!,
      ),
      meta: { requestId: request.id },
    };
  }
  @ApiOperation({
    summary: "Local simulator only: exact-key capability multipart upload",
  })
  @Post("objects")
  @HttpCode(204)
  @Header("Cache-Control", "no-store")
  async upload(@Req() request: FastifyRequest) {
    const fields: Record<string, string> = {};
    let bytes: Buffer | undefined;
    try {
      for await (const part of request.parts()) {
        if (part.type === "file") {
          if (part.fieldname !== "file" || bytes)
            throw new BadRequestException();
          bytes = await part.toBuffer();
        } else {
          if (
            bytes ||
            fields[part.fieldname] !== undefined ||
            typeof part.value !== "string"
          )
            throw new BadRequestException();
          fields[part.fieldname] = part.value;
        }
      }
    } catch {
      throw new BadRequestException();
    }
    if (!bytes) throw new BadRequestException();
    await this.probe.upload(fields, bytes);
  }

  @ApiBearerAuth("timenook-probe")
  @Post("clips/:id/seal")
  @Header("Cache-Control", "no-store")
  async seal(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Req() request: FastifyRequest,
  ) {
    return {
      data: await this.probe.seal(
        await this.probe.identity(request.headers.authorization),
        id,
      ),
      meta: { requestId: request.id },
    };
  }

  @ApiBearerAuth("timenook-probe")
  @Get("clips/:id/content")
  async content(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const bytes = await this.probe.content(
      await this.probe.identity(request.headers.authorization),
      id,
    );
    // Download is bounded and buffered. Recheck access after storage I/O, before any bytes leave.
    await this.probe.identity(request.headers.authorization);
    reply
      .header("Cache-Control", "private, no-store")
      .header("Pragma", "no-cache")
      .header("X-Content-Type-Options", "nosniff")
      .header("Accept-Ranges", "bytes")
      .header("Content-Type", "audio/mpeg")
      .header("Content-Disposition", `attachment; filename="${id}.mp3"`);
    if (!request.headers.range) return reply.send(bytes);
    const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
    let start = 0,
      end = bytes.length - 1;
    if (match?.[1]) {
      start = Number(match[1]);
      if (match[2]) end = Math.min(Number(match[2]), end);
    } else if (match?.[2]) start = Math.max(0, bytes.length - Number(match[2]));
    if (
      !match ||
      (!match[1] && !match[2]) ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start > end ||
      start >= bytes.length
    ) {
      return reply
        .status(416)
        .header("Content-Range", `bytes */${bytes.length}`)
        .send();
    }
    return reply
      .status(206)
      .header("Content-Range", `bytes ${start}-${end}/${bytes.length}`)
      .send(bytes.subarray(start, end + 1));
  }
}
