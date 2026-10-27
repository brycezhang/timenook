import { participationClient } from "../../services/participation";
import { type Project, readyToPrint, validAddress } from "../../domain/model";
import { asset, go, required, save, toast } from "../../services/store";
import { dataMode } from "../../services/mode";
import { sessionClient, ApiFailure } from "../../services/session";
import { firstCopyClient } from "../../services/first-copy";
import { paymentKey } from "../../services/payments";
import type { FirstCopyContext } from "../../../packages/contracts/src";
type E = {
  currentTarget: { dataset: Record<string, string> };
  detail: { value: string };
};
Page({
  data: {
    live: false,
    context: null as FirstCopyContext | null,
    canSubmit: false,
    busy: false,
    status: "",
    versionMismatch: false,
    addressDirty: false,
    regionCode: "",
    regionIndex: -1,
    regionLabels: [] as string[],
    regionOptions: [] as { label: string; selected: boolean }[],
    blockerLabels: [] as string[],
    narratorChecked: false,
    initiatorChecked: false,
    narratorEvidence: "",
    initiatorEvidence: "",
    canConfirmNarrator: false,
    p: null as Project | null,
    bookImage: "",
    ready: false,
    name: "",
    phone: "",
    detail: "",
    error: "",
    submitted: false,
  },
  remoteAccessEpoch: -1,
  projectId: "",
  versionId: "",
  assistedSessionId: "",
  generation: 0,
  ownerContext: "",
  intent: null as { input: string; key: string } | null,
  expiry: undefined as ReturnType<typeof setTimeout> | undefined,
  stopSessionWatch: undefined as (() => void) | undefined,
  onLoad(q) {
    this.projectId = q.projectId || "";
    this.versionId = q.versionId || "";
    this.assistedSessionId = q.assistedSessionId || "";
    this.ownerContext = sessionClient.context();
    if (dataMode() === "live") this.setData({ live: true });
  },
  onHide() {
    this.remoteAccessEpoch = -1;
    if (!this.data.live) return;
    ++this.generation;
    this.ownerContext = "";
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = undefined;
    this.stopSessionWatch?.();
    this.stopSessionWatch = undefined;
    this.intent = null;
    this.setData({
      context: null,
      canSubmit: false,
      busy: false,
      name: "",
      phone: "",
      detail: "",
      regionCode: "",
      regionIndex: -1,
      regionLabels: [],
      regionOptions: [],
      blockerLabels: [],
      addressDirty: false,
      narratorChecked: false,
      initiatorChecked: false,
      narratorEvidence: "",
      initiatorEvidence: "",
      canConfirmNarrator: false,
    });
  },
  onUnload() {
    this.onHide();
  },
  accessExpired() {
    const value = this.data.context?.accessExpiresAt;
    return !!value && Date.parse(value) <= Date.now();
  },
  creationExpired() {
    const value = this.data.context?.creation.expiresAt;
    return !!value && Date.parse(value) <= Date.now();
  },
  current(generation: number, owner: string) {
    return (
      generation === this.generation &&
      dataMode() === "live" &&
      owner === sessionClient.context() &&
      !this.accessExpired()
    );
  },
  accept(value: FirstCopyContext) {
    if (
      value.accessExpiresAt &&
      Date.parse(value.accessExpiresAt) <= Date.now()
    )
      throw new Error("资料访问已到期，请重新查询");
    const versionMismatch =
      !!this.versionId && value.book?.id !== this.versionId;
    const address = value.address.value;
    const labels: Record<string, string> = {
      BOOK_NOT_READY: "书稿尚未就绪或内容已变化",
      ADDRESS_REQUIRED: "请保存配送地址",
      NARRATOR_CONFIRMATION_REQUIRED: "等待讲述者确认本版内容",
      INITIATOR_CONFIRMATION_REQUIRED: "等待发起人确认本版 PDF 与当前地址",
      CREATION_PAUSED: "制作期限已暂停，请联系服务人员核验",
      CREATION_EXPIRED: "制作期限已到，请申请人工审核",
      POLICY_PENDING: "销售规则仍待确认，暂不能提交制作",
      SPECIFICATION_MISMATCH: "书稿超出或不符合约定制作规格",
      ENTITLEMENT_UNAVAILABLE: "首本制作权益当前不可用",
      PROJECT_FROZEN: "项目当前已冻结，请联系服务人员",
      ALREADY_SUBMITTED: "首本已提交，无需再次提交",
    };
    this.setData({
      context: value,
      versionMismatch,
      canSubmit: value.canSubmit && !versionMismatch,
      name: address?.recipientName || "",
      phone: address?.phone || "",
      detail: address?.detail || "",
      regionCode: address?.regionCode || "",
      regionIndex: value.shipping.regionCodes.indexOf(
        address?.regionCode || "",
      ),
      regionLabels: value.shipping.regionCodes.map(
        (code) => value.shipping.regionLabels?.[code] || code,
      ),
      regionOptions: value.shipping.regionCodes.map((code) => ({
        label: value.shipping.regionLabels?.[code] || code,
        selected: code === address?.regionCode,
      })),
      blockerLabels: value.blockers.map(
        (code) => labels[code] || "当前条件未满足，请重新查询",
      ),
      addressDirty: false,
      canConfirmNarrator:
        (value.canConfirmNarrator || !!this.assistedSessionId) &&
        !versionMismatch,
      narratorChecked: false,
      initiatorChecked: false,
      narratorEvidence: "",
      initiatorEvidence: "",
      status: versionMismatch
        ? "书稿版本已变化，请返回成书总览，重新逐页核对完整 PDF。"
        : "",
    });
  },
  key(input: unknown) {
    const serialized = JSON.stringify(input);
    if (this.intent?.input !== serialized)
      this.intent = { input: serialized, key: paymentKey() };
    return this.intent.key;
  },
  watch(owner: string) {
    const generation = this.generation;
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = setTimeout(
      async () => {
        if (
          dataMode() !== "live" ||
          owner !== sessionClient.context() ||
          this.accessExpired()
        ) {
          this.onHide();
          this.setData({ status: "授权已到期或账号已变化，请重新查询" });
          return;
        }
        if (this.creationExpired() && this.data.canSubmit)
          this.setData({
            canSubmit: false,
            status:
              "制作期限已到，请重新查询并按约定申请人工审核；资料不会自动删除。",
          });
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
        this.watch(owner);
      },
      Math.max(
        1,
        Math.min(
          1000,
          this.data.context?.accessExpiresAt
            ? Date.parse(this.data.context.accessExpiresAt) - Date.now()
            : 1000,
        ),
      ),
    );
  },
  async perform(work: (generation: number, owner: string) => Promise<void>) {
    if (this.data.busy) return;
    if (this.ownerContext && this.ownerContext !== sessionClient.context()) {
      this.onHide();
      this.setData({ status: "账号已变化，请重新查询" });
      return;
    }
    if (this.accessExpired()) {
      this.onHide();
      this.setData({ status: "资料访问已到期，请重新查询" });
      return;
    }
    const generation = ++this.generation,
      owner = sessionClient.context();
    this.setData({ busy: true, status: "" });
    try {
      await work(generation, owner);
    } catch (error) {
      if (generation !== this.generation) return;
      if (
        owner !== sessionClient.context() ||
        (error instanceof ApiFailure && [401, 403].includes(error.status))
      ) {
        this.onHide();
        this.setData({ status: "授权已失效或账号已变化，请重新查询" });
      } else
        this.setData({
          ...(error instanceof ApiFailure && error.status === 409
            ? { canSubmit: false }
            : {}),
          status:
            error instanceof ApiFailure && error.status === 409
              ? "书稿、地址或确认已变化，请重新查询后核对。"
              : "结果未确定，请重新查询或重试；重试沿用本次提交标识。",
        });
    } finally {
      if (generation === this.generation && this.accessExpired()) {
        this.onHide();
        this.setData({ status: "资料访问已到期，请重新查询" });
      }
      if (generation === this.generation && owner !== sessionClient.context()) {
        this.onHide();
        this.setData({ status: "账号已变化，请重新查询" });
      }
      if (generation === this.generation) this.setData({ busy: false });
    }
  },
  async refresh() {
    return this.onShow();
  },
  async onShow() {
    if (dataMode() === "live") {
      if (this.ownerContext && this.ownerContext !== sessionClient.context())
        this.onHide();
      this.ownerContext = sessionClient.context();
      this.setData({ live: true });
      this.stopSessionWatch?.();
      this.stopSessionWatch = sessionClient.onInvalidated(() => {
        this.onHide();
        this.setData({ status: "登录已失效，请重新登录" });
      });
      return this.perform(async (generation: number, owner: string) => {
        const value = await firstCopyClient.read(this.projectId);
        if (this.current(generation, owner)) {
          this.accept(value);
          this.watch(owner);
        }
      });
    }
    const p = required();
    this.setData({
      p,
      bookImage: asset(p),
      ready: readyToPrint(p),
      ...p.address,
      submitted: p.printRevision === p.revision,
    });
  },
  input(e: E) {
    if (this.data.live) {
      if (
        this.data.busy ||
        this.data.context?.role !== "initiator" ||
        !["name", "phone", "detail"].includes(e.currentTarget.dataset.field)
      )
        return;
      this.setData({
        [e.currentTarget.dataset.field]: e.detail.value,
        addressDirty: true,
        canSubmit: false,
        initiatorChecked: false,
        initiatorEvidence: "",
      });
      return;
    }
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value });
  },
  chooseRegion(e: {
    detail?: { value: string };
    currentTarget?: { dataset: Record<string, string> };
  }) {
    if (this.data.busy || this.data.context?.role !== "initiator") return;
    const regionIndex = Number(
        e.detail?.value ?? e.currentTarget?.dataset.index,
      ),
      regionCode = this.data.context.shipping.regionCodes[regionIndex];
    if (regionCode)
      this.setData({
        regionIndex,
        regionCode,
        regionOptions: this.data.regionOptions.map((option, index) => ({
          ...option,
          selected: index === regionIndex,
        })),
        addressDirty: true,
        canSubmit: false,
        initiatorChecked: false,
        initiatorEvidence: "",
      });
  },
  async saveAddress() {
    const value = this.data.context;
    if (
      this.data.busy ||
      !value ||
      value.role !== "initiator" ||
      !this.data.addressDirty ||
      (value.production && !value.canReviseProduction)
    )
      return;
    const address = {
      recipientName: this.data.name.trim(),
      phone: this.data.phone.trim(),
      regionCode: this.data.regionCode,
      detail: this.data.detail.trim(),
    };
    if (
      !address.recipientName ||
      !/^1\d{10}$/.test(address.phone) ||
      !address.detail ||
      !value.shipping.regionCodes.includes(address.regionCode)
    ) {
      this.setData({ status: "请填写收件人、11位手机号、配送地区和完整地址" });
      return;
    }
    const key = this.key({
      operation: "address",
      expectedVersion: value.address.version,
      ...address,
    });
    return this.perform(async (generation: number, owner: string) => {
      const saved = await firstCopyClient.saveAddress(
        this.projectId,
        value.address.version,
        address,
        key,
      );
      if (this.current(generation, owner)) {
        this.intent = null;
        this.accept(saved);
        this.setData({ status: "地址已保存，请重新确认当前 PDF 与地址。" });
      }
    });
  },
  chooseConfirmation(e: E) {
    if (this.data.busy) return;
    const role = e.currentTarget.dataset.role;
    if (role === "narrator")
      this.setData({ narratorChecked: !this.data.narratorChecked });
    if (role === "initiator")
      this.setData({ initiatorChecked: !this.data.initiatorChecked });
  },
  evidenceInput(e: E) {
    if (this.data.busy) return;
    const role = e.currentTarget.dataset.role;
    if (role === "narrator") this.setData({ narratorEvidence: e.detail.value });
    if (role === "initiator")
      this.setData({ initiatorEvidence: e.detail.value });
  },
  async confirmNarrator() {
    return this.confirm("narrator");
  },
  async confirmInitiator() {
    return this.confirm("initiator");
  },
  async confirm(role: "narrator" | "initiator") {
    const value = this.data.context,
      book = value?.book;
    if (
      !value ||
      !book?.pdf ||
      book.state !== "ready" ||
      this.data.versionMismatch ||
      this.data.busy ||
      (value.production && !value.canReviseProduction) ||
      (role === "narrator"
        ? !this.data.canConfirmNarrator
        : value.role !== "initiator" ||
          this.data.addressDirty ||
          !value.address.hash)
    )
      return;
    const checked =
        role === "narrator"
          ? this.data.narratorChecked
          : this.data.initiatorChecked,
      evidence = (
        role === "narrator"
          ? this.data.narratorEvidence
          : this.data.initiatorEvidence
      ).trim();
    if (!checked || !/^[^\r\n]{3,160}$/.test(evidence)) {
      this.setData({
        status:
          "请逐页核对完整 PDF，明确选择并填写 3 至 160 字的本次独立说明（单行）",
      });
      return;
    }
    const input = {
        role,
        bookVersionId: book.id,
        snapshotHash: book.snapshotHash,
        pdfHash: book.pdf.sha256,
        ...(role === "initiator" ? { addressHash: value.address.hash! } : {}),
        noticeVersion: "synthetic-d08-v1",
        evidenceRef: `synthetic:${evidence}`,
        ...(role === "narrator" && this.assistedSessionId
          ? { assistedSessionId: this.assistedSessionId }
          : {}),
      },
      key = this.key({ operation: "confirmation", ...input });
    return this.perform(async (generation: number, owner: string) => {
      const saved = await firstCopyClient.confirm(this.projectId, input, key);
      if (this.current(generation, owner)) {
        this.intent = null;
        this.accept(saved);
        this.setData({
          status:
            role === "narrator"
              ? "本人已确认本版内容。"
              : "已确认本版完整 PDF 与当前地址。",
        });
      }
    });
  },
  assist() {
    const book = this.data.context?.book;
    if (this.data.context?.role === "initiator" && book && !this.data.busy)
      go(
        "assisted",
        `projectId=${this.projectId}&bookVersionId=${book.id}&purpose=book_confirmation`,
      );
  },
  async requestExpiryReview() {
    const value = this.data.context;
    if (
      !value ||
      value.role !== "initiator" ||
      !value.expiryReview.available ||
      this.data.busy
    )
      return;
    const key = this.key({
      operation: "expiry-review",
      projectId: this.projectId,
    });
    return this.perform(async (generation: number, owner: string) => {
      const saved = await firstCopyClient.expiryReview(this.projectId, key);
      if (this.current(generation, owner)) {
        this.intent = null;
        this.accept(saved);
        this.setData({
          status:
            "制作期限人工审核申请已记录。尚未预留首本，不会再次支付；资料不会自动删除。",
        });
      }
    });
  },
  book() {
    go("book", `projectId=${this.projectId}`);
  },
  review() {
    if (this.data.live) {
      if (this.accessExpired()) {
        this.onHide();
        return;
      }
      const book = this.data.context?.book;
      if (book)
        go(
          "manuscript",
          `projectId=${this.projectId}&versionId=${book.id}${this.assistedSessionId ? `&assistedSessionId=${this.assistedSessionId}` : ""}`,
        );
      return;
    }
    go("manuscript");
  },
  async submit() {
    if (this.data.live) {
      const value = this.data.context,
        book = value?.book;
      if (this.creationExpired()) {
        this.setData({
          canSubmit: false,
          status:
            "制作期限已到，请重新查询并按约定申请人工审核；资料不会自动删除。",
        });
        return;
      }
      if (
        !value ||
        !book?.pdf ||
        book.state !== "ready" ||
        !this.data.canSubmit ||
        this.data.addressDirty ||
        this.data.versionMismatch ||
        !value.address.hash ||
        (value.production && !value.canReviseProduction)
      )
        return;
      const binding = {
          bookVersionId: book.id,
          snapshotHash: book.snapshotHash,
          pdfHash: book.pdf.sha256,
          addressHash: value.address.hash,
        },
        key = this.key({ operation: "submit", ...binding });
      return this.perform(async (generation: number, owner: string) => {
        const saved = await firstCopyClient.submit(
          this.projectId,
          binding,
          key,
        );
        if (this.current(generation, owner)) {
          this.intent = null;
          this.accept(saved);
          this.setData({
            status: saved.production
              ? "首本制作已预留，等待审核。本次无需支付。"
              : "制作期限需要人工审核；尚未预留首本，不会再次支付。",
          });
        }
      });
    }
    const p = required();
    if (!readyToPrint(p)) {
      toast("请先确认完整书稿");
      return;
    }
    const address = {
      name: this.data.name.trim(),
      phone: this.data.phone.trim(),
      detail: this.data.detail.trim(),
    };
    if (!validAddress(address)) {
      this.setData({ error: "请填写收件人、11位手机号和完整收货地址" });
      return;
    }
    p.address = address;
    save(p);
    wx.showModal({
      title: "体验提交印刷",
      content:
        "当前为本机演示，不会发送地址或创建真实印刷订单。首本已含在套餐中，无需再次支付。",
      confirmText: "确认体验",
      success: (r) => {
        if (r.confirm) {
          const latest = required();
          if (!readyToPrint(latest)) {
            toast("书稿已变化，请重新确认");
            return;
          }
          latest.printRevision = latest.revision;
          save(latest);
          go("order");
        }
      },
    });
  },
  production() {
    if (
      this.data.context?.production &&
      !this.data.busy &&
      !this.accessExpired()
    )
      go("production", `projectId=${this.projectId}`);
  },
  order() {
    go("order");
  },
});
