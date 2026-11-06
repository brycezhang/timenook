import { USER_TERMS_VERSION } from "../../../packages/contracts/src";
import { sessionClient } from "../../services/session";
import { go } from "../../services/store";
import { switchProjectTab } from "../../services/navigation";

Page({
  data: {
    busy: false,
    status: "",
    agreementVisible: false,
    agreed: false,
    termsAccepted: false,
  },
  generation: 0,
  purchaseQuery: "",
  next: "home",
  expectedUserId: "",
  onLoad(q) {
    this.next = ["purchase", "account", "back"].includes(q.next ?? "")
      ? q.next!
      : "home";
    this.expectedUserId = q.expectedUserId ?? "";
    const decode = (value: string) => {
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    };
    if (q.next === "purchase")
      this.purchaseQuery = `bookTitle=${encodeURIComponent(decode(q.bookTitle ?? "人生故事书"))}&salutation=${encodeURIComponent(decode(q.salutation ?? ""))}`;
  },
  onHide() {
    if (!this.data.busy) ++this.generation;
  },
  onUnload() {
    ++this.generation;
    if (this.data.busy) void sessionClient.logout().catch(() => {});
  },
  showAgreement() {
    if (this.data.busy) return;
    this.setData({ agreementVisible: true, agreed: false, status: "" });
  },
  toggleAgreed() {
    this.setData({ agreed: !this.data.agreed });
  },
  agree() {
    if (!this.data.agreed) return;
    this.setData({ agreementVisible: false, termsAccepted: true, status: "" });
  },
  decline() {
    this.setData({
      agreementVisible: false,
      termsAccepted: false,
      agreed: false,
    });
  },
  preventMove() {},
  privacy() {
    wx.openPrivacyContract({
      fail: () =>
        this.setData({ status: "隐私保护指引暂时无法打开，请稍后重试" }),
    });
  },
  async login(e: { detail: { code?: string; errMsg?: string } }) {
    if (this.data.busy) return;
    if (!this.data.termsAccepted) {
      this.showAgreement();
      return;
    }
    if (!e.detail.code || e.detail.errMsg !== "getPhoneNumber:ok") {
      this.setData({ status: "需要授权手机号才能登录，您也可以暂不登录。" });
      return;
    }
    const generation = ++this.generation;
    this.setData({ busy: true, status: "" });
    try {
      await sessionClient.login(
        { phoneCode: e.detail.code, termsVersion: USER_TERMS_VERSION },
        this.expectedUserId || undefined,
      );
      if (generation !== this.generation) return;
      this.setData({ busy: false });
      if (this.purchaseQuery)
        wx.redirectTo({ url: `/pages/purchase/index?${this.purchaseQuery}` });
      else if (this.next === "back") wx.navigateBack();
      else if (this.next === "account") switchProjectTab("account");
      else switchProjectTab("home");
    } catch (e) {
      if (generation === this.generation)
        this.setData({
          status: e instanceof Error ? e.message : "登录未成功，请再试一次",
        });
    } finally {
      if (generation === this.generation) this.setData({ busy: false });
    }
  },
  cancel() {
    if (this.data.busy) return;
    if (this.purchaseQuery || this.next === "back") wx.navigateBack();
    else if (this.next === "account") switchProjectTab("account");
    else switchProjectTab("home");
  },
  terms() {
    go("terms");
  },
});
