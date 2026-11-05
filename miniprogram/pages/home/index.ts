import { demo, go, home, read } from "../../services/store";
import { dataMode } from "../../services/mode";
import { sessionClient } from "../../services/session";
import { projectOverviewClient } from "../../services/project-overview";
import { switchProjectTab } from "../../services/navigation";
type E = {
  currentTarget: { dataset: Record<string, string> };
  detail: { value: string };
};
Page({
  data: {
    hasProject: false,
    mode: dataMode(),
    userId: "",
    status: "",
    busy: false,
  },
  identityVersion: 0,
  autoEnter: false,
  onHide() {
    if (!this.data.busy) ++this.identityVersion;
  },
  onLoad(q) {
    if (dataMode() === "live") {
      this.autoEnter = q.browse !== "1";
      return;
    }
    if (read()?.purchased && q.browse !== "1") home();
  },
  async onShow() {
    // Native login can bring the page foreground before its request completes.
    // The active identity action owns both its result and the busy indicator.
    if (this.data.busy) return;
    const version = ++this.identityVersion;
    const mode = dataMode();
    this.setData({ mode, userId: "", status: "" });
    if (mode === "demo") {
      this.setData({ hasProject: !!read() });
      return;
    }
    try {
      const user = await sessionClient.restore();
      if (version === this.identityVersion)
        this.setData({
          userId: user?.id ?? "",
          status: user ? "已连接服务端账号" : "请使用微信登录",
        });
      if (user && this.autoEnter && version === this.identityVersion) {
        const { projects } = await projectOverviewClient.memberships();
        if (version !== this.identityVersion) return;
        const selected = projectOverviewClient.selected();
        const available = projects.filter((item) => item.state !== "pending");
        const project =
          available.find((item) => item.projectId === selected) ?? available[0];
        if (project) switchProjectTab("project", project.projectId);
      }
    } catch (error) {
      if (version === this.identityVersion)
        this.setData({
          status: error instanceof Error ? error.message : "服务连接失败",
        });
    }
  },
  async login() {
    const version = ++this.identityVersion;
    this.setData({ mode: "live", userId: "", status: "正在登录", busy: true });
    try {
      const result = await sessionClient.login();
      if (version === this.identityVersion)
        this.setData({ userId: result.user.id, status: "已连接服务端账号" });
    } catch (error) {
      if (version === this.identityVersion)
        this.setData({
          status: error instanceof Error ? error.message : "登录失败",
        });
    } finally {
      if (version === this.identityVersion) this.setData({ busy: false });
    }
  },
  async logout() {
    ++this.identityVersion;
    this.setData({ userId: "", busy: true, status: "正在退出" });
    try {
      await sessionClient.logout();
      this.setData({ status: "已退出登录" });
    } catch {
      this.setData({
        status: "本机已退出，服务端撤销未确认；原会话将在到期后失效。",
      });
    } finally {
      this.setData({ busy: false });
    }
  },
  async useDemo() {
    ++this.identityVersion;
    try {
      await sessionClient.enterDemo();
    } catch {
      wx.showToast({ title: "已切换演示，远端退出未确认", icon: "none" });
    }
    home("home");
  },
  // @web-only:start
  accountLink() {
    go("account-link");
  },
  // @web-only:end
  orders() {
    go("order");
  },
  participation() {
    go("welcome");
  },
  catalog() {
    go("purchase");
  },
  project() {
    home();
  },
  account() {
    switchProjectTab("account");
  },
  choose(e: E) {
    go(
      "purchase",
      "recipient=" + encodeURIComponent(e.currentTarget.dataset.recipient),
    );
  },
  experience() {
    demo();
    home();
  },
  privacy() {
    go("service", "kind=privacy");
  },
});
