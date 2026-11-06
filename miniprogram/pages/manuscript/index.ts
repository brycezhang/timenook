import type { BookVersionView } from "../../../packages/contracts/src";
import { bookClient } from "../../services/books";
import { sessionClient, ApiFailure } from "../../services/session";
import { watchProjectAccess } from "../../services/project-access";
import { go } from "../../services/store";
Page({
  data: {
    version: null as BookVersionView | null,
    busy: false,
    pageLoading: true,
    status: "",
  },
  projectId: "",
  versionId: "",
  generation: 0,
  file: "",
  opening: false,
  stopAccess: undefined as (() => void) | undefined,
  stopSession: undefined as (() => void) | undefined,
  onLoad(q) {
    this.projectId = q.projectId || "";
    this.versionId = q.versionId || "";
    this.stopSession = sessionClient.onInvalidated(() => this.clearAccess());
  },
  clearAccess() {
    this.opening = false;
    this.onHide();
    this.setData({ status: "项目访问已变化，请重新打开" });
  },
  async onShow() {
    if (this.opening) return;
    this.stopAccess?.();
    const owner = sessionClient.context();
    this.stopAccess = watchProjectAccess(
      this.projectId,
      () => owner === sessionClient.context(),
      () => this.clearAccess(),
    );
    await this.perform(async (n, owner) => {
      const v = await bookClient.readVersion(this.projectId, this.versionId);
      if (this.current(n, owner)) this.setData({ version: v });
    });
  },
  removeFile(path: string) {
    if (path)
      wx.getFileSystemManager().unlink({ filePath: path, fail: () => {} });
  },
  onHide() {
    if (this.opening) return;
    this.stopAccess?.();
    this.stopAccess = undefined;
    ++this.generation;
    this.removeFile(this.file);
    this.file = "";
    this.setData({ version: null, busy: false, pageLoading: false });
  },
  onUnload() {
    this.stopSession?.();
    this.opening = false;
    this.onHide();
  },
  current(n: number, owner: string) {
    return n === this.generation && owner === sessionClient.context();
  },
  async perform(work: (n: number, owner: string) => Promise<void>) {
    if (this.data.busy) return;
    const n = this.generation,
      owner = sessionClient.context();
    this.setData({ busy: true, pageLoading: !this.data.version, status: "" });
    try {
      await work(n, owner);
    } catch (e) {
      if (this.current(n, owner))
        this.setData({
          status: e instanceof Error ? e.message : "读取失败，请重试",
        });
    } finally {
      this.opening = false;
      if (this.current(n, owner))
        this.setData({ busy: false, pageLoading: false });
    }
  },
  async openPdf() {
    const version = this.data.version;
    if (!version || version.state !== "ready" || !version.pdf) return;
    const pdf = version.pdf;
    return this.perform(async (generation: number, owner: string) => {
      this.removeFile(this.file);
      this.file = "";
      const result = await sessionClient.downloadBook(
        this.projectId,
        version.id,
      );
      const path = result.tempFilePath;
      try {
        if (!this.current(generation, owner)) return;
        if (result.statusCode !== 200)
          throw new ApiFailure("PDF_UNAVAILABLE", result.statusCode);
        const info =
          await new Promise<WechatMiniprogram.GetFileInfoSuccessCallbackResult>(
            (resolve, reject) =>
              wx.getFileSystemManager().getFileInfo({
                filePath: path,
                digestAlgorithm: "sha256",
                success: resolve,
                fail: reject,
              }),
          );
        if (!this.current(generation, owner)) return;
        if (info.digest !== pdf.sha256 || info.size !== pdf.bytes)
          throw new Error("书稿文件校验失败，请重新下载");
        this.file = path;
        this.opening = true;
        await new Promise<void>((resolve, reject) =>
          wx.openDocument({
            filePath: path,
            fileType: "pdf",
            showMenu: true,
            success: () => resolve(),
            fail: () => reject(new Error("无法打开PDF，请重新下载")),
          }),
        );
        if (this.current(generation, owner))
          this.setData({ status: `已打开第${version.version}版完整 PDF` });
      } finally {
        if (this.file !== path || !this.current(generation, owner)) {
          this.removeFile(path);
          if (this.file === path) this.file = "";
        }
      }
    });
  },

  print() {
    go("print", `projectId=${this.projectId}`);
  },
  edit() {
    go("directory", `projectId=${this.projectId}`);
  },
  refresh() {
    void this.onShow();
  },
});
