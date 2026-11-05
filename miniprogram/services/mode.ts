import { NATIVE_RELEASE } from "../config";
export type DataMode = "demo" | "live";
export function dataMode(): DataMode {
  if (NATIVE_RELEASE) return "live";
  return wx.getStorageSync("timenook.mode.v1") === "live" ? "live" : "demo";
}
export function setDataMode(mode: DataMode): void {
  wx.setStorageSync("timenook.mode.v1", NATIVE_RELEASE ? "live" : mode);
}

export function livePageAllowed(page: string): boolean {
  return [
    "home",
    "account-link",
    "purchase",
    "order",
    "refunds",
    "quality",
    "invite",
    "welcome",
    "assisted",
    "plan",
    "interview",
    "photos",
    "story",
    "project",
    "edit-story",
    "settings",
    "book",
    "manuscript",
    "print",
    "production",
    "original-audio",
    "export",
    "deletion-status",
    "account",
    "service",
  ].includes(page);
}
