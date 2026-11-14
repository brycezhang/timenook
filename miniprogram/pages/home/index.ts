import { checkChannelReminders } from "../../services/channel-activation";
import { NATIVE_TABS } from "../../config";
import { ApiFailure, sessionClient } from "../../services/session";
import { projectOverviewClient } from "../../services/project-overview";
import {
  go,
  setTabBarVisible,
  switchProjectTab,
} from "../../services/navigation";
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
import type {
  CurrentPackage,
  PersonalPlan,
  ProjectOverview,
} from "../../../packages/contracts/src";

const emptyOffer = {
  offer: null as CurrentPackage | null,
  price: "",
  offerLabel: "套餐准备中",
};

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
    ...emptyOffer,
    offerLoading: false,
    offerError: "",
  },
  plan: null as PersonalPlan | null,
  coverAssetId: "",
  coverExpiresAt: null as string | null,
  coverExpiryTimer: undefined as ReturnType<typeof setTimeout> | undefined,
  generation: 0,
  ownerContext: "",
  loginDestination: "home",
  stopSession: undefined as (() => void) | undefined,
  clearCoverOnAppHide: undefined as (() => void) | undefined,
  onLoad() {
    this.clearCoverOnAppHide = () => {
      ++this.generation;
      this.clearCover();
    };
    wx.onAppHide?.(this.clearCoverOnAppHide);
    this.stopSession = sessionClient.onSessionEnded((owner, reason) => {
      if (owner !== this.ownerContext) return;
      ++this.generation;
      this.ownerContext = "";
      this.clearProject();
      resetQuestionSession();
      this.setData({
        loggedIn: false,
        pageLoading: false,
        busy: false,
        status: "",
        ...emptyOffer,
        offerError: "",
        offerLoading: false,
      });
      if (reason !== "replaced") void this.loadOffer();
    });
  },
  clearCover() {
    if (this.coverExpiryTimer !== undefined) clearTimeout(this.coverExpiryTimer);
    this.coverExpiryTimer = undefined;
    this.coverAssetId = "";
    this.coverExpiresAt = null;
    const { coverImage } = this.data;
    if (coverImage) {
      this.setData({ coverImage: "" });
      void clearPhotoPreviews([coverImage]).catch(() => {});
    }
  },
  scheduleCoverExpiry(expiresAt: string | null) {
    if (this.coverExpiryTimer !== undefined) clearTimeout(this.coverExpiryTimer);
    this.coverExpiryTimer = undefined;
    this.coverExpiresAt = expiresAt;
    if (!expiresAt) return;
    const remaining = Date.parse(expiresAt) - Date.now();
    if (remaining <= 0) {
      this.clearCover();
      return;
    }
    const timer = setTimeout(() => {
      // This deadline belongs to the displayed cover, even while a refresh is pending.
      if (this.coverExpiryTimer === timer) this.scheduleCoverExpiry(expiresAt);
    }, Math.min(remaining, 2 ** 31 - 1));
    this.coverExpiryTimer = timer;
  },
  clearProject() {
    this.plan = null;
    this.clearCover();
    this.setData({
      overview: null,
      question: null,
      count: 0,
      familyPending: 0,
      giftCaption: "",
      giftPage: "",
    });
  },
  async onShow() {
    const generation = ++this.generation,
      owner = sessionClient.context(),
      selectedId = projectOverviewClient.selected();
    if (
      owner !== this.ownerContext ||
      (selectedId && selectedId !== this.data.overview?.projectId) ||
      (this.data.overview?.accessExpiresAt &&
        Date.parse(this.data.overview.accessExpiresAt) <= Date.now())
    ) {
      this.clearProject();
      wx.pageScrollTo({ scrollTop: 0, duration: 0 });
    }
    if (this.coverExpiresAt && Date.parse(this.coverExpiresAt) <= Date.now())
      this.clearCover();
    if (owner !== this.ownerContext)
      this.setData({ ...emptyOffer, offerError: "", offerLoading: false });
    this.ownerContext = owner;
    this.setData({
      busy: !!owner && !this.data.overview && !this.data.offer,
      status: "",
      loggedIn: !!owner,
    });
    try {
      if (!(await sessionClient.restore())) {
        if (generation === this.generation) {
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
      if (
        this.data.overview &&
        selected?.projectId !== this.data.overview.projectId
      )
        this.clearProject();
      if (!selected) {
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
        busy: false,
        pageLoading: false,
      });
      await this.loadCover(selected.projectId, generation, owner);
    } catch (e) {
      if (generation === this.generation) {
        if (
          owner !== sessionClient.context() ||
          (e instanceof ApiFailure && [401, 403, 404].includes(e.status))
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
      if (generation === this.generation && owner === sessionClient.context())
        void checkChannelReminders(
          () =>
            generation === this.generation &&
            !this.data.busy &&
            !this.data.loginVisible,
        ).catch(() => {});
    }
  },
  async loadCover(projectId: string, generation: number, owner: string) {
    const current = () =>
      generation === this.generation &&
      owner === sessionClient.context() &&
      this.data.overview?.projectId === projectId;
    try {
      const context = await bookClient.read(projectId);
      if (!current()) return;
      const expiresAt = context.draftAccess.expiresAt;
      const authorized = () =>
        current() && (!expiresAt || Date.parse(expiresAt) > Date.now());
      const photo =
        context.draftAccess.allowed && authorized()
          ? context.coverPhotoOptions.find(
              (p) => p.assetId === context.cover.photoAssetId,
            )
          : undefined;
      if (!photo) {
        this.clearCover();
        return;
      }
      const { coverImage: cachedImage } = this.data;
      if (this.coverAssetId === photo.assetId && cachedImage) {
        const exists = await new Promise<boolean>((resolve) =>
          wx.getFileSystemManager().access({
            path: cachedImage,
            success: () => resolve(true),
            fail: () => resolve(false),
          }),
        );
        if (!current()) return;
        if (exists && this.data.coverImage === cachedImage && authorized()) {
          this.scheduleCoverExpiry(expiresAt);
          return;
        }
      }
      this.clearCover();
      if (!authorized()) return;
      const coverImage = await previewBookPhoto(projectId, photo, authorized);
      if (!authorized()) {
        await clearPhotoPreviews([coverImage]).catch(() => {});
        return;
      }
      this.coverAssetId = photo.assetId;
      this.setData({ coverImage });
      this.scheduleCoverExpiry(expiresAt);
    } catch (error) {
      if (
        current() &&
        error instanceof ApiFailure &&
        [401, 403, 404].includes(error.status)
      )
        this.clearCover();
    }
  },
  async loadOffer() {
    const n = this.generation;
    this.setData({ offerLoading: !this.data.offer, offerError: "" });
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
          offerError: e instanceof Error ? e.message : "套餐加载失败",
        });
    } finally {
      if (n === this.generation) this.setData({ offerLoading: false });
    }
  },
  onHide() {
    ++this.generation;
    this.setData({ starting: false });
  },
  onUnload() {
    this.stopSession?.();
    if (this.clearCoverOnAppHide) wx.offAppHide?.(this.clearCoverOnAppHide);
    this.onHide();
    this.clearCover();
  },
  refresh() {
    return this.onShow();
  },
  purchase() {
    if (!this.data.offer?.purchasable) return;
    if (sessionClient.context()) go("new-book");
    else {
      this.login("new-book");
    }
  },
  login(destination = "home") {
    this.loginDestination = destination;
    setTabBarVisible(false);
    this.setData({ loginVisible: true });
  },
  loginSucceeded() {
    const destination = this.loginDestination;
    this.closeLogin();
    this.setData({ loggedIn: true, status: "" });
    if (destination === "new-book") go("new-book");
    else void this.onShow();
  },
  closeLogin() {
    this.loginDestination = "home";
    this.setData({ loginVisible: false });
    setTabBarVisible(true);
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
