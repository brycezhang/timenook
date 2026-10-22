import type { Story } from "../../domain/model";
import { confirmStory, touch } from "../../domain/model";
import {
  go,
  home,
  notify,
  read,
  required,
  save,
  toast,
} from "../../services/store";
type E = {
  currentTarget: { dataset: Record<string, string> };
  detail: { value: string };
};
let audio: WechatMiniprogram.InnerAudioContext | null = null;
Page({
  data: {
    id: "",
    s: null as Story | null,
    paragraphs: [] as string[],
    playing: false,
  },
  onLoad(q) {
    this.setData({ id: q.id || "" });
  },
  onShow() {
    const s = required().stories.find((s) => s.id === this.data.id);
    if (!s) {
      home();
      return;
    }
    this.setData({ s, paragraphs: s.body.split("\n\n") });
  },
  onHide() {
    audio?.pause();
    this.setData({ playing: false });
  },
  onUnload() {
    audio?.destroy();
    audio = null;
  },
  confirm() {
    const p = required();
    confirmStory(p, this.data.id);
    save(p);
    this.onShow();
    toast("已确认，允许这版故事入书");
  },
  edit() {
    go("edit-story", "id=" + this.data.id);
  },
  supplement() {
    go("interview");
  },
  exclude() {
    const p = required();
    const s = p.stories.find((s) => s.id === this.data.id)!;
    s.included = !s.included;
    touch(p);
    save(p);
    this.onShow();
  },
  photos() {
    const projectId = required().id;
    const storyId = this.data.id;
    wx.chooseMedia({
      count: 3,
      mediaType: ["image"],
      success: async (r) => {
        try {
          const paths = await Promise.all(
            r.tempFiles.map(
              (f) =>
                new Promise<string>((resolve, reject) =>
                  wx.getFileSystemManager().saveFile({
                    tempFilePath: f.tempFilePath,
                    success: (v) => resolve(v.savedFilePath),
                    fail: reject,
                  }),
                ),
            ),
          );
          const p = read(projectId);
          const s = p?.stories.find((s) => s.id === storyId);
          if (!p || !s) throw new Error("Story removed");
          s.photos.push(...paths);
          s.version += 1;
          s.confirmedVersion = null;
          touch(p);
          save(p);
          if (read()?.id === projectId) this.onShow();
        } catch {
          toast("照片没有保存成功，请重试");
        }
      },
    });
  },
  play() {
    const s = this.data.s;
    if (!s?.recordings.length) {
      notify(
        "这是一篇示例故事",
        "示例没有对应的真实原声。您录下的声音可在“我的 → 本机原声”中回听。",
      );
      return;
    }
    if (!audio) {
      audio = wx.createInnerAudioContext();
      audio.onEnded(() => this.setData({ playing: false }));
      audio.onError(() => {
        toast("原声暂时无法播放");
        this.setData({ playing: false });
      });
    }
    audio.src = s.recordings[0].path;
    if (this.data.playing) audio.pause();
    else audio.play();
    this.setData({ playing: !this.data.playing });
  },
});
