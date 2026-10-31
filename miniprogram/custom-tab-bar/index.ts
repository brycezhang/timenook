import { isProjectTab, switchProjectTab } from "../services/navigation";

Component({
  data: { selected: "project", projectTitle: "项目" },
  methods: {
    switchTab(e: WechatMiniprogram.TouchEvent) {
      const page = e.currentTarget.dataset.page as string;
      if (isProjectTab(page) && page !== this.data.selected)
        switchProjectTab(page);
    },
  },
});
