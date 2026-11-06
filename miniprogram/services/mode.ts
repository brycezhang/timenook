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
    "login",
    "projects",
    "new-book",
    "terms",
    "stories",
    "story-audio",
    "directory",
    "chapter",
    "chapter-stories",
    "cover",
    "cover-photos",
    "address",
    "account-link",
    "purchase",
    "order",
    "invite",
    "welcome",
    "plan",
    "topic",
    "interview",
    "photos",
    "story",
    "edit-story",
    "book",
    "manuscript",
    "print",
    "production",
    "original-audio",
    "account",
  ].includes(page);
}
