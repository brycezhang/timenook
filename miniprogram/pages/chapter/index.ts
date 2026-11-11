import type { PersonalPlan, StoryView } from "../../../packages/contracts/src";
import { personalPlanClient } from "../../services/personal-plan";
import { paymentKey } from "../../services/payments";
import { storyClient } from "../../services/stories";
import { sessionClient } from "../../services/session";
import {
  storyBody,
  saveStoryBody,
  markEditing,
} from "../../services/book-editor";
import { go } from "../../services/store";
type Row = { id: string; title: string; body: string };
Page({
  data: {
    title: "",
    rows: [] as Row[],
    busy: false,
    pageLoading: true,
    status: "",
    dirty: false,
    existing: false,
  },
  projectId: "",
  key: "",
  context: null as PersonalPlan | null,
  stories: [] as StoryView[],
  generation: 0,
  owner: "",
  stopSession: undefined as (() => void) | undefined,
  onLoad(q) {
    this.stopSession = sessionClient.onInvalidated(() => {
      ++this.generation;
      this.context = null;
      this.stories = [];
      this.setData({
        title: "",
        rows: [],
        dirty: false,
        busy: false,
        pageLoading: false,
        status: "登录已失效，请重新登录",
      });
    });
    this.projectId = q.projectId || "";
    this.key = decodeURIComponent(q.chapter || "");
    this.setData({ existing: !!this.key });
  },
  async onShow() {
    if (this.data.dirty && this.owner === sessionClient.context()) return;
    const n = ++this.generation;
    this.owner = sessionClient.context();
    this.setData({ busy: true, pageLoading: !this.context, status: "" });
    try {
      const c = await personalPlanClient.read(this.projectId);
      const chapter = c.chapters.find((x) => x.key === this.key);
      if (!chapter && this.key) throw new Error("章节已不存在，请返回目录");
      const stories = await Promise.all(
        (chapter?.storyRefs || []).map((id) =>
          storyClient.read(this.projectId, id),
        ),
      );
      if (n !== this.generation || this.owner !== sessionClient.context())
        return;
      this.context = c;
      this.stories = stories;
      this.setData({
        title: chapter?.title || "",
        rows: stories.map((s) => ({
          id: s.id,
          title: s.revision?.title || "故事",
          body: storyBody(s),
        })),
        dirty: false,
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
  },
  onUnload() {
    this.stopSession?.();
    markEditing(false);
  },
  title(e: WechatMiniprogram.Input) {
    this.setData({ title: e.detail.value, dirty: true });
    markEditing(true);
  },
  body(e: WechatMiniprogram.Input) {
    const id = e.currentTarget.dataset.id;
    this.setData({
      rows: this.data.rows.map((r) =>
        r.id === id ? { ...r, body: e.detail.value } : r,
      ),
      dirty: true,
    });
    markEditing(true);
  },
  async persist() {
    if (
      this.data.busy ||
      !this.context ||
      this.owner !== sessionClient.context()
    )
      return false;
    if (!this.data.title.trim()) {
      this.setData({ status: "请填写章节名称" });
      return false;
    }
    this.setData({ busy: true, status: "" });
    try {
      for (const row of this.data.rows) {
        const s = this.stories.find((x) => x.id === row.id)!;
        if (row.body !== storyBody(s)) {
          const updated = await saveStoryBody(
            this.projectId,
            s,
            s.revision!.title,
            row.body,
          );
          this.stories = this.stories.map((x) => (x.id === s.id ? updated : x));
        }
      }
      if (!this.key) {
        this.key = `chapter-${paymentKey()}`;
        this.context = await personalPlanClient.revise(
          this.projectId,
          this.context.revision,
          {
            chapters: [
              ...this.context.chapters,
              {
                key: this.key,
                title: this.data.title.trim(),
                questions: [],
                storyRefs: [],
              },
            ],
            starters: this.context.starters,
          },
        );
      } else if (
        this.context.chapters.find((x) => x.key === this.key)?.title !==
        this.data.title.trim()
      ) {
        this.context = await personalPlanClient.revise(
          this.projectId,
          this.context.revision,
          {
            chapters: this.context.chapters.map((x) =>
              x.key === this.key ? { ...x, title: this.data.title.trim() } : x,
            ),
            starters: this.context.starters,
          },
        );
      }
      this.setData({ dirty: false });
      markEditing(false);
      return true;
    } catch (e) {
      this.setData({
        status: e instanceof Error ? e.message : "未能保存，修改仍保留",
      });
      return false;
    } finally {
      this.setData({ busy: false });
    }
  },
  async save() {
    if (await this.persist()) wx.navigateBack();
  },
  async choose() {
    if (
      ((this.key && !this.data.dirty) || (await this.persist())) &&
      !this.data.busy
    )
      go(
        "chapter-stories",
        `projectId=${this.projectId}&chapter=${encodeURIComponent(this.key)}`,
      );
  },
  remove() {
    if (this.data.busy || !this.context) return;
    wx.showModal({
      title: "移除这个章节？",
      content: "章节里的故事仍会保留。",
      confirmText: "移除章节",
      success: async (r) => {
        if (!r.confirm || !this.context) return;
        this.setData({ busy: true });
        try {
          await personalPlanClient.revise(
            this.projectId,
            this.context.revision,
            {
              chapters: this.context.chapters.filter((x) => x.key !== this.key),
              starters: this.context.starters,
            },
          );
          markEditing(false);
          const previous = getCurrentPages().slice(-2)[0];
          wx.navigateBack({
            delta: previous?.route === "pages/chapter-outline/index" ? 2 : 1,
          });
        } catch (e) {
          this.setData({ status: e instanceof Error ? e.message : "未能移除" });
        } finally {
          this.setData({ busy: false });
        }
      },
    });
  },
});
