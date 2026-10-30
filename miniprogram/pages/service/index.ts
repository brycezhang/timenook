import { type Project } from "../../domain/model";
import { go, notify, read, toast } from "../../services/store";
import { dataMode } from "../../services/mode";
import { sessionClient } from "../../services/session";
import { projectOverviewClient } from "../../services/project-overview";
import { participationClient } from "../../services/participation";
import type { ProjectCareRequestView } from "../../../packages/contracts/src";
type E = {
  currentTarget: { dataset: Record<string, string> };
  detail: { value: string };
};
let audio: WechatMiniprogram.InnerAudioContext | null = null;
Page({
  data: {
    kind: "privacy",
    live: false,
    busy: false,
    status: "",
    careRequests: [] as ProjectCareRequestView[],
    recordings: [] as Project["recordings"],
    playing: "",
    progress: 0,
    duration: 0,
  },
  projectId: "",
  generation: 0,
  stopSessionWatch: undefined as (() => void) | undefined,
  onLoad(q) {
    const kind = q.kind || "privacy";
    const live = dataMode() === "live";
    this.projectId = live
      ? q.projectId || projectOverviewClient.selected()
      : "";
    this.setData({
      kind,
      live,
      recordings: live ? [] : read()?.recordings || [],
    });
    const titles: Record<string, string> = {
      privacy: "隐私与资料说明",
      terms: "服务与隐私说明",
      support: "帮助与反馈",
      recordings: "本机原声",
      export: "导出我的资料",
    };
    wx.setNavigationBarTitle({ title: titles[kind] || "资料与帮助" });
  },
  onShow() {
    if (this.data.live) return this.refresh();
  },
  async refresh() {
    if (!this.data.live || this.data.busy) return;
    const generation = ++this.generation,
      owner = sessionClient.context();
    this.stopSessionWatch?.();
    this.stopSessionWatch = sessionClient.onInvalidated(() => {
      this.onHide();
      this.setData({ status: "登录已失效，请重新登录" });
    });
    this.setData({ busy: true, status: "", careRequests: [] });
    try {
      if (!this.projectId)
        throw new Error("请先打开一个人生项目，再查询资料服务");
      const careRequests = await participationClient.careRequests(
        this.projectId,
      );
      if (generation === this.generation && owner === sessionClient.context())
        this.setData({ careRequests });
    } catch (error) {
      if (generation === this.generation && owner === sessionClient.context())
        this.setData({
          status: error instanceof Error ? error.message : "查询未完成，请重试",
        });
    } finally {
      if (generation === this.generation && owner === sessionClient.context())
        this.setData({ busy: false });
    }
  },
  rights() {
    if (this.projectId) go("welcome", `projectId=${this.projectId}&manage=1`);
  },
  completeExport() {
    if (this.projectId) go("export", `projectId=${this.projectId}`);
  },
  deletion() {
    if (this.projectId) go("deletion-status", `projectId=${this.projectId}`);
  },
  project() {
    if (this.projectId) go("project", `projectId=${this.projectId}`);
  },
  onHide() {
    ++this.generation;
    this.stopSessionWatch?.();
    this.stopSessionWatch = undefined;
    this.setData({ careRequests: [], busy: false });
    audio?.pause();
    this.setData({ playing: "" });
  },
  onUnload() {
    this.onHide();
    audio?.destroy();
    audio = null;
  },
  play(e: E) {
    const r = this.data.recordings.find(
      (r) => r.id === e.currentTarget.dataset.id,
    );
    if (!r) return;
    if (this.data.playing === r.id) {
      audio?.pause();
      this.setData({ playing: "" });
      return;
    }
    audio?.destroy();
    audio = wx.createInnerAudioContext();
    audio.src = r.path;
    audio.onPlay(() => this.setData({ playing: r.id }));
    audio.onTimeUpdate(() =>
      this.setData({
        progress: Math.floor(audio?.currentTime || 0),
        duration: Math.floor(audio?.duration || 0),
      }),
    );
    audio.onEnded(() => this.setData({ playing: "", progress: 0 }));
    audio.onError(() => {
      toast("未能读取这段原声，请重试");
      this.setData({ playing: "" });
    });
    audio.play();
  },
  export() {
    const p = read();
    if (!p) {
      toast("还没有可以导出的资料");
      return;
    }
    const content = JSON.stringify(
        {
          format: "timenook-local-export-v1",
          project: p,
          note: "本文件包含文字与资料索引；原声音频须在本机原声页逐段导出。",
        },
        null,
        2,
      ),
      path = wx.env.USER_DATA_PATH + "/timenook-stories.json";
    wx.getFileSystemManager().writeFile({
      filePath: path,
      data: content,
      encoding: "utf8",
      success: () =>
        wx.shareFileMessage({
          filePath: path,
          fileName: "时光里-我的故事.json",
          fail: () =>
            notify(
              "导出文件已生成",
              "可在当前设备保存。若分享面板不可用，请使用微信开发者工具或真机重试。",
            ),
        }),
      fail: () => toast("导出失败，请检查本机存储空间"),
    });
  },
  exportAudio(e: E) {
    const r = this.data.recordings.find(
      (r) => r.id === e.currentTarget.dataset.id,
    );
    if (r)
      wx.shareFileMessage({
        filePath: r.path,
        fileName: r.id + ".mp3",
        fail: () => toast("未能导出，请在微信真机重试"),
      });
  },
  record() {
    go("interview");
  },
});
