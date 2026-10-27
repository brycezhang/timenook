import type {
  OrderQualityView,
  QualityRequestView,
  QualityRequestCommand,
  QualityAccessCommand,
} from "../../packages/contracts/src";
import { sessionClient } from "./session";
export const qualityReasonLabels = {
  qualityDamaged: "破损或装订问题",
  qualityMissingPages: "缺页或漏印",
  qualityWrongVersion: "收到的版本不符",
  qualityLayoutError: "印刷或排版问题",
};
export const qualityStateLabels = {
  requested: "待客服核验",
  assigned: "客服已领取",
  reviewed: "已核验处理方案",
  reprinting: "原订单重印处理中",
  refund_requested: "已转入退款流程",
  completed: "处理已完成",
};
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
