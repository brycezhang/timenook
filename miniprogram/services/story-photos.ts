import type { StoryPhoto, ProbeUploadForm } from "../../packages/contracts/src";
import { paymentKey } from "./payments";
import { sessionClient, ApiFailure } from "./session";
import { recordingId } from "./local-audio-recorder";
import { API_BASE_URL } from "../config";
export type LocalPhoto = {
  clientPhotoId: string;
  path: string;
  bytes: number;
  sha256: string;
  state:
    | "saving"
    | "save-error"
    | "local"
    | "uploading"
    | "verifying"
    | "sealed"
    | "failed";
  message: string;
  serverId?: string;
  lowResolution?: boolean;
  released?: boolean;
};
type Pending = {
  clientPhotoId: string;
  tempFilePath: string;
  savedPath?: string;
};
/** Stable account/project/interview file ownership, independent of page lifetime. */
export class PhotoFiles {
  private static owners = new Map<string, PhotoFiles>();
  static open(projectId: string, interviewId: string) {
    const account = sessionClient.context().split(":")[0];
    if (!account) throw Error("请先登录");
    const appId = wx.getAccountInfoSync?.().miniProgram.appId ?? "";
    const key = `timenook.photos.v1:${API_BASE_URL}:${appId}:${account}:${projectId}:${interviewId}`;
    let owner = this.owners.get(key);
    if (!owner) {
      owner = new PhotoFiles(key, projectId, interviewId);
      this.owners.set(key, owner);
    }
    return owner;
  }
  private items: LocalPhoto[] = [];
  private pending = new Map<string, Pending>();
  private saving = new Set<string>();
  private uploading = new Set<string>();
  private listener?: (photos: LocalPhoto[]) => void;
  private constructor(
    private key: string,
    readonly projectId: string,
    readonly interviewId: string,
  ) {
    const stored = this.stored();
    this.items = stored.map((p) => ({
      ...p,
      state: p.state === "sealed" ? "sealed" : "local",
      message: p.state === "sealed" ? "封存已确认" : "本机照片已保存，尚待封存",
    }));
  }
  snapshot() {
    return this.items.map((p) => ({ ...p }));
  }
  subscribe(listener: (photos: LocalPhoto[]) => void) {
    this.listener = listener;
    this.emit();
  }
  unsubscribe() {
    this.listener = undefined;
  }
  private emit() {
    this.listener?.(this.snapshot());
  }
  private stored(): LocalPhoto[] {
    const value: unknown = wx.getStorageSync(this.key);
    return Array.isArray(value)
      ? value.filter(
          (p): p is LocalPhoto =>
            p &&
            typeof p.path === "string" &&
            /^[0-9a-f-]{36}$/.test(p.clientPhotoId) &&
            /^[a-f0-9]{64}$/.test(p.sha256) &&
            Number.isSafeInteger(p.bytes) &&
            p.bytes > 0 &&
            p.bytes <= 16777216,
        )
      : [];
  }
  private commit(photo: LocalPhoto) {
    const stored = this.stored(),
      existing = stored.find((p) => p.clientPhotoId === photo.clientPhotoId);
    if (
      existing &&
      (existing.path !== photo.path ||
        existing.bytes !== photo.bytes ||
        existing.sha256 !== photo.sha256 ||
        (existing.serverId &&
          photo.serverId &&
          existing.serverId !== photo.serverId))
    )
      throw Error("照片身份不匹配");
    const merged = {
      ...existing,
      ...photo,
      ...(existing?.serverId ? { serverId: existing.serverId } : {}),
      ...(existing?.state === "sealed" ? { state: "sealed" as const } : {}),
    };
    const entries = existing
      ? stored.map((p) =>
          p.clientPhotoId === photo.clientPhotoId ? merged : p,
        )
      : [...stored, merged];
    wx.setStorageSync(this.key, entries);
    const i = this.items.findIndex(
      (p) => p.clientPhotoId === photo.clientPhotoId,
    );
    if (i >= 0) Object.assign(this.items[i], merged);
    else this.items.push(merged);
    this.emit();
  }
  async add(files: { tempFilePath: string }[]) {
    for (const file of files) {
      const id = recordingId();
      this.pending.set(id, { clientPhotoId: id, ...file });
      this.items.push({
        clientPhotoId: id,
        path: "",
        bytes: 0,
        sha256: "",
        state: "saving",
        message: "正在保存本机原文件，请先别退出",
      });
      this.emit();
      await this.retrySave(id);
    }
  }
  async retrySave(id: string) {
    const pending = this.pending.get(id);
    if (!pending || this.saving.has(id)) return;
    this.saving.add(id);
    const item = this.items.find((p) => p.clientPhotoId === id)!;
    item.state = "saving";
    item.message = "正在保存文件和清单，请先别退出";
    this.emit();
    try {
      pending.savedPath ??= await new Promise<string>((resolve, reject) =>
        wx.getFileSystemManager().saveFile({
          tempFilePath: pending.tempFilePath,
          success: (r) => resolve(r.savedFilePath),
          fail: reject,
        }),
      );
      const info =
        await new Promise<WechatMiniprogram.GetFileInfoSuccessCallbackResult>(
          (resolve, reject) =>
            wx.getFileSystemManager().getFileInfo({
              filePath: pending.savedPath!,
              digestAlgorithm: "sha256",
              success: resolve,
              fail: reject,
            }),
        );
      if (
        info.size < 1 ||
        info.size > 16777216 ||
        !/^[a-f0-9]{64}$/.test(info.digest)
      )
        throw Error("照片过大或文件不可读");
      this.commit({
        ...item,
        path: pending.savedPath,
        bytes: info.size,
        sha256: info.digest,
        state: "local",
        message: "本机原文件和清单已保存，尚未封存",
      });
      this.pending.delete(id);
    } catch {
      item.state = "save-error";
      item.message = "本机清单或文件未保存成功，请先别退出，可单独重试";
      this.emit();
    } finally {
      this.saving.delete(id);
    }
  }
  async upload(id: string, assistedSessionId?: string) {
    const item = this.items.find((p) => p.clientPhotoId === id);
    if (
      !item ||
      item.released ||
      !item.path ||
      !item.sha256 ||
      this.pending.has(id) ||
      this.uploading.has(id)
    )
      return;
    this.uploading.add(id);
    const context = sessionClient.context(),
      check = () => {
        if (context !== sessionClient.context())
          throw Error("账号已变化，请重新查询");
      };
    const base = `/projects/${this.projectId}/interviews/${this.interviewId}/photos`,
      body = assistedSessionId ? { assistedSessionId } : {};
    const matches = (remote: StoryPhoto) => {
      if (
        remote.clientPhotoId !== id ||
        remote.projectId !== this.projectId ||
        remote.interviewId !== this.interviewId ||
        remote.sha256 !== item.sha256 ||
        remote.bytes !== item.bytes
      )
        throw Error("照片上传结果不匹配");
    };
    try {
      check();
      item.state = "uploading";
      item.message = "正在逐图上传，本机原文件仍保留";
      this.emit();
      await new Promise<void>((resolve, reject) =>
        wx
          .getFileSystemManager()
          .access({ path: item.path, success: () => resolve(), fail: reject }),
      );
      let result = item.serverId
        ? await sessionClient.request<StoryPhoto>(
            `${base}/${item.serverId}/status`,
            { key: paymentKey(), data: body },
          )
        : await sessionClient.request<StoryPhoto>(base, {
            key: id,
            data: {
              ...body,
              clientPhotoId: id,
              bytes: item.bytes,
              sha256: item.sha256,
            },
          });
      check();
      matches(result);
      item.serverId = result.id;
      this.commit(item);
      if (result.state === "released")
        throw Error("预留已取消，请选择新的原文件");
      if (result.state !== "sealed") {
        const form = await sessionClient.request<ProbeUploadForm>(
          `${base}/${result.id}/upload`,
          { key: paymentKey(), data: body },
        );
        check();
        await sessionClient.uploadPhoto(form, item.path);
        check();
        item.state = "verifying";
        item.message = "上传完成，正在校验方向与图片产物；尚未封存";
        this.emit();
        result = await sessionClient.request<StoryPhoto>(
          `${base}/${result.id}/seal`,
          { key: paymentKey(), data: body },
        );
        check();
        matches(result);
      }
      if (result.state !== "sealed" || result.assets.length < 3)
        throw Error("封存未确认");
      this.commit({
        ...item,
        state: "sealed",
        lowResolution: result.lowResolution === true,
        message: result.lowResolution
          ? "已封存；清晰度较低，只作提示，不会编造图像"
          : "已封存；原图与处理图分别保存",
      });
    } catch (error) {
      item.state = "failed";
      item.message =
        "封存未确认，原文件仍在；可单独重试。不支持的格式请取消预留后另选JPEG或PNG";
      this.emit();
      throw error;
    } finally {
      this.uploading.delete(id);
    }
  }

