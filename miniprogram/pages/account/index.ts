import { NATIVE_TABS } from "../../config";
import { sessionClient } from "../../services/session";
import { showProjectTab, switchProjectTab } from "../../services/navigation";
import { go } from "../../services/store";
Page({
  data: {
    nativeTabs: NATIVE_TABS,
    loggedIn: false,
    busy: false,
    status: "",
    nickname: "",
    editing: false,
  },
  generation: 0,
  async onShow() {
    showProjectTab(this, "account");
    if (this.data.busy) return;
    const n = ++this.generation;
    this.setData({
      loggedIn: !!sessionClient.context(),
      nickname: sessionClient.nickname(),
    });
    try {
      const user = await sessionClient.restore();
      if (n === this.generation)
        this.setData({
          loggedIn: !!user,
          nickname: user?.nickname ?? "",
          status: "",
        });
    } catch (e) {
      if (n === this.generation)
        this.setData({
          loggedIn: false,
          nickname: "",
          status: e instanceof Error ? e.message : "请重新登录",
        });
    }
  },
  onHide() {
    if (!this.data.busy) ++this.generation;
  },
  login() {
    if (!this.data.busy) go("login", "next=account");
  },
  editNickname() {
    if (!this.data.busy) this.setData({ editing: true, status: "" });
  },
  cancelEdit() {
    if (!this.data.busy) this.setData({ editing: false, status: "" });
  },
  async saveNickname(e: { detail: { value: { nickname: string } } }) {
    if (this.data.busy) return;
    const nickname = e.detail.value.nickname.trim();
    if (!nickname || nickname.length > 32) {
      this.setData({ status: "请选择或填写昵称（最多32个字）" });
      return;
    }
    const n = ++this.generation;
    this.setData({ busy: true, status: "" });
    try {
      const user = await sessionClient.updateNickname(nickname);
      if (n === this.generation)
        this.setData({ nickname: user.nickname ?? "", editing: false });
    } catch (e) {
      if (n === this.generation)
        this.setData({
          status: e instanceof Error ? e.message : "昵称未能保存，请重试",
        });
    } finally {
      this.setData({ busy: false });
    }
  },
  async logout() {
    if (this.data.busy) return;
    ++this.generation;
    this.setData({
      busy: true,
      loggedIn: false,
      nickname: "",
      editing: false,
      status: "",
    });
    try {
      await sessionClient.logout();
    } catch {
      this.setData({ status: "本机已退出，服务端退出结果待确认" });
    } finally {
      this.setData({ busy: false });
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
