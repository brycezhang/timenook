import type { PersonalPlan } from "../../../packages/contracts/src";
import { personalPlanClient } from "../../services/personal-plan";
import { sessionClient } from "../../services/session";
import { paymentKey } from "../../services/payments";
import { markEditing } from "../../services/book-editor";
Page({
  data: {
    text: "",
    chapters: [] as string[],
    chapterIndex: 0,
    existing: false,
    busy: false,
    pageLoading: true,
    status: "",
  },
  projectId: "",
  key: "",
  chapterKey: "",
  plan: null as PersonalPlan | null,
  generation: 0,
  owner: "",
  onLoad(q) {
    this.projectId = q.projectId || "";
    this.key = decodeURIComponent(q.key || "");
    this.chapterKey = decodeURIComponent(q.chapter || "");
    this.setData({ existing: !!this.key });
  },
  async onShow() {
    if (this.plan && this.owner === sessionClient.context()) return;
    const n = ++this.generation;
    this.owner = sessionClient.context();
    this.setData({ busy: true, pageLoading: true, status: "" });
    try {
      const p = await personalPlanClient.read(this.projectId);
      if (n !== this.generation || this.owner !== sessionClient.context())
        return;
      this.plan = p;
      const current = p.chapters.find((c) =>
        c.questions.some((q) => q.key === this.key),
      );
      const q = current?.questions.find((q) => q.key === this.key);
      if (this.key && !q) throw new Error("问题已移除，请返回章节");
      this.chapterKey = current?.key || this.chapterKey;
      this.setData({
        text: q?.text || "",
        chapters: p.chapters.map((c) => c.title),
        chapterIndex: Math.max(
          0,
          p.chapters.findIndex((c) => c.key === this.chapterKey),
        ),
      });
    } catch (e) {
      this.setData({ status: e instanceof Error ? e.message : "读取失败" });
    } finally {
      this.setData({ busy: false, pageLoading: false });
    }
  },
  onHide() {
    ++this.generation;
  },
  onUnload() {
    markEditing(false);
  },
  input(e: WechatMiniprogram.Input) {
    this.setData({ text: e.detail.value });
    markEditing(true);
  },
  chapter(e: WechatMiniprogram.PickerChange) {
    this.setData({ chapterIndex: Number(e.detail.value) });
    markEditing(true);
  },
  async save() {
    const p = this.plan;
    if (!p || this.data.busy || this.owner !== sessionClient.context()) return;
    if (!this.data.text.trim() || !p.chapters[this.data.chapterIndex]) {
      this.setData({ status: "请填写问题并选择章节" });
      return;
    }
    this.setData({ busy: true, status: "" });
    try {
      const old = p.chapters
        .flatMap((c) => c.questions)
        .find((q) => q.key === this.key);
      const key = this.key || `question-${paymentKey()}`;
      const question = old
        ? { ...old, text: this.data.text.trim() }
        : {
            key,
            text: this.data.text.trim(),
            intent: "由主讲人回忆自己的真实经历",
            optionalContext: [],
            sensitivityTags: [],
            followupCandidates: [],
            locale: "zh-CN" as const,
          };
      const target = p.chapters[this.data.chapterIndex].key;
      const same =
        p.chapters.find((c) => c.questions.some((q) => q.key === key))?.key ===
        target;
      const chapters = p.chapters.map((c) => ({
        ...c,
        questions: same
          ? c.questions.map((q) => (q.key === key ? question : q))
          : c.questions.filter((q) => q.key !== key),
      }));
      if (!same)
        chapters.find((c) => c.key === target)!.questions.push(question);
      await personalPlanClient.revise(this.projectId, p.revision, {
        chapters,
        starters: p.starters,
      });
      markEditing(false);
      wx.navigateBack();
    } catch (e) {
      this.setData({ status: e instanceof Error ? e.message : "未能保存" });
    } finally {
      this.setData({ busy: false });
    }
  },
});
