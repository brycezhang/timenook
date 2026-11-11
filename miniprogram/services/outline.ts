import { interviewRecordingClient } from "./interview-recording";
import { recordingId } from "./local-audio-recorder";
import { paymentKey } from "./payments";
import { go } from "./store";
export async function startOutlineAnswer(
  projectId: string,
  revision: number,
  questionKey?: string,
) {
  const interview = await interviewRecordingClient.start(
    projectId,
    {
      clientInterviewId: recordingId(),
      expectedPlanRevision: revision,
      ...(questionKey
        ? { questionKey }
        : { starterKind: "free-narration" as const }),
    },
    paymentKey(),
  );
  go(
    "interview",
    `projectId=${projectId}&interviewId=${interview.id}&prepare=1`,
  );
}
