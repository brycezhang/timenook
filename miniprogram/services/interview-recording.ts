import { LocalAudioRecorder } from "./local-audio-recorder";
import { sessionClient } from "./session";
import { API_BASE_URL } from "../config";
import { paymentKey } from "./payments";
import type {
  RecordingClip,
  RecordingContext,
  RecordingInterview,
} from "../../packages/contracts/src";
import type { ProbeUploadForm } from "../../packages/contracts/src/audio-probe";
export function recordingPartition(projectId: string) {
  const account = sessionClient.context().split(":")[0];
  if (!account) throw new Error("请先登录");
  const appId = wx.getAccountInfoSync?.().miniProgram.appId ?? "";
  return `timenook.recording.v1:${API_BASE_URL}:${appId}:${account}:${projectId}`;
}
export const interviewRecordingClient = {
  authorizeStart(projectId: string, id: string, assistedSessionId?: string) {
    return sessionClient.request<{ allowed: boolean }>(
      `/projects/${projectId}/interviews/${id}/recording-start`,
      {
        key: paymentKey(),
        data: assistedSessionId ? { assistedSessionId } : {},
      },
    );
  },
  context(projectId: string, assistedSessionId?: string) {
    return sessionClient.request<RecordingContext>(
      `/projects/${projectId}/interviews${assistedSessionId ? "/context" : ""}`,
      assistedSessionId
        ? { key: paymentKey(), data: { assistedSessionId } }
        : undefined,
    );
  },
  start(projectId: string, data: Record<string, unknown>, key: string) {
    return sessionClient.request<RecordingInterview>(
      `/projects/${projectId}/interviews`,
      { data, key },
    );
  },
  resume(projectId: string, id: string, assistedSessionId?: string) {
    return sessionClient.request<RecordingInterview>(
      `/projects/${projectId}/interviews/${id}${assistedSessionId ? "/resume" : ""}`,
      assistedSessionId
        ? { key: paymentKey(), data: { assistedSessionId } }
        : undefined,
    );
  },
};
export class InterviewRecorder extends LocalAudioRecorder {
  private readonly sessionContext = sessionClient.context();
  private uploading = false;
  constructor(
    readonly projectId: string,
    readonly interview: RecordingInterview,
    private readonly canRecord: () => boolean,
    private readonly assistedSessionId?: string,
  ) {
    super(`${recordingPartition(projectId)}:${interview.id}`);
  }
  protected check() {
    if (this.sessionContext !== sessionClient.context())
      throw new Error("账号已变化，请重新查询");
    if (!this.canRecord())
      throw new Error("当前不能新录音，请保留本机文件并联系服务");
  }
  start() {
    if (this.uploading) return;
    super.start();
  }
  private currentContext() {
    if (this.sessionContext !== sessionClient.context())
      throw new Error("账号已变化，请重新查询");
  }
  async upload(clientClipId: string) {
    this.currentContext();
    if (this.uploading || this.active || this.pending || this.saving) return;
    const local = this.current.clips.find(
      (c) => c.clientClipId === clientClipId,
    );
    if (!local) throw new Error("没有已保存的片段");
    this.uploading = true;
    let sealing = false;
    const base = `/projects/${this.projectId}/interviews/${this.interview.id}/clips`,
      body = this.assistedSessionId
        ? { assistedSessionId: this.assistedSessionId }
        : {};
    try {
      this.update("uploading", "本机文件仍在；正在查询原上传结果");
      const remote = local.serverId
        ? await sessionClient.request<RecordingClip>(
            `${base}/${local.serverId}/status`,
            { key: paymentKey(), data: body },
          )
        : await sessionClient.request<RecordingClip>(base, {
            key: local.clientClipId,
            data: {
              ...body,
              clientClipId: local.clientClipId,
              bytes: local.bytes,
              sha256: local.sha256,
            },
          });
      this.currentContext();
      if (
        remote.clientClipId !== local.clientClipId ||
        remote.projectId !== this.projectId ||
        remote.interviewId !== this.interview.id ||
        remote.sha256 !== local.sha256 ||
        remote.bytes !== local.bytes
      )
        throw new Error("上传结果不匹配");
      local.serverId = remote.id;
      wx.setStorageSync(this.key, this.current.clips);
      let result = remote;
      if (remote.state === "released")
        throw new Error("上传预留已释放，本机文件仍保留，请联系服务");
      if (remote.state !== "sealed") {
        const form = await sessionClient.request<ProbeUploadForm>(
          `${base}/${remote.id}/upload`,
          { key: paymentKey(), data: body },
        );
        this.currentContext();
        await sessionClient.uploadRecording(form, local.path);
        this.currentContext();
        sealing = true;
        this.update("sealing", "暂存上传完成，正在完整校验；尚未封存");
        result = await sessionClient.request<RecordingClip>(
          `${base}/${remote.id}/seal`,
          { key: paymentKey(), data: body },
        );
        this.currentContext();
      }
      if (
        result.state !== "sealed" ||
        result.sha256 !== local.sha256 ||
        !result.asset
      )
        throw new Error("封存未确认");
      local.sealed = true;
      wx.setStorageSync(this.key, this.current.clips);
      this.update(
        "sealed",
        result.storage === "oss"
          ? "云端已保存；文字处理尚未开始"
          : "本地模拟封存完成；真实云端尚待验收，文字处理尚未开始",
      );
    } catch (error) {
      this.update(
        sealing ? "seal-error" : "upload-error",
        "保存未确认，本机文件仍在；可重新查询并按原文件重试",
      );
      throw error;
    } finally {
      this.uploading = false;
    }
  }
}
