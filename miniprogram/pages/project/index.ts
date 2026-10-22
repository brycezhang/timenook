import { type Project } from "../../domain/model";
import { asset, go, home, read, required } from "../../services/store";
type E = {
  currentTarget: { dataset: Record<string, string> };
  detail: { value: string };
};
Page({
  data: {
    p: null as Project | null,
    confirmed: 0,
    pending: 0,
    filter: "all",
    stories: [] as Project["stories"],
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
      confirmed: p.stories.filter((s) => s.confirmedVersion === s.version)
        .length,
      pending: p.stories.filter((s) => s.confirmedVersion !== s.version).length,
    });
    this.filterStories();
  },
  filterStories() {
    const p = required();
    this.setData({
      stories: p.stories.filter(
        (s) => this.data.filter === "all" || s.confirmedVersion !== s.version,
      ),
    });
  },
  filter(e: E) {
    this.setData({ filter: e.currentTarget.dataset.filter });
    this.filterStories();
  },
  record() {
    const p = required();
    if (!p.consent) {
      go("welcome");
      return;
    }
    go("interview");
  },
  photo() {
    const p = required();
    if (!p.consent) {
      go("welcome");
      return;
    }
    go("interview", "photo=1");
  },
  story(e: E) {
    go("story", "id=" + e.currentTarget.dataset.id);
  },
  invite() {
    go("invite");
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
