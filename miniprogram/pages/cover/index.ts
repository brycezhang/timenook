import type {
  BookContext,
  ProjectOverview,
} from "../../../packages/contracts/src";
import { bookClient } from "../../services/books";
import { projectOverviewClient } from "../../services/project-overview";
import { sessionClient } from "../../services/session";
import { paymentKey } from "../../services/payments";
import { previewBookPhoto, markEditing } from "../../services/book-editor";
import { clearPhotoPreviews } from "../../services/story-photos";
import { go } from "../../services/store";
Page({
  data: {
    title: "",
    salutation: "",
    image: "",
    hasPhoto: false,
    busy: false,
    status: "",
    dirty: false,
  },
  projectId: "",
  context: null as BookContext | null,
  project: null as ProjectOverview | null,
  generation: 0,
  owner: "",
  stopSession: undefined as (() => void) | undefined,
  onLoad(q) {
    this.stopSession = sessionClient.onInvalidated(() => {
      this.onHide();
      this.context = null;
      this.project = null;
      this.setData({
        title: "",
        salutation: "",
        image: "",
        hasPhoto: false,
        dirty: false,
        busy: false,
        status: "登录已失效，请重新登录",
      });
    });
    this.projectId = q.projectId || "";
  },
  async onShow() {
    const n = ++this.generation;
    this.owner = sessionClient.context();
    this.setData({ busy: true, status: "" });
    try {
      const [c, p] = await Promise.all([
        bookClient.read(this.projectId),
        projectOverviewClient.read(this.projectId),
      ]);
      if (n !== this.generation || this.owner !== sessionClient.context())
        return;
      this.context = c;
      this.project = p;
      if (!this.data.dirty)
        this.setData({ title: p.bookTitle, salutation: c.cover.salutation });
      const photo = c.coverPhotoOptions.find(
        (x) => x.assetId === c.cover.photoAssetId,
      );
      this.setData({ hasPhoto: !!photo });
      if (photo) {
        const path = await previewBookPhoto(
          this.projectId,
          photo,
          () => n === this.generation && this.owner === sessionClient.context(),
        );
        if (n !== this.generation) {
          await clearPhotoPreviews([path]);
          return;
        }
        this.setData({ image: path });
      }
    } catch (e) {
      if (n === this.generation)
        this.setData({ status: e instanceof Error ? e.message : "读取失败" });
    } finally {
      if (n === this.generation) this.setData({ busy: false });
    }
  },
  onHide() {
    ++this.generation;
    void clearPhotoPreviews([this.data.image].filter(Boolean));
    this.setData({ image: "", busy: false });
  },
  onUnload() {
    this.stopSession?.();
    this.onHide();
    markEditing(false);
  },
  input(e: WechatMiniprogram.Input) {
    const field = e.currentTarget.dataset.field as "title" | "salutation";
    this.setData({ [field]: e.detail.value, dirty: true });
    markEditing(true);
  },
  async persist() {
    if (!this.context || !this.project || this.data.busy) return false;
    if (!this.data.title.trim()) {
      this.setData({ status: "请填写书名" });
      return false;
    }
    const n = this.generation,
      owner = sessionClient.context();
    this.setData({ busy: true, status: "" });
    try {
      if (this.data.title.trim() !== this.project.bookTitle)
        this.project = await projectOverviewClient.rename(
          this.projectId,
          this.project.metadataVersion,
          this.data.title.trim(),
          paymentKey(),
        );
      if (this.data.salutation !== this.context.cover.salutation)
        this.context = await bookClient.reviseCover(
          this.projectId,
          this.context.cover.version,
          {
            salutation: this.data.salutation,
            photoAssetId: this.context.cover.photoAssetId,
          },
          paymentKey(),
        );
      if (n !== this.generation || owner !== sessionClient.context())
        return false;
      this.setData({ dirty: false });
      markEditing(false);
      return true;
    } catch (e) {
      this.setData({ status: e instanceof Error ? e.message : "修改未保存" });
      return false;
    } finally {
      this.setData({ busy: false });
    }
  },
  async choose() {
    if (await this.persist()) go("cover-photos", `projectId=${this.projectId}`);
  },
  async save() {
    if (await this.persist()) wx.navigateBack();
  },
});
