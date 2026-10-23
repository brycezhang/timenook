import type { ProjectOverview } from "../../packages/contracts/src";
import { sessionClient } from "./session";

function selectionKey() {
  return `timenook.live-project.v1:${sessionClient.context()}`;
}
function validate(value: ProjectOverview, projectId: string) {
  if (
    !value ||
    value.projectId !== projectId ||
    typeof value.bookTitle !== "string" ||
    !Number.isSafeInteger(value.metadataVersion) ||
    !Array.isArray(value.stories) ||
    !Array.isArray(value.interviews) ||
    !Array.isArray(value.tasks) ||
    !value.tasks.every(
      (task) =>
        task &&
        task.projectId === projectId &&
        typeof task.id === "string" &&
        ["transcribe_audio", "compose_story", "ask_followup"].includes(
          task.kind,
        ),
    ) ||
    !value.summary ||
    typeof value.nextStep !== "string" ||
    typeof value.canDecide !== "boolean"
  )
    throw new Error("项目状态无效，请重新查询");
  return value;
}
export const projectOverviewClient = {
  async memberships() {
    return sessionClient.request<{
      projects: { projectId: string; state: string }[];
    }>("/participations");
  },
  selected() {
    const id: unknown = wx.getStorageSync(selectionKey());
    return typeof id === "string" && /^[0-9a-f-]{36}$/.test(id) ? id : "";
  },
  select(id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("项目编号无效");
    wx.setStorageSync(selectionKey(), id);
  },
  async read(projectId: string) {
    return validate(
      await sessionClient.request<ProjectOverview>(
        `/projects/${projectId}/overview`,
      ),
      projectId,
    );
  },
  async rename(
    projectId: string,
    expectedVersion: number,
    bookTitle: string,
    key: string,
  ) {
    return validate(
      await sessionClient.request<ProjectOverview>(
        `/projects/${projectId}/metadata`,
        {
          key,
          data: { expectedVersion, bookTitle },
        },
      ),
      projectId,
    );
  },
};
