import type {
  OrderQualityView,
  QualityRequestView,
  QualityRequestCommand,
  QualityAccessCommand,
} from "../../packages/contracts/src";
import { sessionClient } from "./session";
export { qualityReasonLabels, qualityStateLabels } from "./quality-labels";
function path(id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw Error("请从原订单打开质量售后");
  return `/orders/${id}/quality-care`;
}
export const qualityClient = {
  async list(id: string) {
    const view = await sessionClient.request<OrderQualityView>(path(id));
    if (
      !view ||
      view.orderId !== id ||
      !Array.isArray(view.attempts) ||
      !Array.isArray(view.requests)
    )
      throw Error("售后状态无效，请重新查询");
    return view;
  },
  request(id: string, body: QualityRequestCommand, key: string) {
    return sessionClient.request<QualityRequestView>(path(id), {
      data: { ...body },
      key,
    });
  },
  access(
    id: string,
    requestId: string,
    body: QualityAccessCommand,
    key: string,
  ) {
    return sessionClient.request<QualityRequestView>(
      `${path(id)}/${requestId}/access`,
      { data: { ...body }, key },
    );
  },
  refund(id: string, requestId: string, expectedVersion: number, key: string) {
    return sessionClient.request<QualityRequestView>(
      `${path(id)}/${requestId}/refund`,
      { data: { expectedVersion }, key },
    );
  },
};
