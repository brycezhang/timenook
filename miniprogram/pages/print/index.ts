import { type Project, readyToPrint, validAddress } from "../../domain/model";
import { asset, go, required, save, toast } from "../../services/store";
type E = {
  currentTarget: { dataset: Record<string, string> };
  detail: { value: string };
};
Page({
  data: {
    p: null as Project | null,
    bookImage: "",
    ready: false,
    name: "",
    phone: "",
    detail: "",
    error: "",
    submitted: false,
  },
  onShow() {
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
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value });
  },
  review() {
    go("manuscript");
  },
  submit() {
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
  order() {
    go("order");
  },
});
