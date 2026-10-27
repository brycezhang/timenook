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
  operatorUserId: string | null;
  operatorAdminId?: string | null;
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
  withdrawal?: WithdrawalStatus;
  withdrawalPurpose?: ConsentPurpose | null;
  correctionGrant?: { storyId: string; expiresAt: string } | null;
  id: string;
  projectId: string;
  requesterId: string | null;
  requesterSubjectId: string | null;
  operatorId: string;
  operatorRealm: "product" | "admin";
  targetUserId: string | null;
  sourceBindingVersion: number;
  sourceAccessEpoch: number;
  state: "open" | "verified" | "completed";
  completedBy: string | null;
  kind:
    | "rebind"
    | "withdraw"
    | "export"
    | "delete"
    | "correction"
    | "first_copy_expiry"
    | "production_handoff"
    | "refund";
  createdAt: string;
  supportCaseRef?: string;
  changes?: CareBindingChangeView[];
  verification?: {
    operatorAdminId: string;
    createdAt: string;
    evidenceRef: string;
    noticeVersion: string;
    method: string;
    accessEpoch: number | null;
  } | null;
}
export interface ProjectCareRequestView {
  id: string;
  kind:
    | "rebind"
    | "withdraw"
    | "export"
    | "delete"
    | "correction"
    | "first_copy_expiry"
    | "production_handoff"
    | "refund";
  state: "open" | "verified" | "completed";
  createdAt: string;
}

export const ASSISTED_PURPOSES = [
  ...CONSENT_PURPOSES,
  "story_confirmation",
  "book_confirmation",
] as const;
export type AssistedPurpose = (typeof ASSISTED_PURPOSES)[number];
export interface AssistedSessionView {
  id: string;
  projectId: string;
  subjectId: string;
  operatorUserId: string;
  purpose: AssistedPurpose;
  granted: boolean;
  noticeVersion: string;
  evidenceRef: string;
  bindingVersion: number;
  accessEpoch: number;
  createdAt: string;
  expiresAt: string;
  state: "active" | "expired" | "revoked" | "rejected";
}

export interface WithdrawalStatus {
  projectId: string;
  accessEpoch: number;
  changes: {
    id: string;
    accessEpoch: number;
    purpose: ConsentPurpose | "all" | "binding";
    reason: "self_wechat" | "assisted" | "care_verified" | "rebind";
    applied: boolean;
    productionAction:
      | "not_required"
      | "not_started"
      | "stopped_before_handoff"
      | "supplier_pending"
      | "already_delivered"
      | null;
    createdAt: string;
  }[];
  production: {
    state: string;
    ownerAdminId: string;
    dueAt: string;
    caseId: string;
  } | null;
  boundary: string;
}
