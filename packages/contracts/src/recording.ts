import type { ActualPlanQuestion, PlanQuestion, PlanContent } from "./index";
export interface RecordingClip {
  id: string;
  projectId: string;
  interviewId: string;
  actualQuestionId: string;
  clientClipId: string;
  bytes: number;
  sha256: string;
  state: "pending" | "sealed" | "released";
  durationMs: number | null;
  storage: "local-simulator" | "oss";
  asset: {
    storage?: "local-simulator" | "oss";
    id: string;
    sha256: string;
    bytes: number;
    mime: string;
  } | null;
  sealedInput: { id: string; kind: string } | null;
}
export interface RecordingInterview {
  id: string;
  projectId: string;
  subjectId: string;
  actualQuestion: ActualPlanQuestion;
  currentQuestion: ActualPlanQuestion;
  questionVersion: number;
  questionHistory?: {
    sequence: number;
    parentActualQuestionId: string | null;
    question: ActualPlanQuestion;
  }[];
  clips: {
    id: string;
    clientClipId: string;
    state: string;
    actualQuestionId: string;
  }[];
  usage: { reservedMs: number; consumedMs: number };
}
export interface RecordingContext {
  canRecord: boolean;
  interviews: RecordingInterview[];
  plan: {
    revision: number;
    defaultQuestion: PlanQuestion | null;
    eligibleQuestions: PlanQuestion[];
    starters: PlanContent["starters"];
  };
}
