import { type Project } from "../../domain/model";
import { go, home, read, required, save } from "../../services/store";
type E = {
  currentTarget: { dataset: Record<string, string> };
  detail: { value: string };
};
Page({
  data: { p: null as Project | null, agreed: false, missing: false },
  onLoad(q) {
    if (q.preview === "1" && !read()) {
      this.setData({ missing: true });
      return;
    }
    const p = read();
    if (!p) {
      this.setData({ missing: true });
      return;
    }
    this.setData({ p, agreed: p.consent });
  },
  agree() {
    this.setData({ agreed: !this.data.agreed });
  },
  accept() {
    const p = required();
    p.consent = true;
    p.role = "narrator";
    save(p);
    home();
  },
  privacy() {
    go("service", "kind=privacy");
  },
  decline() {
    home("home");
  },
  back() {
    home();
  },
});
