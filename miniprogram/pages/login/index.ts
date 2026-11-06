import { sessionClient } from "../../services/session";
import { go } from "../../services/store";
import { switchProjectTab } from "../../services/navigation";

Page({
  data: { busy: false, status: "" },
  generation: 0,
  purchaseQuery: "",
  onLoad(q) {
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
  onHide() {
    if (!this.data.busy) ++this.generation;
  },
  onUnload() {
    ++this.generation;
    if (this.data.busy) void sessionClient.logout().catch(() => {});
  },
  async login() {
    if (this.data.busy) return;
    const generation = ++this.generation;
    this.setData({ busy: true, status: "" });
    try {
      await sessionClient.login();
      if (generation !== this.generation) return;
      this.setData({ busy: false });
      if (this.purchaseQuery)
        wx.redirectTo({ url: `/pages/purchase/index?${this.purchaseQuery}` });
      else switchProjectTab("home");
    } catch (e) {
      if (generation === this.generation)
        this.setData({
          status: e instanceof Error ? e.message : "登录未成功，请再试一次",
        });
    } finally {
      if (generation === this.generation) this.setData({ busy: false });
    }
  },
  cancel() {
    if (this.data.busy) return;
    if (this.purchaseQuery) wx.navigateBack();
    else switchProjectTab("home");
  },
  terms() {
    go("terms");
  },
});
