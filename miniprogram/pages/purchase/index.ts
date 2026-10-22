import { type Recipient } from "../../domain/model";
import { go, home, start, toast } from "../../services/store";
import { dataMode } from "../../services/mode";
type E = {
  currentTarget: { dataset: Record<string, string> };
  detail: { value: string };
};
Page({
  data: {
    recipient: "妈妈" as Recipient,
    agreed: false,
    bookImage: "/assets/book.jpg",
  },
  onLoad(q) {
    if (dataMode() === "live") {
      home("home");
      return;
    }
    const recipient = q.recipient === "爸爸" ? "爸爸" : "妈妈";
    this.setData({
      recipient,
      bookImage:
        recipient === "爸爸" ? "/assets/father-book.jpg" : "/assets/book.jpg",
    });
  },
  choose(e: E) {
    const recipient = e.currentTarget.dataset.recipient as Recipient;
    this.setData({
      recipient,
      bookImage:
        recipient === "爸爸" ? "/assets/father-book.jpg" : "/assets/book.jpg",
    });
  },
  agree() {
    this.setData({ agreed: !this.data.agreed });
  },
  privacy() {
    go("service", "kind=terms");
  },
  pay() {
    if (dataMode() === "live") {
      toast("真实购买尚未开放");
      return;
    }
    if (!this.data.agreed) return;
    wx.showModal({
      title: "体验购买流程",
      content:
        "这是前端演示，不会发起微信付款。确认后将在本机建立一个故事记录项目。",
      confirmText: "创建项目",
      success: (r) => {
        if (r.confirm) {
          try {
            start(this.data.recipient);
            home("invite");
          } catch {
            toast("项目创建失败，请检查本机存储空间后重试");
          }
        }
      },
    });
  },
});
