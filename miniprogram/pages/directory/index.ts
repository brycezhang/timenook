import type {
  PersonalPlan,
  PlanChapter,
} from "../../../packages/contracts/src";
import { personalPlanClient } from "../../services/personal-plan";
import { projectOverviewClient } from "../../services/project-overview";
import { sessionClient } from "../../services/session";
import { startOutlineAnswer } from "../../services/outline";
import { go } from "../../services/navigation";
Page({
  data: {
    rows: [] as { id: string; title: string; subtitle: string }[],
    busy: false,
    pageLoading: true,
    status: "",
    storyCount: 0,
    unassigned: 0,
  },
  projectId: "",
  plan: null as PersonalPlan | null,
  generation: 0,
  onLoad(q) {
    this.projectId = q.projectId || "";
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
      this.apply(plan);
      this.setData({
        storyCount: overview.stories.filter(
          (s) => s.revision && s.included !== false,
        ).length,
        unassigned: overview.stories.filter(
          (s) => s.revision && s.included !== false && !s.chapter,
        ).length,
      });
    } catch (e) {
      if (n === this.generation)
        this.setData({ status: e instanceof Error ? e.message : "读取失败" });
    } finally {
      if (n === this.generation)
        this.setData({ busy: false, pageLoading: false });
    }
  },
  apply(plan: PersonalPlan) {
    this.plan = plan;
    this.setData({
      rows: plan.chapters.map((c) => ({
        id: c.key,
        title: c.title,
        subtitle: `${c.questions.length} 个大纲问题 · ${c.storyRefs.length} 篇故事`,
      })),
    });
  },
  onHide() {
    ++this.generation;
    this.plan = null;
    this.setData({ rows: [], storyCount: 0, unassigned: 0, busy: false });
  },
  open(e: WechatMiniprogram.CustomEvent<{ id: string }>) {
    go(
      "chapter-outline",
      `projectId=${this.projectId}&chapter=${encodeURIComponent(e.detail.id)}`,
    );
  },
  async persist(chapters: PlanChapter[]) {
    if (!this.plan || this.data.busy) return false;
    this.setData({ busy: true, status: "" });
    try {
      this.apply(
        await personalPlanClient.revise(this.projectId, this.plan.revision, {
          chapters,
          starters: this.plan.starters,
        }),
      );
      return true;
    } catch (e) {
      this.setData({ status: e instanceof Error ? e.message : "未保存" });
      return false;
    } finally {
      this.setData({ busy: false });
    }
  },
  reorder(e: WechatMiniprogram.CustomEvent<{ ids: string[] }>) {
    if (this.plan)
      void this.persist(
        e.detail.ids.map((id) =>
          this.plan!.chapters.find((c) => c.key === id)!,
        ),
      );
  },
  add() {
    go("chapter", `projectId=${this.projectId}`);
  },
  book() {
    go("book", `projectId=${this.projectId}`);
  },
  unassigned() {
    go("stories", `projectId=${this.projectId}&filter=unassigned`);
  },
  async free() {
    if (!this.plan || this.data.busy) return;
    this.setData({ busy: true });
    try {
      await startOutlineAnswer(this.projectId, this.plan.revision);
    } catch (e) {
      this.setData({ status: e instanceof Error ? e.message : "暂时无法开始" });
    } finally {
      this.setData({ busy: false });
    }
  },
  refresh() {
    void this.onShow();
  },
});
