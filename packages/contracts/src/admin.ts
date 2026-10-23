export const ADMIN_PERMISSIONS = {
  retryTasks: "tasks:retry",
  writeCare: "care:write",
  writeServiceTerms: "service-terms:write",
  readRuntime: "ops:read",
  readAudit: "audit:read",
  readCatalog: "catalog:read",
  writeCatalog: "catalog:write",
  freezeCatalog: "catalog:freeze",
} as const;

export type AdminPermission =
  (typeof ADMIN_PERMISSIONS)[keyof typeof ADMIN_PERMISSIONS];

export function isAdminPermission(value: unknown): value is AdminPermission {
  return Object.values(ADMIN_PERMISSIONS).some(
    (permission) => permission === value,
  );
}

export interface AdminLoginCommand {
  username: string;
  password: string;
}

export interface AdminMfaCommand {
  code: string;
}

export type AdminRealm = "local" | "production";

export interface AdminProvisionCommand extends AdminLoginCommand {
  realm: AdminRealm;
  permissions: AdminPermission[];
}

export interface AdminProvisionResult {
  id: string;
  realm: AdminRealm;
  mfaEnrollmentRequired: true;
}

export interface AdminOperator {
  id: string;
  username: string;
  permissions: AdminPermission[];
}

export interface AdminState {
  authenticated: boolean;
  mfaRequired: boolean;
  enrollmentRequired: boolean;
  operator: AdminOperator | null;
  csrfToken: string;
  expiresAt: string;
}

export interface AdminEnrollment {
  secret: string;
  uri: string;
}

export interface AdminRuntime {
  service: "timenook-api";
  status: "ready" | "unavailable";
}

export interface AdminAuditEntry {
  id: string;
  operatorId: string | null;
  action: string;
  requestId: string;
  result: string;
  createdAt: string;
}
