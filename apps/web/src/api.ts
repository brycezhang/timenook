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
        : status === 409
          ? "关联已失效、核对码不符或微信身份已有其他账号；请重新发起，不会自动合并账号。"
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
async function mutateSession<T>(action: () => Promise<T>): Promise<T> {
  if (!navigator.locks)
    return Promise.reject(new Error("请更新浏览器后再打开登录链接。"));
  // Set-Cookie is applied by the browser before JavaScript can ignore a stale
  // response. Keep exchanges and logout ordered across this origin's tabs.
  return await navigator.locks.request("timenook-web-session", action);
}
const pageInstance = crypto.randomUUID();
function notifySessionChange() {
  try {
    const channel = new BroadcastChannel("timenook-web-session");
    channel.postMessage({ source: pageInstance });
    channel.close();
  } catch {
    /* Each protected operation also rechecks the server session. */
  }
}
export function onWebSessionChange(listener: () => void): () => void {
  try {
    const channel = new BroadcastChannel("timenook-web-session");
    channel.onmessage = (event) => {
      if (event.data?.source !== pageInstance) listener();
    };
    return () => channel.close();
  } catch {
    return () => {};
  }
}
export async function withWebSession<T>(
  expected: WebSession,
  action: (headers: Record<string, string>) => Promise<T>,
): Promise<T> {
  return mutateSession(async () => {
    const current = session(await request("/web/session"));
    if (
      current.user.id !== expected.user.id ||
      current.session.id !== expected.session.id ||
      current.csrfToken !== expected.csrfToken
    )
      throw new WebApiError(401);
    return action({
      "X-Timenook-Web": "1",
      "X-CSRF-Token": current.csrfToken,
    });
  });
}
export const webApi = {
  async experience(): Promise<boolean> {
    const result = (await request("/web/experience")) as {
      mockEnabled?: boolean;
    };
    return result?.mockEnabled === true;
  },
  async mockLogin() {
    return mutateSession(async () => {
      const result = session(await request("/web/mock-session", "POST", {}));
      notifySessionChange();
      return result;
    });
  },
  async mockPurchase(
    expected: WebSession,
    input: { purchaseKey: string; bookTitle: string; subjectName: string },
  ) {
    return withWebSession(expected, async () => {
      const result = (await request(
        "/web/mock-purchases",
        "POST",
        input,
        expected.csrfToken,
      )) as { projectId?: string };
      if (!/^[0-9a-f-]{36}$/.test(result?.projectId ?? ""))
        throw new WebApiError(0);
      return result as { projectId: string };
    });
  },
  async linkAvailability(): Promise<boolean> {
    const result = (await request("/web/wechat-link")) as {
      available?: boolean;
    };
    if (typeof result?.available !== "boolean") throw new WebApiError(0);
    return result.available;
  },
  async createLink(csrf: string): Promise<AccountLinkCreated> {
    const result = await request("/web/wechat-link", "POST", {}, csrf);
    if (
      !isAccountLinkResult(result) ||
      !/^\d{8}$/.test((result as AccountLinkCreated).challenge.code)
    )
      throw new WebApiError(0);
    return result as AccountLinkCreated;
  },
  async link(
    id: string,
    action = "status",
    csrf?: string,
    verificationCode?: string,
  ): Promise<AccountLinkResult> {
    const result = await request(
      `/web/wechat-link/${id}${action === "confirm" ? "/confirm" : ""}`,
      action === "status" ? "GET" : action === "cancel" ? "DELETE" : "POST",
      action === "confirm" ? { verificationCode } : undefined,
      csrf,
    );
    if (!isAccountLinkResult(result)) throw new WebApiError(0);
    return result;
  },
  async login(ticket: string) {
    const result = await mutateSession(async () =>
      session(await request("/web/session", "POST", { ticket })),
    );
    notifySessionChange();
    return result;
  },
  async restore() {
    return session(await request("/web/session"));
  },
  async logout(csrfToken: string) {
    await mutateSession(async () => {
      try {
        const current = session(await request("/web/session"));
        // A different tab may have replaced this page's account. Its session
        // must remain signed in; clear this stale view without revoking it.
        if (current.csrfToken !== csrfToken) return;
        await request("/web/session", "DELETE", undefined, csrfToken);
        notifySessionChange();
      } catch (error) {
        if (!(error instanceof WebApiError && error.status === 401))
          throw error;
      }
    });
  },
  async projects(expected: WebSession): Promise<ProjectSummary[]> {
    const result = (await withWebSession(expected, () =>
      request("/web/projects"),
    )) as { projects?: ProjectSummary[] } | undefined;
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
import type {
  AccountLinkCreated,
  AccountLinkResult,
} from "../../../packages/contracts/src/account-link";
import { isAccountLinkResult } from "../../../packages/contracts/src/account-link";
