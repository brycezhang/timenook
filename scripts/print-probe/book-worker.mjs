import { readFile, writeFile, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { chromium } from "@playwright/test";
import { create as createFont } from "fontkit";
import { FONT, readFont } from "./font.mjs";
import QRCode from "qrcode";
import { CSS, TEMPLATE_VERSION, paginate } from "./template.mjs";
const [input, output, passesArg] = process.argv.slice(2);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
let browser;
try {
  if (
    process.env.PRINT_PROBE_ENABLED !== "synthetic-local" ||
    process.env.NODE_ENV === "production"
  )
    throw Error("PRINT_PROBE_DISABLED");
  if ((await stat(input)).size > 512000) throw Error("BOOK_INPUT_LIMIT");
  const inputBytes = await readFile(input),
    sourceBook = JSON.parse(inputBytes);
  const book = sourceBook;
  const product = book.scope === "synthetic-product-book";
  if (
    (!product && book.scope !== "synthetic-local-probe") ||
    typeof book.title !== "string" ||
    !book.title ||
    !Array.isArray(book.chapters) ||
    book.chapters.length < 1 ||
    book.chapters.length > 64
  )
    throw Error("INVALID_BOOK");
  for (const chapter of book.chapters)
    if (
      typeof chapter.title !== "string" ||
      !chapter.title ||
      !Array.isArray(chapter.paragraphs) ||
      chapter.paragraphs.some((p) => typeof p !== "string" || !p)
    )
      throw Error("INVALID_BOOK");
  const maxPasses = passesArg === undefined ? 8 : Number(passesArg);
  if (!Number.isInteger(maxPasses) || maxPasses < 1 || maxPasses > 8)
    throw Error("INVALID_TOC_PASSES");
  const fontBytes = await readFont(),
    font = createFont(fontBytes);
  const allText = [
    book.title,
    ...(book.provenanceNotice ? [book.provenanceNotice] : []),
    ...book.chapters.flatMap((c) => [
      c.title,
      ...c.paragraphs,
      c.sectionTitle ?? "",
      c.provenance ?? "",
      ...(c.notes ?? []),
      ...(c.photos ?? []).map((p) => p.caption ?? ""),
    ]),
  ].join("");
  if (allText.length > 100000) throw Error("BOOK_TEXT_LIMIT");
  for (const ch of allText)
    if (!/\s/.test(ch) && !font.hasGlyphForCodePoint(ch.codePointAt(0)))
      throw Error("MISSING_FONT_GLYPH");
  const photos = [],
    entries = [];
  for (const chapter of book.chapters) {
    if (
      Object.keys(chapter).some(
        (k) =>
          ![
            "title",
            "paragraphs",
            "photoDirectory",
            "entryId",
            ...(product
              ? ["photos", "sectionTitle", "provenance", "notes"]
              : []),
          ].includes(k),
      )
    )
      throw Error("INVALID_BOOK");
    if (product) {
      const loaded = [];
      if (!Array.isArray(chapter.photos) || chapter.photos.length > 128)
        throw Error("INVALID_PHOTO");
      for (const photo of chapter.photos) {
        if (
          !/^[a-f0-9-]{36}\.png$/.test(photo.file) ||
          typeof photo.caption !== "string" ||
          photo.caption.length > 5000 ||
          ![photo.widthMm, photo.heightMm].every(
            (n) => Number.isFinite(n) && n > 0,
          ) ||
          photo.widthMm > 116 ||
          photo.heightMm > 165
        )
          throw Error("INVALID_PHOTO");
        const bytes = await readFile(join(dirname(input), photo.file));
        if (bytes.length > 16777216 || sha(bytes) !== photo.sha256)
          throw Error("PHOTO_INTEGRITY_FAILED");
        loaded.push({
          ...photo,
          data: `data:image/png;base64,${bytes.toString("base64")}`,
        });
        photos.push({ sha256: photo.sha256, caption: photo.caption });
      }
      chapter.photos = loaded;
    }
    if (chapter.photoDirectory) {
      if (typeof chapter.photoDirectory !== "string")
        throw Error("INVALID_PHOTO");
      const photo = JSON.parse(
        await readFile(join(chapter.photoDirectory, "photo.json"), "utf8"),
      );
      if (
        photo.scope !== "synthetic-local-probe" ||
        photo.printPlacement.widthMm > 116 ||
        photo.printPlacement.heightMm > 172
      )
        throw Error("PHOTO_PLACEMENT_TOO_LARGE");
      for (const [name, file] of [
        ["original", "original.bin"],
        ["preview", "preview.jpg"],
        ["print", "print.png"],
      ]) {
        if (
          photo[name]?.file !== file ||
          sha(await readFile(join(chapter.photoDirectory, file))) !==
            photo[name].sha256
        )
          throw Error("PHOTO_INTEGRITY_FAILED");
      }
      if (
        photo.print.sourceSha256 !== photo.original.sha256 ||
        photo.preview.sourceSha256 !== photo.original.sha256
      )
        throw Error("PHOTO_INTEGRITY_FAILED");
      chapter.photo = {
        data: `data:image/png;base64,${(await readFile(join(chapter.photoDirectory, "print.png"))).toString("base64")}`,
        widthMm: photo.printPlacement.widthMm,
        heightMm: photo.printPlacement.heightMm,
      };
      photos.push(photo);
    }
    if (chapter.entryId) {
      if (!/^[A-Za-z0-9_-]{22}$/.test(chapter.entryId))
        throw Error("INVALID_ENTRY");
      const base = new URL(book.entryBaseUrl);
      if (
        (product
          ? base.protocol !== "https:"
          : base.protocol !== "http:" ||
            !["localhost", "127.0.0.1"].includes(base.hostname) ||
            base.pathname !== "/timenook/v1/probes/print/entries/") ||
        base.search ||
        base.hash ||
        base.username ||
        base.password
      )
        throw Error("INVALID_LOCAL_ENTRY_BASE");
      const url = base.href + chapter.entryId;
      chapter.qr = await QRCode.toDataURL(url, {
        errorCorrectionLevel: "M",
        margin: 4,
        width: 512,
      });
      entries.push({
        id: chapter.entryId,
        url,
        kind: product
          ? "original-audio-version-entry"
          : "ordinary-QR-local-probe",
      });
    }
  }
  browser = await chromium.launch({ headless: true });
  if (browser.version() !== "145.0.7632.6")
    throw Error("CHROMIUM_VERSION_MISMATCH");
  const page = await browser.newPage();
  await page.route("**/*", (route) => route.abort());
  await page.emulateMedia({ media: "print" });
  await page.setContent(
    `<html lang="zh-CN"><head><meta charset="utf-8"><style>@font-face{font-family:ProbeSans;src:url(data:font/otf;base64,${fontBytes.toString("base64")})} ${CSS}</style></head><body>字体</body></html>`,
  );
  await page.evaluate(() => document.fonts.ready);
  let guesses = book.chapters.map(() => 0),
    layout,
    iterations = 0,
    converged = false;
  for (; iterations < maxPasses;) {
    iterations++;
    layout = await page.evaluate(paginate, { book, guesses });
    const next = layout.entries.map((e) => e.page);
    if (JSON.stringify(next) === JSON.stringify(guesses)) {
      converged = true;
      break;
    }
    guesses = next;
  }
  if (!converged) throw Error("TOC_DID_NOT_CONVERGE");
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map((i) => i.decode()));
  });
  const pdf = await page.pdf({
    printBackground: true,
    preferCSSPageSize: true,
    displayHeaderFooter: false,
  });
  await writeFile(join(output, "book.pdf"), pdf, { mode: 0o600, flag: "wx" });
  await writeFile(
    join(output, "manifest.json"),
    JSON.stringify(
      {
        scope: book.scope,
        productionReady: false,
        candidate: {
          widthMm: 148,
          heightMm: 210,
          binding: null,
          paper: null,
          color: "sRGB Chromium output; not PDF/X or CMYK validated",
          bleedMm: 0,
          pageLimits: null,
        },
        d01: {
          status: "unfrozen",
          remaining: [
            "trim size",
            "binding",
            "paper",
            "color / ICC profile",
            "minimum and maximum pages",
            "bleed",
            "printer PDF format acceptance",
            "production resolution threshold",
            "physical proof approval",
          ],
        },
        renderer: {
          playwright: "1.58.2",
          chromium: browser.version(),
          node: process.version,
          template: TEMPLATE_VERSION,
          templateSha256: sha(
            await readFile(new URL("./template.mjs", import.meta.url)),
          ),
        },
        font: FONT,
        photos,
        paperEntries: entries,
        inputSha256: sha(inputBytes),
        pdf: { file: "book.pdf", sha256: sha(pdf) },
        pageCount: layout.pageCount,
        toc: {
          converged,
          iterations,
          pageCount: layout.tocPages,
          entries: layout.entries,
        },
        printerAcceptance: null,
        physicalProof: null,
      },
      null,
      2,
    ),
    { mode: 0o600, flag: "wx" },
  );
} catch (error) {
  console.error(
    /^[A-Z_]+$/.test(error.message) ? error.message : "BOOK_RENDER_REJECTED",
  );
  process.exitCode = 1;
} finally {
  await browser?.close();
}
