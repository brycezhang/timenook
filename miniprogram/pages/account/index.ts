import { NATIVE_TABS } from "../../config";
import { sessionClient } from "../../services/session";
import { showProjectTab, switchProjectTab } from "../../services/navigation";
import { go } from "../../services/store";
Page({
  data: { nativeTabs: NATIVE_TABS, loggedIn: false, busy: false, status: "" },
  generation: 0,
  loginPending: false,
  async onShow() {
    showProjectTab(this, "account");
    if (this.loginPending) return;
    const n = ++this.generation;
    this.setData({ loggedIn: !!sessionClient.context() });
    try {
      const user = await sessionClient.restore();
      if (n === this.generation) this.setData({ loggedIn: !!user, status: "" });
    } catch (e) {
      if (n === this.generation)
        this.setData({
          loggedIn: false,
          status: e instanceof Error ? e.message : "请重新登录",
        });
    }
  },
  onHide() {
    if (!this.loginPending) ++this.generation;
  },
  async login() {
    if (this.data.busy) return;
    ++this.generation;
    this.loginPending = true;
    this.setData({ busy: true, status: "" });
    try {
      await sessionClient.login();
      this.setData({ loggedIn: true });
    } catch (e) {
      this.setData({
        status: e instanceof Error ? e.message : "登录未完成，请重试",
      });
    } finally {
      this.loginPending = false;
      this.setData({ busy: false });
    }
  },
  async logout() {
    if (this.data.busy) return;
    ++this.generation;
    this.setData({ busy: true });
    try {
      await sessionClient.logout();
    } catch (e) {
      this.setData({
        status: "本机已退出，服务端退出结果待确认",
      });
    } finally {
      this.setData({ busy: false, loggedIn: false });
    }
  },
  projects() {
    go("projects");
  },
  purchase() {
    go("new-book");
  },
  terms() {
    go("terms");
  },
  home() {
    switchProjectTab("home");
  },
});
