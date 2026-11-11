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
    "gift-recipient",
    "order",
    "invite",
    "welcome",
    "chapter-outline",
    "question",
    "question-edit",
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
