import type {
  BookContext,
  ProjectOverview,
} from "../../../packages/contracts/src";
import { bookClient } from "../../services/books";
import { projectOverviewClient } from "../../services/project-overview";
import { sessionClient } from "../../services/session";
import { paymentKey } from "../../services/payments";
import { previewBookPhoto } from "../../services/book-editor";
import { clearPhotoPreviews } from "../../services/story-photos";
import { watchProjectAccess } from "../../services/project-access";
import { go } from "../../services/navigation";
import { switchProjectTab } from "../../services/navigation";
Page({
  data: {
    context: null as BookContext | null,
    title: "",
    coverImage: "",
    stateLabel: "",
    busy: false,
    pageLoading: true,
    status: "",
    dirty: false,
    screen: "overview",
    ready: false,
    rendering: false,
    storyCount: 0,
    photoCount: 0,
    unassignedCount: 0,
  },
  projectId: "",
  project: null as ProjectOverview | null,
  coverAssetId: "",
  generation: 0,
  timer: undefined as ReturnType<typeof setTimeout> | undefined,
  intent: null as { hash: string; key: string } | null,
  stopAccess: undefined as (() => void) | undefined,
  stopSession: undefined as (() => void) | undefined,
  onLoad(q) {
    this.projectId = q.projectId || projectOverviewClient.selected();
    this.stopSession = sessionClient.onInvalidated(() => this.clearAccess());
  },
  onShow() {
    this.stopAccess?.();
    const owner = sessionClient.context();
    this.stopAccess = watchProjectAccess(
      this.projectId,
      () => owner === sessionClient.context(),
      () => this.clearAccess(),
    );
    void this.refresh();
  },
  clearAccess() {
    this.onHide();
    this.setData({
      title: "",
      stateLabel: "",
      status: "项目访问已变化，请重新打开",
    });
  },
  onHide() {
    this.stopAccess?.();
    this.stopAccess = undefined;
    ++this.generation;
    if (this.timer) clearTimeout(this.timer);
    void clearPhotoPreviews([this.data.coverImage].filter(Boolean));
    this.project = null;
    this.coverAssetId = "";
    this.setData({
      context: null,
      coverImage: "",
      busy: false,
      pageLoading: false,
    });
  },
  onUnload() {
    this.stopSession?.();
    this.onHide();
  },
  async refresh() {
    if (this.data.busy) return;
    const n = ++this.generation,
      owner = sessionClient.context();
    this.setData({ busy: true, pageLoading: !this.data.context, status: "" });
    try {
      const [c, p] = await Promise.all([
        bookClient.read(this.projectId),
        projectOverviewClient.read(this.projectId),
      ]);
      if (n !== this.generation || owner !== sessionClient.context()) return;
      this.project = p;
      this.setData({ title: p.bookTitle });
      this.accept(c);
      const photo = c.draftAccess.allowed
        ? c.coverPhotoOptions.find((x) => x.assetId === c.cover.photoAssetId)
        : c.current?.coverPhotoAccess.allowed
          ? c.current.snapshot.cover.photo
          : null;
      if (photo?.assetId !== this.coverAssetId) {
        void clearPhotoPreviews([this.data.coverImage].filter(Boolean));
        this.coverAssetId = photo?.assetId || "";
        this.setData({ coverImage: "" });
      }
      if (photo && !this.data.coverImage) {
        try {
          const path = await previewBookPhoto(
            this.projectId,
            photo,
            () => n === this.generation && owner === sessionClient.context(),
          );
          if (n !== this.generation || owner !== sessionClient.context()) {
            await clearPhotoPreviews([path]);
            return;
          }
          void clearPhotoPreviews([this.data.coverImage].filter(Boolean));
          this.setData({ coverImage: path });
        } catch {
          if (n === this.generation)
            this.setData({ status: "封面照片暂时未能读取" });
        }
      }
    } catch (e) {
      if (n === this.generation) {
        void clearPhotoPreviews([this.data.coverImage].filter(Boolean));
        this.setData({
          context: null,
          coverImage: "",
          status: e instanceof Error ? e.message : "书稿未能读取",
        });
      }
    } finally {
      if (n === this.generation) {
        this.setData({ busy: false, pageLoading: false });
        this.poll();
      }
    }
  },
  poll() {
    if (this.timer) clearTimeout(this.timer);
    if (this.data.rendering && this.data.context)
      this.timer = setTimeout(() => void this.refresh(), 3000);
  },
  accept(c: BookContext) {
    const v = c.current,
      dirty = !!v && (v.inputHash !== c.inputHash || v.state === "obsolete"),
      ready = !!v && v.state === "ready" && !dirty,
      rendering = !!v && ["queued", "rendering"].includes(v.state) && !dirty,
      selected = new Set(c.directory.chapters.flatMap((ch) => ch.storyRefs)),
      included = c.eligibleStories.filter((story) => selected.has(story.id));
    const photos = new Set(
      this.project?.stories
        .filter((s) => selected.has(s.id))
        .flatMap(
          (s) => s.revision?.photoSnapshot?.entries.map((p) => p.photoId) || [],
        ),
    );
    this.setData({
      context: c,
      dirty,
      ready,
      rendering,
      storyCount: included.length,
      photoCount: photos.size,
      unassignedCount: c.eligibleStories.filter((s) => !selected.has(s.id))
        .length,
      screen: dirty
        ? "changed"
        : v?.state === "failed"
          ? "failed"
          : !v && !c.eligibleStories.length
            ? "empty"
            : "overview",
      stateLabel: dirty
        ? "书稿待更新"
        : ready
          ? `PDF 已生成 · V${v!.version}`
          : rendering
            ? "正在生成 PDF"
            : v?.state === "failed"
              ? "书稿生成失败"
              : "尚未生成 PDF",
    });
    if (this.timer) clearTimeout(this.timer);
  },
  async generate() {
    const c = this.data.context;
    if (this.data.busy || !c?.inputHash || this.data.rendering) return;
    if (!this.data.storyCount) {
      this.directory();
      return;
    }
    const n = this.generation,
      owner = sessionClient.context();
    this.setData({ busy: true, status: "" });
    if (this.intent?.hash !== c.inputHash)
      this.intent = { hash: c.inputHash, key: paymentKey() };
    try {
      const v = await (c.current?.state === "failed" && !this.data.dirty
        ? bookClient.retry(this.projectId, c.current.id, this.intent.key)
        : bookClient.generate(this.projectId, c.inputHash, this.intent.key));
      if (n === this.generation && owner === sessionClient.context()) {
        this.intent = null;
        this.accept({ ...c, current: v });
      }
    } catch (e) {
      if (n === this.generation)
        this.setData({
          status:
            e instanceof Error ? e.message : "生成结果未确认，请查询后重试",
        });
    } finally {
      if (n === this.generation) {
        this.setData({ busy: false });
        this.poll();
      }
    }
  },
  cover() {
    go("cover", `projectId=${this.projectId}`);
  },
  directory() {
    go("directory", `projectId=${this.projectId}`);
  },
  manuscript() {
    const v = this.data.context?.current;
    if (this.data.ready && v)
      go("manuscript", `projectId=${this.projectId}&versionId=${v.id}`);
    else if (this.data.dirty) this.setData({ screen: "changed" });
  },
  print() {
    if (this.data.ready) go("print", `projectId=${this.projectId}`);
  },
  showOverview() {
    this.setData({ screen: "overview" });
  },
  unassigned() {
    go("stories", `projectId=${this.projectId}&filter=unassigned`);
  },
  projectHome() {
    switchProjectTab("home", this.projectId);
  },
  production() {
    go("production", `projectId=${this.projectId}`);
  },
  record() {
    go("interview", `projectId=${this.projectId}`);
  },
});
