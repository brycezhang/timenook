import { recordingLease } from "./recording-lease";
import type {
  ProbeLocalClip,
  ProbeSnapshot,
} from "../../packages/contracts/src/audio-probe";
export function recordingId() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const n = Math.floor(Math.random() * 16);
    return (c === "x" ? n : (n & 3) | 8).toString(16);
  });
}
/** One device and durable-file lifecycle, shared by product and controlled probe adapters. */
export class LocalAudioRecorder {
  protected readonly manager = wx.getRecorderManager();
  protected current: ProbeSnapshot = {
    hasPendingSave: false,
    stage: "idle",
    message: "只用于合成音频或已获同意的测试样本",
    clips: [],
  };
  protected listener?: (snapshot: ProbeSnapshot) => void;
  protected active = false;
  protected stopRequested = false;
  protected saving = false;
  protected pending?: {
    clientClipId: string;
    tempFilePath: string;
    duration: number;
    savedPath?: string;
    actualQuestionId?: string;
  };
  protected clipId = "";
  private elapsedMs = 0;
  private segmentBegan = 0;
  private openingQuestionId?: string;
  constructor(
    protected readonly key: string,
    private readonly allowed: () => void = () => {},
  ) {
    this.manager.onStart(() => {
      if (!recordingLease.owns(this) || !this.active) return;
      if (this.stopRequested) {
        this.manager.stop();
        return;
      }
      this.elapsedMs = 0;
      this.segmentBegan = Date.now();
      this.update("recording", "录音中；尚未保存，请勿强行退出");
    });
    this.manager.onPause?.(() => {
      if (!this.active || !recordingLease.owns(this)) return;
      if (this.current.stage === "recording")
        this.elapsedMs += Math.max(0, Date.now() - this.segmentBegan);
      this.update("paused", "录音已暂停；继续或结束后保存这段声音");
    });
    this.manager.onResume?.(() => {
      if (!this.active || !recordingLease.owns(this)) return;
      if (this.stopRequested) {
        this.manager.stop();
        return;
      }
      this.segmentBegan = Date.now();
      this.update("recording", "录音中；尚未保存，请勿强行退出");
    });
    this.manager.onStop((value) => {
      if (!this.active || !recordingLease.owns(this)) return;
      recordingLease.release(this);
      this.active = false;
      this.pending = {
        ...value,
        clientClipId: this.clipId,
        ...(this.openingQuestionId
          ? { actualQuestionId: this.openingQuestionId }
          : {}),
      };
      void this.retrySave();
    });
    this.manager.onError(() => {
      if (!this.active || !recordingLease.owns(this)) return;
      recordingLease.release(this);
      this.active = false;
      this.update(
        "device-error",
        "未取得录音；检查麦克风权限后重试，未承诺保存本次声音",
      );
    });
    this.manager.onInterruptionBegin(() => this.stop());
  }
  protected check() {
    this.allowed();
  }
  snapshot(): ProbeSnapshot {
    return {
      ...this.current,
      hasPendingSave: !!this.pending,
      clips: this.current.clips.map((c) => ({ ...c })),
    };
  }
  unsubscribe() {
    this.listener = undefined;
  }
  subscribe(listener: (snapshot: ProbeSnapshot) => void) {
    this.listener = listener;
    listener(this.snapshot());
  }
  protected update(stage: ProbeSnapshot["stage"], message: string) {
    this.current = { ...this.current, stage, message };
    this.listener?.(this.snapshot());
  }
  start(actualQuestionId?: string) {
    this.check();
    if (
      this.active ||
      this.pending ||
      this.saving ||
      !recordingLease.acquire(this)
    )
      return;
    this.clipId = recordingId();
    this.openingQuestionId = actualQuestionId;
    this.active = true;
    this.stopRequested = false;
    this.update("requesting", "正在请求麦克风权限");
    this.manager.start({
      duration: 300000,
      sampleRate: 16000,
      numberOfChannels: 1,
      encodeBitRate: 48000,
      format: "mp3",
    });
  }
  elapsedRecordingMs() {
    return this.active
      ? this.elapsedMs +
          (this.current.stage === "recording"
            ? Math.max(0, Date.now() - this.segmentBegan)
            : 0)
      : 0;
  }
  pause() {
    this.check();
    if (this.active && this.current.stage === "recording") this.manager.pause();
  }
  resume() {
    this.check();
    if (this.active && this.current.stage === "paused") this.manager.resume();
  }
  stop() {
    if (this.active) {
      this.stopRequested = true;
      if (["recording", "paused"].includes(this.current.stage))
        this.manager.stop();
    }
  }
  // Each callback commits only its clip against the latest durable manifest.
  // The synchronous read/merge/write cannot interleave with another callback
  // in the app-service runtime; a stale owner never writes its whole array.
  protected commitClip(clip: ProbeLocalClip) {
    const stored: unknown = wx.getStorageSync(this.key);
    const clips: ProbeLocalClip[] = Array.isArray(stored)
      ? stored.filter(
          (value): value is ProbeLocalClip =>
            !!value &&
            typeof value.path === "string" &&
            /^[0-9a-f-]{36}$/.test(value.clientClipId) &&
            /^[0-9a-f]{64}$/.test(value.sha256),
        )
      : [];
    const existing = clips.find(
      (value) => value.clientClipId === clip.clientClipId,
    );
    if (
      existing &&
      (existing.path !== clip.path ||
        existing.sha256 !== clip.sha256 ||
        existing.bytes !== clip.bytes ||
        existing.durationMs !== clip.durationMs ||
        (existing.actualQuestionId &&
          clip.actualQuestionId &&
          existing.actualQuestionId !== clip.actualQuestionId) ||
        (existing.serverId &&
          clip.serverId &&
          existing.serverId !== clip.serverId))
    )
      throw new Error("Saved clip identity changed");
    const merged = {
      ...existing,
      ...clip,
      ...(existing?.serverId ? { serverId: existing.serverId } : {}),
      ...(existing?.sealed ? { sealed: true } : {}),
    };
    const next = [
      ...clips.filter((value) => value.clientClipId !== clip.clientClipId),
      merged,
    ];
    wx.setStorageSync(this.key, next);
    this.current.clips = next;
  }
  async retrySave() {
    if (!this.pending || this.saving) return;
    this.saving = true;
    this.update("saving", "正在保存本机文件，请先别退出");
    try {
      const pending = this.pending;
      pending.savedPath ??= await new Promise<string>((resolve, reject) =>
        wx.getFileSystemManager().saveFile({
          tempFilePath: pending.tempFilePath,
          success: (r) => resolve(r.savedFilePath),
          fail: reject,
        }),
      );
      const info =
        await new Promise<WechatMiniprogram.GetFileInfoSuccessCallbackResult>(
          (resolve, reject) =>
            wx.getFileSystemManager().getFileInfo({
              filePath: pending.savedPath!,
              digestAlgorithm: "sha256",
              success: resolve,
              fail: reject,
            }),
        );
      if (
        !/^[0-9a-f]{64}$/.test(info.digest) ||
        info.size < 1 ||
        info.size > 2097152
      )
        throw new Error("Invalid saved audio");
      const clip: ProbeLocalClip = {
        clientClipId: pending.clientClipId,
        path: pending.savedPath,
        durationMs: pending.duration,
        bytes: info.size,
        sha256: info.digest,
        ...(pending.actualQuestionId
          ? { actualQuestionId: pending.actualQuestionId }
          : {}),
      };
      this.commitClip(clip);
      this.pending = undefined;
      this.update("local", "已保存在本机；尚未上传封存");
    } catch {
      this.update("device-error", "还没有保存成功，请先别退出。点击重试保存。");
    } finally {
      this.saving = false;
    }
  }
  async restore() {
    if (this.pending || this.saving || this.active) return;
    const stored: unknown = wx.getStorageSync(this.key);
    const clips: ProbeLocalClip[] = [];
    if (Array.isArray(stored))
      for (const clip of stored) {
        if (
          !clip ||
          typeof clip.path !== "string" ||
          !/^[0-9a-f-]{36}$/.test(clip.clientClipId) ||
          !/^[0-9a-f]{64}$/.test(clip.sha256)
        )
          continue;
        const exists = await new Promise<boolean>((resolve) =>
          wx.getFileSystemManager().access({
            path: clip.path,
            success: () => resolve(true),
            fail: () => resolve(false),
          }),
        );
        if (exists) clips.push(clip);
      }
    this.current.clips = clips;
    this.update(
      clips.length ? "local" : "idle",
      clips.length
        ? "仅恢复实际存在的本机片段；可重试上传"
        : Array.isArray(stored) && stored.length
          ? "此前的本机片段暂时不可用，请重新查询云端保存结果"
          : "准备好就开始说，结束后先保存到本机",
    );
  }
}
