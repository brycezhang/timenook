import { NATIVE_TABS } from "../../config";
import {
  showProjectTab,
  switchProjectTab,
  tabProjectId,
} from "../../services/navigation";
import { recordingPartition } from "../../services/interview-recording";
import { recordingId } from "../../services/local-audio-recorder";
import { watchProjectAccess } from "../../services/project-access";
import { dataMode } from "../../services/mode";
import { sessionClient, ApiFailure } from "../../services/session";
import { participationClient } from "../../services/participation";
import { projectOverviewClient } from "../../services/project-overview";
import type {
  RecordingContext,
  ParticipationState,
  ProjectOverview,
  ProductionTaskView,
} from "../../../packages/contracts/src";
import { type Project } from "../../domain/model";
import { asset, go, home, read, required } from "../../services/store";
type E = {
  currentTarget: { dataset: Record<string, string> };
  detail: { value: string };
};
function taskLabels(task: ProductionTaskView) {
  const kindLabel = {
    transcribe_audio: "录音转写",
    compose_story: "故事整理",
    ask_followup: "可选追问",
    render_book: "书稿生成",
  }[task.kind];
  const stateLabel = {
    waiting_inputs: "等待原声转写",
    obsolete: "素材已变化",
    queued: "排队中",
    submitting: "处理中",
    waiting_provider: "等待处理结果",
    succeeded: "已完成",
    no_speech: "未识别到语音",
    no_content: "已转写，暂未形成故事",
    failed: "失败",
    manual_review: "需要人工协助",
    invalidated: "授权或素材已变化",
  }[task.state];
  const nextActionLabel = {
    record_again: "重新录一段",
    retry: "可以重试当前任务",
    contact_support: "请联系人工协助",
    continue: "可以继续讲述或核对故事",
    leave_and_return: "可以离开后再查询",
  }[task.nextAction];
  return { ...task, kindLabel, stateLabel, nextActionLabel };
}
type ResumeInterview = RecordingContext["interviews"][number] & {
  resumeLabel: string;
};
function needsRecovery(task: ProductionTaskView) {
  return (
    [
      "failed",
      "manual_review",
      "invalidated",
      "no_speech",
      "no_content",
      "obsolete",
    ].includes(task.state) || task.errorCode === "AI_AUTHORIZATION_REQUIRED"
  );
}
Page({
  data: {
    nativeTabs: NATIVE_TABS,
    mode: dataMode(),
    status: "",
    busy: false,
    interviews: [] as (RecordingContext["interviews"][number] & {
      resumeLabel: string;
    })[],
    taskRows: [] as ReturnType<typeof taskLabels>[],
    faultRows: [] as ReturnType<typeof taskLabels>[],
    historyTaskRows: [] as ReturnType<typeof taskLabels>[],
    recentInterview: null as ResumeInterview | null,
    historyInterviews: [] as ResumeInterview[],
    localRecoveryIds: [] as string[],
    historyExpanded: false,
    live: null as RecordingContext | null,
    overview: null as ProjectOverview | null,
    liveStories: [] as ProjectOverview["stories"],
    participation: null as ParticipationState | null,
    p: null as Project | null,
    confirmed: 0,
    pending: 0,
    filter: "all",
    stories: [] as Project["stories"],
    bookImage: "",
  },
  projectId: "",
  assistedSessionId: "",
  generation: 0,
  stopProjectWatch: undefined as (() => void) | undefined,
  stopSessionWatch: undefined as (() => void) | undefined,
  expiry: undefined as ReturnType<typeof setTimeout> | undefined,
  onLoad(q) {
    this.projectId = dataMode() === "live" ? tabProjectId(q.projectId) : "";
    this.assistedSessionId = q.assistedSessionId || "";
  },
  onHide() {
    this.stopProjectWatch?.();
    this.stopProjectWatch = undefined;
    if (dataMode() === "live") {
      ++this.generation;
      this.stopSessionWatch?.();
      this.stopSessionWatch = undefined;
      if (this.expiry) clearTimeout(this.expiry);
      this.setData({
        overview: null,
        liveStories: [],
        taskRows: [],
        faultRows: [],
        historyTaskRows: [],
        recentInterview: null,
        historyInterviews: [],
        localRecoveryIds: [],
        historyExpanded: false,
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
      overview: null,
      liveStories: [],
      taskRows: [],
      faultRows: [],
      historyTaskRows: [],
      recentInterview: null,
      historyInterviews: [],
      localRecoveryIds: [],
      historyExpanded: false,
      busy: true,
      live: null,
      interviews: [],
      participation: null,
      status: "",
    });
    this.stopSessionWatch?.();
    this.stopSessionWatch = sessionClient.onInvalidated(() => {
      this.onHide();
      this.setData({ status: "登录已失效，请重新登录" });
    });
    try {
      const participation = await participationClient.state(this.projectId);
      if (generation !== this.generation || context !== sessionClient.context())
        return;
      this.setData({ participation });
      if (participation.canRead) {
        const overview = await projectOverviewClient.read(this.projectId);
        if (
          generation === this.generation &&
          context === sessionClient.context()
        ) {
          projectOverviewClient.select(this.projectId);
          showProjectTab(this, "project", overview.bookTitle);
          this.setData({
            overview,
            interviews: overview.interviews.map((interview) => ({
              ...interview,
              resumeLabel: (
                interview.currentQuestion ?? interview.actualQuestion
              ).snapshot.text,
            })),
            taskRows: overview.tasks.map(taskLabels),
            pending: overview.summary.pending,
            confirmed: overview.summary.confirmed,
          });
          this.updatePresentation();
          this.filterStories();
          if (overview.accessExpiresAt) {
            if (this.expiry) clearTimeout(this.expiry);
            this.expiry = setTimeout(
              () => {
                if (
                  generation !== this.generation ||
                  context !== sessionClient.context()
                )
                  return;
                this.onHide();
                this.setData({ status: "当前资料访问已到期，请重新查询授权" });
              },
              Math.min(
                2147483647,
                Math.max(0, Date.parse(overview.accessExpiresAt) - Date.now()),
              ),
            );
          }
        }
      } else
        this.setData({
          status: "尚未取得共享查看授权；本人在场时可另行选择同机采集用途",
        });
    } catch (error) {
      if (generation === this.generation) {
        const collectionOnly =
          context === sessionClient.context() &&
          error instanceof ApiFailure &&
          error.status === 403 &&
          this.data.participation?.role === "initiator";
        this.setData({
          live: null,
          overview: null,
          liveStories: [],
          taskRows: [],
          faultRows: [],
          historyTaskRows: [],
          recentInterview: null,
          historyInterviews: [],
          localRecoveryIds: [],
          historyExpanded: false,
          interviews: [],
          participation: collectionOnly ? this.data.participation : null,
          status: collectionOnly
            ? "当前没有故事共享查看授权；本人在场时仍可按当次采集用途协助讲述"
            : error instanceof Error
              ? error.message
              : "查询失败",
        });
      }
    } finally {
      if (generation === this.generation) this.setData({ busy: false });
    }
  },
  updatePresentation() {
    const { overview, interviews, taskRows } = this.data;
    if (!overview) return;
    const recentInterview =
      interviews.find(
        (interview) =>
          !overview.stories.some(
            (story) =>
              story.interviewId === interview.id && story.decision?.confirmed,
          ),
      ) ?? null;
    const partition = recordingPartition(this.projectId);
    const index: unknown = wx.getStorageSync(`${partition}:index`);
    const localRecoveryIds = Array.isArray(index)
      ? index.filter((id) => {
          if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id))
            return false;
          const clips: unknown = wx.getStorageSync(`${partition}:${id}`);
          return (
            Array.isArray(clips) &&
            clips.some(
              (clip) => clip && typeof clip.path === "string" && !clip.sealed,
            )
          );
        })
      : [];
    this.setData({
      recentInterview,
      historyInterviews: interviews.filter(
        (interview) => interview.id !== recentInterview?.id,
      ),
      faultRows: taskRows.filter(needsRecovery),
      historyTaskRows: taskRows.filter((task) => !needsRecovery(task)),
      localRecoveryIds,
    });
  },
  toggleHistory() {
    this.setData({ historyExpanded: !this.data.historyExpanded });
  },
  recoverTask(e: E) {
    const task = this.data.taskRows.find(
      (row) => row.id === e.currentTarget.dataset.id,
    );
    if (!task || !this.data.overview) return;
    const story = this.data.overview.stories.find(
      (story) => story.task?.id === task.id,
    );
    if (story) {
      this.story({ ...e, currentTarget: { dataset: { id: story.id } } });
      return;
    }
    if (task.kind === "render_book") {
      this.book();
      return;
    }
    const interview = this.data.interviews.find((interview) =>
      interview.clips.some((clip) => clip.id === task.clipId),
    );
    go(
      "interview",
      `projectId=${this.projectId}${interview ? `&interviewId=${interview.id}` : ""}${this.assistedSessionId ? `&assistedSessionId=${this.assistedSessionId}` : ""}`,
    );
  },
  resume(e: E) {
    if (dataMode() === "live")
      go(
        "interview",
        `projectId=${this.projectId}&interviewId=${e.currentTarget.dataset.id}${this.assistedSessionId ? `&assistedSessionId=${this.assistedSessionId}` : ""}`,
      );
  },
  plan() {
    go("plan", `projectId=${this.projectId}`);
  },
  settings() {
    go("settings", `projectId=${this.projectId}`);
  },
  assisted() {
    go("assisted", `projectId=${this.projectId}`);
  },
  async onShow() {
    showProjectTab(
      this,
      "project",
      this.data.overview?.bookTitle || this.data.p?.title,
    );
    if (dataMode() === "live") {
      const selectedProjectId = tabProjectId();
      if (selectedProjectId && selectedProjectId !== this.projectId) {
        this.projectId = selectedProjectId;
        this.assistedSessionId = "";
      }
      this.setData({ mode: "live", p: null });
      await this.refresh();
      const generation = this.generation,
        owner = sessionClient.context();
      if (this.data.overview) {
        this.stopProjectWatch?.();
        this.stopProjectWatch = watchProjectAccess(
          this.projectId,
          () =>
            generation === this.generation && owner === sessionClient.context(),
          () => {
            this.onHide();
            this.setData({
              status: "资料用途或账号授权已变化，私人内容已清理，请重新查询",
            });
          },
          this.data.participation?.accessEpoch,
        );
      }
      return;
    }

    const p = read();
    if (!p) {
      home("home");
      return;
    }
    this.setData({
      mode: "demo",
      p,
      bookImage: asset(p),
      confirmed: p.stories.filter((s) => s.confirmedVersion === s.version)
        .length,
      pending: p.stories.filter((s) => s.confirmedVersion !== s.version).length,
    });
    showProjectTab(this, "project", p.title);
    this.filterStories();
  },
  filterStories() {
    if (dataMode() === "live") {
      this.setData({
        liveStories: (this.data.overview?.stories ?? [])
          .filter((s) => this.data.filter === "all" || !s.decision?.confirmed)
          .sort(
            (a, b) =>
              Number(!!a.decision?.confirmed) - Number(!!b.decision?.confirmed),
          ),
      });
      return;
    }
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
        go(
          "interview",
          `projectId=${this.projectId}&draftId=${recordingId()}${this.assistedSessionId ? `&assistedSessionId=${this.assistedSessionId}` : ""}`,
        );
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
    if (dataMode() === "live") {
      go(
        "story",
        `projectId=${this.projectId}&storyId=${e.currentTarget.dataset.id}`,
      );
      return;
    }
    go("story", "id=" + e.currentTarget.dataset.id);
  },
  participate() {
    go("welcome", `projectId=${this.projectId}`);
  },
  invite() {
    go("invite", dataMode() === "live" ? `projectId=${this.projectId}` : "");
  },
  project() {
    switchProjectTab("project", this.projectId);
  },
  book() {
    switchProjectTab("book", this.projectId);
  },
  account() {
    switchProjectTab("account", this.projectId);
  },
});
