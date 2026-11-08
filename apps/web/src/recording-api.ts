import { auth, restoreSession } from "./session";
import { WebApiError } from "./api";
import type { LocalRecording } from "./recording-store";
import { fetchVerifiedBlob } from "./private-media";
import type {
  RecordingContext,
  RecordingInterview,
  RecordingClip,
  StoryContext,
  ProductionTaskView,
  ProbeUploadForm,
} from "../../../packages/contracts/src";

// This boundary is fenced to the active Cookie session, including delayed uploads.
async function request<T>(
  path: string,
  data?: unknown,
  idempotencyKey: string = crypto.randomUUID(),
): Promise<T> {
  const owner = auth.account.value;
  if (!owner) throw new WebApiError(401, "请先登录后继续录音。");
  const response = await fetch(`/api/v1${path}`, {
    method: data === undefined ? "GET" : "POST",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(15000),
    headers: {
      "X-Timenook-Web": "1",
      ...(data === undefined
        ? {}
        : {
            "Content-Type": "application/json",
            "X-CSRF-Token": owner.csrfToken,
            "Idempotency-Key": idempotencyKey,
          }),
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  }).catch(() => {
    throw Error("网络连接未完成，请重试；已保存的录音仍在本机。");
  });
  if (auth.account.value?.session.id !== owner.session.id)
    throw Error("账号已变化，请重新进入项目。");
  if (!response.ok) {
    if (response.status === 401) void restoreSession();
    throw new WebApiError(
      response.status,
      response.status === 403 || response.status === 404
        ? "当前账号无法访问这段讲述，请重新进入项目。"
        : response.status === 409
          ? "讲述内容或额度已变化，请重新读取后继续。"
          : "操作未完成，请重试。",
    );
  }
  const result = await response.json();
  if (!result || !("data" in result) || result.error)
    throw Error("录音状态读取失败，请重试。");
  return result.data as T;
}
const base = (projectId: string, interviewId?: string) =>
  `/projects/${projectId}/interviews${interviewId ? `/${interviewId}` : ""}`;
export const recordingApi = {
  context: (projectId: string) => request<RecordingContext>(base(projectId)),
  resume: (projectId: string, interviewId: string) =>
    request<RecordingInterview>(base(projectId, interviewId)),
  start: (projectId: string, data: object, key: string) =>
    request<RecordingInterview>(base(projectId), data, key),
  authorize: (projectId: string, interview: RecordingInterview) =>
    request<{
      allowed: boolean;
      actualQuestionId: string;
      questionVersion: number;
      maxDurationMs: number;
    }>(`${base(projectId, interview.id)}/recording-start`, {
      actualQuestionId: interview.currentQuestion.id,
      expectedQuestionVersion: interview.questionVersion,
    }),
  collection: (projectId: string, interviewId: string) =>
    request<{ allowed: boolean }>(
      `${base(projectId, interviewId)}/collection-check`,
      {},
    ),
  tasks: (projectId: string, interviewId: string) =>
    request<ProductionTaskView[]>(`/projects/${projectId}/tasks/status`, {
      interviewId,
    }),
  task: (projectId: string, taskId: string) =>
    request<ProductionTaskView>(`/projects/${projectId}/tasks/${taskId}`),
  story: (projectId: string, interviewId: string) =>
    request<StoryContext>(`/projects/${projectId}/stories/context`, {
      interviewId,
    }),
  retry: (projectId: string, taskId: string) =>
    request<ProductionTaskView>(
      `/projects/${projectId}/tasks/${taskId}/retry`,
      {},
    ),
  async upload(
    clip: LocalRecording,
    saved: (clip: LocalRecording) => Promise<void>,
    current: () => boolean,
  ) {
    const clips = `${base(clip.projectId, clip.interviewId)}/clips`;
    let remote = clip.serverId
      ? await request<RecordingClip>(`${clips}/${clip.serverId}/status`, {})
      : await request<RecordingClip>(
          clips,
          {
            clientClipId: clip.clientClipId,
            actualQuestionId: clip.actualQuestionId,
            bytes: clip.blob.size,
            sha256: clip.sha256,
          },
          clip.clientClipId,
        );
    if (!current()) throw Error("录音上传已取消。");
    if (
      remote.projectId !== clip.projectId ||
      remote.interviewId !== clip.interviewId ||
      remote.clientClipId !== clip.clientClipId ||
      remote.actualQuestionId !== clip.actualQuestionId ||
      remote.bytes !== clip.blob.size ||
      remote.sha256 !== clip.sha256 ||
      (clip.serverId && remote.id !== clip.serverId)
    )
      throw Error("录音上传结果不匹配，请重新查询。");
    clip = { ...clip, serverId: remote.id };
    await saved(clip);
    if (remote.state === "released")
      throw Error("这段录音的上传未能继续，请联系支持；本机文件仍然保留。");
    if (remote.state !== "sealed") {
      const form = await request<ProbeUploadForm>(
        `${clips}/${remote.id}/upload`,
        {},
      );
      if (!current()) throw Error("录音上传已取消。");
      await uploadRecording(form, clip.blob);
      if (!current()) throw Error("录音上传已取消。");
      remote = await request<RecordingClip>(`${clips}/${remote.id}/seal`, {});
    }
    if (!current()) throw Error("录音上传已取消。");
    if (
      remote.state !== "sealed" ||
      remote.sha256 !== clip.sha256 ||
      remote.actualQuestionId !== clip.actualQuestionId ||
      remote.asset?.sha256 !== clip.sha256 ||
      remote.asset.bytes !== clip.blob.size
    )
      throw Error("上传保存尚未确认，请重试。");
    await saved({ ...clip, sealed: true });
  },
  async original(projectId: string, interviewId: string, clipId: string) {
    const path = `${base(projectId, interviewId)}/clips/${clipId}`;
    const clip = await request<RecordingClip>(path);
    if (
      clip.id !== clipId ||
      clip.projectId !== projectId ||
      clip.interviewId !== interviewId ||
      clip.state !== "sealed" ||
      !clip.asset ||
      clip.asset.sha256 !== clip.sha256
    )
      throw Error("原声来源无效，请重新读取。");
    return fetchVerifiedBlob(`${path}/content`, clip.asset);
  },
};
export async function uploadRecording(form: ProbeUploadForm, blob: Blob) {
  const owner = auth.account.value;
  const local =
    form.storage === "local-simulator" && form.url === "/v1/recordings/objects";
  const cloud =
    form.storage === "oss" &&
    /^https:\/\/[a-z0-9-]+\.oss-[a-z0-9-]+\.aliyuncs\.com$/.test(form.url);
  if (
    !owner ||
    (!local && !cloud) ||
    Date.parse(form.expiresAt) <= Date.now() ||
    !Number.isFinite(Date.parse(form.expiresAt))
  )
    throw Error("录音上传凭据已失效，请重试。");
  const body = new FormData();
  for (const [key, value] of Object.entries(form.fields))
    body.append(key, value);
  body.append("file", blob, "recording.mp3");
  const response = await fetch(
    local ? "/api/v1/recordings/objects" : form.url,
    {
      method: "POST",
      body,
      credentials: local ? "same-origin" : "omit",
      redirect: "error",
      signal: AbortSignal.timeout(45000),
      headers: local
        ? { "X-Timenook-Web": "1", "X-CSRF-Token": owner.csrfToken }
        : {},
    },
  );
  if (auth.account.value?.session.id !== owner.session.id)
    throw Error("账号已变化，请重新进入项目。");
  if (!response.ok)
    throw new WebApiError(
      response.status,
      "上传未成功，声音仍保存在本机，请重试。",
    );
}
