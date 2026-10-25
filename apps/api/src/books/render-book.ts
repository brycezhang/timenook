import type { BookSnapshot } from "@timenook/contracts";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
// Fixed CJK font glyph aliases used by Chromium's PDF ToUnicode table (T04 already covers long/page).
const normalized = (s: string) =>
  s
    .normalize("NFKC")
    .replace(/⻓/g, "长")
    .replace(/⻚/g, "页")
    .replace(/⻔/g, "门")
    .replace(/\s/g, "");
/** T04 owns pagination, fonts, Chromium and PDF inspection. This adapter supplies only a frozen product snapshot. */
export async function renderBook(
  snapshot: BookSnapshot,
  photos: Record<string, Buffer>,
  output: string,
  snapshotHash: string,
): Promise<{
  sha256: string;
  bytes: number;
  pageCount: number;
  manifest: any;
  inspection: any;
}> {
  const runtime = resolve(
      __dirname,
      __dirname.includes("dist-test") ? "../../../runtime" : "../../runtime",
    ),
    scripts = resolve(runtime, "../../../scripts/print-probe"),
    { runBounded } = await import(
      pathToFileURL(join(runtime, "bounded-process.mjs")).href
    );
  await mkdir(output, { recursive: true, mode: 0o700 });
  try {
    const chapters = [];
    const staged = new Set<string>();
    async function stagePhoto(
      p: NonNullable<BookSnapshot["cover"]["photo"]>,
      widthMm: number,
      heightMm: number,
    ) {
      const bytes = photos[p.assetId];
      if (!bytes || hash(bytes) !== p.sha256)
        throw Error("BOOK_PHOTO_INTEGRITY");
      const file = `${p.assetId}.png`,
        scale = Math.min(widthMm / p.width, heightMm / p.height);
      if (!staged.has(p.assetId)) {
        await writeFile(join(output, file), bytes, { mode: 0o600, flag: "wx" });
        staged.add(p.assetId);
      }
      return {
        file,
        sha256: p.sha256,
        widthMm: p.width * scale,
        heightMm: p.height * scale,
        caption: p.caption,
      };
    }
    for (const chapter of snapshot.chapters)
      for (const [index, story] of chapter.stories.entries()) {
        const images = [];
        for (const p of story.photos) {
          images.push(await stagePhoto(p, 100, 145));
        }
        chapters.push({
          title: story.title,
          ...(index === 0 ? { sectionTitle: chapter.title } : {}),
          paragraphs: story.paragraphs,
          notes: story.notes.map((n) => n.text),
          provenance: story.provenance.label,
          photos: images,
          ...(story.entry ? { entryId: story.entry.id } : {}),
        });
      }
    const entries = snapshot.chapters.flatMap((c) =>
      c.stories.flatMap((s) => (s.entry ? [s.entry] : [])),
    );
    const book = {
      scope: "synthetic-product-book",
      title: snapshot.cover.title,
      salutation: snapshot.cover.salutation,
      coverPhoto: snapshot.cover.photo
        ? await stagePhoto(snapshot.cover.photo, 100, 70)
        : null,
      entryBaseUrl: entries.length
        ? entries[0].url.slice(0, -entries[0].id.length)
        : undefined,
      chapters,
      provenanceNotice: snapshot.provenance.notice,
    };
    await writeFile(join(output, "input.json"), JSON.stringify(book), {
      mode: 0o600,
      flag: "wx",
    });
    const limits = {
      heapMiB: 256,
      rssLimit: 2048,
      timeLimit: 60000,
      env: { NODE_ENV: "test", PRINT_PROBE_ENABLED: "synthetic-local" },
    };
    await runBounded({
      ...limits,
      worker: join(scripts, "book-worker.mjs"),
      args: [join(output, "input.json"), output],
    });
    const manifest = JSON.parse(
      await readFile(join(output, "manifest.json"), "utf8"),
    );
    await mkdir(join(output, "pages"), { mode: 0o700 });
    await runBounded({
      ...limits,
      worker: join(scripts, "inspect-worker.mjs"),
      args: [join(output, "book.pdf"), join(output, "pages"), "3"],
    });
    const inspection = JSON.parse(
      await readFile(join(output, "pages/inspection.json"), "utf8"),
    );
    const bytes = await readFile(join(output, "book.pdf")),
      sha256 = hash(bytes);
    if (
      bytes.length > 33554432 ||
      manifest.pdf.sha256 !== sha256 ||
      inspection.pageCount !== manifest.pageCount ||
      !manifest.toc.converged
    )
      throw Error("BOOK_PDF_INTEGRITY");
    // Chromium rounds CSS millimetres to device pixels; retain measured points and reject deviations above one point.
    for (const page of inspection.pages)
      if (
        Math.abs(page.widthPt - (148 / 25.4) * 72) > 1 ||
        Math.abs(page.heightPt - (210 / 25.4) * 72) > 1
      )
        throw Error("BOOK_PAGE_SIZE_MISMATCH");
    const text = inspection.pages
      .map((page: any) => {
        let body = normalized(page.text);
        const header = normalized("书稿预览 · 制作规格待核验"),
          footer = `第${page.number}页`;
        if (body.startsWith(header)) body = body.slice(header.length);
        if (body.endsWith(footer)) body = body.slice(0, -footer.length);
        return body;
      })
      .join("");
    const expected = [
      snapshot.cover.title,
      snapshot.cover.salutation,
      snapshot.provenance.notice,
      ...snapshot.chapters.flatMap((c) => [
        c.title,
        ...c.stories.flatMap((s) => [
          s.title,
          ...s.paragraphs,
          ...s.notes.map((n) => n.text),
          s.provenance.label,
          ...s.photos.map((p) => p.caption),
        ]),
      ]),
    ];
    if (expected.some((s) => !text.includes(normalized(s))))
      throw Error("BOOK_TEXT_INCOMPLETE");
    const codes = inspection.pages.flatMap((p: any) => p.qr);
    if (
      codes.length !== entries.length ||
      entries.some((e) => !codes.includes(e.url))
    )
      throw Error("BOOK_QR_MISMATCH");
    const photoCount =
      (snapshot.cover.photo ? 1 : 0) +
      snapshot.chapters.flatMap((c) => c.stories.flatMap((s) => s.photos))
        .length;
    if (
      inspection.pages.reduce((n: number, p: any) => n + p.imageCount, 0) <
      photoCount + entries.length
    )
      throw Error("BOOK_IMAGES_INCOMPLETE");
    manifest.book = {
      snapshotHash,
      provenanceVersion: snapshot.provenance.version,
      storyRevisions: snapshot.chapters.flatMap((c) =>
        c.stories.map((s) => ({
          id: s.id,
          revisionId: s.revisionId,
          contentHash: s.contentHash,
          provenance: s.provenance,
        })),
      ),
    };
    await writeFile(
      join(output, "manifest.json"),
      JSON.stringify(manifest, null, 2),
      { mode: 0o600 },
    );
    await writeFile(
      join(output, "snapshot.json"),
      JSON.stringify(snapshot, null, 2),
      { mode: 0o600, flag: "wx" },
    );
    return {
      sha256,
      bytes: bytes.length,
      pageCount: inspection.pageCount,
      manifest,
      inspection,
    };
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
}
