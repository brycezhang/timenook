import type { FirstCopyContext } from "../../../packages/contracts/src";
import { firstCopyClient } from "../../services/first-copy";
import { sessionClient, ApiFailure } from "../../services/session";
import { paymentKey } from "../../services/payments";
import { markEditing, previewBookPhoto } from "../../services/book-editor";
import { clearPhotoPreviews } from "../../services/story-photos";
import { watchProjectAccess } from "../../services/project-access";
Page({
  data: {
    context: null as FirstCopyContext | null,
    name: "",
    phone: "",
    detail: "",
    regions: [] as string[],
    regionIndex: -1,
    busy: false,
    pageLoading: true,
    status: "",
    dirty: false,
    coverImage: "",
    keyboardHeight: 0,
  },
  projectId: "",
  returnTo: "",
  generation: 0,
  intent: null as { input: string; key: string } | null,
  stopSession: undefined as (() => void) | undefined,
  stopAccess: undefined as (() => void) | undefined,
  onLoad(q) {
    this.projectId = q.projectId || "";
    this.returnTo = q.returnTo || "";
    this.stopSession = sessionClient.onInvalidated(() => this.clearAccess());
  },
  clearAccess() {
    this.onHide();
    this.intent = null;
    markEditing(false);
    this.setData({
      context: null,
      name: "",
      phone: "",
      detail: "",
      regions: [],
      regionIndex: -1,
      dirty: false,
      status: "项目访问已变化，请重新打开",
    });
  },
  async onShow() {
    this.stopAccess?.();
    const owner = sessionClient.context();
    this.stopAccess = watchProjectAccess(
      this.projectId,
      () => owner === sessionClient.context(),
      () => this.clearAccess(),
    );
    if (!this.data.dirty) await this.refresh();
  },
  async refresh() {
    if (this.data.busy) return;
    const n = ++this.generation,
      owner = sessionClient.context();
    this.setData({ busy: true, pageLoading: !this.data.context, status: "" });
    try {
      const c = await firstCopyClient.read(this.projectId);
      if (n !== this.generation || owner !== sessionClient.context()) return;
      if (c.production && !c.canReviseProduction) {
        wx.redirectTo({
          url: `/pages/production/index?projectId=${this.projectId}`,
        });
        return;
      }
      if (!c.book || c.book.state !== "ready") {
        wx.redirectTo({ url: `/pages/book/index?projectId=${this.projectId}` });
        return;
      }
      const a = c.address.value;
      this.setData({
        context: c,
        name: a?.recipientName || "",
        phone: a?.phone || "",
        detail: a?.detail || "",
        regions: c.shipping.regionCodes.map(
          (code) => c.shipping.regionLabels[code] || code,
        ),
        regionIndex: a ? c.shipping.regionCodes.indexOf(a.regionCode) : -1,
        dirty: false,
      });
      markEditing(false);
      const photo = c.book.coverPhotoAccess.allowed
        ? c.book.snapshot.cover.photo
        : null;
      if (photo && !this.data.coverImage) {
        const path = await previewBookPhoto(
          this.projectId,
          photo,
          () => n === this.generation && owner === sessionClient.context(),
        );
        if (n !== this.generation || owner !== sessionClient.context()) {
          await clearPhotoPreviews([path]);
          return;
        }
        this.setData({ coverImage: path });
      }
    } catch (e) {
      if (n === this.generation)
        this.setData({
          status: e instanceof Error ? e.message : "地址未能读取",
        });
    } finally {
      if (n === this.generation)
        this.setData({ busy: false, pageLoading: false });
    }
  },
  onHide() {
    ++this.generation;
    this.stopAccess?.();
    this.stopAccess = undefined;
    void clearPhotoPreviews([this.data.coverImage].filter(Boolean));
    this.setData({
      coverImage: "",
      busy: false,
      pageLoading: false,
      keyboardHeight: 0,
    });
  },
  onUnload() {
    this.stopSession?.();
    this.onHide();
    markEditing(false);
  },
  input(e: WechatMiniprogram.Input) {
    const field = e.currentTarget.dataset.field as string;
    if (!["name", "phone", "detail"].includes(field)) return;
    this.setData({ [field]: e.detail.value, dirty: true });
    markEditing(true);
  },
  region(e: WechatMiniprogram.PickerChange) {
    this.setData({ regionIndex: Number(e.detail.value), dirty: true });
    markEditing(true);
  },
  keyboard(e: WechatMiniprogram.InputKeyboardHeightChange) {
    this.setData({ keyboardHeight: e.detail.height });
  },
  async save() {
    const c = this.data.context;
    if (!c || this.data.busy) return;
    const { name, phone, detail, regionIndex } = this.data;
    if (
      !name.trim() ||
      !/^1\d{10}$/.test(phone.trim()) ||
      !detail.trim() ||
      !c.shipping.regionCodes[regionIndex]
    ) {
      this.setData({ status: "请填写收件人、11 位手机号和完整地址" });
      return;
    }
    const value = {
      recipientName: name.trim(),
      phone: phone.trim(),
      detail: detail.trim(),
      regionCode: c.shipping.regionCodes[regionIndex],
    };
    const input = JSON.stringify({
      expectedVersion: c.address.version,
      ...value,
    });
    if (this.intent?.input !== input)
      this.intent = { input, key: paymentKey() };
    const n = this.generation,
      owner = sessionClient.context();
    this.setData({ busy: true, status: "" });
    try {
      const saved = await firstCopyClient.saveAddress(
        this.projectId,
        c.address.version,
        value,
        this.intent.key,
      );
      if (n !== this.generation || owner !== sessionClient.context()) return;
      this.intent = null;
      markEditing(false);
      this.setData({ context: saved, dirty: false });
      if (this.returnTo === "print") wx.navigateBack();
      else
        wx.redirectTo({
          url: `/pages/print/index?projectId=${this.projectId}`,
        });
    } catch (e) {
      if (n === this.generation && owner === sessionClient.context())
        this.setData({
          status:
            e instanceof ApiFailure && e.status === 409
              ? "地址或制作状态已更新，请重新读取"
              : "地址未保存，请重试",
        });
    } finally {
      if (n === this.generation) this.setData({ busy: false });
    }
  },
});
