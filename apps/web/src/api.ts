export interface WebSession {
  user: { id: string };
  session: { id: string; expiresAt: string };
  csrfToken: string;
}
export interface ProjectSummary {
  id: string;
  bookTitle: string | null;
  role: "initiator" | "narrator";
}
export class WebApiError extends Error {
  constructor(readonly status: number) {
    super(
      status === 401
        ? "登录链接无效或已失效，请重新获取。"
        : status === 429
          ? "操作较频繁，请稍后再试。"
          : "服务暂不可用，请稍后重试。",
    );
  }
}
async function request(
  path: string,
  method = "GET",
  data?: unknown,
  csrfToken?: string,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(`/api/v1${path}`, {
      method,
      credentials: "same-origin",
      redirect: "error",
      cache: "no-store",
      signal: controller.signal,
      headers: {
        "X-Timenook-Web": "1",
        ...(data === undefined ? {} : { "Content-Type": "application/json" }),
        ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    if (!response.ok) throw new WebApiError(response.status);
    if (response.status === 204) return undefined;
    const result = await response.json();
    if (!result || result.error || !("data" in result))
      throw new WebApiError(0);
    return result.data;
  } catch (error) {
    throw error instanceof WebApiError ? error : new WebApiError(0);
  } finally {
    clearTimeout(timeout);
  }
}
function session(value: unknown): WebSession {
  const v = value as WebSession | undefined;
  if (
    !v ||
    !/^[0-9a-f-]{36}$/.test(v.user?.id ?? "") ||
    !/^[0-9a-f-]{36}$/.test(v.session?.id ?? "") ||
    !Number.isFinite(Date.parse(v.session?.expiresAt)) ||
    !/^[A-Za-z0-9_-]{43}$/.test(v.csrfToken ?? "")
  )
    throw new WebApiError(0);
  return v;
}
export const webApi = {
  async login(ticket: string) {
    return session(await request("/web/session", "POST", { ticket }));
  },
  async restore() {
    return session(await request("/web/session"));
  },
  async logout(csrfToken: string) {
    await request("/web/session", "DELETE", undefined, csrfToken);
  },
  async projects(): Promise<ProjectSummary[]> {
    const result = (await request("/web/projects")) as
      { projects?: ProjectSummary[] } | undefined;
    if (
      !result ||
      !Array.isArray(result.projects) ||
      result.projects.some(
        (p) =>
          !p ||
          !/^[0-9a-f-]{36}$/.test(p.id) ||
          (p.bookTitle !== null && typeof p.bookTitle !== "string") ||
          !["initiator", "narrator"].includes(p.role),
      )
    )
      throw new WebApiError(0);
    return result.projects;
  },
};
