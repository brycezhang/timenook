import { dataMode } from "../../services/mode";
import { sessionClient } from "../../services/session";
import { paymentClient, paymentStatus } from "../../services/payments";
import type { PaymentOrderView } from "../../../packages/contracts/src";
import { type Project } from "../../domain/model";
import { asset, go, home, read } from "../../services/store";
type E = {
  currentTarget: { dataset: Record<string, string> };
  detail: { value: string };
};
Page({
  data: {
    p: null as Project | null,
    bookImage: "",
    mode: dataMode(),
    orders: [] as PaymentOrderView[],
    activeOrder: null as PaymentOrderView | null,
    paymentStatus: "",
    paymentError: "",
    loading: false,
  },
  orderGeneration: 0,
  selectedOrderId: "",
  onLoad(q) {
    this.selectedOrderId = q.id ?? "";
  },
  onHide() {
    ++this.orderGeneration;
  },
  onUnload() {
    ++this.orderGeneration;
  },
  async onShow() {
    if (dataMode() === "live") {
      await this.restoreOrders();
      return;
    }
    this.setData({ mode: "demo" });
    const p = read();
    if (!p) {
      home("home");
      return;
    }
    this.setData({ p, bookImage: asset(p) });
  },
  async restoreOrders() {
    const generation = ++this.orderGeneration;
    const context = sessionClient.context();
    this.setData({
      mode: "live",
      orders: [],
      activeOrder: null,
      paymentError: "",
      paymentStatus: "",
      loading: true,
    });
    const current = () =>
      generation === this.orderGeneration &&
      dataMode() === "live" &&
      context === sessionClient.context();
    try {
      const orders = await paymentClient.list();
      if (!current()) return;
      const id =
        orders.find((o) => o.id === this.selectedOrderId)?.id ?? orders[0]?.id;
      this.setData({ orders });
      if (id) {
        const activeOrder = await paymentClient.get(id);
        if (!current()) return;
        this.selectedOrderId = id;
        this.setData({
          activeOrder,
          paymentStatus: paymentStatus(activeOrder),
        });
      }
    } catch (error) {
      if (current())
        this.setData({
          paymentError:
            error instanceof Error ? error.message : "订单查询失败，请稍后重试",
        });
    } finally {
      if (current()) this.setData({ loading: false });
    }
  },
  async chooseOrder(e: E) {
    this.selectedOrderId = e.currentTarget.dataset.id;
    await this.restoreOrders();
  },
  async retryPayment() {
    const order = this.data.activeOrder;
    if (!order || this.data.loading) return;
    const context = sessionClient.context();
    const generation = this.orderGeneration;
    this.setData({ loading: true, paymentError: "" });
    const current = () =>
      context === sessionClient.context() &&
      generation === this.orderGeneration;
    try {
      const activeOrder = await paymentClient.pay(order.id, {
        localOnly: true,
        isCurrent: current,
      });
      if (current())
        this.setData({
          activeOrder,
          paymentStatus: paymentStatus(activeOrder),
        });
    } catch (error) {
      if (current())
        this.setData({
          paymentError: error instanceof Error ? error.message : "核验失败",
        });
    } finally {
      if (current()) this.setData({ loading: false });
    }
  },
  async closeOrder() {
    const order = this.data.activeOrder;
    if (!order || this.data.loading) return;
    const context = sessionClient.context();
    const generation = this.orderGeneration;
    this.setData({ loading: true, paymentError: "" });
    try {
      const activeOrder = await paymentClient.close(order.id);
      if (
        context === sessionClient.context() &&
        generation === this.orderGeneration
      )
        this.setData({
          activeOrder,
          paymentStatus: paymentStatus(activeOrder),
        });
    } catch (error) {
      if (
        context === sessionClient.context() &&
        generation === this.orderGeneration
      )
        this.setData({
          paymentError:
            error instanceof Error ? error.message : "关闭结果未知，请重新查询",
        });
    } finally {
      if (
        context === sessionClient.context() &&
        generation === this.orderGeneration
      )
        this.setData({ loading: false });
    }
  },
  catalog() {
    go("purchase");
  },
  invite() {
    const project = this.data.activeOrder?.project;
    if (project) go("invite", `projectId=${project.id}`);
  },
  project() {
    home();
  },
  book() {
    home("book");
  },
  support() {
    go("service", "kind=support");
  },
});
