import {
  CONSENT_PURPOSES,
  type ConsentPurpose,
  type InvitationView,
  type ParticipationState,
  type BindingApplication,
  type ProjectCareRequestView,
  type AssistedSessionView,
  type AssistedPurpose,
  type WithdrawalStatus,
} from "../../packages/contracts/src";
import { sessionClient } from "./session";
import { paymentKey } from "./payments";
const uuid = (s: string) => /^[0-9a-f-]{36}$/.test(s);
const token = (s: string) => /^[A-Za-z0-9_-]{43}$/.test(s);
function state(value: ParticipationState) {
  if (
    !value ||
    !uuid(value.projectId) ||
    !["narrator", "initiator"].includes(value.role) ||
    !Number.isSafeInteger(value.accessEpoch) ||
    !Number.isSafeInteger(value.bindingVersion) ||
    !Array.isArray(value.choices) ||
    value.choices.length !== 3 ||
    !CONSENT_PURPOSES.every((p) =>
      value.choices.some(
        (c) => c.purpose === p && [true, false, null].includes(c.granted),
      ),
    ) ||
    typeof value.canRead !== "boolean"
  )
    throw new Error("参与状态无效，请重新查询");
  return value;
}
export function withdrawalDisposition(withdrawal: WithdrawalStatus): string {
  const state = withdrawal.production?.state;
  return state === "cancellation_pending"
    ? "已请求停止生产，印厂接单或取消结果待人工核实"
    : state === "cancelled"
      ? "本次生产已停止；之后须重新核对授权和版本"
      : state === "delivered"
        ? "纸书已交付，实物及已导出文件不能远程收回"
        : withdrawal.changes.length
          ? "相关访问已停止，处置进度以本页实际记录为准"
          : "暂无撤回或账号变更记录";
}
export const participationClient = {
  async withdrawalStatus(id: string) {
    if (!uuid(id)) throw new Error("项目编号无效");
    const value = await sessionClient.request<WithdrawalStatus>(
      `/projects/${id}/withdrawal-status`,
    );
    if (
      !value ||
      value.projectId !== id ||
      !Number.isSafeInteger(value.accessEpoch) ||
      !Array.isArray(value.changes) ||
      typeof value.boundary !== "string"
    )
      throw Error("撤回处置状态无效，请重新查询");
    return value;
  },
  async preview(value: string) {
    if (!token(value)) throw new Error("邀请无效");
    const result = await sessionClient.publicRequest<InvitationView>(
      `/invitations/${value}`,
    );
    if (
      !result ||
      typeof result.inviter !== "string" ||
      !Array.isArray(result.process) ||
      !Array.isArray(result.purposes) ||
      result.purposes.length !== 3
    )
      throw new Error("邀请无效或已到期");
    return result;
  },
  async invite(id: string) {
    if (!uuid(id)) throw new Error("项目编号无效");
    const result = await sessionClient.request<{
      token: string;
      expiresAt: string;
    }>(`/projects/${id}/invitations`, { data: {}, key: paymentKey() });
    if (!token(result.token) || Date.parse(result.expiresAt) <= Date.now())
      throw new Error("邀请无效");
    return result;
  },
  async apply(value: string, noticeVersion: string) {
    return sessionClient.request<{
      id: string;
      projectId: string;
      state: string;
    }>(`/invitations/${value}/requests`, {
      data: { noticeVersion, evidenceRef: "synthetic:本人阅读告知并申请参与" },
      key: paymentKey(),
    });
  },
  async state(id: string) {
    if (!uuid(id)) throw new Error("项目编号无效");
    return state(
      await sessionClient.request<ParticipationState>(
        `/projects/${id}/participation`,
      ),
    );
  },
  async memberships() {
    return sessionClient.request<{
      projects: { projectId: string; state: string }[];
    }>("/participations");
  },
  async requests(id: string) {
    return sessionClient.request<{ requests: BindingApplication[] }>(
      `/projects/${id}/binding-requests`,
    );
  },
  async approve(id: string, expectedBindingVersion: number, key: string) {
    return sessionClient.request(`/binding-requests/${id}/approve`, {
      data: {
        expectedBindingVersion,
        evidenceRef: "synthetic:发起人明确核对申请者账号",
      },
      key,
    });
  },
  async choose(
    current: ParticipationState,
    purpose: ConsentPurpose,
    granted: boolean,
    key: string,
  ) {
    const revoke =
      !granted &&
      current.choices.some((c) => c.purpose === purpose && c.granted);
    return state(
      await sessionClient.request<ParticipationState>(
        `/projects/${current.projectId}/consents${revoke ? "/revoke" : ""}`,
        {
          key,
          data: {
            noticeVersion: current.noticeVersion,
            evidenceRef: "synthetic:本人分别选择资料用途",
            purpose,
            ...(!revoke ? { granted } : {}),
            expectedBindingVersion: current.bindingVersion,
            expectedAccessEpoch: current.accessEpoch,
          },
        },
      ),
    );
  },
  async assisted(
    current: ParticipationState,
    purpose: AssistedPurpose,
    granted: boolean,
    key: string,
    expectedSessionId?: string,
  ) {
    return sessionClient.request<AssistedSessionView>(
      `/projects/${current.projectId}/assisted-sessions`,
      {
        key,
        data: {
          purpose,
          granted,
          noticeVersion: current.noticeVersion,
          evidenceRef: `synthetic:当次同机本人选择:${key}`,
          ...(expectedSessionId ? { expectedSessionId } : {}),
          expectedBindingVersion: current.bindingVersion,
          expectedAccessEpoch: current.accessEpoch,
        },
      },
    );
  },
  async assistedSessions(id: string) {
    const result = await sessionClient.request<{
      sessions: AssistedSessionView[];
    }>(`/projects/${id}/assisted-sessions`);
    if (
      !Array.isArray(result?.sessions) ||
      !result.sessions.every(
        (row) =>
          uuid(row.id) &&
          row.projectId === id &&
          uuid(row.subjectId) &&
          uuid(row.operatorUserId) &&
          [
            "collection",
            "ai",
            "sharing",
            "story_confirmation",
            "book_confirmation",
          ].includes(row.purpose) &&
          ["active", "expired", "revoked", "rejected"].includes(row.state) &&
          Number.isFinite(Date.parse(row.expiresAt)),
      )
    )
      throw new Error("协助状态无效，请重新查询");
    return result.sessions.map((row) => ({
      ...row,
      state:
        row.state === "active" && Date.parse(row.expiresAt) <= Date.now()
          ? ("expired" as const)
          : row.state,
    }));
  },
  async subjectCare(
    current: ParticipationState,
    kind: "withdraw" | "export" | "delete",
    key: string,
  ) {
    return sessionClient.request<{ supportCaseRef: string }>(
      `/projects/${current.projectId}/care-requests`,
      { key, data: { kind, expectedBindingVersion: current.bindingVersion } },
    );
  },
  async care(current: ParticipationState, targetUserId: string, key: string) {
    return sessionClient.request<{ supportCaseRef: string }>(
      `/projects/${current.projectId}/care-requests`,
      {
        key,
        data: {
          kind: "rebind",
          targetUserId,
          expectedBindingVersion: current.bindingVersion,
        },
      },
    );
  },
  async careRequests(id: string) {
    if (!uuid(id)) throw new Error("项目编号无效");
    const result = await sessionClient.request<{
      requests: ProjectCareRequestView[];
    }>(`/projects/${id}/care-requests`);
    if (
      !Array.isArray(result?.requests) ||
      !result.requests.every(
        (item) =>
          uuid(item.id) &&
          [
            "rebind",
            "withdraw",
            "export",
            "delete",
            "correction",
            "first_copy_expiry",
            "production_handoff",
            "refund",
          ].includes(item.kind) &&
          ["open", "verified", "completed"].includes(item.state) &&
          Number.isFinite(Date.parse(item.createdAt)),
      )
    )
      throw new Error("工单状态无效，请重新查询");
    return result.requests;
  },
};
