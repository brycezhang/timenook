import { participationClient } from "../../services/participation";
import type {
  FulfillmentView,
  FulfillmentGrantCommand,
} from "../../../packages/contracts/src";
import { fulfillmentClient } from "../../services/fulfillment";
import { dataMode } from "../../services/mode";
import { sessionClient, ApiFailure } from "../../services/session";
import { paymentKey } from "../../services/payments";
import { go } from "../../services/store";
const stageLabels = {
  approved: "已审核，等待交接",
  handoff_pending: "交接结果待核实",
  in_production: "印厂已确认接单，正在制作",
  shipped: "已发货",
  delivered: "已交付",
  cancellation_pending: "取消待人工核实",
  cancelled: "本次生产已确认取消",
};
Page({
  data: {
    view: null as FulfillmentView | null,
    stageLabel: "",
    cancellationNotice: "",
    busy: false,
    status: "",
    grantMinutes: "10",
    grantEvidence: "",
    grantChecked: false,
    canGrant: false,
  },
  remoteAccessEpoch: -1,
  projectId: "",
  assistedSessionId: "",
  intent: null as {
    input: string;
    key: string;
    body: FulfillmentGrantCommand;
  } | null,
  generation: 0,
  active: false,
  owner: "",
  expiry: undefined as ReturnType<typeof setTimeout> | undefined,
  stopSessionWatch: undefined as (() => void) | undefined,
  onLoad(q) {
    this.projectId = q.projectId || "";
    this.assistedSessionId = q.assistedSessionId || "";
  },
  onHide() {
    this.remoteAccessEpoch = -1;
    this.active = false;
    ++this.generation;
    this.owner = "";
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = undefined;
    this.stopSessionWatch?.();
    this.stopSessionWatch = undefined;
    this.intent = null;
    this.setData({
      view: null,
      stageLabel: "",
      cancellationNotice: "",
      busy: false,
      canGrant: false,
      grantChecked: false,
      grantEvidence: "",
    });
  },
  onUnload() {
    this.onHide();
  },
  async onShow() {
    this.active = true;
    this.stopSessionWatch?.();
    this.stopSessionWatch = sessionClient.onInvalidated(() => {
      this.onHide();
      this.setData({ status: "登录已失效，请重新登录" });
    });
    return this.refresh();
  },
  accessExpired() {
    const expiresAt = this.data.view?.accessExpiresAt;
    return !!expiresAt && Date.parse(expiresAt) <= Date.now();
  },
  current(generation: number, owner: string) {
    return (
      this.active &&
      generation === this.generation &&
      dataMode() === "live" &&
      !!owner &&
      owner === sessionClient.context() &&
      !this.accessExpired()
    );
  },
  watch(generation: number, owner: string) {
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = setTimeout(
      async () => {
        if (generation !== this.generation || !this.active) return;
        if (!this.current(generation, owner)) {
          this.onHide();
          this.setData({ status: "授权已到期或账号已变化，请重新查询" });
          return;
        }
        try {
          const permission = await participationClient.state(this.projectId);
          if (generation !== this.generation) return;
          if (
            !permission.canRead ||
            (this.remoteAccessEpoch >= 0 &&
              permission.accessEpoch !== this.remoteAccessEpoch)
          )
            throw Error("authorization changed");
          this.remoteAccessEpoch = permission.accessEpoch;
        } catch {
          if (generation !== this.generation) return;
          this.onHide();
          this.setData({
            status: "当前访问或用途授权已变化，私人内容已清理，请重新查询",
          });
          return;
        }
        this.watch(generation, owner);
      },
      Math.max(
        1,
        Math.min(
          1000,
          this.data.view?.accessExpiresAt
            ? Date.parse(this.data.view.accessExpiresAt) - Date.now()
            : 1000,
        ),
      ),
    );
  },
  async refresh() {
    if (this.data.busy) return;
    const generation = ++this.generation,
      owner = sessionClient.context();
    this.owner = owner;
    this.intent = null;
    this.setData({
      view: null,
      stageLabel: "",
      cancellationNotice: "",
      busy: true,
      status: "",
      canGrant: false,
      grantChecked: false,
      grantEvidence: "",
    });
    try {
      if (dataMode() !== "live" || !owner)
        throw new Error("请在真实服务模式登录后查询生产与物流");
      const value = await fulfillmentClient.read(this.projectId);
      if (!this.current(generation, owner)) return;
      if (
        value.accessExpiresAt &&
        Date.parse(value.accessExpiresAt) <= Date.now()
      )
        throw new Error("授权已到期，请重新查询");
      this.accept(value);
      this.watch(generation, owner);
    } catch (error) {
      if (generation !== this.generation) return;
      this.setData({
        status:
          error instanceof ApiFailure && [401, 403, 404].includes(error.status)
            ? "当前账号无权查询，或授权已失效，请重新登录或查询"
            : error instanceof Error
              ? error.message
              : "生产与物流查询未完成，请重试",
      });
    } finally {
      if (generation === this.generation) this.setData({ busy: false });
    }
  },
  accept(value: FulfillmentView) {
    this.setData({
      view: value,
      stageLabel: value.current
        ? stageLabels[value.current.state]
        : "尚未安排生产交接",
      cancellationNotice: value.current?.cancellationNotice || "",
      canGrant:
        value.canGrant && (value.canGrantNarrator || !!this.assistedSessionId),
      grantChecked: false,
      grantEvidence: "",
      grantMinutes: String(Math.min(10, value.grantMaxMinutes)),
    });
  },
  chooseGrant() {
    if (!this.data.busy)
      this.setData({ grantChecked: !this.data.grantChecked });
  },
  grantInput(e: {
    currentTarget: { dataset: { field: string } };
    detail: { value: string };
  }) {
    if (
      this.data.busy ||
      !["grantMinutes", "grantEvidence"].includes(e.currentTarget.dataset.field)
    )
      return;
    this.intent = null;
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value });
  },
  async grant() {
    const value = this.data.view,
      attempt = value?.current;
    if (this.data.busy || !value || !attempt || !this.data.canGrant) return;
    if (!this.current(this.generation, this.owner)) {
      this.onHide();
      this.setData({ status: "授权已到期或账号已变化，请重新查询" });
      return;
    }
    const minutes = Number(this.data.grantMinutes),
      evidence = this.data.grantEvidence.trim();
    if (
      !this.data.grantChecked ||
      !Number.isInteger(minutes) ||
      minutes < 1 ||
      minutes > value.grantMaxMinutes ||
      !/^[^\r\n]{3,160}$/.test(evidence)
    ) {
      this.setData({
        status: `请明确选择，并填写1至${value.grantMaxMinutes}分钟及本次独立授权说明`,
      });
      return;
    }
    const input = JSON.stringify({ attemptId: attempt.id, minutes, evidence });
    if (this.intent?.input !== input)
      this.intent = {
        input,
        key: paymentKey(),
        body: {
          attemptId: attempt.id,
          bookVersionId: attempt.bookVersionId,
          snapshotHash: attempt.snapshotHash,
          pdfHash: attempt.pdfHash,
          addressHash: attempt.addressHash,
          expiresAt: new Date(Date.now() + minutes * 60000).toISOString(),
          noticeVersion: "synthetic-d08-v1",
          evidenceRef: `synthetic:${evidence}`,
          ...(this.assistedSessionId
            ? { assistedSessionId: this.assistedSessionId }
            : {}),
        },
      };
    if (Date.parse(this.intent.body.expiresAt) <= Date.now()) {
      this.setData({ status: "本次授权时限已到，请重新查询后授权" });
      return;
    }
    const generation = ++this.generation,
      owner = this.owner;
    this.setData({ busy: true, status: "" });
    try {
      const saved = await fulfillmentClient.grant(
        this.projectId,
        this.intent.body,
        this.intent.key,
      );
      if (!this.current(generation, owner)) return;
      if (
        saved.accessExpiresAt &&
        Date.parse(saved.accessExpiresAt) <= Date.now()
      )
        throw new Error("授权已到期，请重新查询");
      this.intent = null;
      this.accept(saved);
      this.setData({
        status:
          "本次生产资料限时授权已记录。只向本工单负责人提供确定 PDF 和配送地址。",
      });
      this.watch(generation, owner);
    } catch (error) {
      if (generation !== this.generation) return;
      if (
        !this.current(generation, owner) ||
        (error instanceof ApiFailure && [401, 403, 404].includes(error.status))
      ) {
        this.onHide();
        this.setData({ status: "授权已到期或账号已变化，请重新查询" });
      } else
        this.setData({
          status: "授权结果未确定，请重新查询或重试；重试沿用本次标识和时限。",
        });
    } finally {
      if (generation === this.generation && !this.current(generation, owner)) {
        this.onHide();
        this.setData({ status: "授权已到期或账号已变化，请重新查询" });
      }
      if (generation === this.generation) this.setData({ busy: false });
    }
  },
  assist() {
    const attempt = this.data.view?.current;
    if (
      attempt &&
      !this.data.busy &&
      this.data.view?.canGrant &&
      !this.data.view.canGrantNarrator
    )
      go(
        "assisted",
        `projectId=${this.projectId}&bookVersionId=${attempt.bookVersionId}&purpose=book_confirmation&returnTo=production`,
      );
  },
  reviseProduction() {
    if (this.data.busy || this.data.view?.current?.state !== "cancelled")
      return;
    if (!this.current(this.generation, this.owner)) {
      this.onHide();
      this.setData({ status: "授权已到期或账号已变化，请重新查询" });
      return;
    }
    go("print", `projectId=${this.projectId}`);
  },
  book() {
    go("book", `projectId=${this.projectId}`);
  },
});
