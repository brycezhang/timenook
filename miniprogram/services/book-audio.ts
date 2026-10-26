import type { BookAudioEntryView } from "../../packages/contracts/src";
import { sessionClient } from "./session";
const uuid = (v: string) => /^[a-f0-9-]{36}$/.test(v);
export const validBookAudioEntry = (v: string) => /^[A-Za-z0-9_-]{22}$/.test(v);
export const bookAudioClient = {
  async resolve(id: string): Promise<BookAudioEntryView> {
    if (!validBookAudioEntry(id)) throw new Error("原声入口无效，请重新扫码");
    const value = await sessionClient.request<BookAudioEntryView>(
      `/book-audio/${id}`,
    );
    if (
      !value ||
      value.id !== id ||
      !uuid(value.projectId) ||
      !value.story ||
      !uuid(value.story.id) ||
      !uuid(value.story.revisionId) ||
      typeof value.story.title !== "string" ||
      !Number.isSafeInteger(value.story.version) ||
      value.story.version < 1 ||
      !Number.isSafeInteger(value.accessEpoch) ||
      value.accessEpoch < 0 ||
      (value.accessExpiresAt !== null &&
        !Number.isFinite(Date.parse(value.accessExpiresAt))) ||
      !Array.isArray(value.clips) ||
      !value.clips.length ||
      value.clips.some(
        (clip, index) =>
          !uuid(clip.clipId) ||
          !uuid(clip.assetId) ||
          !Number.isSafeInteger(clip.sequence) ||
          clip.sequence !== index ||
          (index > 0 && value.clips[index - 1].sequence >= clip.sequence) ||
          !Number.isSafeInteger(clip.bytes) ||
          clip.bytes < 1 ||
          !/^[a-f0-9]{64}$/.test(clip.sha256) ||
          !Number.isSafeInteger(clip.durationMs) ||
          clip.durationMs < 1,
      ) ||
      new Set(value.clips.map((clip) => clip.clipId)).size !==
        value.clips.length
    )
      throw new Error("原声清单无效，请重新查询");
    return value;
  },
};
