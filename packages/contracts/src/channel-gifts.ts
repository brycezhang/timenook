/** A manually confirmed external purchase; amounts are fen and null means not supplied. */
export interface CreateChannelGiftCommand {
  buyerPhone: string;
  externalOrderNo?: string;
  paidAmount?: number;
  paidAt?: string;
}
export interface ChannelGiftView {
  id: string;
  internalNumber: string;
  packageTitle: string;
  listAmount: number;
  paidAmount: number | null;
  paidAt: string | null;
  createdAt: string;
  state: "active" | "void";
  projectId: string | null;
  orderId: string | null;
}
export interface AdminChannelGiftView extends ChannelGiftView {
  buyerPhone: string;
  maskedBuyerPhone: string;
  buyerId: string | null;
  operatorId: string;
  operatorName: string;
  externalOrderNo: string | null;
  associatedAt: string | null;
}
export interface ActivateChannelGiftCommand {
  purchaseKind: "self" | "gift";
  recipient: { typeCode?: string; relationshipLabel?: string };
  bookTitle: string;
}
export interface ActivatedChannelGift {
  id: string;
  projectId: string;
  orderId: string;
  entitlementId: string;
  purchaseKind: "self" | "gift";
  paidAmount: number | null;
}
export interface ChannelGiftReminders {
  newGiftIds: string[];
  newCount: number;
  pendingCount: number;
}
