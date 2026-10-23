import { go } from "../../services/store";
import { dataMode, setDataMode } from "../../services/mode";
import { sessionClient, ApiFailure } from "../../services/session";
import { participationClient } from "../../services/participation";
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
    participation: null as ParticipationState | null,
    sessions: [] as (AssistedSessionView & { expiresAtLabel: string })[],
    careRequests: [] as ProjectCareRequestView[],
    busy: false,
    status: "",
    loggedIn: false,
    targetUserId: "",
    purposes: [
      { purpose: "collection", label: "采集并保存讲述和照片" },
      { purpose: "ai", label: "交由 AI 处理素材" },
      { purpose: "sharing", label: "向本项目发起人共享资料" },
    ],
  },
  projectId: "",
  generation: 0,
  intent: null as { input: string; key: string } | null,
  onLoad(q) {
    this.projectId = q.projectId ?? "";
    setDataMode("live");
  },
  onHide() {
    ++this.generation;
    this.setData({
      participation: null,
      sessions: [],
      careRequests: [],
      busy: false,
    });
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
  plan() {
    go("plan", `projectId=${this.projectId}`);
  },
  back() {
    go("welcome", `projectId=${this.projectId}`);
  },
});
