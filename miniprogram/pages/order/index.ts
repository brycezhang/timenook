import { switchProjectTab } from "../../services/navigation";
import { sessionClient } from "../../services/session";
import { paymentClient } from "../../services/payments";
import type { PaymentOrderView } from "../../../packages/contracts/src";
import { go } from "../../services/store";
Page({
  data: {
    activeOrder: null as PaymentOrderView | null,
    bookTitle: "",
    packagePrice: "",
    title: "确认付款结果",
    unknown: false,
    paymentError: "",
    loading: false,
    busy: false,
    loginVisible: false,
  },
  orderGeneration: 0,
  selectedOrderId: "",
  ownerContext: "",
  onLoad(q) {
    this.selectedOrderId = q.id ?? "";
    try {
      this.setData({ bookTitle: decodeURIComponent(q.bookTitle ?? "") });
    } catch {
      /* Server title is loaded below. */
    }
  },
  onShow() {
    if (!this.data.busy) return this.restoreOrders();
  },
  onHide() {
    if (!this.data.busy) ++this.orderGeneration;
  },
  onUnload() {
    ++this.orderGeneration;
  },
  async restoreOrders() {
    const generation = ++this.orderGeneration,
      context = sessionClient.context();
    if (!context) {
      this.setData({ activeOrder: null, loginVisible: true, loading: false });
      return;
    }
    if (this.ownerContext && context !== this.ownerContext)
      this.setData({ activeOrder: null, bookTitle: "", packagePrice: "" });
    this.ownerContext = context;
    const current = () =>
      generation === this.orderGeneration &&
      context === sessionClient.context();
    this.setData({ loading: true, paymentError: "" });
    try {
      let id = this.selectedOrderId;
      if (!id) id = (await paymentClient.list())[0]?.id ?? "";
      if (!current()) return;
      if (!id) {
        this.setData({ title: "我的订单", paymentError: "暂无购买记录" });
        return;
      }
      this.selectedOrderId = id;
      const order = await paymentClient.get(id);
      if (current()) this.showOrder(order);
    } catch (e) {
      if (current())
        this.setData({
          unknown: true,
          title: "确认付款结果",
          paymentError:
            e instanceof Error ? e.message : "付款结果未确认，请稍后查询原单",
        });
    } finally {
      if (current()) this.setData({ loading: false });
    }
  },
  showOrder(order: PaymentOrderView) {
    this.setData({
      activeOrder: order,
      bookTitle: order.bookTitle,
      packagePrice: (order.listAmount / 100).toFixed(2),
      unknown: order.paymentStatus === "unknown",
      title:
        order.state === "paid"
          ? "购买成功"
          : order.state === "closed"
            ? "订单已关闭"
            : order.paymentStatus === "unknown"
              ? "确认付款结果"
              : "待付款",
    });
    if (
      order.state === "paid" &&
      order.purchaseKind === "self" &&
      order.project
    )
      switchProjectTab("home", order.project.id);
  },
  async retryPayment() {
    const order = this.data.activeOrder;
    if (
      !order ||
      order.state !== "pending" ||
      this.data.busy ||
      this.data.loading ||
      this.data.unknown
    )
      return;
    const context = sessionClient.context(),
      generation = this.orderGeneration;
    const current = () =>
      context === sessionClient.context() &&
      generation === this.orderGeneration;
    this.setData({ busy: true, paymentError: "" });
    try {
      const result = await paymentClient.pay(order.id, {
        localOnly: false,
        isCurrent: current,
      });
      if (current()) this.showOrder(result);
    } catch (e) {
      if (current())
        this.setData({
          unknown: true,
          title: "确认付款结果",
          paymentError:
            e instanceof Error ? e.message : "付款结果未确认，请查询原单",
        });
    } finally {
      if (current()) this.setData({ busy: false });
    }
  },
  loginSucceeded() {
    this.setData({ loginVisible: false });
    return this.restoreOrders();
  },
  closeLogin() {
    this.setData({ loginVisible: false });
  },
  gifts() {
    go("projects");
  },
  catalog() {
    go("new-book");
  },
  giftRecipient() {
    const order = this.data.activeOrder;
    if (
      order?.state === "paid" &&
      order.project &&
      order.purchaseKind === "gift"
    )
      go("gift-recipient", `projectId=${order.project.id}`);
  },
  project() {
    const project = this.data.activeOrder?.project;
    if (project) switchProjectTab("home", project.id);
  },
});
