import type { WithdrawalStatus } from "../../../packages/contracts/src";
import { go } from "../../services/store";
import { dataMode, setDataMode } from "../../services/mode";
import { sessionClient, ApiFailure } from "../../services/session";
import {
  participationClient,
  withdrawalDisposition,
} from "../../services/participation";
import { paymentKey } from "../../services/payments";
import {
  CONSENT_PURPOSES,
  type ConsentPurpose,
  type ParticipationState,
  type AssistedSessionView,
  type ProjectCareRequestView,
} from "../../../packages/contracts/src";
type E = { currentTarget: { dataset: Record<string, string> } };
function localTime(value: string) {
  const date = new Date(value),
    pad = (n: number) => String(n).padStart(2, "0");
  const offset = -date.getTimezoneOffset(),
    zone = `${offset >= 0 ? "+" : "-"}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}（设备时间 UTC${zone}）`;
}
Page({
  data: {
    withdrawal: null as WithdrawalStatus | null,
    productionDisposition: "",
    participation: null as ParticipationState | null,
    sessions: [] as (AssistedSessionView & { expiresAtLabel: string })[],
    careRequests: [] as ProjectCareRequestView[],
    busy: false,
    status: "",
    loggedIn: false,
    targetUserId: "",
    storyPurpose: false,
    bookPurpose: false,
    storyEvidence: "",
    purposes: [
      { purpose: "collection", label: "采集并保存讲述和照片" },
      { purpose: "ai", label: "交由 AI 处理素材" },
      { purpose: "sharing", label: "向本项目发起人共享资料" },
    ],
  },
  projectId: "",
  storyId: "",
  bookVersionId: "",
  productionReturn: false,
  interviewId: "",
  generation: 0,
  ownerContext: "",
  stopSessionWatch: undefined as (() => void) | undefined,
  intent: null as { input: string; key: string } | null,
  onLoad(q) {
    this.projectId = q.projectId ?? "";
    this.storyId = q.storyId ?? "";
    this.bookVersionId = q.bookVersionId ?? "";
    this.productionReturn = q.returnTo === "production";
    this.interviewId = q.interviewId ?? "";
    this.setData({
      storyPurpose: q.purpose === "story_confirmation" && !!this.storyId,
      bookPurpose: q.purpose === "book_confirmation" && !!this.bookVersionId,
    });
    setDataMode("live");
  },
  onHide() {
    this.setData({ withdrawal: null, productionDisposition: "" });
    ++this.generation;
    this.ownerContext = "";
    this.stopSessionWatch?.();
    this.stopSessionWatch = undefined;
    this.intent = null;
    this.setData({
      participation: null,
      sessions: [],
      careRequests: [],
      busy: false,
      loggedIn: false,
      targetUserId: "",
      storyEvidence: "",
    });
  },
  storyEvidence(e: { detail: { value: string } }) {
    this.setData({ storyEvidence: e.detail.value });
  },
  async startStoryConfirmation(e: E) {
    const current = this.data.participation,
      granted = e.currentTarget.dataset.granted === "true",
      evidence = this.data.storyEvidence.trim();
    if (
      (!this.data.storyPurpose && !this.data.bookPurpose) ||
      !current ||
      this.data.busy ||
      current.policyStatus !== "synthetic-only"
    )
      return;
    if (!/^[^\r\n]{3,160}$/.test(evidence)) {
      this.setData({ status: "请记录 3 至 160 字的本人当次选择说明（单行）" });
      return;
    }
    const purpose = this.data.bookPurpose
      ? "book_confirmation"
      : "story_confirmation";
    const expectedSessionId = this.data.sessions.find(
      (s) => s.purpose === purpose,
    )?.id;
    const input = {
      purpose,
      granted,
      noticeVersion: current.noticeVersion,
      evidenceRef: `synthetic:${evidence}`,
      expectedBindingVersion: current.bindingVersion,
      expectedAccessEpoch: current.accessEpoch,
      ...(expectedSessionId ? { expectedSessionId } : {}),
    };
    const key = this.key(JSON.stringify(input));
    await this.perform(async (generation, context) => {
      const session = await sessionClient.request<AssistedSessionView>(
        `/projects/${this.projectId}/assisted-sessions`,
        { key, data: input },
      );
      if (!this.current(generation, context)) return;
      this.intent = null;
      if (!granted) {
        this.setData({
          status: `本人拒绝已保存；不会进入${this.data.bookPurpose ? "书稿" : "故事"}确认`,
          storyEvidence: "",
        });
        return;
      }
      if (
        session.purpose !== purpose ||
        session.state !== "active" ||
        !/^[0-9a-f-]{36}$/.test(session.id)
      )
        throw new Error("当次内容确认协助尚未生效，请重新查询");
      if (this.data.bookPurpose && this.productionReturn) {
        go(
          "production",
          `projectId=${this.projectId}&assistedSessionId=${session.id}`,
        );
        return;
      }
      if (this.data.bookPurpose) {
        go(
          "print",
          `projectId=${this.projectId}&versionId=${this.bookVersionId}&assistedSessionId=${session.id}`,
        );
        return;
      }
      go(
        "story",
        `projectId=${this.projectId}&storyId=${this.storyId}${this.interviewId ? `&interviewId=${this.interviewId}` : ""}&assistedSessionId=${session.id}`,
      );
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
    if (!this.data.busy) await this.refresh();
  },
  current(generation: number, context: string) {
    return (
      generation === this.generation &&
      dataMode() === "live" &&
      context === sessionClient.context()
    );
  },
  async load(generation: number, context: string) {
    const participation = await participationClient.state(this.projectId);
    if (!this.current(generation, context)) return;
    if (participation.role !== "initiator")
      throw new Error("请使用发起人账号协助；本人账号可在参与页选择用途");
    const sessions = await participationClient.assistedSessions(this.projectId);
    if (!this.current(generation, context)) return;
    const careRequests = await participationClient.careRequests(this.projectId);
    if (this.current(generation, context))
      this.setData({
        participation,
        sessions: sessions.map((row) => ({
          ...row,
          expiresAtLabel: localTime(row.expiresAt),
        })),
        careRequests,
      });
  },
  async perform(work: (generation: number, context: string) => Promise<void>) {
    if (this.data.busy) return;
    const generation = ++this.generation;
    const context = sessionClient.context();
    this.ownerContext = context;
    this.stopSessionWatch?.();
    this.stopSessionWatch = undefined;
    if (context)
      this.stopSessionWatch = sessionClient.onInvalidated((lost) => {
        if (lost !== context || this.ownerContext !== context) return;
        this.onHide();
        this.setData({
          status: sessionClient.sessionCleanupPending()
            ? "登录已失效；设备会话缓存清理失败，请重试登录"
            : "登录已失效，请重新登录",
        });
      });
    this.setData({ busy: true, status: "", loggedIn: !!context });
    try {
      await work(generation, context);
    } catch (error) {
      if (generation !== this.generation || dataMode() !== "live") return;
      if (
        context &&
        !sessionClient.context() &&
        error instanceof ApiFailure &&
        (error.status === 401 || error.code === "STALE_RESPONSE")
      ) {
        this.setData({
          busy: false,
          loggedIn: false,
          participation: null,
          sessions: [],
          careRequests: [],
          status: "登录已失效，请重新登录",
        });
        return;
      }
      if (this.current(generation, context))
        this.setData({
          participation: null,
          sessions: [],
          status:
            error instanceof ApiFailure && error.status === 409
              ? "状态已变化，操作未确认，请重新查询后选择"
              : error instanceof Error
                ? `操作未确认，请重新查询。${error.message}`
                : "操作未确认，请重新查询",
        });
    } finally {
      if (this.current(generation, context)) this.setData({ busy: false });
      else if (
        generation === this.generation &&
        dataMode() === "live" &&
        sessionClient.context()
      )
        this.setData({
          busy: false,
          participation: null,
          sessions: [],
          careRequests: [],
          loggedIn: true,
          status: "账号已变化，请重新查询",
        });
    }
  },
  record() {
    const latest = this.data.sessions.find(
      (row) => row.purpose === "collection" && row.state === "active",
    );
    if (latest)
      go(
        "interview",
        `projectId=${this.projectId}&assistedSessionId=${latest.id}`,
      );
  },
  async refresh() {
    await this.perform(async (generation, context) => {
      this.setData({ participation: null, sessions: [], careRequests: [] });
      await this.load(generation, context);
    });
  },
  async login() {
    if (this.data.busy) return;
    const generation = ++this.generation;
    this.setData({ busy: true, status: "" });
    try {
      await sessionClient.login();
      if (generation === this.generation) {
        this.setData({ busy: false });
        await this.refresh();
      }
    } catch (error) {
      if (generation === this.generation)
        this.setData({
          busy: false,
          status: error instanceof Error ? error.message : "登录失败，请重试",
        });
    }
  },
  key(input: string) {
    if (this.intent?.input !== input)
      this.intent = { input, key: paymentKey() };
    return this.intent!.key;
  },
  async chooseAssisted(e: E) {
    const current = this.data.participation;
    const purpose = e.currentTarget.dataset.purpose as ConsentPurpose;
    const granted = e.currentTarget.dataset.granted === "true";
    if (
      !current ||
      this.data.busy ||
      current.policyStatus !== "synthetic-only" ||
      !CONSENT_PURPOSES.includes(purpose)
    )
      return;
    const expectedSessionId = this.data.sessions.find(
      (row) => row.purpose === purpose,
    )?.id;
    const key = this.key(
      JSON.stringify({
        expectedSessionId,
        purpose,
        granted,
        epoch: current.accessEpoch,
        binding: current.bindingVersion,
      }),
    );
    await this.perform(async (generation, context) => {
      await participationClient.assisted(
        current,
        purpose,
        granted,
        key,
        expectedSessionId,
      );
      if (!this.current(generation, context)) return;
      this.intent = null;
      await this.load(generation, context);
      if (this.current(generation, context))
        this.setData({
          status: granted
            ? "当次协助许可已保存；录音功能待后续接入，故事和书稿仍须另行逐次确认"
            : "本人拒绝已保存，该用途不能继续操作",
        });
    });
  },
  async requestRight(e: E) {
    const current = this.data.participation;
    const kind = e.currentTarget.dataset.kind as
      "withdraw" | "export" | "delete";
    if (
      !current ||
      this.data.busy ||
      current.policyStatus !== "synthetic-only" ||
      !["withdraw", "export", "delete"].includes(kind)
    )
      return;
    const key = this.key(
      JSON.stringify({ kind, binding: current.bindingVersion }),
    );
    await this.perform(async (generation, context) => {
      await participationClient.subjectCare(current, kind, key);
      if (!this.current(generation, context)) return;
      this.intent = null;
      const careRequests = await participationClient.careRequests(
        current.projectId,
      );
      if (this.current(generation, context))
        this.setData({
          careRequests,
          status: "本人申请已记录，等待客服核验；导出交付与删除执行尚未完成",
        });
    });
  },
  deletion() {
    if (this.projectId) go("deletion-status", `projectId=${this.projectId}`);
  },
  plan() {
    go("plan", `projectId=${this.projectId}`);
  },
  back() {
    go("welcome", `projectId=${this.projectId}`);
  },
});
