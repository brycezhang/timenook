import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ApiErrorResponse } from "@timenook/contracts";

const errors: Record<number, ApiErrorResponse["error"]> = {
  400: {
    code: "INVALID_REQUEST",
    message: "Invalid request",
    retryable: false,
  },
  401: {
    code: "UNAUTHENTICATED",
    message: "Authentication required",
    retryable: false,
  },
  403: { code: "FORBIDDEN", message: "Access denied", retryable: false },
  404: { code: "NOT_FOUND", message: "Resource not found", retryable: false },
  409: {
    code: "CONFLICT",
    message: "State or command conflict",
    retryable: false,
  },
  422: {
    code: "INVALID_MEDIA",
    message: "Media validation or sealing failed",
    retryable: true,
  },
  413: {
    code: "PAYLOAD_TOO_LARGE",
    message: "Request payload is too large",
    retryable: false,
  },
  429: { code: "RATE_LIMITED", message: "Too many requests", retryable: true },
  502: {
    code: "UPSTREAM_UNAVAILABLE",
    message: "Identity provider is unavailable",
    retryable: true,
  },
  503: {
    code: "SERVICE_UNAVAILABLE",
    message: "Service is not ready",
    retryable: true,
  },
};

export function errorResponse(
  status: number,
  requestId: string,
): ApiErrorResponse {
  return {
    error: errors[status] ?? {
      code: "INTERNAL_ERROR",
      message: "Internal server error",
      retryable: false,
    },
    meta: { requestId },
  };
}

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const status = error instanceof HttpException ? error.getStatus() : 500;
    reply.status(status).send(errorResponse(status, request.id));
  }
}
