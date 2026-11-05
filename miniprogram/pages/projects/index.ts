import { paymentClient } from "../../services/payments";
import { sessionClient } from "../../services/session";
import { projectOverviewClient } from "../../services/project-overview";
import { switchProjectTab } from "../../services/navigation";
import { go } from "../../services/store";
type Row = { projectId: string; bookTitle: string; origin: string };
Page({
  data: {
    pending: [] as { id: string; bookTitle: string }[],
    rows: [] as Row[],
    selected: "",
    busy: false,
    status: "",
    switching: false,
    loggedIn: false,
  },
  generation: 0,
  onLoad(q) {
    this.setData({ switching: q.switch === "1" });
    wx.setNavigationBarTitle({ title: q.switch === "1" ? "切换项目" : "项目" });
  },
  async onShow() {
    const n = ++this.generation;
    this.setData({ busy: true, status: "", rows: [] });
    try {
      const user = await sessionClient.restore();
      if (n !== this.generation) return;
      this.setData({ loggedIn: !!user });
      if (!user) return;
      const owner = sessionClient.context();
      const [{ projects }, orders] = await Promise.all([
        projectOverviewClient.memberships(),
        paymentClient.list(),
      ]);
      if (n === this.generation && owner === sessionClient.context())
        this.setData({
          pending: orders.filter((o) => o.state === "pending"),
          rows: projects,
          selected: projectOverviewClient.selected(),
        });
    } catch (e) {
      if (n === this.generation)
        this.setData({
          status: e instanceof Error ? e.message : "项目未能读取",
        });
    } finally {
      if (n === this.generation) this.setData({ busy: false });
    }
  },
  onHide() {
    ++this.generation;
    this.setData({ rows: [], pending: [], busy: false });
  },
  choose(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id as string;
    if (this.data.rows.some((p) => p.projectId === id))
      switchProjectTab("home", id);
  },
  payment(e: WechatMiniprogram.TouchEvent) {
    go("order", `id=${e.currentTarget.dataset.id}`);
  },
  login() {
    switchProjectTab("account");
  },
  purchase() {
    go("new-book");
  },
  refresh() {
    void this.onShow();
  },
});
