import { watchProjectAccess } from "../../services/project-access";
import { sessionClient, ApiFailure } from "../../services/session";
import { storyClient } from "../../services/stories";
import {
  clearPhotoPreviews,
  privatePhotoPreview,
} from "../../services/story-photos";
import {
  clearStoryAudio,
  privateStoryAudio,
  requireStoryAudioAccess,
} from "../../services/story-audio";
import { recordingPartition } from "../../services/interview-recording";
import { paymentKey } from "../../services/payments";
import { go, switchProjectTab } from "../../services/navigation";
import {
  audioTime,
  storyDuration,
  storyPlacement,
  storySources,
  storyState,
} from "../../services/story-presentation";
import type {
  StoryView,
  StoryContext,
  PhotoMaterials,
} from "../../../packages/contracts/src";
function stage(story: StoryView | null) {
  const task = story?.task;
  if (!task)
    return story?.revision ? "故事已整理" : "录音保存后，可以整理这段讲述";
  return task.state === "waiting_inputs"
    ? task.errorCode === "DEPENDENCY_FAILED"
      ? "有录音转写失败，原声已保存"
      : "正在等待全部录音转写，可离开"
    : task.state === "queued"
      ? "正在排队，可离开"
      : task.state === "submitting"
        ? "正在整理故事，可离开"
        : task.state === "succeeded"
          ? "故事已整理"
          : task.state === "no_speech"
            ? "未识别到语音，原声已保存，请回听后再录一段"
            : task.state === "no_content"
              ? "已识别到文字，暂未形成故事，可以继续补充讲述"
              : task.state === "failed"
                ? "整理失败，原声仍保留"
                : task.state === "manual_review"
                  ? "需要人工协助，原声仍保留"
                  : task.state === "obsolete"
                    ? "这次整理已失效，请保存补录后重新整理"
                    : "处理中，可离开";
}
type E = {
  currentTarget: { dataset: Record<string, string> };
  detail: { value: string };
};
Page({
  projectId: "",
  interviewId: "",
  storyId: "",
  assistedSessionId: "",
  generation: 0,
  visible: false,
  autoOrganize: false,
  ownerContext: "",
  audioSequence: 0,
  photoSequence: 0,
  photoKey: "",
  audioSeeking: false,
  liveAudio: null as WechatMiniprogram.InnerAudioContext | null,
  stopProjectWatch: undefined as (() => void) | undefined,
  stopSessionWatch: undefined as (() => void) | undefined,
  poll: undefined as ReturnType<typeof setTimeout> | undefined,
  data: {
    displayState: "saved",
    placement: "",
    storyMeta: "",
    failureTitle: "故事整理失败",
    failureHint: "录音已保存，可重试整理。",
    audioBusy: false,
    audioError: "",
    playingClipId: "",
    pausedClipId: "",
    loadingClipId: "",
    audioPosition: 0,
    audioDuration: 0,
    audioPositionLabel: "00:00",
    audioDurationLabel: "--:--",
    liveAudioSources: [] as {
      clipId: string;
      durationSeconds: number;
      durationLabel: string;
    }[],
    liveParagraphs: [] as { text: string; sourceLabel: string }[],
    liveTranscripts: [] as { clipId: string; label: string; text: string }[],
    livePhotos: [] as { photoId: string; caption: string; image: string }[],
    photoError: "",
    saveWarning: "",
    canOrganize: false,
    story: null as StoryView | null,
    context: null as StoryContext | null,
    stage: "",
    error: "",
    privateError: "",
    busy: false,
    pageLoading: true,
    pendingLocal: false,
    retryable: false,
  },
  onLoad(q) {
    this.autoOrganize = q.organize === "1";
    this.projectId = q.projectId || "";
    this.interviewId = q.interviewId || "";
    this.storyId = q.storyId || "";
    this.assistedSessionId = this.storyId ? "" : q.assistedSessionId || "";
  },
  async onShow() {
    this.visible = true;
    this.photoKey = "";
    ++this.photoSequence;
    const generation = ++this.generation,
      context = sessionClient.context();
    this.ownerContext = context;
    this.stopSessionWatch?.();
    this.stopSessionWatch = undefined;
    if (context)
      this.stopSessionWatch = sessionClient.onInvalidated((lost) => {
        if (lost !== context || this.ownerContext !== context) return;
        this.onHide();
        this.setData({
          stage: sessionClient.sessionCleanupPending()
            ? "登录已失效；设备会话缓存清理失败，请重试登录"
            : "登录已失效，请重新登录；本机原文件仍保留",
        });
      });
    this.setData({
      displayState: "saved",
      placement: "",
      storyMeta: "",
      story: null,
      liveParagraphs: [],
      liveTranscripts: [],
      livePhotos: [],
      photoError: "",
      liveAudioSources: [],
      canOrganize: false,
      context: null,
      error: "",
      privateError: "",
      stage: "",
      busy: false,
      pageLoading: true,
    });
    await this.stopLiveAudio().catch(() => {});
    if (!this.currentLive(generation, context)) return;
    if (!context || !this.projectId || (!this.interviewId && !this.storyId)) {
      this.setData({
        pageLoading: false,
        stage: "请登录并从本次采访进入故事",
      });
      return;
    }
    await this.refreshLive(generation, context);
    if (
      this.currentLive(generation, context) &&
      this.autoOrganize &&
      this.data.canOrganize &&
      (!this.data.story?.task ||
        this.data.story.task.state === "obsolete" ||
        this.data.context?.clipCount !== this.data.story.task.sources.length)
    ) {
      this.autoOrganize = false;
      await this.submitLive();
    }
    if (this.currentLive(generation, context) && this.data.story) {
      this.stopProjectWatch?.();
      this.stopProjectWatch = watchProjectAccess(
        this.projectId,
        () => this.currentLive(generation, context),
        () => {
          this.onHide();
          this.setData({
            stage:
              "资料用途或账号授权已变化，私人内容与临时回听已清理，请重新查询",
          });
        },
      );
    }
  },
  onHide() {
    this.stopProjectWatch?.();
    this.stopProjectWatch = undefined;
    this.stopSessionWatch?.();
    this.stopSessionWatch = undefined;
    void this.stopLiveAudio().catch(() => {});
    ++this.photoSequence;
    this.photoKey = "";
    void clearPhotoPreviews().catch(() => {});
    this.visible = false;
    ++this.generation;
    if (this.poll) clearTimeout(this.poll);
    this.setData({
      displayState: "saved",
      placement: "",
      storyMeta: "",
      story: null,
      liveParagraphs: [],
      liveTranscripts: [],
      livePhotos: [],
      photoError: "",
      liveAudioSources: [],
      canOrganize: false,
      context: null,
      busy: false,
      pageLoading: false,
      error: "",
      privateError: "",
    });
  },
  onUnload() {
    this.onHide();
  },
  currentLive(generation: number, context: string, invalidated = false) {
    const current = sessionClient.context();
    return (
      this.visible &&
      generation === this.generation &&
      (current === context || (invalidated && !current))
    );
  },
  liveFailure(
    generation: number,
    context: string,
    error: unknown,
    fallback: string,
  ) {
    if (
      generation === this.generation &&
      this.visible &&
      this.ownerContext === context &&
      sessionClient.context() !== context &&
      sessionClient.context()
    ) {
      this.onHide();
      this.setData({ stage: "账号已变化，原页面私人内容已清除，请重新进入" });
      return;
    }
    if (!this.currentLive(generation, context, true)) return;
    const denied =
      !sessionClient.context() ||
      (error instanceof ApiFailure && [401, 403].includes(error.status));
    if (denied) this.onHide();
    this.setData({
      stage: denied ? "当前访问已失效，请重新查询授权" : this.data.stage,
      error: error instanceof Error ? error.message : fallback,
    });
  },
  async refreshLive(generation?: number, context?: string, background = false) {
    generation ??= this.generation;
    context ??= this.ownerContext;
    if (this.poll) clearTimeout(this.poll);
    if (!background)
      this.setData({
        busy: true,
        pageLoading: !this.data.story && !this.data.context,
        error: "",
      });
    try {
      let loaded: StoryView | undefined;
      if (this.storyId) {
        loaded = await storyClient.read(this.projectId, this.storyId);
        if (!this.currentLive(generation, context)) return;
        this.interviewId = loaded.interviewId;
      }
      const local: unknown = wx.getStorageSync(
          `${recordingPartition(this.projectId)}:${this.interviewId}`,
        ),
        pendingLocal =
          Array.isArray(local) && local.some((c) => !c || c.sealed !== true);
      const result = loaded
        ? null
        : await storyClient.context(
            this.projectId,
            this.interviewId,
            this.assistedSessionId || undefined,
          );
      if (!this.currentLive(generation, context)) return;
      const view = {
        context: result,
        story: loaded ?? result?.story ?? null,
        liveParagraphs: [] as { text: string; sourceLabel: string }[],
        liveTranscripts: [] as {
          clipId: string;
          label: string;
          text: string;
        }[],
        privateError: "",
        liveAudioSources: [] as {
          clipId: string;
          durationSeconds: number;
          durationLabel: string;
        }[],
        pendingLocal,
        stage: stage(loaded ?? result?.story ?? null),
        saveWarning:
          !loaded && (pendingLocal || !result?.cloudSaved)
            ? "还有录音没有云端保存，请回采访页恢复"
            : "",
        retryable: false,
        canOrganize:
          !!result?.cloudSaved &&
          !pendingLocal &&
          (!result.story?.task ||
            ["obsolete", "succeeded"].includes(result.story.task.state) ||
            result.clipCount !== result.story.task.sources.length),
      };
      if (loaded || result?.story) {
        try {
          const full =
            loaded ??
            (await storyClient.read(this.projectId, result!.story!.id));
          if (!this.currentLive(generation, context)) return;
          Object.assign(view, {
            story: full,
            displayState: storyState(full),
            placement: storyPlacement(full),
            storyMeta: [
              full.task?.allSavedAt?.slice(0, 10),
              storyDuration(full) ? `${storyDuration(full)} 讲述` : "",
            ]
              .filter(Boolean)
              .join(" · "),
            failureTitle:
              full.task?.errorCode === "DEPENDENCY_FAILED"
                ? "录音识别未完成"
                : full.task?.state === "no_speech"
                  ? "未识别到语音"
                  : full.task?.state === "no_content"
                    ? "还没有形成故事"
                    : full.task?.state === "manual_review"
                      ? "整理需要协助"
                      : "故事整理失败",
            failureHint:
              full.task?.errorCode === "DEPENDENCY_FAILED"
                ? "原声已保存，可以返回讲述重试。"
                : full.task?.state === "no_speech"
                  ? "原声已保存，可以回听后再录一段。"
                  : full.task?.state === "no_content"
                    ? "文字已识别，可以继续补充讲述。"
                    : full.task?.state === "manual_review"
                      ? "原声仍保留，可以继续补充讲述。"
                      : "录音已保存，可重试整理。",
            liveAudioSources: storySources(full).map((source) => ({
              clipId: source.clipId,
              durationSeconds: (source.durationMs ?? 0) / 1000,
              durationLabel: source.durationMs
                ? audioTime(source.durationMs / 1000)
                : "--:--",
            })),
            stage: stage(full),
            privateError: "",
            liveTranscripts:
              !full.revision || full.task?.state === "no_content"
                ? (full.task?.sources ?? []).flatMap((source, index) =>
                    source.transcript?.text.trim()
                      ? [
                          {
                            clipId: source.clipId,
                            label: `第 ${index + 1} 段原声`,
                            text: source.transcript.text,
                          },
                        ]
                      : [],
                  )
                : [],
            liveParagraphs: (full.revision?.paragraphs ?? []).map((p) => ({
              text: p.text,
              sourceLabel: p.sourceRefs
                .map((ref) => {
                  const index = full.revision!.sourceManifest.findIndex(
                    (s) =>
                      s.transcript &&
                      ref === `transcript:${s.clipId}:${s.transcript.sha256}`,
                  );
                  return index >= 0
                    ? `第 ${index + 1} 段原声`
                    : ref.startsWith("note:")
                      ? "校对说明"
                      : "原声来源";
                })
                .join("、"),
            })),
          });
          if (full.task?.state === "failed") {
            const task = await storyClient.task(this.projectId, full.task.id);
            if (this.currentLive(generation, context))
              view.retryable = task.retryable;
          }
        } catch (error) {
          if (
            error instanceof ApiFailure &&
            error.status === 403 &&
            this.currentLive(generation, context)
          ) {
            ++this.photoSequence;
            this.photoKey = "";
            this.setData({ livePhotos: [], photoError: "" });
            void clearPhotoPreviews().catch(() => {});
            Object.assign(view, {
              story: result?.story ?? null,
              privateError: "当前无法查看正文，请重新登录或查询",
            });
          } else throw error;
        }
      }
      if (!this.currentLive(generation, context)) return;
      this.setData(view);
      if (view.story && !view.privateError)
        void this.loadLivePhotos(view.story, generation, context);
      if (
        this.currentLive(generation, context) &&
        this.data.story?.task &&
        ["queued", "waiting_inputs", "submitting", "waiting_provider"].includes(
          this.data.story.task.state,
        )
      )
        this.poll = setTimeout(
          () => void this.refreshLive(generation, context, true),
          2000,
        );
    } catch (error) {
      this.liveFailure(generation, context, error, "查询失败，请重试");
    } finally {
      if (!background && this.currentLive(generation, context, true))
        this.setData({ busy: false, pageLoading: false });
    }
  },
  async loadLivePhotos(story: StoryView, generation: number, context: string) {
    const key = `${story.id}:${story.revision?.id ?? "materials"}`;
    if (this.photoKey === key) return;
    this.photoKey = key;
    const sequence = ++this.photoSequence;
    const current = () =>
      sequence === this.photoSequence && this.currentLive(generation, context);
    this.setData({ livePhotos: [], photoError: "" });
    try {
      // A composed story displays its immutable photo version. Before composition,
      // show the photos already collected for this same interview.
      const snapshot = story.revision
        ? story.revision.photoSnapshot
        : await sessionClient.request<PhotoMaterials | null>(
            `/projects/${this.projectId}/interviews/${story.interviewId}/photo-materials`,
          );
      if (!current()) return;
      await clearPhotoPreviews();
      if (!current()) return;
      const entries = snapshot?.entries ?? [];
      this.setData({
        livePhotos: entries.map((entry) => ({
          photoId: entry.photoId,
          caption: entry.caption,
          image: "",
        })),
      });
      await Promise.all(
        entries.map(async (entry) => {
          const asset = entry.assets.find((a) => a.kind === "preview");
          if (!asset) return;
          const image = await privatePhotoPreview(
            this.projectId,
            entry.photoId,
            asset,
            current,
          );
          if (current())
            this.setData({
              livePhotos: this.data.livePhotos.map((row) =>
                row.photoId === entry.photoId ? { ...row, image } : row,
              ),
            });
          else await clearPhotoPreviews([image]);
        }),
      );
    } catch (error) {
      if (!current()) return;
      this.photoKey = "";
      if (error instanceof ApiFailure && [401, 403].includes(error.status))
        this.liveFailure(generation, context, error, "照片访问已失效");
      else this.setData({ photoError: "照片暂未加载，请重试。" });
    }
  },
  editLivePhotos() {
    go(
      "photos",
      `projectId=${this.projectId}&interviewId=${this.interviewId}&storyId=${this.data.story?.id || ""}`,
    );
  },
  reloadLivePhotos() {
    if (
      !this.data.story ||
      !this.currentLive(this.generation, this.ownerContext)
    )
      return;
    this.photoKey = "";
    void this.loadLivePhotos(
      this.data.story,
      this.generation,
      this.ownerContext,
    );
  },
  async submitLive() {
    if (
      this.data.busy ||
      this.data.pendingLocal ||
      !this.data.context?.cloudSaved
    )
      return;
    const generation = this.generation,
      context = this.ownerContext,
      baseVersion = this.data.story?.version ?? 0,
      keyName = `${recordingPartition(this.projectId)}:story:${this.interviewId}`;
    const prior = wx.getStorageSync(keyName) as
        { key?: string; baseVersion?: number } | undefined,
      command =
        prior?.key && prior.baseVersion === baseVersion
          ? { key: prior.key, baseVersion }
          : { key: paymentKey(), baseVersion };
    wx.setStorageSync(keyName, command);
    this.setData({ busy: true, error: "" });
    try {
      const result = await storyClient.organize(
        this.projectId,
        this.interviewId,
        baseVersion,
        command.key,
        this.assistedSessionId || undefined,
      );
      if (!this.currentLive(generation, context)) return;
      wx.removeStorageSync(keyName);
      this.setData({ story: result, stage: stage(result) });
      await this.refreshLive(generation, context);
    } catch (error) {
      this.liveFailure(
        generation,
        context,
        error,
        "提交结果未确定，请重试查询",
      );
    } finally {
      if (this.currentLive(generation, context, true))
        this.setData({ busy: false });
    }
  },
  async retryLive() {
    const task = this.data.story?.task;
    if (!task || this.data.busy || !this.data.retryable) return;
    const generation = this.generation,
      context = this.ownerContext,
      keyName = `${recordingPartition(this.projectId)}:story-retry:${task.id}`,
      stored = wx.getStorageSync(keyName),
      key = typeof stored === "string" ? stored : paymentKey();
    wx.setStorageSync(keyName, key);
    this.setData({ busy: true, error: "" });
    try {
      await storyClient.retry(
        this.projectId,
        task.id,
        key,
        this.assistedSessionId || undefined,
      );
      if (!this.currentLive(generation, context)) return;
      wx.removeStorageSync(keyName);
      await this.refreshLive(generation, context);
    } catch (error) {
      this.liveFailure(
        generation,
        context,
        error,
        "重试结果未确定，请重新查询",
      );
    } finally {
      if (this.currentLive(generation, context, true))
        this.setData({ busy: false });
    }
  },
  refresh() {
    if (!this.data.busy) void this.refreshLive();
  },
  async stopLiveAudio(path?: string) {
    ++this.audioSequence;
    this.audioSeeking = false;
    const player = this.liveAudio;
    this.liveAudio = null;
    player?.stop();
    player?.destroy();
    this.setData({
      playingClipId: "",
      pausedClipId: "",
      loadingClipId: "",
      audioBusy: false,
      audioError: "",
      audioPosition: 0,
      audioDuration: 0,
      audioPositionLabel: "00:00",
      audioDurationLabel: "--:--",
    });
    await clearStoryAudio(path ? [path] : undefined);
  },
  async playLive(e: E) {
    const id = e.currentTarget.dataset.id,
      source = this.data.story
        ? storySources(this.data.story).find((s) => s.clipId === id)
        : undefined,
      generation = this.generation,
      context = this.ownerContext;
    if (
      !source ||
      this.data.busy ||
      this.data.audioBusy ||
      this.data.privateError ||
      !this.currentLive(generation, context)
    )
      return;
    try {
      if (this.liveAudio && this.data.playingClipId === id) {
        this.liveAudio.pause();
        this.setData({ playingClipId: "", pausedClipId: id });
        return;
      }
      if (this.liveAudio && this.data.pausedClipId === id) {
        const player = this.liveAudio,
          sequence = this.audioSequence;
        this.setData({ audioBusy: true, loadingClipId: id });
        await requireStoryAudioAccess(
          this.projectId,
          source,
          () =>
            this.currentLive(generation, context) &&
            sequence === this.audioSequence,
        );
        if (!this.currentLive(generation, context) || this.liveAudio !== player)
          return;
        this.setData({ playingClipId: id, pausedClipId: "" });
        player.play();
        return;
      }
      // A previous download may still be pending cleanup. Retain its reference
      // and retry on exit, while reauthorizing and downloading this clip anew.
      const cleanup = this.stopLiveAudio().catch(() => {});
      const sequence = this.audioSequence;
      this.setData({
        audioBusy: true,
        loadingClipId: id,
        audioDuration: (source.durationMs ?? 0) / 1000,
        audioDurationLabel: source.durationMs
          ? audioTime(source.durationMs / 1000)
          : "--:--",
      });
      await cleanup;
      if (
        !this.currentLive(generation, context) ||
        sequence !== this.audioSequence
      )
        return;
      const path = await privateStoryAudio(
        this.projectId,
        source,
        () =>
          this.currentLive(generation, context) &&
          sequence === this.audioSequence,
      );
      if (
        !this.currentLive(generation, context) ||
        sequence !== this.audioSequence
      ) {
        await clearStoryAudio([path]);
        return;
      }
      const player = wx.createInnerAudioContext();
      this.liveAudio = player;
      player.src = path;
      const updateTime = () => {
        if (
          this.liveAudio !== player ||
          this.audioSeeking ||
          !this.currentLive(generation, context)
        )
          return;
        const duration =
          player.duration > 0 ? player.duration : this.data.audioDuration;
        const position = Math.min(
          Math.max(0, player.currentTime || 0),
          duration || Infinity,
        );
        const label = audioTime(position),
          durationLabel = duration > 0 ? audioTime(duration) : "--:--";
        this.setData({
          audioPosition: position,
          audioDuration: duration,
          audioPositionLabel: label,
          audioDurationLabel: durationLabel,
        });
      };
      player.onCanplay(updateTime);
      player.onTimeUpdate(updateTime);
      player.onSeeked(updateTime);
      const finish = () => {
        if (this.liveAudio === player)
          void this.stopLiveAudio(path).catch(() => {});
      };
      player.onEnded(finish);
      player.onError(() => {
        if (this.liveAudio !== player) return;
        finish();
        this.setData({ audioError: "原声播放失败，请重试" });
      });
      this.setData({ playingClipId: id });
      player.play();
    } catch (error) {
      const denied =
        !sessionClient.context() ||
        (error instanceof ApiFailure && [401, 403].includes(error.status));
      if (this.currentLive(generation, context, denied)) {
        if (denied) {
          this.onHide();
          this.setData({ stage: "原声权限已变化，请重新登录或查询" });
        } else
          this.setData({
            audioError:
              error instanceof Error ? error.message : "回听失败，可重试",
          });
      }
    } finally {
      if (this.currentLive(generation, context))
        this.setData({ audioBusy: false, loadingClipId: "" });
    }
  },
  seekLive(e: {
    currentTarget: { dataset: { id: string } };
    detail: { value: number };
    type?: string;
  }) {
    const id = e.currentTarget.dataset.id;
    if (
      !this.liveAudio ||
      ![this.data.playingClipId, this.data.pausedClipId].includes(id) ||
      this.data.audioBusy
    )
      return;
    const position = Math.min(
      this.data.audioDuration,
      Math.max(0, Number(e.detail.value)),
    );
    if (!Number.isFinite(position)) return;
    this.audioSeeking = false;
    this.liveAudio.seek(position);
    this.setData({
      audioPosition: position,
      audioPositionLabel: audioTime(position),
    });
  },
  draggingLive(e: {
    currentTarget: { dataset: { id: string } };
    detail: { value: number };
  }) {
    if (
      !this.liveAudio ||
      ![this.data.playingClipId, this.data.pausedClipId].includes(
        e.currentTarget.dataset.id,
      )
    )
      return;
    const position = Math.min(
      this.data.audioDuration,
      Math.max(0, Number(e.detail.value)),
    );
    if (!Number.isFinite(position)) return;
    this.audioSeeking = true;
    this.setData({
      audioPosition: position,
      audioPositionLabel: audioTime(position),
    });
  },
  assignStory() {
    if (this.data.story?.revision && !this.data.busy)
      go(
        "assign-story",
        `projectId=${this.projectId}&storyId=${this.data.story.id}`,
      );
  },
  returnToProject() {
    switchProjectTab("home", this.projectId);
  },
  recoverInterview() {
    if (!this.projectId || !this.interviewId) return;
    const partition = recordingPartition(this.projectId),
      stored: unknown = wx.getStorageSync(`${partition}:index`),
      ids = Array.isArray(stored)
        ? stored.filter((v) => typeof v === "string")
        : [];
    if (!ids.includes(this.interviewId)) ids.push(this.interviewId);
    wx.setStorageSync(`${partition}:index`, ids);
    wx.setStorageSync(`${partition}:active`, this.interviewId);
    go(
      "interview",
      `projectId=${this.projectId}&interviewId=${this.interviewId}&prepare=1${this.assistedSessionId ? `&assistedSessionId=${this.assistedSessionId}` : ""}`,
    );
  },
  edit() {
    if (this.data.story?.revision)
      go(
        "edit-story",
        `projectId=${this.projectId}&storyId=${this.data.story.id}${this.assistedSessionId ? `&assistedSessionId=${this.assistedSessionId}` : ""}`,
      );
  },
});
