export const orderStateLabels: Record<string, string> = {
  pending: "待付款",
  paid: "已付款",
  refunded: "已退款",
  partially_refunded: "部分退款",
  closed: "已关闭",
};
export const orderStateLabel = (state: string): string =>
  orderStateLabels[state] ?? state;
