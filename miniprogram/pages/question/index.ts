import type {
  PersonalPlan,
  PlanQuestionState,
} from "../../../packages/contracts/src";
import { personalPlanClient } from "../../services/personal-plan";
import { startOutlineAnswer } from "../../services/outline";
import { sessionClient } from "../../services/session";
import { go } from "../../services/store";
Page({
  data: {
    text: "",
    chapter: "",
    state: "",
    storyId: "",
    busy: false,
    pageLoading: true,
    status: "",
  },
  projectId: "",
  key: "",
  plan: null as PersonalPlan | null,
  generation: 0,
  onLoad(q) {
    this.projectId = q.projectId || "";
    this.key = decodeURIComponent(q.key || "");
  },
  async onShow() {
    const n = ++this.generation,
      owner = sessionClient.context();
    this.setData({ busy: true, pageLoading: !this.plan, status: "" });
    try {
      const plan = await personalPlanClient.read(this.projectId);
      if (n !== this.generation || owner !== sessionClient.context()) return;
      this.plan = plan;
      const chapter = plan.chapters.find((c) =>
        c.questions.some((q) => q.key === this.key),
      );
      const q = chapter?.questions.find((q) => q.key === this.key);
      if (!q) throw new Error("问题已移除，请返回章节");
      const answer = plan.answers.find((a) => a.questionKey === this.key);
      const state =
        plan.questionStates.find((s) => s.questionKey === this.key)?.state ||
        "ready";
      this.setData({
        text: q.text,
        chapter: answer
          ? plan.chapters.find((c) => c.key === answer.chapterKey)?.title ||
            "未归章"
          : chapter!.title,
        storyId: answer?.storyId || "",
        state: answer
          ? "已回答"
          : {
              ready: "待回答",
              later: "稍后回答",
              skipped: "已跳过",
              "not-applicable": "不适用",
            }[state],
      });
    } catch (e) {
      if (n === this.generation)
        this.setData({ status: e instanceof Error ? e.message : "读取失败" });
    } finally {
      if (n === this.generation)
        this.setData({ busy: false, pageLoading: false });
    }
  },
  onHide() {
    ++this.generation;
    this.plan = null;
    this.setData({ text: "", chapter: "", storyId: "", busy: false });
  },
  edit() {
    go(
      "question-edit",
      `projectId=${this.projectId}&key=${encodeURIComponent(this.key)}`,
    );
  },
  story() {
    if (this.data.storyId)
      go("story", `projectId=${this.projectId}&storyId=${this.data.storyId}`);
  },
  async answer() {
    if (!this.plan || this.data.busy) return;
    this.setData({ busy: true, status: "" });
    try {
      await startOutlineAnswer(this.projectId, this.plan.revision, this.key);
    } catch (e) {
      this.setData({ status: e instanceof Error ? e.message : "无法开始回答" });
    } finally {
      this.setData({ busy: false });
    }
  },
  async state(e: WechatMiniprogram.TouchEvent) {
    if (!this.plan || this.data.busy) return;
    const state = e.currentTarget.dataset.state as PlanQuestionState["state"];
    this.setData({ busy: true, status: "" });
    try {
      this.plan = await personalPlanClient.decide(
        this.plan,
        [
          ...this.plan.questionStates.filter((q) => q.questionKey !== this.key),
          { questionKey: this.key, state },
        ],
        this.plan.preferences.blockedTopics,
      );
      wx.navigateBack();
    } catch (e) {
      this.setData({ status: e instanceof Error ? e.message : "未能保存" });
    } finally {
      this.setData({ busy: false });
    }
  },
});
