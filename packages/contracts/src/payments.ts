import type { ProjectPlan } from "./index";
export interface PaymentOrderView {
  id: string;
  outTradeNo: string;
  amount: 99900;
  currency: "CNY";
  mode: "local-verification";
  state: "pending" | "paid" | "closed";
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
    subject: { id: string; name: string | null; consent: "not_granted" };
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
  packageVersionId: string;
  recipient: { typeCode?: string; relationshipLabel?: string };
  shippingRegionCode: string;
  subjectName?: string;
  bookTitle?: string;
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
