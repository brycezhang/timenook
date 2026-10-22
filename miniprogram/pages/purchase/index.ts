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
    loading: false,
    catalogError: "",
    recipientTypes: [] as RecipientType[],
    packagePrice: "",
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
      this.setData({ mode: "live" });
      return;
    }
    const recipient = q.recipient === "爸爸" ? "爸爸" : "妈妈";
    this.setData({
      recipient,
      bookImage:
        recipient === "爸爸" ? "/assets/father-book.jpg" : "/assets/book.jpg",
    });
  },
  catalogGeneration: 0,
  onHide() {
    ++this.catalogGeneration;
  },
  onUnload() {
    ++this.catalogGeneration;
  },
  async onShow() {
    const generation = ++this.catalogGeneration;
    const mode = dataMode();
    this.setData({
      mode,
      loading: false,
      catalogError: "",
      recipientTypes: [],
      packagePrice: "",
      packageTerms: [],
      packageTitle: "",
      selection: null,
      selectedLabel: "",
      customLabelValue: "",
    });
    if (mode !== "live") return;
    this.setData({
      loading: true,
      catalogError: "",
      recipientTypes: [],
      packagePrice: "",
      packageTerms: [],
      packageTitle: "",
      selection: null,
      selectedLabel: "",
      customLabelValue: "",
    });
    try {
      const { recipients, offer } = await readCatalog();
      if (generation !== this.catalogGeneration || dataMode() !== "live")
        return;
      this.setData({
        recipientTypes: recipients.types,
        packageTitle: offer.version?.title ?? "",
        packagePrice: offer.version
          ? (offer.version.price.value / 100).toFixed(2)
          : "",
        packageTerms: offer.version?.terms ?? [],
      });
    } catch (error) {
      if (generation === this.catalogGeneration && dataMode() === "live")
        this.setData({
          catalogError:
            error instanceof Error ? error.message : "套餐加载失败，请稍后重试",
        });
    } finally {
      if (generation === this.catalogGeneration)
        this.setData({ loading: false });
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
  pay() {
    if (dataMode() === "live") {
      toast("真实购买尚未开放");
      return;
    }
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
