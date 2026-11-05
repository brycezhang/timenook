import {
  ApiFailure,
  sessionClient,
  recordingUploadTarget,
} from "../../../miniprogram/services/session";
import {
  webApi,
  withWebSession,
  onWebSessionChange,
  WebApiError,
  type WebSession,
} from "./api";
import { resolveBlob, temporaryFile } from "../../../preview/media";

/** A product request owns one server-established browser session. */
export class CookieProductSession {
  private readonly listeners = new Set<(context: string) => void>();
  private pendingLogout?: WebSession;
  private readonly stopChanges: () => void;
  private readonly operations = new Set<AbortController>();
  constructor(private current: WebSession | undefined) {
    this.stopChanges = onWebSessionChange(() => {
      if (this.current) this.invalidate(this.current);
    });
  }

  onInvalidated(listener: (context: string) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private forget(owner: WebSession) {
    if (this.current !== owner) return false;
    this.current = undefined;
    this.stopChanges();
    for (const controller of this.operations) controller.abort();
    return true;
  }

  private notifyInvalidated(owner: WebSession) {
    for (const listener of [...this.listeners]) {
      try {
        listener(`${owner.user.id}:${owner.session.id}`);
      } catch {
        /* Cleanup continues for every active page. */
      }
    }
  }

  private invalidate(owner: WebSession) {
    if (this.forget(owner)) this.notifyInvalidated(owner);
  }

  sessionCleanupPending() {
    return !!this.pendingLogout;
  }
  close() {
    if (this.current) this.invalidate(this.current);
    this.stopChanges();
  }

  async restore() {
    const owner = this.current;
    if (!owner) return null;
    try {
      return await withWebSession(owner, async () =>
        this.current === owner ? owner.user : null,
      );
    } catch (error) {
      if (error instanceof WebApiError && error.status === 401) {
        this.invalidate(owner);
        return null;
      }
      throw error;
    }
  }

  async logout() {
    const owner = this.current ?? this.pendingLogout;
    if (!owner) return;
    this.pendingLogout = owner;
    this.forget(owner);
    await webApi.logout(owner.csrfToken);
    if (this.pendingLogout === owner) {
      this.pendingLogout = undefined;
      this.notifyInvalidated(owner);
    }
  }

  async download(path: string) {
    if (!/^\/[A-Za-z0-9/_-]+(?:\?epoch=\d+)?$/.test(path))
      throw new ApiFailure("INVALID_REQUEST");
    const owner = this.current;
    if (!owner || !this.context()) throw new ApiFailure("UNAUTHENTICATED", 401);
    const controller = new AbortController();
    this.operations.add(controller);
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      return await withWebSession(owner, async (headers) => {
        if (this.current !== owner) throw new ApiFailure("STALE_RESPONSE");
        const response = await fetch(`/api/v1${path}`, {
          headers,
          credentials: "same-origin",
          redirect: "error",
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) {
          if (response.status === 401) this.invalidate(owner);
          return {
            statusCode: response.status,
            tempFilePath: "",
            errMsg: "downloadFile:fail",
          };
        }
        const blob = await response.blob();
        if (this.current !== owner) throw new ApiFailure("STALE_RESPONSE");
        return {
          statusCode: response.status,
          tempFilePath: temporaryFile(blob),
          errMsg: "downloadFile:ok",
        };
      });
    } catch (error) {
      if (error instanceof WebApiError && error.status === 401)
        this.invalidate(owner);
      throw error instanceof ApiFailure
        ? error
        : new ApiFailure(
            "NETWORK_ERROR",
            error instanceof WebApiError ? error.status : 0,
          );
    } finally {
      clearTimeout(timeout);
      this.operations.delete(controller);
    }
  }

  async upload(
    form: import("../../../packages/contracts/src/audio-probe").ProbeUploadForm,
    filePath: string,
    kind: "recordings" | "photos",
  ) {
    const owner = this.current;
    if (!owner || !this.context()) throw new ApiFailure("UNAUTHENTICATED", 401);
    const { local, url } = recordingUploadTarget(
      form,
      `${location.origin}/api/v1`,
      kind,
    );
    const controller = new AbortController();
    this.operations.add(controller);
    const timeout = setTimeout(() => controller.abort(), 45000);
    try {
      await withWebSession(owner, async (headers) => {
        if (this.current !== owner) throw new ApiFailure("STALE_RESPONSE");
        const blob = await (
          await fetch(await resolveBlob(filePath), {
            signal: controller.signal,
          })
        ).blob();
        const data = new FormData();
        for (const [name, value] of Object.entries(form.fields))
          data.append(name, String(value));
        data.append(
          "file",
          blob,
          kind === "recordings" ? "recording.mp3" : "photo.bin",
        );
        const response = await fetch(url, {
          method: "POST",
          body: data,
          credentials: local ? "same-origin" : "omit",
          redirect: "error",
          signal: controller.signal,
          ...(local ? { headers } : {}),
        });
        if (this.current !== owner) throw new ApiFailure("STALE_RESPONSE");
        if (!response.ok)
          throw new ApiFailure(
            response.status === 401 ? "UNAUTHENTICATED" : "UPLOAD_FAILED",
            response.status,
          );
      });
    } catch (error) {
      if (
        (error instanceof WebApiError || error instanceof ApiFailure) &&
        error.status === 401
      )
        this.invalidate(owner);
      throw error instanceof ApiFailure
        ? error
        : new ApiFailure(
            "UPLOAD_FAILED",
            error instanceof WebApiError ? error.status : 0,
          );
    } finally {
      clearTimeout(timeout);
      this.operations.delete(controller);
    }
  }

  context() {
    const owner = this.current;
    if (owner && Date.parse(owner.session.expiresAt) <= Date.now())
      this.invalidate(owner);
    return owner && Date.parse(owner.session.expiresAt) > Date.now()
      ? `${owner.user.id}:${owner.session.id}`
      : "";
  }

  async request<T>(
    path: string,
    command?: { data: Record<string, unknown>; key: string },
  ): Promise<T> {
    if (!/^\/[A-Za-z0-9/_-]+$/.test(path))
      throw new ApiFailure("INVALID_REQUEST");
    const owner = this.current;
    if (!owner || !this.context()) throw new ApiFailure("UNAUTHENTICATED", 401);
    try {
      return await withWebSession(owner, async (headers) => {
        if (this.current !== owner) throw new ApiFailure("STALE_RESPONSE");
        const controller = new AbortController();
        this.operations.add(controller);
        const timeout = setTimeout(() => controller.abort(), 10000);
        try {
          const response = await fetch(`/api/v1${path}`, {
            method: command ? "POST" : "GET",
            credentials: "same-origin",
            redirect: "error",
            cache: "no-store",
            signal: controller.signal,
            headers: {
              ...headers,
              ...(command
                ? {
                    "Content-Type": "application/json",
                    "Idempotency-Key": command.key,
                  }
                : {}),
            },
            ...(command ? { body: JSON.stringify(command.data) } : {}),
          });
          const body = await response.json();
          if (!body?.meta?.requestId)
            throw new ApiFailure("INVALID_RESPONSE", response.status);
          if (!response.ok || body.error) {
            throw new ApiFailure(
              body.error?.code ?? "INVALID_RESPONSE",
              response.status,
              body.meta.requestId,
            );
          }
          if (!("data" in body))
            throw new ApiFailure("INVALID_RESPONSE", response.status);
          if (this.current !== owner) throw new ApiFailure("STALE_RESPONSE");
          return body.data as T;
        } finally {
          clearTimeout(timeout);
          this.operations.delete(controller);
        }
      });
    } catch (error) {
      if (
        (error instanceof WebApiError || error instanceof ApiFailure) &&
        error.status === 401
      )
        this.invalidate(owner);
      if (error instanceof WebApiError)
        throw new ApiFailure(
          error.status === 401 ? "UNAUTHENTICATED" : "NETWORK_ERROR",
          error.status,
        );
      throw error instanceof ApiFailure
        ? error
        : new ApiFailure("NETWORK_ERROR");
    }
  }
}

export function installCookieProductSession(session: WebSession) {
  sessionClient.useCookieSession(new CookieProductSession(session));
  return sessionClient;
}
