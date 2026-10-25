import type { PlanDirectory } from "./index";

export interface BookStory {
  id: string;
  revisionId: string;
  version: number;
  contentHash: string;
  title: string;
  paragraphs: string[];
  notes: { id: string; text: string }[];
  provenance: { origin: "ai" | "participant"; label: string };
  photos: {
    id: string;
    assetId: string;
    sha256: string;
    caption: string;
    width: number;
    height: number;
  }[];
  audio: {
    clipId: string;
    assetId: string;
    inputHash: string;
    sequence: number;
  }[];
  entry: { id: string; url: string; kind: "original-audio" } | null;
}
export interface BookSnapshot {
  schemaVersion: "t20-v1";
  cover: { title: string; template: string };
  plan: { revision: number; contentHash: string; content: object };
  directory: PlanDirectory;
  chapters: { key: string; title: string; stories: BookStory[] }[];
  specification: {
    version: string;
    widthMm: number;
    heightMm: number;
    bleedMm: number;
    productionReady: false;
    status: "synthetic-unfrozen";
  };
  provenance: { version: string; notice: string };
}
export interface BookVersionView {
  id: string;
  projectId: string;
  version: number;
  state: "queued" | "rendering" | "ready" | "failed" | "obsolete";
  inputHash: string;
  snapshotHash: string;
  snapshot: BookSnapshot;
  task: { id: string; state: string; errorCode: string | null };
  pageCount: number | null;
  pdf: { sha256: string; bytes: number } | null;
  toc: { title: string; page: number }[] | null;
  renderer: object | null;
  accessExpiresAt: string | null;
}
export interface BookContext {
  projectId: string;
  inputHash: string;
  directory: PlanDirectory;
  eligibleStories: {
    id: string;
    revisionId: string;
    version: number;
    contentHash: string;
    title: string;
  }[];
  current: BookVersionView | null;
  accessExpiresAt: string | null;
}
