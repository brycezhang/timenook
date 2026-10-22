import { type Project } from "../../domain/model";
import { asset, go, home, read } from "../../services/store";
type E = {
  currentTarget: { dataset: Record<string, string> };
  detail: { value: string };
};
Page({
  data: {
    p: null as Project | null,
    stories: [] as Project["stories"],
    pending: 0,
    bookImage: "",
  },
  onShow() {
    const p = read();
    if (!p) {
      home("home");
      return;
    }
    this.setData({
      p,
      bookImage: asset(p),
      stories: p.stories.filter((s) => s.included),
      pending: p.stories.filter(
        (s) => s.included && s.confirmedVersion !== s.version,
      ).length,
    });
  },
  manuscript() {
    go("manuscript");
  },
  story(e: E) {
    go("story", "id=" + e.currentTarget.dataset.id);
  },
  print() {
    go("print");
  },
  settings() {
    go("settings");
  },
  record() {
    go("interview");
  },
  project() {
    home("project");
  },
  book() {
    home("book");
  },
  account() {
    home("account");
  },
});
