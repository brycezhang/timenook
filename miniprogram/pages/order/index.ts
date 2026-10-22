import { type Project } from "../../domain/model";
import { asset, go, home, read } from "../../services/store";
type E = {
  currentTarget: { dataset: Record<string, string> };
  detail: { value: string };
};
Page({
  data: { p: null as Project | null, bookImage: "" },
  onShow() {
    const p = read();
    if (!p) {
      home("home");
      return;
    }
    this.setData({ p, bookImage: asset(p) });
  },
  project() {
    home();
  },
  book() {
    home("book");
  },
  support() {
    go("service", "kind=support");
  },
});
