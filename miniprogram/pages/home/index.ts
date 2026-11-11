import { NATIVE_TABS } from "../../config";
import { ApiFailure, sessionClient } from "../../services/session";
import { projectOverviewClient } from "../../services/project-overview";
import { recordingId } from "../../services/local-audio-recorder";
import { showProjectTab, switchProjectTab } from "../../services/navigation";
import { go } from "../../services/store";
import type { ProjectOverview } from "../../../packages/contracts/src";
Page({
  data: {
    nativeTabs: NATIVE_TABS,
    pageLoading: true,
    busy: false,
    status: "",
    overview: null as ProjectOverview | null,
    count: 0,
    loggedIn: false,
    loginVisible: false,
  },
  generation: 0,
  ownerContext: "",
  loginDestination: "home",
  onLoad() {},
  async onShow() {
    showProjectTab(this, "home");
    const generation = ++this.generation;
    const owner = sessionClient.context();
    const selectedId = projectOverviewClient.selected();
    if (
      !owner ||
      owner !== this.ownerContext ||
      (selectedId && selectedId !== this.data.overview?.projectId)
    ) {
      this.setData({ overview: null, count: 0 });
      wx.pageScrollTo({ scrollTop: 0, duration: 0 });
    }
    this.ownerContext = owner;
    this.setData({
      busy: !!owner && !this.data.overview,
      status: "",
      loggedIn: !!owner,
    });
    try {
      if (!(await sessionClient.restore())) {
        if (generation === this.generation)
          this.setData({ overview: null, count: 0, loggedIn: false });
        return;
      }
      if (generation !== this.generation || owner !== sessionClient.context())
        return;
      const { projects } = await projectOverviewClient.memberships();
      const selected =
        projects.find(
          (p) => p.projectId === projectOverviewClient.selected(),
        ) ?? projects[0];
      if (generation !== this.generation || owner !== sessionClient.context())
        return;
      if (!selected) {
        this.setData({ overview: null, count: 0 });
        return;
      }
      const overview = await projectOverviewClient.read(selected.projectId);
      if (generation !== this.generation || owner !== sessionClient.context())
        return;
      projectOverviewClient.select(selected.projectId);
      this.setData({ overview, count: projects.length });
    } catch (e) {
      if (generation === this.generation) {
        if (
          owner !== sessionClient.context() ||
          (e instanceof ApiFailure && [401, 403].includes(e.status))
        )
          this.setData({
            overview: null,
            count: 0,
            loggedIn: !!sessionClient.context(),
          });
        this.setData({
          status: e instanceof Error ? e.message : "项目未能读取，请重试",
        });
      }
    } finally {
      if (generation === this.generation)
        this.setData({ busy: false, pageLoading: false });
    }
  },
  onHide() {
    ++this.generation;
  },
  onUnload() {
    this.onHide();
  },
  refresh() {
    void this.onShow();
  },
  purchase() {
    if (sessionClient.context()) go("new-book");
    else {
      this.loginDestination = "new-book";
      this.setData({ loginVisible: true });
    }
  },
  login() {
    this.loginDestination = "home";
    this.setData({ loginVisible: true });
  },
  loginSucceeded() {
    this.setData({ loginVisible: false, loggedIn: true, status: "" });
    if (this.loginDestination === "new-book") go("new-book");
    else void this.onShow();
  },
  closeLogin() {
    this.loginDestination = "home";
    this.setData({ loginVisible: false });
  },
  switchProject() {
    go("projects", "switch=1");
  },
  record() {
    const p = this.data.overview;
    if (p?.canRecord)
      go("interview", `projectId=${p.projectId}&draftId=${recordingId()}`);
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
  sample() {
    go("sample");
  },
  terms() {
    go("terms");
  },
  account() {
    switchProjectTab("account");
  },
});
