import type {
  FirstCopyContext,
  FirstCopyBlocker,
} from "../../../packages/contracts/src";
import { firstCopyClient } from "../../services/first-copy";
import { sessionClient } from "../../services/session";
import { paymentKey } from "../../services/payments";
import { go } from "../../services/store";
const labels: Record<FirstCopyBlocker, string> = {
  PHYSICAL_PRODUCTION_UNAVAILABLE: "当前项目没有实体书制作权益",
  PRODUCTION_PDF_UNAPPROVED: "书稿等待印前检查",
  BOOK_NOT_READY: "请先生成完整书稿",
  ADDRESS_REQUIRED: "请填写收货地址",
  NARRATOR_CONFIRMATION_REQUIRED: "请重新查询印刷状态",
  INITIATOR_CONFIRMATION_REQUIRED: "请重新查询印刷状态",
  POLICY_PENDING: "套餐制作暂未开放",
  SPECIFICATION_MISMATCH: "当前书稿规格需要调整，请联系客服",
  ENTITLEMENT_UNAVAILABLE: "首本制作权益当前不可用",
  PROJECT_FROZEN: "当前项目已停止制作",
  ALREADY_SUBMITTED: "已提交印刷，可查看制作进度",
};
Page({
  data: {
    context: null as FirstCopyContext | null,
    blockers: [] as string[],
    busy: false,
    status: "",
    unknown: false,
  },
  projectId: "",
  generation: 0,
  intent: null as { input: string; key: string } | null,
  stopSession: undefined as (() => void) | undefined,
  onLoad(q) {
    this.stopSession = sessionClient.onInvalidated(() => {
      ++this.generation;
      this.setData({
        context: null,
        blockers: [],
        busy: false,
        status: "登录已失效，请重新登录",
      });
    });
    this.projectId = q.projectId || "";
  },
  onShow() {
    void this.refresh();
  },
  onHide() {
    ++this.generation;
    this.setData({ context: null, busy: false });
  },
  onUnload() {
    this.stopSession?.();
    this.onHide();
  },
  async refresh() {
    if (this.data.busy) return;
    const n = ++this.generation,
      owner = sessionClient.context();
    this.setData({ busy: true, status: "" });
    try {
      const c = await firstCopyClient.read(this.projectId);
      if (n !== this.generation || owner !== sessionClient.context()) return;
      this.setData({
        context: c,
        blockers: c.blockers
          .filter((b) => b !== "ALREADY_SUBMITTED")
          .map((b) => labels[b]),
        unknown: false,
      });
    } catch (e) {
      if (n === this.generation)
        this.setData({
          status: e instanceof Error ? e.message : "查询未完成，请重试",
        });
    } finally {
      if (n === this.generation) this.setData({ busy: false });
    }
  },
  address() {
    go("address", `projectId=${this.projectId}`);
  },
  preview() {
    const b = this.data.context?.book;
    if (b) go("manuscript", `projectId=${this.projectId}&versionId=${b.id}`);
  },
  book() {
    go("book", `projectId=${this.projectId}`);
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
      this.data.unknown ||
      !c?.canSubmit ||
      !b?.pdf ||
      !c.address.hash
    )
      return;
    const binding = {
      bookVersionId: b.id,
      snapshotHash: b.snapshotHash,
      pdfHash: b.pdf.sha256,
      addressHash: c.address.hash,
    };
    const input = JSON.stringify(binding);
    if (this.intent?.input !== input)
      this.intent = { input, key: paymentKey() };
    const n = this.generation,
      owner = sessionClient.context();
    this.setData({ busy: true, status: "" });
    try {
      const saved = await firstCopyClient.submit(
        this.projectId,
        binding,
        this.intent.key,
      );
      if (n !== this.generation || owner !== sessionClient.context()) return;
      this.setData({ context: saved });
      if (saved.production) {
        this.intent = null;
        go("production", `projectId=${this.projectId}`);
      } else
        this.setData({ status: "提交结果待核实，请查询进度", unknown: true });
    } catch {
      if (n === this.generation)
        this.setData({
          status: "提交结果未确认，请先查询，避免重复提交",
          unknown: true,
        });
    } finally {
      if (n === this.generation) this.setData({ busy: false });
    }
  },
});
