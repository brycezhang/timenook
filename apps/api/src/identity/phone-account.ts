import { associateChannelGiftsIn } from "../channel-gifts/record";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { Account } from "@timenook/contracts";

export function accountView(user: {
  id: string;
  nickname: string | null;
  phoneNumber: string | null;
}): Account {
  return {
    id: user.id,
    nickname: user.nickname,
    maskedPhone: user.phoneNumber
      ? user.phoneNumber.slice(3, 6) + "****" + user.phoneNumber.slice(-4)
      : null,
  };
}

/** Web MVP accepts mainland numbers; only verified proofs reach account lookup. */
export function mainlandPhone(value: string): string {
  const phone = value.trim().replace(/^(?:\+86|86)(?=1\d{10}$)/, "");
  if (!/^1[3-9]\d{9}$/.test(phone)) throw new BadRequestException();
  return `+86${phone}`;
}

export async function phoneAccountIn(
  tx: Prisma.TransactionClient,
  phoneNumber: string,
  wechat?: { appId: string; openId: string },
) {
  if (wechat)
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([wechat.appId, wechat.openId])}, 0))`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`phone:${phoneNumber}`}, 0))`;
  const owner = await tx.user.findUnique({ where: { phoneNumber } });
  const identity = wechat
    ? await tx.wechatIdentity.findUnique({
        where: { appId_openId: wechat },
        include: { user: true },
      })
    : null;
  if (
    identity &&
    ((owner && owner.id !== identity.userId) ||
      (identity.user.phoneNumber && identity.user.phoneNumber !== phoneNumber))
  )
    throw new ConflictException("Phone account ownership conflicts");
  const user =
    owner ??
    (identity
      ? await tx.user.update({
          where: { id: identity.userId },
          data: { phoneNumber },
        })
      : await tx.user.create({
          data: {
            id: randomUUID(),
            phoneNumber,
            nickname: `用户${phoneNumber.slice(-4)}`,
          },
        }));
  await associateChannelGiftsIn(tx, phoneNumber, user.id);
  if (wechat && !identity)
    await tx.wechatIdentity.create({ data: { ...wechat, userId: user.id } });
  if (user.nickname === null) {
    await tx.user.updateMany({
      where: { id: user.id, nickname: null },
      data: { nickname: `用户${phoneNumber.slice(-4)}` },
    });
    return tx.user.findUniqueOrThrow({ where: { id: user.id } });
  }
  return user;
}
