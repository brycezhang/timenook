import { createHash, randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { type ApiConfig, validateWebConfig } from "../config";

export const webDigest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

/** This operator-only capability is never registered as an HTTP controller. */
export async function provisionWebAccount(
  config: ApiConfig,
  command: "create" | "issue" | "revoke",
  input: Record<string, unknown>,
) {
  if (!config.web || !config.privacyJournal)
    throw new Error("Web provisioning is not configured");
  validateWebConfig(config.web);
  const db = new PrismaClient({ datasourceUrl: config.databaseUrl });
  try {
    if (command === "create") {
      if (Object.keys(input).length) throw new Error("Unexpected input");
      const user = await db.user.create({ data: { id: randomUUID() } });
      return { user: { id: user.id } };
    }
    if (command === "revoke") {
      if (
        Object.keys(input).length !== 1 ||
        typeof input.ticketId !== "string" ||
        !/^[0-9a-f-]{36}$/.test(input.ticketId)
      )
        throw new Error("Expected one ticket");
      await db.webLoginTicket.update({
        where: { id: input.ticketId },
        data: { revokedAt: new Date() },
      });
      return { revoked: true };
    }
    if (
      Object.keys(input).length !== 1 ||
      typeof input.userId !== "string" ||
      !/^[0-9a-f-]{36}$/.test(input.userId)
    )
      throw new Error("Expected one user");
    const token = randomBytes(32).toString("base64url");
    const ticket = await db.webLoginTicket.create({
      data: {
        id: randomUUID(),
        userId: input.userId,
        tokenHash: webDigest(token),
        expiresAt: new Date(Date.now() + config.web.loginTtlSeconds * 1000),
      },
    });
    const url = new URL("/app/login", config.web.origin);
    url.hash = new URLSearchParams({ ticket: token }).toString();
    return {
      ticket: { id: ticket.id, expiresAt: ticket.expiresAt.toISOString() },
      url: url.toString(),
    };
  } finally {
    await db.$disconnect();
  }
}
