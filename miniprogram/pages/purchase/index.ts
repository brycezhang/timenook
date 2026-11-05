import { API_BASE_URL, PAYMENT_VERIFICATION_BUILD } from "../../config";
import { ApiFailure, sessionClient } from "../../services/session";
import { paymentClient, paymentKey } from "../../services/payments";
import type {
  CreateOrderCommand,
  PaymentOrderView,
} from "../../../packages/contracts/src";
import type {
  RecipientType,
  PackageTerm,
  RecipientSelection,
} from "../../../packages/contracts/src";
import { readCatalog } from "../../services/catalog";
import { type Recipient } from "../../domain/model";
import { go, home, start, toast } from "../../services/store";
import { dataMode } from "../../services/mode";
type E = {
  currentTarget: { dataset: Record<string, string> };
  detail: { value: string };
};
Page({
  data: {
    mode: dataMode(),
    localVerification: PAYMENT_VERIFICATION_BUILD,
    packageVersionId: "",
    shippingRegionCode: "",
    shippingRegionLabel: "",
    verificationBusy: false,
    verificationError: "",
    hasOrderIntent: false,
    restoredOrder: null as PaymentOrderView | null,
    loading: false,
    catalogError: "",
    recipientTypes: [] as RecipientType[],
    packagePrice: "",
    actualPrice: "",
    isE2e: false,
    purchasable: false,
    shippingRegions: [] as { code: string; label: string }[],
    packageTerms: [] as PackageTerm[],
    packageTitle: "",
    availability: "套餐准备中，暂未开放购买",
    selectedLabel: "",
    selection: null as RecipientSelection | null,
    customLabelValue: "",

    recipient: "妈妈" as Recipient,
    agreed: false,
    bookImage: "/assets/book.jpg",
  },
  onLoad(q) {
    if (dataMode() === "live") {
      try {
        this.requestedRecipient = decodeURIComponent(q.recipient ?? "");
      } catch {
        this.requestedRecipient = "";
      }
      this.setData({ mode: "live" });
      return;
    }
    // Native onLoad keeps the encoded query; the browser preview decodes it.
    const recipient =
      q.recipient === "爸爸" || q.recipient === encodeURIComponent("爸爸")
        ? "爸爸"
        : "妈妈";
    this.setData({
      recipient,
      bookImage:
        recipient === "爸爸" ? "/assets/father-book.jpg" : "/assets/book.jpg",
    });
  },
  catalogGeneration: 0,
  requestedRecipient: "",
  orderOwnerContext: "",
  onHide() {
    ++this.catalogGeneration;
  },
  onUnload() {
    ++this.catalogGeneration;
  },
  async onShow() {
    const generation = ++this.catalogGeneration;
    const mode = dataMode();
    const context = sessionClient.context();
    const current = () =>
      generation === this.catalogGeneration &&
      mode === "live" &&
      dataMode() === "live" &&
      context === sessionClient.context();
    const storageKey = `timenook.payment-intent.v1:${API_BASE_URL}:${context.split(":")[0]}`;
    const intent = context ? wx.getStorageSync(storageKey) : null;
    this.orderOwnerContext = context;
    this.setData({
      mode,
      agreed: false,
      shippingRegionCode: "",
      shippingRegionLabel: "",
      packageVersionId: "",
      availability: "套餐准备中，暂未开放购买",
      loading: false,
      catalogError: "",
      recipientTypes: [],
      packagePrice: "",
      actualPrice: "",
      isE2e: false,
      purchasable: false,
      shippingRegions: [],
      packageTerms: [],
      packageTitle: "",
      selection: null,
      selectedLabel: "",
      customLabelValue: "",
      verificationBusy: false,
      verificationError: "",
      hasOrderIntent: !!intent,
      restoredOrder: null,
    });
    if (mode !== "live") return;
    this.setData({
      loading: true,
      catalogError: "",
      recipientTypes: [],
      packagePrice: "",
      actualPrice: "",
      isE2e: false,
      purchasable: false,
      shippingRegions: [],
      packageTerms: [],
      packageTitle: "",
      selection: null,
      selectedLabel: "",
      customLabelValue: "",
    });
    try {
      const { recipients, offer } = await readCatalog();
      if (!current()) return;
      this.setData({
        recipientTypes: recipients.types,
        packageVersionId: offer.version?.id ?? "",
        packageTitle: offer.version?.title ?? "",
        packagePrice: offer.version
          ? (offer.version.price.value / 100).toFixed(2)
          : "",
        packageTerms: offer.version?.terms ?? [],
        shippingRegions: offer.version?.shippingRegions ?? [],
        purchasable: offer.purchasable,
        actualPrice: offer.checkout
          ? (offer.checkout.amount / 100).toFixed(2)
          : "",
        isE2e: offer.checkout?.isE2e ?? false,
        availability: offer.purchasable
          ? "制作、回听与下载长期有效"
          : "套餐准备中，暂未开放购买",
      });
      const recipient = recipients.types.find(
        (item) => item.label === this.requestedRecipient,
      );
      if (recipient)
        this.chooseType({
          currentTarget: { dataset: { code: recipient.code } },
          detail: { value: "" },
        });
      else if (this.requestedRecipient)
        this.customLabel({
          currentTarget: { dataset: {} },
          detail: { value: this.requestedRecipient },
        });
    } catch (error) {
      if (current())
        this.setData({
          catalogError:
            error instanceof Error ? error.message : "套餐加载失败，请稍后重试",
        });
    } finally {
      if (generation === this.catalogGeneration && dataMode() === "live")
        this.setData({
          loading: false,
          ...(context !== sessionClient.context()
            ? {
                purchasable: false,
                actualPrice: "",
                isE2e: false,
                catalogError: "登录状态已变化，请重新加载套餐",
              }
            : {}),
        });
    }
    if (intent?.orderId && current()) {
      try {
        const restoredOrder = await paymentClient.get(intent.orderId);
        if (current())
          this.setData({
            restoredOrder,
            actualPrice: (restoredOrder.amount / 100).toFixed(2),
            isE2e: restoredOrder.isE2e,
          });
      } catch {
        if (current())
          this.setData({
            verificationError: "原订单结果暂未查明，请重新查询，勿重复下单",
          });
      }
    }
  },
  chooseType(e: E) {
    const item = this.data.recipientTypes.find(
      (item) => item.code === e.currentTarget.dataset.code,
    );
    if (!item || dataMode() !== "live") return;
    this.setData({
      selection: {
        recipientCode: item.code,
        recipientRevision: item.revision,
        customLabel: null,
      },
      selectedLabel: item.label,
      customLabelValue: "",
    });
  },
  customLabel(e: E) {
    const label = e.detail.value.trim();
    if (dataMode() !== "live") return;
    if (!label || label.length > 40 || /[\u0000-\u001f<>]/.test(label)) {
      this.setData({
        selection: null,
        selectedLabel: "",
        customLabelValue: e.detail.value,
      });
      return;
    }
    this.setData({
      selection: {
        recipientCode: null,
        recipientRevision: null,
        customLabel: label,
      },
      selectedLabel: label,
      customLabelValue: e.detail.value,
    });
  },
  choose(e: E) {
    const recipient = e.currentTarget.dataset.recipient as Recipient;
    this.setData({
      recipient,
      bookImage:
        recipient === "爸爸" ? "/assets/father-book.jpg" : "/assets/book.jpg",
    });
  },
  agree() {
    this.setData({ agreed: !this.data.agreed });
  },
  privacy() {
    go("service", "kind=terms");
  },
  chooseShippingRegion(e: E) {
    const region = this.data.shippingRegions[Number(e.detail.value)];
    if (region)
      this.setData({
        shippingRegionCode: region.code,
        shippingRegionLabel: region.label,
      });
  },
  shippingRegion(e: E) {
    this.setData({ shippingRegionCode: e.detail.value.trim() });
  },
  orders() {
    const order = this.data.restoredOrder;
    go("order", order ? `id=${order.id}` : "");
  },
  async newPurchase() {
    if (
      !this.data.restoredOrder ||
      this.data.restoredOrder.state === "pending" ||
      this.data.verificationBusy
    )
      return;
    const context = sessionClient.context();
    if (!context || context !== this.orderOwnerContext) return;
    const storageKey = `timenook.payment-intent.v1:${API_BASE_URL}:${context.split(":")[0]}`;
    if (wx.getStorageSync(storageKey)?.orderId !== this.data.restoredOrder.id)
      return;
    wx.removeStorageSync(storageKey);
    await this.onShow();
  },
  // @development-only:start
  async verifyPurchase() {
    if (PAYMENT_VERIFICATION_BUILD) return this.checkout(true);
  },
  // @development-only:end
  async checkout(localOnly = false) {
    if (dataMode() !== "live" || this.data.verificationBusy) return;
    const context = sessionClient.context();
    const generation = this.catalogGeneration;
    if (!context) {
      this.setData({ verificationError: "请先在首页完成微信登录" });
      return;
    }
    const current = () =>
      context === sessionClient.context() &&
      generation === this.catalogGeneration &&
      dataMode() === "live";
    this.setData({ verificationBusy: true, verificationError: "" });
    try {
      const storageKey = `timenook.payment-intent.v1:${API_BASE_URL}:${context.split(":")[0]}`;
      let intent = wx.getStorageSync(storageKey) as
        | { key: string; command: CreateOrderCommand; orderId?: string }
        | undefined;
      const recovering = !!intent;
      if (!intent) {
        if (!localOnly && (!this.data.purchasable || !this.data.agreed))
          throw new Error("请先确认当前套餐与服务说明");
        if (
          !this.data.packageVersionId ||
          !this.data.selection ||
          !this.data.shippingRegionCode
        )
          throw new Error("请先选择赠礼称呼和配送区域");
        intent = {
          key: paymentKey(),
          command: {
            packageVersionId: this.data.packageVersionId,
            recipient: {
              ...(this.data.selection.recipientCode
                ? { typeCode: this.data.selection.recipientCode }
                : {}),
              relationshipLabel: this.data.selectedLabel,
            },
            shippingRegionCode: this.data.shippingRegionCode,
          },
        };
        // Persist before the first request: unknown network results replay this intent.
        wx.setStorageSync(storageKey, intent);
        this.setData({ hasOrderIntent: true });
      }
      const order = await (
        intent.orderId
          ? paymentClient.get(intent.orderId)
          : paymentClient.create(intent.command, intent.key)
      ).catch((error: unknown) => {
        // This create endpoint returns INVALID_REQUEST before insertion or after
        // rolling back its transaction. Other failures can still hide an order.
        if (
          !intent.orderId &&
          error instanceof ApiFailure &&
          error.status === 400 &&
          error.code === "INVALID_REQUEST" &&
          error.requestId &&
          current() &&
          wx.getStorageSync(storageKey)?.key === intent.key
        ) {
          wx.removeStorageSync(storageKey);
          this.setData({ hasOrderIntent: false, restoredOrder: null });
          throw new Error("订单未创建，请核对套餐、称呼与配送区域后重试");
        }
        throw error;
      });
      if (!current()) return;
      // Save the original order before opening WeChat, including cancelled or
      // unknown outcomes. Reentry queries this order instead of creating another.
      intent.orderId = order.id;
      wx.setStorageSync(storageKey, intent);
      this.orderOwnerContext = context;
      this.setData({ hasOrderIntent: true, restoredOrder: order });
      if (order.state === "pending" && (!recovering || localOnly))
        await paymentClient.pay(order.id, { localOnly, isCurrent: current });
      if (!current()) return;
      go("order", `id=${order.id}`);
    } catch (error) {
      if (current())
        this.setData({
          verificationError:
            error instanceof Error ? error.message : "订单核验失败，请重新查询",
        });
    } finally {
      if (current()) this.setData({ verificationBusy: false });
    }
  },
  pay() {
    if (dataMode() === "live") return this.checkout();
    if (!this.data.agreed) return;
    wx.showModal({
      title: "体验购买流程",
      content:
        "这是前端演示，不会发起微信付款。确认后将在本机建立一个故事记录项目。",
      confirmText: "创建项目",
      success: (r) => {
        if (r.confirm) {
          try {
            start(this.data.recipient);
            home("invite");
          } catch {
            toast("项目创建失败，请检查本机存储空间后重试");
          }
        }
      },
    });
  },
});
