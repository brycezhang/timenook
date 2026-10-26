import { RequestClient } from "@vben/request";
import type {
  StoryView,
  AdminAuditEntry,
  AdminEnrollment,
  AdminLoginCommand,
  AdminMfaCommand,
  AdminRuntime,
  AdminState,
  ApiResponse,
} from "@timenook/contracts";
// Same-origin public path; credentials never enter browser storage or JS.
const client = new RequestClient({
  baseURL: "/timenook/v1/admin",
  withCredentials: true,
});
import type { CompleteExportView } from "@timenook/contracts";
export const completeExportApi = {
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
    const r = await fetch(
      `/timenook/v1/admin/care-requests/${id}/export/download`,
      { credentials: "same-origin", cache: "no-store" },
    );
    if (!r.ok)
      throw await r.json().catch(() => ({ error: { code: "UNAVAILABLE" } }));
    return r.arrayBuffer();
  },
};
client.addResponseInterceptor({ fulfilled: (response) => response.data });
export const adminApi = {
  async session() {
    return (await client.get<ApiResponse<AdminState>>("/session")).data;
  },
  async login(username: string, password: string, csrf: string) {
    return (
      await client.post<ApiResponse<AdminState>>(
        "/login",
        { username, password } satisfies AdminLoginCommand,
        { headers: { "X-CSRF-Token": csrf } },
      )
    ).data;
  },
  async enrollment() {
    return (await client.get<ApiResponse<AdminEnrollment>>("/mfa/enrollment"))
      .data;
  },
  async mfa(code: string, csrf: string) {
    return (
      await client.post<ApiResponse<AdminState>>(
        "/mfa",
        { code } satisfies AdminMfaCommand,
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

export interface ServiceTermsView {
  policyStatus: string;
  creation?: {
    state: string;
    startsAt: string | null;
    expiresAt: string | null;
  };
  playback?: { state: string; expiresAt: string | null };
  exportRequests?: { state: string; expiresAt: string | null };
  notStarted?: { reviewAt: string; action: string };
}
export const serviceTermsApi = {
  async read(projectId: string) {
    return (
      await client.get<ApiResponse<ServiceTermsView>>(
        `/service-terms/${projectId}`,
      )
    ).data;
  },
  async pause(
    projectId: string,
    action: "pause" | "resume",
    supportCaseRef: string,
    key: string,
    csrf: string,
  ) {
    return (
      await client.post<ApiResponse<ServiceTermsView>>(
        `/service-terms/${projectId}/pause`,
        { action, supportCaseRef },
        { headers: { "X-CSRF-Token": csrf, "Idempotency-Key": key } },
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
  ) {
    return (
      await client.post<ApiResponse<CareCase>>(
        `/projects/${projectId}/care-requests`,
        { kind, expectedBindingVersion },
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
      `/timenook/v1/admin/fulfillment/${orderId}/attempts/${attemptId}/pdf`,
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
