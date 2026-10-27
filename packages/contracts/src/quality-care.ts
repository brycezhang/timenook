import type { FirstCopyBinding } from "./books";
export const QUALITY_REASONS = [
  "qualityDamaged",
  "qualityMissingPages",
  "qualityWrongVersion",
  "qualityLayoutError",
] as const;
export type QualityReason = (typeof QUALITY_REASONS)[number];
export type QualityState =
  | "requested"
  | "assigned"
  | "reviewed"
  | "reprinting"
  | "refund_requested"
  | "completed";
export type QualityScope = "pdf" | "evidence";
export interface QualityRequestCommand {
  attemptId: string;
  reason: QualityReason;
  description: string;
}
export interface QualityAssignCommand {
  expectedVersion: number;
  dueAt: string;
  evidenceRef: string;
}
export interface QualityAccessCommand {
  expectedVersion: number;
  scopes: QualityScope[];
  expiresAt: string;
  consented: true;
  noticeVersion: "synthetic-d08-v1";
  assistedSessionId?: string;
}
export interface QualityReviewCommand {
  expectedVersion: number;
  resolution: "reprint" | "refund";
  mode?: "original" | "revised";
  evidenceRef: string;
}
export interface QualityReprintCommand extends FirstCopyBinding {
  expectedVersion: number;
}
export interface QualityRefundCommand {
  expectedVersion: number;
}
export interface QualityAttemptOption extends FirstCopyBinding {
  id: string;
  sequence: number;
  bookVersion: number;
  deliveredAt: string;
  tracking: { carrier: string; number: string; shippedAt: string } | null;
}
export interface QualityRequestView {
  id: string;
  caseId: string;
  orderId: string;
  productionOrderId: string;
  projectId: string;
  version: number;
  reason: QualityReason;
  state: QualityState;
  original: FirstCopyBinding & {
    attemptId: string;
    sequence: number;
    bookVersion: number;
    deliveredAt: string | null;
    tracking: QualityAttemptOption["tracking"];
  };
  createdAt: string;
  ownerLabel: string | null;
  dueAt: string | null;
  assignedAt: string | null;
  reviewedAt: string | null;
  resolution: "reprint" | "refund" | null;
  reprintMode: "original" | "revised" | null;
  replacement?: FirstCopyBinding | null;
  grant: { expiresAt: string; scopes: QualityScope[] } | null;
  productionAttemptId: string | null;
  productionState: string | null;
  refund: { id: string; state: string } | null;
}
export interface OrderQualityView {
  orderId: string;
  attempts: QualityAttemptOption[];
  requests: QualityRequestView[];
}
export interface QualityMaterials {
  description: string | null;
  pdf: { sha256: string; bytes: number } | null;
  grantExpiresAt: string;
}
