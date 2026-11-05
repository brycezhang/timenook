/** S0 only. These identities and clips are unrelated to product accounts/projects. */
export interface ProbeSession {
  id: string;
  token: string;
  expiresAt: string;
}
export interface ProbeClipCommand {
  clientClipId: string;
  bytes: number;
  sha256: string;
}
export type ProbeStorage = "local-simulator" | "oss";
export type ProbeClipState = "pending" | "sealed";
export interface ProbeClip {
  id: string;
  clientClipId: string;
  state: ProbeClipState;
  storage: ProbeStorage;
  bytes: number;
  sha256: string;
  durationMs: number | null;
}
/** PostObject-shaped simulator form; this is NOT a real OSS signature. */
export interface ProbeUploadForm {
  url: string;
  fields: Record<string, string>;
  expiresAt: string;
  storage: ProbeStorage;
}
export type ProbeDeviceStage =
  | "idle"
  | "requesting"
  | "recording"
  | "paused"
  | "saving"
  | "device-error"
  | "local"
  | "uploading"
  | "upload-error"
  | "sealing"
  | "seal-error"
  | "sealed";
export interface ProbeLocalClip {
  clientClipId: string;
  actualQuestionId?: string;
  path: string;
  durationMs: number;
  bytes: number;
  sha256: string;
  serverId?: string;
  sealed?: boolean;
}
export interface ProbeSnapshot {
  hasPendingSave: boolean;
  stage: ProbeDeviceStage;
  message: string;
  clips: ProbeLocalClip[];
}
