import { go, switchProjectTab } from "../../services/navigation";
import { giftContinuation } from "../../services/gifts";
import { projectOverviewClient } from "../../services/project-overview";
import { sessionClient } from "../../services/session";
import { paymentClient } from "../../services/payments";
import type { PaymentOrderView } from "../../../packages/contracts/src";
Page({
  data: {
    activeOrder: null as PaymentOrderView | null,
    bookTitle: "",
    packagePrice: "",
    title: "确认付款结果",
    unknown: false,
    paymentError: "",
    giftPage: "" as ReturnType<typeof giftContinuation>,
    giftError: "",
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
    this.setData({ giftPage: "", giftError: "" });
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
      if (current()) await this.showOrder(order, current);
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
  async showOrder(order: PaymentOrderView, current: () => boolean) {
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
    if (order.state !== "paid" || !order.project) return;
    const projectId = order.project.id;
    if (order.purchaseKind === "self") {
      switchProjectTab("home", projectId);
      return;
    }
    try {
      const { projects } = await projectOverviewClient.memberships();
      if (current())
        this.setData({
          giftPage: giftContinuation(
            projects.find((project) => project.projectId === projectId),
          ),
        });
    } catch {
      if (current()) this.setData({ giftError: "礼物状态读取失败，请重试" });
    }
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
      if (current()) await this.showOrder(result, current);
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
  continueGift() {
    const { activeOrder, giftPage } = this.data;
    if (
      activeOrder?.project &&
      giftPage &&
      this.ownerContext === sessionClient.context()
    )
      go(giftPage, `projectId=${activeOrder.project.id}`);
  },
  project() {
    const project = this.data.activeOrder?.project;
    if (project) switchProjectTab("home", project.id);
  },
});
