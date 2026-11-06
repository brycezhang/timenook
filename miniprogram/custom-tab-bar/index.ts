import { isProjectTab, switchProjectTab } from "../services/navigation";

Component({
  data: { selected: "home", projectTitle: "故事书" },
  methods: {
    switchTab(e: WechatMiniprogram.TouchEvent) {
      const page = e.currentTarget.dataset.page as string;
      if (isProjectTab(page)) switchProjectTab(page);
    },
  },
});
