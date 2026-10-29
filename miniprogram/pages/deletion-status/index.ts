import type { DeletionStatus } from "../../../packages/contracts/src";
import {
  DELETION_CATEGORY_LABELS as categories,
  DELETION_LAYER_LABELS as layers,
} from "../../../packages/contracts/src";
import { deletionClient } from "../../services/deletion";
import { participationClient } from "../../services/participation";
import { sessionClient, ApiFailure } from "../../services/session";
import { dataMode } from "../../services/mode";
import { go } from "../../services/store";
import { clearStoryAudio } from "../../services/story-audio";
import { clearPhotoPreviews } from "../../services/story-photos";
Page({
  data: {
    view: null as DeletionStatus | null,
    rows: [] as {
      id: string;
      category: string;
      layer: string;
      state: string;
      deadline: string;
      reason: string;
    }[],
    layerSummary: [] as string[],
    summary: "",
    status: "",
    busy: false,
  },
  projectId: "",
  generation: 0,
  active: false,
  owner: "",
  timer: undefined as ReturnType<typeof setTimeout> | undefined,
  stopSession: undefined as (() => void) | undefined,
  onLoad(q) {
    this.projectId = q.projectId || "";
  },
  onHide() {
    this.active = false;
    ++this.generation;
    if (this.timer) clearTimeout(this.timer);
    this.stopSession?.();
    this.stopSession = undefined;
    this.setData({
      view: null,
      rows: [],
      layerSummary: [],
      summary: "",
      busy: false,
    });
  },
  onUnload() {
    this.onHide();
  },
  onShow() {
    this.active = true;
    this.stopSession?.();
    this.stopSession = sessionClient.onInvalidated(() => {
      this.onHide();
      this.setData({ status: "登录已失效，请重新登录" });
    });
    return this.refresh();
  },
  current(g: number, owner: string, projectId: string) {
    return (
      this.active &&
      projectId === this.projectId &&
      g === this.generation &&
      !!owner &&
      owner === sessionClient.context() &&
      dataMode() === "live"
    );
  },
  watch() {
    if (this.timer) clearTimeout(this.timer);
    const owner = this.owner,
      g = this.generation,
      projectId = this.projectId;
    this.timer = setTimeout(async () => {
      if (!this.active) return;
      if (owner !== sessionClient.context()) {
        this.onHide();
        this.setData({ status: "账号已变化，请重新查询" });
        return;
      }
      if (!this.current(g, owner, projectId)) return;
      if (!this.data.busy) {
        try {
          const value = await deletionClient.read(projectId);
          await this.applyStatus(value, g, owner);
        } catch {
          if (this.current(g, owner, projectId)) {
            this.onHide();
            this.setData({ status: "当前项目查询权限已变化，请重新核验" });
          }
          return;
        }
        if (!this.current(g, owner, projectId)) return;
      }
      this.watch();
    }, 1000);
  },
  async applyStatus(value: DeletionStatus, g: number, owner: string) {
    const projectId = value.projectId;
    if (!this.current(g, owner, projectId)) return;
    this.setData({ status: "" });
    // The minimum deletion route remains available after content authorization stops.
    // Existing care content routes must not become a prerequisite for this view.
    let pending = false;
    if (!value.changes.length) {
      try {
        const requests = await participationClient.careRequests(projectId);
        if (!this.current(g, owner, projectId)) return;
        pending = requests.some(
          (r) => r.kind === "delete" && r.state === "open",
        );
      } catch {
        if (!this.current(g, owner, projectId)) return;
      }
    }
    if (value.permanentProjectDeletion) {
      const cleanup = await Promise.allSettled([
        clearStoryAudio(),
        clearPhotoPreviews(),
      ]);
      if (!this.current(g, owner, projectId)) return;
      if (cleanup.some((r) => r.status === "rejected"))
        this.setData({
          status: "在线访问已停止；本机受控临时文件清理未完成，请重试查询。",
        });
    }
    const items = value.changes.flatMap((change) => change.items),
      activeItems = items.filter((item) =>
        ["active_database", "active_files", "cache"].includes(item.layer),
      );
    const layerSummary = !items.length
      ? []
      : [
          activeItems.length &&
          activeItems.every((item) => item.state === "completed")
            ? "活动资料清理已完成"
            : "活动资料清理中，尚有待处理项",
          ...(["object_history", "backup", "supplier"] as const).flatMap(
            (layer) => {
              const relevant = items.filter((item) => item.layer === layer);
              if (!relevant.length) return [];
              if (relevant.every((item) => item.state === "completed"))
                return [`${layers[layer]}本层已核验完成`];
              return [
                layer === "backup"
                  ? "备份待到期或核验"
                  : layer === "supplier"
                    ? "外部副本待确认"
                    : "历史版本待核验",
              ];
            },
          ),
        ];
    this.setData({
      view: value,
      layerSummary,
      summary: value.permanentProjectDeletion
        ? "在线访问已停止，项目删除不可逆。各层清理结果分别如下。"
        : value.changes.length
          ? "已记录本人核验的删除范围，各层清理结果分别如下。"
          : pending
            ? "删除申请待客服核验；尚未确认在线访问停止。"
            : "尚无已核验的删除记录。",
      rows: value.changes.flatMap((change) =>
        change.items.map((item) => ({
          id: item.id,
          category: categories[item.category] || "相关资料",
          layer: layers[item.layer] || "资料副本",
          state:
            item.state === "completed"
              ? "本层已完成"
              : item.state === "running"
                ? "本层清理中"
                : item.layer === "backup"
                  ? "备份待到期或核验"
                  : item.layer === "supplier"
                    ? "外部副本待确认"
                    : item.layer === "object_history"
                      ? "历史版本待核验"
                      : "本层待清理",
          deadline: item.deadline
            ? Date.parse(item.deadline) <= Date.now() &&
              item.state !== "completed"
              ? `原截止：${item.deadline}；已到期，处理结果仍待核实`
              : `原截止：${item.deadline}`
            : "规则、起算或处理截止待确认",
          reason:
            item.reason === "NO_PLATFORM_TARGETS"
              ? "本层没有待清理的活动文件"
              : item.reason === "RETRY_REQUIRED"
                ? "活动清理待重试"
                : item.reason === "RULE_NOT_FROZEN"
                  ? "处理规则尚待冻结"
                  : item.reason === "EXTERNAL_RECEIPT_REQUIRED"
                    ? "等待独立核验回执"
                    : item.reason
                      ? "处理尚未确认，请联系客服核实"
                      : "",
        })),
      ),
    });
  },
  async refresh() {
    if (this.data.busy) return;
    const g = ++this.generation,
      owner = sessionClient.context(),
      projectId = this.projectId;
    this.owner = owner;
    this.setData({
      busy: true,
      status: "",
      view: null,
      rows: [],
      layerSummary: [],
      summary: "",
    });
    this.watch();
    try {
      if (dataMode() !== "live" || !owner)
        throw Error("请登录后查询当前项目的删除进度");
      const value = await deletionClient.read(projectId);
      if (!this.current(g, owner, projectId)) return;
      await this.applyStatus(value, g, owner);
    } catch (error) {
      if (this.current(g, owner, projectId))
        this.setData({
          status:
            error instanceof ApiFailure
              ? "当前账号无权查询或登录已失效，请重新登录或联系客服"
              : error instanceof Error
                ? error.message
                : "查询未完成，请重试",
        });
    } finally {
      if (g === this.generation) this.setData({ busy: false });
    }
  },
  back() {
    go("welcome", `projectId=${this.projectId}`);
  },
});
