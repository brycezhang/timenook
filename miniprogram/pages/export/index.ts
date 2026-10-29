import type {
  CompleteExportContext,
  CompleteExportView,
} from "../../../packages/contracts/src";
import { completeExportClient } from "../../services/complete-export";
import { sessionClient, ApiFailure } from "../../services/session";
import { dataMode } from "../../services/mode";
import { paymentKey } from "../../services/payments";
const labels: Record<CompleteExportView["state"], string> = {
  requested: "待客服核验本人及范围",
  accepted: "已受理，等待打包",
  packing: "正在打包",
  ready: "资料包可下载",
  failed: "资料包未完成，请客服核对缺失原因",
  revoked: "授权已变化，请重新核验",
  delivered: "已按核验渠道交付",
};
Page({
  data: {
    context: null as CompleteExportContext | null,
    rows: [] as (CompleteExportView & { label: string })[],
    busy: false,
    status: "",
    recipientChoice: "" as "" | "self" | "initiator",
    evidenceText: "",
    checked: false,
  },
  projectId: "",
  generation: 0,
  active: false,
  owner: "",
  intent: null as { input: string; key: string } | null,
  expiry: undefined as ReturnType<typeof setTimeout> | undefined,
  stopSessionWatch: undefined as (() => void) | undefined,
  onLoad(q) {
    this.projectId = q.projectId || "";
  },
  onHide() {
    this.active = false;
    ++this.generation;
    this.stopSessionWatch?.();
    this.stopSessionWatch = undefined;
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = undefined;
    this.intent = null;
    this.setData({
      context: null,
      rows: [],
      busy: false,
      evidenceText: "",
      checked: false,
      recipientChoice: "",
    });
  },
  onUnload() {
    this.onHide();
  },
  async onShow() {
    this.active = true;
    this.stopSessionWatch?.();
    this.stopSessionWatch = sessionClient.onInvalidated(() => {
      this.onHide();
      this.setData({ status: "登录已失效，请重新登录" });
    });
    return this.refresh();
  },
  current(generation: number, owner: string) {
    return (
      this.active &&
      generation === this.generation &&
      !!owner &&
      owner === sessionClient.context() &&
      dataMode() === "live"
    );
  },
  accept(value: CompleteExportContext) {
    this.setData({
      context: value,
      rows: value.requests.map((row) => ({
        ...row,
        label:
          row.missingReason === "EXPORT_CURRENT_AUTHORIZATION_REQUIRED"
            ? "当前本人授权不可用，请重新核验"
            : row.missingReason === "EXPORT_SOURCE_DELETED"
              ? "资料已删除，不能领取"
              : labels[row.state],
      })),
    });
  },
  watch() {
    if (this.expiry) clearTimeout(this.expiry);
    const generation = this.generation,
      owner = this.owner;
    this.expiry = setTimeout(() => {
      if (generation !== this.generation || !this.active) return;
      if (!this.current(generation, owner)) {
        this.onHide();
        this.setData({ status: "账号已变化，请重新查询" });
        return;
      }
      this.watch();
    }, 1000);
  },
  async refresh() {
    if (this.data.busy) return;
    const generation = ++this.generation,
      owner = sessionClient.context();
    this.owner = owner;
    this.setData({ busy: true, status: "", context: null, rows: [] });
    try {
      if (dataMode() !== "live" || !owner)
        throw Error("请在真实服务模式登录后查询资料导出");
      this.watch();
      const value = await completeExportClient.read(this.projectId);
      if (!this.current(generation, owner)) return;
      this.accept(value);
      this.watch();
    } catch (error) {
      if (generation === this.generation)
        this.setData({
          status:
            error instanceof ApiFailure
              ? "当前账号无权查询或授权已失效，请重新登录或联系客服"
              : error instanceof Error
                ? error.message
                : "查询未完成，请重试",
        });
    } finally {
      if (generation === this.generation) this.setData({ busy: false });
    }
  },
  recipient(e: { currentTarget: { dataset: { value: string } } }) {
    if (this.data.busy) return;
    const value = e.currentTarget.dataset.value;
    if (value === "self" || value === "initiator") {
      this.intent = null;
      this.setData({ recipientChoice: value, checked: false });
    }
  },
  evidence(e: { detail: { value: string } }) {
    if (!this.data.busy) {
      this.intent = null;
      this.setData({ evidenceText: e.detail.value });
    }
  },
  choose() {
    if (!this.data.busy) this.setData({ checked: !this.data.checked });
  },
  async request() {
    if (this.data.busy || !this.data.context?.canRequest) return;
    const recipient = this.data.recipientChoice,
      evidence = this.data.evidenceText.trim();
    if (
      !recipient ||
      !this.data.checked ||
      !/^[^\r\n]{3,160}$/.test(evidence)
    ) {
      this.setData({ status: "请明确接收人并确认本人完整资料导出申请" });
      return;
    }
    const generation = ++this.generation,
      owner = this.owner,
      input = JSON.stringify({ recipient, evidence });
    if (!this.current(generation, owner)) {
      this.onHide();
      this.setData({ status: "账号已变化，请重新查询" });
      return;
    }
    if (this.intent?.input !== input)
      this.intent = { input, key: paymentKey() };
    this.setData({ busy: true, status: "" });
    this.watch();
    try {
      const row = await completeExportClient.request(
        this.projectId,
        recipient,
        evidence,
        this.intent.key,
      );
      if (!this.current(generation, owner)) return;
      this.intent = null;
      this.setData({
        rows: [
          { ...row, label: labels[row.state] },
          ...this.data.rows.filter((r) => r.id !== row.id),
        ],
        checked: false,
        evidenceText: "",
        status: "申请已记录，等待客服核验本人及范围；完整导出不额外收费。",
      });
      this.watch();
    } catch (error) {
      if (this.current(generation, owner))
        this.setData({
          status: "申请结果未确定，请重新查询或重试；重试保留本次申请标识。",
        });
    } finally {
      if (generation === this.generation) this.setData({ busy: false });
    }
  },
  async download(e: { currentTarget: { dataset: { id: string } } }) {
    const row = this.data.rows.find((r) => r.id === e.currentTarget.dataset.id),
      epoch = this.data.context?.accessEpoch;
    if (this.data.busy || !row?.canDownload || !row.sha256 || !row.bytes)
      return;
    const generation = ++this.generation,
      owner = this.owner;
    let filePath = "";
    this.setData({ busy: true, status: "" });
    this.watch();
    try {
      const result = await sessionClient.downloadExport(this.projectId, row.id);
      filePath = result.tempFilePath;
      if (!this.current(generation, owner)) return;
      if (result.statusCode !== 200) throw Error("本次领取授权已变化");
      const info =
        await new Promise<WechatMiniprogram.GetFileInfoSuccessCallbackResult>(
          (resolve, reject) =>
            wx.getFileSystemManager().getFileInfo({
              filePath,
              digestAlgorithm: "sha256",
              success: resolve,
              fail: reject,
            }),
        );
      if (info.size !== row.bytes || info.digest !== row.sha256)
        throw Error("资料包完整性核对未通过，请重新领取");
      const context = await completeExportClient.read(this.projectId),
        current = context.requests.find((r) => r.id === row.id);
      if (!this.current(generation, owner)) return;
      if (
        context.accessEpoch !== epoch ||
        !current?.canDownload ||
        current.sha256 !== row.sha256
      )
        throw Error("本次领取授权已变化，请重新核验");
      await new Promise<void>((resolve, reject) =>
        wx.shareFileMessage({
          filePath,
          fileName: "岁月成书-完整资料.zip",
          success: () => resolve(),
          fail: reject,
        }),
      );
      if (!this.current(generation, owner)) return;
      await completeExportClient.receipt(
        this.projectId,
        row.id,
        row.sha256,
        paymentKey(),
      );
      if (this.current(generation, owner))
        this.setData({
          status:
            "资料包已交给设备保存或发送；请解压核对 manifest 清单。已下载副本需由接收人自行保管。",
        });
    } catch (error) {
      if (this.current(generation, owner))
        this.setData({
          status:
            error instanceof Error
              ? error.message
              : "下载或保存未完成，请重新查询后重试",
        });
    } finally {
      if (filePath)
        await new Promise<void>((resolve) =>
          wx.getFileSystemManager().unlink({
            filePath,
            success: () => resolve(),
            fail: () => resolve(),
          }),
        );
      if (generation === this.generation) {
        this.setData({ busy: false });
        this.watch();
      }
    }
  },
});
