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
  consent: ConsentDecisionView[];
  canCollect: boolean;
  canProcessAi: boolean;
  canRead: boolean;
  careAvailable: boolean;
}
export interface ConsentDecisionView {
  subjectId: string;
  operatorUserId: string;
  purpose: ConsentPurpose;
  granted: boolean;
  noticeVersion: string;
  method: string;
  evidenceRef: string;
  bindingVersion: number;
  accessEpoch: number;
  createdAt: string;
}
export interface CareBindingChangeView {
  subjectId: string;
  sourceBindingVersion: number;
  bindingVersion: number;
  accessEpoch: number;
  operatorId: string;
  supportCaseId: string | null;
  noticeVersion: string;
  method: string;
  evidenceRef: string;
  requestId: string;
  createdAt: string;
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
  createdAt: string;
  supportCaseRef?: string;
  changes?: CareBindingChangeView[];
}
export interface ProjectCareRequestView {
  id: string;
  kind: "rebind";
  state: "open" | "completed";
  createdAt: string;
}
