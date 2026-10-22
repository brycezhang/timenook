import { type Project } from "../../domain/model";
import { asset, go, home, notify, required } from "../../services/store";
type E = {
  currentTarget: { dataset: Record<string, string> };
  detail: { value: string };
};
Page({
  data: { p: null as Project | null, bookImage: "" },
  onShow() {
    const p = required();
    this.setData({ p, bookImage: asset(p) });
  },
  preview() {
    go("welcome");
  },
  settings() {
    go("settings");
  },
  project() {
    home();
  },
  onShareAppMessage() {
    const p = required();
    return {
      title: p.recipient + "，想把你的故事留给我们",
      path: "/pages/welcome/index?preview=1",
    };
  },
  share() {
    notify(
      "邀请卡已准备好",
      "前端版可在此设备预览邀请。跨设备邀请需要登录与服务端绑定，暂未接入。",
    );
  },
});
