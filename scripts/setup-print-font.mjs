import { mkdir, writeFile, rename, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { FONT, fontPath, readFont } from "./print-probe/font.mjs";
try {
  await readFont();
  console.log("Pinned font verified.");
} catch {
  const response = await fetch(FONT.url, {
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw Error("Pinned font download failed");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== FONT.sha256)
    throw Error("Font checksum mismatch");
  await mkdir(new URL(".", fontPath), { recursive: true, mode: 0o700 });
  const temp = new URL(`${fontPath.href}.${randomUUID()}.partial`);
  try {
    await writeFile(temp, bytes, { flag: "wx", mode: 0o600 });
    await rename(temp, fontPath);
  } finally {
    await rm(temp, { force: true });
  }
  console.log("Pinned font downloaded and verified.");
}
