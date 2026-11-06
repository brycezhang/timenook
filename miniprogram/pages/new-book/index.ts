import { go } from "../../services/store";
import { sessionClient } from "../../services/session";
Page({
  data: { name: "", salutation: "" },
  input(e: WechatMiniprogram.Input) {
    const field = e.currentTarget.dataset.field as string;
    if (field === "name" || field === "salutation")
      this.setData({ [field]: e.detail.value });
  },
  next() {
    if (!this.data.name.trim()) return;
    go(
      sessionClient.context() ? "purchase" : "login",
      `next=purchase&bookTitle=${encodeURIComponent(this.data.name.trim())}&salutation=${encodeURIComponent(this.data.salutation.trim())}`,
    );
  },
});
