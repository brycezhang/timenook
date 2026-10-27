import type {
  OrderRefundsView,
  RefundReason,
  RefundView,
} from "../../../packages/contracts/src";
import {
  REFUND_REASON_LABELS,
  REFUND_STATE_LABELS,
} from "../../../packages/contracts/src";
import { refundClient } from "../../services/refunds";
import { paymentKey } from "../../services/payments";
import { sessionClient } from "../../services/session";
import { dataMode } from "../../services/mode";
type Row = RefundView & {
  stateLabel: string;
  reasonLabel: string;
  amountLabel: string;
  dueLabel: string;
  completedLabel: string;
};
function dateLabel(iso: string | null) {
  if (!iso) return "";
  const at = new Date(Date.parse(iso) + 8 * 3600000);
  if (!Number.isFinite(at.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getUTCFullYear()}年${pad(at.getUTCMonth() + 1)}月${pad(at.getUTCDate())}日 ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}（北京时间）`;
}
type E = {
  currentTarget: { dataset: { reason?: RefundReason } };
  detail: { value: string };
};
Page({
  data: {
    view: null as OrderRefundsView | null,
    rows: [] as Row[],
    busy: false,
    status: "",
    description: "",
    reason: "notParticipated" as RefundReason,
    options: (
      [
        "notParticipated",
        "usedNotProduced",
        "inProduction",
        "platformUnableDeliver",
      ] as RefundReason[]
    ).map((reason) => ({ reason, label: REFUND_REASON_LABELS[reason] })),
  },
  orderId: "",
  generation: 0,
  active: false,
  stopWatch: undefined as (() => void) | undefined,
  intent: null as { input: string; key: string } | null,
  onLoad(query) {
    this.orderId = query.orderId ?? "";
  },
  onHide() {
    this.active = false;
    ++this.generation;
    this.stopWatch?.();
    this.stopWatch = undefined;
    this.intent = null;
    this.setData({ view: null, rows: [], busy: false, description: "" });
  },
  onUnload() {
    this.onHide();
  },
  async onShow() {
    this.active = true;
    this.stopWatch?.();
    this.stopWatch = sessionClient.onInvalidated(() => {
      this.onHide();
      this.setData({ status: "登录已失效，请重新登录后查看。" });
    });
    return this.refresh();
  },
  current(generation: number, owner: string) {
    return (
      this.active &&
      dataMode() === "live" &&
      generation === this.generation &&
      !!owner &&
      owner === sessionClient.context()
    );
  },
  async refresh() {
    if (this.data.busy) return;
    const generation = ++this.generation,
      owner = sessionClient.context();
    this.setData({ busy: true, status: "", view: null, rows: [] });
    try {
      if (dataMode() !== "live" || !this.orderId)
        throw new Error("请从已付款订单打开退款申请。");
      const view = await refundClient.list(this.orderId);
      if (!this.current(generation, owner)) return;
      this.show(view);
    } catch (error) {
      if (this.current(generation, owner))
        this.setData({
          status:
            error instanceof Error ? error.message : "未能查询，请稍后重试。",
        });
    } finally {
      if (this.current(generation, owner)) this.setData({ busy: false });
    }
  },
  show(view: OrderRefundsView) {
    this.setData({
      view,
      rows: view.refunds.map((row) => ({
        ...row,
        stateLabel: REFUND_STATE_LABELS[row.state],
        reasonLabel: REFUND_REASON_LABELS[row.reason],
        amountLabel:
          row.amountFen === null
            ? "待核验"
            : `¥${(row.amountFen / 100).toFixed(2)}`,
        dueLabel: dateLabel(row.dueAt),
        completedLabel: dateLabel(row.completedAt),
      })),
    });
  },
  chooseReason(e: E) {
    if (!this.data.busy && e.currentTarget.dataset.reason)
      this.setData({ reason: e.currentTarget.dataset.reason });
  },
  descriptionInput(e: E) {
    this.setData({ description: e.detail.value });
  },
  async apply() {
    if (this.data.busy || !this.data.view) return;
    const description = this.data.description.trim();
    if (description.length < 3 || description.length > 150) {
      this.setData({ status: "请填写3到150字的申请说明。" });
      return;
    }
    const input = JSON.stringify({ reason: this.data.reason, description });
    if (this.intent?.input !== input)
      this.intent = { input, key: paymentKey() };
    const generation = this.generation,
      owner = sessionClient.context();
    this.setData({ busy: true, status: "" });
    try {
      await refundClient.request(
        this.orderId,
        this.data.reason,
        description,
        this.intent.key,
      );
      if (!this.current(generation, owner)) return;
      const view = await refundClient.list(this.orderId);
      if (!this.current(generation, owner)) return;
      this.show(view);
      this.intent = null;
      this.setData({
        description: "",
        status: "申请已提交，请在此查看客服处理进展。",
      });
    } catch (error) {
      if (this.current(generation, owner))
        this.setData({
          status:
            error instanceof Error
              ? error.message
              : "申请结果未确认，请重新查询或重试。",
        });
    } finally {
      if (this.current(generation, owner)) this.setData({ busy: false });
    }
  },
});
