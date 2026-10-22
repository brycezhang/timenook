import { dataMode } from "./services/mode";
App({
  onShow(options) {
    if (
      dataMode() === "live" &&
      options.path &&
      options.path !== "pages/home/index"
    ) {
      wx.reLaunch({ url: "/pages/home/index" });
    }
  },
});
