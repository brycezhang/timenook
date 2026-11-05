import { NATIVE_TABS } from "../../config";
import { sessionClient } from "../../services/session";
import { projectOverviewClient } from "../../services/project-overview";
import { showProjectTab, switchProjectTab } from "../../services/navigation";
import { go } from "../../services/store";
import type { ProjectOverview } from "../../../packages/contracts/src";
Page({
  data: {
    nativeTabs: NATIVE_TABS,
    busy: false,
    status: "",
    overview: null as ProjectOverview | null,
    count: 0,
  },
  generation: 0,
  onLoad() {},
  async onShow() {
    showProjectTab(this, "home");
    const generation = ++this.generation;
    this.setData({ busy: true, status: "", overview: null });
    try {
      if (!(await sessionClient.restore())) return;
      const owner = sessionClient.context();
      const { projects } = await projectOverviewClient.memberships();
      const selected =
        projects.find(
          (p) => p.projectId === projectOverviewClient.selected(),
        ) ?? projects[0];
      if (!selected || generation !== this.generation) return;
      const overview = await projectOverviewClient.read(selected.projectId);
      if (generation !== this.generation || owner !== sessionClient.context())
        return;
      projectOverviewClient.select(selected.projectId);
      this.setData({ overview, count: projects.length });
    } catch (e) {
      if (generation === this.generation)
        this.setData({
          status: e instanceof Error ? e.message : "项目未能读取，请重试",
        });
    } finally {
      if (generation === this.generation) this.setData({ busy: false });
    }
  },
  onHide() {
    ++this.generation;
    this.setData({ overview: null, busy: false });
  },
  onUnload() {
    this.onHide();
  },
  refresh() {
    void this.onShow();
  },
  purchase() {
    go("new-book");
  },
  switchProject() {
    go("projects", "switch=1");
  },
  record() {
    const p = this.data.overview;
    if (p?.canRecord) go("interview", `projectId=${p.projectId}`);
  },
  stories() {
    const p = this.data.overview;
    if (p) go("stories", `projectId=${p.projectId}`);
  },
  book() {
    const p = this.data.overview;
    if (p) go("book", `projectId=${p.projectId}`);
  },
  invite() {
    const p = this.data.overview;
    if (p?.canInvite) go("invite", `projectId=${p.projectId}`);
  },
  terms() {
    go("terms");
  },
  account() {
    switchProjectTab("account");
  },
});
