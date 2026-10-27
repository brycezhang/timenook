import { createHash, randomUUID } from "node:crypto";
import { inspectAudio } from "../probe/inspect-audio";
import type { ProbeObjects } from "../probe/local-objects";
/** Shared bounded file verification. Identity and durable facts belong to callers. */
export async function sealAudio(
  objects: ProbeObjects,
  input: {
    source: string;
    target: string;
    bytes: number;
    sha256: string;
    snapshotKey?: string;
  },
) {
  const expected = (bytes: Buffer) =>
    bytes.length === input.bytes &&
    createHash("sha256").update(bytes).digest("hex") === input.sha256;
  const bytes = await objects.read(input.source);
  if (!expected(bytes)) throw new Error("Staging object mismatch");
  const durationMs = await inspectAudio(bytes);
  // A client may still replace its staging key. Publish only the immutable
  // bytes we inspected; every concurrent completion of this intent has this hash.
  const snapshot = input.snapshotKey ?? `staging/${randomUUID()}.mp3`;
  try {
    await objects.putSnapshot(snapshot, bytes);
    await objects.copy(snapshot, input.target);
    if (!expected(await objects.read(input.target)))
      throw new Error("Final object mismatch");
  } finally {
    await objects.remove(snapshot).catch(() => {});
  }
  return {
    bytes: input.bytes,
    sha256: input.sha256,
    durationMs,
    objectKey: input.target,
  };
}
