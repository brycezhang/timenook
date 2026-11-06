import type {
  PersonalPlan,
  PlanContent,
} from "../../../packages/contracts/src";
import { personalPlanClient } from "../../services/personal-plan";
import { sessionClient } from "../../services/session";
import { go } from "../../services/store";
Page({
  data: {
    groups: [] as {
      id: string;
      title: string;
      rows: { id: string; title: string }[];
    }[],
    busy: false,
    pageLoading: true,
    status: "",
  },
  projectId: "",
  plan: null as PersonalPlan | null,
  generation: 0,
  onLoad(q) {
    this.projectId = q.projectId || "";
  },
  onShow() {
    void this.refresh();
  },
  onHide() {
    ++this.generation;
    this.plan = null;
    this.setData({ groups: [], busy: false, pageLoading: false });
  },
  apply(p: PersonalPlan) {
    this.plan = p;
    this.setData({
      groups: p.chapters.map((c) => ({
        id: c.key,
        title: c.title,
        rows: c.questions.map((q) => {
          const state = p.questionStates.find(
            (s) => s.questionKey === q.key,
          )?.state;
          return {
            id: q.key,
            title:
              q.text +
              (p.preferences.blockedTopics.includes(q.key)
                ? " · 不再问"
                : state === "later"
                  ? " · 稍后说"
                  : state === "skipped"
                    ? " · 已跳过"
                    : state === "not-applicable"
                      ? " · 不适用"
                      : ""),
          };
        }),
      })),
    });
  },
  async refresh() {
    const n = ++this.generation,
      owner = sessionClient.context();
    this.setData({ busy: true, pageLoading: !this.plan, status: "" });
    try {
      const p = await personalPlanClient.read(this.projectId);
      if (n === this.generation && owner === sessionClient.context())
        this.apply(p);
    } catch (e) {
      if (n === this.generation)
        this.setData({ status: e instanceof Error ? e.message : "读取失败" });
    } finally {
      if (n === this.generation)
        this.setData({ busy: false, pageLoading: false });
    }
  },
  open(e: WechatMiniprogram.CustomEvent<{ id: string }>) {
    go(
      "topic",
      `projectId=${this.projectId}&key=${encodeURIComponent(e.detail.id)}`,
    );
  },
  add() {
    go("topic", `projectId=${this.projectId}`);
  },
  async reorder(e: WechatMiniprogram.CustomEvent<{ ids: string[] }>) {
    const p = this.plan;
    if (!p || this.data.busy) return;
    const key = e.currentTarget.dataset.chapter;
    const content: PlanContent = {
      chapters: p.chapters.map((c) =>
        c.key === key
          ? {
              ...c,
              questions: e.detail.ids.map((id) =>
                c.questions.find((q) => q.key === id)!,
              ),
            }
          : c,
      ),
      starters: p.starters,
    };
    this.setData({ busy: true, status: "" });
    try {
      this.apply(
        await personalPlanClient.revise(this.projectId, p.revision, content),
      );
    } catch (e) {
      this.apply(p);
      this.setData({ status: e instanceof Error ? e.message : "顺序未保存" });
    } finally {
      this.setData({ busy: false });
    }
  },
});
