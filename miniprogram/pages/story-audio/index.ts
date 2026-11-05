import type { StoryView } from "../../../packages/contracts/src";
import { storyClient } from "../../services/stories";
import { sessionClient } from "../../services/session";
import {
  revisionInput,
  storyBody,
  markEditing,
} from "../../services/book-editor";
import { paymentKey } from "../../services/payments";
Page({
  data: {
    rows: [] as { id: string; title: string; selected: boolean }[],
    busy: false,
    status: "",
  },
  projectId: "",
  storyId: "",
  story: null as StoryView | null,
  generation: 0,
  onLoad(q) {
    this.projectId = q.projectId || "";
    this.storyId = q.storyId || "";
  },
  async onShow() {
    const n = ++this.generation,
      owner = sessionClient.context();
    this.setData({ busy: true, status: "" });
    try {
      const s = await storyClient.read(this.projectId, this.storyId);
      if (n !== this.generation || owner !== sessionClient.context()) return;
      this.story = s;
      const selected =
        s.revision?.audioManifest || s.revision?.sourceManifest || [];
      this.setData({
        rows: (s.revision?.sourceManifest || []).map((a, i) => ({
          id: a.clipId,
          title: `第 ${i + 1} 段原声`,
          selected: selected.some((b) => b.clipId === a.clipId),
        })),
      });
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
    markEditing(false);
  },
  toggle(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id;
    this.setData({
      rows: this.data.rows.map((r) =>
        r.id === id ? { ...r, selected: !r.selected } : r,
      ),
    });
    markEditing(true);
  },
  async save() {
    const s = this.story;
    if (!s?.revision || this.data.busy) return;
    this.setData({ busy: true, status: "" });
    try {
      const input = revisionInput(s, s.revision.title, storyBody(s));
      input.audioClipIds = this.data.rows
        .filter((r) => r.selected)
        .map((r) => r.id);
      await storyClient.revise(this.projectId, s.id, input, paymentKey());
      markEditing(false);
      wx.navigateBack();
    } catch (e) {
      this.setData({ status: e instanceof Error ? e.message : "未能保存" });
    } finally {
      this.setData({ busy: false });
    }
  },
});
