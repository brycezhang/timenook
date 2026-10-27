import type { DeletionStatus } from "../../packages/contracts/src";
import { sessionClient } from "./session";
export const deletionClient = {
  async read(projectId: string) {
    if (!/^[a-f0-9-]{36}$/.test(projectId)) throw Error("请选择当前项目后查询");
    const value = await sessionClient.request<DeletionStatus>(
      `/projects/${projectId}/deletion-status`,
    );
    if (
      !value ||
      value.projectId !== projectId ||
      typeof value.onlineAccessStopped !== "boolean" ||
      typeof value.permanentProjectDeletion !== "boolean" ||
      !Number.isSafeInteger(value.accessEpoch) ||
      !Array.isArray(value.changes) ||
      value.changes.some((change) => !Array.isArray(change.items))
    )
      throw Error("删除进度未能确认，请重新查询");
    return value;
  },
};
