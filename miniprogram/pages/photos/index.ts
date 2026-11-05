import { storyClient } from "../../services/stories";
import {
  revisionInput,
  storyBody,
  markEditing,
} from "../../services/book-editor";
import { watchPermission } from "../../services/project-access";
import { paymentKey } from "../../services/payments";
import {
  PhotoFiles,
  clearPhotoPreviews,
  privatePhotoPreview,
  type LocalPhoto,
} from "../../services/story-photos";
import { sessionClient, ApiFailure } from "../../services/session";
import { interviewRecordingClient } from "../../services/interview-recording";
import type {
  PhotoCollection,
  PhotoMaterials,
  ParticipationState,
} from "../../../packages/contracts/src";
type Event = {
  currentTarget: { dataset: Record<string, string> };
  detail: { value: string };
};
Page({
  data: {
    rows: [] as { id: string; title: string; image: string }[],
    previewPath: "",
    photos: [] as LocalPhoto[],
    snapshot: null as PhotoMaterials | null,
    captions: {} as Record<string, string>,
    hasDraft: false,
    status: "",
    busy: false,
  },
  picking: false,
  storyId: "",
  projectId: "",
  interviewId: "",
  assistedSessionId: "",
  generation: 0,
  previewGeneration: 0,
  ownerContext: "",
  editingRevision: null as number | null,
  owner: null as PhotoFiles | null,
  stopProjectWatch: undefined as (() => void) | undefined,
  stopSessionWatch: undefined as (() => void) | undefined,
  onLoad(q: Record<string, string>) {
    this.storyId = q.storyId || "";
    this.projectId = q.projectId ?? "";
    this.interviewId = q.interviewId ?? "";
    this.assistedSessionId = q.assistedSessionId ?? "";
  },
  current(g: number, context: string) {
    return g === this.generation && context === sessionClient.context();
  },
  relevant(g: number, context: string) {
    return (
      g === this.generation &&
      (context === sessionClient.context() || !sessionClient.context())
    );
  },
  async readCollection(): Promise<PhotoCollection> {
    const base = `/projects/${this.projectId}/interviews/${this.interviewId}/photos`;
    const collection = this.assistedSessionId
      ? await sessionClient.request<PhotoCollection>(`${base}/context`, {
          key: paymentKey(),
          data: { assistedSessionId: this.assistedSessionId },
        })
      : null;
    try {
      return await sessionClient.request<PhotoCollection>(base);
    } catch (error) {
      // Collection alone permits uploading own originals, not reading material history.
      if (
        collection &&
        !this.data.snapshot &&
        error instanceof ApiFailure &&
        error.status === 403
      )
        return collection;
      throw error;
    }
  },
  async onShow() {
    if (this.picking) return;
    this.stopSessionWatch?.();
    this.stopSessionWatch = undefined;
    const ownerContext = sessionClient.context();
    if (ownerContext)
      this.stopSessionWatch = sessionClient.onInvalidated((context) => {
        if (!ownerContext || context !== ownerContext) return;
        this.onHide();
        this.setData({
          status: sessionClient.sessionCleanupPending()
            ? "登录已失效；设备会话缓存清理失败，请重试登录"
            : "照片权限已变化，请重新查询",
        });
      });
    if (this.data.hasDraft && this.ownerContext === sessionClient.context()) {
      this.setData({
        status: "仍有未保存的照片说明；请先保存，或明确放弃草稿再重新查询",
      });
      return;
    }
    this.editingRevision = null;
    this.setData({ captions: {}, hasDraft: false });
    const g = ++this.generation,
      context = sessionClient.context();
    this.setData({
      rows: [],
      previewPath: "",
      photos: [],
      snapshot: null,
      busy: true,
      status: "正在查询当前照片权限",
    });
    try {
      await clearPhotoPreviews();
      if (
        !/^[a-f0-9-]{36}$/.test(this.projectId) ||
        !/^[a-f0-9-]{36}$/.test(this.interviewId)
      )
        throw Error("请从本人采访进入");
      const result = await this.readCollection();
      if (!this.current(g, context)) return;
      this.ownerContext = context;
      this.owner = PhotoFiles.open(this.projectId, this.interviewId);
      this.owner.subscribe((photos) => {
        if (this.current(g, context)) this.setData({ photos });
      });
      this.setData({
        snapshot: result.snapshot,
        status: "",
      });
      void this.renderPhotos();
      this.stopProjectWatch?.();
      this.stopProjectWatch = watchPermission(
        () => this.current(g, context),
        async () => {
          const collection = await interviewRecordingClient.authorizeCollection(
            this.projectId,
            this.interviewId,
            this.assistedSessionId || undefined,
          );
          if (!collection.allowed) return false;
          if (!this.data.snapshot) return true;
          const participation = await sessionClient.request<ParticipationState>(
            `/projects/${this.projectId}/participation`,
          );
          return participation.canRead === true;
        },
        () => {
          this.onHide();
          this.setData({
            status:
              "资料用途或账号授权已变化，照片预览已清理；本机原文件仍保留",
          });
        },
      );
    } catch (error) {
      if (this.relevant(g, context))
        this.setData({
          photos: [],
          snapshot: null,
          status:
            error instanceof Error ? error.message : "查询失败，可重新查询",
        });
    } finally {
      if (this.relevant(g, context)) this.setData({ busy: false });
    }
  },
  onHide() {
    if (this.picking) return;
    this.stopProjectWatch?.();
    this.stopProjectWatch = undefined;
    this.stopSessionWatch?.();
    this.stopSessionWatch = undefined;
    this.editingRevision = null;
    ++this.previewGeneration;
    void clearPhotoPreviews().catch(() => {});
    ++this.generation;
    this.owner?.unsubscribe();
    this.owner = null;
    this.setData({
      rows: [],
      previewPath: "",
      photos: [],
      snapshot: null,
      captions: {},
      hasDraft: false,
      busy: false,
      status: "",
    });
  },
  onUnload() {
    this.picking = false;
    markEditing(false);
    this.onHide();
  },
  async choose() {
    const g = this.generation,
      context = sessionClient.context();
    if (!this.owner || this.data.busy) return;
    this.setData({ busy: true });
    try {
      await interviewRecordingClient.authorizeCollection(
        this.projectId,
        this.interviewId,
        this.assistedSessionId || undefined,
      );
      if (!this.current(g, context)) return;
      this.picking = true;
      const result =
        await new Promise<WechatMiniprogram.ChooseMediaSuccessCallbackResult>(
          (resolve, reject) =>
            wx.chooseMedia({
              count: 9,
              mediaType: ["image"],
              sizeType: ["original"],
              sourceType: ["album", "camera"],
              success: resolve,
              fail: reject,
            }),
        );
      if (!this.current(g, context)) return;
      await this.owner!.add(result.tempFiles);
      void this.queueUploads();
    } catch (error) {
      if (this.current(g, context))
        this.setData({
          status: "未取得照片，请重试；不支持的格式请另选JPEG或PNG",
        });
      if (
        error instanceof ApiFailure &&
        [401, 403].includes(error.status) &&
        this.relevant(g, context)
      )
        this.onHide();
    } finally {
      this.picking = false;
      if (this.current(g, context)) this.setData({ busy: false });
    }
  },
  async queueUploads() {
    for (const photo of this.owner
      ?.snapshot()
      .filter((p) => p.state === "local") || [])
      await this.upload({
        currentTarget: { dataset: { id: photo.clientPhotoId } },
        detail: { value: "" },
      });
  },
  async retrySave(e: Event) {
    await this.owner?.retrySave(e.currentTarget.dataset.id);
    void this.queueUploads();
  },

  async upload(e: Event) {
    const g = this.generation,
      context = sessionClient.context(),
      owner = this.owner;
    if (!owner) return;
    try {
      await owner.upload(
        e.currentTarget.dataset.id,
        this.assistedSessionId || undefined,
      );
      if (!this.current(g, context)) return;
      const result = await this.readCollection();
      if (this.current(g, context)) {
        if (
          this.data.hasDraft &&
          result.snapshot?.revision !== this.editingRevision
        )
          this.setData({
            status:
              "照片引用已变化；未保存说明仍对应原版本，请保存后处理冲突或明确放弃草稿再查询",
          });
        else if (
          (result.snapshot?.revision ?? 0) >=
          (this.data.snapshot?.revision ?? 0)
        ) {
          this.setData({ snapshot: result.snapshot });
          void this.renderPhotos();
          await this.applyStoryPhotos();
        }
      }
    } catch (error) {
      if (
        error instanceof ApiFailure &&
        [401, 403].includes(error.status) &&
        this.relevant(g, context)
      ) {
        this.onHide();
        this.setData({ status: "权限已变化，请重新查询或登录" });
      }
    }
  },

  caption(e: Event) {
    if (this.data.busy) return;
    markEditing(true);
    this.editingRevision ??= this.data.snapshot?.revision ?? null;
    this.setData({
      hasDraft: true,
      captions: {
        ...this.data.captions,
        [e.currentTarget.dataset.id]: e.detail.value,
      },
    });
  },
  async saveCaption(e: Event) {
    const snapshot = this.data.snapshot;
    if (!snapshot) return;
    await this.revise(
      snapshot.entries.map((entry) => ({
        photoId: entry.photoId,
        caption: this.data.captions[entry.photoId] ?? entry.caption,
      })),
    );
  },
  async moveUp(e: Event) {
    const entries = this.data.snapshot?.entries.map((entry) => ({
      photoId: entry.photoId,
      caption: this.data.captions[entry.photoId] ?? entry.caption,
    }));
    if (!entries) return;
    const i = entries.findIndex(
      (entry) => entry.photoId === e.currentTarget.dataset.id,
    );
    if (i < 1) return;
    [entries[i - 1], entries[i]] = [entries[i], entries[i - 1]];
    await this.revise(entries);
  },
  async revise(entries: { photoId: string; caption: string }[]) {
    const snapshot = this.data.snapshot,
      g = this.generation,
      context = sessionClient.context();
    if (!snapshot || this.data.busy) return;
    this.setData({ busy: true });
    try {
      const next = await sessionClient.request<PhotoMaterials>(
        `/projects/${this.projectId}/interviews/${this.interviewId}/photos/materials`,
        {
          key: paymentKey(),
          data: {
            expectedRevision: this.editingRevision ?? snapshot.revision,
            entries,
            ...(this.assistedSessionId
              ? { assistedSessionId: this.assistedSessionId }
              : {}),
          },
        },
      );
      if (this.current(g, context)) {
        this.editingRevision = null;
        this.setData({
          snapshot:
            (this.data.snapshot?.revision ?? 0) > next.revision
              ? this.data.snapshot
              : next,
          captions: {},
          hasDraft: false,
          status: "照片已保存",
        });
        markEditing(false);
        void this.renderPhotos();
        await this.applyStoryPhotos();
      }
    } catch (error) {
      if (
        error instanceof ApiFailure &&
        [401, 403].includes(error.status) &&
        this.relevant(g, context)
      ) {
        this.onHide();
        this.setData({ status: "权限已变化，请重新查询" });
      } else if (this.current(g, context))
        this.setData({ status: "照片可能已经变化，请重新查询后再修改" });
    } finally {
      if (this.current(g, context)) this.setData({ busy: false });
    }
  },

  async preview(e: Event) {
    const op = ++this.previewGeneration,
      photoId = e.currentTarget.dataset.id,
      asset = this.data.snapshot?.entries
        .find((entry) => entry.photoId === photoId)
        ?.assets.find((a) => a.kind === "preview"),
      g = this.generation,
      context = sessionClient.context();
    if (!asset) return;
    this.setData({ previewPath: "" });
    try {
      const path = await privatePhotoPreview(
        this.projectId,
        this.interviewId,
        photoId,
        asset,
        () => this.current(g, context) && op === this.previewGeneration,
      );
      if (this.current(g, context) && op === this.previewGeneration)
        this.setData({ previewPath: path });
    } catch (error) {
      if (
        error instanceof ApiFailure &&
        [401, 403].includes(error.status) &&
        this.relevant(g, context)
      ) {
        this.onHide();
        this.setData({
          status: sessionClient.sessionCleanupPending()
            ? "登录已失效；设备会话缓存清理失败，请重试登录"
            : "照片权限已变化，请重新查询",
        });
      } else if (this.current(g, context) && op === this.previewGeneration)
        this.setData({
          status: "预览失败，可重新查询；尚未清理的临时图请重试清理",
        });
    }
  },
  async discardDrafts() {
    this.editingRevision = null;
    this.setData({ captions: {}, hasDraft: false });
    await this.onShow();
  },

  async release(e: Event) {
    const g = this.generation,
      context = sessionClient.context();
    try {
      await this.owner?.release(
        e.currentTarget.dataset.id,
        this.assistedSessionId || undefined,
      );
    } catch (error) {
      if (
        error instanceof ApiFailure &&
        [401, 403].includes(error.status) &&
        this.relevant(g, context)
      ) {
        this.onHide();
        this.setData({ status: "权限已变化，请重新查询" });
      } else if (this.current(g, context))
        this.setData({ status: "取消预留未确认，可重试；本机原文件仍在" });
    }
  },
  async applyStoryPhotos() {
    if (!this.storyId || !this.data.snapshot) return;
    const story = await storyClient.read(this.projectId, this.storyId);
    if (
      !story.revision ||
      story.revision.photoSnapshot?.id === this.data.snapshot.id
    )
      return;
    const input = revisionInput(story, story.revision.title, storyBody(story));
    input.photoSnapshotId = this.data.snapshot.id;
    await storyClient.revise(this.projectId, story.id, input, paymentKey());
  },
  async renderPhotos() {
    const n = this.generation,
      owner = sessionClient.context(),
      snapshot = this.data.snapshot;
    this.setData({
      rows: (snapshot?.entries || []).map((p) => ({
        id: p.photoId,
        title: p.caption,
        image: "",
      })),
    });
    await Promise.all(
      (snapshot?.entries || []).map(async (p) => {
        const asset = p.assets.find((a) => a.kind === "preview");
        if (!asset) return;
        try {
          const image = await privatePhotoPreview(
            this.projectId,
            this.interviewId,
            p.photoId,
            asset,
            () => this.current(n, owner),
          );
          if (this.current(n, owner))
            this.setData({
              rows: this.data.rows.map((r) =>
                r.id === p.photoId ? { ...r, image } : r,
              ),
            });
          else await clearPhotoPreviews([image]);
        } catch {}
      }),
    );
  },
  sort(e: WechatMiniprogram.CustomEvent<{ ids: string[] }>) {
    const entries = this.data.snapshot?.entries;
    if (entries)
      void this.revise(
        e.detail.ids.map((id) => ({
          photoId: id,
          caption:
            this.data.captions[id] ??
            entries.find((p) => p.photoId === id)!.caption,
        })),
      );
  },
  editCaption(e: WechatMiniprogram.CustomEvent<{ id: string; value: string }>) {
    this.caption({
      currentTarget: { dataset: { id: e.detail.id } },
      detail: { value: e.detail.value },
    });
  },
  showPhoto(e: WechatMiniprogram.CustomEvent<{ id: string }>) {
    const image = this.data.rows.find((r) => r.id === e.detail.id)?.image;
    if (image) {
      this.picking = true;
      wx.previewImage({
        current: image,
        urls: this.data.rows.map((r) => r.image).filter(Boolean),
        complete: () => {
          this.picking = false;
        },
      });
    }
  },
  async back() {
    if (this.data.hasDraft)
      await this.saveCaption({
        currentTarget: { dataset: {} },
        detail: { value: "" },
      });
    if (this.data.hasDraft) return;
    try {
      await this.applyStoryPhotos();
      markEditing(false);
      wx.navigateBack();
    } catch {
      this.setData({ status: "照片尚未同步到故事，请重试保存" });
    }
  },
});
