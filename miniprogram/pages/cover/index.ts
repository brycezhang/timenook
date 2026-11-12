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
import { watchProjectAccess } from "../../services/project-access";
Page({
  data: {
    title: "",
    salutation: "",
    photoAssetId: null as string | null,
    image: "",
    hasPhoto: false,
    busy: false,
    pageLoading: true,
    photoLoading: false,
    status: "",
    dirty: false,
    photos: [] as { id: string; image: string }[],
  },
  projectId: "",
  context: null as BookContext | null,
  project: null as ProjectOverview | null,
  generation: 0,
  owner: "",
  disposed: false,
  intent: null as { body: string; key: string } | null,
  stopSession: undefined as (() => void) | undefined,
  stopAccess: undefined as (() => void) | undefined,
  onLoad(q) {
    this.projectId = q.projectId || "";
    this.stopSession = sessionClient.onInvalidated(() => this.clearAccess());
  },
  clearAccess() {
    this.onHide();
    this.context = null;
    this.project = null;
    this.intent = null;
    markEditing(false);
    this.setData({
      title: "",
      salutation: "",
      photoAssetId: null,
      hasPhoto: false,
      dirty: false,
      status: "项目访问已变化，请重新打开",
    });
  },
  async onShow() {
    markEditing(this.data.dirty);
    const n = ++this.generation;
    this.owner = sessionClient.context();
    const owner = this.owner;
    this.stopAccess?.();
    this.stopAccess = watchProjectAccess(
      this.projectId,
      () => owner === sessionClient.context(),
      () => this.clearAccess(),
    );
    this.setData({ busy: true, pageLoading: !this.context, status: "" });
    try {
      if (!this.context) {
        const [c, p] = await Promise.all([
          bookClient.read(this.projectId),
          projectOverviewClient.read(this.projectId),
        ]);
        if (!this.current(n, owner)) return;
        this.context = c;
        this.project = p;
        this.setData({
          title: p.bookTitle,
          salutation: c.cover.salutation,
          photoAssetId: c.cover.photoAssetId,
          hasPhoto: !!c.cover.photoAssetId,
        });
      }
      if (this.current(n, owner)) await this.loadPhoto(n, owner);
    } catch (e) {
      if (this.current(n, owner))
        this.setData({
          status: e instanceof Error ? e.message : "封面未能读取",
        });
    } finally {
      if (this.current(n, owner))
        this.setData({ busy: false, pageLoading: false });
    }
  },
  current(n: number, owner: string) {
    return (
      !this.disposed &&
      n === this.generation &&
      owner === sessionClient.context()
    );
  },
  async loadPhoto(n: number, owner: string) {
    const options = this.context?.coverPhotoOptions || [];
    const choices = options.slice(0, 3);
    const selected = options.find(
      (photo) => photo.assetId === this.data.photoAssetId,
    );
    const visible =
      selected && !choices.includes(selected)
        ? [...choices, selected]
        : choices;
    this.setData({
      photos: choices.map((photo) => ({ id: photo.assetId, image: "" })),
      photoLoading: visible.length > 0,
    });
    try {
      await Promise.all(
        visible.map(async (photo) => {
          try {
            const path = await previewBookPhoto(this.projectId, photo, () =>
              this.current(n, owner),
            );
            if (!this.current(n, owner)) {
              await clearPhotoPreviews([path]);
              return;
            }
            this.setData({
              photos: this.data.photos.map((item) =>
                item.id === photo.assetId ? { ...item, image: path } : item,
              ),
              ...(photo.assetId === this.data.photoAssetId
                ? { image: path }
                : {}),
            });
          } catch (e) {
            if (this.current(n, owner))
              this.setData({
                status: e instanceof Error ? e.message : "封面照片暂未加载",
              });
          }
        }),
      );
    } finally {
      if (this.current(n, owner)) this.setData({ photoLoading: false });
    }
  },
  selectPhoto(e: WechatMiniprogram.TouchEvent) {
    if (this.data.busy) return;
    const photo = this.data.photos.find(
      (item) => item.id === e.currentTarget.dataset.id,
    );
    if (!photo) return;
    this.setData({
      photoAssetId: photo.id,
      image: photo.image,
      hasPhoto: true,
      dirty: true,
    });
    markEditing(true);
  },
  onHide() {
    this.stopAccess?.();
    this.stopAccess = undefined;
    ++this.generation;
    void clearPhotoPreviews([
      ...new Set(
        [this.data.image, ...this.data.photos.map((p) => p.image)].filter(
          Boolean,
        ),
      ),
    ]);
    this.setData({
      image: "",
      photos: [],
      busy: false,
      photoLoading: false,
      pageLoading: false,
    });
  },
  onUnload() {
    this.disposed = true;
    this.stopSession?.();
    this.onHide();
    this.context = null;
    this.project = null;
    this.intent = null;
    markEditing(false);
  },
  input(e: WechatMiniprogram.Input) {
    if (this.data.busy) return;
    const field = e.currentTarget.dataset.field as "title" | "salutation";
    this.setData({ [field]: e.detail.value, dirty: true });
    markEditing(true);
  },
  choose() {
    if (!this.context || this.data.busy) return;
    const owner = this.owner;
    markEditing(false);
    wx.navigateTo({
      url: `/pages/cover-photos/index?projectId=${this.projectId}&selected=${this.data.photoAssetId || ""}`,
      fail: () => {
        if (!this.disposed && owner === sessionClient.context())
          markEditing(this.data.dirty);
      },
      events: {
        coverPhotoSelected: ({
          photoAssetId,
        }: {
          photoAssetId: string | null;
        }) => {
          if (this.disposed || owner !== sessionClient.context()) return;
          this.setData({ photoAssetId, hasPhoto: !!photoAssetId, dirty: true });
        },
      },
    });
  },
  async save() {
    if (!this.context || !this.project || this.data.busy) return;
    if (!this.data.title.trim()) {
      this.setData({ status: "请填写书名" });
      return;
    }
    if (!this.data.dirty) {
      wx.navigateBack();
      return;
    }
    const n = this.generation,
      owner = this.owner;
    const input = {
      title: this.data.title.trim(),
      salutation: this.data.salutation,
      photoAssetId: this.data.photoAssetId,
      expectedMetadataVersion: this.project.metadataVersion,
    };
    const body = JSON.stringify({
      expectedVersion: this.context.cover.version,
      ...input,
    });
    if (this.intent?.body !== body) this.intent = { body, key: paymentKey() };
    this.setData({ busy: true, status: "" });
    try {
      await bookClient.reviseCover(
        this.projectId,
        this.context.cover.version,
        input,
        this.intent.key,
      );
      if (!this.current(n, owner)) return;
      this.intent = null;
      this.setData({ dirty: false });
      markEditing(false);
      wx.navigateBack();
    } catch (e) {
      if (this.current(n, owner))
        this.setData({ status: e instanceof Error ? e.message : "修改未保存" });
    } finally {
      if (this.current(n, owner)) this.setData({ busy: false });
    }
  },
});
