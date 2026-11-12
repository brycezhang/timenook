import type {
  BookVersionView,
  FulfillmentView,
} from "../../../packages/contracts/src";
import { fulfillmentClient } from "../../services/fulfillment";
import { bookClient } from "../../services/books";
import { sessionClient } from "../../services/session";
import { previewBookPhoto } from "../../services/book-editor";
import { clearPhotoPreviews } from "../../services/story-photos";
import { watchProjectAccess } from "../../services/project-access";
import { go, switchProjectTab } from "../../services/navigation";

const labels = {
  approved: "已提交，等待制作",
  handoff_pending: "正在核实制作安排",
  in_production: "书籍制作中",
  shipped: "书籍已寄出",
  delivered: "书籍已送达",
  cancellation_pending: "正在核实取消结果",
  cancelled: "制作已取消",
};
Page({
  data: {
    view: null as FulfillmentView | null,
    book: null as BookVersionView | null,
    label: "",
    screen: "production",
    coverImage: "",
    maskedPhone: "",
    busy: false,
    pageLoading: true,
    status: "",
    steps: [] as { title: string; caption: string; done: boolean }[],
  },
  projectId: "",
  generation: 0,
  stopSession: undefined as (() => void) | undefined,
  stopAccess: undefined as (() => void) | undefined,
  onLoad(q) {
    this.projectId = q.projectId || "";
    this.stopSession = sessionClient.onInvalidated(() => this.clearAccess());
  },
  clearAccess() {
    this.onHide();
    this.setData({ label: "", status: "项目访问已变化，请重新打开" });
  },
  onShow() {
    this.stopAccess?.();
    const owner = sessionClient.context();
    this.stopAccess = watchProjectAccess(
      this.projectId,
      () => owner === sessionClient.context(),
      () => this.clearAccess(),
    );
    void this.refresh();
  },
  onHide() {
    this.stopAccess?.();
    this.stopAccess = undefined;
    ++this.generation;
    void clearPhotoPreviews([this.data.coverImage].filter(Boolean));
    this.setData({
      view: null,
      book: null,
      coverImage: "",
      maskedPhone: "",
      steps: [],
      busy: false,
      pageLoading: false,
    });
  },
  onUnload() {
    this.stopSession?.();
    this.onHide();
  },
  async onPullDownRefresh() {
    await this.refresh();
    wx.stopPullDownRefresh();
  },
  accept(view: FulfillmentView) {
    const attempt = view.current,
      state = attempt?.state;
    const screen =
      state === "cancelled"
        ? "cancelled"
        : state === "shipped"
          ? "shipped"
          : state === "delivered"
            ? "delivered"
            : "production";
    const stage =
      state === "delivered"
        ? 3
        : attempt?.tracking
          ? 2
          : state === "in_production" ||
              attempt?.printedAt ||
              attempt?.records?.some((r) => r.kind === "receipt_accepted")
            ? 1
            : 0;
    this.setData({
      view,
      screen,
      label: attempt
        ? attempt.printedAt && state === "in_production"
          ? "已印好，等待寄出"
          : labels[attempt.state]
        : view.reservation
          ? "已提交，等待制作"
          : "还未提交制作",
      maskedPhone:
        view.deliveryAddress?.phone.replace(
          /^(\d{3})\d{4}(\d{4})$/,
          "$1****$2",
        ) || "",
      steps: ["已提交制作", "正在制作", "已寄出", "已送达"].map(
        (title, index) => ({
          title,
          done: !!view.reservation && index <= stage,
          caption:
            index > stage
              ? "等待后续进度"
              : index === stage && index > 0
                ? "当前进度"
                : "已完成",
        }),
      ),
    });
  },
  async refresh() {
    if (this.data.busy) return;
    const n = ++this.generation,
      owner = sessionClient.context();
    this.setData({ busy: true, pageLoading: !this.data.view, status: "" });
    try {
      const view = await fulfillmentClient.read(this.projectId);
      if (n !== this.generation || owner !== sessionClient.context()) return;
      this.accept(view);
      const fixedId =
        view.current?.bookVersionId || view.reservation?.bookVersionId;
      if (fixedId && this.data.book?.id !== fixedId) {
        void clearPhotoPreviews([this.data.coverImage].filter(Boolean));
        this.setData({ book: null, coverImage: "" });
        const book = await bookClient.readProduction(this.projectId);
        if (n !== this.generation || owner !== sessionClient.context()) return;
        this.setData({ book });
      }
      const photo = this.data.book?.coverPhotoAccess.allowed
        ? this.data.book.snapshot.cover.photo
        : null;
      if (photo && !this.data.coverImage) {
        try {
          const path = await previewBookPhoto(
            this.projectId,
            photo,
            () => n === this.generation && owner === sessionClient.context(),
          );
          if (n !== this.generation || owner !== sessionClient.context()) {
            await clearPhotoPreviews([path]);
            return;
          }
          this.setData({ coverImage: path });
        } catch {
          /* Progress and the fixed PDF remain available without a thumbnail. */
        }
      }
    } catch (e) {
      if (n === this.generation)
        this.setData({
          status: e instanceof Error ? e.message : "未能读取进度",
        });
    } finally {
      if (n === this.generation)
        this.setData({ busy: false, pageLoading: false });
    }
  },
  projectHome() {
    switchProjectTab("home", this.projectId);
  },
  book() {
    go("book", `projectId=${this.projectId}`);
  },
  print() {
    go("print", `projectId=${this.projectId}`);
  },
  preview() {
    const id =
      this.data.view?.current?.bookVersionId ||
      this.data.view?.reservation?.bookVersionId;
    if (id)
      go(
        "manuscript",
        `projectId=${this.projectId}&versionId=${id}&production=1`,
      );
  },
  record() {
    go("interview", `projectId=${this.projectId}`);
  },
  copyTracking() {
    const number = this.data.view?.current?.tracking?.number;
    if (number) wx.setClipboardData({ data: number });
  },
});
