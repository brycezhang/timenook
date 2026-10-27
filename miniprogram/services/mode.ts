export type DataMode = "demo" | "live";
export function dataMode(): DataMode {
  return wx.getStorageSync("timenook.mode.v1") === "live" ? "live" : "demo";
}
export function setDataMode(mode: DataMode): void {
  wx.setStorageSync("timenook.mode.v1", mode);
}

export function livePageAllowed(page: string): boolean {
  return [
    "home",
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
  ].includes(page);
}
