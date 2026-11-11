import type { StoryView } from "../../../packages/contracts/src";
import { projectOverviewClient } from "../../services/project-overview";
import { recordingId } from "../../services/local-audio-recorder";
import { sessionClient } from "../../services/session";
import { storyClient } from "../../services/stories";
import {
  privatePhotoPreview,
  clearPhotoPreviews,
} from "../../services/story-photos";
import {
  storyDuration,
  storyPlacement,
  storyState,
} from "../../services/story-presentation";
import { go } from "../../services/store";
type Row = {
  id: string;
  title: string;
  state: string;
  excerpt: string;
  duration: string;
  image: string;
};
Page({
  data: {
    rows: [] as Row[],
    excludedRows: [] as Row[],
    unassigned: false,
    unassignedCount: 0,
    busy: false,
    pageLoading: true,
    status: "",
  },
  stories: [] as StoryView[],
  projectId: "",
  generation: 0,
  owner: "",
  stopSession: undefined as (() => void) | undefined,
  onLoad(q) {
    this.projectId = q.projectId || "";
    this.setData({ unassigned: q.filter === "unassigned" });
    this.stopSession?.();
    this.stopSession = sessionClient.onInvalidated(() => {
      this.onHide();
      this.setData({ status: "登录已失效，请重新登录" });
    });
  },
  onShow() {
    return this.refresh();
  },
  onHide() {
    ++this.generation;
    this.stories = [];
    this.setData({
      rows: [],
      excludedRows: [],
      unassignedCount: 0,
      busy: false,
      pageLoading: false,
    });
    void clearPhotoPreviews().catch(() => {});
  },
  onUnload() {
    this.onHide();
    this.stopSession?.();
  },
  current(n: number) {
    return (
      n === this.generation &&
      !!this.owner &&
      this.owner === sessionClient.context()
    );
  },
  async refresh() {
    const n = ++this.generation;
    this.owner = sessionClient.context();
    this.setData({
      busy: true,
      pageLoading: !this.data.rows.length && !this.data.excludedRows.length,
      status: "",
    });
    try {
      const p = await projectOverviewClient.read(this.projectId);
      if (!this.current(n)) return;
      this.stories = p.stories;
      const row = (s: StoryView): Row => ({
        id: s.id,
        title: s.revision?.title || "新记录的故事",
        state:
          storyState(s) === "processing"
            ? "正在整理"
            : storyState(s) === "failed"
              ? "整理未完成"
              : storyPlacement(s),
        excerpt:
          s.revision?.paragraphs
            .map((p) => p.text)
            .join(" ")
            .slice(0, 58) || "录音已保存",
        duration: storyDuration(s),
        image: "",
      });
      const unassigned = p.stories.filter(
        (s) => s.revision && s.included !== false && !s.chapter,
      );
      this.setData({
        rows: (this.data.unassigned ? unassigned : p.stories).map(row),
        excludedRows: this.data.unassigned
          ? p.stories.filter((s) => s.revision && s.included === false).map(row)
          : [],
        unassignedCount: unassigned.length,
      });
      if (!this.data.unassigned) void this.loadPhotos(n, p.stories);
    } catch (error) {
      if (this.current(n))
        this.setData({
          status: error instanceof Error ? error.message : "未能读取故事",
        });
    } finally {
      if (this.current(n)) this.setData({ busy: false, pageLoading: false });
    }
  },
  async loadPhotos(n: number, stories: StoryView[]) {
    await Promise.all(
      stories.map(async (story) => {
        const photo = story.revision?.photoSnapshot?.entries[0];
        const asset = photo?.assets.find((a) => a.kind === "preview");
        if (!photo || !asset) return;
        try {
          const image = await privatePhotoPreview(
            this.projectId,
            photo.photoId,
            asset,
            () => this.current(n),
          );
          if (this.current(n))
            this.setData({
              rows: this.data.rows.map((row) =>
                row.id === story.id ? { ...row, image } : row,
              ),
            });
          else await clearPhotoPreviews([image]);
        } catch {
          /* A failed thumbnail never hides the saved story. */
        }
      }),
    );
  },
  open(e: WechatMiniprogram.TouchEvent) {
    go(
      "story",
      `projectId=${this.projectId}&storyId=${e.currentTarget.dataset.id}`,
    );
  },
  assign(e: WechatMiniprogram.TouchEvent) {
    go(
      "assign-story",
      `projectId=${this.projectId}&storyId=${e.currentTarget.dataset.id}`,
    );
  },
  unassigned() {
    go("stories", `projectId=${this.projectId}&filter=unassigned`);
  },
  async exclude(e: WechatMiniprogram.TouchEvent) {
    const story = this.stories.find(
        (s: StoryView) => s.id === e.currentTarget.dataset.id,
      ),
      n = this.generation;
    if (!story || this.data.busy) return;
    this.setData({ busy: true, status: "" });
    try {
      await storyClient.inclusion(
        this.projectId,
        story.id,
        story.version,
        false,
      );
      if (this.current(n)) await this.refresh();
    } catch (error) {
      if (this.current(n))
        this.setData({
          status: error instanceof Error ? error.message : "未能保存",
        });
    } finally {
      if (this.current(n)) this.setData({ busy: false });
    }
  },
  record() {
    go(
      "interview",
      `projectId=${this.projectId}&draftId=${recordingId()}&prepare=1`,
    );
  },
});
