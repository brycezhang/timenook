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
  selection: null as {
    input: string;
    key: string;
    clientInterviewId: string;
  } | null,
  timerHandle: undefined as ReturnType<typeof setInterval> | undefined,
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
    if (dataMode() === "live") await this.refresh();
  },
  onHide() {
    if (dataMode() === "live") {
      ++this.generation;
      this.liveRecorder?.stop();
      this.liveRecorder?.unsubscribe();
      if (this.timerHandle) clearInterval(this.timerHandle);
      this.context = null;
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
    const generation = ++this.generation,
      context = sessionClient.context();
    this.setData({
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
      if (selected && this.current(generation, context))
        await this.attach(selected, generation, context);
    } catch (error) {
      if (generation === this.generation) {
        this.liveRecorder?.unsubscribe();
        this.liveRecorder = null;
        this.context = null;
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
      if (this.current(generation, context))
        this.setData({
          state: snapshot.stage,
          status: snapshot.message,
          localClips: snapshot.clips,
        });
    });
    await device.restore();
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
    } catch (error) {
      if (generation === this.generation && dataMode() === "live") {
        if (
          error instanceof ApiFailure &&
          (error.status === 401 || error.status === 403)
        ) {
          this.liveRecorder?.unsubscribe();
          this.liveRecorder = null;
          this.context = null;
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
