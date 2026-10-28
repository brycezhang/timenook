import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ProbeObjects } from "../probe/local-objects";
export const photoDigest = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
/** Same T04 pixels and bounded process. Caller owns authorization and durable facts. */
export class PhotoBusyError extends Error {}
let active = 0;
const inFlight = new WeakMap<
  ProbeObjects,
  Map<string, Promise<Awaited<ReturnType<typeof verifyPhoto>>>>
>();
export function sealPhoto(
  objects: ProbeObjects,
  input: {
    owned?: { root: string; snapshots: Record<string, string> };
    id: string;
    bytes: number;
    sha256: string;
    placement: { widthMm: number; heightMm: number };
    sourceKey?: string;
    crop?: { left: number; top: number; width: number; height: number };
  },
) {
  const jobs = inFlight.get(objects) ?? new Map();
  inFlight.set(objects, jobs);
  const key = JSON.stringify(input),
    prior = jobs.get(key);
  if (prior) return prior;
  if (active >= 2) throw new PhotoBusyError();
  active++;
  const job = verifyPhoto(objects, input).finally(() => {
    active--;
    jobs.delete(key);
  });
  jobs.set(key, job);
  return job;
}
async function verifyPhoto(
  objects: ProbeObjects,
  input: {
    owned?: { root: string; snapshots: Record<string, string> };
    id: string;
    bytes: number;
    sha256: string;
    placement: { widthMm: number; heightMm: number };
    sourceKey?: string;
    crop?: { left: number; top: number; width: number; height: number };
  },
) {
  const bytes = await objects.read(
    input.sourceKey ?? `photos/staging/${input.id}.bin`,
  );
  if (bytes.length !== input.bytes || photoDigest(bytes) !== input.sha256)
    throw new Error("PHOTO_SOURCE_MISMATCH");
  const root =
    input.owned?.root ?? (await mkdtemp(join(tmpdir(), "timenook-photo-")));
  if (input.owned) await mkdir(root, { recursive: true, mode: 0o700 });
  const snapshots: string[] = [];
  try {
    await writeFile(join(root, "input"), bytes, { mode: 0o600, flag: "wx" });
    await mkdir(join(root, "output"), { mode: 0o700 });
    // dist/media and dist-test/src/media both find the package-owned runtime.
    const runtime = resolve(
      __dirname,
      __dirname.includes("dist-test") ? "../../../runtime" : "../../runtime",
    );
    const { runBounded } = await import(
      pathToFileURL(join(runtime, "bounded-process.mjs")).href
    );
    await runBounded({
      worker: join(runtime, "photo-worker.mjs"),
      args: [
        join(root, "input"),
        join(root, "output"),
        String(input.placement.widthMm),
        String(input.placement.heightMm),
        ...(input.crop ? [JSON.stringify(input.crop)] : []),
      ],
      heapMiB: 128,
      rssLimit: 384,
      timeLimit: 15000,
      env: { NODE_ENV: "test", TIMENOOK_PHOTO_MODE: "synthetic-local" },
    });
    const metadata = JSON.parse(
      await readFile(join(root, "output/photo.json"), "utf8"),
    );
    const assets = [];
    for (const [kind, file, mime, extension] of [
      ["original", "original.bin", `image/${metadata.format}`, "bin"],
      ["preview", "preview.jpg", "image/jpeg", "jpg"],
      ["print", "print.png", "image/png", "png"],
    ]) {
      if (input.crop && kind === "original") continue;
      const content = await readFile(join(root, "output", file));
      const snapshot =
        input.owned?.snapshots[kind!] ??
        `photos/staging/${randomUUID()}.${extension}`;
      const objectKey = `photos/sealed/${input.id}/${file}`;
      snapshots.push(snapshot);
      await objects.putSnapshot(snapshot, content);
      await objects.copy(snapshot, objectKey);
      const final = await objects.read(objectKey);
      if (
        final.length !== content.length ||
        photoDigest(final) !== photoDigest(content)
      )
        throw new Error("PHOTO_FINAL_MISMATCH");
      assets.push({
        kind,
        objectKey,
        mime,
        bytes: content.length,
        sha256: photoDigest(content),
        width:
          kind === "preview"
            ? metadata.preview.pixels.width
            : metadata.orientedPixels.width,
        height:
          kind === "preview"
            ? metadata.preview.pixels.height
            : metadata.orientedPixels.height,
      });
    }
    return { assets, metadata };
  } finally {
    for (const key of snapshots) await objects.remove(key).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}
