import type { WithdrawalStatus } from "../../../packages/contracts/src";
import { type Project } from "../../domain/model";
import { go, home, read, required, save } from "../../services/store";
import { dataMode, setDataMode } from "../../services/mode";
import { sessionClient, ApiFailure } from "../../services/session";
import {
  participationClient,
  withdrawalDisposition,
} from "../../services/participation";
import { paymentKey } from "../../services/payments";
import { recordingId } from "../../services/local-audio-recorder";
import {
  CONSENT_PURPOSES,
  type ConsentPurpose,
  type ParticipationState,
  type InvitationView,
  type ProjectCareRequestView,
} from "../../../packages/contracts/src";
type E = {
  currentTarget: { dataset: Record<string, string> };
  detail: { value: string };
};
Page({
  data: {
    statusProjectId: "",
    withdrawal: null as WithdrawalStatus | null,
    productionDisposition: "",
    p: null as Project | null,
    agreed: false,
    showDetails: false,
    showManagement: false,
    missing: false,
    mode: dataMode(),
    invitation: null as InvitationView | null,
    participation: null as ParticipationState | null,
    memberships: [] as { projectId: string; state: string }[],
    status: "",
    busy: false,
    loggedIn: false,
    accountId: "",
    targetUserId: "",
    supportCaseRef: "",
    careRequests: [] as ProjectCareRequestView[],
    purposeLabels: [
      { purpose: "collection", label: "采集并保存讲述和照片" },
      { purpose: "ai", label: "交由AI处理素材" },
      { purpose: "sharing", label: "向本项目发起人共享资料" },
    ],
  },
  inviteToken: "",
  projectId: "",
  generation: 0,
  intent: null as { input: string; key: string } | null,
  onLoad(q) {
    this.setData({ showManagement: q.manage === "1" });
    if (q.token || q.projectId) setDataMode("live");
    if (dataMode() === "live") {
      this.inviteToken = q.token ?? "";
      this.projectId = q.projectId ?? "";
      this.setData({ statusProjectId: this.projectId });
      this.setData({ mode: "live", p: null });
      return;
    }
    if (q.preview === "1" && !read()) {
      this.setData({ missing: true });
      return;
    }
    const p = read();
    if (!p) {
      this.setData({ missing: true });
      return;
    }
    this.setData({ p, agreed: p.consent });
  },
  onHide() {
    this.intent = null;
    this.setData({ withdrawal: null, productionDisposition: "" });
    ++this.generation;
    this.setData({
      participation: null,
      invitation: null,
      memberships: [],
      careRequests: [],
      busy: false,
    });
  },
  async showWithdrawal() {
    if (this.data.busy || !this.projectId) return;
    const generation = this.generation,
      owner = sessionClient.context();
    this.setData({ busy: true, withdrawal: null, productionDisposition: "" });
    try {
      const withdrawal = await participationClient.withdrawalStatus(
        this.projectId,
      );
      if (generation !== this.generation || owner !== sessionClient.context())
        return;
      const productionDisposition = withdrawalDisposition(withdrawal);
      this.setData({ withdrawal, productionDisposition });
    } catch (error) {
      if (generation === this.generation && owner === sessionClient.context())
        this.setData({
          status: error instanceof Error ? error.message : "查询未完成，请重试",
        });
    } finally {
      if (generation === this.generation && owner === sessionClient.context())
        this.setData({ busy: false });
    }
  },
  onUnload() {
    this.onHide();
  },
  async onShow() {
    if (this.data.busy) return;
    if (dataMode() === "live") await this.refreshLive();
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
      accountId: "",
      participation: null,
      invitation: null,
      memberships: [],
      careRequests: [],
      supportCaseRef: "",
      status: "登录已失效，请重新登录",
    });
    return true;
  },
  async refreshLive() {
    const generation = ++this.generation;
    const context = sessionClient.context();
    this.setData({
      mode: "live",
      participation: null,
      invitation: null,
      memberships: [],
      careRequests: [],
      supportCaseRef: "",
      status: "",
      busy: true,
      loggedIn: !!context,
      accountId: context.split(":")[0] ?? "",
    });
    const activePage = () =>
      generation === this.generation && dataMode() === "live";
    const current = () => activePage() && context === sessionClient.context();
    try {
      if (this.projectId) {
        const participation = await participationClient.state(this.projectId);
        if (!current()) return;
        const careRequests = await participationClient.careRequests(
          this.projectId,
        );
        if (current()) this.setData({ participation, careRequests });
      } else if (this.inviteToken) {
        const invitation = await participationClient.preview(this.inviteToken);
        if (current()) this.setData({ invitation });
      } else if (context) {
        const result = await participationClient.memberships();
        if (current())
          this.setData({
            memberships: result.projects,
            status: result.projects.length
              ? "选择参与项目"
              : "还没有参与项目，请使用本人邀请入口",
          });
      }
    } catch (error) {
      if (this.recoverExpiredSession(error, generation, context)) return;
      if (current())
        this.setData({
          status:
            error instanceof ApiFailure && error.status === 403
              ? "等待发起人核对申请；旧账号或无权限账号不能读取项目"
              : error instanceof Error
                ? error.message
                : "查询失败",
        });
    } finally {
      if (current()) this.setData({ busy: false });
    }
  },
  async loginLive() {
    if (this.data.busy) return;
    const generation = ++this.generation;
    this.setData({ busy: true, status: "", participation: null });
    try {
      await sessionClient.login();
      if (generation === this.generation) await this.refreshLive();
    } catch (error) {
      if (generation === this.generation)
        this.setData({
          busy: false,
          status: error instanceof Error ? error.message : "登录失败",
        });
    }
  },
  async openParticipation(e: E) {
    this.projectId = e.currentTarget.dataset.id;
    this.setData({ statusProjectId: this.projectId });
    await this.refreshLive();
  },
  async chooseConsent(e: E) {
    const state = this.data.participation;
    const purpose = e.currentTarget.dataset.purpose as ConsentPurpose;
    const granted = e.currentTarget.dataset.granted === "true";
    if (
      !state ||
      this.data.busy ||
      state.role !== "narrator" ||
      (state.policyStatus !== "synthetic-only" &&
        state.policyStatus !== "internal-acceptance") ||
      !CONSENT_PURPOSES.includes(purpose)
    )
      return;
    const input = JSON.stringify({
      id: state.projectId,
      purpose,
      granted,
      epoch: state.accessEpoch,
      version: state.bindingVersion,
    });
    if (this.intent?.input !== input)
      this.intent = { input, key: paymentKey() };
    const context = sessionClient.context();
    const generation = this.generation;
    this.setData({ busy: true, status: "" });
    try {
      const participation = await participationClient.choose(
        state,
        purpose,
        granted,
        this.intent.key,
      );
      if (
        context === sessionClient.context() &&
        generation === this.generation
      ) {
        this.intent = null;
        this.setData({ participation, status: "用途选择已保存" });
      }
    } catch (error) {
      if (this.recoverExpiredSession(error, generation, context)) return;
      if (context === sessionClient.context() && generation === this.generation)
        this.setData({
          participation: null,
          status:
            error instanceof Error ? error.message : "保存未确认，请重新查询",
        });
    } finally {
      if (context === sessionClient.context() && generation === this.generation)
        this.setData({ busy: false });
    }
  },
  toggleDetails() {
    this.setData({ showDetails: !this.data.showDetails });
  },
  toggleManagement() {
    this.setData({ showManagement: !this.data.showManagement });
  },
  async confirmAndStart() {
    const state = this.data.participation;
    if (
      !state ||
      this.data.busy ||
      state.role !== "narrator" ||
      !["synthetic-only", "internal-acceptance"].includes(state.policyStatus)
    )
      return;
    const input = JSON.stringify({
      action: "start",
      projectId: state.projectId,
      notice: state.noticeVersion,
      binding: state.bindingVersion,
      epoch: state.accessEpoch,
    });
    if (this.intent?.input !== input)
      this.intent = { input, key: paymentKey() };
    const context = sessionClient.context(),
      generation = this.generation;
    this.setData({ busy: true, status: "" });
    try {
      const participation = await participationClient.start(
        state,
        this.intent.key,
      );
      if (context !== sessionClient.context() || generation !== this.generation)
        return;
      this.intent = null;
      this.setData({ participation });
      if (
        participation.canCollect &&
        participation.canProcessAi &&
        CONSENT_PURPOSES.every((purpose) =>
          participation.choices.some(
            (choice) => choice.purpose === purpose && choice.granted,
          ),
        )
      )
        go(
          "interview",
          `projectId=${state.projectId}&draftId=${recordingId()}&prepare=1`,
        );
      else this.setData({ status: "用途保存后仍未取得开始权限，请重新查询" });
    } catch (error) {
      if (this.recoverExpiredSession(error, generation, context)) return;
      if (context === sessionClient.context() && generation === this.generation)
        this.setData({
          status:
            error instanceof Error ? error.message : "开始结果未确认，请重试",
        });
    } finally {
      if (context === sessionClient.context() && generation === this.generation)
        this.setData({ busy: false });
    }
  },
  targetInput(e: E) {
    this.setData({ targetUserId: e.detail.value.trim() });
  },
  async requestRebind() {
    const state = this.data.participation;
    if (!state || this.data.busy || !this.data.targetUserId) return;
    const context = sessionClient.context();
    const generation = this.generation;
    const input = JSON.stringify({
      projectId: state.projectId,
      target: this.data.targetUserId,
      version: state.bindingVersion,
    });
    if (this.intent?.input !== input)
      this.intent = { input, key: paymentKey() };
    this.setData({ busy: true, status: "", supportCaseRef: "" });
    try {
      const care = await participationClient.care(
        state,
        this.data.targetUserId,
        this.intent.key,
      );
      if (context !== sessionClient.context() || generation !== this.generation)
        return;
      const careRequests = await participationClient.careRequests(
        state.projectId,
      );
      if (
        context === sessionClient.context() &&
        generation === this.generation
      ) {
        this.intent = null;
        this.setData({
          supportCaseRef: care.supportCaseRef,
          careRequests,
          status:
            state.bindingVersion === 0
              ? "本人账号绑定申请已记录，须由客服核验本人；此申请不会授予目标账号权限"
              : "换绑申请已记录，须由客服核验本人；此申请不会授予目标账号权限",
        });
      }
    } catch (error) {
      if (this.recoverExpiredSession(error, generation, context)) return;
      if (context === sessionClient.context() && generation === this.generation)
        this.setData({
          status: error instanceof Error ? error.message : "申请未确认",
        });
    } finally {
      if (context === sessionClient.context() && generation === this.generation)
        this.setData({ busy: false });
    }
  },
  agree() {
    this.setData({ agreed: !this.data.agreed });
  },
  async accept() {
    if (dataMode() === "live") {
      if (
        this.data.busy ||
        !this.data.invitation ||
        !sessionClient.context() ||
        (this.data.invitation.policyStatus !== "synthetic-only" &&
          this.data.invitation.policyStatus !== "internal-acceptance")
      )
        return;
      const context = sessionClient.context();
      const generation = this.generation;
      this.setData({ busy: true, status: "" });
      try {
        const application = await participationClient.apply(
          this.inviteToken,
          this.data.invitation.noticeVersion,
        );
        if (
          context === sessionClient.context() &&
          generation === this.generation
        ) {
          this.projectId = application.projectId;
          this.setData({
            invitation: null,
            status: "已申请参与，等待发起人核对；申请不授予内容权限",
          });
        }
      } catch (error) {
        if (this.recoverExpiredSession(error, generation, context)) return;
        if (
          context === sessionClient.context() &&
          generation === this.generation
        )
          this.setData({
            status: error instanceof Error ? error.message : "申请失败",
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
    const p = required();
    p.consent = true;
    p.role = "narrator";
    save(p);
    home();
  },
  async requestDelete() {
    const state = this.data.participation;
    if (
      this.data.busy ||
      state?.role !== "narrator" ||
      (state.policyStatus !== "synthetic-only" &&
        state.policyStatus !== "internal-acceptance")
    )
      return;
    const context = sessionClient.context(),
      generation = this.generation;
    const input = JSON.stringify({
      projectId: state.projectId,
      kind: "delete",
      version: state.bindingVersion,
    });
    if (this.intent?.input !== input)
      this.intent = { input, key: paymentKey() };
    this.setData({ busy: true, status: "" });
    try {
      const request = await participationClient.subjectCare(
        state,
        "delete",
        this.intent.key,
      );
      if (generation !== this.generation || context !== sessionClient.context())
        return;
      this.intent = null;
      this.setData({
        supportCaseRef: request.supportCaseRef,
        status: "本人删除申请已记录，待客服核验；尚未确认在线访问停止。",
      });
    } catch (error) {
      if (this.recoverExpiredSession(error, generation, context)) return;
      if (generation === this.generation && context === sessionClient.context())
        this.setData({
          status: "申请结果未确认，请查询进度或重试；重试保留同一申请。",
        });
    } finally {
      if (generation === this.generation && context === sessionClient.context())
        this.setData({ busy: false });
    }
  },
  deletion() {
    if (this.projectId) go("deletion-status", `projectId=${this.projectId}`);
  },
  project() {
    go("project", `projectId=${this.projectId}`);
  },
  plan() {
    go("plan", `projectId=${this.projectId}`);
  },
  assisted() {
    go("assisted", `projectId=${this.projectId}`);
  },
  privacy() {
    go("service", "kind=privacy");
  },
  decline() {
    home("home");
  },
  back() {
    home();
  },
});
