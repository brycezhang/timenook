import type { PlanDirectory } from "./index";

export interface BookPhoto {
  /** Product photo ID, used with the authenticated Media gateway. */
  id: string;
  interviewId: string;
  assetId: string;
  sha256: string;
  bytes: number;
  caption: string;
  width: number;
  height: number;
}
export interface BookCoverSettings {
  version: number;
  salutation: string;
  photoAssetId: string | null;
}
export interface BookStory {
  id: string;
  revisionId: string;
  version: number;
  contentHash: string;
  title: string;
  paragraphs: string[];
  notes: { id: string; text: string }[];
  provenance: { origin: "ai" | "participant"; label: string };
  photos: BookPhoto[];
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
  cover: {
    title: string;
    template: string;
    version: number;
    salutation: string;
    photo: BookPhoto | null;
  };
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
  /** Frozen book access follows bookPdf; source editing/generation expires separately. */
  accessExpiresAt: string | null;
  draftAccess: { allowed: boolean; expiresAt: string | null };
  /** Live access to the separate raw thumbnail; never part of the book snapshot. */
  coverPhotoAccess: { allowed: boolean; expiresAt: string | null };
}
export interface BookContext {
  projectId: string;
  inputHash: string | null;
  draftAccess: { allowed: boolean; expiresAt: string | null };
  /** Frozen current values (or empty defaults) when draftAccess is unavailable. */
  directory: PlanDirectory;
  cover: BookCoverSettings;
  coverPhotoOptions: BookPhoto[];
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

/** A stable printed locator reveals private metadata only after current authorization. */
export interface BookAudioEntryView {
  id: string;
  projectId: string;
  story: { id: string; revisionId: string; version: number; title: string };
  clips: {
    clipId: string;
    /** Zero-based position in the frozen book item, independent of recording counters. */
    sequence: number;
    assetId: string;
    sha256: string;
    bytes: number;
    durationMs: number;
  }[];
  accessEpoch: number;
  accessExpiresAt: string | null;
}
