import { go } from "../../services/store";
import { sessionClient } from "../../services/session";
Page({
  data: { name: "", salutation: "", loginVisible: false },
  input(e: WechatMiniprogram.Input) {
    const field = e.currentTarget.dataset.field as string;
    if (field === "name" || field === "salutation")
      this.setData({ [field]: e.detail.value });
  },
  next() {
    if (!this.data.name.trim()) return;
    if (!sessionClient.context()) {
      this.setData({ loginVisible: true });
      return;
    }
    this.openPurchase();
  },
  closeLogin() {
    this.setData({ loginVisible: false });
  },
  loginSucceeded() {
    this.setData({ loginVisible: false });
    this.openPurchase();
  },
  openPurchase() {
    go(
      "purchase",
      `next=purchase&bookTitle=${encodeURIComponent(this.data.name.trim())}&salutation=${encodeURIComponent(this.data.salutation.trim())}`,
    );
  },
});
