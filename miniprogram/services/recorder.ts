import { recordingLease } from "./recording-lease";
const microphoneOwner = {};
import type { Recording } from "../domain/model";
import { read, save } from "./store";
export type RecordState =
  "idle" | "requesting" | "recording" | "saving" | "saved" | "error";
export interface Snapshot {
  state: RecordState;
  seconds: number;
  error: string;
  recording: Recording | null;
}
const manager = wx.getRecorderManager();
let current: Snapshot = {
  state: "idle",
  seconds: 0,
  error: "",
  recording: null,
};
let listener: ((s: Snapshot) => void) | null = null;
let timer: ReturnType<typeof setInterval> | undefined;
let question = "";
let projectId = "";
let cancelRequested = false;
let savedPath = "";
let recordingId = "";
let sequence = 0;
let persisting = false;
let temp: { tempFilePath: string; duration: number } | null = null;
function emit(patch: Partial<Snapshot>) {
  current = { ...current, ...patch };
  listener?.(current);
}
function clearTimer() {
  if (timer) clearInterval(timer);
  timer = undefined;
}
manager.onStart(() => {
  if (!recordingLease.owns(microphoneOwner)) return;
  if (cancelRequested) {
    emit({ state: "saving" });
    manager.stop();
    return;
  }
  emit({ state: "recording", seconds: 0, error: "" });
  clearTimer();
  timer = setInterval(() => emit({ seconds: current.seconds + 1 }), 1000);
});
manager.onStop((res) => {
  if (!recordingLease.owns(microphoneOwner)) return;
  recordingLease.release(microphoneOwner);
  clearTimer();
  temp = res;
  void persist();
});
manager.onError(() => {
  if (!recordingLease.owns(microphoneOwner)) return;
  recordingLease.release(microphoneOwner);
  clearTimer();
  emit({
    state: "error",
    error: "未能录音。请允许麦克风权限后重试，已有录音仍在本机。",
  });
});
manager.onInterruptionBegin(() => {
  if (!recordingLease.owns(microphoneOwner)) return;
  if (current.state === "recording") {
    manager.stop();
    emit({ state: "saving" });
  }
});
async function persist() {
  if (!temp || persisting) return;
  persisting = true;
  emit({ state: "saving", error: "" });
  try {
    const file =
      savedPath ||
      (await new Promise<string>((resolve, reject) =>
        wx.getFileSystemManager().saveFile({
          tempFilePath: temp!.tempFilePath,
          success: (r) => resolve(r.savedFilePath),
          fail: reject,
        }),
      ));
    savedPath = file;
    const p = read(projectId);
    if (!p) throw new Error("Project removed");
    const recording: Recording = {
      id: recordingId,
      path: file,
      duration: temp.duration,
      question,
    };
    if (!p.recordings.some((r) => r.id === recordingId))
      p.recordings.push(recording);
    save(p);
    temp = null;
    savedPath = "";
    emit({ state: "saved", recording });
  } catch {
    emit({
      state: "error",
      error: "还没有保存成功，请先别退出。点击重试，保留这段声音。",
    });
  } finally {
    persisting = false;
  }
}
export const recorder = {
  subscribe(fn: (s: Snapshot) => void) {
    listener = fn;
    fn(current);
  },
  unsubscribe() {
    listener = null;
  },
  start(q: string) {
    const p = read();
    if (!p?.consent) throw new Error("请先同意参与");
    if (["requesting", "recording", "saving"].includes(current.state)) return;
    if (temp || !recordingLease.acquire(microphoneOwner)) return;
    question = q;
    projectId = p.id;
    cancelRequested = false;
    recordingId = `rec-${Date.now()}-${++sequence}`;
    emit({ state: "requesting", error: "", recording: null });
    manager.start({
      duration: 300000,
      sampleRate: 16000,
      numberOfChannels: 1,
      encodeBitRate: 48000,
      format: "mp3",
    });
  },
  stop() {
    if (current.state === "requesting") cancelRequested = true;
    if (current.state === "recording") {
      emit({ state: "saving" });
      manager.stop();
    }
  },
  retry() {
    return persist();
  },
  get hasPending() {
    return !!temp;
  },
  reset() {
    if (["recording", "saving", "requesting"].includes(current.state) || temp)
      return;
    emit({ state: "idle", seconds: 0, recording: null, error: "" });
  },
};
