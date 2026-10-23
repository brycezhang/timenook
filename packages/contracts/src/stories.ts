export interface StorySourceView {
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
export interface StoryRevisionView {
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
