import type { ProductionTaskState } from "./tasks";
export interface OptionalFollowupView {
  interviewId: string;
  actualQuestionId?: string;
  questionVersion?: number;
  planRevision?: number;
  canFinish: boolean;
  finishReason?: string | null;
  usage: number;
  latencyMs?: number | null;
  task: {
    id: string;
    kind: "ask_followup";
    state: ProductionTaskState;
    errorCode: string | null;
  } | null;
  result: {
    action: "ask" | "finish";
    question: string | null;
    intent: string | null;
    sourceRefs: string[];
    reasonCode: string;
  } | null;
}
