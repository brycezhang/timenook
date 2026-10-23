import { dataMode } from "../../services/mode";
import { sessionClient, ApiFailure } from "../../services/session";
import { storyClient } from "../../services/stories";
import { clearStoryAudio, privateStoryAudio } from "../../services/story-audio";
import { recordingPartition } from "../../services/interview-recording";
import { paymentKey } from "../../services/payments";
import type { StoryView, StoryContext } from "../../../packages/contracts/src";
function stage(story: StoryView | null) {
  const task = story?.task;
  if (!task) return "录音保存后，可以整理这段讲述";
  return task.state === "waiting_inputs"
    ? task.errorCode === "DEPENDENCY_FAILED"
      ? "有录音转写失败，原声已保存"
      : "正在等待全部录音转写，可离开"
    : task.state === "queued"
      ? "正在排队，可离开"
      : task.state === "submitting"
        ? "正在整理故事，可离开"
        : task.state === "succeeded"
          ? "故事已整理，待本人核对"
          : task.state === "no_speech"
            ? "未识别到有效语音，请再录一段"
            : task.state === "failed"
              ? "整理失败，原声仍保留"
              : task.state === "manual_review"
                ? "需要人工协助，原声仍保留"
                : task.state === "obsolete"
                  ? "这次整理已失效，请保存补录后重新整理"
                  : "处理中，可离开";
}
import type { Story } from "../../domain/model";
import { confirmStory, touch } from "../../domain/model";
import {
  go,
  home,
  notify,
  read,
  required,
  save,
  toast,
} from "../../services/store";
type E = {
  currentTarget: { dataset: Record<string, string> };
  detail: { value: string };
};
let audio: WechatMiniprogram.InnerAudioContext | null = null;
Page({
  projectId: "",
  interviewId: "",
  assistedSessionId: "",
  generation: 0,
  visible: false,
  ownerContext: "",
  audioSequence: 0,
  liveAudio: null as WechatMiniprogram.InnerAudioContext | null,
  stopSessionWatch: undefined as (() => void) | undefined,
  poll: undefined as ReturnType<typeof setTimeout> | undefined,
  data: {
    audioBusy: false,
    audioError: "",
    playingClipId: "",
    liveParagraphs: [] as { text: string; sourceLabel: string }[],
    saveWarning: "",
    canOrganize: false,
    live: false,
    story: null as StoryView | null,
    context: null as StoryContext | null,
    stage: "",
    error: "",
    privateError: "",
    busy: false,
    pendingLocal: false,
    retryable: false,
    id: "",
    s: null as Story | null,
    paragraphs: [] as string[],
    playing: false,
  },
  onLoad(q) {
    if (dataMode() === "live") {
      this.projectId = q.projectId || "";
      this.interviewId = q.interviewId || "";
      this.assistedSessionId = q.assistedSessionId || "";
      this.setData({ live: true });
      return;
    }
    this.setData({ id: q.id || "" });
  },
  async onShow() {
    if (dataMode() === "live") {
      this.visible = true;
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
        story: null,
        liveParagraphs: [],
        canOrganize: false,
        context: null,
        error: "",
        privateError: "",
        stage: "正在查询保存与整理状态",
        busy: false,
      });
      try {
        await this.stopLiveAudio();
      } catch (error) {
        if (this.currentLive(generation, context, true))
          this.setData({
            stage: "原声临时文件尚未清理，请重试",
            error: error instanceof Error ? error.message : "清理失败",
          });
        return;
      }
      if (!this.currentLive(generation, context)) return;
      if (!context || !this.projectId || !this.interviewId) {
        this.setData({ stage: "请登录并从本次采访进入故事" });
        return;
      }
      await this.refreshLive(generation, context);
      return;
    }
    const s = required().stories.find((s) => s.id === this.data.id);
    if (!s) {
      home();
      return;
    }
    this.setData({ s, paragraphs: s.body.split("\n\n") });
  },
  onHide() {
    if (this.data.live) {
      this.stopSessionWatch?.();
      this.stopSessionWatch = undefined;
      void this.stopLiveAudio().catch(() => {});
      this.visible = false;
      ++this.generation;
      if (this.poll) clearTimeout(this.poll);
      this.setData({
        story: null,
        liveParagraphs: [],
        canOrganize: false,
        context: null,
        busy: false,
        error: "",
        privateError: "",
      });
    }
    audio?.pause();
    this.setData({ playing: false });
  },
  onUnload() {
    this.onHide();
    audio?.destroy();
    audio = null;
  },
  currentLive(generation: number, context: string, invalidated = false) {
    const current = sessionClient.context();
    return (
      this.visible &&
      generation === this.generation &&
      dataMode() === "live" &&
      (current === context || (invalidated && !current))
    );
  },
  liveFailure(
    generation: number,
    context: string,
    error: unknown,
    fallback: string,
  ) {
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
  async refreshLive(generation?: number, context?: string) {
    generation ??= this.generation;
    context ??= this.ownerContext;
    if (this.poll) clearTimeout(this.poll);
    this.setData({ busy: true, error: "" });
    try {
      const local: unknown = wx.getStorageSync(
          `${recordingPartition(this.projectId)}:${this.interviewId}`,
        ),
        pendingLocal =
          Array.isArray(local) && local.some((c) => !c || c.sealed !== true);
      const result = await storyClient.context(
        this.projectId,
        this.interviewId,
        this.assistedSessionId || undefined,
      );
      if (!this.currentLive(generation, context)) return;
      this.setData({
        context: result,
        story: result.story,
        liveParagraphs: [],
        pendingLocal,
        stage: stage(result.story),
        saveWarning:
          pendingLocal || !result.cloudSaved
            ? "还有录音没有云端保存，请回采访页恢复"
            : "",
        retryable: false,
        canOrganize:
          result.cloudSaved &&
          !pendingLocal &&
          (!result.story?.task ||
            ["obsolete", "succeeded"].includes(result.story.task.state) ||
            result.clipCount !== result.story.task.sources.length),
      });
      if (result.story) {
        try {
          const full = await storyClient.read(this.projectId, result.story.id);
          if (!this.currentLive(generation, context)) return;
          this.setData({
            story: full,
            stage: stage(full),
            privateError: "",
            liveParagraphs: (full.revision?.paragraphs ?? []).map((p) => ({
              text: p.text,
              sourceLabel: p.sourceRefs
                .map((ref) => {
                  const index = full.revision!.sourceManifest.findIndex(
                    (s) =>
                      s.transcript &&
                      ref === `transcript:${s.clipId}:${s.transcript.sha256}`,
                  );
                  return index >= 0 ? `第 ${index + 1} 段原声` : "原声来源";
                })
                .join("、"),
            })),
          });
          if (full.task?.state === "failed") {
            const task = await storyClient.task(this.projectId, full.task.id);
            if (this.currentLive(generation, context))
              this.setData({ retryable: task.retryable });
          }
        } catch (error) {
          if (
            error instanceof ApiFailure &&
            error.status === 403 &&
            this.currentLive(generation, context)
          ) {
            this.setData({
              story: result.story,
              privateError: "正文暂时不可查看，请核对讲述者的共享授权",
            });
          } else throw error;
        }
      }
      if (
        this.currentLive(generation, context) &&
        this.data.story?.task &&
        ["queued", "waiting_inputs", "submitting", "waiting_provider"].includes(
          this.data.story.task.state,
        )
      )
        this.poll = setTimeout(
          () => void this.refreshLive(generation, context),
          2000,
        );
    } catch (error) {
      this.liveFailure(generation, context, error, "查询失败，请重试");
    } finally {
      if (this.currentLive(generation, context, true))
        this.setData({ busy: false });
    }
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
  async stopLiveAudio() {
    ++this.audioSequence;
    this.liveAudio?.stop();
    this.liveAudio?.destroy();
    this.liveAudio = null;
    this.setData({ playingClipId: "", audioBusy: false, audioError: "" });
    await clearStoryAudio();
  },
  async playLive(e: E) {
    const id = e.currentTarget.dataset.id,
      source = this.data.story?.task?.sources.find((s) => s.clipId === id),
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
    const stopping = this.data.playingClipId === id;
    try {
      await this.stopLiveAudio();
      if (stopping || !this.currentLive(generation, context)) return;
      const sequence = ++this.audioSequence;
      this.setData({ audioBusy: true });
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
      const finish = () => {
        if (this.liveAudio === player)
          void this.stopLiveAudio().catch(() =>
            this.setData({ audioError: "临时原声未能清理，请重试" }),
          );
      };
      player.onEnded(finish);
      player.onError(finish);
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
        this.setData({ audioBusy: false });
    }
  },
  recoverInterview() {
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
      `projectId=${this.projectId}&interviewId=${this.interviewId}${this.assistedSessionId ? `&assistedSessionId=${this.assistedSessionId}` : ""}`,
    );
  },
  confirm() {
    const p = required();
    confirmStory(p, this.data.id);
    save(p);
    this.onShow();
    toast("已确认，允许这版故事入书");
  },
  edit() {
    go("edit-story", "id=" + this.data.id);
  },
  supplement() {
    go("interview");
  },
  exclude() {
    const p = required();
    const s = p.stories.find((s) => s.id === this.data.id)!;
    s.included = !s.included;
    touch(p);
    save(p);
    this.onShow();
  },
  photos() {
    const projectId = required().id;
    const storyId = this.data.id;
    wx.chooseMedia({
      count: 3,
      mediaType: ["image"],
      success: async (r) => {
        try {
          const paths = await Promise.all(
            r.tempFiles.map(
              (f) =>
                new Promise<string>((resolve, reject) =>
                  wx.getFileSystemManager().saveFile({
                    tempFilePath: f.tempFilePath,
                    success: (v) => resolve(v.savedFilePath),
                    fail: reject,
                  }),
                ),
            ),
          );
          const p = read(projectId);
          const s = p?.stories.find((s) => s.id === storyId);
          if (!p || !s) throw new Error("Story removed");
          s.photos.push(...paths);
          s.version += 1;
          s.confirmedVersion = null;
          touch(p);
          save(p);
          if (read()?.id === projectId) this.onShow();
        } catch {
          toast("照片没有保存成功，请重试");
        }
      },
    });
  },
  play() {
    const s = this.data.s;
    if (!s?.recordings.length) {
      notify(
        "这是一篇示例故事",
        "示例没有对应的真实原声。您录下的声音可在“我的 → 本机原声”中回听。",
      );
      return;
    }
    if (!audio) {
      audio = wx.createInnerAudioContext();
      audio.onEnded(() => this.setData({ playing: false }));
      audio.onError(() => {
        toast("原声暂时无法播放");
        this.setData({ playing: false });
      });
    }
    audio.src = s.recordings[0].path;
    if (this.data.playing) audio.pause();
    else audio.play();
    this.setData({ playing: !this.data.playing });
  },
});
