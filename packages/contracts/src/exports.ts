export interface CompleteExportView {
  id: string;
  projectId: string;
  state:
    | "requested"
    | "accepted"
    | "packing"
    | "ready"
    | "failed"
    | "revoked"
    | "delivered";
  recipientUserId: string | null;
  recipient: "self" | "initiator" | "verified_alternative";
  requestedAt: string;
  acceptedAt: string | null;
  dueAt: string | null;
  ownerId: string | null;
  readyAt: string | null;
  expiresAt: string | null;
  sha256: string | null;
  bytes: number | null;
  missingReason: string | null;
  canDownload: boolean;
  deliveredAt: string | null;
  staffAccess?: {
    id: string | null;
    available: boolean;
    expiresAt: string | null;
    purpose: string;
    identityProcedureRef: string;
    confirmationChannelRef: string;
    bindingVersion: number;
    accessEpoch: number;
  };
}
export interface CompleteExportContext {
  projectId: string;
  canRequest: boolean;
  amountDueFen: 0;
  requestWindow: {
    state: string;
    startsAt: string | null;
    expiresAt: string | null;
  };
  service: {
    within: number;
    unit: "business_days";
    ownerRef: string;
    calendarRef: string;
  };
  accessEpoch: number;
  requests: CompleteExportView[];
}
