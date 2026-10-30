import { type Project } from "../../domain/model";
import { clear, go, home, list, read, select } from "../../services/store";
import { dataMode } from "../../services/mode";
import { sessionClient } from "../../services/session";
import { projectOverviewClient } from "../../services/project-overview";
import type { ProjectOverview } from "../../../packages/contracts/src";
type E = {
  currentTarget: { dataset: Record<string, string> };
  detail: { value: string };
};
Page({
  data: {
    p: null as Project | null,
    count: 0,
    projects: [] as Project[],
    live: false,
    busy: false,
    status: "",
    overview: null as ProjectOverview | null,
    memberships: [] as { projectId: string; state: string }[],
  },
  exports() {
    if (this.projectId) go("export", `projectId=${this.projectId}`);
  },
  projectId: "",
  generation: 0,
  stopSessionWatch: undefined as (() => void) | undefined,
  expiry: undefined as ReturnType<typeof setTimeout> | undefined,
  onLoad(q) {
    if (dataMode() === "live") {
      this.projectId = q.projectId || projectOverviewClient.selected();
      this.setData({ live: true });
    }
  },
  onHide() {
    if (this.data.live) {
      ++this.generation;
      this.stopSessionWatch?.();
      this.stopSessionWatch = undefined;
      if (this.expiry) clearTimeout(this.expiry);
      this.setData({ overview: null, memberships: [], busy: false });
    }
  },
  onUnload() {
    this.onHide();
  },
  async refresh() {
    await this.onShow();
  },
  async onShow() {
    if (dataMode() === "live") {
      const generation = ++this.generation,
        context = sessionClient.context();
      this.stopSessionWatch?.();
      this.stopSessionWatch = sessionClient.onInvalidated(() => {
        this.onHide();
        this.setData({ status: "登录已失效，请重新登录" });
      });
      this.setData({
        live: true,
        busy: true,
        status: "",
        overview: null,
        memberships: [],
      });
      try {
        const result = await projectOverviewClient.memberships();
        if (
          generation !== this.generation ||
          context !== sessionClient.context()
        )
          return;
        this.setData({ memberships: result.projects });
        if (!result.projects.some((p) => p.projectId === this.projectId))
          this.projectId = result.projects[0]?.projectId ?? "";
        if (!this.projectId) {
          this.setData({ status: "当前账号尚无人生项目，请从邀请或订单进入" });
          return;
        }
        const overview = await projectOverviewClient.read(this.projectId);
        if (
          generation !== this.generation ||
          context !== sessionClient.context()
        )
          return;
        projectOverviewClient.select(this.projectId);
        this.setData({ overview });
        if (overview.accessExpiresAt)
          this.expiry = setTimeout(
            () => {
              if (generation === this.generation) {
                this.onHide();
                this.setData({ status: "资料访问已到期，请重新查询" });
              }
            },
            Math.min(
              2147483647,
              Math.max(0, Date.parse(overview.accessExpiresAt) - Date.now()),
            ),
          );
      } catch (error) {
        if (generation === this.generation)
          this.setData({
            overview: null,
            memberships:
              context === sessionClient.context() ? this.data.memberships : [],
            status:
              context !== sessionClient.context()
                ? "账号已变化，请重新查询项目"
                : error instanceof Error
                  ? error.message
                  : "查询失败，请重试",
          });
      } finally {
        if (generation === this.generation) this.setData({ busy: false });
      }
      return;
    }
    const p = read();
    if (!p) {
      home("home");
      return;
    }
    this.setData({ p, count: p.recordings.length, projects: list() });
  },
  shop() {
    go("home", "browse=1");
  },
  switchProject(e: E) {
    if (this.data.live) {
      const id = e.currentTarget.dataset.id;
      if (!this.data.memberships.some((m) => m.projectId === id)) return;
      this.onHide();
      projectOverviewClient.select(id);
      wx.reLaunch({ url: `/pages/project/index?projectId=${id}` });
      return;
    }
    select(e.currentTarget.dataset.id);
    home();
  },
  order() {
    go("order");
  },
  settings() {
    go("settings", this.data.live ? `projectId=${this.projectId}` : "");
  },
  invite() {
    if (this.data.live && this.data.overview?.role === "narrator") {
      go("welcome", `projectId=${this.projectId}`);
      return;
    }
    go("invite", this.data.live ? `projectId=${this.projectId}` : "");
  },
  service(e: E) {
    go(
      "service",
      "kind=" +
        e.currentTarget.dataset.kind +
        (this.data.live ? `&projectId=${this.projectId}` : ""),
    );
  },
  reset() {
    wx.showModal({
      title: "重新体验",
      content:
        "这会清除当前本机演示项目及其资料索引，其他项目会保留。请先导出需要保留的内容。",
      confirmText: "清除重来",
      success: (r) => {
        if (r.confirm) {
          clear();
          home(read() ? "account" : "home");
        }
      },
    });
  },
  project() {
    if (this.data.live) {
      wx.reLaunch({ url: `/pages/project/index?projectId=${this.projectId}` });
      return;
    }
    home("project");
  },
  book() {
    if (this.data.live) {
      wx.reLaunch({ url: `/pages/book/index?projectId=${this.projectId}` });
      return;
    }
    home("book");
  },
  account() {
    if (this.data.live) {
      wx.reLaunch({ url: `/pages/account/index?projectId=${this.projectId}` });
      return;
    }
    home("account");
  },
});
