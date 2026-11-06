import type {
  PersonalPlan,
  PlanContent,
  PlanQuestionState,
} from "../../../packages/contracts/src";
import { personalPlanClient } from "../../services/personal-plan";
import { sessionClient } from "../../services/session";
import { paymentKey } from "../../services/payments";
import { markEditing } from "../../services/book-editor";
const states = [
  "ready",
  "later",
  "skipped",
  "not-applicable",
  "blocked",
] as const;
Page({
  data: {
    text: "",
    stateIndex: 0,
    labels: ["可以聊", "稍后再说", "跳过", "不适用", "不再问"],
    busy: false,
    pageLoading: true,
    status: "",
    existing: false,
  },
  projectId: "",
  key: "",
  plan: null as PersonalPlan | null,
  generation: 0,
  onLoad(q) {
    this.projectId = q.projectId || "";
    this.key = decodeURIComponent(q.key || "");
    this.setData({ existing: !!this.key });
  },
  async onShow() {
    const n = ++this.generation,
      owner = sessionClient.context();
    this.setData({ busy: true, pageLoading: !this.plan, status: "" });
    try {
      const p = await personalPlanClient.read(this.projectId);
      if (n !== this.generation || owner !== sessionClient.context()) return;
      this.plan = p;
      const question = p.chapters
          .flatMap((c) => c.questions)
          .find((q) => q.key === this.key),
        state = p.preferences.blockedTopics.includes(this.key)
          ? "blocked"
          : p.questionStates.find((q) => q.questionKey === this.key)?.state ||
            "ready";
      this.setData({
        text: question?.text || "",
        stateIndex: Math.max(0, states.indexOf(state)),
      });
    } catch (e) {
      this.setData({ status: e instanceof Error ? e.message : "读取失败" });
    } finally {
      this.setData({ busy: false, pageLoading: false });
    }
  },
  onHide() {
    ++this.generation;
  },
  onUnload() {
    markEditing(false);
  },
  input(e: WechatMiniprogram.Input) {
    this.setData({ text: e.detail.value });
    markEditing(true);
  },
  state(e: WechatMiniprogram.PickerChange) {
    this.setData({ stateIndex: Number(e.detail.value) });
    markEditing(true);
  },
  async save() {
    let p = this.plan;
    if (!p || this.data.busy) return;
    if (!this.data.text.trim()) {
      this.setData({ status: "请填写想聊的话题" });
      return;
    }
    this.setData({ busy: true, status: "" });
    try {
      this.key ||= `custom-${paymentKey()}`;
      const question = {
        key: this.key,
        text: this.data.text.trim(),
        intent: "记录一段往事",
        optionalContext: [],
        sensitivityTags: [],
        followupCandidates: [],
        locale: "zh-CN" as const,
      };
      const content: PlanContent = {
        chapters: p.chapters.map((c) => ({
          ...c,
          questions: c.questions.map((q) =>
            q.key === this.key ? { ...q, text: question.text } : q,
          ),
        })),
        starters: p.starters,
      };
      if (
        !p.chapters.some((c) => c.questions.some((q) => q.key === this.key))
      ) {
        if (!content.chapters.length)
          content.chapters.push({
            key: "my-topics",
            title: "想聊的往事",
            questions: [],
          });
        content.chapters[0].questions.push(question);
      }
      p = await personalPlanClient.revise(this.projectId, p.revision, content);
      this.plan = p;
      const state = states[this.data.stateIndex],
        topics = p.preferences.blockedTopics.filter((t) => t !== this.key);
      if (state === "blocked") topics.push(this.key);
      const selections: PlanQuestionState[] = [
        ...p.questionStates.filter((q) => q.questionKey !== this.key),
        { questionKey: this.key, state: state === "blocked" ? "ready" : state },
      ];
      this.plan = await personalPlanClient.decide(p, selections, topics);
      markEditing(false);
      wx.navigateBack();
    } catch (e) {
      this.setData({ status: e instanceof Error ? e.message : "未能保存" });
    } finally {
      this.setData({ busy: false });
    }
  },
});
