import type {
  PaymentOrderView,
  PreparedPayment,
  CreateOrderCommand,
  MiniPaymentParameters,
} from "../../packages/contracts/src";
import { sessionClient } from "./session";
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function uuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f-]{36}$/.test(value);
}
function order(value: unknown): value is PaymentOrderView {
  if (
    !record(value) ||
    !uuid(value.id) ||
    value.amount !== 99900 ||
    value.currency !== "CNY" ||
    !["local-verification", "wechat"].includes(String(value.mode)) ||
    !["pending", "paid", "closed"].includes(String(value.state)) ||
    !record(value.recipient) ||
    typeof value.recipient.relationshipLabel !== "string" ||
    typeof value.bookTitle !== "string"
  )
    return false;
  if (value.state !== "paid") return value.project === null;
  return (
    record(value.project) &&
    uuid(value.project.id) &&
    record(value.project.subject) &&
    uuid(value.project.subject.id) &&
    record(value.project.entitlement) &&
    uuid(value.project.entitlement.id) &&
    value.project.entitlement.copies === 1
  );
}
function validParameters(value: unknown): value is MiniPaymentParameters {
  return (
    record(value) &&
    value.signType === "RSA" &&
    typeof value.timeStamp === "string" &&
    /^\d{10}$/.test(value.timeStamp) &&
    typeof value.nonceStr === "string" &&
    value.nonceStr.length <= 32 &&
    typeof value.package === "string" &&
    value.package.startsWith("prepay_id=") &&
    typeof value.paySign === "string" &&
    value.paySign.length > 0
  );
}
export const paymentKey = () =>
  `mp_${Date.now()}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`;
export const paymentClient = {
  async create(command: CreateOrderCommand, key: string) {
    const result = await sessionClient.request<unknown>("/orders", {
      data: { ...command },
      key,
    });
    if (!order(result)) throw new Error("订单结果无效，请重新查询");
    return result;
  },
  async pay(
    id: string,
    options: { localOnly: boolean; isCurrent: () => boolean },
  ) {
    const context = sessionClient.context();
    try {
      const prepared = await sessionClient.request<PreparedPayment>(
        `/orders/${id}/payment`,
        { data: {}, key: paymentKey() },
      );
      if (context !== sessionClient.context() || !options.isCurrent())
        throw new Error("页面或账号已切换");
      if (
        prepared.mode === "wechat" &&
        !options.localOnly &&
        prepared.status === "prepared" &&
        validParameters(prepared.parameters)
      ) {
        const parameters = prepared.parameters;
        await new Promise<void>((resolve) => {
          try {
            wx.requestPayment({
              ...parameters,
              success: () => resolve(),
              fail: () => resolve(),
            });
          } catch {
            resolve();
          }
        });
      }
      // local-verification never sends synthetic signatures into wx.requestPayment.
    } catch {
      /* Every known native/network outcome reconciles the original order. */
    }
    if (context !== sessionClient.context())
      throw new Error("账号已切换，请重新查询订单");
    return paymentClient.get(id);
  },
  async close(id: string) {
    const result = await sessionClient.request<unknown>(`/orders/${id}/close`, {
      data: {},
      key: paymentKey(),
    });
    if (!order(result)) throw new Error("订单结果无效，请重新查询");
    return result;
  },
  async list() {
    const result = await sessionClient.request<{ orders: unknown[] }>(
      "/orders",
    );
    if (!Array.isArray(result?.orders) || !result.orders.every(order))
      throw new Error("订单结果无效，请重新查询");
    return result.orders;
  },
  async get(id: string) {
    if (!uuid(id)) throw new Error("订单编号无效");
    const result = await sessionClient.request<unknown>("/orders/" + id);
    if (!order(result) || result.id !== id)
      throw new Error("订单结果无效，请重新查询");
    return result;
  },
};
export function paymentStatus(order: PaymentOrderView) {
  if (order.mode === "wechat")
    return order.state === "paid"
      ? "付款核验完成"
      : order.state === "closed"
        ? "订单已关闭 · 未发放权益"
        : "订单待付款核验 · 尚未发放权益";
  return order.state === "paid"
    ? "合成付款核验完成 · 未真实扣款"
    : order.state === "closed"
      ? "合成订单已关闭 · 未发放权益"
      : "合成订单待核验 · 尚未发放权益";
}
