export type ProductionTaskState =
  | "waiting_inputs"
  | "obsolete"
  | "queued"
  | "submitting"
  | "waiting_provider"
  | "succeeded"
  | "no_speech"
  | "failed"
  | "manual_review"
  | "invalidated";
export interface ProductionTaskView {
  id: string;
  projectId: string;
  clipId: string | null;
  kind: "transcribe_audio" | "compose_story" | "ask_followup" | "render_book";
  state: ProductionTaskState;
  inputHash: string;
  queuedAt: string;
  deadline: string | null;
  providerRequestId: string;
  configurationVersion: string;
  providerCode: string | null;
  errorCode: string | null;
  retryable: boolean;
  nextAction:
    | "record_again"
    | "retry"
    | "contact_support"
    | "continue"
    | "leave_and_return";
  submittedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  recordingUsageMs: number;
  originalTranscript?: {
    text: string;
    sha256: string;
    inputHash: string;
  } | null;
  attempts: {
    requestId: string;
    number: number;
    state: string;
    providerCode: string | null;
    polls: number;
    reservedCostFen: number;
    actualCostFen: number | null;
    usage?: Record<string, number> | null;
    model?: string | null;
    failure?: string | null;
    observations: {
      action: string;
      state: string;
      providerCode: string | null;
      superseded: boolean;
      observedAt: string;
    }[];
  }[];
}
