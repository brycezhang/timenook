import { participationClient } from "../../services/participation";
import { sessionClient } from "../../services/session";
import { go } from "../../services/navigation";
Page({
  data: {
    bookTitle: "",
    token: "",
    busy: false,
    pageLoading: true,
    status: "",
    canInvite: false,
  },
  projectId: "",
  owner: "",
  generation: 0,
  expiresAt: 0,
  onLoad(q) {
    this.projectId = q.projectId ?? "";
  },
  async onShow() {
    if (this.owner !== sessionClient.context())
      this.setData({ bookTitle: "", token: "", canInvite: false });
    if (
      this.data.token &&
      this.owner === sessionClient.context() &&
      this.expiresAt > Date.now()
    )
      return;
    await this.prepare();
  },
  async prepare() {
    if (this.data.busy) return;
    const n = ++this.generation,
      owner = sessionClient.context();
    this.setData({
      busy: true,
      pageLoading: !this.data.bookTitle,
      status: "",
      token: "",
    });
    try {
      const state = await participationClient.state(this.projectId);
      if (n !== this.generation || owner !== sessionClient.context()) return;
      this.setData({
        bookTitle: state.bookTitle ?? "时光故事书",
        canInvite: !!state.canInvite,
      });
      if (!state.canInvite) throw Error("请购买者分享项目邀请");
      const invite = await participationClient.invite(this.projectId);
      if (n === this.generation && owner === sessionClient.context()) {
        this.owner = owner;
        this.expiresAt = Date.parse(invite.expiresAt);
        this.setData({ token: invite.token });
      }
    } catch (e) {
      if (n === this.generation)
        this.setData({
          status: e instanceof Error ? e.message : "邀请未能准备，请重试",
        });
    } finally {
      if (n === this.generation)
        this.setData({ busy: false, pageLoading: false });
    }
  },
  onHide() {
    ++this.generation;
    this.setData({ busy: false });
  },
  onUnload() {
    ++this.generation;
  },
  onShareAppMessage() {
    return this.data.token &&
      this.owner === sessionClient.context() &&
      this.expiresAt > Date.now()
      ? {
          title: `一起完成《${this.data.bookTitle}》`,
          path: `/pages/welcome/index?token=${this.data.token}`,
        }
      : { title: "时光故事", path: "/pages/home/index" };
  },
  terms() {
    go("terms");
  },
});
