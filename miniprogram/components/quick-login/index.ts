import { USER_TERMS_VERSION } from "../../../packages/contracts/src";
import { sessionClient } from "../../services/session";
import { go } from "../../services/navigation";

Component({
  options: { styleIsolation: "apply-shared" },
  properties: {
    visible: { type: Boolean, value: false },
    expectedUserId: { type: String, value: "" },
    embedded: { type: Boolean, value: false },
  },
  data: {
    busy: false,
    agreed: false,
    consentConfirm: false,
    status: "",
    generation: 0,
  },
  observers: {
    visible(visible: boolean) {
      if (visible)
        this.setData({ agreed: false, consentConfirm: false, status: "" });
      else this.cancelPending();
    },
  },
  lifetimes: {
    detached() {
      this.cancelPending();
    },
  },
  methods: {
    cancelPending() {
      ++this.data.generation;
      if (this.data.busy) void sessionClient.logout().catch(() => {});
      this.setData({ busy: false });
    },
    toggleAgreed() {
      if (!this.data.busy)
        this.setData({ agreed: !this.data.agreed, status: "" });
    },
    requestConsent() {
      if (!this.data.busy) this.setData({ consentConfirm: true, status: "" });
    },
    cancelConsent() {
      this.setData({ consentConfirm: false });
    },
    async continueLogin(e: { detail: { code?: string; errMsg?: string } }) {
      if (!this.data.consentConfirm || this.data.busy || !this.data.visible)
        return;
      this.setData({ agreed: true, consentConfirm: false });
      await this.login(e);
    },
    async login(e: { detail: { code?: string; errMsg?: string } }) {
      if (this.data.busy || !this.data.agreed || !this.data.visible) return;
      if (!e.detail.code || e.detail.errMsg !== "getPhoneNumber:ok") {
        this.setData({ status: "需要授权手机号才能登录，您也可以暂不登录。" });
        return;
      }
      const generation = ++this.data.generation;
      this.setData({ busy: true, status: "" });
      try {
        const result = await sessionClient.login(
          { phoneCode: e.detail.code, termsVersion: USER_TERMS_VERSION },
          this.data.expectedUserId || undefined,
        );
        if (generation !== this.data.generation || !this.data.visible) return;
        this.setData({ busy: false });
        this.triggerEvent("success", { user: result.user });
      } catch (error) {
        if (generation === this.data.generation)
          this.setData({
            status:
              error instanceof Error ? error.message : "登录未成功，请再试一次",
          });
      } finally {
        if (generation === this.data.generation) this.setData({ busy: false });
      }
    },
    close() {
      if (!this.data.busy) this.triggerEvent("close");
    },
    terms() {
      go("terms");
    },
    privacy() {
      wx.openPrivacyContract({
        fail: () =>
          this.setData({ status: "隐私保护指引暂时无法打开，请稍后重试" }),
      });
    },
    preventMove() {},
  },
});
