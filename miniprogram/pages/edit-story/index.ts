import type { StoryView } from "../../../packages/contracts/src";
import { storyClient } from "../../services/stories";
import { sessionClient } from "../../services/session";
import {
  storyBody,
  saveStoryBody,
  markEditing,
} from "../../services/book-editor";
Page({
  data: { title: "", body: "", busy: false, status: "", dirty: false },
  projectId: "",
  storyId: "",
  story: null as StoryView | null,
  generation: 0,
  owner: "",
  stopSession: undefined as (() => void) | undefined,
  onLoad(q) {
    this.stopSession = sessionClient.onInvalidated(() => {
      ++this.generation;
      this.story = null;
      this.setData({
        title: "",
        body: "",
        dirty: false,
        busy: false,
        status: "登录已失效，请重新登录",
      });
    });
    this.projectId = q.projectId || "";
    this.storyId = q.storyId || "";
  },
  async onShow() {
    if (this.data.dirty && this.owner === sessionClient.context()) return;
    const n = ++this.generation;
    this.owner = sessionClient.context();
    this.setData({ busy: true, status: "" });
    try {
      const s = await storyClient.read(this.projectId, this.storyId);
      if (n !== this.generation || this.owner !== sessionClient.context())
        return;
      this.story = s;
      this.setData({ title: s.revision?.title || "", body: storyBody(s) });
    } catch (e) {
      if (n === this.generation)
        this.setData({ status: e instanceof Error ? e.message : "读取失败" });
    } finally {
      if (n === this.generation) this.setData({ busy: false });
    }
  },
  onHide() {
    ++this.generation;
  },
  onUnload() {
    this.stopSession?.();
    markEditing(false);
  },
  input(e: WechatMiniprogram.Input) {
    this.setData({
      [e.currentTarget.dataset.field as string]: e.detail.value,
      dirty: true,
    });
    markEditing(true);
  },
  async save() {
    if (!this.story || this.data.busy || this.owner !== sessionClient.context())
      return;
    const n = this.generation,
      owner = sessionClient.context();
    this.setData({ busy: true, status: "" });
    try {
      await saveStoryBody(
        this.projectId,
        this.story,
        this.data.title,
        this.data.body,
      );
      if (n !== this.generation || owner !== sessionClient.context()) return;
      markEditing(false);
      wx.navigateBack();
    } catch (e) {
      this.setData({
        status: e instanceof Error ? e.message : "未能保存，修改仍保留",
      });
    } finally {
      this.setData({ busy: false });
    }
  },
});
