export interface ApiResponse<T> {
  data: T;
  meta: { requestId: string };
}

export interface ApiErrorResponse {
  error: { code: string; message: string; retryable: boolean };
  meta: { requestId: string };
}

export interface HealthStatus {
  status: "ok" | "ready";
  service: "timenook-api";
  version: string;
}
