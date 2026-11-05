import { createHash, randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { type ApiConfig, validateWebConfig } from "../config";

export const webDigest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

// Session/Ticket dates are required by the shared identity contract. Internal
// acceptance uses this explicit no-timeout marker; revocation still applies.
export const PERSISTENT_WEB_EXPIRY = "9999-12-31T23:59:59.999Z";
export function webCredentialExpiry(config: ApiConfig, ttlSeconds: number) {
  return config.acceptance?.mode === "internal-acceptance"
    ? new Date(PERSISTENT_WEB_EXPIRY)
    : new Date(Date.now() + ttlSeconds * 1000);
}

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
        expiresAt: webCredentialExpiry(config, config.web.loginTtlSeconds),
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
