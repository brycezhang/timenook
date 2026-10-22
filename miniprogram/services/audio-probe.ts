import { recordingLease } from "./recording-lease";
import type {
  ProbeSession,
  ProbeLocalClip,
  ProbeSnapshot,
  ProbeClip,
  ProbeUploadForm,
} from "../../packages/contracts/src/audio-probe";

function uuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const n = Math.floor(Math.random() * 16);
    return (c === "x" ? n : (n & 3) | 8).toString(16);
  });
}
/** Controlled S0 identity, never reads or writes the product/demo account stores. */
export class AudioProbeClient {
  private readonly manager = wx.getRecorderManager();
  private current: ProbeSnapshot = {
    hasPendingSave: false,
    stage: "idle",
    message: "只用于合成音频或已获同意的测试样本",
    clips: [],
  };
  private listener?: (snapshot: ProbeSnapshot) => void;
  private active = false;
  private stopRequested = false;
  private saving = false;
  private pending?: {
    clientClipId: string;
    tempFilePath: string;
    duration: number;
    savedPath?: string;
  };
  private clipId = "";
  private uploading = false;
  private playbackGeneration = 0;
  private player?: WechatMiniprogram.InnerAudioContext;
  private playbackTimer?: ReturnType<typeof setTimeout>;
  private readonly cacheKey = "timenook.probe.cache.v1";
  constructor(
    private readonly base: string,
    private readonly session: ProbeSession,
    private readonly enabled: boolean,
  ) {
    this.manager.onStart(() => {
      if (!recordingLease.owns(this) || !this.active) return;
      if (this.stopRequested) {
        this.manager.stop();
        return;
      }
      this.update("recording", "录音中；尚未保存，请勿强行退出");
    });
    this.manager.onStop((value) => {
      if (!this.active || !recordingLease.owns(this)) return;
      recordingLease.release(this);
      this.active = false;
      this.pending = { ...value, clientClipId: this.clipId };
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
  private get key() {
    return `timenook.probe.v1:${this.base}:${this.session.id}`;
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
  private update(stage: ProbeSnapshot["stage"], message: string) {
    this.current = { ...this.current, stage, message };
    this.listener?.(this.snapshot());
  }
  private check() {
    if (
      !this.enabled ||
      !/^(?:https:\/\/[A-Za-z0-9.-]+(?::\d+)?|http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?)(?:\/[A-Za-z0-9_-]+)*\/v1$/.test(
        this.base,
      )
    )
      throw new Error("未开启受控测试入口");
    if (Date.parse(this.session.expiresAt) <= Date.now())
      throw new Error("测试权限已过期");
  }
  start() {
    this.check();
    if (
      this.active ||
      this.pending ||
      this.saving ||
      !recordingLease.acquire(this)
    )
      return;
    this.clipId = uuid();
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
  stop() {
    if (this.active) {
      this.stopRequested = true;
      if (this.current.stage === "recording") this.manager.stop();
    }
  }
  async retrySave() {
    if (!this.pending || this.saving) return;
    this.saving = true;
    this.update("saving", "正在保存本机文件，请先别退出");
    try {
      const pending = this.pending;
      pending.savedPath ??= await new Promise<string>((resolve, reject) =>
        wx
          .getFileSystemManager()
          .saveFile({
            tempFilePath: pending.tempFilePath,
            success: (r) => resolve(r.savedFilePath),
            fail: reject,
          }),
      );
      const info =
        await new Promise<WechatMiniprogram.GetFileInfoSuccessCallbackResult>(
          (resolve, reject) =>
            wx
              .getFileSystemManager()
              .getFileInfo({
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
      };
      const clips = [
        ...this.current.clips.filter(
          (c) => c.clientClipId !== clip.clientClipId,
        ),
        clip,
      ];
      wx.setStorageSync(this.key, clips);
      this.current.clips = clips;
      this.pending = undefined;
      this.update("local", "已保存在本机；尚未上传封存");
    } catch {
      this.update("device-error", "还没有保存成功，请先别退出。点击重试保存。");
    } finally {
      this.saving = false;
    }
  }
  async restore() {
    await this.stopPlayback();
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
          wx
            .getFileSystemManager()
            .access({
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
        : "没有找到已保存片段；强杀前未保存的声音无法恢复",
    );
  }
  private send<T>(path: string, data?: object): Promise<T> {
    this.check();
    return new Promise((resolve, reject) =>
      wx.request<{ data: T }>({
        url: this.base + "/probes/audio" + path,
        method: "POST",
        data,
        timeout: 45000,
        header: { authorization: `Bearer ${this.session.token}` },
        success: (r) =>
          r.statusCode >= 200 && r.statusCode < 300
            ? resolve(r.data.data)
            : reject(new Error(`HTTP ${r.statusCode}`)),
        fail: () => reject(new Error("网络请求失败")),
      }),
    );
  }
  async upload(clientClipId: string) {
    if (this.uploading) return;
    this.check();
    const clip = this.current.clips.find(
      (c) => c.clientClipId === clientClipId,
    );
    if (!clip) throw new Error("没有已保存片段");
    this.uploading = true;
    let sealing = false;
    try {
      this.update("uploading", "本机文件已保存，正在上传暂存区");
      const remote = await this.send<ProbeClip>("/clips", {
        clientClipId: clip.clientClipId,
        bytes: clip.bytes,
        sha256: clip.sha256,
      });
      if (
        !remote ||
        remote.sha256 !== clip.sha256 ||
        !["local-simulator", "oss"].includes(remote.storage)
      )
        throw new Error("封存响应不匹配");
      clip.serverId = remote.id;
      wx.setStorageSync(this.key, this.current.clips);
      if (remote.state !== "sealed") {
        const form = await this.send<ProbeUploadForm>(
          `/clips/${remote.id}/upload`,
          {},
        );
        const local =
          form.storage === "local-simulator" &&
          form.url === "/v1/probes/audio/objects";
        const oss =
          form.storage === "oss" &&
          /^https:\/\/[a-z0-9-]+\.oss-[a-z0-9-]+\.aliyuncs\.com$/.test(
            form.url,
          );
        if (form.storage !== remote.storage || (!local && !oss))
          throw new Error("未支持的上传目的地");
        // Keep the configured deployment prefix (for example /timenook), never resolve against origin alone.
        await new Promise<void>((resolve, reject) =>
          wx.uploadFile({
            url: local ? this.base + form.url.slice(3) : form.url,
            name: "file",
            filePath: clip.path,
            formData: form.fields,
            timeout: 45000,
            success: (r) =>
              r.statusCode >= 200 && r.statusCode < 300
                ? resolve()
                : reject(new Error("暂存上传失败")),
            fail: () => reject(new Error("上传网络中断")),
          }),
        );
        sealing = true;
        this.update("sealing", "暂存上传完成，正在校验；尚未封存");
        const sealed = await this.send<ProbeClip>(
          `/clips/${remote.id}/seal`,
          {},
        );
        if (
          sealed.state !== "sealed" ||
          sealed.storage !== remote.storage ||
          sealed.sha256 !== clip.sha256
        )
          throw new Error("尚未封存");
      }
      clip.sealed = true;
      wx.setStorageSync(this.key, this.current.clips);
      this.update(
        "sealed",
        remote.storage === "oss"
          ? "云端已保存（受控测试样本）"
          : "本地模拟封存完成；真实 OSS 尚待验收",
      );
    } catch {
      this.update(
        sealing ? "seal-error" : "upload-error",
        sealing
          ? "封存未确认，本机文件仍在；可重试校验"
          : "上传未完成，本机文件仍在；可按文件重试",
      );
    } finally {
      this.uploading = false;
    }
  }

  private async removeCache(path: string) {
    await new Promise<void>((resolve, reject) =>
      wx
        .getFileSystemManager()
        .unlink({ filePath: path, success: () => resolve(), fail: reject }),
    );
    const cache: unknown = wx.getStorageSync(this.cacheKey);
    wx.setStorageSync(
      this.cacheKey,
      Array.isArray(cache) ? cache.filter((p) => p !== path) : [],
    );
  }
  async stopPlayback() {
    this.playbackGeneration++;
    if (this.playbackTimer) clearTimeout(this.playbackTimer);
    this.player?.stop();
    this.player?.destroy();
    this.player = undefined;
    const cache: unknown = wx.getStorageSync(this.cacheKey);
    if (Array.isArray(cache))
      for (const path of cache)
        if (typeof path === "string") {
          const exists = await new Promise<boolean>((resolve) =>
            wx
              .getFileSystemManager()
              .access({
                path,
                success: () => resolve(true),
                fail: () => resolve(false),
              }),
          );
          if (exists) await this.removeCache(path);
          else
            wx.setStorageSync(
              this.cacheKey,
              (wx.getStorageSync(this.cacheKey) as string[]).filter(
                (p) => p !== path,
              ),
            );
        }
  }
  async play(clientClipId: string) {
    this.check();
    const clip = this.current.clips.find(
      (c) => c.clientClipId === clientClipId,
    );
    if (!clip?.sealed || !clip.serverId) throw new Error("片段尚未封存");
    const cleanup = this.stopPlayback();
    const generation = this.playbackGeneration;
    try {
      await cleanup;
    } catch {
      this.update(
        this.current.stage,
        "临时文件清理失败；回听未启动，请重试清理",
      );
      return;
    }
    if (generation !== this.playbackGeneration) return;
    let path: string | undefined;
    try {
      const download =
        new Promise<WechatMiniprogram.DownloadFileSuccessCallbackResult>(
          (resolve, reject) =>
            wx.downloadFile({
              url: this.base + `/probes/audio/clips/${clip.serverId}/content`,
              header: { authorization: `Bearer ${this.session.token}` },
              timeout: 15000,
              success: resolve,
              fail: reject,
            }),
        );
      const result = await download;
      path = result.tempFilePath;
      if (path) {
        const cache: unknown = wx.getStorageSync(this.cacheKey);
        wx.setStorageSync(this.cacheKey, [
          ...(Array.isArray(cache) ? cache : []),
          path,
        ]);
      }
      if (
        !path ||
        result.statusCode !== 200 ||
        generation !== this.playbackGeneration ||
        Date.parse(this.session.expiresAt) <= Date.now()
      )
        throw new Error("回听已失效");
      const info =
        await new Promise<WechatMiniprogram.GetFileInfoSuccessCallbackResult>(
          (resolve, reject) =>
            wx
              .getFileSystemManager()
              .getFileInfo({
                filePath: path!,
                digestAlgorithm: "sha256",
                success: resolve,
                fail: reject,
              }),
        );
      if (
        info.digest !== clip.sha256 ||
        info.size !== clip.bytes ||
        generation !== this.playbackGeneration ||
        Date.parse(this.session.expiresAt) <= Date.now()
      )
        throw new Error("下载校验失败");
      this.player = wx.createInnerAudioContext();
      this.player.src = path;
      this.player.onEnded(() => {
        void this.stopPlayback().catch(() =>
          this.update(this.current.stage, "临时文件清理失败；请重试清理"),
        );
      });
      this.player.onError(() => {
        void this.stopPlayback().catch(() =>
          this.update(this.current.stage, "临时文件清理失败；请重试清理"),
        );
      });
      this.player.play();
      this.playbackTimer = setTimeout(
        () => {
          void this.stopPlayback().catch(() =>
            this.update(this.current.stage, "临时文件清理失败；请重试清理"),
          );
        },
        Math.max(0, Date.parse(this.session.expiresAt) - Date.now()),
      );
    } catch {
      try {
        if (path) await this.removeCache(path);
      } catch {
        this.update(this.current.stage, "临时文件清理失败；请重试清理");
        return;
      }
      this.update(this.current.stage, "回听未完成或权限已过期；临时文件已清理");
    }
  }
  async onHide() {
    this.stop();
    try {
      await this.stopPlayback();
    } catch {
      this.update(this.current.stage, "临时文件清理失败；请重试清理");
    }
  }
}
