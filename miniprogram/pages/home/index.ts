import { NATIVE_TABS } from "../../config";
import { ApiFailure, sessionClient } from "../../services/session";
import { projectOverviewClient } from "../../services/project-overview";
import { showProjectTab, switchProjectTab } from "../../services/navigation";
import { personalPlanClient } from "../../services/personal-plan";
import {
  familyQuestionClient,
  startFamilyAnswer,
} from "../../services/family-questions";
import {
  questionSession,
  resetQuestionSession,
  type RecommendedQuestion,
} from "../../services/question-recommendations";
import { startOutlineAnswer } from "../../services/outline";
import { readCurrentPackage } from "../../services/catalog";
import { bookClient } from "../../services/books";
import { previewBookPhoto } from "../../services/book-editor";
import { clearPhotoPreviews } from "../../services/story-photos";
import { giftContinuation } from "../../services/gifts";
import { go } from "../../services/navigation";
import type {
  CurrentPackage,
  PersonalPlan,
  ProjectOverview,
} from "../../../packages/contracts/src";
Page({
  data: {
    nativeTabs: NATIVE_TABS,
    pageLoading: true,
    busy: false,
    starting: false,
    status: "",
    overview: null as ProjectOverview | null,
    question: null as RecommendedQuestion | null,
    count: 0,
    familyPending: 0,
    giftCaption: "",
    giftPage: "" as ReturnType<typeof giftContinuation>,
    coverImage: "",
    loggedIn: false,
    loginVisible: false,
    offer: null as CurrentPackage | null,
    price: "",
    offerLabel: "套餐准备中",
    offerLoading: false,
    offerError: "",
  },
  plan: null as PersonalPlan | null,
  generation: 0,
  ownerContext: "",
  loginDestination: "home",
  stopSession: undefined as (() => void) | undefined,
  onLoad() {
    this.stopSession = sessionClient.onInvalidated(() => {
      ++this.generation;
      this.clearProject();
      resetQuestionSession();
      this.setData({
        loggedIn: false,
        pageLoading: false,
        busy: false,
        status: "",
      });
      void this.loadOffer();
    });
  },
  clearProject() {
    this.plan = null;
    void clearPhotoPreviews([this.data.coverImage].filter(Boolean));
    this.setData({
      overview: null,
      question: null,
      count: 0,
      familyPending: 0,
      giftCaption: "",
      giftPage: "",
      coverImage: "",
    });
  },
  async onShow() {
    showProjectTab(this, "home");
    const generation = ++this.generation,
      owner = sessionClient.context(),
      selectedId = projectOverviewClient.selected();
    if (
      !owner ||
      owner !== this.ownerContext ||
      (selectedId && selectedId !== this.data.overview?.projectId)
    ) {
      this.clearProject();
      wx.pageScrollTo({ scrollTop: 0, duration: 0 });
    }
    this.ownerContext = owner;
    this.setData({
      busy: !!owner && !this.data.overview,
      giftPage: "",
      status: "",
      loggedIn: !!owner,
    });
    try {
      if (!(await sessionClient.restore())) {
        if (generation === this.generation) {
          this.clearProject();
          this.setData({ loggedIn: false });
          await this.loadOffer();
        }
        return;
      }
      if (generation !== this.generation || owner !== sessionClient.context())
        return;
      const { projects } = await projectOverviewClient.memberships();
      const selected =
        projects.find(
          (p) => p.projectId === projectOverviewClient.selected(),
        ) ?? projects[0];
      if (generation !== this.generation || owner !== sessionClient.context())
        return;
      if (!selected) {
        this.clearProject();
        await this.loadOffer();
        return;
      }
      const [overview, plan, family] = await Promise.all([
        projectOverviewClient.read(selected.projectId),
        personalPlanClient.read(selected.projectId),
        familyQuestionClient.list(selected.projectId),
      ]);
      if (generation !== this.generation || owner !== sessionClient.context())
        return;
      projectOverviewClient.select(selected.projectId);
      this.plan = plan;
      this.setData({
        overview,
        count: projects.length,
        question: questionSession(selected.projectId).update(
          plan,
          family.questions,
        ),
        familyPending: family.questions.filter(
          (q) => !q.story && q.state !== "skipped",
        ).length,
        giftCaption: `${selected.giverNickname}送给${selected.isSelfGift ? "自己" : selected.giftRelationship || "家人"}的时光故事书`,
        giftPage: giftContinuation(selected),
      });
      void this.loadCover(selected.projectId, generation, owner);
    } catch (e) {
      if (generation === this.generation) {
        if (
          owner !== sessionClient.context() ||
          (e instanceof ApiFailure && [401, 403].includes(e.status))
        ) {
          this.clearProject();
          this.setData({ loggedIn: !!sessionClient.context() });
        }
        this.setData({
          status: e instanceof Error ? e.message : "项目未能读取，请重试",
        });
      }
    } finally {
      if (generation === this.generation)
        this.setData({ busy: false, pageLoading: false });
    }
  },
  async loadCover(projectId: string, generation: number, owner: string) {
    const current = () =>
      generation === this.generation && owner === sessionClient.context();
    try {
      const context = await bookClient.read(projectId);
      if (!current()) return;
      const photo = context.coverPhotoOptions.find(
        (p) => p.assetId === context.cover.photoAssetId,
      );
      const coverImage = photo
        ? await previewBookPhoto(projectId, photo, current)
        : "";
      if (!current()) {
        if (coverImage) await clearPhotoPreviews([coverImage]);
        return;
      }
      if (this.data.coverImage !== coverImage)
        void clearPhotoPreviews([this.data.coverImage].filter(Boolean));
      this.setData({ coverImage });
    } catch {
      /* The saved title remains the book entry when its cover is unavailable. */
    }
  },
  async loadOffer() {
    const n = this.generation;
    this.setData({ offerLoading: true, offerError: "" });
    try {
      const offer = await readCurrentPackage();
      if (n !== this.generation) return;
      this.setData({
        offer,
        price: offer.checkout
          ? (offer.checkout.amount / 100).toFixed(
              offer.checkout.amount % 100 ? 2 : 0,
            )
          : offer.version
            ? (offer.version.price.value / 100).toFixed(0)
            : "",
        offerLabel: offer.checkout?.isE2e
          ? "内测套餐"
          : offer.version?.title || "套餐准备中",
      });
    } catch (e) {
      if (n === this.generation)
        this.setData({
          offer: null,
          price: "",
          offerError: e instanceof Error ? e.message : "套餐加载失败",
        });
    } finally {
      if (n === this.generation) this.setData({ offerLoading: false });
    }
  },
  onHide() {
    ++this.generation;
    void clearPhotoPreviews([this.data.coverImage].filter(Boolean));
    this.setData({ coverImage: "", starting: false });
  },
  onUnload() {
    this.stopSession?.();
    this.onHide();
  },
  refresh() {
    void this.onShow();
  },
  purchase() {
    if (!this.data.offer?.purchasable) return;
    if (sessionClient.context()) go("new-book");
    else {
      this.loginDestination = "new-book";
      this.setData({ loginVisible: true });
    }
  },
  login() {
    this.loginDestination = "home";
    this.setData({ loginVisible: true });
  },
  loginSucceeded() {
    this.setData({ loginVisible: false, loggedIn: true, status: "" });
    if (this.loginDestination === "new-book") go("new-book");
    else void this.onShow();
  },
  closeLogin() {
    this.loginDestination = "home";
    this.setData({ loginVisible: false });
  },
  switchProject() {
    go("projects", "switch=1");
  },
  nextQuestion() {
    if (this.data.overview)
      this.setData({
        question: questionSession(this.data.overview.projectId).next(),
      });
  },
  async record() {
    const p = this.data.overview,
      q = this.data.question;
    if (!p?.canRecord || !this.plan || this.data.starting) return;
    this.setData({ starting: true, status: "" });
    try {
      if (q?.kind === "family")
        await startFamilyAnswer(p.projectId, this.plan.revision, q.key);
      else await startOutlineAnswer(p.projectId, this.plan.revision, q?.key);
    } catch (e) {
      this.setData({
        status: e instanceof Error ? e.message : "暂时无法开始讲述",
      });
    } finally {
      this.setData({ starting: false });
    }
  },
  stories() {
    if (this.data.overview)
      go("stories", `projectId=${this.data.overview.projectId}`);
  },
  photos() {
    if (this.data.overview)
      go("photos", `projectId=${this.data.overview.projectId}`);
  },
  book() {
    if (this.data.overview)
      go("book", `projectId=${this.data.overview.projectId}`);
  },
  continueGift() {
    const { overview, giftPage } = this.data;
    if (overview && giftPage && this.ownerContext === sessionClient.context())
      go(giftPage, `projectId=${overview.projectId}`);
  },
  family() {
    if (this.data.overview)
      go("family-questions", `projectId=${this.data.overview.projectId}`);
  },
  directory() {
    if (this.data.overview)
      go("directory", `projectId=${this.data.overview.projectId}`);
  },
  invite() {
    if (this.data.overview?.canInvite)
      go("invite", `projectId=${this.data.overview.projectId}`);
  },
  sample() {
    go("sample");
  },
  terms() {
    go("terms");
  },
  account() {
    switchProjectTab("account");
  },
});
