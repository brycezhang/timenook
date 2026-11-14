import { shallowRef } from "vue";
import type { AdminPermission, AdminState } from "@timenook/contracts";
import { adminApi } from "./api/admin";
import { useAccessStore, useTabbarStore } from "@vben/stores";
export const session = shallowRef<AdminState | null>(null);
export const sessionError = shallowRef("");
export let sessionEpoch = 0;
export const can = (permission: AdminPermission) =>
  session.value?.operator?.permissions.includes(permission) ?? false;
export function clearPrivateState() {
  sessionEpoch++;
  session.value = null;
  useAccessStore().$reset();
  useTabbarStore().$reset();
}
export async function refreshSession() {
  const epoch = sessionEpoch;
  const next = await adminApi.session();
  if (epoch !== sessionEpoch) throw new Error("STALE_SESSION");
  if (!next.authenticated && session.value?.authenticated) clearPrivateState();
  session.value = next;
  return next;
}
export async function expireSession() {
  clearPrivateState();
  sessionError.value = "登录已到期，请重新登录。";
  await refreshSession().catch(() => null);
  window.dispatchEvent(new Event("admin-session-expired"));
}
export async function adminRequest<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const epoch = sessionEpoch;
  const response = await fetch(`/api/v1/admin${path}`, {
    credentials: "same-origin",
    cache: "no-store",
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const payload = await response.json();
  if (epoch !== sessionEpoch) throw new Error("STALE_SESSION");
  if (response.status === 401) {
    await expireSession();
    throw payload;
  }
  if (response.status === 403) {
    sessionEpoch++;
    await refreshSession();
    window.dispatchEvent(new Event("admin-permission-changed"));
    throw payload;
  }
  if (!response.ok) throw payload;
  return payload.data as T;
}
export function errorText(error: unknown) {
  const code = (error as { error?: { code?: string } })?.error?.code;
  return (
    (
      {
        FORBIDDEN: "没有此操作权限。",
        NOT_FOUND: "未找到这条记录。",
        INVALID_REQUEST: "输入或查询条件不正确。",
        CONFLICT: "状态已变化，请刷新后重试。",
        IDEMPOTENCY_CONFLICT: "同一提交编号已用于不同备注，请刷新后重新提交。",
        RATE_LIMITED: "操作较频繁，请稍后重试。",
      } as Record<string, string>
    )[code ?? ""] ?? "请求未完成，请重试。"
  );
}
