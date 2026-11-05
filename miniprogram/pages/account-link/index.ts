import { sessionClient, ApiFailure } from "../../services/session";
import { setDataMode } from "../../services/mode";
import type {
  AccountLinkChallenge,
  AccountLinkClaim,
  AccountLinkResult,
} from "../../../packages/contracts/src";
// Native output is unbundled: contracts are types only across this boundary.
function isAccountLinkResult(value: unknown): value is AccountLinkResult {
  const row = (value as AccountLinkResult | undefined)?.challenge;
  return (
    !!row &&
    /^[0-9a-f-]{36}$/.test(row.id) &&
    /^[0-9a-f-]{36}$/.test(row.targetUser?.id ?? "") &&
    Number.isFinite(Date.parse(row.expiresAt)) &&
    ["waiting", "paired", "linked", "cancelled", "expired"].includes(
      row.state,
    ) &&
    (row.verificationCode === null || /^\d{6}$/.test(row.verificationCode)) &&
    typeof row.webConfirmed === "boolean" &&
    typeof row.nativeConfirmed === "boolean"
  );
}
function message(error: unknown) {
  return error instanceof ApiFailure && error.status === 409
    ? "关联状态冲突或微信账号已切换，请取消后重新发起；已有账号不会自动合并。"
    : error instanceof ApiFailure && error.status === 401
      ? "关联或网页会话已失效，请重新发起。"
      : error instanceof Error
        ? error.message
        : "关联服务暂不可用，请稍后重试。";
}
Page({
  data: {
    available: false,
    status: "正在检查关联服务…",
    busy: false,
    linkCode: "",
    challenge: null as AccountLinkChallenge | null,
    userId: "",
  },
  version: 0,
  proof: "",
  loginPending: false,
  async onLoad() {
    const version = ++this.version;
    setDataMode("live");
    try {
      const availability = await sessionClient.publicRequest<{
        available: boolean;
      }>("/wechat-links");
      if (version === this.version)
        this.setData({
          available: availability.available === true,
          status: availability.available
            ? "请输入网页上显示的关联码。"
            : "独立小程序尚未配置，暂不可关联。",
        });
    } catch {
      if (version === this.version)
        this.setData({ status: "关联服务暂不可用，请稍后重试。" });
    }
  },
  inputCode(event: { detail: { value: string } }) {
    this.setData({
      linkCode: event.detail.value.replace(/\D/g, "").slice(0, 8),
    });
  },
  async claim() {
    if (
      this.data.busy ||
      !this.data.available ||
      !/^\d{8}$/.test(this.data.linkCode)
    )
      return;
    const version = ++this.version;
    this.proof = "";
    this.setData({
      busy: true,
      challenge: null,
      userId: "",
      status: "正在证明当前微信身份…",
    });
    try {
      // Entering association never calls ordinary login or creates a User.
      await sessionClient.logout();
      if (version !== this.version) return;
      const result = await sessionClient.wechatLink<AccountLinkClaim>("claim", {
        linkCode: this.data.linkCode,
      });
      if (
        !isAccountLinkResult(result) ||
        !/^[A-Za-z0-9_-]{43}$/.test(result.proof)
      )
        throw new Error("关联响应无效");
      if (version !== this.version) {
        void sessionClient
          .wechatLink("cancel", { proof: result.proof })
          .catch(() => {});
        return;
      }
      this.proof = result.proof;
      this.show(result);
    } catch (error) {
      if (version === this.version) this.setData({ status: message(error) });
    } finally {
      if (version === this.version) this.setData({ busy: false });
    }
  },
  show(result: AccountLinkResult) {
    if (!isAccountLinkResult(result)) throw new Error("关联响应无效");
    this.setData({
      challenge: result.challenge,
      linkCode: "",
      status:
        result.challenge.state === "linked"
          ? "两端已确认。请重新微信登录，打开同一产品账号。"
          : result.challenge.state === "paired"
            ? result.challenge.nativeConfirmed
              ? "本端已确认，请在网页端核对并确认，然后刷新状态。"
              : "请核对两端相同的6位核对码和网页账号，再明确确认。"
            : "本次关联已取消或到期，请从网页重新发起。",
    });
  },
  async action(action: "status" | "confirm" | "cancel") {
    if (!this.proof || this.data.busy) return;
    const version = ++this.version;
    const proof = this.proof,
      verificationCode = this.data.challenge?.verificationCode;
    this.setData({ busy: true });
    try {
      const result = await sessionClient.wechatLink<AccountLinkResult>(action, {
        proof,
        ...(action === "confirm" ? { verificationCode } : {}),
      });
      if (version === this.version) this.show(result);
    } catch (error) {
      if (version === this.version) this.setData({ status: message(error) });
    } finally {
      if (version === this.version) this.setData({ busy: false });
    }
  },
  confirm() {
    return this.action("confirm");
  },
  refresh() {
    return this.action("status");
  },
  cancel() {
    return this.action("cancel");
  },
  async finish() {
    const expectedUserId = this.data.challenge?.targetUser.id;
    if (
      this.data.busy ||
      this.data.challenge?.state !== "linked" ||
      !expectedUserId
    )
      return;
    const version = ++this.version;
    this.loginPending = true;
    this.setData({ busy: true });
    try {
      const result = await sessionClient.login(expectedUserId);
      if (version === this.version)
        this.setData({
          userId: result.user.id,
          status: "已登录同一产品账号，项目和资料沿用原有授权。",
        });
    } catch (error) {
      if (version === this.version) this.setData({ status: message(error) });
    } finally {
      this.loginPending = false;
      if (version === this.version) this.setData({ busy: false });
    }
  },
  onUnload() {
    ++this.version;
    // Invalidate this in-flight login before another page can start a new one.
    if (this.loginPending) void sessionClient.logout().catch(() => {});
    const proof = this.proof;
    this.proof = "";
    if (proof && this.data.challenge?.state === "paired")
      void sessionClient.wechatLink("cancel", { proof }).catch(() => {});
    this.setData({ challenge: null, linkCode: "", userId: "" });
  },
});
