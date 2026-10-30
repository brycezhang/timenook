import type { ProbeSnapshot } from "../../packages/contracts/src/audio-probe";

export type InterviewStep =
  "choose" | "prepare" | "record" | "review" | "processing" | "followup";
const steps: Record<InterviewStep, { number: number; title: string }> = {
  choose: { number: 1, title: "这一段想讲什么" },
  prepare: { number: 2, title: "准备开讲" },
  record: { number: 3, title: "慢慢说，我们听着" },
  review: { number: 4, title: "听一听，再留下这段讲述" },
  processing: { number: 5, title: "这段声音，留下来了" },
  followup: { number: 6, title: "还想听你说说" },
};
export function flowView(flowStep: InterviewStep) {
  return {
    flowStep,
    stepNumber: steps[flowStep].number,
    stepTitle: steps[flowStep].title,
  };
}
export function savedRecordingStep(
  snapshot: ProbeSnapshot,
  hasSealedRemote = false,
): InterviewStep {
  if (
    ["requesting", "recording", "paused", "saving", "device-error"].includes(
      snapshot.stage,
    )
  )
    return "record";
  if (
    ["uploading", "sealing", "sealed", "upload-error", "seal-error"].includes(
      snapshot.stage,
    )
  )
    return "processing";
  if (snapshot.clips.some((clip) => !clip.sealed)) return "review";
  if (snapshot.clips.length || hasSealedRemote) return "processing";
  return "prepare";
}
