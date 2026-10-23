import { LocalAudioRecorder } from "./local-audio-recorder";
import type {
  ProbeSession,
  ProbeLocalClip,
  ProbeSnapshot,
  ProbeClip,
  ProbeUploadForm,
} from "../../packages/contracts/src/audio-probe";

/** Controlled S0 identity, separate from product accounts/projects. */
export class AudioProbeClient extends LocalAudioRecorder {
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
    super(`timenook.probe.v1:${base}:${session.id}`);
  }
  protected check() {
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
    if (this.uploading) {
      this.update(this.current.stage, "正在上传或校验，请完成后再录音");
      return;
    }
    super.start();
  }
  async restore() {
    await this.stopPlayback();
    await super.restore();
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
    if (this.active || this.pending || this.saving) {
      this.update(
        this.current.stage,
        "请先停止录音并完成本机保存，再上传已有片段",
      );
      return;
    }
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
            wx.getFileSystemManager().access({
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
            wx.getFileSystemManager().getFileInfo({
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
