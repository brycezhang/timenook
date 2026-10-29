import { type Project } from "../../domain/model";
import { asset, go, home, notify, required } from "../../services/store";
import { dataMode } from "../../services/mode";
import { sessionClient, ApiFailure } from "../../services/session";
import { participationClient } from "../../services/participation";
import { paymentKey } from "../../services/payments";
import type {
  ParticipationState,
  BindingApplication,
} from "../../../packages/contracts/src";
type E = {
  currentTarget: { dataset: Record<string, string> };
  detail: { value: string };
};
Page({
  data: {
    p: null as Project | null,
    bookImage: "",
    mode: dataMode(),
    participation: null as ParticipationState | null,
    requests: [] as BindingApplication[],
    inviteToken: "",
    busy: false,
    status: "",
    loggedIn: false,
  },
  projectId: "",
  generation: 0,
  shareContext: "",
  approvalIntent: null as { input: string; key: string } | null,
  onLoad(q) {
    this.projectId = q.projectId ?? "";
  },
  onHide() {
    ++this.generation;
    this.setData({
      inviteToken: "",
      participation: null,
      requests: [],
      busy: false,
    });
  },
  onUnload() {
    this.onHide();
  },
  async onShow() {
    if (this.data.busy) return;
    if (dataMode() === "live") {
      await this.refreshLive();
      return;
    }
    const p = required();
    this.setData({ mode: "demo", p, bookImage: asset(p) });
  },
  recoverExpiredSession(error: unknown, generation: number, context: string) {
    if (
      generation !== this.generation ||
      dataMode() !== "live" ||
      !context ||
      sessionClient.context() ||
      !(error instanceof ApiFailure) ||
      (error.status !== 401 &&
        !(error.code === "STALE_RESPONSE" && error.status === 0))
    )
      return false;
    this.setData({
      busy: false,
      loggedIn: false,
      participation: null,
      requests: [],
      inviteToken: "",
      status: "登录已失效，请重新登录",
    });
    return true;
  },
  async loginLive() {
    if (this.data.busy) return;
    const generation = ++this.generation;
    this.setData({
      busy: true,
      status: "",
      participation: null,
      inviteToken: "",
    });
    try {
      await sessionClient.login();
      if (generation === this.generation && dataMode() === "live")
        await this.refreshLive();
    } catch (error) {
      if (generation === this.generation)
        this.setData({
          busy: false,
          status: error instanceof Error ? error.message : "登录失败",
        });
    }
  },
  async refreshLive() {
    const generation = ++this.generation;
    const context = sessionClient.context();
    this.setData({
      mode: "live",
      p: null,
      participation: null,
      requests: [],
      status: "",
      busy: true,
      loggedIn: !!context,
    });
    const current = () =>
      generation === this.generation &&
      context === sessionClient.context() &&
      dataMode() === "live";
    try {
      const participation = await participationClient.state(this.projectId);
      if (!current()) return;
      this.setData({ participation });
      const result = await participationClient.requests(this.projectId);
      if (current()) this.setData({ requests: result.requests });
    } catch (error) {
      if (this.recoverExpiredSession(error, generation, context)) return;
      if (current())
        this.setData({
          status: error instanceof Error ? error.message : "查询失败",
        });
    } finally {
      if (current()) this.setData({ busy: false });
    }
  },
  async approve(e: E) {
    const state = this.data.participation;
    if (
      !state ||
      this.data.busy ||
      (state.policyStatus !== "synthetic-only" &&
        state.policyStatus !== "internal-acceptance")
    )
      return;
    const input = JSON.stringify({
      id: e.currentTarget.dataset.id,
      version: state.bindingVersion,
    });
    if (this.approvalIntent?.input !== input)
      this.approvalIntent = { input, key: paymentKey() };
    const context = sessionClient.context();
    const generation = this.generation;
    this.setData({ busy: true, status: "" });
    try {
      await participationClient.approve(
        e.currentTarget.dataset.id,
        state.bindingVersion,
        this.approvalIntent.key,
        state.noticeVersion,
      );
      if (context !== sessionClient.context() || generation !== this.generation)
        return;
      this.approvalIntent = null;
      await this.refreshLive();
    } catch (error) {
      if (this.recoverExpiredSession(error, generation, context)) return;
      if (context === sessionClient.context() && generation === this.generation)
        this.setData({
          status:
            error instanceof Error ? error.message : "核验未确认，请重新查询",
          busy: false,
        });
    }
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
  copyInvitation() {
    if (!this.data.inviteToken || this.shareContext !== sessionClient.context())
      return;
    const origin =
      typeof window !== "undefined"
        ? window.location.origin
        : "https://sgl.wootoon.cn";
    wx.setClipboardData({
      data: `${origin}/app/invitation/${this.data.inviteToken}`,
      fail: () => this.setData({ status: "邀请链接未复制，请重试。" }),
    });
  },
  onShareAppMessage() {
    if (dataMode() === "live")
      return this.data.inviteToken &&
        this.shareContext === sessionClient.context()
        ? {
            title: "邀请你记录自己的故事 · 时光里",
            path: `/pages/welcome/index?token=${this.data.inviteToken}`,
          }
        : { title: "时光里 · 岁月成书", path: "/pages/home/index" };
    const p = required();
    return {
      title: p.recipient + "，想把你的故事留给我们",
      path: "/pages/welcome/index?preview=1",
    };
  },
  async share() {
    if (dataMode() === "live") {
      if (
        this.data.busy ||
        (this.data.participation?.policyStatus !== "synthetic-only" &&
          this.data.participation?.policyStatus !== "internal-acceptance")
      )
        return;
      const context = sessionClient.context();
      const generation = this.generation;
      this.setData({ busy: true, status: "", inviteToken: "" });
      try {
        const invite = await participationClient.invite(this.projectId);
        if (
          context === sessionClient.context() &&
          generation === this.generation
        ) {
          this.shareContext = context;
          this.setData({
            inviteToken: invite.token,
            status: "邀请已准备，请发送给本人。转发不会授予内容权限。",
          });
        }
      } catch (error) {
        if (this.recoverExpiredSession(error, generation, context)) return;
        if (
          context === sessionClient.context() &&
          generation === this.generation
        )
          this.setData({
            status: error instanceof Error ? error.message : "邀请准备失败",
          });
      } finally {
        if (
          context === sessionClient.context() &&
          generation === this.generation
        )
          this.setData({ busy: false });
      }
      return;
    }
    notify(
      "邀请卡已准备好",
      "前端版可在此设备预览邀请。跨设备邀请需要登录与服务端绑定，暂未接入。",
    );
  },
});
