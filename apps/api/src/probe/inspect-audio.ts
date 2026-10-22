import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Bounded process output, elapsed time, allocator request size and decoder threads.
// These are not an OS memory sandbox. This non-production probe is operator-only.
function run(binary: string, args: string[], limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    const fail = () => {
      failed = true;
      child.kill("SIGKILL");
    };
    const timeout = setTimeout(fail, 15000);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) fail();
      else chunks.push(chunk);
    });
    let diagnostics = 0;
    child.stderr.on("data", (chunk: Buffer) => {
      diagnostics += chunk.length;
      if (diagnostics > 65536) fail();
    });
    child.on("error", () => {
      clearTimeout(timeout);
      reject(new Error("Audio decoder unavailable"));
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (failed || code !== 0) reject(new Error("Audio validation failed"));
      else resolve(Buffer.concat(chunks));
    });
  });
}
export async function inspectAudio(bytes: Buffer): Promise<number> {
  if (!bytes.length || bytes.length > 2097152)
    throw new Error("Audio size invalid");
  const dir = await mkdtemp(join(tmpdir(), "timenook-audio-"));
  const path = join(dir, "input.mp3");
  try {
    await writeFile(path, bytes, { mode: 0o600 });
    const input = [
      "-protocol_whitelist",
      "file,pipe",
      "-format_whitelist",
      "mp3",
      "-codec_whitelist",
      "mp3,mp3float",
      "-f",
      "mp3",
      "-threads",
      "1",
      "-i",
      path,
    ];
    const metadata = JSON.parse(
      (
        await run(
          process.env.FFPROBE_PATH ?? "ffprobe",
          [
            "-v",
            "error",
            "-max_alloc",
            "16777216",
            ...input,
            "-show_entries",
            "stream=codec_name,codec_type,sample_rate,channels",
            "-of",
            "json",
          ],
          65536,
        )
      ).toString(),
    );
    if (
      metadata.streams?.length !== 1 ||
      metadata.streams[0].codec_name !== "mp3" ||
      metadata.streams[0].codec_type !== "audio" ||
      metadata.streams[0].sample_rate !== "16000" ||
      metadata.streams[0].channels !== 1
    )
      throw new Error("Unsupported audio format");
    const pcm = await run(
      process.env.FFMPEG_PATH ?? "ffmpeg",
      [
        "-nostdin",
        "-v",
        "error",
        "-max_alloc",
        "16777216",
        "-xerror",
        "-err_detect",
        "explode",
        ...input,
        "-map",
        "0:a:0",
        "-vn",
        "-sn",
        "-dn",
        "-threads",
        "1",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        "-f",
        "s16le",
        "pipe:1",
      ],
      9600000,
    );
    const durationMs = Math.round(pcm.length / 32);
    if (durationMs < 1 || durationMs > 300000)
      throw new Error("Audio duration invalid");
    return durationMs;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
