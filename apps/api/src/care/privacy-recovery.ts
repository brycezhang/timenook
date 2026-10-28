import { randomUUID } from "node:crypto";
import { PrivacyJournal } from "../privacy-journal/privacy-journal";
import type { ApiConfig } from "../config";
import { PrivacyRights, privacyAuthorityId } from "./privacy-rights";
/** Explicit operator recovery boundary. An ordinary API/worker never promotes itself. */
export async function recoverPrivacy(config: ApiConfig) {
  if (!config.privacyJournal)
    throw new Error("Independent privacy source is required");
  const reader = new PrivacyJournal(config.privacyJournal),
    initial = await reader.snapshot();
  const rights = new PrivacyRights(config);
  try {
    // A clone receives a new installation identity. Source targets absent from the
    // restored backup fail closed before authority can move; no identity/funds are invented.
    const installation = randomUUID();
    await rights.db
      .$executeRaw`UPDATE privacy_recovery_state SET database_id=${installation}::uuid WHERE singleton`;
    await rights.replayOnly();
    const [checkpoint] = await rights.db.$queryRaw<
      {
        source_id: string;
        checkpoint_generation: bigint;
        checkpoint_hash: string;
      }[]
    >`SELECT source_id,checkpoint_generation,checkpoint_hash FROM privacy_recovery_state WHERE singleton`;
    const authority = await PrivacyJournal.promote(config.privacyJournal, {
      expectedAuthority: initial.authority,
      databaseId: privacyAuthorityId(config.databaseUrl, installation),
      checkpoint: {
        sourceId: checkpoint.source_id,
        generation: Number(checkpoint.checkpoint_generation),
        hash: checkpoint.checkpoint_hash,
      },
    });
    await rights.db
      .$executeRaw`UPDATE privacy_recovery_state SET authority_generation=${authority.generation} WHERE singleton`;
    return {
      sourceId: checkpoint.source_id,
      checkpoint: Number(checkpoint.checkpoint_generation),
      authority,
    };
  } finally {
    await rights.onApplicationShutdown();
  }
}