  async release(id: string, assistedSessionId?: string) {
    const item = this.items.find((p) => p.clientPhotoId === id);
    if (!item?.serverId || item.state === "sealed" || this.uploading.has(id))
      return;
    const context = sessionClient.context();
    const result = await sessionClient.request<StoryPhoto>(
      `/projects/${this.projectId}/interviews/${this.interviewId}/photos/${item.serverId}/release`,
      {
        key: paymentKey(),
        data: assistedSessionId ? { assistedSessionId } : {},
      },
    );
    if (
      context !== sessionClient.context() ||
      result.clientPhotoId !== id ||
      result.state !== "released"
    )
      throw Error("取消预留未确认");
    this.commit({
      ...item,
      released: true,
      state: "failed",
      message: "预留已取消；本机原文件仍保留，请另选支持的照片",
    });
  }
}

const previewCacheKey = `timenook.photo-previews.v1:${API_BASE_URL}`;
const unregisteredPreviews = new Set<string>();
function previewPaths(): string[] {
  const value: unknown = wx.getStorageSync(previewCacheKey);
  return [
    ...new Set([
      ...(Array.isArray(value)
        ? value.filter((p): p is string => typeof p === "string")
        : []),
      ...unregisteredPreviews,
    ]),
  ];
}
export async function clearPhotoPreviews(only?: string[]) {
  const paths = only ?? previewPaths(),
    removed = new Set<string>();
  for (const path of paths)
    try {
      await new Promise<void>((resolve, reject) =>
        wx
          .getFileSystemManager()
          .unlink({ filePath: path, success: () => resolve(), fail: reject }),
      );
      removed.add(path);
      unregisteredPreviews.delete(path);
    } catch {}
  wx.setStorageSync(
    previewCacheKey,
    previewPaths().filter((path) => !removed.has(path)),
  );
  if (paths.some((path) => !removed.has(path)))
    throw Error("临时预览尚未清理，请重试");
}
export async function privatePhotoPreview(
  projectId: string,
  interviewId: string,
  photoId: string,
  asset: { id: string; bytes: number; sha256: string },
  current: () => boolean,
) {
  await clearPhotoPreviews();
  if (!current()) throw Error("预览已取消");
  const context = sessionClient.context();
  const result = await sessionClient.downloadPhoto(
    projectId,
    interviewId,
    photoId,
    asset.id,
  );
  if (result.tempFilePath) unregisteredPreviews.add(result.tempFilePath);
  const denied = [401, 403].includes(result.statusCode)
    ? new ApiFailure(
        result.statusCode === 401 ? "UNAUTHENTICATED" : "FORBIDDEN",
        result.statusCode,
      )
    : null;
  try {
    // Revocation must reach the page even if device bookkeeping is unavailable.
    if (denied) throw denied;
    if (result.tempFilePath) {
      wx.setStorageSync(previewCacheKey, previewPaths());
      unregisteredPreviews.delete(result.tempFilePath);
    }
    if (
      result.statusCode !== 200 ||
      !result.tempFilePath ||
      context !== sessionClient.context() ||
      !current()
    )
      throw Error("预览未获授权或已取消");
    const info =
      await new Promise<WechatMiniprogram.GetFileInfoSuccessCallbackResult>(
        (resolve, reject) =>
          wx.getFileSystemManager().getFileInfo({
            filePath: result.tempFilePath,
            digestAlgorithm: "sha256",
            success: resolve,
            fail: reject,
          }),
      );
    if (
      info.size !== asset.bytes ||
      info.digest !== asset.sha256 ||
      context !== sessionClient.context() ||
      !current()
    )
      throw Error("预览校验未通过");
    return result.tempFilePath;
  } catch (error) {
    try {
      if (result.tempFilePath) await clearPhotoPreviews([result.tempFilePath]);
    } catch (cleanupError) {
      if (!denied) throw cleanupError;
    }
    throw denied ?? error;
  }
}
