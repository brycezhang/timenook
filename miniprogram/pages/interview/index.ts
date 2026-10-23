import { dataMode } from "../../services/mode";
import { sessionClient, ApiFailure } from "../../services/session";
import {
  InterviewRecorder,
  interviewRecordingClient,
  recordingPartition,
} from "../../services/interview-recording";
import { recordingId } from "../../services/local-audio-recorder";
import { paymentKey } from "../../services/payments";
import type {
  ProductionTaskView,
  RecordingContext,
  RecordingInterview,
} from "../../../packages/contracts/src";
import type { ProbeLocalClip } from "../../../packages/contracts/src/audio-probe";
import { questions, samples, touch } from "../../domain/model";
import { recorder } from "../../services/recorder";
import { go, home, read, required, save } from "../../services/store";
type E = {
  currentTarget: { dataset: Record<string, string> };
  detail: { value: string };
};
Page({
  data: {
    mode: dataMode(),
    status: "",
    busy: false,
    canRecord: false,
    localClips: [] as ProbeLocalClip[],
    taskRows: [] as (ProductionTaskView & { label: string })[],
    taskError: "",
    pendingInterviews: [] as string[],
    interviews: [] as RecordingInterview[],
    interview: null as RecordingInterview | null,
    customText: "",
    customIntent: "",
    question: questions[0],
    questionIndex: 0,
    state: "idle",
    timer: "00:00",
    error: "",
    photo: "",
    permission: false,
  },
  projectId: "",
  assistedSessionId: "",
  requestedInterviewId: "",
  generation: 0,
  liveRecorder: null as InterviewRecorder | null,
  context: null as RecordingContext | null,
  storyOwnerContext: "",
  selection: null as {
    input: string;
    key: string;
    clientInterviewId: string;
  } | null,
  taskPollHandle: undefined as ReturnType<typeof setTimeout> | undefined,
  taskSequence: 0,
  taskVisible: false,
  taskDelay: 2000,
  taskRetries: {} as Record<string, string>,
  timerHandle: undefined as ReturnType<typeof setInterval> | undefined,
  stopSessionWatch: undefined as (() => void) | undefined,
  onLoad(q) {
    if (dataMode() === "live") {
      this.projectId = q.projectId ?? "";
      this.requestedInterviewId = q.interviewId ?? "";
      this.assistedSessionId = q.assistedSessionId ?? "";
      this.setData({ mode: "live", question: "", state: "idle" });
      return;
    }

    const p = read();
    if (!p?.consent) {
      home("welcome");
      return;
    }
    recorder.reset();
    recorder.subscribe((s) => {
      const min = Math.floor(s.seconds / 60)
          .toString()
          .padStart(2, "0"),
        sec = (s.seconds % 60).toString().padStart(2, "0");
      this.setData({
        state: s.state,
        timer: min + ":" + sec,
        error: s.error,
        permission: s.state === "error" && !recorder.hasPending,
      });
    });
    if (q.photo === "1") this.pickPhoto();
  },
  async onShow() {
    this.stopSessionWatch?.();
    this.stopSessionWatch = undefined;
    const ownerContext = sessionClient.context();
    if (dataMode() === "live" && ownerContext)
      this.stopSessionWatch = sessionClient.onInvalidated((context) => {
        if (context !== ownerContext) return;
        this.onHide();
        this.setData({
          status: sessionClient.sessionCleanupPending()
            ? "登录已失效；设备会话缓存清理失败，请重试登录"
            : "当前权限已失效，请重新查询或登录；本机原文件仍保留",
        });
      });
    this.taskVisible = true;
    if (dataMode() === "live") await this.refresh();
  },
  onHide() {
    this.stopSessionWatch?.();
    this.stopSessionWatch = undefined;
    this.taskVisible = false;
    if (this.taskPollHandle) clearTimeout(this.taskPollHandle);
    this.taskPollHandle = undefined;
    ++this.taskSequence;
    this.taskRetries = {};
    this.setData({ taskRows: [], taskError: "" });
    if (dataMode() === "live") {
      ++this.generation;
      this.liveRecorder?.stop();
      this.liveRecorder?.unsubscribe();
      if (this.timerHandle) clearInterval(this.timerHandle);
      this.context = null;
      this.storyOwnerContext = "";
      this.selection = null;
      this.setData({
        question: "",
        interview: null,
        localClips: [],
        interviews: [],
        pendingInterviews: [],
        customText: "",
        customIntent: "",
        busy: false,
        canRecord: false,
      });
      return;
    }
    recorder.stop();
  },
  onUnload() {
    if (dataMode() === "live") {
      this.onHide();
      return;
    }
    recorder.stop();
    recorder.unsubscribe();
  },
  current(generation: number, context: string) {
    return (
      generation === this.generation &&
      dataMode() === "live" &&
      context === sessionClient.context()
    );
  },
  async refresh() {
    this.storyOwnerContext = "";
    const generation = ++this.generation,
      context = sessionClient.context();
    if (this.taskPollHandle) clearTimeout(this.taskPollHandle);
    this.taskPollHandle = undefined;
    this.taskDelay = 2000;
    this.setData({
      taskRows: [],
      taskError: "",
      busy: true,
      status: "正在查询当前权限与保存状态",
      question: "",
      localClips: [],
      interview: null,
      interviews: [],
      pendingInterviews: [],
      canRecord: false,
    });
    try {
      if (!/^[a-f0-9-]{36}$/.test(this.projectId))
        throw new Error("请从本人参与的项目进入");
      const result = await interviewRecordingClient.context(
        this.projectId,
        this.assistedSessionId || undefined,
      );
      if (!this.current(generation, context)) return;
      this.context = result;
      this.setData({
        canRecord: result.canRecord,
        interviews: result.interviews,
        question:
          result.plan.defaultQuestion?.text ??
          "想从哪里讲起？可以自由讲述、看照片或自拟问题。",
        status: result.canRecord
          ? "先确定一个问题，再开始说。"
          : "当前不能新录音；已有文件与封存内容可按授权恢复。",
      });
      const index: unknown = wx.getStorageSync(
        `${recordingPartition(this.projectId)}:index`,
      );
      this.setData({
        pendingInterviews: Array.isArray(index)
          ? index.filter(
              (id) => typeof id === "string" && /^[a-f0-9-]{36}$/.test(id),
            )
          : [],
      });
      const active =
        this.requestedInterviewId ||
        wx.getStorageSync(`${recordingPartition(this.projectId)}:active`);
      let selected =
        result.interviews.find((i) => i.id === active) ?? result.interviews[0];
      if (
        !selected &&
        typeof active === "string" &&
        /^[a-f0-9-]{36}$/.test(active)
      )
        selected = await interviewRecordingClient.resume(
          this.projectId,
          active,
          this.assistedSessionId || undefined,
        );
      if (selected && this.current(generation, context)) {
        await this.attach(selected, generation, context);
        if (
          selected.clips.some((clip) => clip.state === "sealed") ||
          this.data.localClips.some((clip) => clip.sealed)
        )
          void this.refreshTasks();
      }
    } catch (error) {
      if (generation === this.generation) {
        this.liveRecorder?.unsubscribe();
        this.liveRecorder = null;
        this.context = null;
        this.storyOwnerContext = "";
        this.setData({
          question: "",
          interview: null,
          localClips: [],
          interviews: [],
          pendingInterviews: [],
          customText: "",
          customIntent: "",
          canRecord: false,
          status: error instanceof Error ? error.message : "查询失败，请重试",
        });
      }
    } finally {
      if (generation === this.generation) this.setData({ busy: false });
    }
  },
  async attach(value: RecordingInterview, generation: number, context: string) {
    if (
      value.projectId !== this.projectId ||
      !value.actualQuestion?.snapshot?.text
    )
      throw new Error("采访数据无效");
    this.liveRecorder?.unsubscribe();
    const device = InterviewRecorder.open(
      this.projectId,
      value,
      () => this.data.canRecord,
      this.assistedSessionId || undefined,
    );
    this.liveRecorder = device;
    this.storyOwnerContext = context;
    this.setData({
      interview: value,
      question: value.actualQuestion.snapshot.text,
      state: "idle",
    });
    device.subscribe((snapshot) => {
      if (snapshot.stage !== "recording" && this.timerHandle) {
        clearInterval(this.timerHandle);
        this.timerHandle = undefined;
      }
      if (this.current(generation, context)) {
        this.setData({
          state: snapshot.stage,
          status: snapshot.message,
          localClips: snapshot.clips,
        });
        if (snapshot.stage === "sealed") void this.refreshTasks();
      }
    });
    await device.restore();
  },
  photos() {
    const interview = this.data.interview;
    if (
      !interview ||
      ["recording", "requesting", "saving"].includes(this.data.state)
    )
      return;
    wx.navigateTo({
      url: `/pages/photos/index?projectId=${encodeURIComponent(this.projectId)}&interviewId=${encodeURIComponent(interview.id)}${this.assistedSessionId ? `&assistedSessionId=${encodeURIComponent(this.assistedSessionId)}` : ""}`,
    });
  },
  taskAuthorizationLost(error: unknown, generation: number, context: string) {
    const current = sessionClient.context();
    if (
      error instanceof ApiFailure &&
      [401, 403].includes(error.status) &&
      generation === this.generation &&
      dataMode() === "live" &&
      (!current || current === context)
    ) {
      this.onHide();
      this.setData({
        status: sessionClient.sessionCleanupPending()
          ? "登录已失效；设备会话缓存清理失败，请重试登录"
          : "当前权限已失效，请重新查询或登录；本机原文件仍保留",
      });
      return true;
    }
    return false;
  },
  async refreshTasks() {
    if (!this.taskVisible || dataMode() !== "live" || !this.data.interview)
      return;
    if (this.taskPollHandle) clearTimeout(this.taskPollHandle);
    this.taskPollHandle = undefined;
    const generation = this.generation,
      context = sessionClient.context(),
      sequence = ++this.taskSequence,
      interviewId = this.data.interview.id;
    try {
      const rows = await interviewRecordingClient.taskStatus(
        this.projectId,
        interviewId,
        this.assistedSessionId || undefined,
      );
      if (
        !this.taskVisible ||
        !this.current(generation, context) ||
        sequence !== this.taskSequence
      )
        return;
      if (rows.some((row) => row.projectId !== this.projectId))
        throw new Error("转写状态不匹配");
      const taskRows = rows.map((row) => ({
        ...row,
        label:
          row.errorCode === "AI_AUTHORIZATION_REQUIRED"
            ? "原声已保存；等待本人选择 AI 处理授权，可以先离开。"
            : row.state === "succeeded"
              ? "转写完成；原声与正式转录已保存。"
              : row.state === "no_speech"
                ? "无有效语音；可以回听原声、继续补录或换个问题。"
                : row.state === "failed"
                  ? row.retryable
                    ? "转写未完成；已保存原声，可以按原任务重试。"
                    : "转写未完成；原声仍保留，请联系服务继续处理。"
                  : row.state === "manual_review"
                    ? "转写需要人工接管；原声仍保留，请联系服务。"
                    : row.state === "invalidated"
                      ? "本次处理授权已失效，请重新查询权限或联系服务。"
                      : "转写中；原声已保存，可以离开，返回后继续查询。",
      }));
      this.setData({ taskRows, taskError: "" });
      if (
        rows.some((row) =>
          ["queued", "waiting_provider", "submitting"].includes(row.state),
        )
      ) {
        this.taskPollHandle = setTimeout(
          () => void this.refreshTasks(),
          this.taskDelay,
        );
        this.taskDelay = Math.min(10000, this.taskDelay * 2);
      }
    } catch (error) {
      if (!this.taskVisible || generation !== this.generation) return;
      // Current-session invalidation also applies to an older overlapping query.
      if (
        error instanceof ApiFailure &&
        error.status === 401 &&
        this.taskAuthorizationLost(error, generation, context)
      )
        return;
      if (sequence !== this.taskSequence) return;
      if (this.taskAuthorizationLost(error, generation, context)) return;
      if (!this.current(generation, context)) return;
      this.setData({
        taskRows:
          error instanceof ApiFailure &&
          (error.status === 401 || error.status === 403)
            ? []
            : this.data.taskRows,
        taskError: "转写状态未能确认；原声仍保留，请重新查询。",
      });
    }
  },
  async retryTranscription(e: E) {
    const id = e.currentTarget.dataset.id;
    if (
      this.data.busy ||
      !this.data.taskRows.some((row) => row.id === id && row.retryable)
    )
      return;
    const generation = this.generation,
      context = sessionClient.context();
    this.taskRetries[id] ??= paymentKey();
    this.setData({ busy: true, taskError: "" });
    try {
      await interviewRecordingClient.retryTask(
        this.projectId,
        id,
        this.taskRetries[id],
        this.assistedSessionId || undefined,
      );
      if (!this.current(generation, context)) return;
      delete this.taskRetries[id];
      this.taskDelay = 2000;
      await this.refreshTasks();
    } catch (error) {
      if (this.taskAuthorizationLost(error, generation, context)) return;
      if (this.current(generation, context))
        this.setData({
          taskError: "重试结果未确认，请重新查询；相同任务保留原请求。",
        });
    } finally {
      if (this.current(generation, context)) this.setData({ busy: false });
    }
  },
  async selectQuestion(e?: E) {
    if (
      !this.context ||
      this.data.busy ||
      !this.data.canRecord ||
      this.data.state === "recording" ||
      this.data.state === "requesting" ||
      this.data.state === "saving"
    )
      return;
    const kind = e?.currentTarget?.dataset.kind ?? "plan";
    const source =
      kind === "custom"
        ? {
            selfWritten: {
              text: this.data.customText,
              intent: this.data.customIntent,
            },
          }
        : kind === "plan" && this.context.plan.defaultQuestion
          ? { questionKey: this.context.plan.defaultQuestion.key }
          : { starterKind: kind === "photo" ? "photo" : "free-narration" };
    const command = {
      expectedPlanRevision: this.context.plan.revision,
      ...source,
      ...(this.assistedSessionId
        ? { assistedSessionId: this.assistedSessionId }
        : {}),
    };
    const input = JSON.stringify(command);
    if (this.selection?.input !== input)
      this.selection = {
        input,
        key: paymentKey(),
        clientInterviewId: recordingId(),
      };
    const generation = this.generation,
      context = sessionClient.context();
    this.setData({ busy: true, status: "正在确定本次实际问题" });
    try {
      const selected = await interviewRecordingClient.start(
        this.projectId,
        { ...command, clientInterviewId: this.selection.clientInterviewId },
        this.selection.key,
      );
      if (!this.current(generation, context)) return;
      const partition = recordingPartition(this.projectId),
        index: unknown = wx.getStorageSync(`${partition}:index`);
      const ids = Array.isArray(index)
        ? index.filter(
            (id) => typeof id === "string" && /^[a-f0-9-]{36}$/.test(id),
          )
        : [];
      if (!ids.includes(selected.id)) ids.push(selected.id);
      wx.setStorageSync(`${partition}:index`, ids);
      wx.setStorageSync(`${partition}:active`, selected.id);
      this.selection = null;
      this.setData({ pendingInterviews: ids });
      await this.attach(selected, generation, context);
      if (kind === "photo") this.photos();
    } catch (error) {
      if (generation === this.generation && dataMode() === "live") {
        if (
          error instanceof ApiFailure &&
          (error.status === 401 || error.status === 403)
        ) {
          this.liveRecorder?.unsubscribe();
          this.liveRecorder = null;
          this.context = null;
          this.storyOwnerContext = "";
          this.selection = null;
          this.setData({
            question: "",
            interview: null,
            localClips: [],
            interviews: [],
            pendingInterviews: [],
            customText: "",
            customIntent: "",
            canRecord: false,
          });
        }
        this.setData({
          status:
            error instanceof Error ? error.message : "本次问题未确认，请重试",
        });
      }
    } finally {
      if (this.current(generation, context)) this.setData({ busy: false });
    }
  },
  async resumeLocal(e: E) {
    if (
      this.data.busy ||
      this.data.state === "recording" ||
      this.data.state === "requesting" ||
      this.data.state === "saving"
    )
      return;
    const id = e.currentTarget.dataset.id;
    if (!this.data.pendingInterviews.includes(id)) return;
    const generation = this.generation,
      context = sessionClient.context();
    this.setData({ busy: true });
    try {
      const selected = await interviewRecordingClient.resume(
        this.projectId,
        id,
        this.assistedSessionId || undefined,
      );
      if (this.current(generation, context)) {
        wx.setStorageSync(`${recordingPartition(this.projectId)}:active`, id);
        await this.attach(selected, generation, context);
      }
    } catch (error) {
      if (this.current(generation, context))
        this.setData({
          question: "",
          interview: null,
          localClips: [],
          status:
            error instanceof Error ? error.message : "未能恢复，本机文件仍保留",
        });
    } finally {
      if (this.current(generation, context)) this.setData({ busy: false });
    }
  },
  customText(e: E) {
    this.setData({ customText: e.detail.value });
  },
  customIntent(e: E) {
    this.setData({ customIntent: e.detail.value });
  },
  async upload(e: E) {
    if (this.data.busy || !this.liveRecorder) return;
    const generation = this.generation,
      context = sessionClient.context();
    this.setData({ busy: true });
    try {
      await this.liveRecorder.upload(e.currentTarget.dataset.id);
    } catch (error) {
      if (
        generation === this.generation &&
        error instanceof ApiFailure &&
        (error.status === 401 || error.status === 403)
      ) {
        this.liveRecorder.unsubscribe();
        this.liveRecorder = null;
        this.context = null;
        this.storyOwnerContext = "";
        this.setData({
          question: "",
          interview: null,
          localClips: [],
          interviews: [],
          pendingInterviews: [],
          customText: "",
          customIntent: "",
          canRecord: false,
          status: "当前访问已失效，本机文件仍保留；请重新查询权限",
        });
      }
    } finally {
      if (generation === this.generation) this.setData({ busy: false });
    }
  },
  async record() {
    if (dataMode() === "live") {
      if (this.data.busy || !this.liveRecorder) return;
      if (this.data.state === "recording" || this.data.state === "requesting") {
        this.liveRecorder.stop();
        if (this.timerHandle) clearInterval(this.timerHandle);
      } else {
        const generation = this.generation,
          context = sessionClient.context();
        this.setData({ busy: true });
        try {
          const result = await interviewRecordingClient.authorizeStart(
            this.projectId,
            this.data.interview!.id,
            this.assistedSessionId || undefined,
          );
          if (!this.current(generation, context) || !result.allowed) return;
          this.liveRecorder!.start();
          const began = Date.now();
          this.timerHandle = setInterval(() => {
            const seconds = Math.floor((Date.now() - began) / 1000);
            this.setData({
              timer: `${Math.floor(seconds / 60)
                .toString()
                .padStart(
                  2,
                  "0",
                )}:${(seconds % 60).toString().padStart(2, "0")}`,
            });
          }, 1000);
        } catch (error) {
          if (generation === this.generation && dataMode() === "live") {
            if (
              error instanceof ApiFailure &&
              (error.status === 401 || error.status === 403)
            ) {
              this.liveRecorder?.unsubscribe();
              this.liveRecorder = null;
              this.context = null;
              this.storyOwnerContext = "";
              this.selection = null;
              this.setData({
                question: "",
                interview: null,
                localClips: [],
                interviews: [],
                pendingInterviews: [],
                customText: "",
                customIntent: "",
                canRecord: false,
              });
            }
            this.setData({
              status: error instanceof Error ? error.message : "不能开始录音",
            });
          }
        } finally {
          if (generation === this.generation) this.setData({ busy: false });
        }
      }
      return;
    }

    if (this.data.state === "recording") recorder.stop();
    else if (this.data.state === "idle") recorder.start(this.data.question);
  },
  change() {
    const i = (this.data.questionIndex + 1) % questions.length;
    this.setData({ questionIndex: i, question: questions[i] });
  },
  continue() {
    recorder.reset();
    this.setData({ question: "关于那段日子，\n还有什么想说的吗？" });
  },
  async retry() {
    if (dataMode() === "live") {
      await this.liveRecorder?.retrySave();
      return;
    }
    if (recorder.hasPending) void recorder.retry();
    else {
      recorder.reset();
      this.setData({ state: "idle" });
    }
  },
  settings() {
    wx.openSetting({});
  },
  openStory() {
    const interview = this.data.interview,
      context = sessionClient.context();
    if (
      dataMode() !== "live" ||
      !context ||
      context !== this.storyOwnerContext ||
      !interview ||
      interview.projectId !== this.projectId ||
      this.data.busy ||
      ["recording", "requesting", "saving", "device-error"].includes(
        this.data.state,
      )
    )
      return;
    go(
      "story",
      `projectId=${this.projectId}&interviewId=${interview.id}${this.assistedSessionId ? `&assistedSessionId=${this.assistedSessionId}` : ""}`,
    );
  },
  finish() {
    if (dataMode() === "live") {
      go("welcome", `projectId=${this.projectId}`);
      return;
    }
    home();
  },
  example() {
    const p = required();
    let s = p.stories.find((s) => s.id === "sample-0");
    if (!s) {
      s = {
        ...samples[0],
        id: "sample-0",
        version: 1,
        confirmedVersion: null,
        included: true,
        photos: [],
        recordings: [],
        sample: true,
      };
      p.stories.push(s);
      touch(p);
      save(p);
    }
    go("story", "id=sample-0");
  },
  pickPhoto() {
    wx.chooseMedia({
      count: 1,
      mediaType: ["image"],
      success: (r) => {
        this.setData({ photo: r.tempFiles[0].tempFilePath });
      },
    });
  },
});
