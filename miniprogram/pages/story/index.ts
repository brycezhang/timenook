import { watchProjectAccess } from "../../services/project-access";
import { dataMode } from "../../services/mode";
import { sessionClient, ApiFailure } from "../../services/session";
import { storyClient } from "../../services/stories";
import { clearStoryAudio, privateStoryAudio } from "../../services/story-audio";
import { recordingPartition } from "../../services/interview-recording";
import { paymentKey } from "../../services/payments";
import { projectOverviewClient } from "../../services/project-overview";
import type { StoryView, StoryContext } from "../../../packages/contracts/src";
function stage(story: StoryView | null) {
  if (story?.decision?.confirmed)
    return story.decision.allowInBook
      ? "本人已确认这版，允许入书"
      : "本人已确认这版，暂不入书";
  const task = story?.task;
  if (!task)
    return story?.revision
      ? "故事已整理，待本人核对"
      : "录音保存后，可以整理这段讲述";
  return task.state === "waiting_inputs"
    ? task.errorCode === "DEPENDENCY_FAILED"
      ? "有录音转写失败，原声已保存"
      : "正在等待全部录音转写，可离开"
    : task.state === "queued"
      ? "正在排队，可离开"
      : task.state === "submitting"
        ? "正在整理故事，可离开"
        : task.state === "succeeded"
          ? "故事已整理，待本人核对"
          : task.state === "no_speech"
            ? "未识别到有效语音，请再录一段"
            : task.state === "failed"
              ? "整理失败，原声仍保留"
              : task.state === "manual_review"
                ? "需要人工协助，原声仍保留"
                : task.state === "obsolete"
                  ? "这次整理已失效，请保存补录后重新整理"
                  : "处理中，可离开";
}
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
  projectId: "",
  interviewId: "",
  storyId: "",
  assistedSessionId: "",
  confirmationSessionId: "",
  generation: 0,
  visible: false,
  autoOrganize: false,
  ownerContext: "",
  audioSequence: 0,
  liveAudio: null as WechatMiniprogram.InnerAudioContext | null,
  stopProjectWatch: undefined as (() => void) | undefined,
  stopSessionWatch: undefined as (() => void) | undefined,
  poll: undefined as ReturnType<typeof setTimeout> | undefined,
  decisionCommand: null as { input: string; key: string } | null,
  careCommand: null as { input: string; key: string } | null,
  data: {
    needsReview: false,
    showAudio: false,
    showCare: false,
    careExpiry: "",
    careEvidence: "",
    careStatus: "",
    noticeVersion: "synthetic-d08-v1",
    evidencePrefix: "synthetic:",
    noticeText: "当前为本地合成政策验证；此说明仅提交到本次选择。",
    decisionReady: false,
    canDecide: false,
    confirmedChoice: null as boolean | null,
    includeChoice: null as boolean | null,
    evidence: "",
    decisionStatus: "",
    audioBusy: false,
    audioError: "",
    playingClipId: "",
    liveParagraphs: [] as { text: string; sourceLabel: string }[],
    saveWarning: "",
    canOrganize: false,
    live: false,
    story: null as StoryView | null,
    context: null as StoryContext | null,
    stage: "",
    error: "",
    privateError: "",
    busy: false,
    pendingLocal: false,
    retryable: false,
    id: "",
    s: null as Story | null,
    paragraphs: [] as string[],
    playing: false,
  },
  onLoad(q) {
    if (dataMode() === "live") {
      this.autoOrganize = q.organize === "1";
      this.projectId = q.projectId || "";
      this.interviewId = q.interviewId || "";
      this.storyId = q.storyId || "";
      this.assistedSessionId = this.storyId ? "" : q.assistedSessionId || "";
      this.confirmationSessionId = this.storyId
        ? q.assistedSessionId || ""
        : "";
      this.setData({ live: true });
      return;
    }
    this.setData({ id: q.id || "" });
  },
  async onShow() {
    if (dataMode() === "live") {
      this.visible = true;
      const generation = ++this.generation,
        context = sessionClient.context();
      this.ownerContext = context;
      this.stopSessionWatch?.();
      this.stopSessionWatch = undefined;
      if (context)
        this.stopSessionWatch = sessionClient.onInvalidated((lost) => {
          if (lost !== context || this.ownerContext !== context) return;
          this.onHide();
          this.setData({
            stage: sessionClient.sessionCleanupPending()
              ? "登录已失效；设备会话缓存清理失败，请重试登录"
              : "登录已失效，请重新登录；本机原文件仍保留",
          });
        });
      this.setData({
        story: null,
        liveParagraphs: [],
        canOrganize: false,
        context: null,
        error: "",
        privateError: "",
        stage: "正在查询保存与整理状态",
        busy: false,
        decisionReady: false,
        canDecide: false,
        confirmedChoice: null,
        includeChoice: null,
        evidence: "",
        decisionStatus: "",
        careExpiry: "",
        careEvidence: "",
        careStatus: "",
      });
      try {
        await this.stopLiveAudio();
      } catch (error) {
        if (this.currentLive(generation, context, true))
          this.setData({
            stage: "原声临时文件尚未清理，请重试",
            error: error instanceof Error ? error.message : "清理失败",
          });
        return;
      }
      if (!this.currentLive(generation, context)) return;
      if (!context || !this.projectId || (!this.interviewId && !this.storyId)) {
        this.setData({ stage: "请登录并从本次采访进入故事" });
        return;
      }
      await this.refreshLive(generation, context);
      if (
        this.currentLive(generation, context) &&
        this.autoOrganize &&
        this.data.canOrganize &&
        (!this.data.story?.task ||
          this.data.story.task.state === "obsolete" ||
          this.data.context?.clipCount !== this.data.story.task.sources.length)
      ) {
        this.autoOrganize = false;
        await this.submitLive();
      }
      if (this.currentLive(generation, context) && this.data.story) {
        this.stopProjectWatch?.();
        this.stopProjectWatch = watchProjectAccess(
          this.projectId,
          () => this.currentLive(generation, context),
          () => {
            this.onHide();
            this.setData({
              stage:
                "资料用途或账号授权已变化，私人内容与临时回听已清理，请重新查询",
            });
          },
        );
      }
      return;
    }
    const s = required().stories.find((s) => s.id === this.data.id);
    if (!s) {
      home();
      return;
    }
    this.setData({ s, paragraphs: s.body.split("\n\n") });
  },
  onHide() {
    this.stopProjectWatch?.();
    this.stopProjectWatch = undefined;
    if (this.data.live) {
      this.stopSessionWatch?.();
      this.stopSessionWatch = undefined;
      void this.stopLiveAudio().catch(() => {});
      this.visible = false;
      this.decisionCommand = null;
      this.careCommand = null;
      ++this.generation;
      if (this.poll) clearTimeout(this.poll);
      this.setData({
        careExpiry: "",
        careEvidence: "",
        careStatus: "",
        decisionReady: false,
        canDecide: false,
        confirmedChoice: null,
        includeChoice: null,
        evidence: "",
        decisionStatus: "",
        story: null,
        liveParagraphs: [],
        canOrganize: false,
        context: null,
        busy: false,
        error: "",
        privateError: "",
      });
    }
    audio?.pause();
    this.setData({ playing: false });
  },
  onUnload() {
    this.onHide();
    audio?.destroy();
    audio = null;
  },
  currentLive(generation: number, context: string, invalidated = false) {
    const current = sessionClient.context();
    return (
      this.visible &&
      generation === this.generation &&
      dataMode() === "live" &&
      (current === context || (invalidated && !current))
    );
  },
  liveFailure(
    generation: number,
    context: string,
    error: unknown,
    fallback: string,
  ) {
    if (
      generation === this.generation &&
      this.visible &&
      this.ownerContext === context &&
      sessionClient.context() !== context &&
      sessionClient.context()
    ) {
      this.onHide();
      this.setData({ stage: "账号已变化，原页面私人内容已清除，请重新进入" });
      return;
    }
    if (!this.currentLive(generation, context, true)) return;
    const denied =
      !sessionClient.context() ||
      (error instanceof ApiFailure && [401, 403].includes(error.status));
    if (denied) this.onHide();
    this.setData({
      stage: denied ? "当前访问已失效，请重新查询授权" : this.data.stage,
      error: error instanceof Error ? error.message : fallback,
    });
  },
  async refreshLive(generation?: number, context?: string) {
    generation ??= this.generation;
    context ??= this.ownerContext;
    if (this.poll) clearTimeout(this.poll);
    this.setData({
      busy: true,
      error: "",
      decisionReady: false,
      canDecide: false,
      confirmedChoice: null,
      includeChoice: null,
      evidence: "",
      careEvidence: "",
      careExpiry: "",
      decisionStatus: "",
      careStatus: "",
    });
    try {
      let loaded: StoryView | undefined;
      if (this.storyId) {
        loaded = await storyClient.read(this.projectId, this.storyId);
        if (!this.currentLive(generation, context)) return;
        this.interviewId = loaded.interviewId;
      }
      const local: unknown = wx.getStorageSync(
          `${recordingPartition(this.projectId)}:${this.interviewId}`,
        ),
        pendingLocal =
          Array.isArray(local) && local.some((c) => !c || c.sealed !== true);
      const result = loaded
        ? null
        : await storyClient.context(
            this.projectId,
            this.interviewId,
            this.assistedSessionId || undefined,
          );
      if (!this.currentLive(generation, context)) return;
      this.setData({
        context: result,
        story: loaded ?? result?.story ?? null,
        liveParagraphs: [],
        pendingLocal,
        stage: stage(loaded ?? result?.story ?? null),
        saveWarning:
          !loaded && (pendingLocal || !result?.cloudSaved)
            ? "还有录音没有云端保存，请回采访页恢复"
            : "",
        retryable: false,
        canOrganize:
          !!result?.cloudSaved &&
          !pendingLocal &&
          (!result.story?.task ||
            ["obsolete", "succeeded"].includes(result.story.task.state) ||
            result.clipCount !== result.story.task.sources.length),
      });
      if (loaded || result?.story) {
        try {
          const full =
            loaded ??
            (await storyClient.read(this.projectId, result!.story!.id));
          if (!this.currentLive(generation, context)) return;
          this.setData({
            story: full,
            needsReview: !!full.revision?.reviewItems.some(
              (item) =>
                !full.revision?.reviewResolutions?.some(
                  (resolved) => resolved.item === item,
                ),
            ),
            stage: stage(full),
            privateError: "",
            liveParagraphs: (full.revision?.paragraphs ?? []).map((p) => ({
              text: p.text,
              sourceLabel: p.sourceRefs
                .map((ref) => {
                  const index = full.revision!.sourceManifest.findIndex(
                    (s) =>
                      s.transcript &&
                      ref === `transcript:${s.clipId}:${s.transcript.sha256}`,
                  );
                  return index >= 0
                    ? `第 ${index + 1} 段原声`
                    : ref.startsWith("note:")
                      ? "校对说明"
                      : "原声来源";
                })
                .join("、"),
            })),
          });
          if (full.task?.state === "failed") {
            const task = await storyClient.task(this.projectId, full.task.id);
            if (this.currentLive(generation, context))
              this.setData({ retryable: task.retryable });
          }
        } catch (error) {
          if (
            error instanceof ApiFailure &&
            error.status === 403 &&
            this.currentLive(generation, context)
          ) {
            this.setData({
              story: result?.story ?? null,
              privateError: "正文暂时不可查看，请核对讲述者的共享授权",
            });
          } else throw error;
        }
      }
      if (
        this.currentLive(generation, context) &&
        this.data.story?.task &&
        ["queued", "waiting_inputs", "submitting", "waiting_provider"].includes(
          this.data.story.task.state,
        )
      )
        this.poll = setTimeout(
          () => void this.refreshLive(generation, context),
          2000,
        );
    } catch (error) {
      this.liveFailure(generation, context, error, "查询失败，请重试");
    } finally {
      if (this.currentLive(generation, context, true))
        this.setData({ busy: false });
    }
  },
  moreActions() {
    wx.showActionSheet({
      itemList: [
        "修改故事文字",
        "补充照片",
        "回听已保存的原声",
        "重新整理故事",
        "申请人工校对",
        "继续补充讲述",
      ],
      success: ({ tapIndex }) => {
        if (tapIndex === 0) this.edit();
        else if (tapIndex === 1) this.editLivePhotos();
        else if (tapIndex === 2) {
          this.setData({ showAudio: true });
          wx.pageScrollTo?.({ selector: ".live-sources", duration: 200 });
        } else if (tapIndex === 3) void this.submitLive();
        else if (tapIndex === 4) {
          this.setData({ showCare: true });
          void this.prepareDecision();
        } else this.recoverInterview();
      },
    });
  },
  async submitLive() {
    if (
      this.data.busy ||
      this.data.pendingLocal ||
      !this.data.context?.cloudSaved
    )
      return;
    const generation = this.generation,
      context = this.ownerContext,
      baseVersion = this.data.story?.version ?? 0,
      keyName = `${recordingPartition(this.projectId)}:story:${this.interviewId}`;
    const prior = wx.getStorageSync(keyName) as
        { key?: string; baseVersion?: number } | undefined,
      command =
        prior?.key && prior.baseVersion === baseVersion
          ? { key: prior.key, baseVersion }
          : { key: paymentKey(), baseVersion };
    wx.setStorageSync(keyName, command);
    this.setData({ busy: true, error: "" });
    try {
      const result = await storyClient.organize(
        this.projectId,
        this.interviewId,
        baseVersion,
        command.key,
        this.assistedSessionId || undefined,
      );
      if (!this.currentLive(generation, context)) return;
      wx.removeStorageSync(keyName);
      this.setData({ story: result, stage: stage(result) });
      await this.refreshLive(generation, context);
    } catch (error) {
      this.liveFailure(
        generation,
        context,
        error,
        "提交结果未确定，请重试查询",
      );
    } finally {
      if (this.currentLive(generation, context, true))
        this.setData({ busy: false });
    }
  },
  async retryLive() {
    const task = this.data.story?.task;
    if (!task || this.data.busy || !this.data.retryable) return;
    const generation = this.generation,
      context = this.ownerContext,
      keyName = `${recordingPartition(this.projectId)}:story-retry:${task.id}`,
      stored = wx.getStorageSync(keyName),
      key = typeof stored === "string" ? stored : paymentKey();
    wx.setStorageSync(keyName, key);
    this.setData({ busy: true, error: "" });
    try {
      await storyClient.retry(
        this.projectId,
        task.id,
        key,
        this.assistedSessionId || undefined,
      );
      if (!this.currentLive(generation, context)) return;
      wx.removeStorageSync(keyName);
      await this.refreshLive(generation, context);
    } catch (error) {
      this.liveFailure(
        generation,
        context,
        error,
        "重试结果未确定，请重新查询",
      );
    } finally {
      if (this.currentLive(generation, context, true))
        this.setData({ busy: false });
    }
  },
  refresh() {
    if (!this.data.busy) void this.refreshLive();
  },
  async prepareDecision() {
    if (this.data.busy || !this.data.story?.revision) return;
    const generation = this.generation,
      context = this.ownerContext;
    this.setData({ busy: true, decisionStatus: "" });
    try {
      const overview = await projectOverviewClient.read(this.projectId);
      if (!this.currentLive(generation, context)) return;
      this.setData({
        decisionReady: true,
        noticeVersion: overview.noticeVersion || "synthetic-d08-v1",
        evidencePrefix: overview.evidencePrefix || "synthetic:",
        noticeText:
          overview.noticeText ||
          "当前为本地合成政策验证；此说明仅提交到本次选择。",
        canDecide: overview.canDecide || !!this.confirmationSessionId,
        confirmedChoice: null,
        includeChoice: null,
        evidence: "",
        decisionStatus:
          overview.canDecide || this.confirmationSessionId
            ? "请本人分别选择，并记录本次独立说明"
            : "当前账号只能协助校对；本人确认请使用讲述者账号或当次故事确认协助",
      });
    } catch (error) {
      this.liveFailure(
        generation,
        context,
        error,
        "查询本人确认权限失败，请重试",
      );
    } finally {
      if (this.currentLive(generation, context, true))
        this.setData({ busy: false });
    }
  },
  chooseConfirmation(e: E) {
    this.setData({ confirmedChoice: e.currentTarget.dataset.value === "true" });
  },
  chooseInclusion(e: E) {
    this.setData({ includeChoice: e.currentTarget.dataset.value === "true" });
  },
  decisionEvidence(e: E) {
    this.setData({ evidence: e.detail.value });
  },
  async decideLive() {
    const current = this.data.story,
      revision = current?.revision;
    if (this.data.busy || !current || !revision || !this.data.canDecide) return;
    if (
      this.data.confirmedChoice === null ||
      this.data.includeChoice === null ||
      !/^[^\r\n]{3,160}$/.test(this.data.evidence.trim())
    ) {
      this.setData({
        decisionStatus:
          "请本人分别选择内容确认与入书许可，并填写 3 至 160 字的本次独立说明（单行）",
      });
      return;
    }
    if (this.data.includeChoice && !this.data.confirmedChoice) {
      this.setData({ decisionStatus: "未确认的故事不能允许入书" });
      return;
    }
    const input = {
      revisionId: revision.id,
      contentHash: revision.contentHash,
      expectedVersion: current.version,
      confirmed: this.data.confirmedChoice,
      allowInBook: this.data.includeChoice,
      noticeVersion: this.data.noticeVersion,
      evidenceRef: `${this.data.evidencePrefix}${this.data.evidence.trim()}`,
      ...(this.confirmationSessionId
        ? { assistedSessionId: this.confirmationSessionId }
        : {}),
    };
    const serialized = JSON.stringify(input);
    if (this.decisionCommand?.input !== serialized)
      this.decisionCommand = { input: serialized, key: paymentKey() };
    const generation = this.generation,
      context = this.ownerContext;
    this.setData({ busy: true, decisionStatus: "" });
    try {
      const result = await storyClient.decide(
        this.projectId,
        current.id,
        input,
        this.decisionCommand!.key,
      );
      if (!this.currentLive(generation, context)) return;
      this.decisionCommand = null;
      this.setData({
        story: result,
        stage: stage(result),
        evidence: "",
        decisionReady: false,
        decisionStatus: result.decision?.confirmed
          ? result.decision.allowInBook
            ? "本人已确认，允许这版入书"
            : "本人已确认，这版暂不入书"
          : "本人已撤回这版确认与入书许可",
      });
    } catch (error) {
      if (this.currentLive(generation, context))
        this.setData({
          decisionStatus:
            error instanceof ApiFailure && error.status === 409
              ? "版本或核对状态已变化，请刷新并重新核对；本次决定未确认"
              : "本次决定未确认，请重新查询或重试",
        });
      this.liveFailure(generation, context, error, "决定保存失败");
    } finally {
      if (this.currentLive(generation, context, true))
        this.setData({ busy: false });
    }
  },
  participation() {
    go(
      "assisted",
      `projectId=${this.projectId}&storyId=${this.data.story?.id || this.storyId}&interviewId=${this.interviewId}&purpose=story_confirmation`,
    );
  },
  correctionInput(e: E) {
    if (["careExpiry", "careEvidence"].includes(e.currentTarget.dataset.field))
      this.setData({ [e.currentTarget.dataset.field]: e.detail.value });
  },
  async requestCorrection() {
    const current = this.data.story,
      revision = current?.revision;
    if (this.data.busy || !current || !revision || !this.data.canDecide) return;
    const expiry = this.data.careExpiry.trim(),
      evidence = this.data.careEvidence.trim();
    if (
      !/^[^\r\n]{3,160}$/.test(evidence) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
        expiry,
      ) ||
      !Number.isFinite(Date.parse(expiry)) ||
      Date.parse(expiry) <= Date.now()
    ) {
      this.setData({
        careStatus:
          "请本人明确填写未来的 ISO 有效期和 3 至 160 字的单行独立说明；尚未申请",
      });
      return;
    }
    const input = {
      revisionId: revision.id,
      contentHash: revision.contentHash,
      expectedVersion: current.version,
      noticeVersion: this.data.noticeVersion,
      evidenceRef: `${this.data.evidencePrefix}${evidence}`,
      expiresAt: expiry,
      ...(this.confirmationSessionId
        ? { assistedSessionId: this.confirmationSessionId }
        : {}),
    };
    const serialized = JSON.stringify(input);
    if (this.careCommand?.input !== serialized)
      this.careCommand = { input: serialized, key: paymentKey() };
    const generation = this.generation,
      context = this.ownerContext;
    this.setData({ busy: true, careStatus: "" });
    try {
      const result = await storyClient.requestCorrection(
        this.projectId,
        current.id,
        input,
        this.careCommand!.key,
      );
      if (!this.currentLive(generation, context)) return;
      if (
        result.storyId !== current.id ||
        !/^[0-9a-f-]{36}$/.test(result.caseId) ||
        Date.parse(result.expiresAt) !== Date.parse(expiry)
      )
        throw new Error("工单结果无效，请重新查询");
      this.careCommand = null;
      this.setData({
        careEvidence: "",
        careStatus: `校对申请已记录，工单 ${result.caseId}，有效期至 ${result.expiresAt}。等待运营处理；故事仍须本人确认。`,
      });
    } catch (error) {
      if (this.currentLive(generation, context))
        this.setData({ careStatus: "校对申请结果未确定，请重新查询或重试" });
      this.liveFailure(generation, context, error, "申请未保存");
    } finally {
      if (this.currentLive(generation, context, true))
        this.setData({ busy: false });
    }
  },
  editLivePhotos() {
    go("photos", `projectId=${this.projectId}&interviewId=${this.interviewId}`);
  },
  async stopLiveAudio() {
    ++this.audioSequence;
    this.liveAudio?.stop();
    this.liveAudio?.destroy();
    this.liveAudio = null;
    this.setData({ playingClipId: "", audioBusy: false, audioError: "" });
    await clearStoryAudio();
  },
  async playLive(e: E) {
    const id = e.currentTarget.dataset.id,
      source = this.data.story?.task?.sources.find((s) => s.clipId === id),
      generation = this.generation,
      context = this.ownerContext;
    if (
      !source ||
      this.data.busy ||
      this.data.audioBusy ||
      this.data.privateError ||
      !this.currentLive(generation, context)
    )
      return;
    const stopping = this.data.playingClipId === id;
    try {
      await this.stopLiveAudio();
      if (stopping || !this.currentLive(generation, context)) return;
      const sequence = ++this.audioSequence;
      this.setData({ audioBusy: true });
      const path = await privateStoryAudio(
        this.projectId,
        source,
        () =>
          this.currentLive(generation, context) &&
          sequence === this.audioSequence,
      );
      if (
        !this.currentLive(generation, context) ||
        sequence !== this.audioSequence
      ) {
        await clearStoryAudio([path]);
        return;
      }
      const player = wx.createInnerAudioContext();
      this.liveAudio = player;
      player.src = path;
      const finish = () => {
        if (this.liveAudio === player)
          void this.stopLiveAudio().catch(() =>
            this.setData({ audioError: "临时原声未能清理，请重试" }),
          );
      };
      player.onEnded(finish);
      player.onError(finish);
      this.setData({ playingClipId: id });
      player.play();
    } catch (error) {
      const denied =
        !sessionClient.context() ||
        (error instanceof ApiFailure && [401, 403].includes(error.status));
      if (this.currentLive(generation, context, denied)) {
        if (denied) {
          this.onHide();
          this.setData({ stage: "原声权限已变化，请重新登录或查询" });
        } else
          this.setData({
            audioError:
              error instanceof Error ? error.message : "回听失败，可重试",
          });
      }
    } finally {
      if (this.currentLive(generation, context))
        this.setData({ audioBusy: false });
    }
  },
  recoverInterview() {
    const partition = recordingPartition(this.projectId),
      stored: unknown = wx.getStorageSync(`${partition}:index`),
      ids = Array.isArray(stored)
        ? stored.filter((v) => typeof v === "string")
        : [];
    if (!ids.includes(this.interviewId)) ids.push(this.interviewId);
    wx.setStorageSync(`${partition}:index`, ids);
    wx.setStorageSync(`${partition}:active`, this.interviewId);
    go(
      "interview",
      `projectId=${this.projectId}&interviewId=${this.interviewId}${this.assistedSessionId ? `&assistedSessionId=${this.assistedSessionId}` : ""}`,
    );
  },
  confirm() {
    const p = required();
    confirmStory(p, this.data.id);
    save(p);
    this.onShow();
    toast("已确认，允许这版故事入书");
  },
  edit() {
    if (this.data.live && this.data.story?.revision) {
      go(
        "edit-story",
        `projectId=${this.projectId}&storyId=${this.data.story.id}${this.assistedSessionId ? `&assistedSessionId=${this.assistedSessionId}` : ""}`,
      );
      return;
    }
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
