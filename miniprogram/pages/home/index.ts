import { demo, go, home, read } from "../../services/store";
type E = {
  currentTarget: { dataset: Record<string, string> };
  detail: { value: string };
};
Page({
  data: { hasProject: false },
  onLoad(q) {
    if (read()?.purchased && q.browse !== "1") home();
  },
  onShow() {
    this.setData({ hasProject: !!read() });
  },
  project() {
    home();
  },
  choose(e: E) {
    go(
      "purchase",
      "recipient=" + encodeURIComponent(e.currentTarget.dataset.recipient),
    );
  },
  experience() {
    demo();
    home();
  },
  privacy() {
    go("service", "kind=privacy");
  },
});
