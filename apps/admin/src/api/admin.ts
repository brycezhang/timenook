import { RequestClient } from "@vben/request";
export interface AdminState {
  authenticated: boolean;
  mfaRequired: boolean;
  enrollmentRequired: boolean;
  csrfToken: string;
  expiresAt: string;
  operator: null | { id: string; username: string; permissions: string[] };
}
export interface AuditEntry {
  id: string;
  operatorId: string | null;
  action: string;
  requestId: string;
  result: string;
  createdAt: string;
}
interface Envelope<T> {
  data: T;
  meta: { requestId: string };
}
// Same-origin public path; credentials never enter browser storage or JS.
const client = new RequestClient({
  baseURL: "/timenook/v1/admin",
  withCredentials: true,
});
client.addResponseInterceptor({ fulfilled: (response) => response.data });
export const adminApi = {
  async session() {
    return (await client.get<Envelope<AdminState>>("/session")).data;
  },
  async login(username: string, password: string, csrf: string) {
    return (
      await client.post<Envelope<AdminState>>(
        "/login",
        { username, password },
        { headers: { "X-CSRF-Token": csrf } },
      )
    ).data;
  },
  async enrollment() {
    return (await client.get<Envelope<{ secret: string }>>("/mfa/enrollment"))
      .data;
  },
  async mfa(code: string, csrf: string) {
    return (
      await client.post<Envelope<AdminState>>(
        "/mfa",
        { code },
        { headers: { "X-CSRF-Token": csrf } },
      )
    ).data;
  },
  async runtime() {
    return (
      await client.get<Envelope<{ status: string; service: string }>>(
        "/runtime",
      )
    ).data;
  },
  async audit() {
    return (await client.get<Envelope<AuditEntry[]>>("/audit")).data;
  },
  async logout(csrf: string) {
    await client.post("/logout", {}, { headers: { "X-CSRF-Token": csrf } });
  },
};
