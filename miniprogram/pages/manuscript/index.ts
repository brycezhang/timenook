import { type Project } from "../../domain/model";
import { go, required, save, toast } from "../../services/store";
type E = {
  currentTarget: { dataset: Record<string, string> };
  detail: { value: string };
};
Page({
  data: {
    p: null as Project | null,
    stories: [] as Project["stories"],
    pending: 0,
    content: false,
    layout: false,
  },
  onShow() {
    const p = required();
    this.setData({
      p,
      stories: p.stories.filter((s) => s.included),
      pending: p.stories.filter(
        (s) => s.included && s.confirmedVersion !== s.version,
      ).length,
      content: p.contentApproved === p.revision,
      layout: p.layoutApproved === p.revision,
    });
  },
  content() {
    this.setData({ content: !this.data.content });
  },
  layout() {
    this.setData({ layout: !this.data.layout });
  },
  approve() {
    const p = required();
    if (
      !p.stories.some((s) => s.included) ||
      p.stories.some((s) => s.included && s.confirmedVersion !== s.version)
    ) {
      toast("请先完成每篇故事的本人确认");
      return;
    }
    if (!this.data.content || !this.data.layout) return;
    p.contentApproved = p.revision;
    p.layoutApproved = p.revision;
    save(p);
    go("print");
  },
  story(e: E) {
    go("story", "id=" + e.currentTarget.dataset.id);
  },
});
