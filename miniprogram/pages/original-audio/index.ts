import { go } from "../../services/navigation";
import type { BookAudioEntryView } from "../../../packages/contracts/src";
import {
  bookAudioClient,
  validBookAudioEntry,
} from "../../services/book-audio";
import { clearStoryAudio, privateAudioFile } from "../../services/story-audio";
import { dataMode, setDataMode } from "../../services/mode";
import { sessionClient, ApiFailure } from "../../services/session";
import { audioTime } from "../../services/story-presentation";
import { previewBookPhoto } from "../../services/book-editor";
import { clearPhotoPreviews } from "../../services/story-photos";
function scannedEntry(q: Record<string, string | undefined>): string {
  try {
    const direct = q.entryId ?? (q.scene ? decodeURIComponent(q.scene) : "");
    if (direct) return validBookAudioEntry(direct) ? direct : "";
    const link = q.q ? decodeURIComponent(q.q) : "";
    return (
      /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[A-Za-z0-9_-]+)*\/audio\/([A-Za-z0-9_-]{22})\/?$/.exec(
        link,
      )?.[1] ?? ""
    );
  } catch {
    return "";
  }
}
type PlayEvent = { currentTarget: { dataset: { id: string } } };
Page({
  data: {
    entry: null as BookAudioEntryView | null,
    busy: false,
    loggedIn: false,
    loginVisible: false,
    status: "",
    paused: false,
    position: 0,
    duration: 0,
    positionLabel: "00:00",
    durationLabel: "00:00",
    playingClipId: "",
    loadingClipId: "",
    clips: [] as (BookAudioEntryView["clips"][number] & {
      durationSeconds: number;
      durationLabel: string;
    })[],
    image: "",
    photoLoading: false,
    photoError: "",
  },
  entryId: "",
  generation: 0,
  active: false,
  seeking: false,
  player: undefined as WechatMiniprogram.InnerAudioContext | undefined,
  audioFile: "",
  expiry: undefined as ReturnType<typeof setTimeout> | undefined,
  stopSessionWatch: undefined as (() => void) | undefined,
  onLoad(q) {
    this.entryId = scannedEntry(q);
    if (this.entryId) setDataMode("live");
  },
  async clearPlayback() {
    const player = this.player,
      path = this.audioFile;
    this.player = undefined;
    this.audioFile = "";
    player?.destroy();
    this.seeking = false;
    this.setData({
      playingClipId: "",
      position: 0,
      duration: 0,
      positionLabel: "00:00",
      durationLabel: "00:00",
    });
    if (path) await clearStoryAudio([path]);
  },
  onHide() {
    this.active = false;
    ++this.generation;
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = undefined;
    this.stopSessionWatch?.();
    this.stopSessionWatch = undefined;
    this.clearPhoto();
    this.setData({ entry: null, clips: [], busy: false, loadingClipId: "" });
    void this.clearPlayback().catch(() => {});
  },
  onUnload() {
    this.onHide();
  },
  accessExpired() {
    const expires = this.data.entry?.accessExpiresAt;
    return !!expires && Date.parse(expires) <= Date.now();
  },
  current(generation: number, owner: string) {
    return (
      this.active &&
      generation === this.generation &&
      dataMode() === "live" &&
      !!owner &&
      owner === sessionClient.context() &&
      !this.accessExpired()
    );
  },
  deny(status = "当前账号无权回听这本书的原声。") {
    this.clearPhoto();
    ++this.generation;
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = undefined;
    this.setData({
      entry: null,
      clips: [],
      loadingClipId: "",
      busy: false,
      loggedIn: !!sessionClient.context(),
      status,
    });
    void this.clearPlayback().catch(() => {});
  },
  denyFor(error: unknown) {
    this.deny(
      error instanceof ApiFailure && error.status === 401
        ? "登录已失效，请重新登录"
        : error instanceof ApiFailure && [403, 404].includes(error.status)
          ? undefined
          : error instanceof Error
            ? error.message
            : "原声暂不可用，请重新查询",
    );
  },
  watch(generation: number, owner: string) {
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = setTimeout(
      async () => {
        if (generation !== this.generation || !this.active) return;
        if (!this.current(generation, owner)) {
          this.deny("授权已到期或账号已变化，请重新登录或查询");
          return;
        }
        try {
          const current = await bookAudioClient.resolve(this.entryId);
          if (generation !== this.generation || !this.active) return;
          if (
            !this.current(generation, owner) ||
            current.accessEpoch !== this.data.entry?.accessEpoch
          ) {
            this.deny("资料用途或账号授权已变化，临时回听已清理，请重新查询");
            return;
          }
        } catch (error) {
          if (generation !== this.generation || !this.active) return;
          this.denyFor(error);
          return;
        }
        this.watch(generation, owner);
      },
      Math.max(
        1,
        Math.min(
          1000,
          this.data.entry?.accessExpiresAt
            ? Date.parse(this.data.entry.accessExpiresAt) - Date.now()
            : 1000,
        ),
      ),
    );
  },
  async onShow() {
    this.active = true;
    if (this.data.busy) return;
    this.stopSessionWatch?.();
    this.stopSessionWatch = sessionClient.onInvalidated(() =>
      this.deny("登录已失效，请重新登录"),
    );
    return this.refresh();
  },
  async refresh() {
    const generation = ++this.generation,
      owner = sessionClient.context();
    if (this.expiry) clearTimeout(this.expiry);
    this.clearPhoto();
    this.setData({
      entry: null,
      clips: [],
      loggedIn: !!owner,
      busy: true,
      status: "",
    });
    try {
      await this.clearPlayback();
      await clearStoryAudio();
      if (!this.entryId) {
        this.setData({ status: "原声入口无效，请重新扫码" });
        return;
      }
      if (!owner) {
        this.setData({ status: "请登录后回听书中原声" });
        return;
      }
      const entry = await bookAudioClient.resolve(this.entryId);
      if (!this.current(generation, owner)) return;
      if (
        entry.accessExpiresAt &&
        Date.parse(entry.accessExpiresAt) <= Date.now()
      ) {
        this.deny();
        return;
      }
      this.setData({
        entry,
        clips: entry.clips.map((clip) => ({
          ...clip,
          durationSeconds: clip.durationMs / 1000,
          durationLabel: audioTime(clip.durationMs / 1000),
        })),
      });
      void this.loadPhoto(entry, generation, owner);
      this.watch(generation, owner);
    } catch (error) {
      if (generation !== this.generation) return;
      this.denyFor(error);
    } finally {
      if (generation === this.generation)
        this.setData({ busy: false, loadingClipId: "" });
    }
  },
  clearPhoto() {
    void clearPhotoPreviews([this.data.image].filter(Boolean));
    this.setData({ image: "", photoLoading: false, photoError: "" });
  },
  async loadPhoto(
    entry: BookAudioEntryView,
    generation: number,
    owner: string,
  ) {
    if (!entry.photo) return;
    this.setData({ photoLoading: true });
    try {
      const image = await previewBookPhoto(entry.projectId, entry.photo, () =>
        this.current(generation, owner),
      );
      if (!this.current(generation, owner)) {
        await clearPhotoPreviews([image]);
        return;
      }
      this.setData({ image });
    } catch {
      if (this.current(generation, owner))
        this.setData({ photoError: "照片暂未加载" });
    } finally {
      if (this.current(generation, owner))
        this.setData({ photoLoading: false });
    }
  },
  login() {
    if (!this.data.busy && this.entryId) this.setData({ loginVisible: true });
  },
  closeLogin() {
    this.setData({ loginVisible: false });
  },
  loginSucceeded() {
    this.setData({ loginVisible: false, loggedIn: true });
    return this.refresh();
  },
  async logout() {
    this.deny("正在退出登录");
    this.setData({ busy: true, loggedIn: false });
    const generation = this.generation;
    const cleanup = clearStoryAudio().then(
      () => true,
      () => false,
    );
    let revoked = true;
    try {
      await sessionClient.logout();
    } catch {
      revoked = false;
    }
    const cleaned = await cleanup;
    if (generation === this.generation)
      this.setData({
        busy: false,
        loggedIn: !!sessionClient.context(),
        status: sessionClient.context()
          ? "退出登录尚未完成，请重试；当前原声已停止播放"
          : !cleaned
            ? "本机已退出，原声临时文件尚未清理，请重新查询重试"
            : !revoked
              ? "本机已退出，服务端撤销未确认；原会话将在到期后失效"
              : "已退出登录，临时原声已清理",
      });
  },
  terms() {
    go("terms");
  },
  toggle() {
    if (!this.player) return;
    if (this.data.paused) this.player.play();
    else this.player.pause();
    this.setData({ paused: !this.data.paused });
  },
  dragging(e: WechatMiniprogram.SliderChange) {
    if (!this.player) return;
    this.seeking = true;
    const position = Math.max(
      0,
      Math.min(this.data.duration, Number(e.detail.value)),
    );
    this.setData({ position, positionLabel: audioTime(position) });
  },
  seek(e: WechatMiniprogram.SliderChange) {
    if (!this.player) return;
    const position = Math.max(
      0,
      Math.min(this.data.duration, Number(e.detail.value)),
    );
    this.player.seek(position);
    this.seeking = false;
    this.setData({ position, positionLabel: audioTime(position) });
  },
  async play(e: PlayEvent) {
    if (this.data.busy || !this.data.entry) return;
    if (this.accessExpired()) {
      this.deny();
      return;
    }
    const generation = ++this.generation,
      owner = sessionClient.context(),
      clipId = e.currentTarget.dataset.id;
    this.watch(generation, owner);
    this.setData({ busy: true, status: "", loadingClipId: clipId });
    try {
      await this.clearPlayback();
      await clearStoryAudio();
      const entry = await bookAudioClient.resolve(this.entryId);
      if (!this.current(generation, owner)) return;
      const clip = entry.clips.find((c) => c.clipId === clipId);
      if (!clip) throw Error("该原声不在纸书版本中，请重新查询");
      this.setData({ entry });
      this.watch(generation, owner);
      const path = await privateAudioFile(
        clip,
        () =>
          sessionClient.downloadBookAudio(
            this.entryId,
            clipId,
            entry.accessEpoch,
          ),
        () => this.current(generation, owner),
      );
      if (!this.current(generation, owner)) {
        await clearStoryAudio([path]);
        return;
      }
      this.audioFile = path;
      const checked = await bookAudioClient.resolve(this.entryId);
      if (!this.current(generation, owner)) {
        // This response owns only its download, never a newer page's player/file.
        if (this.audioFile === path) this.audioFile = "";
        await clearStoryAudio([path]);
        return;
      }
      const confirmed = checked.clips.find((c) => c.clipId === clipId);
      if (
        checked.accessEpoch !== entry.accessEpoch ||
        !confirmed ||
        confirmed.assetId !== clip.assetId ||
        confirmed.sha256 !== clip.sha256 ||
        confirmed.bytes !== clip.bytes
      )
        throw new ApiFailure("STALE_AUDIO", 403);
      this.setData({ entry: checked });
      if (!this.data.image) void this.loadPhoto(checked, generation, owner);
      this.watch(generation, owner);
      if (this.accessExpired()) {
        this.deny();
        return;
      }
      const player = wx.createInnerAudioContext();
      this.player = player;
      const finish = () => {
        if (this.player === player)
          void this.clearPlayback().catch((error: unknown) =>
            this.setData({
              status: error instanceof Error ? error.message : "临时文件待清理",
            }),
          );
      };
      player.onEnded(finish);
      player.onError(() => {
        if (this.player === player) {
          finish();
          this.setData({ status: "原声播放失败，请重新下载" });
        }
      });
      const duration = clip.durationMs / 1000;
      player.onTimeUpdate(() => {
        if (this.player !== player || this.seeking) return;
        const total =
          Number.isFinite(player.duration) && player.duration > 0
            ? player.duration
            : duration;
        const position = Number.isFinite(player.currentTime)
          ? player.currentTime
          : 0;
        this.setData({
          position,
          duration: total,
          positionLabel: audioTime(position),
          durationLabel: audioTime(total),
        });
      });
      this.setData({
        paused: false,
        position: 0,
        positionLabel: "00:00",
        duration,
        durationLabel: audioTime(duration),
      });
      player.src = path;
      this.setData({ playingClipId: clipId });
      player.play();
    } catch (error) {
      if (generation !== this.generation) return;
      this.denyFor(error);
    } finally {
      if (generation === this.generation)
        this.setData({ busy: false, loadingClipId: "" });
    }
  },
  async stop() {
    ++this.generation;
    this.setData({ busy: false });
    try {
      await this.clearPlayback();
    } catch (error) {
      this.setData({
        status: error instanceof Error ? error.message : "临时文件待清理",
      });
    }
    const owner = sessionClient.context();
    if (this.active && this.data.entry && owner)
      this.watch(this.generation, owner);
  },
});
