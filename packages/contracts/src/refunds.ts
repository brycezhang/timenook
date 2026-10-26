export const REFUND_REASONS = [
  "notParticipated",
  "usedNotProduced",
  "inProduction",
  "platformUnableDeliver",
  "qualityDamaged",
  "qualityMissingPages",
  "qualityWrongVersion",
  "qualityLayoutError",
] as const;
export type RefundReason = (typeof REFUND_REASONS)[number];
export const REFUND_REASON_LABELS: Record<RefundReason, string> = {
  notParticipated: "尚未参与",
  usedNotProduced: "已经使用，尚未投产",
  inProduction: "已投产",
  platformUnableDeliver: "平台无法交付",
  qualityDamaged: "收到的书破损",
  qualityMissingPages: "收到的书漏页",
  qualityWrongVersion: "收到的书版本错误",
  qualityLayoutError: "平台排版错误",
};
export const REFUND_STATE_LABELS: Record<RefundView["state"], string> = {
  requested: "待客服核验",
  approved: "已批准，待执行",
  unknown: "退款结果待核实",
  processing: "退款处理中",
  abnormal: "退款异常，待客服核实",
  succeeded: "已退款",
  closed: "退款已关闭",
  rejected: "申请已结束",
};
export interface RefundRule {
  refundAmount: { value: number; unit: "fen" };
  requestWindow: {
    duration: { value: number; unit: "calendar_days" };
    startsAt: string;
  };
  processing: {
    within: { value: number; unit: "calendar_days" };
    startsAt: "verified_refund_request";
  };
  remedy: "refund" | "reprint_or_refund" | "resend_or_refund";
  entitlementEffect: {
    creation: "retain" | "suspend" | "terminate";
    firstCopy: "retain" | "cancel" | "consumed" | "quality_remedy";
  };
  productionAction:
    | "none"
    | "check_and_stop_if_possible"
    | "remedy_original_order"
    | "already_produced";
  policyRef: string;
  ownerRef: string;
}
export interface RefundView {
  id: string;
  caseId: string;
  orderId: string;
  projectId: string;
  reason: RefundReason;
  state:
    | "requested"
    | "approved"
    | "unknown"
    | "processing"
    | "abnormal"
    | "succeeded"
    | "closed"
    | "rejected";
  amountFen: number | null;
  outRefundNo: string;
  approvedBy: string | null;
  createdAt: string;
  approvedAt: string | null;
  dueAt: string | null;
  completedAt: string | null;
  rule: RefundRule | null;
  deleteData: false;
  productionReviewRequired: boolean;
  requestDescription: string;
  productionAttemptId: string | null;
}
export interface OrderRefundsView {
  orderId: string;
  paidAmountFen: number;
  refundedAmountFen: number;
  reservedAmountFen: number;
  availableAmountFen: number;
  productionFrozen: boolean;
  creationState: string;
  refunds: RefundView[];
}
