import { dataMode } from "../../services/mode";
import { sessionClient } from "../../services/session";
import { participationClient } from "../../services/participation";
import { interviewRecordingClient } from "../../services/interview-recording";
import type {
  RecordingContext,
  ParticipationState,
} from "../../../packages/contracts/src";
import { type Project } from "../../domain/model";
import { asset, go, home, read, required } from "../../services/store";
type E = {
  currentTarget: { dataset: Record<string, string> };
  detail: { value: string };
};
Page({
  data: {
    mode: dataMode(),
    status: "",
    busy: false,
    interviews: [] as RecordingContext["interviews"],
    live: null as RecordingContext | null,
    participation: null as ParticipationState | null,
    p: null as Project | null,
    confirmed: 0,
    pending: 0,
    filter: "all",
    stories: [] as Project["stories"],
    bookImage: "",
  },
  projectId: "",
  generation: 0,
  onLoad(q) {
    this.projectId = q.projectId ?? "";
  },
  onHide() {
    if (dataMode() === "live") {
      ++this.generation;
      this.setData({
        live: null,
        interviews: [],
        participation: null,
        status: "",
        busy: false,
      });
    }
  },
  onUnload() {
    this.onHide();
  },
  async refresh() {
    const generation = ++this.generation,
      context = sessionClient.context();
    this.setData({
      busy: true,
      live: null,
      interviews: [],
      participation: null,
      status: "",
    });
    try {
      const participation = await participationClient.state(this.projectId);
      if (generation !== this.generation || context !== sessionClient.context())
        return;
      this.setData({ participation });
      if (participation.canRead) {
        const live = await interviewRecordingClient.context(this.projectId);
        if (
          generation === this.generation &&
          context === sessionClient.context()
        )
          this.setData({ live, interviews: live.interviews });
      }
    } catch (error) {
      if (generation === this.generation)
        this.setData({
          live: null,
          interviews: [],
          participation: null,
          status: error instanceof Error ? error.message : "查询失败",
        });
    } finally {
      if (generation === this.generation) this.setData({ busy: false });
    }
  },
  resume(e: E) {
    if (dataMode() === "live")
      go(
        "interview",
        `projectId=${this.projectId}&interviewId=${e.currentTarget.dataset.id}`,
      );
  },
  plan() {
    go("plan", `projectId=${this.projectId}`);
  },
  async onShow() {
    if (dataMode() === "live") {
      this.setData({ mode: "live", p: null });
      await this.refresh();
      return;
    }

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
    if (dataMode() === "live") {
      if (this.data.participation?.canCollect)
        go("interview", `projectId=${this.projectId}`);
      return;
    }
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
