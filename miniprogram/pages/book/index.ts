import { type Project } from "../../domain/model";
import { asset, go, home, read } from "../../services/store";
import { dataMode } from "../../services/mode";
import { sessionClient } from "../../services/session";
import { projectOverviewClient } from "../../services/project-overview";
import type {
  BookContext,
  BookVersionView,
  BookCoverSettings,
  PlanDirectory,
} from "../../../packages/contracts/src";
import { bookClient } from "../../services/books";
import { ApiFailure } from "../../services/session";
import { paymentKey } from "../../services/payments";
import {
  clearPhotoPreviews,
  privatePhotoPreview,
} from "../../services/story-photos";
type E = {
  currentTarget: { dataset: Record<string, string> };
  detail: { value: string };
};
Page({
  data: {
    live: false,
    context: null as BookContext | null,
    version: null as BookVersionView | null,
    excerpts: [] as { id: string; title: string; text: string }[],
    stateLabel: "",
    draftAvailable: false,
    sourceStatus: "",
    draft: null as PlanDirectory["chapters"] | null,
    draftVersion: 0,
    draftRows: [] as {
      key: string;
      title: string;
      choices: { id: string; title: string; selected: boolean }[];
      stories: { id: string; title: string }[];
    }[],
    editing: false,
    coverEditing: false,
    coverDirty: false,
    coverDraft: null as Omit<BookCoverSettings, "version"> | null,
    coverDraftVersion: 0,
    coverOptions: [] as { assetId: string; label: string; selected: boolean }[],
    coverImage: "",
    coverStatus: "",
    dirty: false,
    busy: false,
    status: "",
    p: null as Project | null,
    stories: [] as Project["stories"],
    pending: 0,
    bookImage: "",
  },
  projectId: "",
  generation: 0,
  generateRequest: null as { hash: string; key: string } | null,
  retryRequest: null as { id: string; key: string } | null,
  coverRequest: null as { input: string; key: string } | null,
  coverFile: "",
  coverAssetId: "",
  stopSessionWatch: undefined as (() => void) | undefined,
  expiry: undefined as ReturnType<typeof setTimeout> | undefined,
  onLoad(q) {
    if (dataMode() === "live") {
      this.onHide();
      ++this.generation;
      this.projectId = q.projectId || projectOverviewClient.selected();
      this.setData({ live: true });
    }
  },
  onHide() {
    if (this.data.live) {
      ++this.generation;
      this.stopSessionWatch?.();
      this.stopSessionWatch = undefined;
      if (this.expiry) clearTimeout(this.expiry);
      this.generateRequest = null;
      this.retryRequest = null;
      this.coverRequest = null;
      this.clearCover();
      this.setData({
        context: null,
        version: null,
        excerpts: [],
        draftAvailable: false,
        sourceStatus: "",
        draft: null,
        draftVersion: 0,
        draftRows: [],
        editing: false,
        coverEditing: false,
        coverDirty: false,
        coverDraft: null,
        coverDraftVersion: 0,
        coverOptions: [],
        coverStatus: "",
        dirty: false,
        busy: false,
      });
    }
  },
  onUnload() {
    this.onHide();
  },
  async refresh() {
    await this.onShow();
  },
  current(generation: number, context: string) {
    return (
      generation === this.generation &&
      dataMode() === "live" &&
      context === sessionClient.context() &&
      !this.accessExpired()
    );
  },
  accessExpired() {
    return [
      this.data.context?.accessExpiresAt,
      this.data.version?.accessExpiresAt,
    ].some((value) => !!value && Date.parse(value) <= Date.now());
  },
  draftExpired() {
    const access = this.data.context?.draftAccess;
    return (
      [access, this.data.version?.draftAccess].some(
        (value) =>
          value &&
          (!value.allowed ||
            (!!value.expiresAt && Date.parse(value.expiresAt) <= Date.now())),
      ) || !access
    );
  },
  discardDrafts() {
    const value = this.data.context;
    if (!value) return;
    const current = this.data.version
        ? {
            ...this.data.version,
            draftAccess: { allowed: false, expiresAt: null },
          }
        : null,
      cover = current?.snapshot.cover;
    this.generateRequest = null;
    this.retryRequest = null;
    this.coverRequest = null;
    this.setData({
      version: current,
      context: {
        ...value,
        current,
        inputHash: null,
        draftAccess: { allowed: false, expiresAt: null },
        directory: this.data.version?.snapshot.directory || {
          version: 0,
          contentHash: "",
          chapters: [],
        },
        cover: cover
          ? {
              version: cover.version,
              salutation: cover.salutation,
              photoAssetId: cover.photo?.assetId || null,
            }
          : { version: 0, salutation: "", photoAssetId: null },
        eligibleStories: [],
        coverPhotoOptions: [],
      },
      draftAvailable: false,
      sourceStatus: "来源故事当前不可用于编辑或生成，请重新取得本人许可。",
      draft: null,
      draftVersion: 0,
      draftRows: [],
      dirty: false,
      editing: false,
      coverEditing: false,
      coverDirty: false,
      coverDraft: null,
      coverDraftVersion: 0,
      coverOptions: [],
    });
  },
  canDraft() {
    if (this.accessExpired()) {
      this.onHide();
      this.setData({ status: "资料访问已到期，请重新查询" });
      return false;
    }
    if (!this.data.context) return false;
    if (this.draftExpired()) {
      this.discardDrafts();
      return false;
    }
    return true;
  },
  clearCover() {
    const path = this.coverFile;
    this.coverFile = "";
    this.coverAssetId = "";
    this.setData({ coverImage: "" });
    if (path) void clearPhotoPreviews([path]).catch(() => {});
  },
  coverExpired() {
    const access = this.data.version?.coverPhotoAccess;
    return (
      !access?.allowed ||
      (!!access.expiresAt && Date.parse(access.expiresAt) <= Date.now())
    );
  },
  async loadCover(generation: number, owner: string) {
    if (!this.current(generation, owner)) return;
    this.watch(owner);
    const photo = this.data.version?.snapshot.cover.photo;
    if (
      photo &&
      !this.coverExpired() &&
      this.coverAssetId === photo.assetId &&
      this.data.coverImage
    )
      return;
    this.clearCover();
    this.setData({ coverStatus: "" });
    if (!photo) return;
    if (this.coverExpired()) {
      this.setData({
        coverStatus: "封面照片预览已到期，请从完整 PDF 核对照片。",
      });
      return;
    }
    try {
      const path = await privatePhotoPreview(
        this.projectId,
        photo.interviewId,
        photo.id,
        { id: photo.assetId, bytes: photo.bytes, sha256: photo.sha256 },
        () =>
          this.current(generation, owner) &&
          !this.coverExpired() &&
          this.data.version?.snapshot.cover.photo?.assetId === photo.assetId,
      );
      if (!this.current(generation, owner)) {
        await clearPhotoPreviews([path]);
        return;
      }
      this.coverFile = path;
      this.coverAssetId = photo.assetId;
      this.setData({ coverImage: path });
    } catch (error) {
      if (!this.current(generation, owner)) return;
      this.clearCover();
      if (error instanceof ApiFailure && error.status === 401) throw error;
      if (error instanceof ApiFailure && error.status === 403) {
        let fresh: BookVersionView;
        try {
          fresh = await bookClient.readVersion(
            this.projectId,
            this.data.version!.id,
          );
        } catch (failure) {
          if (
            failure instanceof ApiFailure &&
            [401, 403].includes(failure.status)
          )
            throw failure;
          throw new ApiFailure("AUTHORIZATION_RECHECK_FAILED", 403);
        }
        if (!this.current(generation, owner) || !this.data.context) return;
        this.accept({ ...this.data.context, current: fresh }, false, false);
      }
      if (this.current(generation, owner))
        this.setData({
          coverStatus: this.coverExpired()
            ? "封面照片预览已到期，请从完整 PDF 核对照片。"
            : "封面照片暂时无法预览，请从完整 PDF 核对照片。",
        });
    }
  },
  accept(value: BookContext, resetDraft = true, resetCover = true) {
    if (
      value.accessExpiresAt &&
      Date.parse(value.accessExpiresAt) <= Date.now()
    )
      throw new Error("资料访问已到期，请重新取得本人许可");
    const version = value.current;
    this.setData({
      context: value,
      version,
      draftAvailable: true,
      sourceStatus: "",
      excerpts:
        version?.snapshot.chapters.flatMap((c) =>
          c.stories.map((s) => ({
            id: s.id,
            title: s.title,
            text: (s.paragraphs[0] || "").slice(0, 160),
          })),
        ) || [],
      stateLabel: version
        ? {
            queued: "书稿正在排队",
            rendering: "正在生成完整书稿",
            ready: "书稿已生成",
            failed: "书稿生成失败，请重试",
            obsolete: "内容已变化，请重新生成书稿",
          }[version.state]
        : "请先安排目录，再生成书稿",
      ...(resetDraft
        ? {
            draft: JSON.parse(JSON.stringify(value.directory.chapters)),
            draftVersion: value.directory.version,
            dirty: false,
          }
        : {}),
      ...(resetCover
        ? {
            coverDraft: {
              salutation: value.cover.salutation,
              photoAssetId: value.cover.photoAssetId,
            },
            coverDraftVersion: value.cover.version,
            coverDirty: false,
          }
        : {}),
    });
    if (this.draftExpired()) {
      this.discardDrafts();
      return;
    }
    this.updateDraftRows();
    this.updateCoverOptions();
  },
  updateCoverOptions() {
    this.setData({
      coverOptions: (this.data.context?.coverPhotoOptions || []).map(
        (photo, index) => ({
          assetId: photo.assetId,
          label: photo.caption || `已确认照片${index + 1}`,
          selected: photo.assetId === this.data.coverDraft?.photoAssetId,
        }),
      ),
    });
  },
  editCover() {
    if (this.canDraft() && !this.data.busy)
      this.setData({ coverEditing: !this.data.coverEditing });
  },
  salutation(e: E) {
    if (!this.canDraft() || !this.data.coverDraft || this.data.busy) return;
    this.setData({
      coverDraft: { ...this.data.coverDraft, salutation: e.detail.value },
      coverDirty: true,
    });
  },
  chooseCoverPhoto(e: E) {
    if (!this.canDraft() || !this.data.coverDraft || this.data.busy) return;
    const assetId = e.currentTarget.dataset.assetId || null;
    if (
      assetId &&
      !this.data.context?.coverPhotoOptions.some((p) => p.assetId === assetId)
    )
      return;
    this.setData({
      coverDraft: { ...this.data.coverDraft, photoAssetId: assetId },
      coverDirty: true,
    });
    this.updateCoverOptions();
  },
  async saveCover() {
    if (!this.canDraft() || !this.data.coverDraft || !this.data.coverDirty)
      return;
    const expectedVersion = this.data.coverDraftVersion,
      input = { ...this.data.coverDraft },
      serialized = JSON.stringify({ expectedVersion, ...input });
    if (this.coverRequest?.input !== serialized)
      this.coverRequest = { input: serialized, key: paymentKey() };
    const key = this.coverRequest.key;
    return this.perform(async (generation: number, owner: string) => {
      const value = await bookClient.reviseCover(
        this.projectId,
        expectedVersion,
        input,
        key,
      );
      if (this.current(generation, owner)) {
        this.coverRequest = null;
        this.accept(value, !this.data.dirty, true);
        await this.loadCover(generation, owner);
        this.setData({ status: "书封已保存，请生成新书稿" });
      }
    }, true);
  },
  updateDraftRows() {
    const eligible = this.data.context?.eligibleStories || [];
    this.setData({
      draftRows: (this.data.draft || []).map((c) => ({
        ...c,
        choices: eligible.map((s) => ({
          id: s.id,
          title: s.title,
          selected: c.storyRefs.includes(s.id),
        })),
        stories: c.storyRefs.map((id) => ({
          id,
          title:
            eligible.find((s) => s.id === id)?.title ||
            "该故事已不可入书，请移除",
        })),
      })),
    });
  },
  editDirectory() {
    if (this.canDraft() && !this.data.busy)
      this.setData({ editing: !this.data.editing });
  },
  edit(work: (draft: PlanDirectory["chapters"]) => void) {
    if (!this.canDraft() || !this.data.draft || this.data.busy) return;
    const draft = JSON.parse(
      JSON.stringify(this.data.draft),
    ) as PlanDirectory["chapters"];
    work(draft);
    this.setData({ draft, dirty: true });
    this.updateDraftRows();
  },
  addChapter() {
    this.edit((d: PlanDirectory["chapters"]) =>
      d.push({
        key: `chapter_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        title: "新章节",
        storyRefs: [],
      }),
    );
  },
  chapterTitle(e: E) {
    this.edit((d: PlanDirectory["chapters"]) => {
      const chapter = d[Number(e.currentTarget.dataset.chapter)];
      if (chapter) chapter.title = e.detail.value;
    });
  },
  removeChapter(e: E) {
    this.edit((d: PlanDirectory["chapters"]) => {
      const index = Number(e.currentTarget.dataset.chapter);
      if (index >= 0 && index < d.length) d.splice(index, 1);
    });
  },
  moveChapter(e: E) {
    this.edit((d: PlanDirectory["chapters"]) => {
      const index = Number(e.currentTarget.dataset.chapter),
        next = index + Number(e.currentTarget.dataset.direction);
      if (index >= 0 && next >= 0 && index < d.length && next < d.length)
        [d[index], d[next]] = [d[next], d[index]];
    });
  },
  assignStory(e: E) {
    const id = e.currentTarget.dataset.id,
      index = Number(e.currentTarget.dataset.chapter);
    if (!this.data.context?.eligibleStories.some((s) => s.id === id)) return;
    this.edit((d: PlanDirectory["chapters"]) => {
      if (!d[index]) return;
      const remove = d[index].storyRefs.includes(id);
      for (const c of d) c.storyRefs = c.storyRefs.filter((ref) => ref !== id);
      if (!remove) d[index].storyRefs.push(id);
    });
  },
  moveStory(e: E) {
    this.edit((d: PlanDirectory["chapters"]) => {
      const refs = d[Number(e.currentTarget.dataset.chapter)]?.storyRefs;
      if (!refs) return;
      const index = refs.indexOf(e.currentTarget.dataset.id),
        next = index + Number(e.currentTarget.dataset.direction);
      if (index >= 0 && next >= 0 && next < refs.length)
        [refs[index], refs[next]] = [refs[next], refs[index]];
    });
  },
  async saveDirectory() {
    if (!this.canDraft() || !this.data.draft || !this.data.dirty) return;
    const expectedVersion = this.data.draftVersion,
      chapters = JSON.parse(
        JSON.stringify(this.data.draft),
      ) as PlanDirectory["chapters"];
    return this.perform(async (generation: number, owner: string) => {
      const value = await bookClient.reviseDirectory(
        this.projectId,
        expectedVersion,
        chapters,
      );
      if (this.current(generation, owner)) {
        this.accept(value, true, !this.data.coverDirty);
        await this.loadCover(generation, owner);
        this.setData({ status: "目录已保存，请生成新书稿" });
      }
    }, true);
  },
  watch(context: string) {
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = setTimeout(
      () => {
        if (
          dataMode() !== "live" ||
          context !== sessionClient.context() ||
          this.accessExpired()
        ) {
          this.onHide();
          this.setData({ status: "授权已到期或账号已变化，请重新查询" });
          return;
        }
        if (this.draftExpired()) this.discardDrafts();
        if (this.data.version?.snapshot.cover.photo && this.coverExpired()) {
          this.clearCover();
          this.setData({
            coverStatus: "封面照片预览已到期，请从完整 PDF 核对照片。",
          });
        }
        if (
          ["queued", "rendering"].includes(this.data.version?.state || "") &&
          !this.data.busy
        ) {
          void this.perform(async (generation: number, owner: string) => {
            const value = await bookClient.read(this.projectId);
            if (this.current(generation, owner)) {
              this.accept(value, !this.data.dirty, !this.data.coverDirty);
              await this.loadCover(generation, owner);
            }
          });
        }
        this.watch(context);
      },
      Math.max(
        1,
        Math.min(
          1000,
          ...[
            this.data.context?.accessExpiresAt,
            this.data.version?.accessExpiresAt,
            this.data.version?.coverPhotoAccess.expiresAt,
            this.data.context?.draftAccess.expiresAt,
            this.data.version?.draftAccess.expiresAt,
          ]
            .filter((value): value is string => !!value)
            .map((value) => Date.parse(value) - Date.now())
            .filter((value) => value > 0),
        ),
      ),
    );
  },
  async perform(
    work: (generation: number, context: string) => Promise<void>,
    sourceCommand = false,
  ) {
    if (this.data.busy) return;
    if (this.accessExpired()) {
      this.onHide();
      this.setData({ status: "资料访问已到期，请重新查询" });
      return;
    }
    const generation = ++this.generation,
      context = sessionClient.context();
    this.setData({ busy: true, status: "" });
    try {
      await work(generation, context);
      if (
        generation === this.generation &&
        context !== sessionClient.context()
      ) {
        this.onHide();
        this.setData({ status: "账号已变化，请重新查询" });
      }
    } catch (error) {
      if (generation !== this.generation) return;
      if (
        sourceCommand &&
        context === sessionClient.context() &&
        error instanceof ApiFailure &&
        error.status === 403
      ) {
        try {
          const value = await bookClient.read(this.projectId);
          if (!this.current(generation, context)) return;
          this.accept(value);
          this.watch(context);
          await this.loadCover(generation, context);
          if (this.current(generation, context))
            this.setData({
              status: "操作权限已变化，已重新查询有效书稿。",
            });
          return;
        } catch (failure) {
          error =
            failure instanceof ApiFailure && [401, 403].includes(failure.status)
              ? failure
              : new ApiFailure("AUTHORIZATION_RECHECK_FAILED", 403);
        }
        if (generation !== this.generation) return;
      }
      if (
        context !== sessionClient.context() ||
        (error instanceof ApiFailure && [401, 403].includes(error.status))
      ) {
        this.onHide();
        this.setData({
          status:
            error instanceof ApiFailure &&
            error.code === "AUTHORIZATION_RECHECK_FAILED"
              ? "资料权限未能重新核对，请重新查询"
              : "授权已失效或账号已变化，请重新查询",
        });
      } else
        this.setData({
          status:
            error instanceof ApiFailure && error.status === 409
              ? "编辑冲突：修改已保留，请重新查询后核对。"
              : error instanceof Error
                ? error.message
                : "操作未确认，请重新查询",
          ...(sourceCommand ? {} : { version: null, excerpts: [] }),
        });
    } finally {
      if (generation === this.generation && this.accessExpired()) {
        this.onHide();
        this.setData({ status: "资料访问已到期，请重新查询" });
      }
      if (generation === this.generation) this.setData({ busy: false });
    }
  },
  async generate() {
    if (
      !this.canDraft() ||
      !this.data.context ||
      !this.data.context.inputHash ||
      this.data.dirty ||
      this.data.coverDirty ||
      this.data.busy
    )
      return;
    const inputHash = this.data.context.inputHash;
    if (this.generateRequest?.hash !== inputHash)
      this.generateRequest = { hash: inputHash, key: paymentKey() };
    const key = this.generateRequest.key;
    return this.perform(async (generation: number, owner: string) => {
      const value = await bookClient.generate(this.projectId, inputHash, key);
      if (this.current(generation, owner) && this.data.context) {
        this.generateRequest = null;
        this.accept({ ...this.data.context, current: value }, false);
        await this.loadCover(generation, owner);
        this.watch(owner);
      }
    }, true);
  },
  async retry() {
    if (
      !this.canDraft() ||
      !this.data.version ||
      this.data.version.state !== "failed"
    )
      return;
    const id = this.data.version.id;
    if (this.retryRequest?.id !== id)
      this.retryRequest = { id, key: paymentKey() };
    const key = this.retryRequest.key;
    return this.perform(async (generation: number, owner: string) => {
      const value = await bookClient.retry(this.projectId, id, key);
      if (this.current(generation, owner) && this.data.context) {
        this.retryRequest = null;
        this.accept({ ...this.data.context, current: value }, false);
        await this.loadCover(generation, owner);
        this.watch(owner);
      }
    }, true);
  },
  async onShow() {
    if (dataMode() === "live") {
      this.stopSessionWatch?.();
      this.stopSessionWatch = sessionClient.onInvalidated(() => {
        this.onHide();
        this.setData({ status: "登录已失效，请重新登录" });
      });
      return this.perform(async (generation: number, context: string) => {
        this.clearCover();
        this.setData({
          live: true,
          context: null,
          version: null,
          excerpts: [],
          draft: null,
          draftVersion: 0,
          dirty: false,
          editing: false,
          coverEditing: false,
          coverDirty: false,
          coverDraft: null,
          coverOptions: [],
        });
        const value = await bookClient.read(this.projectId);
        if (this.current(generation, context)) {
          this.accept(value);
          this.watch(context);
          await this.loadCover(generation, context);
        }
      });
    }
    const p = read();
    if (!p) {
      home("home");
      return;
    }
    this.setData({
      p,
      bookImage: asset(p),
      stories: p.stories.filter((s) => s.included),
      pending: p.stories.filter(
        (s) => s.included && s.confirmedVersion !== s.version,
      ).length,
    });
  },
  manuscript() {
    if (this.data.live) {
      if (this.accessExpired()) {
        this.onHide();
        this.setData({ status: "资料访问已到期，请重新查询" });
        return;
      }
      if (this.data.version?.state === "ready")
        go(
          "manuscript",
          `projectId=${this.projectId}&versionId=${this.data.version.id}`,
        );
      return;
    }
    go("manuscript");
  },
  story(e: E) {
    if (this.data.live) {
      go(
        "story",
        `projectId=${this.projectId}&storyId=${e.currentTarget.dataset.id}`,
      );
      return;
    }
    go("story", "id=" + e.currentTarget.dataset.id);
  },
  print() {
    if (this.data.live) {
      if (this.accessExpired()) {
        this.onHide();
        this.setData({ status: "资料访问已到期，请重新查询" });
        return;
      }
      if (this.data.version?.state === "ready")
        go(
          "print",
          `projectId=${this.projectId}&versionId=${this.data.version.id}`,
        );
      return;
    }
    go("print");
  },
  settings() {
    go("settings", this.data.live ? `projectId=${this.projectId}` : "");
  },
  record() {
    go("interview", this.data.live ? `projectId=${this.projectId}` : "");
  },
  project() {
    if (this.data.live) {
      wx.reLaunch({ url: `/pages/project/index?projectId=${this.projectId}` });
      return;
    }
    home("project");
  },
  book() {
    if (this.data.live) {
      wx.reLaunch({ url: `/pages/book/index?projectId=${this.projectId}` });
      return;
    }
    home("book");
  },
  account() {
    if (this.data.live) {
      wx.reLaunch({ url: `/pages/account/index?projectId=${this.projectId}` });
      return;
    }
    home("account");
  },
});
