import { RequestClient } from "@vben/request";
import type {
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
