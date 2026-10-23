import type {
  StoryContext,
  StoryView,
  ProductionTaskView,
} from "../../packages/contracts/src";
import { sessionClient } from "./session";
import { paymentKey } from "./payments";
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
