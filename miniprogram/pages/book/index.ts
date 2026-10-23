import { type Project } from "../../domain/model";
import { asset, go, home, read } from "../../services/store";
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
    live: false,
    overview: null as ProjectOverview | null,
    liveStories: [] as ProjectOverview["stories"],
    busy: false,
    status: "",
    p: null as Project | null,
    stories: [] as Project["stories"],
    pending: 0,
    bookImage: "",
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
      this.setData({ overview: null, liveStories: [], busy: false });
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
        overview: null,
        liveStories: [],
        busy: true,
        status: "",
      });
      try {
        const overview = await projectOverviewClient.read(this.projectId);
        if (
          generation !== this.generation ||
          context !== sessionClient.context()
        )
          return;
        this.setData({
          overview,
          liveStories: overview.stories.filter(
            (s) => s.decision?.confirmed && s.decision.allowInBook,
          ),
        });
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
            status: error instanceof Error ? error.message : "查询失败，请重试",
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
    this.setData({
      p,
      bookImage: asset(p),
      stories: p.stories.filter((s) => s.included),
      pending: p.stories.filter(
        (s) => s.included && s.confirmedVersion !== s.version,
      ).length,
    });
  },
  manuscript() {
    go("manuscript");
  },
  story(e: E) {
    if (this.data.live) {
      go(
        "story",
        `projectId=${this.projectId}&storyId=${e.currentTarget.dataset.id}`,
      );
      return;
    }
    go("story", "id=" + e.currentTarget.dataset.id);
  },
  print() {
    go("print");
  },
  settings() {
    go("settings", this.data.live ? `projectId=${this.projectId}` : "");
  },
  record() {
    go("interview", this.data.live ? `projectId=${this.projectId}` : "");
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
