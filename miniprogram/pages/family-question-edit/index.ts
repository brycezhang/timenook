import type {
  FamilyQuestion,
  PersonalPlan,
  ProjectMemberProfile,
} from "../../../packages/contracts/src";
import {
  familyQuestionClient,
  familyQuestionSource,
} from "../../services/family-questions";
import { personalPlanClient } from "../../services/personal-plan";
import { projectOverviewClient } from "../../services/project-overview";
import { recordingId } from "../../services/local-audio-recorder";
import { sessionClient } from "../../services/session";
Page({
  data: {
    editing: false,
    bookTitle: "",
    text: "",
    chapterIndex: 0,
    chapters: [{ key: "", title: "不选章节" }],
    source: "",
    needsRelationship: false,
    relationship: "",
    customRelationship: "",
    relations: ["儿子", "女儿", "孙子", "孙女", "伴侣", "自定义"],
    busy: false,
    pageLoading: true,
    status: "",
    canSave: false,
  },
  projectId: "",
  id: "",
  clientId: "",
  generation: 0,
  question: null as FamilyQuestion | null,
  profile: null as ProjectMemberProfile | null,
  plan: null as PersonalPlan | null,
  initialChapter: "",
  onLoad(q) {
    this.projectId = q.projectId || "";
    this.id = q.id || "";
    this.initialChapter = decodeURIComponent(q.chapter || "");
    this.clientId = recordingId();
    this.setData({ editing: !!this.id });
  },
  async onShow() {
    const n = ++this.generation,
      owner = sessionClient.context();
    this.setData({ busy: true, status: "" });
    try {
      const [plan, overview, profile, question] = await Promise.all([
        personalPlanClient.read(this.projectId),
        projectOverviewClient.read(this.projectId),
        familyQuestionClient.profile(this.projectId),
        this.id
          ? familyQuestionClient.read(this.projectId, this.id)
          : Promise.resolve(null),
      ]);
      if (n !== this.generation || owner !== sessionClient.context()) return;
      this.plan = plan;
      this.profile = profile;
      this.question = question;
      const chapters = [
        { key: "", title: "不选章节" },
        ...plan.chapters.map((c) => ({ key: c.key, title: c.title })),
      ];
      const key = question?.chapterKey ?? this.initialChapter;
      this.setData({
        bookTitle: overview.bookTitle,
        text: question?.text ?? this.data.text,
        chapters,
        chapterIndex: Math.max(
          0,
          chapters.findIndex((c) => c.key === key),
        ),
        needsRelationship: !question && !profile.relationship,
        source: question
          ? familyQuestionSource(question)
          : profile.relationship
            ? `${profile.relationship} · ${profile.nickname}`
            : "",
      });
      this.validate();
    } catch (e) {
      if (n === this.generation)
        this.setData({
          status: e instanceof Error ? e.message : "未能打开提问",
        });
    } finally {
      if (n === this.generation)
        this.setData({ busy: false, pageLoading: false });
    }
  },
  validate() {
    this.setData({
      canSave:
        !!this.data.text.trim() &&
        (!this.data.needsRelationship ||
          !!(this.data.relationship === "自定义"
            ? this.data.customRelationship.trim()
            : this.data.relationship)),
    });
  },
  input(e: WechatMiniprogram.Input) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value });
    this.validate();
  },
  relationship(e: WechatMiniprogram.TouchEvent) {
    this.setData({ relationship: e.currentTarget.dataset.value });
    this.validate();
  },
  chapter(e: WechatMiniprogram.PickerChange) {
    this.setData({ chapterIndex: Number(e.detail.value) });
  },
  async save() {
    if (!this.data.canSave || this.data.busy || !this.plan) return;
    const n = this.generation,
      owner = sessionClient.context();
    this.setData({ busy: true, status: "" });
    try {
      if (this.data.needsRelationship) {
        this.profile = await familyQuestionClient.relationship(
          this.projectId,
          this.data.relationship === "自定义"
            ? this.data.customRelationship.trim()
            : this.data.relationship,
        );
        if (n !== this.generation || owner !== sessionClient.context()) return;
        this.setData({
          needsRelationship: false,
          source: `${this.profile.relationship} · ${this.profile.nickname}`,
        });
      }
      const chapterKey =
        this.data.chapters[this.data.chapterIndex]?.key || null;
      const question = this.question
        ? await familyQuestionClient.edit(
            this.question,
            this.data.text.trim(),
            chapterKey,
          )
        : await familyQuestionClient.create(
            this.projectId,
            this.clientId,
            this.data.text.trim(),
            chapterKey,
          );
      if (n !== this.generation || owner !== sessionClient.context()) return;
      if (this.id) wx.navigateBack();
      else
        wx.redirectTo({
          url: `/pages/family-question/index?projectId=${this.projectId}&id=${question.id}`,
        });
    } catch (e) {
      if (n === this.generation)
        this.setData({
          status: e instanceof Error ? e.message : "问题未能保存",
        });
    } finally {
      if (n === this.generation) this.setData({ busy: false });
    }
  },
  onHide() {
    ++this.generation;
    this.setData({ busy: false });
  },
});
