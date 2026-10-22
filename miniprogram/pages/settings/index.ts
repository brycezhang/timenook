import { touch } from "../../domain/model";
import { required, save, toast } from "../../services/store";
type E = {
  currentTarget: { dataset: Record<string, string> };
  detail: { value: string };
};
Page({
  data: { title: "", buyer: "", recipient: "", error: "" },
  onLoad() {
    const p = required();
    this.setData({ title: p.title, buyer: p.buyer, recipient: p.recipient });
  },
  input(e: E) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value });
  },
  save() {
    if (!this.data.title.trim() || !this.data.buyer.trim()) {
      this.setData({ error: "请填写书名和赠礼人称呼" });
      return;
    }
    const p = required();
    if (p.title !== this.data.title.trim()) touch(p);
    p.title = this.data.title.trim();
    p.buyer = this.data.buyer.trim();
    save(p);
    toast("资料已保存");
    wx.navigateBack();
  },
});
