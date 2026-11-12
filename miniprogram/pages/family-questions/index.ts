import type {
  FamilyQuestion,
  PersonalPlan,
} from "../../../packages/contracts/src";
import {
  familyQuestionClient,
  familyQuestionSource,
  familyQuestionState,
} from "../../services/family-questions";
import { personalPlanClient } from "../../services/personal-plan";
import { sessionClient } from "../../services/session";
import { go } from "../../services/navigation";
Page({
  data: {
    tab: "pending",
    questions: [] as (FamilyQuestion & {
      source: string;
      chapter: string;
      stateLabel: string;
    })[],
    total: 0,
    busy: false,
    pageLoading: true,
    status: "",
    emptyLabel: "暂无待回答的问题",
  },
  projectId: "",
  generation: 0,
  questions: [] as FamilyQuestion[],
  plan: null as PersonalPlan | null,
  onLoad(q) {
    this.projectId = q.projectId || "";
  },
  async onShow() {
    const n = ++this.generation,
      owner = sessionClient.context();
    this.setData({ busy: true, status: "" });
    try {
      const [list, plan] = await Promise.all([
        familyQuestionClient.list(this.projectId),
        personalPlanClient.read(this.projectId),
      ]);
      if (n !== this.generation || owner !== sessionClient.context()) return;
      this.questions = list.questions;
      this.plan = plan;
      this.apply();
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
  apply() {
    this.setData({
      total: this.questions.length,
      questions: this.questions
        .filter((q) =>
          this.data.tab === "answered"
            ? !!q.story
            : this.data.tab === "skipped"
              ? !q.story && q.state === "skipped"
              : !q.story && q.state !== "skipped",
        )
        .map((q) => ({
          ...q,
          source: familyQuestionSource(q),
          chapter:
            this.plan?.chapters.find((c) => c.key === q.chapterKey)?.title ||
            "未选章节",
          stateLabel: familyQuestionState(q),
        })),
      emptyLabel:
        this.data.tab === "answered"
          ? "暂无已回答的问题"
          : this.data.tab === "skipped"
            ? "暂无跳过的问题"
            : "暂无待回答的问题",
    });
  },
  tab(e: WechatMiniprogram.TouchEvent) {
    this.setData({ tab: e.currentTarget.dataset.tab });
    this.apply();
  },
  open(e: WechatMiniprogram.TouchEvent) {
    go(
      "family-question",
      `projectId=${this.projectId}&id=${e.currentTarget.dataset.id}`,
    );
  },
  add() {
    go("family-question-edit", `projectId=${this.projectId}`);
  },
  onHide() {
    ++this.generation;
    this.questions = [];
    this.plan = null;
    this.setData({ questions: [], total: 0, pageLoading: true, busy: false });
  },
});
