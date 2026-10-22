import { editStory } from "../../domain/model";
import { home, required, save } from "../../services/store";
type E = {
  currentTarget: { dataset: Record<string, string> };
  detail: { value: string };
};
Page({
  data: { id: "", title: "", body: "", error: "" },
  onLoad(q) {
    const s = required().stories.find((s) => s.id === q.id);
    if (!s) {
      home();
      return;
    }
    this.setData({ id: s.id, title: s.title, body: s.body });
  },
  input(e: E) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value });
  },
  save() {
    if (!this.data.title.trim() || !this.data.body.trim()) {
      this.setData({ error: "请填写标题与故事正文" });
      return;
    }
    const p = required();
    editStory(p, this.data.id, this.data.title.trim(), this.data.body.trim());
    save(p);
    wx.navigateBack();
  },
});
