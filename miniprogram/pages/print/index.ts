import type {
  FirstCopyContext,
  FirstCopyBlocker,
} from "../../../packages/contracts/src";
import { firstCopyClient } from "../../services/first-copy";
import { sessionClient, ApiFailure } from "../../services/session";
import { paymentKey } from "../../services/payments";
import { printIntent, type PrintIntent } from "../../services/print-intent";
import { previewBookPhoto } from "../../services/book-editor";
import { clearPhotoPreviews } from "../../services/story-photos";
import { watchProjectAccess } from "../../services/project-access";
import { go, switchProjectTab } from "../../services/navigation";

const labels: Record<FirstCopyBlocker, string> = {
  PHYSICAL_PRODUCTION_UNAVAILABLE: "当前项目没有实体书制作权益",
  PRODUCTION_PDF_UNAPPROVED: "书稿等待印前检查",
  BOOK_NOT_READY: "请先生成当前书稿 PDF",
  ADDRESS_REQUIRED: "请填写收货地址",
  NARRATOR_CONFIRMATION_REQUIRED: "请重新查询制作状态",
  INITIATOR_CONFIRMATION_REQUIRED: "请重新查询制作状态",
  POLICY_PENDING: "套餐制作暂未开放",
  SPECIFICATION_MISMATCH: "当前书稿规格需要调整，请联系客服",
  ENTITLEMENT_UNAVAILABLE: "首本制作权益当前不可用",
  PROJECT_FROZEN: "当前项目已停止制作",
  ALREADY_SUBMITTED: "已提交，可查看制作进度",
};
Page({
  data: {
    context: null as FirstCopyContext | null,
    blockers: [] as string[],
    busy: false,
    pageLoading: true,
    status: "",
    unknown: false,
    queryComplete: false,
    needsRefresh: false,
    coverImage: "",
    maskedPhone: "",
    pendingIntent: null as PrintIntent | null,
  },
  projectId: "",
  generation: 0,
  intent: null as PrintIntent | null,
  stopSession: undefined as (() => void) | undefined,
  stopAccess: undefined as (() => void) | undefined,
  onLoad(q) {
    this.projectId = q.projectId || "";
    this.intent = printIntent.read(this.projectId);
    this.setData({
      unknown: !!this.intent,
      pendingIntent: this.intent,
      pageLoading: !this.intent,
    });
    this.stopSession = sessionClient.onInvalidated((owner) => {
      printIntent.clear(this.projectId, owner);
      this.clearAccess();
    });
  },
  clearAccess() {
    this.onHide();
    this.intent = null;
    this.setData({
      pendingIntent: null,
      unknown: false,
      status: "项目访问已变化，请重新打开",
    });
  },
  onShow() {
    this.stopAccess?.();
    const owner = sessionClient.context();
    this.stopAccess = watchProjectAccess(
      this.projectId,
      () => owner === sessionClient.context(),
      () => this.clearAccess(),
    );
    if (!this.data.unknown) void this.refresh();
  },
  onHide() {
    ++this.generation;
    this.stopAccess?.();
    this.stopAccess = undefined;
    void clearPhotoPreviews([this.data.coverImage].filter(Boolean));
    this.setData({
      context: null,
      coverImage: "",
      maskedPhone: "",
      blockers: [],
      busy: false,
      pageLoading: false,
      queryComplete: false,
    });
  },
  onUnload() {
    this.stopSession?.();
    this.onHide();
  },
  async refresh() {
    if (this.data.busy) return;
    const n = ++this.generation,
      owner = sessionClient.context();
    this.setData({
      busy: true,
      pageLoading: !this.data.context && !this.intent,
      status: "",
    });
    try {
      const c = await firstCopyClient.read(this.projectId);
      if (n !== this.generation || owner !== sessionClient.context()) return;
      if (c.production && !c.canReviseProduction) {
        printIntent.clear(this.projectId);
        this.intent = null;
        this.setData({ context: c, unknown: false, pendingIntent: null });
        wx.redirectTo({
          url: `/pages/production/index?projectId=${this.projectId}`,
        });
        return;
      }
      this.setData({
        context: c,
        blockers: c.blockers
          .filter((b) => b !== "ALREADY_SUBMITTED")
          .map((b) => labels[b]),
        maskedPhone:
          c.address.value?.phone.replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2") ||
          "",
        unknown: !!this.intent,
        queryComplete: !!this.intent,
        needsRefresh: false,
      });
      if (this.intent) return;
      if (
        !this.intent &&
        c.book?.state === "ready" &&
        !c.address.value &&
        c.shipping.regionCodes.length
      ) {
        wx.redirectTo({
          url: `/pages/address/index?projectId=${this.projectId}`,
        });
        return;
      }
      const photo = c.book?.coverPhotoAccess.allowed
        ? c.book.snapshot.cover.photo
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
          /* The fixed PDF can still be submitted without its thumbnail. */
        }
      }
    } catch (e) {
      if (n === this.generation)
        this.setData({
          status: e instanceof Error ? e.message : "查询未完成，请重试",
        });
    } finally {
      if (n === this.generation)
        this.setData({ busy: false, pageLoading: false });
    }
  },
  address() {
    if (!this.intent)
      go("address", `projectId=${this.projectId}&returnTo=print`);
  },
  preview() {
    const id =
      this.intent?.binding.bookVersionId || this.data.context?.book?.id;
    if (id) go("manuscript", `projectId=${this.projectId}&versionId=${id}`);
  },
  book() {
    go("book", `projectId=${this.projectId}`);
  },
  projectHome() {
    switchProjectTab("home", this.projectId);
  },
  production() {
    go("production", `projectId=${this.projectId}`);
  },
  terms() {
    go("terms");
  },
  async submit() {
    const c = this.data.context,
      b = c?.book;
    if (
      this.data.busy ||
      (this.data.unknown && !this.data.queryComplete) ||
      this.data.needsRefresh ||
      !c
    )
      return;
    if (!this.intent) {
      if (!c.canSubmit || !b?.pdf || !c.address.hash) return;
      this.intent = {
        key: paymentKey(),
        title: b.snapshot.cover.title,
        version: b.version,
        binding: {
          bookVersionId: b.id,
          snapshotHash: b.snapshotHash,
          pdfHash: b.pdf.sha256,
          addressHash: c.address.hash,
        },
      };
      printIntent.save(this.projectId, this.intent);
    }
    const n = this.generation,
      owner = sessionClient.context();
    this.setData({ busy: true, status: "", pendingIntent: this.intent });
    try {
      const saved = await firstCopyClient.submit(
        this.projectId,
        this.intent.binding,
        this.intent.key,
      );
      if (n !== this.generation || owner !== sessionClient.context()) return;
      this.setData({ context: saved });
      if (saved.production) {
        printIntent.clear(this.projectId);
        this.intent = null;
        this.setData({ pendingIntent: null });
        wx.redirectTo({
          url: `/pages/production/index?projectId=${this.projectId}`,
        });
      } else this.setData({ unknown: true, queryComplete: false });
    } catch (e) {
      if (n !== this.generation || owner !== sessionClient.context()) return;
      if (
        e instanceof ApiFailure &&
        [400, 403, 404, 409, 422].includes(e.status)
      ) {
        printIntent.clear(this.projectId);
        this.intent = null;
        this.setData({
          pendingIntent: null,
          unknown: false,
          queryComplete: false,
          needsRefresh: true,
          status: "书稿、地址或制作状态已变化，请重新读取后确认",
        });
      } else this.setData({ unknown: true, queryComplete: false, status: "" });
    } finally {
      if (n === this.generation) this.setData({ busy: false });
    }
  },
});
