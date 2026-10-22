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
