export interface ApiResponse<T> {
  data: T;
  meta: { requestId: string };
}

export interface ApiErrorResponse {
  error: { code: string; message: string; retryable: boolean };
  meta: { requestId: string };
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
