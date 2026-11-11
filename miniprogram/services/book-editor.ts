import type { StoryView, BookPhoto } from "../../packages/contracts/src";
import { storyClient, type StoryRevisionInput } from "./stories";
import { recordingId } from "./local-audio-recorder";
import { paymentKey } from "./payments";
import { privatePhotoPreview } from "./story-photos";

export const storyBody = (s: StoryView) =>
  s.revision?.paragraphs.map((p) => p.text).join("\n\n") || "";
export function revisionInput(
  story: StoryView,
  title: string,
  body: string,
): StoryRevisionInput {
  const revision = story.revision;
  if (!revision || !title.trim() || !body.trim())
    throw new Error("请填写标题和正文");
  const notes = [...(revision.notes || [])];
  const paragraphs = body
    .trim()
    .split(/\n\s*\n/)
    .flatMap((text) => text.match(/[\s\S]{1,5000}/g) || [])
    .map((text) => {
      const original = revision.paragraphs.find((p) => p.text === text);
      if (original) return { text, sourceRefs: [...original.sourceRefs] };
      const id = recordingId();
      notes.push({ id, text });
      return { text, sourceRefs: [`note:${id}`] };
    });
  if (paragraphs.length > 200) throw new Error("正文过长，请分成多个故事保存");
  return {
    baseRevisionId: revision.id,
    expectedVersion: story.version,
    title: title.trim(),
    theme: revision.theme,
    paragraphs,
    notes: notes.filter((n) =>
      paragraphs.some((p) => p.sourceRefs.includes(`note:${n.id}`)),
    ),
    reviewResolutions: revision.reviewResolutions || [],
    photoSnapshotId: revision.photoSnapshot?.id ?? null,
    audioClipIds: (revision.audioManifest || revision.sourceManifest).map(
      (a) => a.clipId,
    ),
  };
}
export const saveStoryBody = (
  projectId: string,
  story: StoryView,
  title: string,
  body: string,
) =>
  storyClient.revise(
    projectId,
    story.id,
    revisionInput(story, title, body),
    paymentKey(),
  );
export const previewBookPhoto = (
  projectId: string,
  photo: BookPhoto,
  current: () => boolean,
) =>
  privatePhotoPreview(
    projectId,
    photo.id,
    { id: photo.assetId, sha256: photo.sha256, bytes: photo.bytes },
    current,
  );
export function markEditing(dirty: boolean) {
  if (dirty)
    wx.enableAlertBeforeUnload?.({ message: "修改还未保存，确定离开吗？" });
  else wx.disableAlertBeforeUnload?.();
}
