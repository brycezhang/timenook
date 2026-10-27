import type {
  CompleteExportContext,
  CompleteExportView,
} from "../../packages/contracts/src";
import { sessionClient } from "./session";
const uuid = (v: string) => /^[a-f0-9-]{36}$/.test(v);
function record(v: CompleteExportView, projectId: string) {
  if (
    !v ||
    !uuid(v.id) ||
    v.projectId !== projectId ||
    ![
      "requested",
      "accepted",
      "packing",
      "ready",
      "failed",
      "expired",
      "revoked",
      "delivered",
    ].includes(v.state) ||
    typeof v.canDownload !== "boolean" ||
    (v.expiresAt !== null && !Number.isFinite(Date.parse(v.expiresAt))) ||
    (v.sha256 !== null && !/^[a-f0-9]{64}$/.test(v.sha256)) ||
    (v.bytes !== null && (!Number.isSafeInteger(v.bytes) || v.bytes < 1))
  )
    throw Error("资料导出状态无效，请重新查询");
  return v;
}
export const completeExportClient = {
  async receipt(projectId: string, id: string, sha256: string, key: string) {
    return record(
      await sessionClient.request<CompleteExportView>(
        `/projects/${projectId}/exports/${id}/receipt`,
        { key, data: { sha256 } },
      ),
      projectId,
    );
  },
  async read(projectId: string) {
    if (!uuid(projectId)) throw Error("项目编号无效");
    const v = await sessionClient.request<CompleteExportContext>(
      `/projects/${projectId}/exports`,
    );
    if (
      !v ||
      v.projectId !== projectId ||
      v.amountDueFen !== 0 ||
      typeof v.canRequest !== "boolean" ||
      !Number.isSafeInteger(v.accessEpoch) ||
      !v.service ||
      !Array.isArray(v.requests) ||
      !v.requestWindow
    )
      throw Error("资料导出状态无效，请重新查询");
    v.requests.forEach((row) => record(row, projectId));
    return v;
  },
  async request(
    projectId: string,
    recipient: "self" | "initiator",
    evidence: string,
    key: string,
  ) {
    if (!uuid(projectId)) throw Error("项目编号无效");
    return record(
      await sessionClient.request<CompleteExportView>(
        `/projects/${projectId}/exports`,
        {
          key,
          data: {
            recipient,
            noticeVersion: "synthetic-d08-v1",
            evidenceRef: `synthetic:${evidence}`,
          },
        },
      ),
      projectId,
    );
  },
};
