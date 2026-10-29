import { RequestClient } from "@vben/request";
import type {
  DeletionStatus,
  StoryView,
  AdminAuditEntry,
  AdminFeishuLogin,
  AdminRuntime,
  AdminState,
  ApiResponse,
} from "@timenook/contracts";
// Same-origin public path; credentials never enter browser storage or JS.
const client = new RequestClient({
  baseURL: "/api/v1/admin",
  withCredentials: true,
});
import type { CompleteExportView } from "@timenook/contracts";
export const completeExportApi = {
  async verifyAccess(id: string, body: object, key: string, csrf: string) {
    return (
      await client.post<ApiResponse<{ id: string; expiresAt: string }>>(
        `/care-requests/${id}/export/access-verification`,
        body,
        { headers: { "X-CSRF-Token": csrf, "Idempotency-Key": key } },
      )
    ).data;
  },
  async read(id: string) {
    return (
      await client.get<ApiResponse<CompleteExportView | null>>(
        `/care-requests/${id}/export`,
      )
    ).data;
  },
  async command(
    id: string,
    action: "accept" | "pack" | "delivery",
    body: object,
    key: string,
    csrf: string,
  ) {
    return (
      await client.post<ApiResponse<CompleteExportView>>(
        `/care-requests/${id}/export/${action}`,
        body,
        { headers: { "X-CSRF-Token": csrf, "Idempotency-Key": key } },
      )
    ).data;
  },
  async download(id: string) {
    const r = await fetch(`/api/v1/admin/care-requests/${id}/export/download`, {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!r.ok)
      throw await r.json().catch(() => ({ error: { code: "UNAVAILABLE" } }));
    return r.arrayBuffer();
  },
};
export const deletionApi = {
  async read(id: string) {
    return (
      await client.get<ApiResponse<DeletionStatus>>(
        `/care-requests/${id}/deletion-status`,
      )
    ).data;
  },
  async command(
    id: string,
    action: string,
    body: object,
    key: string,
    csrf: string,
  ) {
    return (
      await client.post<ApiResponse<DeletionStatus>>(
        `/care-requests/${id}/deletion/${action}`,
        body,
        { headers: { "X-CSRF-Token": csrf, "Idempotency-Key": key } },
      )
    ).data;
  },
};
client.addResponseInterceptor({ fulfilled: (response) => response.data });
export const adminApi = {
  async session() {
    return (await client.get<ApiResponse<AdminState>>("/session")).data;
  },
  async feishuLogin(csrf: string) {
    return (
      await client.post<ApiResponse<AdminFeishuLogin>>(
        "/feishu/login",
        {},
        { headers: { "X-CSRF-Token": csrf } },
      )
    ).data;
  },
  async runtime() {
    return (await client.get<ApiResponse<AdminRuntime>>("/runtime")).data;
  },
  async audit() {
    return (await client.get<ApiResponse<AdminAuditEntry[]>>("/audit")).data;
  },
  async logout(csrf: string) {
    await client.post("/logout", {}, { headers: { "X-CSRF-Token": csrf } });
  },
};
import type { RefundView } from "@timenook/contracts";
export const refundApi = {
  async forCase(id: string) {
    return (
      await client.get<ApiResponse<RefundView>>(
        `/refunds/cases/${encodeURIComponent(id)}`,
      )
    ).data;
  },
  async command(
    id: string,
    action: "approve" | "reject" | "submit" | "reconcile" | "production-review",
    body: object,
    key: string,
    csrf: string,
  ) {
    return (
      await client.post<ApiResponse<RefundView>>(
        `/refunds/${encodeURIComponent(id)}/${action}`,
        body,
        { headers: { "Idempotency-Key": key, "X-CSRF-Token": csrf } },
      )
    ).data;
  },
};
import type { QualityRequestView, QualityMaterials } from "@timenook/contracts";
export const qualityApi = {
  async read(caseId: string) {
    return (
      await client.get<ApiResponse<QualityRequestView>>(
        `/quality/cases/${encodeURIComponent(caseId)}`,
      )
    ).data;
  },
  async command(
    caseId: string,
    action: "assign" | "review" | "reprints",
    body: object,
    key: string,
    csrf: string,
  ) {
    return (
      await client.post<ApiResponse<QualityRequestView>>(
        `/quality/cases/${encodeURIComponent(caseId)}/${action}`,
        body,
        { headers: { "Idempotency-Key": key, "X-CSRF-Token": csrf } },
      )
    ).data;
  },
  async materials(caseId: string, csrf: string) {
    return (
      await client.get<ApiResponse<QualityMaterials>>(
        `/quality/cases/${encodeURIComponent(caseId)}/materials`,
        { headers: { "X-CSRF-Token": csrf } },
      )
    ).data;
  },
  async pdf(caseId: string, csrf: string) {
    const response = await fetch(
      `/api/v1/admin/quality/cases/${encodeURIComponent(caseId)}/pdf`,
      {
        credentials: "same-origin",
        cache: "no-store",
        headers: { "X-CSRF-Token": csrf },
      },
    );
    if (!response.ok)
      throw await response
        .json()
        .catch(() => ({ error: { code: "UNAVAILABLE" } }));
    return response.arrayBuffer();
  },
};

import type {
  ManagedRecipientType,
  PackageDraft,
  PackageDraftInput,
  PackageVersion,
} from "@timenook/contracts";
export const catalogApi = {
  async recipients() {
    return (
      await client.get<ApiResponse<ManagedRecipientType[]>>(
        "/catalog/recipient-types",
      )
    ).data;
  },
  async saveRecipient(
    input: Omit<ManagedRecipientType, "revision">,
    revision: number | null,
    csrf: string,
  ) {
    const { code, label, sortOrder, active } = input;
    const fields = { label, sortOrder, active };
    return (
      revision === null
        ? await client.post<ApiResponse<ManagedRecipientType>>(
            "/catalog/recipient-types",
            { code, ...fields },
            { headers: { "X-CSRF-Token": csrf } },
          )
        : await client.put<ApiResponse<ManagedRecipientType>>(
            `/catalog/recipient-types/${encodeURIComponent(code)}`,
            { ...fields, expectedRevision: revision },
            { headers: { "X-CSRF-Token": csrf } },
          )
    ).data;
  },
  async drafts() {
    return (
      await client.get<ApiResponse<PackageDraft[]>>("/catalog/package-drafts")
    ).data;
  },
  async saveDraft(
    input: PackageDraftInput,
    draft: { id: string; revision: number } | null,
    csrf: string,
  ) {
    return (
      draft
        ? await client.put<ApiResponse<PackageDraft>>(
            `/catalog/package-drafts/${draft.id}`,
            { ...input, expectedRevision: draft.revision },
            { headers: { "X-CSRF-Token": csrf } },
          )
        : await client.post<ApiResponse<PackageDraft>>(
            "/catalog/package-drafts",
            input,
            { headers: { "X-CSRF-Token": csrf } },
          )
    ).data;
  },
  async versions() {
    return (
      await client.get<ApiResponse<PackageVersion[]>>(
        "/catalog/package-versions",
      )
    ).data;
  },
  async freeze(draft: { id: string; revision: number }, csrf: string) {
    return (
      await client.post<ApiResponse<PackageVersion>>(
        `/catalog/package-drafts/${draft.id}/preview-versions`,
        { expectedRevision: draft.revision },
        { headers: { "X-CSRF-Token": csrf } },
      )
    ).data;
  },
};

import type { CareCase } from "@timenook/contracts";
export const careApi = {
  async story(caseId: string, csrf: string) {
    return (
      await client.get<ApiResponse<StoryView>>(
        `/care-requests/${caseId}/story`,
        { headers: { "X-CSRF-Token": csrf } },
      )
    ).data;
  },
  async correct(
    caseId: string,
    story: StoryView,
    title: string,
    paragraphs: { text: string; sourceRefs: string[] }[],
    reviewResolutions: { item: string; reason: string }[],
    key: string,
    csrf: string,
  ) {
    return (
      await client.post<ApiResponse<StoryView>>(
        `/care-requests/${caseId}/story/revisions`,
        {
          baseRevisionId: story.revision!.id,
          expectedVersion: story.version,
          title,
          theme: story.revision!.theme,
          paragraphs,
          reviewResolutions,
          notes: story.revision!.notes ?? [],
        },
        { headers: { "X-CSRF-Token": csrf, "Idempotency-Key": key } },
      )
    ).data;
  },
  async open(
    projectId: string,
    kind: "withdraw" | "export" | "delete",
    expectedBindingVersion: number,
    key: string,
    csrf: string,
    purpose?: "collection" | "ai" | "sharing",
  ) {
    return (
      await client.post<ApiResponse<CareCase>>(
        `/projects/${projectId}/care-requests`,
        { kind, expectedBindingVersion, ...(purpose ? { purpose } : {}) },
        { headers: { "X-CSRF-Token": csrf, "Idempotency-Key": key } },
      )
    ).data;
  },
  async verify(care: CareCase, evidenceRef: string, key: string, csrf: string) {
    return (
      await client.post<ApiResponse<{ state: string }>>(
        `/care-requests/${care.id}/verify`,
        {
          noticeVersion: "synthetic-d08-v1",
          evidenceRef,
          expectedBindingVersion: care.sourceBindingVersion,
          expectedAccessEpoch: care.sourceAccessEpoch,
        },
        { headers: { "X-CSRF-Token": csrf, "Idempotency-Key": key } },
      )
    ).data;
  },
  async list() {
    return (
      await client.get<ApiResponse<{ requests: CareCase[] }>>("/care-requests")
    ).data;
  },
  async read(id: string) {
    return (await client.get<ApiResponse<CareCase>>(`/care-requests/${id}`))
      .data;
  },
  async rebind(care: CareCase, evidenceRef: string, key: string, csrf: string) {
    return (
      await client.post<
        ApiResponse<{ bindingVersion: number; accessEpoch: number }>
      >(
        `/projects/${care.projectId}/rebind`,
        {
          supportCaseRef: `record:${care.id}`,
          targetUserId: care.targetUserId,
          expectedBindingVersion: care.sourceBindingVersion,
          noticeVersion: "synthetic-d08-v1",
          evidenceRef,
        },
        { headers: { "X-CSRF-Token": csrf, "Idempotency-Key": key } },
      )
    ).data;
  },
};

import type { ProductionTaskView } from "@timenook/contracts";
export const tasksApi = {
  async list() {
    return (await client.get<ApiResponse<ProductionTaskView[]>>("/tasks")).data;
  },
  async retry(task: ProductionTaskView, key: string, csrf: string) {
    return (
      await client.post<ApiResponse<ProductionTaskView>>(
        `/projects/${task.projectId}/tasks/${task.id}/retry`,
        {},
        { headers: { "X-CSRF-Token": csrf, "Idempotency-Key": key } },
      )
    ).data;
  },
};

import type {
  FirstCopyBinding,
  FirstCopyApprovalView,
  FulfillmentView,
  FulfillmentAttemptCommand,
  FulfillmentReceiptCommand,
  FulfillmentShippingCommand,
  FulfillmentDeliveryCommand,
  FulfillmentMaterials,
} from "@timenook/contracts";
export const fulfillmentApi = {
  async list() {
    return (await client.get<ApiResponse<FulfillmentView[]>>("/fulfillment"))
      .data;
  },
  async read(orderId: string) {
    return (
      await client.get<ApiResponse<FulfillmentView>>(`/fulfillment/${orderId}`)
    ).data;
  },
  async approve(
    orderId: string,
    input: FirstCopyBinding,
    key: string,
    csrf: string,
  ) {
    return (
      await client.post<ApiResponse<FirstCopyApprovalView>>(
        `/first-copy/${orderId}/approve`,
        input,
        { headers: { "X-CSRF-Token": csrf, "Idempotency-Key": key } },
      )
    ).data;
  },
  async attempt(
    orderId: string,
    input: FulfillmentAttemptCommand,
    key: string,
    csrf: string,
  ) {
    return (
      await client.post<ApiResponse<FulfillmentView>>(
        `/fulfillment/${orderId}/attempts`,
        input,
        { headers: { "X-CSRF-Token": csrf, "Idempotency-Key": key } },
      )
    ).data;
  },
  async command(
    orderId: string,
    attemptId: string,
    action: "handoff" | "receipt" | "cancel" | "shipping" | "delivery",
    input:
      | {}
      | FulfillmentReceiptCommand
      | FulfillmentShippingCommand
      | FulfillmentDeliveryCommand,
    key: string,
    csrf: string,
  ) {
    return (
      await client.post<ApiResponse<FulfillmentView>>(
        `/fulfillment/${orderId}/attempts/${attemptId}/${action}`,
        input,
        { headers: { "X-CSRF-Token": csrf, "Idempotency-Key": key } },
      )
    ).data;
  },
  async materials(orderId: string, attemptId: string, csrf: string) {
    return (
      await client.get<ApiResponse<FulfillmentMaterials>>(
        `/fulfillment/${orderId}/attempts/${attemptId}/materials`,
        { headers: { "X-CSRF-Token": csrf } },
      )
    ).data;
  },
  async pdf(orderId: string, attemptId: string, csrf: string) {
    const response = await fetch(
      `/api/v1/admin/fulfillment/${orderId}/attempts/${attemptId}/pdf`,
      {
        credentials: "same-origin",
        cache: "no-store",
        headers: { "X-CSRF-Token": csrf },
      },
    );
    if (!response.ok)
      throw await response
        .json()
        .catch(() => ({ error: { code: "UNAVAILABLE" } }));
    return response.arrayBuffer();
  },
};
