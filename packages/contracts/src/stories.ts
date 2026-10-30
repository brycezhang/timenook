export interface StorySourceView {
  durationMs?: number | null;
  intentId: string;
  clipId: string;
  interviewId: string;
  actualQuestionId: string;
  sequence: number;
  assetId: string;
  sealedInputId: string;
  inputHash: string;
  transcriptionTaskId: string;
  state: string;
  question?: object;
  transcript: {
    taskId: string;
    text: string;
    sha256: string;
    inputHash: string;
  } | null;
}
export interface StoryDecisionView {
  id: string;
  revisionId: string;
  contentHash: string;
  subjectId: string;
  operatorUserId: string;
  confirmed: boolean;
  allowInBook: boolean;
  method: string;
  noticeVersion: string;
  evidenceRef: string;
  assistedEvidenceId: string | null;
  createdAt: string;
}
export interface ProjectOverview {
  noticeVersion?: string;
  evidencePrefix?: string;
  noticeText?: string;
  policyStatus?: "internal-acceptance" | "synthetic-only" | "pending";
  source?: "paid" | "internal-acceptance";
  projectId: string;
  bookTitle: string;
  metadataVersion: number;
  subjectId: string;
  role: "narrator" | "initiator";
  canDecide: boolean;
  stories: StoryView[];
  tasks: import("./tasks").ProductionTaskView[];
  interviews: import("./recording").RecordingContext["interviews"];
  summary: { pending: number; confirmed: number; included: number };
  nextStep: string;
  accessExpiresAt: string | null;
}
export interface StoryRevisionView {
  baseRevisionId?: string | null;
  reviewResolutions?: { item: string; reason: string }[];
  notes?: { id: string; text: string }[];
  audioManifest?: StorySourceView[] | null;
  photoSnapshot?: import("./photos").PhotoMaterials | null;

  id: string;
  version: number;
  title: string;
  theme: string;
  paragraphs: { text: string; sourceRefs: string[] }[];
  reviewItems: string[];
  sourceManifest: StorySourceView[];
  contentHash: string;
  origin: "ai" | "participant";
}
export interface StoryView {
  appliedRevision?: { id: string; version: number; contentHash: string };
  decision?: StoryDecisionView | null;
  id: string;
  projectId: string;
  interviewId: string;
  version: number;
  currentRevisionId: string | null;
  revision: StoryRevisionView | null;
  usage: { organizations: number; regenerations: number };
  task: {
    id: string;
    kind: "compose_story";
    state: string;
    errorCode: string | null;
    queuedAt: string;
    userSubmittedAt: string;
    allSavedAt: string;
    dependenciesReadyAt: string | null;
    submittedAt: string | null;
    completedAt: string | null;
    failedAt: string | null;
    sources: StorySourceView[];
    attempts: object[];
  } | null;
}
export interface StoryContext {
  interviewId: string;
  clipCount: number;
  pendingCount: number;
  cloudSaved: boolean;
  story: StoryView | null;
}
