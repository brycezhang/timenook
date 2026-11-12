import type { StoryView } from "../../packages/contracts/src";

export function storySources(story: StoryView) {
  return story.task?.sources.length
    ? story.task.sources
    : (story.revision?.sourceManifest ?? []);
}
export function audioTime(seconds: number) {
  const total = Math.max(0, Math.floor(seconds)),
    hours = Math.floor(total / 3600);
  return `${hours ? hours + ":" : ""}${String(Math.floor(total / 60) % 60).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}
export function storyDuration(story: StoryView) {
  const duration = storySources(story).reduce(
    (sum, source) => sum + (source.durationMs || 0),
    0,
  );
  return duration ? audioTime(duration / 1000) : "";
}
export function storyDate(story: StoryView) {
  const date = story.task?.allSavedAt?.slice(0, 10);
  return date
    ? `${Number(date.slice(5, 7))} 月 ${Number(date.slice(8, 10))} 日`
    : "";
}
export function storyPlacement(story: StoryView) {
  return story.included === false
    ? "暂不入书"
    : story.chapter?.title || "未归章";
}
export function storyState(story: StoryView) {
  const state = story.task?.state;
  if (
    state === "waiting_inputs" &&
    story.task?.errorCode === "DEPENDENCY_FAILED"
  )
    return "failed";
  if (
    state &&
    ["waiting_inputs", "queued", "submitting", "waiting_provider"].includes(
      state,
    )
  )
    return "processing";
  if (
    state &&
    ["failed", "manual_review", "no_speech", "no_content"].includes(state)
  )
    return "failed";
  return story.revision ? "ready" : "saved";
}
