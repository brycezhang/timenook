import { participationClient } from "../../services/participation";
import { sessionClient } from "../../services/session";
import { setDataMode } from "../../services/mode";
import { switchProjectTab } from "../../services/navigation";
import { go } from "../../services/store";
import type { InvitationView } from "../../../packages/contracts/src";
Page({
  data: {
    invitation: null as InvitationView | null,
    busy: false,
    status: "",
    loggedIn: false,
    loginVisible: false,
    expired: false,
  },
  token: "",
  generation: 0,
  joining: false,
  onLoad(q) {
    this.token = q.token ?? "";
    setDataMode("live");
  },
  async onShow() {
    if (this.joining) return;
    const n = ++this.generation;
    this.setData({
      busy: true,
      status: "",
      loggedIn: !!sessionClient.context(),
    });
    try {
      const invitation = await participationClient.preview(this.token);
      if (n === this.generation) this.setData({ invitation, expired: false });
    } catch (e) {
      if (n === this.generation)
        this.setData({
          invitation: null,
          expired: true,
          status: "这份邀请已失效，请家人重新分享邀请。",
        });
    } finally {
      if (n === this.generation) this.setData({ busy: false });
    }
  },
  onHide() {
    if (!this.joining) ++this.generation;
  },
  async accept() {
    if (this.data.busy || !this.data.invitation) return;
    if (!sessionClient.context()) {
      this.setData({ loginVisible: true });
      return;
    }
    this.joining = true;
    this.setData({ busy: true, status: "" });
    try {
      const joined = await participationClient.apply(
        this.token,
        this.data.invitation.noticeVersion,
      );
      switchProjectTab("home", joined.projectId);
    } catch (e) {
      this.setData({
        status: e instanceof Error ? e.message : "加入未完成，请重试",
      });
    } finally {
      this.joining = false;
      this.setData({ busy: false, loggedIn: !!sessionClient.context() });
    }
  },
  closeLogin() {
    this.setData({ loginVisible: false });
  },
  loginSucceeded() {
    this.setData({ loginVisible: false, loggedIn: true });
  },
  terms() {
    go("terms");
  },
  home() {
    switchProjectTab("home");
  },
});
