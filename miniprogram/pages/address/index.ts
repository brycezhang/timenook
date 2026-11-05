import type { FirstCopyContext } from "../../../packages/contracts/src";
import { firstCopyClient } from "../../services/first-copy";
import { sessionClient } from "../../services/session";
import { paymentKey } from "../../services/payments";
import { markEditing } from "../../services/book-editor";
Page({
  data: {
    name: "",
    phone: "",
    detail: "",
    regions: [] as string[],
    regionIndex: -1,
    busy: false,
    status: "",
    dirty: false,
  },
  projectId: "",
  context: null as FirstCopyContext | null,
  generation: 0,
  stopSession: undefined as (() => void) | undefined,
  onLoad(q) {
    this.stopSession = sessionClient.onInvalidated(() => {
      ++this.generation;
      this.context = null;
      this.setData({
        name: "",
        phone: "",
        detail: "",
        dirty: false,
        busy: false,
        status: "登录已失效，请重新登录",
      });
    });
    this.projectId = q.projectId || "";
  },
  async onShow() {
    if (this.data.dirty) return;
    const n = ++this.generation,
      owner = sessionClient.context();
    this.setData({ busy: true, status: "" });
    try {
      const c = await firstCopyClient.read(this.projectId);
      if (n !== this.generation || owner !== sessionClient.context()) return;
      this.context = c;
      const a = c.address.value;
      this.setData({
        name: a?.recipientName || "",
        phone: a?.phone || "",
        detail: a?.detail || "",
        regions: c.shipping.regionCodes.map(
          (code) => c.shipping.regionLabels[code] || code,
        ),
        regionIndex: a ? c.shipping.regionCodes.indexOf(a.regionCode) : -1,
      });
    } catch (e) {
      if (n === this.generation)
        this.setData({ status: e instanceof Error ? e.message : "读取失败" });
    } finally {
      if (n === this.generation) this.setData({ busy: false });
    }
  },
  onHide() {
    ++this.generation;
  },
  onUnload() {
    this.stopSession?.();
    markEditing(false);
  },
  input(e: WechatMiniprogram.Input) {
    this.setData({
      [e.currentTarget.dataset.field as string]: e.detail.value,
      dirty: true,
    });
    markEditing(true);
  },
  region(e: WechatMiniprogram.PickerChange) {
    this.setData({ regionIndex: Number(e.detail.value), dirty: true });
    markEditing(true);
  },
  async save() {
    const c = this.context;
    if (!c || this.data.busy) return;
    const { name, phone, detail, regionIndex } = this.data;
    if (
      !name.trim() ||
      !/^1[3-9]\d{9}$/.test(phone.trim()) ||
      !detail.trim() ||
      regionIndex < 0
    ) {
      this.setData({ status: "请填写收件人、11位手机号、地区和详细地址" });
      return;
    }
    const n = this.generation,
      owner = sessionClient.context();
    this.setData({ busy: true, status: "" });
    try {
      await firstCopyClient.saveAddress(
        this.projectId,
        c.address.version,
        {
          recipientName: name.trim(),
          phone: phone.trim(),
          detail: detail.trim(),
          regionCode: c.shipping.regionCodes[regionIndex],
        },
        paymentKey(),
      );
      if (n !== this.generation || owner !== sessionClient.context()) return;
      markEditing(false);
      wx.navigateBack();
    } catch (e) {
      this.setData({
        status: e instanceof Error ? e.message : "地址未保存，请重试",
      });
    } finally {
      this.setData({ busy: false });
    }
  },
});
