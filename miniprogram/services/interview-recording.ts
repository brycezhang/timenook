import { LocalAudioRecorder } from "./local-audio-recorder";
import { sessionClient } from "./session";
import { API_BASE_URL } from "../config";
import { paymentKey } from "./payments";
import type {
  ProductionTaskView,
  RecordingClip,
  RecordingContext,
  RecordingInterview,
} from "../../packages/contracts/src";
import type {
  ProbeLocalClip,
  ProbeUploadForm,
} from "../../packages/contracts/src/audio-probe";
export type InterviewLocalClip = ProbeLocalClip & {
  storage?: RecordingClip["storage"];
};

export function recordingPartition(projectId: string) {
  const account = sessionClient.context().split(":")[0];
  if (!account) throw new Error("请先登录");
  const appId = wx.getAccountInfoSync?.().miniProgram.appId ?? "";
  return `timenook.recording.v1:${API_BASE_URL}:${appId}:${account}:${projectId}`;
}
export const interviewRecordingClient = {
  taskStatus(
    projectId: string,
    interviewId: string,
    assistedSessionId?: string,
  ) {
    return sessionClient.request<ProductionTaskView[]>(
      `/projects/${projectId}/tasks/status`,
      {
        key: paymentKey(),
        data: {
          interviewId,
          ...(assistedSessionId ? { assistedSessionId } : {}),
        },
      },
    );
  },
  retryTask(
    projectId: string,
    taskId: string,
    key: string,
    assistedSessionId?: string,
  ) {
    return sessionClient.request<ProductionTaskView>(
      `/projects/${projectId}/tasks/${taskId}/retry`,
      { key, data: assistedSessionId ? { assistedSessionId } : {} },
    );
  },
  authorizeCollection(
    projectId: string,
    id: string,
    assistedSessionId?: string,
  ) {
    return sessionClient.request<{ allowed: boolean }>(
      `/projects/${projectId}/interviews/${id}/collection-check`,
      {
        key: paymentKey(),
        data: assistedSessionId ? { assistedSessionId } : {},
      },
    );
  },
  authorizeStart(
    projectId: string,
    id: string,
    actualQuestionId: string,
    expectedQuestionVersion: number,
    assistedSessionId?: string,
  ) {
    return sessionClient.request<{
      allowed: boolean;
      actualQuestionId: string;
      questionVersion: number;
      maxDurationMs: number;
    }>(`/projects/${projectId}/interviews/${id}/recording-start`, {
      key: paymentKey(),
      data: {
        actualQuestionId,
        expectedQuestionVersion,
        ...(assistedSessionId ? { assistedSessionId } : {}),
      },
    });
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
  private static readonly owners = new Map<string, InterviewRecorder>();
  // Preserve native pending-save/retry state across page instances. Uploads
  // remain independently fenced and persist only their own clip changes.
  static open(
    projectId: string,
    interview: RecordingInterview,
    canRecord: () => boolean,
    assistedSessionId?: string,
  ) {
    const key = `${recordingPartition(projectId)}:${interview.id}`;
    const prior = this.owners.get(key);
    if (prior && (prior.pending || prior.saving || prior.active)) {
      prior.sessionContext = sessionClient.context();
      prior.canRecord = canRecord;
      prior.assistedSessionId = assistedSessionId;
      return prior;
    }
    const owner = new InterviewRecorder(
      projectId,
      interview,
      canRecord,
      assistedSessionId,
    );
    this.owners.set(key, owner);
    return owner;
  }
  private sessionContext = sessionClient.context();
  private uploading = false;
  constructor(
    readonly projectId: string,
    readonly interview: RecordingInterview,
    private canRecord: () => boolean,
    private assistedSessionId?: string,
  ) {
    super(`${recordingPartition(projectId)}:${interview.id}`);
  }
  protected check() {
    if (this.sessionContext !== sessionClient.context())
      throw new Error("账号已变化，请重新查询");
    if (!this.canRecord())
      throw new Error("当前不能新录音，请保留本机文件并联系服务");
  }
  start(actualQuestionId?: string, maxDurationMs?: number) {
    if (this.uploading) return;
    if (!actualQuestionId || !/^[a-f0-9-]{36}$/.test(actualQuestionId))
      throw new Error("实际问题未确认，请重新查询");
    super.start(actualQuestionId, maxDurationMs);
  }
  async restore() {
    await super.restore();
    // T14 manifests had one question per interview. Never use its later current question.
    const original = this.interview.actualQuestion;
    const knownOrigin =
      original?.projectId === this.projectId &&
      original.answerRef === this.interview.id &&
      /^[a-f0-9-]{36}$/.test(original.id)
        ? original.id
        : undefined;
    for (const clip of [...this.current.clips]) {
      if (clip.actualQuestionId) continue;
      const saved = clip.serverId
        ? this.interview.clips.find(
            (row) =>
              row.id === clip.serverId &&
              row.clientClipId === clip.clientClipId,
          )
        : undefined;
      const actualQuestionId =
        saved?.actualQuestionId ?? (!clip.serverId ? knownOrigin : undefined);
      if (actualQuestionId) this.commitClip({ ...clip, actualQuestionId });
    }
    this.update(this.current.stage, this.current.message);
  }
  private currentContext() {
    if (this.sessionContext !== sessionClient.context())
      throw new Error("账号已变化，请重新查询");
  }
  async upload(clientClipId: string) {
    this.currentContext();
    if (this.uploading || this.active || this.pending || this.saving) return;
    const local: InterviewLocalClip | undefined = this.current.clips.find(
      (c) => c.clientClipId === clientClipId,
    );
    if (!local) throw new Error("没有已保存的片段");
    if (
      !local.serverId &&
      (!local.actualQuestionId ||
        !/^[a-f0-9-]{36}$/.test(local.actualQuestionId))
    ) {
      const message = "原录音的问题归属未确认；本机文件仍保留，请重新查询";
      this.update("upload-error", message);
      throw new Error(message);
    }
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
              actualQuestionId: local.actualQuestionId,
              bytes: local.bytes,
              sha256: local.sha256,
            },
          });
      this.currentContext();
      if (
        remote.clientClipId !== local.clientClipId ||
        remote.projectId !== this.projectId ||
        remote.interviewId !== this.interview.id ||
        (local.serverId && remote.id !== local.serverId) ||
        !/^[a-f0-9-]{36}$/.test(remote.actualQuestionId) ||
        (local.actualQuestionId &&
          remote.actualQuestionId !== local.actualQuestionId) ||
        remote.sha256 !== local.sha256 ||
        remote.bytes !== local.bytes
      )
        throw new Error("上传结果不匹配");
      local.actualQuestionId ??= remote.actualQuestionId;
      local.serverId = remote.id;
      this.commitClip(local);
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
        this.update("sealing", "录音已上传，正在确认保存，请先别退出");
        result = await sessionClient.request<RecordingClip>(
          `${base}/${remote.id}/seal`,
          { key: paymentKey(), data: body },
        );
        this.currentContext();
      }
      if (
        result.state !== "sealed" ||
        result.actualQuestionId !== local.actualQuestionId ||
        result.sha256 !== local.sha256 ||
        !result.asset
      )
        throw new Error("封存未确认");
      local.sealed = true;
      local.storage = result.storage;
      this.commitClip(local);
      this.update(
        "sealed",
        result.storage === "oss"
          ? "已上传到云端，可以离开；文字处理状态可重新查询"
          : "已在测试环境保存，真实云端保存仍待验证",
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
