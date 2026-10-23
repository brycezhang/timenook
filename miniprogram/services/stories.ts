import type {
  StoryContext,
  StoryView,
  ProductionTaskView,
} from "../../packages/contracts/src";
import { sessionClient } from "./session";
import { paymentKey } from "./payments";
export interface StoryRevisionInput {
  baseRevisionId: string;
  expectedVersion: number;
  title: string;
  theme: string;
  paragraphs: { text: string; sourceRefs: string[] }[];
  reviewResolutions: { item: string; reason: string }[];
  notes: { id: string; text: string }[];
  photoSnapshotId?: string | null;
  audioClipIds?: string[];
}
function story(value: StoryView, projectId: string) {
  if (
    !value ||
    value.projectId !== projectId ||
    typeof value.id !== "string" ||
    !Number.isSafeInteger(value.version) ||
    value.version < 0 ||
    (value.task && value.task.kind !== "compose_story")
  )
    throw new Error("故事状态无效，请重新查询");
  return value;
}
export const storyClient = {
  requestCorrection(
    projectId: string,
    id: string,
    input: {
      revisionId: string;
      contentHash: string;
      expectedVersion: number;
      evidenceRef: string;
      expiresAt: string;
      assistedSessionId?: string;
    },
    key: string,
  ) {
    return sessionClient.request<{
      caseId: string;
      storyId: string;
      expiresAt: string;
    }>(`/projects/${projectId}/stories/${id}/care-access`, {
      key,
      data: { ...input, noticeVersion: "synthetic-d08-v1" },
    });
  },
  async revise(
    projectId: string,
    id: string,
    input: StoryRevisionInput,
    key: string,
  ) {
    return story(
      await sessionClient.request<StoryView>(
        `/projects/${projectId}/stories/${id}/revisions`,
        { key, data: { ...input } },
      ),
      projectId,
    );
  },
  async decide(
    projectId: string,
    id: string,
    input: {
      revisionId: string;
      contentHash: string;
      expectedVersion: number;
      confirmed: boolean;
      allowInBook: boolean;
      evidenceRef: string;
      assistedSessionId?: string;
    },
    key: string,
  ) {
    return story(
      await sessionClient.request<StoryView>(
        `/projects/${projectId}/stories/${id}/decisions`,
        {
          key,
          data: { ...input, noticeVersion: "synthetic-d08-v1" },
        },
      ),
      projectId,
    );
  },
  async context(
    projectId: string,
    interviewId: string,
    assistedSessionId?: string,
  ) {
    const result = await sessionClient.request<StoryContext>(
      `/projects/${projectId}/stories/context`,
      {
        key: paymentKey(),
        data: {
          interviewId,
          ...(assistedSessionId ? { assistedSessionId } : {}),
        },
      },
    );
    if (
      !result ||
      result.interviewId !== interviewId ||
      typeof result.cloudSaved !== "boolean"
    )
      throw new Error("录音保存状态无效");
    if (result.story) story(result.story, projectId);
    return result;
  },
  async read(projectId: string, id: string) {
    return story(
      await sessionClient.request<StoryView>(
        `/projects/${projectId}/stories/${id}`,
      ),
      projectId,
    );
  },
  async organize(
    projectId: string,
    interviewId: string,
    baseVersion: number,
    key: string,
    assistedSessionId?: string,
  ) {
    return story(
      await sessionClient.request<StoryView>(
        `/projects/${projectId}/stories/organize`,
        {
          key,
          data: {
            interviewId,
            baseVersion,
            ...(assistedSessionId ? { assistedSessionId } : {}),
          },
        },
      ),
      projectId,
    );
  },
  retry(
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
  task(projectId: string, taskId: string) {
    return sessionClient.request<ProductionTaskView>(
      `/projects/${projectId}/tasks/${taskId}`,
    );
  },
};
