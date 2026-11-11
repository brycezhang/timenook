import type {
  GiftPreview,
  GiftVerification,
} from "../../../packages/contracts/src";
import { giftClient } from "../../services/gifts";
import { ApiFailure, sessionClient } from "../../services/session";
import { setDataMode } from "../../services/mode";
import { switchProjectTab } from "../../services/navigation";

type Screen = "open" | "verify" | "mismatch" | "accept" | "invalid" | "claimed";
const titles: Record<Screen, string> = {
  open: "查看礼物",
  verify: "验证收礼手机号",
  mismatch: "手机号不匹配",
  accept: "确认领取礼物",
  invalid: "礼物卡已失效",
  claimed: "礼物已领取",
};
Page({
  data: {
    screen: "open" as Screen,
    title: titles.open,
    gift: null as GiftPreview | null,
    currentMaskedPhone: "",
    projectId: "",
    loading: true,
    busy: false,
    status: "",
    loginVisible: false,
  },
  token: "",
  generation: 0,
  ownerContext: "",
  onLoad(q) {
    this.token = q.token ?? "";
    setDataMode("live");
  },
  onShow() {
    return this.load();
  },
  onHide() {
    ++this.generation;
  },
  onUnload() {
    ++this.generation;
  },
  screen(screen: Screen) {
    this.setData({
      screen,
      title: titles[screen],
      loginVisible: screen === "verify",
    });
  },
  showVerification(result: GiftVerification) {
    this.setData({
      gift: result.gift,
      currentMaskedPhone: result.currentMaskedPhone ?? "未验证",
      projectId: result.projectId ?? "",
      status: "",
    });
    this.screen(result.state === "ready" ? "accept" : result.state);
  },
  failure(e: unknown) {
    if (e instanceof ApiFailure && [403, 404].includes(e.status)) {
      this.setData({ gift: null, projectId: "", status: "" });
      this.screen("invalid");
    } else if (e instanceof ApiFailure && e.status === 401)
      this.screen("verify");
    else
      this.setData({
        status: e instanceof Error ? e.message : "礼物读取失败，请重试",
      });
  },
  async load() {
    const generation = ++this.generation,
      context = sessionClient.context();
    if (this.ownerContext !== context) {
      this.setData({ projectId: "", currentMaskedPhone: "" });
      if (["mismatch", "accept", "claimed"].includes(this.data.screen))
        this.screen("open");
    }
    this.ownerContext = context;
    this.setData({ loading: true, status: "" });
    try {
      const gift = await giftClient.preview(this.token);
      if (generation !== this.generation || context !== sessionClient.context())
        return;
      this.setData({ gift });
      if (
        context &&
        (gift.state === "claimed" ||
          ["accept", "mismatch"].includes(this.data.screen))
      ) {
        const verification = await giftClient.verify(this.token);
        if (
          generation === this.generation &&
          context === sessionClient.context()
        )
          this.showVerification(verification);
      } else if (gift.state === "claimed") this.screen("claimed");
    } catch (e) {
      if (generation === this.generation) this.failure(e);
    } finally {
      if (generation === this.generation)
        this.setData({ loading: false, busy: false });
    }
  },
  async verify() {
    if (this.data.busy || this.data.loading) return;
    if (!sessionClient.context()) {
      this.screen("verify");
      return;
    }
    const generation = this.generation,
      context = sessionClient.context();
    this.setData({ busy: true, status: "" });
    try {
      const result = await giftClient.verify(this.token);
      if (
        generation === this.generation &&
        context === sessionClient.context()
      ) {
        this.ownerContext = context;
        this.showVerification(result);
      }
    } catch (e) {
      if (generation === this.generation) this.failure(e);
    } finally {
      if (generation === this.generation) this.setData({ busy: false });
    }
  },
  loginSucceeded() {
    this.setData({ loginVisible: false });
    return this.verify();
  },
  closeLogin() {
    this.screen("open");
  },
  async switchAccount() {
    if (this.data.busy) return;
    this.setData({
      busy: true,
      projectId: "",
      currentMaskedPhone: "",
      status: "",
    });
    try {
      await sessionClient.logout();
    } catch {
      /* Local session is removed before the revoke request. */
    } finally {
      this.ownerContext = "";
      this.setData({ busy: false });
      this.screen("verify");
    }
  },
  async accept() {
    if (this.data.busy || this.data.loading || this.data.screen !== "accept")
      return;
    const generation = this.generation,
      context = sessionClient.context();
    this.setData({ busy: true, status: "" });
    try {
      const result = await giftClient.claim(this.token);
      if (
        generation === this.generation &&
        context === sessionClient.context()
      ) {
        this.setData({ projectId: result.projectId });
        this.screen("claimed");
      }
    } catch (e) {
      if (generation === this.generation) {
        if (e instanceof ApiFailure && e.status === 403) {
          this.setData({ status: "收礼信息已变更，请重新验证" });
          this.screen("open");
        } else this.failure(e);
      }
    } finally {
      if (generation === this.generation) this.setData({ busy: false });
    }
  },
  project() {
    if (this.data.projectId) switchProjectTab("home", this.data.projectId);
  },
  home() {
    switchProjectTab("home");
  },
});
