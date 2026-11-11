export interface GiftPreview {
  state: "unclaimed" | "claimed";
  bookTitle: string;
  recipientName: string;
  maskedPhone: string;
}

/** Full recipient phone and recoverable current card are purchaser-only. */
export interface OwnedGift extends GiftPreview {
  projectId: string;
  recipientPhone: string;
  version: number;
  token: string;
}

export interface GiftSetup {
  projectId: string;
  bookTitle: string;
  recipientName: string;
  gift: OwnedGift | null;
}

export interface GiftVerification {
  state: "ready" | "mismatch" | "claimed";
  gift: GiftPreview;
  currentMaskedPhone: string | null;
  /** Present only for the authenticated original claimant. */
  projectId?: string;
}
