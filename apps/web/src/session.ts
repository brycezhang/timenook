import { readonly, ref } from "vue";
import { webApi, WebApiError, type WebSession } from "./api";
const account = ref<WebSession | null>(null);
const restoring = ref(true);
const restoreError = ref("");
let generation = 0;
let controller: AbortController | undefined;
let pendingLogout: WebSession | null = null;
let expiry: ReturnType<typeof setTimeout> | undefined;
const changes =
  typeof BroadcastChannel !== "undefined"
    ? new BroadcastChannel("timenook-web-session")
    : undefined;
const listeners = new Set<() => void>();
function forget() {
  generation++;
  controller?.abort();
  clearTimeout(expiry);
  account.value = null;
  restoring.value = false;
  for (const listener of listeners) listener();
}
function changed() {
  changes?.postMessage("changed");
}
function accept(value: WebSession) {
  account.value = value;
  restoring.value = false;
  clearTimeout(expiry);
  expiry = setTimeout(
    forget,
    Math.max(0, Date.parse(value.session.expiresAt) - Date.now()),
  );
}
// Serialize Cookie writes across tabs; an ignored late response can still set a Cookie.
async function mutate<T>(action: () => Promise<T>): Promise<T> {
  return navigator.locks.request("timenook-web-session", action);
}
export async function restoreSession() {
  const version = ++generation;
  restoring.value = true;
  restoreError.value = "";
  try {
    const result = await webApi.restore();
    if (version === generation) accept(result);
  } catch (error) {
    if (version !== generation) return;
    if (error instanceof WebApiError && error.status === 401) forget();
    else {
      forget();
      restoreError.value = "暂时无法确认登录状态，请重试。";
    }
  } finally {
    if (version === generation) restoring.value = false;
  }
}
changes?.addEventListener("message", () => {
  forget();
  void restoreSession();
});
export const auth = {
  account: readonly(account),
  restoring: readonly(restoring),
  restoreError: readonly(restoreError),
  onClear(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  async login(challengeId: string, code: string) {
    return mutate(async () => {
      forget();
      const result = await webApi.login(challengeId, code);
      // This Cookie write owns the cross-tab lock. Invalidate any restoration
      // started by an older tab notification while the request was in flight.
      forget();
      accept(result);
      pendingLogout = null;
      changed();
      return result;
    });
  },
  async logout() {
    const owner = account.value ?? pendingLogout;
    forget();
    if (!owner) return;
    pendingLogout = owner;
    await mutate(async () => {
      try {
        const current = await webApi.restore().catch((error) => {
          if (error instanceof WebApiError && error.status === 401) return null;
          throw error;
        });
        if (current?.session.id === owner.session.id)
          await webApi.logout(owner.csrfToken);
        // Restorations may have begun while DELETE was pending. Invalidate
        // them before releasing the Cookie lock, including on request failure.
        forget();
        if (current && current.session.id !== owner.session.id) accept(current);
      } catch (error) {
        forget();
        throw error;
      }
    });
    pendingLogout = null;
    changed();
  },
  async projects() {
    const owner = account.value;
    if (!owner) throw new WebApiError(401);
    controller?.abort();
    const operation = new AbortController();
    controller = operation;
    const version = generation;
    try {
      const current = await webApi.restore();
      if (version !== generation)
        throw new DOMException("Request superseded", "AbortError");
      if (
        current.session.id !== owner.session.id ||
        current.user.id !== owner.user.id
      ) {
        forget();
        throw new WebApiError(401);
      }
      const result = await webApi.projects(operation.signal);
      if (generation !== version)
        throw new DOMException("Request superseded", "AbortError");
      return result.projects;
    } catch (error) {
      if (
        generation === version &&
        error instanceof WebApiError &&
        error.status === 401
      )
        forget();
      throw error;
    }
  },
};
