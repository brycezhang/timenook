import type { StoryView } from "../../../packages/contracts/src";
import { projectOverviewClient } from "../../services/project-overview";
import { recordingId } from "../../services/local-audio-recorder";
import { sessionClient } from "../../services/session";
import { go } from "../../services/store";
Page({
  data: {
    rows: [] as { id: string; title: string; state: string }[],
    busy: false,
    pageLoading: true,
    status: "",
  },
  projectId: "",
  filter: "",
  generation: 0,
  onLoad(q) {
    this.projectId = q.projectId || "";
    this.filter = q.filter || "";
  },
  onShow() {
    void this.refresh();
  },
  onHide() {
    ++this.generation;
    this.setData({ rows: [], busy: false, pageLoading: false });
  },
  async refresh() {
    const n = ++this.generation,
      owner = sessionClient.context();
    this.setData({
      busy: true,
      pageLoading: !this.data.rows.length,
      status: "",
    });
    try {
      const p = await projectOverviewClient.read(this.projectId);
      if (n !== this.generation || owner !== sessionClient.context()) return;
      const label = (s: StoryView) =>
        s.revision
          ? s.included === false
            ? "暂不入书"
            : s.chapter?.title || "未归章"
          : s.task?.state === "no_content"
            ? "已有录音，待补充"
            : s.task?.state === "failed"
              ? "整理未完成"
              : "正在整理";
      this.setData({
        rows: p.stories
          .filter(
            (s) =>
              this.filter !== "unassigned" ||
              (s.revision && s.included !== false && !s.chapter),
          )
          .map((s) => ({
            id: s.id,
            title: s.revision?.title || "新记录的故事",
            state: label(s),
          })),
      });
    } catch (e) {
      if (n === this.generation)
        this.setData({
          status: e instanceof Error ? e.message : "未能读取故事",
        });
    } finally {
      if (n === this.generation)
        this.setData({ busy: false, pageLoading: false });
    }
  },
  open(e: WechatMiniprogram.TouchEvent) {
    go(
      "story",
      `projectId=${this.projectId}&storyId=${e.currentTarget.dataset.id}`,
    );
  },
  record() {
    go("interview", `projectId=${this.projectId}&draftId=${recordingId()}`);
  },
});
