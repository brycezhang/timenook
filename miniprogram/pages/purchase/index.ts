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
type OrderIntent = {
  key: string;
  command: CreateOrderCommand;
  orderId?: string;
};

function unresolvedIntent(storageKey: string) {
  const intent = wx.getStorageSync(storageKey) as OrderIntent | undefined;
  return intent?.orderId ? undefined : intent;
}

Page({
  data: {
    mode: dataMode(),
    bookTitle: "",
    loggedIn: false,
    localVerification: PAYMENT_VERIFICATION_BUILD,
    packageVersionId: "",
    verificationBusy: false,
    verificationError: "",
    hasOrderIntent: false,
    restoredOrder: null as PaymentOrderView | null,
    loading: false,
    catalogError: "",
    recipientTypes: [] as RecipientType[],
    packagePrice: "",
    purchasable: false,
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
    const decode = (v: string) => {
      try {
        return decodeURIComponent(v);
      } catch {
        return v;
      }
    };
    this.setData({ bookTitle: decode(q.bookTitle ?? "人生故事书") });
    this.requestedRecipient = decode(q.salutation ?? "") || "我";
    if (dataMode() === "live") {
      try {
        this.requestedRecipient =
          decode(q.salutation ?? q.recipient ?? "") || "我";
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
    if (this.data.verificationBusy) return;
    ++this.catalogGeneration;
  },
  onUnload() {
    ++this.catalogGeneration;
  },
  async onShow() {
    if (this.data.verificationBusy) return;
    const generation = ++this.catalogGeneration;
    const mode = dataMode();
    const context = sessionClient.context();
    const current = () =>
      generation === this.catalogGeneration &&
      mode === "live" &&
      dataMode() === "live" &&
      context === sessionClient.context();
    const storageKey = `timenook.payment-intent.v1:${API_BASE_URL}:${context.split(":")[0]}`;
    const intent = context ? unresolvedIntent(storageKey) : undefined;
    const order =
      context === this.orderOwnerContext ? this.data.restoredOrder : null;
    this.orderOwnerContext = context;
    this.setData({
      mode,
      agreed: true,
      loggedIn: !!context,
      packageVersionId: "",
      availability: "套餐准备中，暂未开放购买",
      loading: false,
      catalogError: "",
      recipientTypes: [],
      packagePrice: "",
      purchasable: false,
      packageTerms: [],
      packageTitle: "",
      selection: null,
      selectedLabel: "",
      customLabelValue: "",
      verificationBusy: false,
      verificationError: "",
      hasOrderIntent: !!intent || !!order,
      restoredOrder: order,
    });
    if (mode !== "live") return;
    this.setData({
      loading: true,
      catalogError: "",
      recipientTypes: [],
      packagePrice: "",
      purchasable: false,
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
        purchasable: offer.purchasable,
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
                catalogError: "登录状态已变化，请重新加载套餐",
              }
            : {}),
        });
    }
    if (order && current()) {
      try {
        const restoredOrder = await paymentClient.get(order.id);
        if (current())
          this.setData({
            restoredOrder,
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
    go("terms");
  },
  orders() {
    const order = this.data.restoredOrder;
    if (order && this.orderOwnerContext === sessionClient.context())
      go("order", `id=${order.id}`);
  },
  // @development-only:start
  async verifyPurchase() {
    if (PAYMENT_VERIFICATION_BUILD) return this.checkout(true);
  },
  // @development-only:end
  login() {
    wx.redirectTo({
      url: `/pages/login/index?next=purchase&bookTitle=${encodeURIComponent(this.data.bookTitle)}&salutation=${encodeURIComponent(this.requestedRecipient)}`,
    });
  },
  async checkout(localOnly = false) {
    if (dataMode() !== "live" || this.data.verificationBusy) return;
    const context = sessionClient.context();
    const generation = this.catalogGeneration;
    if (!context) {
      this.setData({ verificationError: "请先微信登录" });
      return;
    }
    const current = () =>
      context === sessionClient.context() &&
      generation === this.catalogGeneration &&
      dataMode() === "live";
    this.setData({ verificationBusy: true, verificationError: "" });
    try {
      const storageKey = `timenook.payment-intent.v1:${API_BASE_URL}:${context.split(":")[0]}`;
      let order =
        this.orderOwnerContext === context ? this.data.restoredOrder : null;
      const savedIntent = unresolvedIntent(storageKey);
      const recovering = !!order || !!savedIntent;
      if (order) {
        order = await paymentClient.get(order.id);
      } else {
        let intent = savedIntent;
        if (!intent) {
          if (!localOnly && (!this.data.purchasable || !this.data.agreed))
            throw new Error("套餐暂未开放购买");
          if (!this.data.packageVersionId || !this.data.selection)
            throw new Error("请确认套餐与称呼后重试");
          intent = {
            key: paymentKey(),
            command: {
              packageVersionId: this.data.packageVersionId,
              bookTitle: this.data.bookTitle,
              subjectName:
                this.data.selectedLabel === "我"
                  ? undefined
                  : this.data.selectedLabel,
              recipient: {
                ...(this.data.selection.recipientCode
                  ? { typeCode: this.data.selection.recipientCode }
                  : {}),
                relationshipLabel: this.data.selectedLabel,
              },
            },
          };
          // Keep the request until the server returns the order ID.
          wx.setStorageSync(storageKey, intent);
          this.setData({ hasOrderIntent: true });
        }
        try {
          order = await paymentClient.create(intent.command, intent.key);
        } catch (error) {
          // This rejection means the server did not insert an order.
          if (
            error instanceof ApiFailure &&
            error.status === 400 &&
            error.code === "INVALID_REQUEST" &&
            error.requestId &&
            current() &&
            wx.getStorageSync(storageKey)?.key === intent.key
          ) {
            wx.removeStorageSync(storageKey);
            this.setData({ hasOrderIntent: false });
            throw new Error("订单未创建，请核对套餐与称呼后重试");
          }
          throw error;
        }
        if (!current()) return;
        // Keep this order on the current page. Pending orders can also be
        // reopened from the project list.
        if (wx.getStorageSync(storageKey)?.key === intent.key)
          wx.removeStorageSync(storageKey);
      }
      if (!current()) return;
      this.orderOwnerContext = context;
      this.setData({ hasOrderIntent: true, restoredOrder: order });
      if (order.state === "pending" && (!recovering || localOnly))
        order = await paymentClient.pay(order.id, {
          localOnly,
          isCurrent: current,
        });
      if (!current()) return;
      this.setData({ restoredOrder: order });
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
