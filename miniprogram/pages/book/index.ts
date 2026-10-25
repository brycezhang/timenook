import { type Project } from "../../domain/model";
import { asset, go, home, read } from "../../services/store";
import { dataMode } from "../../services/mode";
import { sessionClient } from "../../services/session";
import { projectOverviewClient } from "../../services/project-overview";
import type {
  BookContext,
  BookVersionView,
  PlanDirectory,
} from "../../../packages/contracts/src";
import { bookClient } from "../../services/books";
import { ApiFailure } from "../../services/session";
import { paymentKey } from "../../services/payments";
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
    draft: null as PlanDirectory["chapters"] | null,
    draftRows: [] as {
      key: string;
      title: string;
      choices: { id: string; title: string; selected: boolean }[];
      stories: { id: string; title: string }[];
    }[],
    editing: false,
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
      this.setData({
        context: null,
        version: null,
        excerpts: [],
        draft: null,
        draftRows: [],
        editing: false,
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
  accept(value: BookContext, resetDraft = true) {
    if (
      value.accessExpiresAt &&
      Date.parse(value.accessExpiresAt) <= Date.now()
    )
      throw new Error("资料访问已到期，请重新取得本人许可");
    const version = value.current;
    this.setData({
      context: value,
      version,
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
            dirty: false,
          }
        : {}),
    });
    this.updateDraftRows();
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
    if (!this.data.busy && this.data.context)
      this.setData({ editing: !this.data.editing });
  },
  edit(work: (draft: PlanDirectory["chapters"]) => void) {
    if (!this.data.draft || this.data.busy) return;
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
    if (!this.data.context || !this.data.draft || !this.data.dirty) return;
    const expectedVersion = this.data.context.directory.version,
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
        this.accept(value);
        this.setData({ status: "目录已保存，请生成新书稿" });
      }
    }, true);
  },
  watch(context: string) {
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = setTimeout(() => {
      if (
        dataMode() !== "live" ||
        context !== sessionClient.context() ||
        (this.data.context?.accessExpiresAt &&
          Date.parse(this.data.context.accessExpiresAt) <= Date.now())
      ) {
        this.onHide();
        this.setData({ status: "授权已到期或账号已变化，请重新查询" });
        return;
      }
      if (
        ["queued", "rendering"].includes(this.data.version?.state || "") &&
        !this.data.busy
      ) {
        void this.perform(async (generation: number, owner: string) => {
          const value = await bookClient.read(this.projectId);
          if (this.current(generation, owner))
            this.accept(value, !this.data.dirty);
        });
      }
      this.watch(context);
    }, 1000);
  },
  async perform(
    work: (generation: number, context: string) => Promise<void>,
    preserveDraft = false,
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
        context !== sessionClient.context() ||
        (error instanceof ApiFailure && [401, 403].includes(error.status))
      ) {
        this.onHide();
        this.setData({ status: "授权已失效或账号已变化，请重新查询" });
      } else
        this.setData({
          status:
            error instanceof ApiFailure && error.status === 409
              ? "编辑冲突：修改已保留，请重新查询后核对。"
              : error instanceof Error
                ? error.message
                : "操作未确认，请重新查询",
          ...(preserveDraft ? {} : { version: null, excerpts: [] }),
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
    if (!this.data.context || this.data.dirty || this.data.busy) return;
    const inputHash = this.data.context.inputHash;
    if (this.generateRequest?.hash !== inputHash)
      this.generateRequest = { hash: inputHash, key: paymentKey() };
    const key = this.generateRequest.key;
    return this.perform(async (generation: number, owner: string) => {
      const value = await bookClient.generate(this.projectId, inputHash, key);
      if (this.current(generation, owner) && this.data.context) {
        this.generateRequest = null;
        this.accept({ ...this.data.context, current: value }, false);
        this.watch(owner);
      }
    }, true);
  },
  async retry() {
    if (!this.data.version || this.data.version.state !== "failed") return;
    const id = this.data.version.id;
    if (this.retryRequest?.id !== id)
      this.retryRequest = { id, key: paymentKey() };
    const key = this.retryRequest.key;
    return this.perform(async (generation: number, owner: string) => {
      const value = await bookClient.retry(this.projectId, id, key);
      if (this.current(generation, owner) && this.data.context) {
        this.retryRequest = null;
        this.accept({ ...this.data.context, current: value }, false);
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
        this.setData({
          live: true,
          context: null,
          version: null,
          excerpts: [],
          draft: null,
          dirty: false,
          editing: false,
        });
        const value = await bookClient.read(this.projectId);
        if (this.current(generation, context)) {
          this.accept(value);
          this.watch(context);
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
    if (this.data.live) return;
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
