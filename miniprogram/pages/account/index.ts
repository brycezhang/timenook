import { NATIVE_TABS } from "../../config";
import { ApiFailure, sessionClient } from "../../services/session";
import {
  go,
  setTabBarVisible,
  switchProjectTab,
} from "../../services/navigation";
Page({
  data: {
    nativeTabs: NATIVE_TABS,
    loggedIn: false,
    busy: false,
    status: "",
    nickname: "",
    maskedPhone: "",
    editing: false,
    nicknameSheetMounted: false,
    nicknameFocused: false,
    loginVisible: false,
  },
  generation: 0,
  loginDestination: "account",
  async onShow() {
    if (this.data.busy) return;
    const n = ++this.generation;
    const owner = sessionClient.context();
    this.setData({
      loggedIn: !!owner,
      nickname: sessionClient.nickname(),
      maskedPhone: sessionClient.maskedPhone(),
    });
    try {
      const user = await sessionClient.restore();
      if (n === this.generation)
        this.setData({
          loggedIn: !!user,
          nickname: user?.nickname ?? "",
          maskedPhone: user?.maskedPhone ?? "",
          status: "",
        });
    } catch (e) {
      if (n !== this.generation) return;
      if (owner !== sessionClient.context()) {
        this.setData({ loggedIn: false, nickname: "", maskedPhone: "" });
        this.closeEdit();
      }
      this.setData({
        status: e instanceof Error ? e.message : "暂时无法刷新账号信息",
      });
    }
  },
  onHide() {
    if (!this.data.busy) ++this.generation;
  },
  login() {
    if (!this.data.busy) this.openLogin("account");
  },
  openLogin(destination: string) {
    this.loginDestination = destination;
    setTabBarVisible(false);
    this.setData({ loginVisible: true });
  },
  editNickname() {
    if (this.data.busy || this.data.nicknameSheetMounted) return;
    setTabBarVisible(false);
    this.setData({ nicknameSheetMounted: true, editing: true, status: "" });
  },
  cancelEdit() {
    if (!this.data.busy) this.closeEdit();
  },
  closeEdit() {
    this.setData({ editing: false, nicknameFocused: false });
  },
  focusNickname() {
    if (this.data.editing) this.setData({ nicknameFocused: true });
  },
  nicknameSheetClosed() {
    this.setData({
      nicknameSheetMounted: false,
      ...(this.data.loggedIn ? { status: "" } : {}),
    });
    if (!this.data.loginVisible) setTabBarVisible(true);
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
      if (n === this.generation) {
        this.setData({ nickname: user.nickname ?? "" });
        this.closeEdit();
      }
    } catch (e) {
      if (n === this.generation) {
        if (e instanceof ApiFailure && e.status === 401) {
          this.setData({ loggedIn: false, nickname: "", maskedPhone: "" });
          this.closeEdit();
        }
        this.setData({
          status: e instanceof Error ? e.message : "昵称未能保存，请重试",
        });
      }
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
      maskedPhone: "",
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
    if (sessionClient.context()) go("new-book");
    else this.openLogin("new-book");
  },
  loginSucceeded(e: {
    detail: { user: { nickname?: string | null; maskedPhone?: string | null } };
  }) {
    ++this.generation;
    const destination = this.loginDestination;
    this.closeLogin();
    this.setData({
      loggedIn: true,
      nickname: e.detail.user.nickname ?? "",
      maskedPhone: e.detail.user.maskedPhone ?? "",
      status: "",
    });
    if (destination === "new-book") go("new-book");
  },
  closeLogin() {
    this.loginDestination = "account";
    this.setData({ loginVisible: false });
    setTabBarVisible(true);
  },
  terms() {
    go("terms");
  },
  home() {
    switchProjectTab("home");
  },
});
