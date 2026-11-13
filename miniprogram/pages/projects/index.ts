import type {
  GiftCategory,
  ProjectMembership,
  PaymentOrderView,
} from "../../../packages/contracts/src";
import { paymentClient } from "../../services/payments";
import { sessionClient } from "../../services/session";
import { projectOverviewClient } from "../../services/project-overview";
import { switchProjectTab } from "../../services/navigation";
import { go } from "../../services/navigation";
const categories = [
  { value: "sent", label: "我送出的" },
  { value: "received", label: "我收到的" },
  { value: "participating", label: "我参与的" },
];
type Row = ProjectMembership & {
  description: string;
  detail: string;
  orderId: string;
};
type PendingRow = {
  id: string;
  bookTitle: string;
  description: string;
  detail: string;
};
Page({
  data: {
    categories,
    category: "sent" as GiftCategory,
    pending: [] as PendingRow[],
    rows: [] as Row[],
    selected: "",
    busy: false,
    pageLoading: true,
    status: "",
    switching: false,
    loggedIn: false,
    loginVisible: false,
  },
  generation: 0,
  owner: "",
  projects: [] as ProjectMembership[],
  orders: [] as PaymentOrderView[],
  onLoad(q) {
    this.setData({
      switching: q.switch === "1",
      ...(categories.some((item) => item.value === q.category)
        ? { category: q.category as GiftCategory }
        : {}),
    });
  },
  async onShow() {
    const n = ++this.generation;
    const previous = sessionClient.context();
    if (previous !== this.owner) this.clearProjects();
    this.setData({
      busy: true,
      pageLoading: !this.projects.length && !this.orders.length,
      status: "",
    });
    try {
      const user = await sessionClient.restore();
      if (n !== this.generation) return;
      this.setData({ loggedIn: !!user });
      if (!user) {
        this.clearProjects();
        return;
      }
      const owner = sessionClient.context();
      if (owner !== this.owner) this.clearProjects();
      const [{ projects }, orders] = await Promise.all([
        projectOverviewClient.memberships(),
        paymentClient.list(),
      ]);
      if (n !== this.generation || owner !== sessionClient.context()) return;
      this.owner = owner;
      this.projects = projects;
      this.orders = orders;
      this.showCategory();
    } catch (e) {
      if (n === this.generation) {
        if (this.owner !== sessionClient.context()) this.clearProjects();
        this.setData({
          status: e instanceof Error ? e.message : "礼物未能读取",
        });
      }
    } finally {
      if (n === this.generation)
        this.setData({ busy: false, pageLoading: false });
    }
  },
  clearProjects() {
    this.projects = [];
    this.orders = [];
    this.owner = "";
    this.setData({ rows: [], pending: [], selected: "" });
  },
  showCategory() {
    const category = this.data.category;
    const paidGiftOrders = new Map<string, string>();
    if (category === "sent" && !this.data.switching) {
      for (const order of this.orders) {
        if (
          order.state === "paid" &&
          order.purchaseKind === "gift" &&
          order.project
        )
          paidGiftOrders.set(order.project.id, order.id);
      }
    }
    this.setData({
      rows: this.projects
        .filter((p) => p.categories.includes(category))
        .map((p) => ({
          ...p,
          orderId: paidGiftOrders.get(p.projectId) ?? "",
          description: p.giftRelationship
            ? `${p.giverNickname}送给${p.giftRelationship}的时光故事书`
            : `${p.giverNickname}发起的时光故事书`,
          detail: `${p.isSelfGift ? "送给自己" : category === "received" ? "我是主讲人" : category === "participating" ? "参与记录" : p.giftState === "unissued" ? "待送出" : p.giftState === "unclaimed" ? "待领取" : "已送出"} · ${p.storyCount} 个故事`,
        })),
      pending:
        category === "sent"
          ? this.orders
              .filter((o) => o.state === "pending")
              .map((o) => ({
                id: o.id,
                bookTitle: o.bookTitle,
                description: `${sessionClient.nickname() || "我"}送给${o.recipient.relationshipLabel}的时光故事书`,
                detail: `${o.paymentStatus === "unknown" ? "付款结果待确认" : "待付款"} · ¥${(o.amount / 100).toFixed(o.amount % 100 ? 2 : 0)}`,
              }))
          : [],
      selected: projectOverviewClient.selected(),
    });
  },
  changeCategory(e: WechatMiniprogram.TouchEvent) {
    const category = e.currentTarget.dataset.category as GiftCategory;
    if (!categories.some((item) => item.value === category)) return;
    this.setData({ category });
    if (this.owner && this.owner === sessionClient.context())
      this.showCategory();
  },
  onHide() {
    ++this.generation;
    this.setData({ busy: false });
  },
  onUnload() {
    ++this.generation;
  },
  choose(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id as string;
    if (
      this.owner === sessionClient.context() &&
      this.data.rows.some((p) => p.projectId === id)
    )
      switchProjectTab("home", id);
  },
  payment(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id as string;
    if (
      this.owner === sessionClient.context() &&
      (this.data.pending.some((order) => order.id === id) ||
        this.data.rows.some((project) => project.orderId === id))
    )
      go("order", `id=${id}`);
  },
  login() {
    this.setData({ loginVisible: true });
  },
  closeLogin() {
    this.setData({ loginVisible: false });
  },
  loginSucceeded() {
    this.setData({ loginVisible: false });
    void this.onShow();
  },
  purchase() {
    go("new-book");
  },
  refresh() {
    void this.onShow();
  },
});
