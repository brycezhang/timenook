export const CONSENT_PURPOSES = ["collection", "ai", "sharing"] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];
export type GiftCategory = "sent" | "received" | "participating";
export interface ProjectMembership {
  projectId: string;
  bookTitle: string;
  state: "active";
  categories: GiftCategory[];
  isSelfGift: boolean;
  giftState: "unissued" | "unclaimed" | "claimed" | null;
  giverNickname: string;
  giftRelationship: string | null;
  storyCount: number;
}
export interface ProjectMemberProfile {
  projectId: string;
  userId: string;
  nickname: string;
  relationship: string | null;
  isNarrator: boolean;
}
export interface InvitationView {
  projectId?: string;
  bookTitle?: string;
  inviter: string;
  process: string[];
  purposes: ConsentPurpose[];
  noticeVersion: string;
  policyStatus:
    "synthetic-only" | "internal-acceptance" | "paid-e2e" | "pending";
  evidencePrefix?: string;
  noticeText?: string;
  source?: "paid" | "internal-acceptance";
  choice: string;
}
export interface ParticipationState {
  projectId: string;
  bookTitle?: string;
  subjectId: string;
  role: "member" | "narrator" | "initiator";
  canInvite?: boolean;
  bindingVersion: number;
  accessEpoch: number;
  noticeVersion: string;
  policyStatus:
    "synthetic-only" | "internal-acceptance" | "paid-e2e" | "pending";
  evidencePrefix?: string;
  noticeText?: string;
  source?: "paid" | "internal-acceptance";
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
  evidenceRef: string | null;
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
  evidenceRef: string | null;
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
    | "production_handoff"
    | "refund"
    | "quality";
  createdAt: string;
  supportCaseRef?: string;
  changes?: CareBindingChangeView[];
  verificationScope?: { accessSequence: number };
  verification?: {
    operatorAdminId: string;
    createdAt: string;
    evidenceRef: string | null;
    noticeVersion: string | null;
    method: string;
    accessEpoch: number | null;
    accessSequence: number | null;
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
    | "production_handoff"
    | "refund"
    | "quality";
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
  evidenceRef: string | null;
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
    reason:
      "self_wechat" | "self_web" | "assisted" | "care_verified" | "rebind";
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
