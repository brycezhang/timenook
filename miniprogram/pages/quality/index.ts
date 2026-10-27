import type {
  OrderQualityView,
  QualityRequestView,
  QualityReason,
  QualityAccessCommand,
  QualityScope,
} from "../../../packages/contracts/src";
import {
  qualityClient,
  qualityReasonLabels,
  qualityStateLabels,
} from "../../services/quality";
import { sessionClient, ApiFailure } from "../../services/session";
import { paymentKey } from "../../services/payments";
import { dataMode } from "../../services/mode";
import { participationClient } from "../../services/participation";
import { go } from "../../services/store";
type E = {
  currentTarget: { dataset: Record<string, string> };
  detail: { value: string };
};
type Row = QualityRequestView & {
  stateLabel: string;
  reasonLabel: string;
  dueLabel: string;
  grantLabel: string;
};
function dateLabel(value: string | null) {
  return value ? `${new Date(value).toLocaleString("zh-CN")}（设备时间）` : "";
}
Page({
  data: {
    view: null as OrderQualityView | null,
    rows: [] as Row[],
    attempts: [] as { id: string; label: string }[],
    selectedId: "",
    attemptId: "",
    description: "",
    reason: "qualityDamaged" as QualityReason,
    options: Object.entries(qualityReasonLabels).map(([reason, label]) => ({
      reason,
      label,
    })),
    busy: false,
    status: "",
    selected: null as Row | null,
    accessChoice: false,
    canGrant: false,
    canAssist: false,
    grantChecked: false,
    pdfScope: false,
    evidenceScope: false,
    grantMinutes: "10",
  },
  orderId: "",
  projectId: "",
  active: false,
  generation: 0,
  assistedSessionId: "",
  ownerContext: "",
  permissionEpoch: -1,
  contentPermitted: null as boolean | null,
  stopWatch: undefined as (() => void) | undefined,
  timer: undefined as ReturnType<typeof setTimeout> | undefined,
  intent: null as { input: string; key: string } | null,
  grantIntent: null as {
    input: string;
    key: string;
    body: QualityAccessCommand;
  } | null,
  refundIntent: null as {
    input: string;
    key: string;
    expectedVersion: number;
  } | null,
  onLoad(q) {
    this.orderId = q.orderId || "";
    this.projectId = q.projectId || "";
    this.assistedSessionId = q.assistedSessionId || "";
    this.setData({ selectedId: q.requestId || "" });
  },
  onHide() {
    this.active = false;
    ++this.generation;
    this.stopWatch?.();
    this.stopWatch = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.intent = null;
    this.grantIntent = null;
    this.refundIntent = null;
    this.ownerContext = "";
    this.permissionEpoch = -1;
    this.contentPermitted = null;
    this.setData({
      view: null,
      rows: [],
      attempts: [],
      description: "",
      busy: false,
      selectedId: "",
      selected: null,
      accessChoice: false,
      canGrant: false,
      canAssist: false,
      grantChecked: false,
      pdfScope: false,
      evidenceScope: false,
    });
  },
  onUnload() {
    this.onHide();
  },
  async onShow() {
    this.active = true;
    this.ownerContext = sessionClient.context();
    this.stopWatch?.();
    this.stopWatch = sessionClient.onInvalidated(() => {
      this.onHide();
      this.setData({ status: "登录已失效，请重新登录" });
    });
    return this.refresh();
  },
  current(generation: number, owner: string) {
    return (
      this.active &&
      dataMode() === "live" &&
      generation === this.generation &&
      !!owner &&
      owner === this.ownerContext &&
      owner === sessionClient.context()
    );
  },
  finish(generation: number, owner: string) {
    if (generation !== this.generation || !this.active) return;
    if (!this.current(generation, owner)) {
      this.onHide();
      this.setData({ status: "账号或登录已变化，售后资料已清理" });
    } else {
      this.setData({ busy: false });
      this.watch(generation, owner);
    }
  },
  show(view: OrderQualityView, preferredId?: string) {
    const rows = view.requests.map((request) => ({
      ...request,
      grant:
        request.grant && Date.parse(request.grant.expiresAt) > Date.now()
          ? request.grant
          : null,
      stateLabel: qualityStateLabels[request.state],
      reasonLabel: qualityReasonLabels[request.reason],
      dueLabel: dateLabel(request.dueAt),
      grantLabel:
        request.grant && Date.parse(request.grant.expiresAt) > Date.now()
          ? dateLabel(request.grant.expiresAt)
          : "",
    }));
    const preferred = preferredId ?? this.data.selectedId;
    const selectedId = view.requests.some((request) => request.id === preferred)
      ? preferred
      : view.requests[0]?.id || "";
    const changed = selectedId !== this.data.selectedId;
    if (changed) {
      this.grantIntent = null;
      this.refundIntent = null;
      if (this.data.selectedId) this.assistedSessionId = "";
    }
    this.setData({
      view,
      attempts: view.attempts.map((attempt) => ({
        id: attempt.id,
        label: `第${attempt.sequence}次制作 · 书稿第${attempt.bookVersion}版 · ${dateLabel(attempt.deliveredAt)}签收`,
      })),
      attemptId: view.attempts.some(
        (attempt) => attempt.id === this.data.attemptId,
      )
        ? this.data.attemptId
        : view.attempts[0]?.id || "",
      rows,
      selectedId,
      selected: rows.find((request) => request.id === selectedId) || null,
      ...(changed
        ? {
            accessChoice: false,
            canGrant: false,
            canAssist: false,
            grantChecked: false,
            pdfScope: false,
            evidenceScope: false,
            grantMinutes: "10",
          }
        : {}),
    });
  },
  async refresh() {
    if (this.data.busy) return;
    const generation = ++this.generation,
      owner = sessionClient.context();
    this.setData({ busy: true, status: "" });
    try {
      const view = await qualityClient.list(this.orderId);
      if (!this.current(generation, owner)) return;
      this.show(view);
      this.watch(generation, owner);
    } catch (error) {
      if (this.current(generation, owner)) this.fail(error);
    } finally {
      this.finish(generation, owner);
    }
  },
  fail(error: unknown) {
    if (error instanceof ApiFailure && [401, 403, 404].includes(error.status)) {
      this.onHide();
      this.setData({ status: "当前账号或访问授权已变化，请重新打开原订单" });
    } else
      this.setData({
        status: "结果尚未确认，请重新查询或重试；重试会沿用本次申请。",
      });
  },
  clearPrivateChoices() {
    this.intent = null;
    this.grantIntent = null;
    this.setData({
      description: "",
      accessChoice: false,
      canGrant: false,
      canAssist: false,
      grantChecked: false,
      pdfScope: false,
      evidenceScope: false,
    });
  },
  watch(generation: number, owner: string) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      if (!this.current(generation, owner)) {
        if (this.active && generation === this.generation) {
          this.onHide();
          this.setData({ status: "账号或登录已变化，售后资料已清理" });
        }
        return;
      }
      if (!this.data.busy) {
        try {
          const view = await qualityClient.list(this.orderId);
          if (!this.current(generation, owner)) return;
          this.show(view);
          const projectId = this.data.selected?.projectId || this.projectId;
          if (projectId) {
            const permission = await participationClient.state(projectId);
            if (!this.current(generation, owner)) return;
            if (
              (this.contentPermitted === true && !permission.canRead) ||
              (this.permissionEpoch >= 0 &&
                this.permissionEpoch !== permission.accessEpoch)
            ) {
              this.clearPrivateChoices();
              this.setData({
                status: "用途授权已变化，私人草稿与未提交的授权选择已清理。",
              });
            }
            this.permissionEpoch = permission.accessEpoch;
            this.contentPermitted = permission.canRead;
          }
        } catch (error) {
          if (this.current(generation, owner)) this.fail(error);
        }
      }
      if (this.current(generation, owner)) this.watch(generation, owner);
      else if (this.active && generation === this.generation) {
        this.onHide();
        this.setData({ status: "账号或登录已变化，售后资料已清理" });
      }
    }, 1000);
  },
  descriptionInput(e: E) {
    this.setData({ description: e.detail.value });
  },
  chooseReason(e: E) {
    if (
      !this.data.busy &&
      e.currentTarget.dataset.reason in qualityReasonLabels
    )
      this.setData({ reason: e.currentTarget.dataset.reason as QualityReason });
  },
  chooseAttempt(e: E) {
    if (
      !this.data.busy &&
      this.data.attempts.some((a) => a.id === e.currentTarget.dataset.id)
    )
      this.setData({ attemptId: e.currentTarget.dataset.id });
  },
  chooseRequest(e: E) {
    if (this.data.busy) return;
    const selected = this.data.rows.find(
      (r) => r.id === e.currentTarget.dataset.id,
    );
    if (selected && selected.id !== this.data.selectedId) {
      ++this.generation;
      this.show(this.data.view!, selected.id);
      this.watch(this.generation, this.ownerContext);
    }
  },
  async prepareAccess() {
    const selected = this.data.selected;
    if (this.data.busy || !selected?.ownerLabel) return;
    const generation = ++this.generation,
      owner = this.ownerContext;
    this.setData({ busy: true, status: "" });
    try {
      const permission = await participationClient.state(selected.projectId);
      if (
        !this.current(generation, owner) ||
        this.data.selectedId !== selected.id
      )
        return;
      this.permissionEpoch = permission.accessEpoch;
      this.contentPermitted = permission.canRead;
      this.setData({
        accessChoice: true,
        canGrant: permission.role === "narrator" || !!this.assistedSessionId,
        canAssist: permission.role === "initiator" && !this.assistedSessionId,
      });
    } catch (error) {
      if (this.current(generation, owner)) this.fail(error);
    } finally {
      this.finish(generation, owner);
    }
  },
  chooseGrant() {
    if (!this.data.busy)
      this.setData({ grantChecked: !this.data.grantChecked });
  },
  chooseScope(e: { currentTarget: { dataset: { scope: string } } }) {
    if (this.data.busy) return;
    const field =
      e.currentTarget.dataset.scope === "pdf" ? "pdfScope" : "evidenceScope";
    this.setData({ [field]: !this.data[field] });
  },
  minutesInput(e: E) {
    if (!this.data.busy) this.setData({ grantMinutes: e.detail.value });
  },
  async grant() {
    const selected = this.data.selected;
    if (
      this.data.busy ||
      !selected ||
      !this.data.canGrant ||
      !this.data.grantChecked
    )
      return;
    const scopes: QualityScope[] = [];
    if (this.data.pdfScope) scopes.push("pdf");
    if (this.data.evidenceScope) scopes.push("evidence");
    const minutes = Number(this.data.grantMinutes);
    if (
      !scopes.length ||
      !Number.isInteger(minutes) ||
      minutes < 1 ||
      minutes > 30
    ) {
      this.setData({ status: "请选择资料范围和1到30分钟的有效期" });
      return;
    }
    const input = JSON.stringify({
      id: selected.id,
      scopes,
      minutes,
      assistedSessionId: this.assistedSessionId,
    });
    if (this.grantIntent?.input !== input)
      this.grantIntent = {
        input,
        key: paymentKey(),
        body: {
          expectedVersion: selected.version,
          scopes,
          expiresAt: new Date(Date.now() + minutes * 60000).toISOString(),
          consented: true,
          noticeVersion: "synthetic-d08-v1",
          ...(this.assistedSessionId
            ? { assistedSessionId: this.assistedSessionId }
            : {}),
        },
      };
    if (Date.parse(this.grantIntent.body.expiresAt) <= Date.now()) {
      this.setData({ status: "本次授权时限已到，请重新选择授权" });
      this.grantIntent = null;
      return;
    }
    const generation = ++this.generation,
      owner = this.ownerContext;
    this.setData({ busy: true, status: "" });
    try {
      const saved = await qualityClient.access(
        this.orderId,
        selected.id,
        this.grantIntent.body,
        this.grantIntent.key,
      );
      if (!this.current(generation, owner)) return;
      this.show({
        ...this.data.view!,
        requests: this.data.view!.requests.map((r) =>
          r.id === saved.id ? saved : r,
        ),
      });
      this.grantIntent = null;
      this.setData({
        grantChecked: false,
        pdfScope: false,
        evidenceScope: false,
        accessChoice: false,
        status: "本次限时授权已记录，仅向本工单负责人提供所选资料。",
      });
    } catch (error) {
      if (this.current(generation, owner)) this.fail(error);
    } finally {
      this.finish(generation, owner);
    }
  },
  assist() {
    const selected = this.data.selected;
    if (!this.data.busy && selected && this.data.canAssist)
      go(
        "assisted",
        `projectId=${selected.projectId}&bookVersionId=${selected.original.bookVersionId}&purpose=book_confirmation&returnTo=quality&orderId=${this.orderId}&requestId=${selected.id}`,
      );
  },
  revise() {
    const selected = this.data.selected;
    if (
      !this.data.busy &&
      selected?.state === "reviewed" &&
      selected.reprintMode === "revised" &&
      this.current(this.generation, this.ownerContext)
    )
      go("book", `projectId=${selected.projectId}`);
  },
  confirmRevision() {
    const selected = this.data.selected;
    if (
      !this.data.busy &&
      selected?.state === "reviewed" &&
      selected.reprintMode === "revised" &&
      this.current(this.generation, this.ownerContext)
    )
      go("print", `projectId=${selected.projectId}`);
  },
  production() {
    const projectId = this.data.selected?.projectId || this.projectId;
    if (
      !this.data.busy &&
      projectId &&
      this.current(this.generation, this.ownerContext)
    )
      go("production", `projectId=${projectId}`);
  },
  async requestRefund() {
    const selected = this.data.selected;
    if (
      this.data.busy ||
      !selected ||
      selected.resolution !== "refund" ||
      selected.refund
    )
      return;
    const generation = ++this.generation,
      owner = this.ownerContext;
    this.setData({ busy: true, status: "" });
    try {
      const permission = await participationClient.state(selected.projectId);
      if (!this.current(generation, owner)) return;
      if (permission.role !== "initiator") {
        this.setData({
          status: "退款由付款发起人继续申请，可联系发起人查看原订单。",
        });
        return;
      }
      const input = JSON.stringify({ id: selected.id, action: "refund" });
      if (this.refundIntent?.input !== input)
        this.refundIntent = {
          input,
          key: paymentKey(),
          expectedVersion: selected.version,
        };
      const saved = await qualityClient.refund(
        this.orderId,
        selected.id,
        this.refundIntent.expectedVersion,
        this.refundIntent.key,
      );
      if (!this.current(generation, owner)) return;
      this.show({
        ...this.data.view!,
        requests: this.data.view!.requests.map((r) =>
          r.id === saved.id ? saved : r,
        ),
      });
      this.refundIntent = null;
      go("refunds", `orderId=${this.orderId}`);
    } catch (error) {
      if (this.current(generation, owner)) this.fail(error);
    } finally {
      this.finish(generation, owner);
    }
  },
  async refunds() {
    const selected = this.data.selected;
    if (this.data.busy || !selected?.refund) return;
    const generation = ++this.generation,
      owner = this.ownerContext;
    this.setData({ busy: true, status: "" });
    try {
      const permission = await participationClient.state(selected.projectId);
      if (!this.current(generation, owner)) return;
      if (permission.role === "initiator")
        go("refunds", `orderId=${this.orderId}`);
      else this.setData({ status: "退款进展由付款发起人在原订单中查看。" });
    } catch (error) {
      if (this.current(generation, owner)) this.fail(error);
    } finally {
      this.finish(generation, owner);
    }
  },
  async apply() {
    if (this.data.busy || !this.data.view || !this.data.attemptId) return;
    const description = this.data.description.trim();
    if (description.length < 3 || description.length > 1500) {
      this.setData({ status: "请填写3到1500字的质量问题说明" });
      return;
    }
    const body = {
        attemptId: this.data.attemptId,
        reason: this.data.reason,
        description,
      },
      input = JSON.stringify(body);
    if (this.intent?.input !== input)
      this.intent = { input, key: paymentKey() };
    const generation = ++this.generation,
      owner = this.ownerContext;
    this.setData({ busy: true, status: "" });
    try {
      const saved = await qualityClient.request(
        this.orderId,
        body,
        this.intent.key,
      );
      if (!this.current(generation, owner)) return;
      this.show(
        {
          ...this.data.view,
          requests: [
            saved,
            ...this.data.view.requests.filter((r) => r.id !== saved.id),
          ],
        },
        saved.id,
      );
      this.intent = null;
      this.setData({
        description: "",
        status: "质量申请已提交，请在此查看实际处理进展。",
      });
    } catch (error) {
      if (this.current(generation, owner)) this.fail(error);
    } finally {
      this.finish(generation, owner);
    }
  },
});
