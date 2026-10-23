import { touch } from "../../domain/model";
import { required, save, toast } from "../../services/store";
import { dataMode } from "../../services/mode";
import { sessionClient, ApiFailure } from "../../services/session";
import { projectOverviewClient } from "../../services/project-overview";
import { paymentKey } from "../../services/payments";
import type { ProjectOverview } from "../../../packages/contracts/src";
type E = {
  currentTarget: { dataset: Record<string, string> };
  detail: { value: string };
};
Page({
  data: {
    title: "",
    buyer: "",
    recipient: "",
    error: "",
    live: false,
    busy: false,
    overview: null as ProjectOverview | null,
  },
  projectId: "",
  generation: 0,
  command: null as { input: string; key: string } | null,
  stopSessionWatch: undefined as (() => void) | undefined,
  onLoad(q) {
    if (dataMode() === "live") {
      this.projectId = q.projectId || projectOverviewClient.selected();
      this.setData({ live: true });
      return;
    }
    const p = required();
    this.setData({ title: p.title, buyer: p.buyer, recipient: p.recipient });
  },
  async onShow() {
    if (!this.data.live) return;
    const generation = ++this.generation,
      context = sessionClient.context();
    this.stopSessionWatch?.();
    this.stopSessionWatch = sessionClient.onInvalidated(() => {
      this.onHide();
      this.setData({ error: "登录已失效，请重新登录" });
    });
    this.setData({ busy: true, error: "", overview: null, title: "" });
    try {
      const overview = await projectOverviewClient.read(this.projectId);
      if (generation === this.generation && context === sessionClient.context())
        this.setData({ overview, title: overview.bookTitle });
    } catch (error) {
      if (generation === this.generation)
        this.setData({
          error: error instanceof Error ? error.message : "查询失败，请重试",
        });
    } finally {
      if (generation === this.generation) this.setData({ busy: false });
    }
  },
  onHide() {
    if (this.data.live) {
      ++this.generation;
      this.stopSessionWatch?.();
      this.stopSessionWatch = undefined;
      this.command = null;
      this.setData({ overview: null, title: "", busy: false });
    }
  },
  onUnload() {
    this.onHide();
  },
  input(e: E) {
    if (this.data.live && (this.data.busy || !this.data.overview)) return;
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value });
  },
  async save() {
    if (this.data.live) {
      if (this.data.busy || !this.data.overview) return;
      const title = this.data.title.trim();
      if (!title) {
        this.setData({ error: "请填写书名" });
        return;
      }
      const generation = this.generation,
        context = sessionClient.context(),
        input = `${this.data.overview.metadataVersion}:${title}`;
      if (this.command?.input !== input)
        this.command = { input, key: paymentKey() };
      this.setData({ busy: true, error: "" });
      try {
        await projectOverviewClient.rename(
          this.projectId,
          this.data.overview.metadataVersion,
          title,
          this.command!.key,
        );
        if (
          generation === this.generation &&
          context === sessionClient.context()
        ) {
          this.command = null;
          wx.navigateBack();
        }
      } catch (error) {
        if (
          generation === this.generation &&
          context === sessionClient.context()
        )
          this.setData({
            error:
              error instanceof ApiFailure && error.status === 409
                ? "书名已被修改，请保留本页草稿并重新查询"
                : "保存结果未确定，请重试；当前书名草稿仍保留",
          });
      } finally {
        if (generation === this.generation) {
          if (context !== sessionClient.context()) {
            this.onHide();
            this.setData({ error: "账号已变化，请重新查询" });
          } else this.setData({ busy: false });
        }
      }
      return;
    }
    if (!this.data.title.trim() || !this.data.buyer.trim()) {
      this.setData({ error: "请填写书名和赠礼人称呼" });
      return;
    }
    const p = required();
    if (p.title !== this.data.title.trim()) touch(p);
    p.title = this.data.title.trim();
    p.buyer = this.data.buyer.trim();
    save(p);
    toast("资料已保存");
    wx.navigateBack();
  },
});
