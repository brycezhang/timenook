export const ADMIN_PERMISSIONS = {
  readOrders: "orders:read",
  writeOrders: "orders:write",
  writeFulfillment: "fulfillment:write",
  retryTasks: "tasks:retry",
  writeCare: "care:write",
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

export interface AdminFeishuLogin {
  authorizationUrl: string;
}

export type AdminRealm = "local" | "production";

export interface AdminProvisionCommand {
  username: string;
  realm: AdminRealm;
  feishuAppId: string;
  feishuOpenId: string;
  tenantKey: string;
  permissions: AdminPermission[];
}

export interface AdminProvisionResult {
  id: string;
  realm: AdminRealm;
}

export interface AdminOperator {
  id: string;
  username: string;
  permissions: AdminPermission[];
}

export interface AdminState {
  authenticated: boolean;
  loginAvailable: boolean;
  operator: AdminOperator | null;
  csrfToken: string;
  expiresAt: string;
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

export interface AdminOrderSummary {
  id: string;
  outTradeNo: string;
  buyerId: string;
  projectId: string | null;
  subjectId: string | null;
  subjectName: string | null;
  narratorUserId: string | null;
  bookTitle: string | null;
  state: string;
  mode: string;
  isE2e: boolean;
  listAmount: number;
  payableAmount: number | null;
  paidAmount: number | null;
  refundedAmount: number;
  currency: string;
  createdAt: string;
  pending: boolean;
}
export interface AdminOrderNote {
  id: string;
  content: string;
  operatorId: string;
  operatorName: string;
  createdAt: string;
}
export interface AdminOrderDetail extends AdminOrderSummary {
  payment: {
    providerTransactionId: string;
    paidAt: string;
    amount: number;
  } | null;
  entitlement: { id: string; state: string } | null;
  productionOrder: { id: string; state: string } | null;
  refunds: {
    id: string;
    caseId: string;
    state: string;
    amount: number | null;
    completedAt: string | null;
  }[];
  qualityRequests: { id: string; caseId: string; state: string }[];
  notes: AdminOrderNote[];
  history: AdminAuditEntry[];
}
export interface AdminOrdersPage {
  items: AdminOrderSummary[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AdminServiceRequestSummary {
  id: string;
  projectId: string;
  kind: string;
  state: string;
  createdAt: string;
}
export interface AdminUserSummary {
  id: string;
  kind: "account" | "narrator";
  name: string | null;
  projectId: string | null;
  createdAt: string;
  pending: boolean;
}
export interface AdminUsersPage {
  items: AdminUserSummary[];
  total: number;
  page: number;
  pageSize: number;
}
export interface AdminProjectSummary {
  id: string;
  bookTitle: string | null;
  initiatorUserId: string;
  subjectId: string | null;
  subjectName: string | null;
  narratorUserId: string | null;
  bindingVersion: number;
  orderId: string | null;
  source: "payment" | "internal-acceptance" | "unlinked";
  physicalProduction: boolean;
  pending: boolean;
}
export interface AdminProjectDetail extends AdminProjectSummary {
  requests: AdminServiceRequestSummary[];
  productionOrder: { id: string; state: string } | null;
  noticeVersion: string;
  evidencePrefix: string;
  policyStatus: string;
  exportAlternativeAvailable: boolean;
  history: AdminAuditEntry[];
}
export interface AdminUserDetail {
  id: string;
  createdAt: string;
  loginMethods: string[];
  projects: AdminProjectSummary[];
  orders: { id: string; outTradeNo: string; state: string }[];
  requests: AdminServiceRequestSummary[];
  notes: AdminOrderNote[];
  history: AdminAuditEntry[];
}
