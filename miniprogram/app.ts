import { AUDIO_PROBE_BUILD } from "./config";
import { dataMode } from "./services/mode";
App({
  onShow(options) {
    if (
      dataMode() === "live" &&
      options.path &&
      options.path !== "pages/home/index" &&
      !(AUDIO_PROBE_BUILD && options.path === "pages/audio-probe/index")
    ) {
      wx.reLaunch({ url: "/pages/home/index" });
    }
  },
});
