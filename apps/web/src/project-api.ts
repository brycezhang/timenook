import { request, USER_TERMS_VERSION, WebApiError } from "./api";
import { auth } from "./session";
export interface StoryRevision {
  id: string;
  title: string;
  theme: string;
  createdAt: string;
  paragraphs: { text: string; sourceRefs: string[] }[];
  notes: { id: string; text: string }[] | null;
  reviewResolutions: { item: string; reason: string }[] | null;
  reviewItems: string[] | null;
  photoSnapshotId: string | null;
}
export interface StoryRecord {
  id: string;
  interviewId: string;
  version: number;
  included: boolean;
  createdAt: string;
  revision: StoryRevision | null;
  task: { state: string; sources: { durationMs: number | null }[] } | null;
}
export interface ProjectOverview {
  projectId: string;
  bookTitle: string;
  metadataVersion: number;
  canInvite: boolean;
  canRecord: boolean;
  nextStep: string;
  summary: { pending: number; confirmed: number; included: number };
  stories: StoryRecord[];
}
export interface Invitation {
  projectId: string;
  bookTitle: string;
  inviter: string;
  choice: string;
}
export function memberRequest<T>(
  path: string,
  data?: unknown,
  idempotencyKey?: string,
) {
  return auth.protect((owner, signal) =>
    request<T>(path, {
      method: data === undefined ? "GET" : "POST",
      data,
      csrf: owner.csrfToken,
      signal,
      idempotencyKey,
    }),
  );
}
const base = (id: string) => `/projects/${encodeURIComponent(id)}`;
export const projectApi = {
  overview: (id: string) =>
    memberRequest<ProjectOverview>(`${base(id)}/overview`),
  rename: (id: string, expectedVersion: number, bookTitle: string) =>
    memberRequest<ProjectOverview>(
      `${base(id)}/metadata`,
      { expectedVersion, bookTitle },
      crypto.randomUUID(),
    ),
  story: (id: string, storyId: string) =>
    memberRequest<StoryRecord>(
      `${base(id)}/stories/${encodeURIComponent(storyId)}`,
    ),
  revise: (
    id: string,
    story: StoryRecord,
    title: string,
    paragraphs: { text: string; sourceRefs: string[] }[],
  ) =>
    memberRequest<StoryRecord>(
      `${base(id)}/stories/${story.id}/revisions`,
      {
        expectedVersion: story.version,
        baseRevisionId: story.revision!.id,
        title,
        theme: story.revision!.theme,
        paragraphs,
        notes: story.revision!.notes ?? [],
        reviewResolutions: story.revision!.reviewResolutions ?? [],
      },
      crypto.randomUUID(),
    ),
  inclusion: (id: string, story: StoryRecord) =>
    memberRequest<StoryRecord>(`${base(id)}/stories/${story.id}/inclusion`, {
      expectedVersion: story.version,
      included: !story.included,
    }),
  invite: (id: string) =>
    memberRequest<{ token: string; expiresAt: string }>(
      `${base(id)}/invitations`,
      {},
    ),
  invitation: (token: string, signal?: AbortSignal) =>
    request<Invitation>(`/invitations/${encodeURIComponent(token)}`, {
      signal,
    }),
  accept: (token: string) =>
    memberRequest<{ projectId: string }>(
      `/invitations/${encodeURIComponent(token)}/accept`,
      { termsVersion: USER_TERMS_VERSION },
    ),
  nickname: (nickname: string) =>
    memberRequest<{ id: string; nickname: string }>("/users/me/profile", {
      nickname,
    }),
};
export function projectError(error: unknown) {
  if (error instanceof WebApiError) {
    if (error.status === 409)
      return "内容已被其他成员更新。请读取最新版本后再保存。";
    if (error.status === 403)
      return "暂时无法操作这个项目，请确认成员资格和项目状态。";
    if (error.status === 404)
      return "内容不存在或已不可用，请返回项目重新查看。";
    if (error.status === 400) return "请检查填写的内容后重试。";
  }
  return error instanceof Error ? error.message : "读取失败，请重试。";
}
export const storyTitle = (story: StoryRecord) =>
  story.revision?.title || "正在整理的故事";
export function storyState(story: StoryRecord) {
  if (story.revision) return story.included ? "已编入书稿" : "未编入书稿";
  if (story.task?.state === "no_content") return "等待补充讲述";
  if (
    story.task &&
    ["failed", "manual_review", "obsolete", "no_speech"].includes(
      story.task.state,
    )
  )
    return "需要重新整理";
  return "故事整理中";
}
export const storyMinutes = (story: StoryRecord) =>
  Math.ceil(
    (story.task?.sources.reduce(
      (sum, source) => sum + (source.durationMs ?? 0),
      0,
    ) ?? 0) / 60000,
  );
export const storyDate = (story: StoryRecord) =>
  new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date(story.createdAt));
