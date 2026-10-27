import { watchProjectAccess } from "../../services/project-access";
import { editStory } from "../../domain/model";
import { home, required, save } from "../../services/store";
import { dataMode } from "../../services/mode";
import { sessionClient, ApiFailure } from "../../services/session";
import { storyClient, type StoryRevisionInput } from "../../services/stories";
import { paymentKey } from "../../services/payments";
import { recordingId } from "../../services/local-audio-recorder";
import type {
  StoryView,
  PhotoMaterials,
  PhotoCollection,
  StorySourceView,
} from "../../../packages/contracts/src";
type E = {
  currentTarget: { dataset: Record<string, string> };
  detail: { value: string };
};
Page({
  data: {
    id: "",
    title: "",
    body: "",
    error: "",
    live: false,
    busy: false,
    noteText: "",
    theme: "",
    story: null as StoryView | null,
    paragraphs: [] as StoryRevisionInput["paragraphs"],
    reviews: [] as { item: string; reason: string }[],
    notes: [] as { id: string; text: string }[],
    audioClips: [] as (StorySourceView & { included: boolean })[],
    photoSnapshot: null as PhotoMaterials | null,
  },
  projectId: "",
  storyId: "",
  generation: 0,
  ownerContext: "",
  command: null as { input: string; key: string } | null,
  stopProjectWatch: undefined as (() => void) | undefined,
  stopSessionWatch: undefined as (() => void) | undefined,
  onLoad(q) {
    if (dataMode() === "live") {
      this.projectId = q.projectId || "";
      this.storyId = q.storyId || "";
      this.setData({ live: true });
      return;
    }
    const s = required().stories.find((s) => s.id === q.id);
    if (!s) {
      home();
      return;
    }
    this.setData({ id: s.id, title: s.title, body: s.body });
  },
  current(generation: number, context: string) {
    return (
      generation === this.generation &&
      context === sessionClient.context() &&
      dataMode() === "live"
    );
  },
  onHide() {
    this.stopProjectWatch?.();
    this.stopProjectWatch = undefined;
    if (!this.data.live) return;
    ++this.generation;
    this.stopSessionWatch?.();
    this.stopSessionWatch = undefined;
    this.command = null;
    this.setData({
      story: null,
      title: "",
      theme: "",
      body: "",
      paragraphs: [],
      reviews: [],
      notes: [],
      audioClips: [],
      photoSnapshot: null,
      noteText: "",
      busy: false,
    });
  },
  onUnload() {
    this.onHide();
  },
  async onShow() {
    if (!this.data.live) return;
    const generation = ++this.generation,
      context = sessionClient.context();
    this.ownerContext = context;
    this.stopSessionWatch?.();
    this.stopSessionWatch = sessionClient.onInvalidated(() => {
      this.onHide();
      this.setData({ error: "登录已失效，请重新登录" });
    });
    this.setData({ busy: true, error: "" });
    try {
      const story = await storyClient.read(this.projectId, this.storyId),
        revision = story.revision;
      if (!this.current(generation, context)) return;
      if (!revision) throw new Error("故事尚未整理完成，请返回查询");
      this.setData({
        story,
        title: revision.title,
        theme: revision.theme,
        paragraphs: revision.paragraphs.map((p) => ({
          ...p,
          sourceRefs: [...p.sourceRefs],
        })),
        reviews: revision.reviewItems.map((item) => ({
          item,
          reason:
            revision.reviewResolutions?.find((r) => r.item === item)?.reason ??
            "",
        })),
        notes: (revision.notes ?? []).map((n) => ({ ...n })),
        photoSnapshot: revision.photoSnapshot ?? null,
        audioClips: revision.sourceManifest.map((s) => ({
          ...s,
          included: (revision.audioManifest ?? revision.sourceManifest).some(
            (a) => a.clipId === s.clipId,
          ),
        })),
      });
      const order = (revision.audioManifest ?? revision.sourceManifest).map(
        (s) => s.clipId,
      );
      this.setData({
        audioClips: this.data.audioClips.sort((a, b) => {
          const ai = order.indexOf(a.clipId),
            bi = order.indexOf(b.clipId);
          return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
        }),
      });
      this.stopProjectWatch?.();
      this.stopProjectWatch = watchProjectAccess(
        this.projectId,
        () => this.current(generation, context),
        () => {
          this.onHide();
          this.setData({
            error: "资料用途或账号授权已变化，私人草稿已清理，请重新查询",
          });
        },
      );
    } catch (error) {
      if (this.current(generation, context))
        this.setData({
          error: error instanceof Error ? error.message : "查询失败，请重试",
        });
    } finally {
      this.finish(generation, context);
    }
  },
  finish(generation: number, context: string) {
    if (this.current(generation, context)) this.setData({ busy: false });
    else if (generation === this.generation) {
      this.onHide();
      this.setData({ error: "账号或访问已变化，请重新查询" });
    }
  },
  clearDenied(generation: number, context: string, error: unknown) {
    if (
      !this.current(generation, context) ||
      !(error instanceof ApiFailure) ||
      error.status !== 403
    )
      return false;
    this.onHide();
    this.setData({
      error: "当前资料访问已失效，私人内容已清除，请重新查询授权",
    });
    return true;
  },
  input(e: E) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value });
  },
  paragraphText(e: E) {
    const paragraphs = this.data.paragraphs.map((p) => ({
      ...p,
      sourceRefs: [...p.sourceRefs],
    }));
    const p = paragraphs[Number(e.currentTarget.dataset.index)];
    if (p) p.text = e.detail.value;
    this.setData({ paragraphs });
  },
  reviewReason(e: E) {
    const reviews = this.data.reviews.map((r) => ({ ...r }));
    const r = reviews[Number(e.currentTarget.dataset.index)];
    if (r) r.reason = e.detail.value;
    this.setData({ reviews });
  },
  noteText(e: E) {
    const notes = this.data.notes.map((n) => ({ ...n }));
    const n = notes[Number(e.currentTarget.dataset.index)];
    if (n) n.text = e.detail.value;
    this.setData({ notes });
  },
  addNote(e: E) {
    const text = this.data.noteText.trim(),
      index = Number(e.currentTarget.dataset.index);
    if (!text) {
      this.setData({ error: "请先填写校对说明" });
      return;
    }
    const id = recordingId(),
      notes = [...this.data.notes, { id, text }],
      paragraphs = this.data.paragraphs.map((p) => ({
        ...p,
        sourceRefs: [...p.sourceRefs],
      }));
    if (paragraphs[index]) paragraphs[index].sourceRefs.push(`note:${id}`);
    else paragraphs.push({ text, sourceRefs: [`note:${id}`] });
    this.setData({ notes, paragraphs, noteText: "", error: "" });
  },
  moveParagraph(e: E) {
    const index = Number(e.currentTarget.dataset.index),
      next = index + Number(e.currentTarget.dataset.direction),
      paragraphs = [...this.data.paragraphs];
    if (next < 0 || next >= paragraphs.length) return;
    [paragraphs[index], paragraphs[next]] = [
      paragraphs[next],
      paragraphs[index],
    ];
    this.setData({ paragraphs });
  },
  toggleAudio(e: E) {
    const audioClips = this.data.audioClips.map((a) => ({ ...a })),
      row = audioClips[Number(e.currentTarget.dataset.index)];
    if (row) row.included = !row.included;
    this.setData({ audioClips });
  },
  moveAudio(e: E) {
    const index = Number(e.currentTarget.dataset.index),
      next = index + Number(e.currentTarget.dataset.direction),
      audioClips = [...this.data.audioClips];
    if (next < 0 || next >= audioClips.length) return;
    [audioClips[index], audioClips[next]] = [
      audioClips[next],
      audioClips[index],
    ];
    this.setData({ audioClips });
  },
  async applyPhotos() {
    const current = this.data.story;
    if (this.data.busy || !current) return;
    const generation = this.generation,
      context = this.ownerContext;
    this.setData({ busy: true, error: "" });
    try {
      const collection = await sessionClient.request<PhotoCollection>(
        `/projects/${this.projectId}/interviews/${current.interviewId}/photos`,
      );
      if (this.current(generation, context))
        this.setData({
          photoSnapshot: collection.snapshot,
          error: collection.snapshot
            ? "已选用当前照片清单；保存后成为新的故事版本"
            : "当前没有已封存照片；保存后故事不附照片",
        });
    } catch (error) {
      if (this.clearDenied(generation, context, error)) return;
      if (this.current(generation, context))
        this.setData({
          error: error instanceof Error ? error.message : "读取照片失败",
        });
    } finally {
      this.finish(generation, context);
    }
  },
  removePhotos() {
    this.setData({ photoSnapshot: null });
  },
  async save() {
    if (this.data.live) {
      await this.saveLive();
      return;
    }
    if (!this.data.title.trim() || !this.data.body.trim()) {
      this.setData({ error: "请填写标题与故事正文" });
      return;
    }
    const p = required();
    editStory(p, this.data.id, this.data.title.trim(), this.data.body.trim());
    save(p);
    wx.navigateBack();
  },
  async saveLive() {
    const story = this.data.story;
    if (this.data.busy || !story?.revision) return;
    if (
      !this.data.title.trim() ||
      !this.data.theme.trim() ||
      !this.data.paragraphs.length ||
      this.data.paragraphs.some((p) => !p.text.trim())
    ) {
      this.setData({ error: "请填写标题、主题和每段正文" });
      return;
    }
    const input: StoryRevisionInput = {
      baseRevisionId: story.revision.id,
      expectedVersion: story.version,
      title: this.data.title.trim(),
      theme: this.data.theme.trim(),
      paragraphs: this.data.paragraphs.map((p) => ({
        text: p.text.trim(),
        sourceRefs: [...p.sourceRefs],
      })),
      reviewResolutions: this.data.reviews
        .filter((r) => r.reason.trim())
        .map((r) => ({ item: r.item, reason: r.reason.trim() })),
      notes: this.data.notes.map((n) => ({ id: n.id, text: n.text.trim() })),
      photoSnapshotId: this.data.photoSnapshot?.id ?? null,
      audioClipIds: this.data.audioClips
        .filter((a) => a.included)
        .map((a) => a.clipId),
    };
    const serialized = JSON.stringify(input);
    if (this.command?.input !== serialized)
      this.command = { input: serialized, key: paymentKey() };
    const generation = this.generation,
      context = this.ownerContext;
    this.setData({ busy: true, error: "" });
    try {
      await storyClient.revise(
        this.projectId,
        story.id,
        input,
        this.command!.key,
      );
      if (this.current(generation, context)) {
        this.command = null;
        wx.navigateBack();
      }
    } catch (error) {
      if (this.clearDenied(generation, context, error)) return;
      if (this.current(generation, context))
        this.setData({
          error:
            error instanceof ApiFailure && error.status === 409
              ? "版本已变化，修改尚未保存。请保留本页文字并返回重新核对"
              : "修改尚未确认保存，请重试；本页草稿仍保留",
        });
    } finally {
      this.finish(generation, context);
    }
  },
});
