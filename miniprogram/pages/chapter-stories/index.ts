import type {
  BookContext,
  PersonalPlan,
} from "../../../packages/contracts/src";
import { personalPlanClient } from "../../services/personal-plan";
import { bookClient } from "../../services/books";
import { sessionClient } from "../../services/session";
type Row = { id: string; title: string; elsewhere?: boolean };
Page({
  data: {
    title: "",
    selected: [] as Row[],
    available: [] as Row[],
    busy: false,
    pageLoading: true,
    status: "",
  },
  projectId: "",
  plan: null as PersonalPlan | null,
  key: "",
  context: null as BookContext | null,
  generation: 0,
  onLoad(q) {
    this.projectId = q.projectId || "";
    this.key = decodeURIComponent(q.chapter || "");
  },
  async onShow() {
    const n = ++this.generation,
      owner = sessionClient.context();
    this.setData({ busy: true, pageLoading: !this.context, status: "" });
    try {
      const [c, plan] = await Promise.all([
        bookClient.read(this.projectId),
        personalPlanClient.read(this.projectId),
      ]);
      this.plan = plan;
      if (n === this.generation && owner === sessionClient.context())
        this.apply(c);
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
    this.context = null;
    this.setData({
      selected: [],
      available: [],
      busy: false,
      pageLoading: false,
    });
  },
  apply(c: BookContext) {
    this.context = c;
    const chapter = c.directory.chapters.find((x) => x.key === this.key);
    if (!chapter) throw new Error("章节不存在");
    this.setData({
      title: chapter.title,
      selected: chapter.storyRefs.map((id) => ({
        id,
        title: c.eligibleStories.find((s) => s.id === id)?.title || "故事",
      })),
      available: c.eligibleStories
        .filter((s) => !chapter.storyRefs.includes(s.id))
        .map((s) => ({
          id: s.id,
          title: s.title,
          elsewhere: c.directory.chapters.some((x) =>
            x.storyRefs.includes(s.id),
          ),
        })),
    });
  },
  async persist(ids: string[]) {
    if (this.data.busy || !this.context || !this.plan) return;
    const c = this.context,
      n = this.generation,
      owner = sessionClient.context();
    this.setData({ busy: true, status: "" });
    try {
      this.plan = await personalPlanClient.revise(
        this.projectId,
        this.plan.revision,
        {
          chapters: this.plan.chapters.map((x) => ({
            ...x,
            storyRefs:
              x.key === this.key
                ? ids
                : x.storyRefs.filter((id) => !ids.includes(id)),
          })),
          starters: this.plan.starters,
        },
      );
      const updated = await bookClient.read(this.projectId);
      if (n === this.generation && owner === sessionClient.context())
        this.apply(updated);
    } catch (e) {
      if (n === this.generation) {
        this.apply(c);
        this.setData({
          status: e instanceof Error ? e.message : "未保存，请重试",
        });
      }
    } finally {
      if (n === this.generation) this.setData({ busy: false });
    }
  },
  add(e: WechatMiniprogram.TouchEvent) {
    void this.persist([
      ...this.data.selected.map((s) => s.id),
      e.currentTarget.dataset.id as string,
    ]);
  },
  remove(e: WechatMiniprogram.CustomEvent<{ id: string }>) {
    void this.persist(
      this.data.selected.filter((s) => s.id !== e.detail.id).map((s) => s.id),
    );
  },
  reorder(e: WechatMiniprogram.CustomEvent<{ ids: string[] }>) {
    void this.persist(e.detail.ids);
  },
  done() {
    wx.navigateBack();
  },
});
