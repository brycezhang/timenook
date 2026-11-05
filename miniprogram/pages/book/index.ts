import type { BookContext } from "../../../packages/contracts/src";
import { bookClient } from "../../services/books";
import { projectOverviewClient } from "../../services/project-overview";
import { sessionClient } from "../../services/session";
import { paymentKey } from "../../services/payments";
import { previewBookPhoto } from "../../services/book-editor";
import { clearPhotoPreviews } from "../../services/story-photos";
import { watchProjectAccess } from "../../services/project-access";
import { go } from "../../services/store";
Page({
  data: {
    context: null as BookContext | null,
    title: "",
    coverImage: "",
    stateLabel: "",
    busy: false,
    status: "",
    dirty: false,
  },
  projectId: "",
  generation: 0,
  timer: undefined as ReturnType<typeof setTimeout> | undefined,
  intent: null as { hash: string; key: string } | null,
  stopAccess: undefined as (() => void) | undefined,
  stopSession: undefined as (() => void) | undefined,
  onLoad(q) {
    this.projectId = q.projectId || projectOverviewClient.selected();
    this.stopSession = sessionClient.onInvalidated(() => this.clearAccess());
  },
  onShow() {
    this.stopAccess?.();
    const owner = sessionClient.context();
    this.stopAccess = watchProjectAccess(
      this.projectId,
      () => owner === sessionClient.context(),
      () => this.clearAccess(),
    );
    void this.refresh();
  },
  clearAccess() {
    this.onHide();
    this.setData({
      title: "",
      stateLabel: "",
      status: "项目访问已变化，请重新打开",
    });
  },
  onHide() {
    this.stopAccess?.();
    this.stopAccess = undefined;
    ++this.generation;
    if (this.timer) clearTimeout(this.timer);
    void clearPhotoPreviews([this.data.coverImage].filter(Boolean));
    this.setData({ context: null, coverImage: "", busy: false });
  },
  onUnload() {
    this.stopSession?.();
    this.onHide();
  },
  async refresh() {
    if (this.data.busy) return;
    const n = ++this.generation,
      owner = sessionClient.context();
    this.setData({ busy: true, status: "" });
    try {
      const [c, p] = await Promise.all([
        bookClient.read(this.projectId),
        projectOverviewClient.read(this.projectId),
      ]);
      if (n !== this.generation || owner !== sessionClient.context()) return;
      this.setData({ title: p.bookTitle });
      this.accept(c);
      const photo =
        c.coverPhotoOptions.find((x) => x.assetId === c.cover.photoAssetId) ||
        c.current?.snapshot.cover.photo;
      if (photo) {
        try {
          const path = await previewBookPhoto(
            this.projectId,
            photo,
            () => n === this.generation && owner === sessionClient.context(),
          );
          if (n !== this.generation || owner !== sessionClient.context()) {
            await clearPhotoPreviews([path]);
            return;
          }
          void clearPhotoPreviews([this.data.coverImage].filter(Boolean));
          this.setData({ coverImage: path });
        } catch {
          if (n === this.generation)
            this.setData({ status: "封面照片暂时未能读取" });
        }
      }
    } catch (e) {
      if (n === this.generation) {
        void clearPhotoPreviews([this.data.coverImage].filter(Boolean));
        this.setData({
          context: null,
          coverImage: "",
          status: e instanceof Error ? e.message : "书稿未能读取",
        });
      }
    } finally {
      if (n === this.generation) this.setData({ busy: false });
    }
  },
  accept(c: BookContext) {
    const v = c.current,
      dirty = !!v && v.inputHash !== c.inputHash;
    this.setData({
      context: c,
      dirty,
      stateLabel: !v
        ? "还未生成书稿"
        : dirty
          ? "内容已更新，请生成新版"
          : v.state === "ready"
            ? "电子书已生成"
            : v.state === "failed"
              ? "这次生成没有完成"
              : v.state === "obsolete"
                ? "请生成新版书稿"
                : "正在排版成书",
    });
    if (this.timer) clearTimeout(this.timer);
    if (v && ["queued", "rendering"].includes(v.state))
      this.timer = setTimeout(() => void this.refresh(), 3000);
  },
  async generate() {
    const c = this.data.context;
    if (this.data.busy || !c?.inputHash) return;
    const n = this.generation,
      owner = sessionClient.context();
    this.setData({ busy: true, status: "" });
    if (this.intent?.hash !== c.inputHash)
      this.intent = { hash: c.inputHash, key: paymentKey() };
    try {
      const v = await (c.current?.state === "failed" && !this.data.dirty
        ? bookClient.retry(this.projectId, c.current.id, this.intent.key)
        : bookClient.generate(this.projectId, c.inputHash, this.intent.key));
      if (n === this.generation && owner === sessionClient.context()) {
        this.intent = null;
        this.accept({ ...c, current: v });
      }
    } catch (e) {
      if (n === this.generation)
        this.setData({
          status:
            e instanceof Error ? e.message : "生成结果未确认，请查询后重试",
        });
    } finally {
      if (n === this.generation) this.setData({ busy: false });
    }
  },
  cover() {
    go("cover", `projectId=${this.projectId}`);
  },
  directory() {
    go("directory", `projectId=${this.projectId}`);
  },
  manuscript() {
    const v = this.data.context?.current;
    if (v?.state === "ready")
      go("manuscript", `projectId=${this.projectId}&versionId=${v.id}`);
  },
  print() {
    go("print", `projectId=${this.projectId}`);
  },
  production() {
    go("production", `projectId=${this.projectId}`);
  },
  record() {
    go("interview", `projectId=${this.projectId}`);
  },
});
