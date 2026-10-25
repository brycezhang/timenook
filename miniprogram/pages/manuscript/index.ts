import { type Project } from "../../domain/model";
import { go, required, save, toast } from "../../services/store";
import { dataMode } from "../../services/mode";
import { sessionClient, ApiFailure } from "../../services/session";
import { bookClient } from "../../services/books";
import type { BookVersionView } from "../../../packages/contracts/src";
type E = {
  currentTarget: { dataset: Record<string, string> };
  detail: { value: string };
};
Page({
  data: {
    live: false,
    version: null as BookVersionView | null,
    busy: false,
    status: "",
    p: null as Project | null,
    stories: [] as Project["stories"],
    pending: 0,
    content: false,
    layout: false,
  },
  projectId: "",
  versionId: "",
  generation: 0,
  file: "",
  expiry: undefined as ReturnType<typeof setTimeout> | undefined,
  stopSessionWatch: undefined as (() => void) | undefined,
  onLoad(q) {
    this.onHide();
    ++this.generation;
    this.projectId = q.projectId || "";
    this.versionId = q.versionId || "";
    if (dataMode() === "live") this.setData({ live: true });
  },
  removeFile(path: string) {
    if (path)
      wx.getFileSystemManager().unlink({ filePath: path, fail: () => {} });
  },
  onHide() {
    if (!this.data.live) return;
    ++this.generation;
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = undefined;
    this.stopSessionWatch?.();
    this.stopSessionWatch = undefined;
    this.removeFile(this.file);
    this.file = "";
    this.setData({ version: null, busy: false });
  },
  onUnload() {
    this.onHide();
  },
  accessExpired() {
    const value = this.data.version?.accessExpiresAt;
    return !!value && Date.parse(value) <= Date.now();
  },
  current(generation: number, owner: string) {
    return (
      generation === this.generation &&
      dataMode() === "live" &&
      owner === sessionClient.context() &&
      !this.accessExpired()
    );
  },
  watch(owner: string) {
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = setTimeout(() => {
      if (
        dataMode() !== "live" ||
        owner !== sessionClient.context() ||
        (this.data.version?.accessExpiresAt &&
          Date.parse(this.data.version.accessExpiresAt) <= Date.now())
      ) {
        this.onHide();
        this.setData({ status: "授权已到期或账号已变化，请重新查询" });
        return;
      }
      this.watch(owner);
    }, 1000);
  },
  async perform(work: (generation: number, owner: string) => Promise<void>) {
    if (this.data.busy) return;
    if (this.accessExpired()) {
      this.onHide();
      this.setData({ status: "资料访问已到期，请重新查询" });
      return;
    }
    const generation = ++this.generation,
      owner = sessionClient.context();
    this.setData({ busy: true, status: "" });
    try {
      await work(generation, owner);
      if (generation === this.generation && owner !== sessionClient.context()) {
        this.onHide();
        this.setData({ status: "账号已变化，请重新查询" });
      }
    } catch (error) {
      if (generation !== this.generation) return;
      if (
        owner !== sessionClient.context() ||
        (error instanceof ApiFailure && [401, 403].includes(error.status))
      ) {
        this.onHide();
        this.setData({ status: "授权已失效或账号已变化，请重新查询" });
      } else {
        this.removeFile(this.file);
        this.file = "";
        this.setData({
          version: null,
          status:
            error instanceof Error ? error.message : "书稿操作失败，请重新查询",
        });
      }
    } finally {
      if (generation === this.generation && this.accessExpired()) {
        this.onHide();
        this.setData({ status: "资料访问已到期，请重新查询" });
      }
      if (generation === this.generation) this.setData({ busy: false });
    }
  },
  async refresh() {
    return this.onShow();
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
  book() {
    go("book", `projectId=${this.projectId}`);
  },
  async onShow() {
    if (dataMode() === "live") {
      this.setData({ live: true, version: null });
      this.stopSessionWatch?.();
      this.stopSessionWatch = sessionClient.onInvalidated(() => {
        this.onHide();
        this.setData({ status: "登录已失效，请重新登录" });
      });
      return this.perform(async (generation: number, owner: string) => {
        const value = await bookClient.readVersion(
          this.projectId,
          this.versionId,
        );
        if (!this.current(generation, owner)) return;
        if (
          value.accessExpiresAt &&
          Date.parse(value.accessExpiresAt) <= Date.now()
        )
          throw new Error("资料访问已到期");
        this.setData({
          version: value,
          status:
            value.state === "obsolete"
              ? "内容已变化，请返回重新生成书稿"
              : value.state !== "ready"
                ? "书稿尚未生成完成，请返回查看状态"
                : "",
        });
        this.watch(owner);
      });
    }
    const p = required();
    this.setData({
      p,
      stories: p.stories.filter((s) => s.included),
      pending: p.stories.filter(
        (s) => s.included && s.confirmedVersion !== s.version,
      ).length,
      content: p.contentApproved === p.revision,
      layout: p.layoutApproved === p.revision,
    });
  },
  content() {
    this.setData({ content: !this.data.content });
  },
  layout() {
    this.setData({ layout: !this.data.layout });
  },
  approve() {
    if (this.data.live) return;
    const p = required();
    if (
      !p.stories.some((s) => s.included) ||
      p.stories.some((s) => s.included && s.confirmedVersion !== s.version)
    ) {
      toast("请先完成每篇故事的本人确认");
      return;
    }
    if (!this.data.content || !this.data.layout) return;
    p.contentApproved = p.revision;
    p.layoutApproved = p.revision;
    save(p);
    go("print");
  },
  story(e: E) {
    go("story", "id=" + e.currentTarget.dataset.id);
  },
});
