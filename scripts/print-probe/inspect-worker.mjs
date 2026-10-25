import { readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createCanvas } from "@napi-rs/canvas";
import jsQR from "jsqr";
const [input, output, scaleArg] = process.argv.slice(2);
const scale = Number(scaleArg ?? 2);
let doc;
try {
  if (![2, 3].includes(scale)) throw Error("INVALID_PDF_SCALE");
  if (
    process.env.PRINT_PROBE_ENABLED !== "synthetic-local" ||
    process.env.NODE_ENV === "production"
  )
    throw Error("PRINT_PROBE_DISABLED");
  if ((await stat(input)).size > 32 * 1024 * 1024)
    throw Error("PDF_BYTE_LIMIT");
  doc = await getDocument({
    data: new Uint8Array(await readFile(input)),
    useSystemFonts: false,
    isEvalSupported: false,
  }).promise;
  if (doc.numPages > 128) throw Error("PAGE_LIMIT");
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n),
      viewport = page.getViewport({ scale });
    if (viewport.width * viewport.height > 4_000_000)
      throw Error("PDF_PIXEL_LIMIT");
    const canvas = createCanvas(
        Math.ceil(viewport.width),
        Math.ceil(viewport.height),
      ),
      context = canvas.getContext("2d");
    await page.render({ canvas, canvasContext: context, viewport }).promise;
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(image.data, canvas.width, canvas.height, {
      inversionAttempts: "dontInvert",
    });
    const file = `page-${String(n).padStart(3, "0")}.png`;
    await writeFile(join(output, file), canvas.toBuffer("image/png"), {
      mode: 0o600,
      flag: "wx",
    });
    const text = (await page.getTextContent()).items
      .map((i) => i.str ?? "")
      .join("");
    const operators = await page.getOperatorList();
    pages.push({
      number: n,
      file,
      text,
      qr: code?.data ? [code.data] : [],
      imageCount: operators.fnArray.filter((op) =>
        [
          OPS.paintImageXObject,
          OPS.paintInlineImageXObject,
          OPS.paintImageXObjectRepeat,
        ].includes(op),
      ).length,
      widthPt: viewport.width / scale,
      heightPt: viewport.height / scale,
    });
    page.cleanup();
  }
  await writeFile(
    join(output, "inspection.json"),
    JSON.stringify(
      {
        renderer: "pdfjs-dist 5.4.624",
        scale,
        pageCount: doc.numPages,
        pages,
      },
      null,
      2,
    ),
    { mode: 0o600, flag: "wx" },
  );
} catch (error) {
  console.error(
    /^[A-Z_]+$/.test(error.message) ? error.message : "PDF_INSPECTION_FAILED",
  );
  process.exitCode = 1;
} finally {
  await doc?.destroy();
}
