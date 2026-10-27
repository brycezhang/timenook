import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { PrivacyJournal } from "../src/privacy-journal/privacy-journal";
import { privacyAuthorityId } from "../src/care/privacy-rights";
import type { ApiConfig } from "../src/config";
/** Explicit bootstrap at an isolated fixture boundary; runtime never initializes a source. */
export async function bootPrivacyFixture(config: ApiConfig) {
  if (config.privacyJournal) return;
  const root = join(tmpdir(), `timenook-privacy-${randomUUID()}`);
  const key = randomBytes(32).toString("base64");
  const db = new PrismaClient({ datasourceUrl: config.databaseUrl });
  try {
    const [state] = await db.$queryRaw<
      { database_id: string }[]
    >`SELECT database_id FROM privacy_recovery_state WHERE singleton`;
    await PrivacyJournal.bootstrap(
      { root, key },
      { databaseId: privacyAuthorityId(config.databaseUrl, state.database_id) },
    );
    config.privacyJournal = { root, key };
  } finally {
    await db.$disconnect();
  }
}
export async function closePrivacyFixture(config: ApiConfig) {
  if (config?.privacyJournal)
    await rm(config.privacyJournal.root, { recursive: true, force: true });
}
