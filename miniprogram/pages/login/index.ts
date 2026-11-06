import { go } from "../../services/store";
import { switchProjectTab } from "../../services/navigation";

Page({
  data: { loginVisible: true, expectedUserId: "" },
  purchaseQuery: "",
  next: "home",
  onLoad(q) {
    this.next = ["purchase", "account", "back"].includes(q.next ?? "")
      ? q.next!
      : "home";
    this.setData({ expectedUserId: q.expectedUserId ?? "" });
    const decode = (value: string) => {
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    };
    if (q.next === "purchase")
      this.purchaseQuery = `bookTitle=${encodeURIComponent(decode(q.bookTitle ?? "人生故事书"))}&salutation=${encodeURIComponent(decode(q.salutation ?? ""))}`;
  },
  loginSucceeded() {
    this.setData({ loginVisible: false });
    if (this.purchaseQuery)
      wx.redirectTo({ url: `/pages/purchase/index?${this.purchaseQuery}` });
    else if (this.next === "back") wx.navigateBack();
    else if (this.next === "account") switchProjectTab("account");
    else switchProjectTab("home");
  },
  cancel() {
    if (this.purchaseQuery || this.next === "back") wx.navigateBack();
    else if (this.next === "account") switchProjectTab("account");
    else switchProjectTab("home");
  },
  terms() {
    go("terms");
  },
});
