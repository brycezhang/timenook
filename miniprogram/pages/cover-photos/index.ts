import type { BookContext } from "../../../packages/contracts/src";
import { bookClient } from "../../services/books";
import { sessionClient } from "../../services/session";
import { previewBookPhoto } from "../../services/book-editor";
import { clearPhotoPreviews } from "../../services/story-photos";
Page({
  data: {
    rows: [] as { id: string; image: string; caption: string }[],
    selected: "",
    busy: false,
    pageLoading: true,
    status: "",
  },
  projectId: "",
  context: null as BookContext | null,
  generation: 0,
  onLoad(q) {
    this.projectId = q.projectId || "";
    this.setData({ selected: q.selected || "" });
  },
  async onShow() {
    const n = ++this.generation,
      owner = sessionClient.context();
    this.setData({
      busy: true,
      pageLoading: !this.data.rows.length,
      status: "",
    });
    try {
      const c = await bookClient.read(this.projectId);
      if (n !== this.generation || owner !== sessionClient.context()) return;
      this.context = c;
      this.setData({
        rows: c.coverPhotoOptions.map((p) => ({
          id: p.assetId,
          image: "",
          caption: p.caption || "项目照片",
        })),
      });
      await Promise.all(
        c.coverPhotoOptions.map(async (p) => {
          try {
            const image = await previewBookPhoto(
              this.projectId,
              p,
              () => n === this.generation && owner === sessionClient.context(),
            );
            if (n !== this.generation || owner !== sessionClient.context()) {
              await clearPhotoPreviews([image]);
              return;
            }
            this.setData({
              rows: this.data.rows.map((r) =>
                r.id === p.assetId ? { ...r, image } : r,
              ),
            });
          } catch {
            if (n === this.generation)
              this.setData({ status: "部分照片未能读取，请重新进入此页" });
          }
        }),
      );
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
    void clearPhotoPreviews(this.data.rows.map((r) => r.image).filter(Boolean));
    this.setData({ rows: [], busy: false, pageLoading: false });
  },
  onUnload() {
    this.onHide();
  },
  choose(e: WechatMiniprogram.TouchEvent) {
    if (!this.data.busy)
      this.setData({ selected: e.currentTarget.dataset.id as string });
  },
  save() {
    if (!this.context || this.data.busy) return;
    this.getOpenerEventChannel?.().emit?.("coverPhotoSelected", {
      photoAssetId: this.data.selected || null,
    });
    wx.navigateBack();
  },
});
