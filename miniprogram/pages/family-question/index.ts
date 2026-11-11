import type {
  FamilyQuestion,
  PersonalPlan,
} from "../../../packages/contracts/src";
import {
  familyQuestionClient,
  familyQuestionSource,
  familyQuestionState,
  startFamilyAnswer,
} from "../../services/family-questions";
import { personalPlanClient } from "../../services/personal-plan";
import { questionSession } from "../../services/question-recommendations";
import { sessionClient } from "../../services/session";
import { go } from "../../services/store";
Page({
  data: {
    question: null as FamilyQuestion | null,
    source: "",
    chapter: "",
    state: "",
    busy: false,
    pageLoading: true,
    status: "",
  },
  projectId: "",
  id: "",
  generation: 0,
  plan: null as PersonalPlan | null,
  onLoad(q) {
    this.projectId = q.projectId || "";
    this.id = q.id || "";
  },
  async onShow() {
    const n = ++this.generation,
      owner = sessionClient.context();
    this.setData({ busy: true, status: "" });
    try {
      const [question, plan] = await Promise.all([
        familyQuestionClient.read(this.projectId, this.id),
        personalPlanClient.read(this.projectId),
      ]);
      if (n !== this.generation || owner !== sessionClient.context()) return;
      this.plan = plan;
      this.apply(question);
    } catch (e) {
      if (n === this.generation)
        this.setData({
          status: e instanceof Error ? e.message : "问题未能读取",
        });
    } finally {
      if (n === this.generation)
        this.setData({ busy: false, pageLoading: false });
    }
  },
  apply(question: FamilyQuestion) {
    this.setData({
      question,
      source: familyQuestionSource(question),
      chapter:
        this.plan?.chapters.find((c) => c.key === question.chapterKey)?.title ||
        "未选章节",
      state: familyQuestionState(question),
    });
  },
  edit() {
    go("family-question-edit", `projectId=${this.projectId}&id=${this.id}`);
  },
  story() {
    if (this.data.question?.story)
      go(
        "story",
        `projectId=${this.projectId}&storyId=${this.data.question.story.id}`,
      );
  },
  async answer() {
    if (!this.plan || this.data.busy) return;
    this.setData({ busy: true, status: "" });
    try {
      await startFamilyAnswer(this.projectId, this.plan.revision, this.id);
    } catch (e) {
      this.setData({ status: e instanceof Error ? e.message : "暂时无法开始" });
    } finally {
      this.setData({ busy: false });
    }
  },
  async state(e: WechatMiniprogram.TouchEvent) {
    if (!this.data.question || this.data.busy) return;
    const state = e.currentTarget.dataset.state as FamilyQuestion["state"];
    this.setData({ busy: true, status: "" });
    try {
      this.apply(await familyQuestionClient.state(this.data.question, state));
      if (state === "later")
        questionSession(this.projectId).defer(`family:${this.id}`);
      else if (state === "ready")
        questionSession(this.projectId).restore(`family:${this.id}`);
      wx.showToast({
        title:
          state === "later"
            ? "本次先不推荐"
            : state === "skipped"
              ? "已跳过，可随时恢复"
              : "已恢复到待回答",
        icon: "none",
      });
    } catch (e) {
      this.setData({ status: e instanceof Error ? e.message : "未能保存" });
    } finally {
      this.setData({ busy: false });
    }
  },
  remove() {
    const q = this.data.question;
    if (!q || this.data.busy) return;
    wx.showModal({
      title: "移除问题",
      content: "已有录音和故事仍保留。",
      confirmText: "移除问题",
      success: async (r) => {
        if (!r.confirm) return;
        this.setData({ busy: true, status: "" });
        try {
          await familyQuestionClient.remove(q);
          wx.navigateBack();
        } catch (e) {
          this.setData({ status: e instanceof Error ? e.message : "未能移除" });
        } finally {
          this.setData({ busy: false });
        }
      },
    });
  },
  onHide() {
    ++this.generation;
    this.plan = null;
    this.setData({
      question: null,
      source: "",
      chapter: "",
      pageLoading: true,
      busy: false,
    });
  },
});
