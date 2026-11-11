import { USER_TERMS_VERSION } from "../../../packages/contracts/src/index";
export { USER_TERMS_VERSION };
export interface WebSession {
  user: { id: string; nickname: string | null };
  session: { id: string; expiresAt: string };
  csrfToken: string;
}
export type { ProjectMembership as ProjectSummary } from "../../../packages/contracts/src/index";
import type { ProjectMembership as ProjectSummary } from "../../../packages/contracts/src/index";
export interface SmsChallenge {
  challengeId: string;
  expiresInSeconds: number;
  retryAfterSeconds: number;
}
export class WebApiError extends Error {
  constructor(
    readonly status: number,
    message?: string,
  ) {
    super(
      message ??
        (status === 401
          ? "验证码无效、已过期或登录已失效，请重试。"
          : status === 429
            ? "操作较频繁，请稍后再试。"
            : status === 409
              ? "账号归属需要核实，请通过小程序联系客服。"
              : status === 400
                ? "请检查手机号、验证码并同意使用条款。"
                : "服务暂不可用，请稍后重试。"),
    );
  }
}
export async function request<T>(
  path: string,
  init: {
    method?: string;
    data?: unknown;
    csrf?: string;
    idempotencyKey?: string;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    method: init.method ?? "GET",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.any([
      ...(init.signal ? [init.signal] : []),
      AbortSignal.timeout(15000),
    ]),
    headers: {
      "X-Timenook-Web": "1",
      ...(init.data === undefined
        ? {}
        : { "Content-Type": "application/json" }),
      ...(init.idempotencyKey
        ? { "Idempotency-Key": init.idempotencyKey }
        : {}),
      ...(init.csrf ? { "X-CSRF-Token": init.csrf } : {}),
    },
    ...(init.data === undefined ? {} : { body: JSON.stringify(init.data) }),
  }).catch(() => {
    throw new WebApiError(0);
  });
  if (!response.ok) throw new WebApiError(response.status);
  if (response.status === 204) return undefined as T;
  const body = await response.json();
  if (!body || !("data" in body) || body.error) throw new WebApiError(0);
  return body.data as T;
}
export const webApi = {
  sendCode: (phone: string) =>
    request<SmsChallenge>("/web/sms-codes", {
      method: "POST",
      data: { phone, termsVersion: USER_TERMS_VERSION },
    }),
  login: (challengeId: string, code: string) =>
    request<WebSession>("/web/session", {
      method: "POST",
      data: { challengeId, code, termsVersion: USER_TERMS_VERSION },
    }),
  restore: () => request<WebSession>("/web/session"),
  logout: (csrf: string) =>
    request<void>("/web/session", { method: "DELETE", csrf }),
  projects: (signal?: AbortSignal) =>
    request<{ projects: ProjectSummary[] }>("/participations", { signal }),
};
