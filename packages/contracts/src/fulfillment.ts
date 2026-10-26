import type { FirstCopyAddress, FirstCopyBinding } from "./books";
export type FulfillmentState =
  | "approved"
  | "handoff_pending"
  | "in_production"
  | "shipped"
  | "delivered"
  | "cancellation_pending"
  | "cancelled";
export interface FulfillmentWechat {
  handling: "implemented_and_verified";
  evidenceRef: string;
  result: "recorded" | "pending" | "failed";
}
export interface FulfillmentAttemptView extends FirstCopyBinding {
  id: string;
  sequence: number;
  handoffId: string;
  state: FulfillmentState;
  caseId: string;
  ownerAdminId: string;
  dueAt: string;
  supplierRef: string;
  receiptRef: string | null;
  tracking: { carrier: string; number: string; shippedAt: string } | null;
  wechat: FulfillmentWechat | null;
  deliveredAt: string | null;
  grantExpiresAt: string | null;
  cancellationNotice: string;
}
export interface FulfillmentView {
  projectId: string;
  orderId: string | null;
  entitlementState: string | null;
  approvedSupplierRef: string | null;
  reservation: FirstCopyBinding | null;
  accessExpiresAt: string | null;
  grantMaxMinutes: 30;
  canGrantNarrator: boolean;
  attempts: FulfillmentAttemptView[];
  current: FulfillmentAttemptView | null;
  creation: { state: string; expiresAt: string | null };
  serviceTerms: {
    playback: {
      startsAt: string | null;
      expiresAt: string | null;
      state: string;
    } | null;
  };
  canGrant: boolean;
}
export interface FulfillmentGrantCommand extends FirstCopyBinding {
  attemptId: string;
  expiresAt: string;
  noticeVersion: "synthetic-d08-v1";
  evidenceRef: string;
  assistedSessionId?: string;
}
export interface FulfillmentAttemptCommand extends FirstCopyBinding {
  supplierRef: string;
  dueAt: string;
}
export interface FulfillmentReceiptCommand {
  outcome: "accepted" | "unknown" | "cancelled" | "cancellation_rejected";
  evidenceRef: string;
}
export interface FulfillmentShippingCommand {
  carrier: string;
  number: string;
  shippedAt: string;
  evidenceRef: string;
  wechat: FulfillmentWechat;
}
export interface FulfillmentDeliveryCommand {
  deliveredAt: string;
  evidenceRef: string;
}
export interface FulfillmentMaterials {
  address: FirstCopyAddress;
  pdf: { sha256: string; bytes: number };
  grantExpiresAt: string;
  handoffId: string;
}
