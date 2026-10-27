import type { FirstCopyBinding } from "./books";
export const QUALITY_REASONS = [
  "qualityDamaged",
  "qualityMissingPages",
  "qualityWrongVersion",
  "qualityLayoutError",
] as const;
export type QualityReason = (typeof QUALITY_REASONS)[number];
export interface QualityRequestCommand {
  attemptId: string;
  reason: QualityReason;
  description: string;
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
  projectId: string;
  reason: QualityReason;
  state: "requested";
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
}
export interface OrderQualityView {
  orderId: string;
  attempts: QualityAttemptOption[];
  requests: QualityRequestView[];
}
