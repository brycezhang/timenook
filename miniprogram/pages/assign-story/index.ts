import type { PersonalPlan, StoryView } from "../../../packages/contracts/src";
import { personalPlanClient } from "../../services/personal-plan";
import { storyClient } from "../../services/stories";
import { sessionClient } from "../../services/session";
import { go } from "../../services/store";

Page({
  projectId: "",
  storyId: "",
  story: null as StoryView | null,
  plan: null as PersonalPlan | null,
  generation: 0,
  owner: "",
  stopSession: undefined as (() => void) | undefined,
  data: {
    title: "",
    selected: "",
    assigned: false,
    excluded: false,
    chapters: [] as { key: string; title: string; number: string }[],
    busy: false,
    pageLoading: true,
    status: "",
  },
  onLoad(q) {
    this.projectId = q.projectId || "";
    this.storyId = q.storyId || "";
    this.stopSession = sessionClient.onInvalidated(() => {
      this.onHide();
      this.setData({ status: "登录已失效，请重新登录" });
    });
  },
  async onShow() {
    const n = ++this.generation;
    this.owner = sessionClient.context();
    this.setData({ busy: true, pageLoading: true, status: "" });
    try {
      const [story, plan] = await Promise.all([
        storyClient.read(this.projectId, this.storyId),
        personalPlanClient.read(this.projectId),
      ]);
      if (!this.current(n)) return;
      if (!story.revision) throw new Error("故事整理完成后可以选择章节");
      this.story = story;
      this.plan = plan;
      this.setData({
        title: story.revision.title,
        selected: story.chapter?.key || "",
        assigned: !!story.chapter,
        excluded: story.included === false,
        chapters: plan.chapters.map((ch, i) => ({
          key: ch.key,
          title: ch.title,
          number: String(i + 1).padStart(2, "0"),
        })),
      });
    } catch (error) {
      if (this.current(n))
        this.setData({
          status: error instanceof Error ? error.message : "未能读取章节",
        });
    } finally {
      if (this.current(n)) this.setData({ busy: false, pageLoading: false });
    }
  },
  onHide() {
    ++this.generation;
    this.story = null;
    this.plan = null;
    this.setData({
      title: "",
      chapters: [],
      selected: "",
      assigned: false,
      excluded: false,
      busy: false,
      pageLoading: false,
    });
  },
  onUnload() {
    this.onHide();
    this.stopSession?.();
  },
  current(n: number) {
    return (
      n === this.generation &&
      !!this.owner &&
      this.owner === sessionClient.context()
    );
  },
  choose(e: WechatMiniprogram.TouchEvent) {
    const key = e.currentTarget.dataset.id as string;
    if (!this.data.busy && this.plan?.chapters.some((ch) => ch.key === key))
      this.setData({ selected: key });
  },
  save() {
    if (this.data.selected) return this.place(this.data.selected);
  },
  unassign() {
    return this.place(null);
  },
  async place(chapterKey: string | null) {
    if (!this.story || !this.plan || this.data.busy) return;
    const n = this.generation,
      story = this.story,
      plan = this.plan;
    this.setData({ busy: true, status: "" });
    try {
      if (story.included === false) {
        const restored = await storyClient.inclusion(
          this.projectId,
          story.id,
          story.version,
          true,
        );
        if (!this.current(n)) return;
        this.story = restored;
        this.setData({ excluded: false });
      }
      const updated = await personalPlanClient.revise(
        this.projectId,
        plan.revision,
        {
          chapters: plan.chapters.map((ch) => ({
            ...ch,
            storyRefs:
              ch.key === chapterKey && ch.storyRefs.includes(story.id)
                ? ch.storyRefs
                : [
                    ...ch.storyRefs.filter((id) => id !== story.id),
                    ...(ch.key === chapterKey ? [story.id] : []),
                  ],
          })),
          starters: plan.starters,
        },
      );
      if (!this.current(n)) return;
      this.plan = updated;
      wx.navigateBack();
    } catch (error) {
      if (this.current(n))
        this.setData({
          status: error instanceof Error ? error.message : "章节未保存，请重试",
        });
    } finally {
      if (this.current(n)) this.setData({ busy: false });
    }
  },
  async exclude() {
    if (!this.story || this.data.busy) return;
    const n = this.generation;
    this.setData({ busy: true, status: "" });
    try {
      await storyClient.inclusion(
        this.projectId,
        this.story.id,
        this.story.version,
        false,
      );
      if (this.current(n)) wx.navigateBack();
    } catch (error) {
      if (this.current(n))
        this.setData({
          status: error instanceof Error ? error.message : "未能保存，请重试",
        });
    } finally {
      if (this.current(n)) this.setData({ busy: false });
    }
  },
  directory() {
    go("directory", `projectId=${this.projectId}`);
  },
});
