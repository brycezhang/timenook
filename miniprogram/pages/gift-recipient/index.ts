import { giftClient } from "../../services/gifts";
import { sessionClient } from "../../services/session";
import { go } from "../../services/navigation";

Page({
  data: {
    recipientName: "",
    recipientPhone: "",
    loading: true,
    loaded: false,
    busy: false,
    claimed: false,
    status: "",
    loginVisible: false,
  },
  projectId: "",
  ownerContext: "",
  generation: 0,
  onLoad(q) {
    this.projectId = q.projectId ?? "";
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
    if (context !== this.ownerContext)
      this.setData({
        loaded: false,
        recipientPhone: "",
        recipientName: "",
        claimed: false,
      });
    this.ownerContext = context;
    if (!context) {
      this.setData({
        loading: false,
        loginVisible: true,
        loaded: false,
        recipientPhone: "",
        recipientName: "",
      });
      return;
    }
    this.setData({ loading: true, status: "" });
    try {
      const setup = await giftClient.current(this.projectId);
      if (generation !== this.generation || context !== sessionClient.context())
        return;
      this.setData({
        loaded: true,
        recipientName: setup.gift?.recipientName ?? setup.recipientName,
        recipientPhone: setup.gift?.recipientPhone ?? "",
        claimed: setup.gift?.state === "claimed",
      });
    } catch (e) {
      if (generation === this.generation)
        this.setData({
          status: e instanceof Error ? e.message : "收礼信息读取失败，请重试",
        });
    } finally {
      if (generation === this.generation) this.setData({ loading: false });
    }
  },
  setName(e: WechatMiniprogram.Input) {
    this.setData({ recipientName: e.detail.value, status: "" });
  },
  setPhone(e: WechatMiniprogram.Input) {
    this.setData({ recipientPhone: e.detail.value, status: "" });
  },
  async save() {
    if (this.data.busy || this.data.loading || !this.data.loaded) return;
    if (this.data.claimed) {
      go("gift-share", `projectId=${this.projectId}`);
      return;
    }
    const name = this.data.recipientName.trim(),
      phone = this.data.recipientPhone.trim();
    if (!name || !/^1[3-9]\d{9}$/.test(phone)) {
      this.setData({
        status: !name ? "请填写收礼人称呼" : "请填写 11 位微信绑定手机号",
      });
      return;
    }
    const generation = this.generation,
      context = sessionClient.context();
    this.setData({ busy: true, status: "" });
    try {
      await giftClient.issue(this.projectId, name, phone);
      if (generation === this.generation && context === sessionClient.context())
        go("gift-share", `projectId=${this.projectId}`);
    } catch (e) {
      if (generation === this.generation)
        this.setData({
          status: e instanceof Error ? e.message : "礼物卡生成失败，请重试",
        });
    } finally {
      this.setData({ busy: false });
    }
  },
  loginSucceeded() {
    this.setData({ loginVisible: false });
    return this.load();
  },
  closeLogin() {
    this.setData({ loginVisible: false });
  },
});
