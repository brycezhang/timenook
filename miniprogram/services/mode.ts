export type DataMode = "demo" | "live";
export function dataMode(): DataMode {
  return wx.getStorageSync("timenook.mode.v1") === "live" ? "live" : "demo";
}
export function setDataMode(mode: DataMode): void {
  wx.setStorageSync("timenook.mode.v1", mode);
}
