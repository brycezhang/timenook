import { questions, samples, touch } from "../../domain/model";
import { recorder } from "../../services/recorder";
import { go, home, read, required, save } from "../../services/store";
type E = {
  currentTarget: { dataset: Record<string, string> };
  detail: { value: string };
};
Page({
  data: {
    question: questions[0],
    questionIndex: 0,
    state: "idle",
    timer: "00:00",
    error: "",
    photo: "",
    permission: false,
  },
  onLoad(q) {
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
  onHide() {
    recorder.stop();
  },
  onUnload() {
    recorder.stop();
    recorder.unsubscribe();
  },
  record() {
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
  retry() {
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
