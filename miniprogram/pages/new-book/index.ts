import { go } from "../../services/store";
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
      "purchase",
      `bookTitle=${encodeURIComponent(this.data.name.trim())}&salutation=${encodeURIComponent(this.data.salutation.trim())}`,
    );
  },
});
