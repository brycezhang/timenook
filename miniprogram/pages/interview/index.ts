import { MAX_RECORDING_DURATION_MS } from "../../../packages/contracts/src/recording";
import type {
  ActualPlanQuestion,
  PhotoMaterials,
  RecordingContext,
  RecordingInterview,
} from "../../../packages/contracts/src";
import type { ProbeSnapshot } from "../../../packages/contracts/src/audio-probe";
import { switchProjectTab } from "../../services/navigation";
import { sessionClient, ApiFailure } from "../../services/session";
import {
  clearPhotoPreviews,
  privatePhotoPreview,
} from "../../services/story-photos";
import {
  InterviewRecorder,
  interviewRecordingClient,
  recordingPartition,
  type InterviewLocalClip,
} from "../../services/interview-recording";
import { recordingId } from "../../services/local-audio-recorder";
import { paymentKey } from "../../services/payments";
import { watchPermission } from "../../services/project-access";

type Screen =
  "ready" | "recording" | "paused" | "saving" | "failed" | "blocked";
type E = { currentTarget: { dataset: { id: string } } };
const titles: Record<Screen, string> = {
  ready: "开始讲述",
  recording: "正在录音",
  paused: "录音已暂停",
  saving: "保存录音",
  failed: "录音上传失败",
  blocked: "麦克风权限",
};
function time(ms: number) {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  return `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}
function sourceLabel(question: ActualPlanQuestion) {
  const source = question.source;
  if (source?.kind === "family")
    return `${source.authorRelationship} · ${source.authorNickname}的提问`;
  if (question.starterKind === "photo" || source?.kind === "photo")
    return "从照片讲起";
  if (
    question.starterKind === "free-narration" ||
    source?.kind === "free-narration"
  )
    return "自由讲述";
  if (source?.kind === "self-written") return "自己的问题";
  if (source?.kind === "follow-up") return "补充讲述";
  return "大纲问题";
}
Page({
  data: {
    screen: "ready" as Screen,
    navigationTitle: titles.ready,
    pageLoading: true,
    busy: false,
    canRecord: false,
    canChooseQuestion: true,
    question: "",
    questionSource: "",
    interview: null as RecordingInterview | null,
    state: "idle" as ProbeSnapshot["stage"],
    timer: "00:00",
    recordingLimitLabel: "10:00",
    recordingMaxMinutes: MAX_RECORDING_DURATION_MS / 60000,
    localClips: [] as InterviewLocalClip[],
    pendingInterviews: [] as string[],
    recordingPhotos: [] as {
      photoId: string;
      caption: string;
      image: string;
    }[],
    photoIndex: 0,
    photosLoading: false,
    photoError: "",
    status: "",
    uploadProgress: 0,
    hasUploadProgress: false,
    localSaveFailed: false,
    wave: [
      12, 20, 32, 17, 45, 35, 58, 44, 26, 61, 42, 29, 49, 63, 33, 19, 44, 29,
      55, 41, 23, 47, 33, 17, 26, 44, 33, 23, 14,
    ],
  },
  projectId: "",
  assistedSessionId: "",
  requestedInterviewId: "",
  draftId: "",
  requestedQuestionKey: "",
  starterKind: "" as "" | "photo" | "free-narration",
  preparing: true,
  generation: 0,
  visible: false,
  visitingPhotos: false,
  pendingPhotoNavigation: false,
  openingSettings: false,
  leaving: false,
  leaveAfterSave: false,
  finishing: false,
  ownerContext: "",
  context: null as RecordingContext | null,
  liveRecorder: null as InterviewRecorder | null,
  photoSnapshot: null as PhotoMaterials | null,
  selection: null as { input: string; id: string; key: string } | null,
  uploadJob: null as Promise<void> | null,
  timerHandle: undefined as ReturnType<typeof setInterval> | undefined,
  stopPermissionWatch: undefined as (() => void) | undefined,
  stopSessionWatch: undefined as (() => void) | undefined,
  onLoad(q: Record<string, string>) {
    this.projectId = q.projectId || "";
    this.assistedSessionId = q.assistedSessionId || "";
    this.requestedInterviewId = q.interviewId || "";
    this.draftId =
      q.draftId || (!this.requestedInterviewId ? recordingId() : "");
    this.requestedQuestionKey = q.questionKey || "";
    this.starterKind =
      q.starterKind === "photo" || q.starterKind === "free-narration"
        ? q.starterKind
        : "";
    this.preparing = q.prepare === "1" || !this.requestedInterviewId;
  },
  current(g: number, context: string) {
    return (
      g === this.generation && !!context && context === sessionClient.context()
    );
  },
  showScreen(screen: Screen) {
    this.setData({ screen, navigationTitle: titles[screen] });
  },
  async onShow() {
    this.visible = true;
    if (this.openingSettings) return;
    if (this.visitingPhotos && this.liveRecorder && this.data.interview) {
      this.visitingPhotos = false;
      const g = this.generation,
        owner = this.ownerContext;
      try {
        const access = await interviewRecordingClient.authorizeCollection(
          this.projectId,
          this.data.interview.id,
          this.assistedSessionId || undefined,
        );
        if (!this.current(g, owner)) return;
        if (!access.allowed) throw new ApiFailure("FORBIDDEN", 403);
        await this.loadRecordingPhotos();
        if (this.current(g, owner)) {
          this.updateSnapshot(this.liveRecorder.snapshot());
          this.queueAutoUpload();
        }
      } catch (error) {
        this.fail(error, g, owner);
      }
      return;
    }
    this.visitingPhotos = false;
    await this.refresh();
  },
  onHide() {
    this.visible = false;
    // Opening the in-project photo picker must retain the paused native segment.
    if (this.visitingPhotos || this.openingSettings) return;
    this.clearPrivateView();
  },
  onUnload() {
    this.visitingPhotos = false;
    this.openingSettings = false;
    this.visible = false;
    this.clearPrivateView();
    wx.disableAlertBeforeUnload?.();
  },
  clearPrivateView() {
    ++this.generation;
    this.stopPermissionWatch?.();
    this.stopPermissionWatch = undefined;
    this.stopSessionWatch?.();
    this.stopSessionWatch = undefined;
    if (this.timerHandle) clearInterval(this.timerHandle);
    this.timerHandle = undefined;
    // The recorder owns its pending native save, independent of this page/session.
    this.liveRecorder?.unsubscribe();
    this.liveRecorder?.stop();
    this.liveRecorder = null;
    this.context = null;
    this.ownerContext = "";
    this.selection = null;
    this.uploadJob = null;
    this.photoSnapshot = null;
    this.finishing = false;
    this.pendingPhotoNavigation = false;
    this.leaveAfterSave = false;
    void clearPhotoPreviews(
      this.data.recordingPhotos.map((photo) => photo.image).filter(Boolean),
    ).catch(() => {});
    this.setData({
      screen: "ready",
      navigationTitle: titles.ready,
      state: "idle",
      localSaveFailed: false,
      question: "",
      questionSource: "",
      interview: null,
      localClips: [],
      pendingInterviews: [],
      recordingPhotos: [],
      photoError: "",
      busy: false,
      canRecord: false,
      pageLoading: false,
    });
  },
  fail(error: unknown, g: number, owner: string) {
    if (g !== this.generation) return;
    if (
      !sessionClient.context() ||
      (error instanceof ApiFailure && [401, 403].includes(error.status))
    ) {
      this.clearPrivateView();
      this.setData({ status: "当前权限已变化，请重新查询；本机录音仍保留。" });
      return;
    }
    if (!this.current(g, owner)) return;
    this.setData({
      status: error instanceof Error ? error.message : "操作未完成，请重试",
    });
  },
  async refresh() {
    if (!this.visible) return;
    const g = ++this.generation,
      owner = sessionClient.context();
    this.stopPermissionWatch?.();
    this.stopSessionWatch?.();
    this.stopSessionWatch = sessionClient.onInvalidated((previous) => {
      if (previous !== owner) return;
      this.clearPrivateView();
      this.setData({ status: "登录已失效，请重新登录；本机录音仍保留。" });
    });
    this.setData({ pageLoading: !this.data.question, busy: true, status: "" });
    try {
      if (!/^[a-f0-9-]{36}$/.test(this.projectId))
        throw Error("请从故事书进入讲述");
      if (!owner) throw new ApiFailure("UNAUTHENTICATED", 401);
      const result = await interviewRecordingClient.context(
        this.projectId,
        this.assistedSessionId || undefined,
      );
      if (!this.current(g, owner)) return;
      this.context = result;
      this.ownerContext = owner;
      const question =
        result.plan.eligibleQuestions.find(
          (q) => q.key === this.requestedQuestionKey,
        ) ?? result.plan.defaultQuestion;
      this.setData({
        canRecord: result.canRecord,
        status: result.canRecord
          ? ""
          : "当前项目暂时不能新增录音，请重新查询。",
        question: this.starterKind
          ? result.plan.starters.find((s) => s.kind === this.starterKind)
              ?.text || "自由讲述"
          : question?.text || "自由讲述",
        questionSource:
          this.starterKind === "photo"
            ? "从照片讲起"
            : this.starterKind === "free-narration" || !question
              ? "自由讲述"
              : "大纲问题",
      });
      const partition = recordingPartition(this.projectId);
      const active =
        this.requestedInterviewId ||
        (this.draftId
          ? wx.getStorageSync(`${partition}:draft:${this.draftId}`)
          : "");
      let selected = result.interviews.find((i) => i.id === active);
      if (
        !selected &&
        typeof active === "string" &&
        /^[a-f0-9-]{36}$/.test(active)
      )
        selected = await interviewRecordingClient.resume(
          this.projectId,
          active,
          this.assistedSessionId || undefined,
        );
      if (!this.current(g, owner)) return;
      if (selected) await this.attach(selected, g, owner);
      else {
        this.showScreen("ready");
        this.setData({ state: "idle", canChooseQuestion: true });
      }
      this.loadPending();
    } catch (error) {
      this.fail(error, g, owner);
    } finally {
      if (this.current(g, owner)) {
        this.setData({ pageLoading: false, busy: false });
        this.queueAutoUpload();
        if (!this.preparing && this.isSaved()) this.saved();
      }
    }
  },
  loadPending() {
    const partition = recordingPartition(this.projectId);
    const index: unknown = wx.getStorageSync(`${partition}:index`);
    this.setData({
      pendingInterviews: Array.isArray(index)
        ? index.filter((id) => {
            if (
              typeof id !== "string" ||
              !/^[a-f0-9-]{36}$/.test(id) ||
              id === this.data.interview?.id
            )
              return false;
            const clips: unknown = wx.getStorageSync(`${partition}:${id}`);
            return (
              Array.isArray(clips) &&
              clips.some((clip) => clip?.path && !clip.sealed)
            );
          })
        : [],
    });
  },
  remember(interview: RecordingInterview) {
    const partition = recordingPartition(this.projectId);
    const index: unknown = wx.getStorageSync(`${partition}:index`);
    const ids = Array.isArray(index)
      ? index.filter(
          (id) => typeof id === "string" && /^[a-f0-9-]{36}$/.test(id),
        )
      : [];
    wx.setStorageSync(`${partition}:index`, [
      ...new Set([...ids, interview.id]),
    ]);
    if (this.draftId)
      wx.setStorageSync(`${partition}:draft:${this.draftId}`, interview.id);
    this.requestedInterviewId = interview.id;
  },
  async attach(value: RecordingInterview, g: number, owner: string) {
    if (
      value.projectId !== this.projectId ||
      !value.actualQuestion?.snapshot?.text
    )
      throw Error("讲述信息不匹配");
    this.liveRecorder?.unsubscribe();
    const device = InterviewRecorder.open(
      this.projectId,
      value,
      () => this.data.canRecord,
      this.assistedSessionId || undefined,
    );
    this.liveRecorder = device;
    this.remember(value);
    this.ownerContext = owner;
    const question = value.currentQuestion ?? value.actualQuestion;
    this.setData({
      interview: value,
      question: question.snapshot.text,
      questionSource: sourceLabel(question),
      timer: "00:00",
      canChooseQuestion: !value.clips.length,
    });
    device.subscribe((snapshot) => {
      if (this.current(g, owner)) this.updateSnapshot(snapshot);
    });
    await device.restore();
    if (!this.current(g, owner)) return;
    this.stopPermissionWatch?.();
    this.stopPermissionWatch = watchPermission(
      () => this.current(g, owner),
      async () =>
        (
          await interviewRecordingClient.authorizeCollection(
            this.projectId,
            value.id,
            this.assistedSessionId || undefined,
          )
        ).allowed,
      () => {
        this.clearPrivateView();
        this.setData({
          status: "当前录音权限已变化；录音已停止，本机文件仍保留。",
        });
      },
    );
    await this.loadRecordingPhotos();
  },
  updateSnapshot(snapshot: ProbeSnapshot) {
    const stage = snapshot.stage,
      device = this.liveRecorder;
    if (!device) return;
    if (stage === "device-error" && this.pendingPhotoNavigation) {
      this.pendingPhotoNavigation = false;
      this.setData({ busy: false });
    }
    const pending = snapshot.clips.some((clip) => !clip.sealed);
    let screen: Screen = "ready";
    if (stage === "recording") screen = "recording";
    else if (stage === "paused") screen = "paused";
    else if (stage === "device-error")
      screen = snapshot.hasPendingSave ? "failed" : "blocked";
    else if (["upload-error", "seal-error"].includes(stage)) screen = "failed";
    else if (
      ["saving", "uploading", "sealing"].includes(stage) ||
      pending ||
      this.finishing
    )
      screen = "saving";
    const latest = snapshot.clips[snapshot.clips.length - 1];
    const uploadProgress = device.uploadProgress();
    this.setData({
      state: stage,
      localClips: snapshot.clips,
      localSaveFailed: stage === "device-error" && snapshot.hasPendingSave,
      canChooseQuestion:
        !this.data.interview?.clips.length &&
        !snapshot.clips.length &&
        ["idle", "device-error"].includes(stage),
      timer: ["recording", "paused"].includes(stage)
        ? time(device.elapsedRecordingMs())
        : latest && screen !== "ready"
          ? time(latest.durationMs)
          : this.data.timer,
      uploadProgress: uploadProgress ?? 0,
      hasUploadProgress: uploadProgress !== null,
    });
    this.showScreen(screen);
    if (this.timerHandle) clearInterval(this.timerHandle);
    this.timerHandle = undefined;
    if (stage === "recording") {
      this.timerHandle = setInterval(
        () => this.setData({ timer: time(device.elapsedRecordingMs()) }),
        1000,
      );
      wx.enableAlertBeforeUnload?.({
        message: "离开会结束录音并保存在当前设备，返回后可继续保存。",
      });
    } else if (
      stage === "paused" ||
      stage === "saving" ||
      snapshot.hasPendingSave
    ) {
      wx.enableAlertBeforeUnload?.({
        message: "录音尚未保存完成，离开后请回到本机继续保存。",
      });
    } else wx.disableAlertBeforeUnload?.();
    if (stage === "local" && pending) this.queueAutoUpload();
    if (stage === "paused" && this.pendingPhotoNavigation) this.openPhotos();
  },
  async ensureInterview() {
    if (this.data.interview) return this.data.interview;
    if (!this.context || !this.data.canRecord || this.data.busy) return null;
    const g = this.generation,
      owner = this.ownerContext;
    const selected =
      this.context.plan.eligibleQuestions.find(
        (q) => q.key === this.requestedQuestionKey,
      ) ?? this.context.plan.defaultQuestion;
    const source = this.starterKind
      ? { starterKind: this.starterKind }
      : selected
        ? { questionKey: selected.key }
        : { starterKind: "free-narration" };
    const body = {
      expectedPlanRevision: this.context.plan.revision,
      ...source,
      ...(this.assistedSessionId
        ? { assistedSessionId: this.assistedSessionId }
        : {}),
    };
    const input = JSON.stringify(body);
    if (this.selection?.input !== input)
      this.selection = {
        input,
        id: this.draftId || recordingId(),
        key: paymentKey(),
      };
    this.setData({ busy: true, status: "" });
    try {
      const value = await interviewRecordingClient.start(
        this.projectId,
        { ...body, clientInterviewId: this.selection.id },
        this.selection.key,
      );
      if (!this.current(g, owner)) return null;
      await this.attach(value, g, owner);
      if (!this.current(g, owner)) return null;
      this.selection = null;
      return value;
    } catch (error) {
      this.fail(error, g, owner);
      return null;
    } finally {
      if (this.current(g, owner)) this.setData({ busy: false });
    }
  },
  async startSpeaking() {
    if (this.data.busy || !this.data.canRecord || this.data.screen !== "ready")
      return;
    if (!(await this.ensureInterview())) return;
    await this.authorizeRecording(false);
  },
  async authorizeRecording(resume: boolean) {
    const device = this.liveRecorder,
      interview = this.data.interview;
    if (!device || !interview || this.data.busy) return;
    const g = this.generation,
      owner = this.ownerContext,
      question = interview.currentQuestion ?? interview.actualQuestion;
    this.setData({ busy: true, status: "" });
    try {
      const result = await interviewRecordingClient.authorizeStart(
        this.projectId,
        interview.id,
        question.id,
        interview.questionVersion ?? 1,
        this.assistedSessionId || undefined,
      );
      if (!this.current(g, owner) || device !== this.liveRecorder) return;
      if (!result.allowed) throw new ApiFailure("FORBIDDEN", 403);
      if (
        result.actualQuestionId !== question.id ||
        result.questionVersion !== (interview.questionVersion ?? 1)
      )
        throw Error("当前问题已变化，请重新进入讲述");
      if (
        !Number.isSafeInteger(result.maxDurationMs) ||
        result.maxDurationMs < 1 ||
        result.maxDurationMs > MAX_RECORDING_DURATION_MS
      )
        throw Error("录音额度未确认，请重试");
      this.preparing = false;
      if (resume) device.resume();
      else {
        this.setData({
          timer: "00:00",
          recordingLimitLabel: time(
            Math.ceil(result.maxDurationMs / 1000) * 1000,
          ),
        });
        device.start(question.id, result.maxDurationMs);
      }
    } catch (error) {
      this.fail(error, g, owner);
    } finally {
      if (this.current(g, owner)) this.setData({ busy: false });
    }
  },
  async togglePause() {
    if (this.data.busy || !this.liveRecorder) return;
    if (this.data.state === "recording") this.liveRecorder.pause();
    else if (this.data.state === "paused") await this.authorizeRecording(true);
  },
  finishRecording() {
    if (
      !this.liveRecorder ||
      this.data.busy ||
      !["recording", "paused", "requesting"].includes(this.data.state)
    )
      return;
    this.finishing = true;
    this.liveRecorder.stop();
  },
  queueAutoUpload() {
    const g = this.generation;
    void Promise.resolve().then(() => {
      if (
        g === this.generation &&
        this.visible &&
        !this.data.busy &&
        this.data.state === "local" &&
        this.data.localClips.some((clip) => !clip.sealed)
      )
        void this.uploadPending();
    });
  },
  async uploadPending() {
    if (this.uploadJob) return this.uploadJob;
    const device = this.liveRecorder,
      g = this.generation,
      owner = this.ownerContext;
    if (!device || !this.current(g, owner)) return;
    this.finishing = true;
    this.showScreen("saving");
    this.setData({ busy: true, status: "" });
    const job = (async () => {
      try {
        for (const clip of device
          .snapshot()
          .clips.filter((clip) => !clip.sealed)) {
          if (!this.current(g, owner)) return;
          await device.upload(clip.clientClipId);
        }
        if (this.current(g, owner) && this.isSaved()) this.saved();
      } catch (error) {
        this.fail(error, g, owner);
      } finally {
        if (this.current(g, owner)) this.setData({ busy: false });
      }
    })();
    this.uploadJob = job;
    try {
      await job;
    } finally {
      if (this.uploadJob === job) this.uploadJob = null;
    }
  },
  isSaved() {
    const clips = this.liveRecorder?.snapshot().clips || [];
    return (
      !clips.some((clip) => !clip.sealed) &&
      (clips.some((clip) => clip.sealed) ||
        !!this.data.interview?.clips.some((clip) => clip.state === "sealed"))
    );
  },
  saved() {
    if (
      !this.visible ||
      this.visitingPhotos ||
      this.leaving ||
      !this.data.interview
    )
      return;
    this.finishing = false;
    wx.disableAlertBeforeUnload?.();
    if (this.leaveAfterSave) {
      this.exitToBook();
      return;
    }
    this.leaving = true;
    wx.redirectTo({
      url: `/pages/story/index?projectId=${encodeURIComponent(this.projectId)}&interviewId=${encodeURIComponent(this.data.interview.id)}${this.assistedSessionId ? `&assistedSessionId=${encodeURIComponent(this.assistedSessionId)}` : ""}`,
      fail: () => {
        this.leaving = false;
        this.setData({ status: "录音已保存，点击查看故事。" });
      },
    });
  },
  async retryProcessing() {
    if (this.data.busy || !this.liveRecorder) return;
    this.setData({ status: "" });
    if (this.liveRecorder.snapshot().hasPendingSave) {
      await this.liveRecorder.retrySave();
      this.queueAutoUpload();
    } else await this.uploadPending();
  },
  async loadRecordingPhotos() {
    const interview = this.data.interview,
      g = this.generation,
      owner = this.ownerContext;
    if (!interview) return;
    const current = () =>
      this.current(g, owner) && this.data.interview?.id === interview.id;
    this.setData({ photosLoading: true, photoError: "" });
    try {
      const result = await sessionClient.request<PhotoMaterials | null>(
        `/projects/${this.projectId}/interviews/${interview.id}/photo-materials`,
      );
      if (!current()) return;
      if (
        result &&
        (result.projectId !== this.projectId ||
          result.interviewId !== interview.id)
      )
        throw Error("照片归属不匹配");
      this.photoSnapshot = result;
      const old = this.data.recordingPhotos;
      this.setData({
        recordingPhotos: (result?.entries || []).map((entry) => ({
          photoId: entry.photoId,
          caption: entry.caption,
          image: "",
        })),
        photoIndex: 0,
      });
      await clearPhotoPreviews(old.map((photo) => photo.image).filter(Boolean));
      await Promise.all(
        (result?.entries || []).map(async (entry) => {
          const asset = entry.assets.find((a) => a.kind === "preview");
          if (!asset || !current()) return;
          const image = await privatePhotoPreview(
            this.projectId,
            entry.photoId,
            asset,
            current,
          );
          if (current())
            this.setData({
              recordingPhotos: this.data.recordingPhotos.map((photo) =>
                photo.photoId === entry.photoId ? { ...photo, image } : photo,
              ),
            });
          else await clearPhotoPreviews([image]);
        }),
      );
    } catch (error) {
      if (error instanceof ApiFailure && [401, 403].includes(error.status))
        this.fail(error, g, owner);
      else if (current())
        this.setData({ photoError: "照片暂时无法显示，请重试。" });
    } finally {
      if (current()) this.setData({ photosLoading: false });
    }
  },
  async photos() {
    if (
      this.data.busy ||
      ["saving", "failed", "blocked"].includes(this.data.screen)
    )
      return;
    if (!(await this.ensureInterview())) return;
    if (this.data.state === "recording") {
      this.pendingPhotoNavigation = true;
      this.setData({ busy: true });
      this.liveRecorder?.pause();
      return;
    }
    if (!["idle", "local", "sealed", "paused"].includes(this.data.state))
      return;
    this.openPhotos();
  },
  openPhotos() {
    this.pendingPhotoNavigation = false;
    this.setData({ busy: false });
    this.visitingPhotos = true;
    wx.navigateTo({
      url: `/pages/photos/index?projectId=${encodeURIComponent(this.projectId)}&interviewId=${encodeURIComponent(this.data.interview!.id)}${this.assistedSessionId ? `&assistedSessionId=${encodeURIComponent(this.assistedSessionId)}` : ""}`,
      fail: () => {
        this.visitingPhotos = false;
        this.setData({ status: "照片页未能打开，请重试。" });
      },
    });
  },
  photoChanged(e: { detail: { current: number } }) {
    this.setData({ photoIndex: e.detail.current });
  },
  async removePhoto(e: E) {
    const interview = this.data.interview,
      snapshot = this.photoSnapshot;
    if (
      !interview ||
      !snapshot ||
      this.data.busy ||
      !["ready", "recording", "paused"].includes(this.data.screen)
    )
      return;
    const id = e.currentTarget.dataset.id;
    if (!snapshot.entries.some((photo) => photo.photoId === id)) return;
    const g = this.generation,
      owner = this.ownerContext;
    this.setData({ busy: true, photoError: "" });
    try {
      const next = await sessionClient.request<PhotoMaterials>(
        `/projects/${this.projectId}/interviews/${interview.id}/photo-materials`,
        {
          key: paymentKey(),
          data: {
            expectedRevision: snapshot.revision,
            entries: snapshot.entries
              .filter((entry) => entry.photoId !== id)
              .map(({ photoId, caption }) => ({ photoId, caption })),
            ...(this.assistedSessionId
              ? { assistedSessionId: this.assistedSessionId }
              : {}),
          },
        },
      );
      if (!this.current(g, owner)) return;
      this.photoSnapshot = next;
      const removed = this.data.recordingPhotos.find(
        (photo) => photo.photoId === id,
      );
      const photos = this.data.recordingPhotos.filter(
        (photo) => photo.photoId !== id,
      );
      this.setData({
        recordingPhotos: photos,
        photoIndex: Math.min(
          this.data.photoIndex,
          Math.max(0, photos.length - 1),
        ),
      });
      if (removed?.image) await clearPhotoPreviews([removed.image]);
    } catch (error) {
      if (error instanceof ApiFailure && [401, 403].includes(error.status))
        this.fail(error, g, owner);
      else if (this.current(g, owner))
        this.setData({ photoError: "照片移除未确认，请重新读取后再试。" });
    } finally {
      if (this.current(g, owner)) this.setData({ busy: false });
    }
  },
  chooseAnother() {
    if (
      this.data.busy ||
      this.data.screen !== "ready" ||
      !this.data.canChooseQuestion
    )
      return;
    // Replace this empty preparation, so Back cannot reopen a superseded question.
    wx.redirectTo({
      url: `/pages/directory/index?projectId=${encodeURIComponent(this.projectId)}`,
    });
  },
  settings() {
    if (this.data.busy || this.data.screen !== "blocked") return;
    const g = this.generation,
      owner = this.ownerContext;
    this.openingSettings = true;
    wx.openSetting({
      success: (result) => {
        if (!this.current(g, owner)) return;
        if (result.authSetting["scope.record"]) {
          this.showScreen("ready");
          this.setData({ status: "", state: "idle" });
        }
      },
      complete: () => {
        this.openingSettings = false;
      },
    });
  },
  async leave() {
    if (this.leaving) return;
    if (
      ["recording", "paused", "requesting", "saving"].includes(
        this.data.state,
      ) ||
      this.data.localSaveFailed
    ) {
      const g = this.generation,
        owner = this.ownerContext;
      const confirmed = await new Promise<boolean>((resolve) =>
        wx.showModal({
          title: "保存这段讲述？",
          content: "保存后返回这本书，故事会继续整理。",
          confirmText: "保存并离开",
          cancelText: "继续讲述",
          success: (result) => resolve(result.confirm),
          fail: () => resolve(false),
        }),
      );
      if (!confirmed || !this.current(g, owner)) return;
      this.leaveAfterSave = true;
      if (["recording", "paused", "requesting"].includes(this.data.state))
        this.finishRecording();
      else if (this.data.localSaveFailed) await this.retryProcessing();
      return;
    }
    if (this.data.screen === "ready") {
      wx.disableAlertBeforeUnload?.();
      if (getCurrentPages().length > 1) wx.navigateBack();
      else this.exitToBook();
    } else this.exitToBook();
  },
  exitToBook() {
    this.leaving = true;
    wx.disableAlertBeforeUnload?.();
    switchProjectTab("home", this.projectId);
  },
  async resumePending(e: E) {
    const id = e.currentTarget.dataset.id;
    if (
      this.data.busy ||
      this.data.screen !== "ready" ||
      !this.data.pendingInterviews.includes(id)
    )
      return;
    wx.redirectTo({
      url: `/pages/interview/index?projectId=${encodeURIComponent(this.projectId)}&interviewId=${encodeURIComponent(id)}`,
    });
  },
});
