import { go } from "../../services/navigation";
import { sessionClient } from "../../services/session";
const relationships = ["爸爸", "妈妈", "爷爷", "奶奶", "自己", "自定义"];
Page({
  data: {
    relationships,
    relationship: "",
    customRelationship: "",
    bookTitle: "",
    titleTouched: false,
    loginVisible: false,
    error: "",
  },
  chooseRelationship(e: WechatMiniprogram.TouchEvent) {
    const relationship = String(e.currentTarget.dataset.relationship);
    if (!relationships.includes(relationship)) return;
    const label =
      relationship === "自定义"
        ? this.data.customRelationship.trim()
        : relationship;
    this.setData({
      relationship,
      error: "",
      ...(!this.data.titleTouched
        ? {
            bookTitle:
              label === "自己" ? "我的故事" : label ? `${label}的故事` : "",
          }
        : {}),
    });
  },
  input(e: WechatMiniprogram.Input) {
    const field = e.currentTarget.dataset.field;
    if (field === "bookTitle")
      this.setData({
        bookTitle: e.detail.value,
        titleTouched: true,
        error: "",
      });
    if (field === "customRelationship") {
      const name = e.detail.value;
      this.setData({
        customRelationship: name,
        error: "",
        ...(!this.data.titleTouched
          ? { bookTitle: name.trim() ? `${name.trim()}的故事` : "" }
          : {}),
      });
    }
  },
  next() {
    const relationship =
      this.data.relationship === "自定义"
        ? this.data.customRelationship.trim()
        : this.data.relationship;
    if (!relationship) {
      this.setData({ error: "请选择关系或填写自定义关系" });
      return;
    }
    if (!this.data.bookTitle.trim()) {
      this.setData({ error: "请填写书名" });
      return;
    }
    if (!sessionClient.context()) {
      this.setData({ loginVisible: true });
      return;
    }
    go(
      "purchase",
      `bookTitle=${encodeURIComponent(this.data.bookTitle.trim())}&relationship=${encodeURIComponent(relationship)}&purchaseKind=${this.data.relationship === "自己" ? "self" : "gift"}`,
    );
  },
  loginSucceeded() {
    this.setData({ loginVisible: false });
    this.next();
  },
  closeLogin() {
    this.setData({ loginVisible: false });
  },
});
