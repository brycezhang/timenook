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
    "invite",
    "welcome",
    "assisted",
    "plan",
    "interview",
    "project",
  ].includes(page);
}
