import { NotFoundException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
/** All activation, correction and void commands lock this persistent row first. */
export async function lockChannelGiftIn(tx: Prisma.TransactionClient, id: string) {
  await tx.$queryRaw`SELECT id FROM channel_gifts WHERE id=${id}::uuid FOR UPDATE`;
  const gift = await tx.channelGift.findUnique({ where: { id } });
  if (!gift) throw new NotFoundException();
  return gift;
}
/** Caller holds the existing phone-account advisory lock. Never creates a user. */
export async function associateChannelGiftsIn(tx: Prisma.TransactionClient, phone: string, userId: string) {
  await tx.channelGift.updateMany({
    where: { buyerPhone: phone, buyerId: null, state: "active", projectId: null },
    data: { buyerId: userId, associatedAt: new Date() },
  });
}
