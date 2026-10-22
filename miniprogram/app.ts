import { AUDIO_PROBE_BUILD } from "./config";
import { dataMode, livePageAllowed } from "./services/mode";
App({
  onShow(options) {
    if (
      dataMode() === "live" &&
      options.path &&
      !livePageAllowed(
        options.path.replace(/^pages\//, "").replace(/\/index$/, ""),
      ) &&
      !(AUDIO_PROBE_BUILD && options.path === "pages/audio-probe/index")
    ) {
      wx.reLaunch({ url: "/pages/home/index" });
    }
  },
});
