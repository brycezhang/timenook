import { participationClient } from "../../services/participation";
import { ApiFailure, sessionClient } from "../../services/session";
import { setDataMode } from "../../services/mode";
import { switchProjectTab } from "../../services/navigation";
import { go } from "../../services/navigation";
import type { InvitationView } from "../../../packages/contracts/src";
const relationships = ["儿子", "女儿", "孙子", "孙女", "伴侣", "自定义"];
Page({
  data: {
    invitation: null as InvitationView | null,
    relationships,
    relationship: "",
    customRelationship: "",
    agreed: false,
    busy: false,
    status: "",
    loggedIn: false,
    loginVisible: false,
    expired: false,
  },
  token: "",
  generation: 0,
  joining: false,
  owner: "",
  onLoad(q) {
    this.token = q.token ?? "";
    setDataMode("live");
  },
  async onShow() {
    if (this.joining) return;
    const n = ++this.generation;
    const owner = sessionClient.context();
    if (this.owner && this.owner !== owner)
      this.setData({ relationship: "", customRelationship: "", agreed: false });
    this.owner = owner;
    this.setData({
      busy: true,
      status: "",
      loggedIn: !!sessionClient.context(),
    });
    try {
      const invitation = await participationClient.preview(this.token);
      if (n === this.generation) this.setData({ invitation, expired: false });
    } catch (e) {
      if (n === this.generation) {
        const expired =
          !/^[A-Za-z0-9_-]{43}$/.test(this.token) ||
          (e instanceof ApiFailure && e.status === 404);
        this.setData({
          invitation: null,
          expired,
          status: expired
            ? "这份邀请已失效，请家人重新分享邀请。"
            : "邀请暂未读取，请重试。",
        });
      }
    } finally {
      if (n === this.generation) this.setData({ busy: false });
    }
  },
  onHide() {
    ++this.generation;
  },
  onUnload() {
    ++this.generation;
  },
  chooseRelationship(e: WechatMiniprogram.TouchEvent) {
    const relationship = String(e.currentTarget.dataset.relationship);
    if (relationships.includes(relationship))
      this.setData({ relationship, status: "" });
  },
  customRelationshipInput(e: { detail: { value: string } }) {
    this.setData({ customRelationship: e.detail.value, status: "" });
  },
  agreementChange(e: { detail: { value: string[] } }) {
    this.setData({ agreed: e.detail.value.includes("agree"), status: "" });
  },
  async accept() {
    if (this.data.busy || !this.data.invitation) return;
    const relationship = (
      this.data.relationship === "自定义"
        ? this.data.customRelationship
        : this.data.relationship
    ).trim();
    if (!relationship || relationship.length > 32) {
      this.setData({ status: "请填写你是主讲人的谁（最多32个字）" });
      return;
    }
    if (!this.data.agreed) {
      this.setData({ status: "请先阅读并同意使用条款与隐私说明" });
      return;
    }
    if (!sessionClient.context()) {
      this.setData({ loginVisible: true });
      return;
    }
    this.joining = true;
    const n = ++this.generation,
      owner = sessionClient.context();
    this.setData({ busy: true, status: "" });
    try {
      const joined = await participationClient.apply(
        this.token,
        this.data.invitation.noticeVersion,
        relationship,
      );
      if (n === this.generation && owner === sessionClient.context())
        switchProjectTab("home", joined.projectId);
    } catch (e) {
      if (n === this.generation && owner === sessionClient.context()) {
        const expired = e instanceof ApiFailure && e.status === 404;
        this.setData({
          ...(expired ? { invitation: null, expired } : {}),
          status: expired
            ? "这份邀请已失效，请家人重新分享邀请。"
            : e instanceof Error
              ? e.message
              : "加入未完成，请重试",
        });
      }
    } finally {
      this.joining = false;
      this.setData({ busy: false, loggedIn: !!sessionClient.context() });
    }
  },
  closeLogin() {
    this.setData({ loginVisible: false });
  },
  loginSucceeded() {
    this.owner = sessionClient.context();
    this.setData({ loginVisible: false, loggedIn: true });
  },
  terms() {
    go("terms");
  },
  home() {
    switchProjectTab("home");
  },
  retry() {
    void this.onShow();
  },
});
