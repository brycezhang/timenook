import type {
  RecordingClip,
  StorySourceView,
} from "../../packages/contracts/src";
import { API_BASE_URL } from "../config";
import { sessionClient, ApiFailure } from "./session";
const cacheKey = `timenook.story-audio.v1:${API_BASE_URL}`;
const unregistered = new Set<string>();
function paths(): string[] {
  const stored: unknown = wx.getStorageSync(cacheKey);
  return [
    ...new Set([
      ...(Array.isArray(stored)
        ? stored.filter((p): p is string => typeof p === "string")
        : []),
      ...unregistered,
    ]),
  ];
}
/** Only downloaded temporary audio is registered here; original recording manifests are untouched. */
export async function clearStoryAudio(only?: string[]) {
  const pending = only ?? paths(),
    removed = new Set<string>();
  for (const path of pending) {
    try {
      await new Promise<void>((resolve, reject) =>
        wx.getFileSystemManager().unlink({
          filePath: path,
          success: () => resolve(),
          // WeChat FileError 1300002 confirms the file is already absent.
          fail: (error) =>
            error.errCode === 1300002 ? resolve() : reject(error),
        }),
      );
      removed.add(path);
      unregistered.delete(path);
    } catch {}
  }
  wx.setStorageSync(
    cacheKey,
    paths().filter((p) => !removed.has(p)),
  );
  if (pending.some((p) => !removed.has(p)))
    throw Error("原声临时文件尚未清理，请重试");
}
export async function privateStoryAudio(
  projectId: string,
  source: StorySourceView,
  current: () => boolean,
) {
  await clearStoryAudio();
  const context = sessionClient.context();
  if (!context || !current()) throw Error("回听已取消");
  const clip = await sessionClient.request<RecordingClip>(
    `/projects/${projectId}/interviews/${source.interviewId}/clips/${source.intentId}`,
  );
  if (
    !current() ||
    context !== sessionClient.context() ||
    clip.id !== source.intentId ||
    clip.projectId !== projectId ||
    clip.interviewId !== source.interviewId ||
    clip.actualQuestionId !== source.actualQuestionId ||
    clip.state !== "sealed" ||
    clip.asset?.id !== source.assetId ||
    clip.asset.sha256 !== source.inputHash ||
    clip.sealedInput?.id !== source.sealedInputId ||
    !Number.isSafeInteger(clip.asset.bytes) ||
    clip.asset.bytes < 1
  )
    throw Error("原声来源不匹配，请重新查询");
  const result = await sessionClient.downloadRecording(
    projectId,
    source.interviewId,
    source.intentId,
  );
  if (result.tempFilePath) {
    unregistered.add(result.tempFilePath);
  }
  const denied = [401, 403].includes(result.statusCode)
    ? new ApiFailure(
        result.statusCode === 401 ? "UNAUTHENTICATED" : "FORBIDDEN",
        result.statusCode,
      )
    : null;
  try {
    if (denied) throw denied;
    if (result.tempFilePath) {
      wx.setStorageSync(cacheKey, paths());
      unregistered.delete(result.tempFilePath);
    }
    if (
      result.statusCode !== 200 ||
      !result.tempFilePath ||
      context !== sessionClient.context() ||
      !current()
    )
      throw Error("回听未获授权或已取消");
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
      info.size !== clip.asset.bytes ||
      info.digest !== source.inputHash ||
      context !== sessionClient.context() ||
      !current()
    )
      throw Error("原声校验未通过");
    return result.tempFilePath;
  } catch (error) {
    try {
      if (result.tempFilePath) await clearStoryAudio([result.tempFilePath]);
    } catch (cleanup) {
      if (!denied) throw cleanup;
    }
    throw denied ?? error;
  }
}
