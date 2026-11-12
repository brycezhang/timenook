import { NATIVE_RELEASE } from "../config";
export type DataMode = "demo" | "live";
export function dataMode(): DataMode {
  // @development-only:start
  if (!NATIVE_RELEASE)
    return wx.getStorageSync("timenook.mode.v1") === "live" ? "live" : "demo";
  // @development-only:end
  return "live";
}
export function setDataMode(mode: DataMode): void {
  // @development-only:start
  if (!NATIVE_RELEASE) {
    wx.setStorageSync("timenook.mode.v1", mode);
    return;
  }
  // @development-only:end
  wx.setStorageSync("timenook.mode.v1", "live");
}

export function livePageAllowed(page: string): boolean {
  return [
    "home",
    "sample",
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
    "gift-share",
    "gift-claim",
    "order",
    "invite",
    "welcome",
    "chapter-outline",
    "question",
    "question-edit",
    "family-questions",
    "family-question",
    "family-question-edit",
    "interview",
    "photos",
    "story",
    "edit-story",
    "assign-story",
    "book",
    "manuscript",
    "print",
    "production",
    "original-audio",
    "account",
  ].includes(page);
}
