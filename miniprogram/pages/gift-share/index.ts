import type { OwnedGift } from "../../../packages/contracts/src";
import { giftClient } from "../../services/gifts";
import { sessionClient } from "../../services/session";
import { go } from "../../services/store";
import { switchProjectTab } from "../../services/navigation";

Page({
  data: {
    gift: null as OwnedGift | null,
    loading: true,
    status: "",
    loginVisible: false,
  },
  projectId: "",
  ownerContext: "",
  generation: 0,
  onLoad(q) {
    this.projectId = q.projectId ?? "";
    wx.hideShareMenu();
  },
  onShow() {
    return this.load();
  },
  onHide() {
    ++this.generation;
  },
  onUnload() {
    ++this.generation;
  },
  async load() {
    const generation = ++this.generation,
      context = sessionClient.context();
    if (context !== this.ownerContext) this.setData({ gift: null });
    this.ownerContext = context;
    if (!context) {
      this.setData({ gift: null, loading: false, loginVisible: true });
      return;
    }
    this.setData({ loading: true, status: "" });
    try {
      const setup = await giftClient.current(this.projectId);
      if (generation !== this.generation || context !== sessionClient.context())
        return;
      this.setData({ gift: setup.gift });
      if (!setup.gift) go("gift-recipient", `projectId=${this.projectId}`);
    } catch (e) {
      if (generation === this.generation)
        this.setData({
          status: e instanceof Error ? e.message : "礼物卡读取失败，请重试",
        });
    } finally {
      if (generation === this.generation) this.setData({ loading: false });
    }
  },
  edit() {
    if (this.data.gift?.state === "unclaimed")
      go("gift-recipient", `projectId=${this.projectId}`);
  },
  project() {
    if (this.data.gift) switchProjectTab("home", this.projectId);
  },
  onShareAppMessage() {
    const gift = this.data.gift;
    return gift
      ? {
          title: `送给${gift.recipientName}的时光书：${gift.bookTitle}`,
          path: `/pages/gift-claim/index?token=${gift.token}`,
          imageUrl: "/assets/storybook-example.jpg",
        }
      : { title: "时光故事", path: "/pages/home/index" };
  },
  loginSucceeded() {
    this.setData({ loginVisible: false });
    return this.load();
  },
  closeLogin() {
    this.setData({ loginVisible: false });
  },
});
