import type {
  Account,
  ApiErrorResponse,
  ApiResponse,
  LoginResult,
} from "../../packages/contracts/src";
import { dataMode, setDataMode } from "./mode";
import { API_BASE_URL } from "../config";

export class ApiFailure extends Error {
  constructor(
    readonly code: string,
    readonly status = 0,
    readonly requestId?: string,
  ) {
    super(
      code === "UNAUTHENTICATED"
        ? "登录已失效，请重新登录"
        : code === "NOT_CONFIGURED"
          ? "真实服务尚未配置"
          : "服务暂不可用，请稍后重试",
    );
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function account(value: unknown): value is Account {
  return (
    record(value) &&
    typeof value.id === "string" &&
    /^[0-9a-f-]{36}$/.test(value.id)
  );
}
function loginResult(value: unknown): value is LoginResult {
  if (!record(value) || !account(value.user) || !record(value.session))
    return false;
  const session = value.session;
  return (
    typeof session.id === "string" &&
    /^[0-9a-f-]{36}$/.test(session.id) &&
    typeof session.token === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(session.token) &&
    typeof session.expiresAt === "string" &&
    Number.isFinite(Date.parse(session.expiresAt))
  );
}

export class SessionClient {
  private generation = 0;
  private invalidatedToken: string | null = null;
  private cleanupPending = false;
  private readonly invalidationListeners = new Set<(context: string) => void>();
  constructor(private readonly apiBaseUrl: string) {}
  onInvalidated(listener: (context: string) => void): () => void {
    this.invalidationListeners.add(listener);
    return () => {
      this.invalidationListeners.delete(listener);
    };
  }
  sessionCleanupPending(): boolean {
    return this.cleanupPending;
  }
  context(): string {
    const stored = this.stored();
    return dataMode() === "live" && stored
      ? `${stored.user.id}:${stored.session.id}`
      : "";
  }
  async restore(): Promise<Account | null> {
    if (dataMode() !== "live") return null;
    const stored = this.stored();
    if (!stored) return null;
    const result = await this.request<Account>("/users/me");
    if (!account(result) || result.id !== stored.user.id)
      throw new ApiFailure("INVALID_RESPONSE");
    return result;
  }
  async logout(): Promise<void> {
    this.generation++;
    const stored = this.stored();
    wx.removeStorageSync(this.storageKey);
    this.cleanupPending = false;
    if (stored) {
      try {
        await this.send<void>(
          `/sessions/${stored.session.id}`,
          "DELETE",
          undefined,
          stored.session.token,
        );
      } catch (error) {
        if (!(error instanceof ApiFailure && error.status === 401)) throw error;
      }
    }
  }
  async enterDemo(): Promise<void> {
    try {
      await this.logout();
    } finally {
      setDataMode("demo");
    }
  }
  async request<T>(
    path: string,
    command?: { data: Record<string, unknown>; key: string },
  ): Promise<T> {
    if (dataMode() !== "live") throw new ApiFailure("DEMO_MODE");
    const generation = this.generation;
    const stored = this.stored();
    if (!stored) throw new ApiFailure("UNAUTHENTICATED", 401);
    try {
      const result = await this.send<T>(
        path,
        command ? "POST" : "GET",
        command?.data,
        stored.session.token,
        command?.key,
      );
      this.assertCurrent(generation);
      if (this.stored()?.session.token !== stored.session.token)
        throw new ApiFailure("STALE_RESPONSE");
      return result;
    } catch (error) {
      if (
        error instanceof ApiFailure &&
        error.status === 401 &&
        generation === this.generation &&
        this.persisted()?.session.token === stored.session.token
      )
        this.invalidate(stored);
      throw error;
    } finally {
      try {
        if (
          generation === this.generation &&
          dataMode() === "live" &&
          this.invalidatedToken !== stored.session.token &&
          Date.parse(stored.session.expiresAt) <= Date.now() &&
          this.persisted()?.session.token === stored.session.token
        )
          this.invalidate(stored);
      } catch {
        // A device cleanup lookup must not replace the request's result or error.
      }
    }
  }

  async downloadPhoto(
    projectId: string,
    interviewId: string,
    photoId: string,
    assetId: string,
  ) {
    if (
      ![projectId, interviewId, photoId, assetId].every((id) =>
        /^[a-f0-9-]{36}$/.test(id),
      )
    )
      throw new ApiFailure("INVALID_RESPONSE");
    return this.downloadContent(
      `/projects/${projectId}/interviews/${interviewId}/photos/${photoId}/assets/${assetId}/content`,
    );
  }
  async downloadRecording(
    projectId: string,
    interviewId: string,
    intentId: string,
  ) {
    if (
      ![projectId, interviewId, intentId].every((id) =>
        /^[a-f0-9-]{36}$/.test(id),
      )
    )
      throw new ApiFailure("INVALID_RESPONSE");
    return this.downloadContent(
      `/projects/${projectId}/interviews/${interviewId}/clips/${intentId}/content`,
    );
  }
  async downloadBook(projectId: string, versionId: string) {
    if (![projectId, versionId].every((id) => /^[a-f0-9-]{36}$/.test(id)))
      throw new ApiFailure("INVALID_RESPONSE");
    return this.downloadContent(
      `/projects/${projectId}/book/versions/${versionId}/pdf`,
    );
  }
  private async downloadContent(path: string) {
    const generation = this.generation,
      stored = this.stored();
    if (dataMode() !== "live" || !stored)
      throw new ApiFailure("UNAUTHENTICATED", 401);
    this.checkBaseUrl();
    return new Promise<WechatMiniprogram.DownloadFileSuccessCallbackResult>(
      (resolve, reject) =>
        wx.downloadFile({
          url: this.apiBaseUrl + path,
          header: { authorization: `Bearer ${stored.session.token}` },
          timeout: 15000,
          success: (result) => {
            if (
              result.statusCode === 401 &&
              generation === this.generation &&
              dataMode() === "live" &&
              this.persisted()?.session.token === stored.session.token
            )
              this.invalidate(stored);
            // The media owner still needs this path to remove denied or stale bytes.
            resolve(result);
          },
          fail: () => reject(new ApiFailure("NETWORK_ERROR")),
        }),
    );
  }
  async uploadPhoto(
    form: import("../../packages/contracts/src/audio-probe").ProbeUploadForm,
    filePath: string,
  ) {
    return this.uploadRecording(form, filePath, "photos");
  }
  async uploadRecording(
    form: import("../../packages/contracts/src/audio-probe").ProbeUploadForm,
    filePath: string,
    kind: "recordings" | "photos" = "recordings",
  ): Promise<void> {
    const generation = this.generation,
      stored = this.stored();
    if (dataMode() !== "live" || !stored)
      throw new ApiFailure("UNAUTHENTICATED", 401);
    this.checkBaseUrl();
    const local =
      form.storage === "local-simulator" && form.url === `/v1/${kind}/objects`;
    const oss =
      form.storage === "oss" &&
      /^https:\/\/[a-z0-9-]+\.oss-[a-z0-9-]+\.aliyuncs\.com$/.test(form.url);
    if (
      (!local && !oss) ||
      !Number.isFinite(Date.parse(form.expiresAt)) ||
      Date.parse(form.expiresAt) <= Date.now()
    )
      throw new ApiFailure("INVALID_RESPONSE");
    const result = await new Promise<number>((resolve, reject) =>
      wx.uploadFile({
        url: local ? this.apiBaseUrl + form.url.slice(3) : form.url,
        name: "file",
        filePath,
        formData: form.fields,
        timeout: 45000,
        ...(local
          ? { header: { authorization: `Bearer ${stored.session.token}` } }
          : {}),
        success: (r) => resolve(r.statusCode),
        fail: () => reject(new ApiFailure("NETWORK_ERROR")),
      }),
    );
    this.assertCurrent(generation);
    if (
      result === 401 &&
      this.persisted()?.session.token === stored.session.token
    ) {
      this.invalidate(stored);
      throw new ApiFailure("UNAUTHENTICATED", 401);
    }
    if (this.stored()?.session.token !== stored.session.token)
      throw new ApiFailure("STALE_RESPONSE");
    if (result < 200 || result >= 300) {
      throw new ApiFailure(
        result === 401 ? "UNAUTHENTICATED" : "UPLOAD_FAILED",
        result,
      );
    }
  }
  async publicRequest<T>(path: string): Promise<T> {
    if (dataMode() !== "live") throw new ApiFailure("DEMO_MODE");
    const generation = this.generation;
    const result = await this.send<T>(path, "GET");
    this.assertCurrent(generation);
    return result;
  }
  private get storageKey() {
    return `timenook.session.v1:${this.apiBaseUrl}`;
  }
  private stored(): LoginResult | null {
    const value = this.persisted();
    return value &&
      value.session.token !== this.invalidatedToken &&
      Date.parse(value.session.expiresAt) > Date.now()
      ? value
      : null;
  }
  private persisted(): LoginResult | null {
    // Expiry blocks new credentials, but does not change an in-flight request's owner.
    const value: unknown = wx.getStorageSync(this.storageKey);
    return loginResult(value) ? value : null;
  }
  private invalidate(stored: LoginResult) {
    // Fail closed even if the device cannot remove its persisted session.
    this.invalidatedToken = stored.session.token;
    try {
      wx.removeStorageSync(this.storageKey);
      this.cleanupPending = false;
    } catch {
      this.cleanupPending = true;
    }
    for (const listener of [...this.invalidationListeners]) {
      try {
        listener(`${stored.user.id}:${stored.session.id}`);
      } catch {
        /* One device view must not block invalidation or media cleanup. */
      }
    }
  }
  private assertCurrent(generation: number) {
    if (generation !== this.generation || dataMode() !== "live")
      throw new ApiFailure("STALE_RESPONSE");
  }

  async login(): Promise<LoginResult> {
    const generation = ++this.generation;
    setDataMode("live");
    wx.removeStorageSync(this.storageKey);
    this.cleanupPending = false;
    this.checkBaseUrl();
    const code = await new Promise<string>((resolve, reject) =>
      wx.login({
        success: (result) =>
          result.code
            ? resolve(result.code)
            : reject(new ApiFailure("WECHAT_LOGIN_FAILED")),
        fail: () => reject(new ApiFailure("WECHAT_LOGIN_FAILED")),
      }),
    );
    this.assertCurrent(generation);
    const result = await this.send<LoginResult>("/sessions/wechat", "POST", {
      code,
    });
    if (
      !loginResult(result) ||
      Date.parse(result.session.expiresAt) <= Date.now()
    )
      throw new ApiFailure("INVALID_RESPONSE");
    try {
      this.assertCurrent(generation);
    } catch (error) {
      // A late server response may already have issued a session. Revoke it
      // without making it current; transport failure never restores it locally.
      void this.send<void>(
        `/sessions/${result.session.id}`,
        "DELETE",
        undefined,
        result.session.token,
      ).catch(() => {});
      throw error;
    }
    wx.setStorageSync(this.storageKey, result);
    this.invalidatedToken = null;
    return result;
  }

  private send<T>(
    path: string,
    method: "GET" | "POST" | "DELETE",
    data?: Record<string, unknown>,
    token?: string,
    idempotencyKey?: string,
  ): Promise<T> {
    this.checkBaseUrl();
    if (!/^\/[A-Za-z0-9/_-]+$/.test(path))
      throw new ApiFailure("INVALID_REQUEST");
    return new Promise((resolve, reject) =>
      wx.request<ApiResponse<T> | ApiErrorResponse>({
        url: this.apiBaseUrl + path,
        method,
        data,
        timeout: 10000,
        header: {
          "content-type": "application/json",
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        success: (response) => {
          if (response.statusCode === 204 && method === "DELETE") {
            resolve(undefined as T);
            return;
          }
          const body: unknown = response.data;
          if (
            !record(body) ||
            !record(body.meta) ||
            typeof body.meta.requestId !== "string"
          ) {
            reject(new ApiFailure("INVALID_RESPONSE", response.statusCode));
            return;
          }
          if (
            response.statusCode >= 200 &&
            response.statusCode < 300 &&
            "data" in body
          ) {
            resolve(body.data as T);
            return;
          }
          reject(
            new ApiFailure(
              record(body.error) && typeof body.error.code === "string"
                ? body.error.code
                : "INVALID_RESPONSE",
              response.statusCode,
              body.meta.requestId,
            ),
          );
        },
        fail: () => reject(new ApiFailure("NETWORK_ERROR")),
      }),
    );
  }

  private checkBaseUrl() {
    // Real hosts require HTTPS; plain HTTP is limited to the local dev server.
    if (
      !/^(?:https:\/\/[A-Za-z0-9.-]+(?::\d+)?|http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?)(?:\/[A-Za-z0-9_-]+)*\/v1$/.test(
        this.apiBaseUrl,
      )
    )
      throw new ApiFailure("NOT_CONFIGURED");
  }
}

export const sessionClient = new SessionClient(API_BASE_URL);
