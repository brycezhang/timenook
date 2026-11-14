import type { ProjectPlan } from "./index";
export interface PaymentOrderView {
  channelPurchase?: {
    internalNumber: string;
    externalOrderNo: string | null;
    paidAt: string | null;
    paidAmount: number | null;
    createdAt: string;
  } | null;
  purchaseKind: "self" | "gift";
  id: string;
  outTradeNo: string;
  listAmount: 99900;
  amount: number | null;
  isE2e: boolean;
  currency: "CNY";
  mode: "local-verification" | "wechat" | "channel";
  state: "pending" | "paid" | "closed";
  paymentStatus: "pending" | "unknown" | "paid" | "closed";
  packageVersionId: string;
  recipient: { typeCode: string | null; relationshipLabel: string };
  subjectName: string | null;
  bookTitle: string;
  template: {
    id: string;
    version: number;
    reviewStatus: "unreviewed-test-only";
  };
  project: null | {
    id: string;
    subject: {
      id: string;
      name: string | null;
      boundUserId: string | null;
      consent: "not_granted";
    };
    bookTitle: string;
    recipient: PaymentOrderView["recipient"];
    plan: ProjectPlan;
    entitlement: {
      id: string;
      state: "available" | "reserved" | "suspended" | "revoked";
      copies: 1;
    };
    terms: Record<string, unknown>;
  };
}
export interface CreateOrderCommand {
  purchaseKind: "self" | "gift";
  packageVersionId: string;
  recipient: { typeCode?: string; relationshipLabel?: string };
  subjectName?: string;
  bookTitle: string;
}
export interface MiniPaymentParameters {
  timeStamp: string;
  nonceStr: string;
  package: string;
  signType: "RSA";
  paySign: string;
}
export interface PreparedPayment {
  mode: "local-verification" | "wechat";
  status: "prepared" | "pending" | "unknown" | "paid" | "closed";
  parameters: MiniPaymentParameters | null;
}
