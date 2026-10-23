import type { FastifyReply } from "fastify";
/** Shared bounded private MP3/Range response after the caller rechecks access. */
export function sendAudio(
  bytes: Buffer,
  id: string,
  range: string | undefined,
  reply: FastifyReply,
) {
  reply
    .header("Cache-Control", "private, no-store")
    .header("Pragma", "no-cache")
    .header("X-Content-Type-Options", "nosniff")
    .header("Accept-Ranges", "bytes")
    .header("Content-Type", "audio/mpeg")
    .header("Content-Disposition", `attachment; filename="${id}.mp3"`);
  if (!range) return reply.send(bytes);
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  let start = 0,
    end = bytes.length - 1;
  if (match?.[1]) {
    start = Number(match[1]);
    if (match[2]) end = Math.min(Number(match[2]), end);
  } else if (match?.[2]) start = Math.max(0, bytes.length - Number(match[2]));
  if (
    !match ||
    (!match[1] && !match[2]) ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start > end ||
    start >= bytes.length
  ) {
    return reply
      .status(416)
      .header("Content-Range", `bytes */${bytes.length}`)
      .send();
  }
  return reply
    .status(206)
    .header("Content-Range", `bytes ${start}-${end}/${bytes.length}`)
    .send(bytes.subarray(start, end + 1));
}
