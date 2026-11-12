import type { FulfillmentView } from "../../../packages/contracts/src";
import { fulfillmentClient } from "../../services/fulfillment";
import { sessionClient } from "../../services/session";
import { go } from "../../services/navigation";
const labels = {
  approved: "已提交，等待制作",
  handoff_pending: "正在核实制作安排",
  in_production: "正在印制",
  shipped: "已发货",
  delivered: "已送达",
  cancellation_pending: "正在核实取消结果",
  cancelled: "本次制作已取消",
};
Page({
  data: {
    view: null as FulfillmentView | null,
    label: "",
    busy: false,
    pageLoading: true,
    status: "",
  },
  projectId: "",
  generation: 0,
  stopSession: undefined as (() => void) | undefined,
  onLoad(q) {
    this.stopSession = sessionClient.onInvalidated(() => {
      ++this.generation;
      this.setData({
        view: null,
        label: "",
        busy: false,
        pageLoading: false,
        status: "登录已失效，请重新登录",
      });
    });
    this.projectId = q.projectId || "";
  },
  onShow() {
    void this.refresh();
  },
  onHide() {
    ++this.generation;
    this.setData({ view: null, busy: false, pageLoading: false });
  },
  onUnload() {
    this.stopSession?.();
    this.onHide();
  },
  async refresh() {
    if (this.data.busy) return;
    const n = ++this.generation,
      owner = sessionClient.context();
    this.setData({ busy: true, pageLoading: !this.data.view, status: "" });
    try {
      const view = await fulfillmentClient.read(this.projectId);
      if (n === this.generation && owner === sessionClient.context())
        this.setData({
          view,
          label: view.current
            ? view.current.printedAt && view.current.state === "in_production"
              ? "已印好，等待发货"
              : labels[view.current.state]
            : view.reservation
              ? "已提交，等待制作"
              : "还未提交印刷",
        });
    } catch (e) {
      if (n === this.generation)
        this.setData({
          status: e instanceof Error ? e.message : "未能读取进度",
        });
    } finally {
      if (n === this.generation)
        this.setData({ busy: false, pageLoading: false });
    }
  },
  book() {
    go("book", `projectId=${this.projectId}`);
  },
  print() {
    go("print", `projectId=${this.projectId}`);
  },
  preview() {
    const id =
      this.data.view?.current?.bookVersionId ||
      this.data.view?.reservation?.bookVersionId;
    if (id) go("manuscript", `projectId=${this.projectId}&versionId=${id}`);
  },
  terms() {
    go("terms");
  },
});
