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
