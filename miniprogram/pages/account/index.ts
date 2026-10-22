import { type Project } from "../../domain/model";
import { clear, go, home, list, read, select } from "../../services/store";
type E = {
  currentTarget: { dataset: Record<string, string> };
  detail: { value: string };
};
Page({
  data: { p: null as Project | null, count: 0, projects: [] as Project[] },
  onShow() {
    const p = read();
    if (!p) {
      home("home");
      return;
    }
    this.setData({ p, count: p.recordings.length, projects: list() });
  },
  shop() {
    go("home", "browse=1");
  },
  switchProject(e: E) {
    select(e.currentTarget.dataset.id);
    home();
  },
  order() {
    go("order");
  },
  settings() {
    go("settings");
  },
  invite() {
    go("invite");
  },
  service(e: E) {
    go("service", "kind=" + e.currentTarget.dataset.kind);
  },
  reset() {
    wx.showModal({
      title: "重新体验",
      content:
        "这会清除当前本机演示项目及其资料索引，其他项目会保留。请先导出需要保留的内容。",
      confirmText: "清除重来",
      success: (r) => {
        if (r.confirm) {
          clear();
          home(read() ? "account" : "home");
        }
      },
    });
  },
  project() {
    home("project");
  },
  book() {
    home("book");
  },
  account() {
    home("account");
  },
});
