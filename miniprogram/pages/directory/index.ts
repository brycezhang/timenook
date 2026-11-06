import type { BookContext } from "../../../packages/contracts/src";
import { bookClient } from "../../services/books";
import { projectOverviewClient } from "../../services/project-overview";
import { sessionClient } from "../../services/session";
import { go } from "../../services/store";
import { paymentKey } from "../../services/payments";
Page({
  data: {
    title: "",
    rows: [] as { id: string; title: string }[],
    busy: false,
    pageLoading: true,
    status: "",
  },
  projectId: "",
  context: null as BookContext | null,
  generation: 0,
  onLoad(q) {
    this.projectId = q.projectId || "";
  },
  async onShow() {
    const n = ++this.generation,
      owner = sessionClient.context();
    this.setData({ busy: true, pageLoading: !this.context, status: "" });
    try {
      const [c, p] = await Promise.all([
        bookClient.read(this.projectId),
        projectOverviewClient.read(this.projectId),
      ]);
      if (n !== this.generation || owner !== sessionClient.context()) return;
      this.context = c;
      this.setData({
        title: p.bookTitle,
        rows: c.directory.chapters.map((x) => ({ id: x.key, title: x.title })),
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
    this.context = null;
    this.setData({ rows: [], busy: false, pageLoading: false });
  },
  open(e: WechatMiniprogram.CustomEvent<{ id: string }>) {
    go(
      "chapter",
      `projectId=${this.projectId}&chapter=${encodeURIComponent(e.detail.id)}`,
    );
  },
  async persist(chapters: BookContext["directory"]["chapters"]) {
    if (this.data.busy || !this.context) return false;
    const n = this.generation,
      owner = sessionClient.context();
    this.setData({ busy: true, status: "" });
    try {
      const c = await bookClient.reviseDirectory(
        this.projectId,
        this.context.directory.version,
        chapters,
      );
      if (n !== this.generation || owner !== sessionClient.context())
        return false;
      this.context = c;
      this.setData({
        rows: c.directory.chapters.map((x) => ({ id: x.key, title: x.title })),
      });
      return true;
    } catch (e) {
      if (n === this.generation)
        this.setData({
          status: e instanceof Error ? e.message : "顺序未保存，请重试",
          rows:
            this.context?.directory.chapters.map((x) => ({
              id: x.key,
              title: x.title,
            })) || [],
        });
      return false;
    } finally {
      if (n === this.generation) this.setData({ busy: false });
    }
  },
  reorder(e: WechatMiniprogram.CustomEvent<{ ids: string[] }>) {
    const c = this.context;
    if (c)
      void this.persist(
        e.detail.ids.map((id) =>
          c.directory.chapters.find((x) => x.key === id)!,
        ),
      );
  },
  async add() {
    if (!this.context) return;
    const key = `chapter-${paymentKey()}`;
    if (
      await this.persist([
        ...this.context.directory.chapters,
        { key, title: "新的章节", storyRefs: [] },
      ])
    )
      go(
        "chapter",
        `projectId=${this.projectId}&chapter=${encodeURIComponent(key)}`,
      );
  },
  done() {
    wx.navigateBack();
  },
  refresh() {
    void this.onShow();
  },
});
