import { API_BASE_URL } from "../../config";
import { channelGiftClient } from "../../services/channel-gifts";
import { channelActivationClient } from "../../services/channel-activation";
import { projectOverviewClient } from "../../services/project-overview";
import { giftContinuation } from "../../services/gifts";
import type { ActivateChannelGiftCommand } from "../../../packages/contracts/src";
import { switchProjectTab } from "../../services/navigation";
import { go } from "../../services/navigation";
import { ApiFailure, sessionClient } from "../../services/session";
const relationships = ["爸爸", "妈妈", "爷爷", "奶奶", "自己", "自定义"];
Page({
  data: {
    channelGiftId: "",
    busy: false,
    loading: false,
    available: true,
    relationships,
    relationship: "",
    customRelationship: "",
    bookTitle: "",
    titleTouched: false,
    loginVisible: false,
    error: "",
  },
  generation: 0,
  owner: "",
  onLoad(q) {
    this.setData({ channelGiftId: q.channelGiftId ?? "" });
  },
  intentKey() {
    return `timenook.channel-activation.v1:${API_BASE_URL}:${sessionClient.context().split(":")[0]}:${this.data.channelGiftId}`;
  },
  async continueProject(projectId: string, current: () => boolean) {
    this.setData({ available: false });
    wx.removeStorageSync(this.intentKey());
    const { projects } = await projectOverviewClient.memberships();
    if (!current()) return;
    const project = projects.find((p) => p.projectId === projectId);
    if (!project) throw new Error("故事书暂不可用，请返回我的礼物刷新");
    const page = giftContinuation(project);
    if (page)
      wx.redirectTo({ url: `/pages/${page}/index?projectId=${projectId}` });
    else switchProjectTab("home", projectId);
  },
  async onShow() {
    if (!this.data.channelGiftId || this.data.busy) return;
    const generation = ++this.generation,
      owner = sessionClient.context();
    if (this.owner && this.owner !== owner)
      this.setData({
        relationship: "",
        customRelationship: "",
        bookTitle: "",
        titleTouched: false,
      });
    this.owner = owner;
    if (!owner) {
      this.setData({ loginVisible: true, available: false });
      return;
    }
    const current = () =>
      generation === this.generation && owner === sessionClient.context();
    this.setData({ loading: true, available: false, error: "" });
    try {
      const gift = (await channelGiftClient.list()).find(
        (g) => g.id === this.data.channelGiftId,
      );
      if (!current()) return;
      if (!gift || gift.state !== "active")
        throw new Error("这份礼物已不可开通，请返回我的礼物刷新");
      if (gift.projectId) {
        await this.continueProject(gift.projectId, current);
        return;
      }
      const intent = wx.getStorageSync(this.intentKey()) as
        ActivateChannelGiftCommand | undefined;
      if (intent)
        this.setData({
          relationship: intent.purchaseKind === "self" ? "自己" : "自定义",
          customRelationship: intent.recipient.relationshipLabel ?? "",
          bookTitle: intent.bookTitle,
          titleTouched: true,
        });
      this.setData({ available: true });
    } catch (e) {
      if (current())
        this.setData({
          error: e instanceof Error ? e.message : "礼物加载失败",
        });
    } finally {
      if (current()) this.setData({ loading: false });
    }
  },
  onHide() {
    if (!this.data.busy) ++this.generation;
  },
  onUnload() {
    ++this.generation;
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
  async next() {
    if (this.data.busy || this.data.loading) return;
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
    if (this.data.channelGiftId) {
      if (!this.data.available) return;
      const owner = sessionClient.context(),
        generation = this.generation,
        key = this.intentKey();
      const current = () =>
        owner === sessionClient.context() && generation === this.generation;
      const command = (wx.getStorageSync(key) as
        ActivateChannelGiftCommand | undefined) || {
        purchaseKind: this.data.relationship === "自己" ? "self" : "gift",
        recipient:
          this.data.relationship === "自己"
            ? { typeCode: "self", relationshipLabel: "自己" }
            : { relationshipLabel: relationship },
        bookTitle: this.data.bookTitle.trim(),
      };
      wx.setStorageSync(key, command);
      this.setData({ busy: true, error: "" });
      try {
        const result = await channelActivationClient.activate(
          this.data.channelGiftId,
          command,
        );
        if (!current()) return;
        wx.removeStorageSync(key);
        if (result.purchaseKind === "self")
          switchProjectTab("home", result.projectId);
        else
          wx.redirectTo({
            url: `/pages/gift-recipient/index?projectId=${result.projectId}`,
          });
      } catch (e) {
        if (!current()) return;
        if (e instanceof ApiFailure && e.status === 400)
          wx.removeStorageSync(key);
        if (e instanceof ApiFailure && [403, 404, 409].includes(e.status)) {
          const fresh = await channelGiftClient.list().catch(() => null);
          if (!current()) return;
          const gift = fresh?.find((g) => g.id === this.data.channelGiftId);
          if (fresh && (!gift || gift.state !== "active"))
            this.setData({ available: false });
          if (gift?.state === "active" && gift.projectId) {
            try {
              await this.continueProject(gift.projectId, current);
            } catch (recoveryError) {
              if (current())
                this.setData({
                  error:
                    recoveryError instanceof Error
                      ? recoveryError.message
                      : "故事书暂不可用，请返回我的礼物刷新",
                });
            }
            return;
          }
        }
        if (current())
          this.setData({
            error:
              e instanceof Error ? e.message : "开通结果未确认，请重试原礼物",
          });
      } finally {
        if (current()) this.setData({ busy: false });
      }
      return;
    }
    go(
      "purchase",
      `bookTitle=${encodeURIComponent(this.data.bookTitle.trim())}&relationship=${encodeURIComponent(relationship)}&purchaseKind=${this.data.relationship === "自己" ? "self" : "gift"}`,
    );
  },
  loginSucceeded() {
    this.setData({ loginVisible: false });
    if (this.data.channelGiftId) void this.onShow();
    else void this.next();
  },
  closeLogin() {
    this.setData({ loginVisible: false });
  },
});
