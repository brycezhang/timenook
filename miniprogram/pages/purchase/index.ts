import { API_BASE_URL, PAYMENT_VERIFICATION_BUILD } from "../../config";
import { ApiFailure, sessionClient } from "../../services/session";
import { paymentClient, paymentKey } from "../../services/payments";
import type {
  CreateOrderCommand,
  PaymentOrderView,
} from "../../../packages/contracts/src";
import { readCurrentPackage } from "../../services/catalog";
import { go } from "../../services/navigation";
import { switchProjectTab } from "../../services/navigation";
type OrderIntent = { key: string; command: CreateOrderCommand };
const decode = (v = "") => {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
};
Page({
  data: {
    bookTitle: "",
    relationship: "",
    purchaseKind: "gift" as "self" | "gift",
    packageVersionId: "",
    packagePrice: "",
    purchasable: false,
    loading: true,
    busy: false,
    error: "",
    hasOrderIntent: false,
    restoredOrder: null as PaymentOrderView | null,
    loginVisible: false,
    localVerification: PAYMENT_VERIFICATION_BUILD,
  },
  generation: 0,
  ownerContext: "",
  onLoad(q) {
    this.setData({
      bookTitle: decode(q.bookTitle),
      relationship: decode(q.relationship),
      purchaseKind: q.purchaseKind === "self" ? "self" : "gift",
    });
  },
  storageKey(context = sessionClient.context()) {
    return `timenook.purchase-intent.v2:${API_BASE_URL}:${context.split(":")[0]}`;
  },
  async onShow() {
    if (this.data.busy) return;
    const generation = ++this.generation,
      context = sessionClient.context();
    if (this.ownerContext && this.ownerContext !== context)
      this.setData({ restoredOrder: null });
    this.ownerContext = context;
    const intent = context
      ? (wx.getStorageSync(this.storageKey(context)) as OrderIntent | undefined)
      : undefined;
    this.setData({
      loading: true,
      error: "",
      hasOrderIntent: !!intent || !!this.data.restoredOrder,
    });
    if (intent)
      this.setData({
        bookTitle: intent.command.bookTitle,
        relationship: intent.command.recipient.relationshipLabel ?? "",
        purchaseKind: intent.command.purchaseKind,
      });
    try {
      const offer = await readCurrentPackage();
      if (generation !== this.generation || context !== sessionClient.context())
        return;
      this.setData({
        packageVersionId: offer.version?.id ?? "",
        packagePrice: offer.version
          ? (offer.version.price.value / 100).toFixed(2)
          : "",
        purchasable: offer.purchasable,
      });
    } catch (e) {
      if (generation === this.generation)
        this.setData({
          error: e instanceof Error ? e.message : "套餐加载失败，请重试",
          purchasable: false,
        });
    } finally {
      if (generation === this.generation) this.setData({ loading: false });
    }
  },
  onHide() {
    if (!this.data.busy) ++this.generation;
  },
  onUnload() {
    ++this.generation;
  },
  retry() {
    void this.onShow();
  },
  loginSucceeded() {
    this.setData({ loginVisible: false });
    void this.onShow();
  },
  closeLogin() {
    this.setData({ loginVisible: false });
  },
  // @development-only:start
  verifyPurchase() {
    if (PAYMENT_VERIFICATION_BUILD) return this.checkout(true);
  },
  // @development-only:end
  pay() {
    return this.checkout(false);
  },
  async checkout(localOnly: boolean) {
    if (this.data.busy) return;
    const context = sessionClient.context();
    if (!context) {
      this.setData({ loginVisible: true });
      return;
    }
    const generation = this.generation;
    const current = () =>
      context === sessionClient.context() && generation === this.generation;
    this.setData({ busy: true, error: "" });
    let order = this.ownerContext === context ? this.data.restoredOrder : null;
    const storageKey = this.storageKey(context);
    try {
      const recovering = !!order || !!wx.getStorageSync(storageKey);
      if (!order) {
        let intent = wx.getStorageSync(storageKey) as OrderIntent | undefined;
        if (!intent) {
          if (!localOnly && !this.data.purchasable)
            throw new Error("套餐暂未开放购买");
          if (
            !this.data.packageVersionId ||
            !this.data.bookTitle.trim() ||
            !this.data.relationship.trim()
          )
            throw new Error("请返回填写关系和书名");
          intent = {
            key: paymentKey(),
            command: {
              packageVersionId: this.data.packageVersionId,
              purchaseKind: this.data.purchaseKind,
              bookTitle: this.data.bookTitle.trim(),
              recipient:
                this.data.purchaseKind === "self"
                  ? { typeCode: "self", relationshipLabel: "自己" }
                  : { relationshipLabel: this.data.relationship.trim() },
            },
          };
          wx.setStorageSync(storageKey, intent);
          this.setData({ hasOrderIntent: true });
        }
        try {
          order = await paymentClient.create(intent.command, intent.key);
        } catch (e) {
          if (
            e instanceof ApiFailure &&
            e.status === 400 &&
            e.code === "INVALID_REQUEST" &&
            e.requestId &&
            current() &&
            wx.getStorageSync(storageKey)?.key === intent.key
          ) {
            wx.removeStorageSync(storageKey);
            this.setData({ hasOrderIntent: false });
          }
          throw e;
        }
        if (!current()) return;
        if (wx.getStorageSync(storageKey)?.key === intent.key)
          wx.removeStorageSync(storageKey);
      }
      if (!current()) return;
      this.ownerContext = context;
      this.setData({ restoredOrder: order, hasOrderIntent: true });
      if (recovering) order = await paymentClient.get(order.id);
      else if (order.state === "pending")
        order = await paymentClient.pay(order.id, {
          localOnly,
          isCurrent: current,
        });
      if (!current()) return;
      this.setData({ restoredOrder: order });
      this.openResult(order);
    } catch (e) {
      if (!current()) return;
      if (order) this.openResult(order);
      else
        this.setData({
          error:
            e instanceof Error ? e.message : "订单结果未确认，请查询原购买结果",
        });
    } finally {
      if (current()) this.setData({ busy: false });
    }
  },
  openResult(order: PaymentOrderView) {
    if (
      order.state === "paid" &&
      order.purchaseKind === "self" &&
      order.project
    )
      switchProjectTab("home", order.project.id);
    else
      go(
        "order",
        `id=${order.id}&bookTitle=${encodeURIComponent(order.bookTitle)}`,
      );
  },
});
