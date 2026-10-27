export * from "./admin";

export interface ApiResponse<T> {
  data: T;
  meta: { requestId: string };
}

export interface ApiErrorResponse {
  error: { code: string; message: string; retryable: boolean };
  meta: { requestId: string };
}

export interface LoginCommand {
  code: string;
}
export interface Account {
  id: string;
}
export interface LoginResult {
  user: Account;
  session: { id: string; token: string; expiresAt: string };
}

export interface HealthStatus {
  status: "ok" | "ready";
  service: "timenook-api";
  version: string;
}

export interface PlanQuestion {
  key: string;
  text: string;
  intent: string;
  optionalContext: string[];
  sensitivityTags: string[];
  followupCandidates: string[];
  locale: "zh-CN";
}

export interface PlanChapter {
  key: string;
  title: string;
  questions: PlanQuestion[];
}

export interface PlanContent {
  chapters: PlanChapter[];
  starters: {
    kind: "photo" | "free-narration";
    text: string;
    intent: string;
  }[];
}

export interface TemplateReference {
  id: string;
  version: number;
  contentHash: string;
  reviewStatus: "unreviewed-test-only";
}

export interface ProjectPlanRevision extends PlanContent {
  projectId: string;
  revision: number;
  createdBy: string;
  sourceTemplate: TemplateReference;
  contentHash: string;
}

export interface ProjectPlan extends ProjectPlanRevision {
  preferences: { version: number; blockedTopics: string[] };
}

export * from "./audio-probe";

export * from "./catalog";
export * from "./payments";
export * from "./participation";

export interface PlanQuestionState {
  questionKey: string;
  state: "ready" | "later" | "skipped" | "not-applicable";
}
export interface PlanPreferenceDecision {
  version: number;
  subjectId: string;
  operatorUserId: string;
  method: "self_wechat" | "assisted";
  assistedSessionId: string | null;
  blockedTopics: string[];
  questionStates: PlanQuestionState[];
  createdAt: string;
}
export interface PersonalPlan extends ProjectPlan {
  subjectDecision: "self" | "assisted" | null;
  decisionSessionId: string | null;
  actualQuestions: ActualPlanQuestion[];
  questionStates: PlanQuestionState[];
  preferenceHistory: PlanPreferenceDecision[];
  accessExpiresAt: string | null;
}

// T14 owns recording/answer creation; this immutable reference survives plan edits.
export interface ActualPlanQuestion {
  id: string;
  projectId: string;
  planRevision: number;
  capturedBy: string;
  questionKey: string | null;
  starterKind: "photo" | "free-narration" | null;
  snapshot:
    | PlanQuestion
    | PlanContent["starters"][number]
    | { text: string; intent: string };
  source?: {
    kind: "plan" | "photo" | "free-narration" | "self-written" | "follow-up";
    rewritesQuestionKey?: string;
    generationTaskId?: string;
    original?: PlanQuestion | Record<string, unknown>;
  };
  answerRef: string | null;
}

// Book freezes this independent token; future-question edits do not change it.
export interface PlanDirectory {
  version: number;
  contentHash: string;
  chapters: { key: string; title: string; storyRefs: string[] }[];
}
export * from "./recording";
export * from "./photos";
export * from "./tasks";

export * from "./stories";

export * from "./followups";
export * from "./books";

export * from "./fulfillment";
export * from "./exports";
export * from "./refunds";
