import { storyClient } from "../../services/stories";
import {
  revisionInput,
  storyBody,
  markEditing,
} from "../../services/book-editor";
import { watchPermission } from "../../services/project-access";
import { paymentKey } from "../../services/payments";
import { recordingId } from "../../services/local-audio-recorder";
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
  ProjectPhoto,
  ParticipationState,
} from "../../../packages/contracts/src";
type PhotoRow = {
  id: string;
  title: string;
  image: string;
  imageLoading: boolean;
  selected: boolean;
  lowResolution: boolean;
};
type PhotoEvent = {
  currentTarget: { dataset: { id: string } };
  detail?: { value: string };
};
Page({
  data: {
    rows: [] as PhotoRow[],
    photos: [] as LocalPhoto[],
    selectedId: "",
    selectedTitle: "",
    selectedIds: [] as string[],
    captions: {} as Record<string, string>,
    selection: false,
    status: "",
    busy: false,
    pageLoading: true,
  },
  projectId: "",
  interviewId: "",
  storyId: "",
  assistedSessionId: "",
  snapshot: null as PhotoMaterials | null,
  assets: [] as ProjectPhoto[],
  owner: null as PhotoFiles | null,
  generation: 0,
  picking: false,
  startingId: "",
  uploadQueue: null as Promise<void> | null,
  stopProjectWatch: undefined as (() => void) | undefined,
  stopSessionWatch: undefined as (() => void) | undefined,
  onLoad(q: Record<string, string>) {
    this.projectId = q.projectId || "";
    this.interviewId = q.interviewId || "";
    this.storyId = q.storyId || "";
    this.assistedSessionId = q.assistedSessionId || "";
    this.setData({ selection: !!(this.interviewId || this.storyId) });
    wx.setNavigationBarTitle({
      title: this.data.selection ? "选择照片" : "项目照片",
    });
  },
  current(g: number, context: string) {
    return this.generation === g && sessionClient.context() === context;
  },
  async onShow() {
    if (this.picking) return;
    const g = ++this.generation,
      context = sessionClient.context();
    this.setData({
      pageLoading: !this.data.rows.length,
      busy: true,
      status: "",
    });
    this.stopSessionWatch?.();
    this.stopSessionWatch = sessionClient.onInvalidated((previous) => {
      if (previous === context) this.deny();
    });
    try {
      if (!/^[a-f0-9-]{36}$/.test(this.projectId))
        throw Error("请从故事书进入照片");
      if (this.storyId && !this.interviewId) {
        const story = await storyClient.read(this.projectId, this.storyId);
        if (!this.current(g, context)) return;
        this.interviewId = story.interviewId;
      }
      await this.load(g, context, true);
      if (!this.current(g, context)) return;
      this.owner = PhotoFiles.open(this.projectId);
      this.owner.subscribe((photos) => {
        if (this.current(g, context))
          this.setData({
            photos: photos.filter((p) => !p.released && p.state !== "sealed"),
          });
      });
      this.stopProjectWatch?.();
      this.stopProjectWatch = watchPermission(
        () => this.current(g, context),
        async () =>
          (
            await sessionClient.request<ParticipationState>(
              `/projects/${this.projectId}/participation`,
            )
          ).canRead,
        () => this.deny(),
      );
      void this.queueUploads();
    } catch (error) {
      this.fail(error, g, context);
    } finally {
      if (this.current(g, context))
        this.setData({ pageLoading: false, busy: false });
    }
  },
  async load(g: number, context: string, readSelection = false) {
    const result = await sessionClient.request<PhotoCollection>(
      `/projects/${this.projectId}/photos`,
    );
    const snapshot =
      readSelection && this.interviewId
        ? await sessionClient.request<PhotoMaterials | null>(
            `/projects/${this.projectId}/interviews/${this.interviewId}/photo-materials`,
          )
        : this.snapshot;
    if (!this.current(g, context)) return;
    this.assets = result.photos.filter((photo) => photo.state === "sealed");
    this.snapshot = snapshot;
    if (readSelection)
      this.setData({
        selectedIds: snapshot?.entries.map((entry) => entry.photoId) ?? [],
        captions: Object.fromEntries(
          snapshot?.entries.map((entry) => [entry.photoId, entry.caption]) ??
            [],
        ),
      });
    const previous = this.data.rows;
    this.setData({
      rows: this.assets.map((photo, index) => ({
        id: photo.id,
        title: this.data.captions[photo.id] || `照片 ${index + 1}`,
        image: previous.find((row) => row.id === photo.id)?.image || "",
        imageLoading: !previous.find((row) => row.id === photo.id)?.image,
        selected: this.data.selection
          ? this.data.selectedIds.includes(photo.id)
          : this.data.selectedId === photo.id,
        lowResolution: photo.lowResolution === true,
      })),
    });
    await Promise.all(
      this.assets.map(async (photo) => {
        if (this.data.rows.find((row) => row.id === photo.id)?.image) return;
        const asset = photo.assets.find(
          (item) =>
            item.kind === "preview" &&
            item.processingVersion === "t04-pixels-v1",
        );
        if (!asset) return;
        try {
          const image = await privatePhotoPreview(
            this.projectId,
            photo.id,
            asset,
            () => this.current(g, context),
          );
          if (this.current(g, context))
            this.setData({
              rows: this.data.rows.map((row) =>
                row.id === photo.id
                  ? { ...row, image, imageLoading: false }
                  : row,
              ),
            });
          else await clearPhotoPreviews([image]);
        } catch (error) {
          if (error instanceof ApiFailure && [401, 403].includes(error.status))
            this.fail(error, g, context);
          else if (this.current(g, context))
            this.setData({
              rows: this.data.rows.map((row) =>
                row.id === photo.id ? { ...row, imageLoading: false } : row,
              ),
            });
        }
      }),
    );
  },
  fail(error: unknown, g: number, context: string) {
    if (!this.current(g, context)) return;
    if (error instanceof ApiFailure && [401, 403].includes(error.status)) {
      this.deny();
      return;
    }
    this.setData({
      status:
        error instanceof ApiFailure && error.status === 409
          ? "照片选择已变化，请重新读取后再保存"
          : error instanceof Error
            ? error.message
            : "操作未完成，请重试",
    });
  },
  deny() {
    this.onHide();
    this.setData({
      status: "照片权限已变化，请返回故事书重新进入",
      pageLoading: false,
    });
  },
  onHide() {
    if (this.picking) return;
    this.generation++;
    this.stopProjectWatch?.();
    this.stopProjectWatch = undefined;
    this.stopSessionWatch?.();
    this.stopSessionWatch = undefined;
    this.owner?.unsubscribe();
    this.snapshot = null;
    this.assets = [];
    this.setData({
      rows: [],
      photos: [],
      captions: {},
      selectedIds: [],
      selectedId: "",
      selectedTitle: "",
      busy: false,
    });
    void clearPhotoPreviews().catch(() => {});
  },
  onUnload() {
    this.picking = false;
    markEditing(false);
    this.onHide();
  },
  async choose() {
    if (!this.owner || this.data.busy) return;
    const g = this.generation,
      context = sessionClient.context();
    this.picking = true;
    this.setData({ busy: true, status: "" });
    try {
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
      await this.owner.add(result.tempFiles);
      await this.queueUploads();
    } catch (error) {
      if (!/cancel/i.test(String((error as { errMsg?: string })?.errMsg || "")))
        this.fail(error, g, context);
    } finally {
      this.picking = false;
      if (this.current(g, context)) this.setData({ busy: false });
    }
  },
  async queueUploads(): Promise<void> {
    if (this.uploadQueue) return this.uploadQueue;
    const g = this.generation,
      context = sessionClient.context();
    const job = (async () => {
      for (const photo of this.owner
        ?.snapshot()
        .filter((p) => p.state === "local" && !p.released) ?? []) {
        if (!this.current(g, context)) return;
        await this.upload({
          currentTarget: { dataset: { id: photo.clientPhotoId } },
        });
      }
    })();
    this.uploadQueue = job;
    try {
      await job;
    } finally {
      if (this.uploadQueue === job) this.uploadQueue = null;
    }
  },
  async retrySave(e: PhotoEvent) {
    await this.owner?.retrySave(e.currentTarget.dataset.id);
    await this.queueUploads();
  },
  async upload(e: PhotoEvent) {
    const g = this.generation,
      context = sessionClient.context();
    try {
      await this.owner?.upload(
        e.currentTarget.dataset.id,
        this.assistedSessionId || undefined,
      );
      if (!this.current(g, context)) return;
      const photo = this.owner
        ?.snapshot()
        .find((item) => item.clientPhotoId === e.currentTarget.dataset.id);
      if (photo?.state === "sealed" && photo.serverId && this.data.selection) {
        this.setData({
          selectedIds: [...new Set([...this.data.selectedIds, photo.serverId])],
        });
        markEditing(true);
      }
      await this.load(g, context);
    } catch (error) {
      this.fail(error, g, context);
    }
  },
  async release(e: PhotoEvent) {
    const g = this.generation,
      context = sessionClient.context();
    try {
      await this.owner?.release(
        e.currentTarget.dataset.id,
        this.assistedSessionId || undefined,
      );
    } catch (error) {
      this.fail(error, g, context);
    }
  },
  select(e: PhotoEvent) {
    if (this.data.busy) return;
    const id = e.currentTarget.dataset.id,
      row = this.data.rows.find((item) => item.id === id);
    if (!row) return;
    if (this.data.selection) {
      const ids = this.data.selectedIds.includes(id)
        ? this.data.selectedIds.filter((value) => value !== id)
        : [...this.data.selectedIds, id];
      this.setData({
        selectedIds: ids,
        rows: this.data.rows.map((item) => ({
          ...item,
          selected: ids.includes(item.id),
        })),
      });
      markEditing(true);
    } else {
      this.startingId = "";
      this.setData({
        selectedId: id,
        selectedTitle: row.title,
        rows: this.data.rows.map((item) => ({
          ...item,
          selected: item.id === id,
        })),
      });
    }
  },
  caption(e: PhotoEvent) {
    markEditing(true);
    this.setData({
      captions: {
        ...this.data.captions,
        [e.currentTarget.dataset.id]: e.detail?.value || "",
      },
    });
  },
  preview(e: PhotoEvent) {
    const row = this.data.rows.find(
      (item) =>
        item.id === (e.currentTarget.dataset.id || this.data.selectedId),
    );
    if (!row?.image) return;
    this.picking = true;
    wx.previewImage({
      current: row.image,
      urls: this.data.rows.map((item) => item.image).filter(Boolean),
      complete: () => {
        this.picking = false;
      },
    });
  },
  async done() {
    if (!this.interviewId || this.data.busy) return;
    const g = this.generation,
      context = sessionClient.context();
    this.setData({ busy: true, status: "" });
    try {
      await this.queueUploads();
      const snapshot = await sessionClient.request<PhotoMaterials>(
        `/projects/${this.projectId}/interviews/${this.interviewId}/photo-materials`,
        {
          key: paymentKey(),
          data: {
            expectedRevision: this.snapshot?.revision ?? 0,
            entries: this.data.selectedIds.map((photoId) => ({
              photoId,
              caption: this.data.captions[photoId] || "",
            })),
            ...(this.assistedSessionId
              ? { assistedSessionId: this.assistedSessionId }
              : {}),
          },
        },
      );
      if (!this.current(g, context)) return;
      this.snapshot = snapshot;
      if (this.storyId) {
        const story = await storyClient.read(this.projectId, this.storyId);
        if (!this.current(g, context)) return;
        if (
          story.revision &&
          story.revision.photoSnapshot?.id !== snapshot.id
        ) {
          const input = revisionInput(
            story,
            story.revision.title,
            storyBody(story),
          );
          input.photoSnapshotId = snapshot.id;
          await storyClient.revise(
            this.projectId,
            story.id,
            input,
            paymentKey(),
          );
        }
      }
      if (this.current(g, context)) {
        markEditing(false);
        wx.navigateBack();
      }
    } catch (error) {
      this.fail(error, g, context);
    } finally {
      if (this.current(g, context)) this.setData({ busy: false });
    }
  },
  async recordPhoto() {
    if (!this.data.selectedId || this.data.busy) return;
    const g = this.generation,
      context = sessionClient.context(),
      photoId = this.data.selectedId;
    this.setData({ busy: true, status: "" });
    try {
      const recording = await interviewRecordingClient.context(this.projectId);
      if (!this.current(g, context)) return;
      if (!recording.canRecord) throw Error("当前项目暂时无法新增讲述");
      this.startingId ||= recordingId();
      const interview = await interviewRecordingClient.start(
        this.projectId,
        {
          clientInterviewId: this.startingId,
          expectedPlanRevision: recording.plan.revision,
          starterKind: "photo",
        },
        this.startingId,
      );
      if (!this.current(g, context)) return;
      await sessionClient.request<PhotoMaterials>(
        `/projects/${this.projectId}/interviews/${interview.id}/photo-materials`,
        {
          key: this.startingId + "-photos",
          data: {
            expectedRevision: 0,
            entries: [{ photoId, caption: this.data.captions[photoId] || "" }],
          },
        },
      );
      if (this.current(g, context))
        wx.navigateTo({
          url: `/pages/interview/index?projectId=${this.projectId}&interviewId=${interview.id}&prepare=1`,
        });
    } catch (error) {
      this.fail(error, g, context);
    } finally {
      if (this.current(g, context)) this.setData({ busy: false });
    }
  },
});
