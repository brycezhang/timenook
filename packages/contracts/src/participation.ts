export const CONSENT_PURPOSES = ["collection", "ai", "sharing"] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];
export interface InvitationView {
  inviter: string;
  process: string[];
  purposes: ConsentPurpose[];
  noticeVersion: string;
  policyStatus: "synthetic-only" | "pending";
  choice: string;
}
export interface ParticipationState {
  projectId: string;
  subjectId: string;
  role: "narrator" | "initiator";
  bindingVersion: number;
  accessEpoch: number;
  noticeVersion: string;
  policyStatus: "synthetic-only" | "pending";
  choices: { purpose: ConsentPurpose; granted: boolean | null }[];
  canCollect: boolean;
  canProcessAi: boolean;
  canRead: boolean;
  careAvailable: boolean;
}
export interface BindingApplication {
  id: string;
  applicantUserId: string;
  state: string;
}
export interface CareCase {
  id: string;
  projectId: string;
  requesterId: string;
  targetUserId: string;
  sourceBindingVersion: number;
  state: "open" | "completed";
  completedBy: string | null;
  kind: "rebind";
  supportCaseRef?: string;
  changes?: {
    sourceBindingVersion: number;
    bindingVersion: number;
    accessEpoch: number;
    evidenceRef: string;
    operatorId: string;
    requestId: string;
  }[];
}
