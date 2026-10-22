import { ApiProperty } from "@nestjs/swagger";
import type {
  ApiErrorResponse,
  ApiResponse,
  HealthStatus,
} from "@timenook/contracts";

export class RequestMetaDto {
  @ApiProperty({ format: "uuid" })
  requestId!: string;
}

class HealthDto implements HealthStatus {
  @ApiProperty({ enum: ["ok", "ready"] })
  status!: HealthStatus["status"];
  @ApiProperty({ enum: ["timenook-api"] })
  service!: "timenook-api";
  @ApiProperty({ example: "0.1.0" })
  version!: string;
}

export class HealthResponseDto implements ApiResponse<HealthStatus> {
  @ApiProperty({ type: HealthDto })
  data!: HealthDto;
  @ApiProperty({ type: RequestMetaDto })
  meta!: RequestMetaDto;
}

type ErrorDetails = ApiErrorResponse["error"];

class ErrorDto implements ErrorDetails {
  @ApiProperty({ example: "SERVICE_UNAVAILABLE" })
  code!: string;
  @ApiProperty({ example: "Service is not ready" })
  message!: string;
  @ApiProperty({ example: true })
  retryable!: boolean;
}

export class ErrorResponseDto implements ApiErrorResponse {
  @ApiProperty({ type: ErrorDto })
  error!: ErrorDto;
  @ApiProperty({ type: RequestMetaDto })
  meta!: RequestMetaDto;
}
