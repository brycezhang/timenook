import type {
  OrderRefundsView,
  RefundReason,
  RefundView,
} from "../../packages/contracts/src";
import { sessionClient } from "./session";
export const refundClient = {
  list: (id: string) =>
    sessionClient.request<OrderRefundsView>(
      `/orders/${encodeURIComponent(id)}/refunds`,
    ),
  request: (
    id: string,
    reason: RefundReason,
    description: string,
    key: string,
  ) =>
    sessionClient.request<RefundView>(
      `/orders/${encodeURIComponent(id)}/refunds`,
      { data: { reason, evidenceRef: `synthetic:${description}` }, key },
    ),
};
