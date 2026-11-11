import type { PersonalPlan, StoryView } from "../../../packages/contracts/src";
import { personalPlanClient } from "../../services/personal-plan";
import { projectOverviewClient } from "../../services/project-overview";
import { sessionClient } from "../../services/session";
import { go } from "../../services/store";
Page({
  data: {
    title: "",
    number: 0,
    tab: "questions",
    sorting: false,
    questions: [] as {
      id: string;
      title: string;
      text: string;
      state: string;
    }[],
    stories: [] as { id: string; title: string }[],
    busy: false,
    pageLoading: true,
    status: "",
  },
  projectId: "",
  key: "",
  plan: null as PersonalPlan | null,
  stories: [] as StoryView[],
  generation: 0,
  onLoad(q) {
    this.projectId = q.projectId || "";
    this.key = decodeURIComponent(q.chapter || "");
  },
  async onShow() {
    const n = ++this.generation,
      owner = sessionClient.context();
    this.setData({ busy: true, pageLoading: !this.plan, status: "" });
    try {
      const [plan, overview] = await Promise.all([
        personalPlanClient.read(this.projectId),
        projectOverviewClient.read(this.projectId),
      ]);
      if (n !== this.generation || owner !== sessionClient.context()) return;
      this.stories = overview.stories;
      this.apply(plan);
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
    this.setData({ questions: [], stories: [], title: "", busy: false });
  },
  apply(plan: PersonalPlan) {
    const c = plan.chapters.find((c) => c.key === this.key);
    if (!c) throw new Error("章节已移除，请返回目录");
    this.plan = plan;
    this.setData({
      title: c.title,
      number: plan.chapters.indexOf(c) + 1,
      questions: c.questions.map((q) => ({
        id: q.key,
        title: q.text,
        text: q.text,
        state: plan.answers.some((a) => a.questionKey === q.key)
          ? "已回答"
          : {
              later: "稍后回答",
              skipped: "已跳过",
              "not-applicable": "不适用",
              ready: "待回答",
            }[
              plan.questionStates.find((s) => s.questionKey === q.key)?.state ||
                "ready"
            ],
      })),
      stories: c.storyRefs.map((id) => ({
        id,
        title: this.stories.find((s) => s.id === id)?.revision?.title || "故事",
      })),
    });
  },
  tab(e: WechatMiniprogram.TouchEvent) {
    this.setData({ tab: e.currentTarget.dataset.tab, sorting: false });
  },
  question(e: WechatMiniprogram.TouchEvent) {
    go(
      "question",
      `projectId=${this.projectId}&key=${encodeURIComponent(e.currentTarget.dataset.id)}`,
    );
  },
  story(e: WechatMiniprogram.TouchEvent) {
    go(
      "story",
      `projectId=${this.projectId}&storyId=${e.currentTarget.dataset.id}`,
    );
  },
  edit() {
    go(
      "chapter",
      `projectId=${this.projectId}&chapter=${encodeURIComponent(this.key)}`,
    );
  },
  add() {
    go(
      "question-edit",
      `projectId=${this.projectId}&chapter=${encodeURIComponent(this.key)}`,
    );
  },
  manage() {
    go(
      "chapter-stories",
      `projectId=${this.projectId}&chapter=${encodeURIComponent(this.key)}`,
    );
  },
  sort() {
    this.setData({ sorting: !this.data.sorting });
  },
  async reorder(e: WechatMiniprogram.CustomEvent<{ ids: string[] }>) {
    const p = this.plan;
    if (!p || this.data.busy) return;
    this.setData({ busy: true, status: "" });
    try {
      this.apply(
        await personalPlanClient.revise(this.projectId, p.revision, {
          chapters: p.chapters.map((c) =>
            c.key === this.key
              ? {
                  ...c,
                  questions: e.detail.ids.map((id) =>
                    c.questions.find((q) => q.key === id)!,
                  ),
                }
              : c,
          ),
          starters: p.starters,
        }),
      );
    } catch (e) {
      this.setData({ status: e instanceof Error ? e.message : "顺序未保存" });
    } finally {
      this.setData({ busy: false });
    }
  },
});
