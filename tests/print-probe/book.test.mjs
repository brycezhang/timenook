import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const cli = resolve("scripts/print-probe/cli.mjs");
export const paragraph =
  "春天的清晨，我沿着河岸慢慢走过，记得岸边有一棵老树。那时的生活简单，偶尔下雨，我们便在屋檐下等候。日子一点一点过去，回忆留在了心里。";
const makeBook = () => ({
  scope: "synthetic-local-probe",
  title: "合成排版样书",
  chapters: [
    {
      title: "第一章 长段落的回忆",
      paragraphs: [paragraph.repeat(100), "第一章结束标记。"],
    },
    {
      title: "第二章 新的一页",
      paragraphs: ["第二章开始标记。", paragraph.repeat(10), "全书结束标记。"],
    },
  ],
});
function run(input, out) {
  return spawnSync(process.execPath, [cli, "book", input, out], {
    env: { ...process.env, PRINT_PROBE_ENABLED: "synthetic-local" },
    encoding: "utf8",
    timeout: 90000,
  });
}
function normalize(text) {
  return text
    .replace(/[\u2f00-\u2fdf]/g, (ch) => ch.normalize("NFKC"))
    .replace(/⻓/g, "长")
    .replace(/⻚/g, "页")
    .replace(/\s/g, "");
}
async function textPages(pdf) {
  const doc = await getDocument({
    data: new Uint8Array(pdf),
    useSystemFonts: false,
  }).promise;
  try {
    const pages = [];
    for (let n = 1; n <= doc.numPages; n++)
      pages.push(
        (await (await doc.getPage(n)).getTextContent()).items
          .map((i) => i.str ?? "")
          .join(""),
      );
    return pages;
  } finally {
    await doc.destroy();
  }
}

test("fixed Chromium book delivers complete long Chinese paragraphs, converged TOC, actual pages and a hashed candidate manifest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "t04-book-"));
  try {
    const book = makeBook(),
      input = join(dir, "book.json"),
      out = join(dir, "result");
    await writeFile(input, JSON.stringify(book));
    const result = run(input, out);
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(
      await readFile(join(out, "manifest.json"), "utf8"),
    );
    const pdf = await readFile(join(out, "book.pdf")),
      pages = await textPages(pdf);
    assert.equal(
      manifest.pdf.sha256,
      createHash("sha256").update(pdf).digest("hex"),
    );
    assert.equal(manifest.pageCount, pages.length);
    assert.ok(pages.length >= 8);
    assert.equal(manifest.renderer.chromium, "145.0.7632.6");
    assert.equal(manifest.renderer.playwright, "1.58.2");
    assert.equal(manifest.productionReady, false);
    assert.equal(manifest.d01.status, "unfrozen");
    assert.ok(manifest.toc.iterations >= 2);
    assert.equal(manifest.toc.converged, true);
    const body = normalize(pages.slice(manifest.toc.pageCount + 1).join(""))
      .replace(/本地合成样书/g, "")
      .replace(/第\d+页/g, "");
    assert.equal(
      body,
      normalize(
        book.chapters.map((c) => c.title + c.paragraphs.join("")).join(""),
      ),
    );
    for (const entry of manifest.toc.entries) {
      assert.ok(
        normalize(pages[entry.page - 1]).includes(normalize(entry.title)),
      );
      assert.ok(
        normalize(pages.slice(1, 1 + manifest.toc.pageCount).join("")).includes(
          normalize(entry.title),
        ),
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("book preserves verified photo placement and a real PDF raster decodes only the opaque paper entry URL", async () => {
  const dir = await mkdtemp(join(tmpdir(), "t04-paper-"));
  try {
    const photo = join(dir, "photo");
    const image = spawnSync(
      process.execPath,
      [
        cli,
        "photo",
        resolve("tests/print-probe/fixtures/synthetic.heic"),
        photo,
        "96",
        "64",
      ],
      {
        env: { ...process.env, PRINT_PROBE_ENABLED: "synthetic-local" },
        encoding: "utf8",
      },
    );
    assert.equal(image.status, 0, image.stderr);
    const input = join(dir, "book.json"),
      out = join(dir, "result");
    const entryId = "bN3Qw2ft4X8sML7R9jA0ZQ",
      entryBaseUrl = "http://127.0.0.1:4310/timenook/v1/probes/print/entries/";
    await writeFile(
      input,
      JSON.stringify({
        scope: "synthetic-local-probe",
        title: "合成照片原声样书",
        entryBaseUrl,
        chapters: [
          {
            title: "河边的回忆",
            paragraphs: [paragraph],
            photoDirectory: photo,
            entryId,
          },
        ],
      }),
    );
    const result = run(input, out);
    assert.equal(result.status, 0, result.stderr);
    const inspected = spawnSync(
      process.execPath,
      [cli, "inspect", join(out, "book.pdf"), join(dir, "pages")],
      {
        env: { ...process.env, PRINT_PROBE_ENABLED: "synthetic-local" },
        encoding: "utf8",
      },
    );
    assert.equal(inspected.status, 0, inspected.stderr);
    const report = JSON.parse(
      await readFile(join(dir, "pages/inspection.json"), "utf8"),
    );
    assert.deepEqual(
      report.pages.flatMap((p) => p.qr ?? []),
      [entryBaseUrl + entryId],
    );
    const manifest = JSON.parse(
      await readFile(join(out, "manifest.json"), "utf8"),
    );
    assert.equal(manifest.photos[0].printPlacement.widthMm, 96);
    assert.equal(manifest.photos[0].printPlacement.heightMm, 64);
    assert.equal(
      manifest.photos[0].print.sha256,
      createHash("sha256")
        .update(await readFile(join(photo, "print.png")))
        .digest("hex"),
    );
    for (const page of report.pages)
      assert.ok((await readFile(join(dir, "pages", page.file))).length > 5000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a multi-page table of contents converges and every chapter starts on its advertised page", async () => {
  const dir = await mkdtemp(join(tmpdir(), "t04-toc-"));
  try {
    const book = {
      scope: "synthetic-local-probe",
      title: "跨页目录合成样书",
      chapters: Array.from({ length: 22 }, (_, i) => ({
        title: `回忆章节${i + 1} 合成目录验证`,
        paragraphs: [`这是第${i + 1}段合成内容。`],
      })),
    };
    const input = join(dir, "book.json"),
      out = join(dir, "result");
    await writeFile(input, JSON.stringify(book));
    const result = run(input, out);
    assert.equal(result.status, 0, result.stderr);
    const m = JSON.parse(await readFile(join(out, "manifest.json"), "utf8")),
      pages = await textPages(await readFile(join(out, "book.pdf")));
    assert.ok(m.toc.pageCount >= 2);
    assert.equal(m.toc.entries[0].page, m.toc.pageCount + 2);
    const tocText = normalize(pages.slice(1, 1 + m.toc.pageCount).join(""));
    for (const entry of m.toc.entries) {
      assert.ok(tocText.includes(normalize(entry.title) + entry.page));
      assert.ok(
        normalize(pages[entry.page - 1]).includes(normalize(entry.title)),
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("unconverged TOC, missing glyphs and a heading that cannot fit fail without publishing a PDF", async () => {
  const dir = await mkdtemp(join(tmpdir(), "t04-layout-reject-"));
  try {
    const input = join(dir, "book.json");
    for (const [suffix, book, passes, expected] of [
      ["toc", makeBook(), "1", "TOC_DID_NOT_CONVERGE"],
      [
        "glyph",
        { ...makeBook(), title: "合成\u{10ffff}" },
        undefined,
        "MISSING_FONT_GLYPH",
      ],
      [
        "heading",
        {
          ...makeBook(),
          chapters: [
            { title: "过长的章节标题".repeat(200), paragraphs: ["内容。"] },
          ],
        },
        undefined,
        "BOOK_RENDER_REJECTED",
      ],
    ]) {
      await writeFile(input, JSON.stringify(book));
      const out = join(dir, suffix);
      const result = spawnSync(
        process.execPath,
        [cli, "book", input, out, ...(passes ? [passes] : [])],
        {
          env: { ...process.env, PRINT_PROBE_ENABLED: "synthetic-local" },
          encoding: "utf8",
        },
      );
      assert.equal(result.status, 1);
      assert.match(result.stderr, new RegExp(expected));
      await assert.rejects(readFile(join(out, "book.pdf")));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("paragraph pagination never strands closing Chinese punctuation at a new page start", async () => {
  const dir = await mkdtemp(join(tmpdir(), "t04-punctuation-"));
  try {
    const input = join(dir, "book.json"),
      out = join(dir, "result");
    const body = paragraph.repeat(45) + "这段长文完整结束。";
    await writeFile(
      input,
      JSON.stringify({
        scope: "synthetic-local-probe",
        title: "中文分页试验",
        chapters: [{ title: "第一章 沿着河岸", paragraphs: [body] }],
      }),
    );
    const result = run(input, out);
    assert.equal(result.status, 0, result.stderr);
    const m = JSON.parse(await readFile(join(out, "manifest.json"), "utf8")),
      pages = await textPages(await readFile(join(out, "book.pdf")));
    const extracted = pages.slice(m.toc.pageCount + 1).map((p) =>
      normalize(p)
        .replace(/本地合成样书/g, "")
        .replace(/第\d+页/g, ""),
    );
    assert.equal(extracted.join(""), normalize("第一章 沿着河岸" + body));
    for (const [index, text] of extracted.entries())
      assert.doesNotMatch(
        text,
        /^[，。！？、；：）】》」』”’]/,
        `body page ${index + 1}`,
      );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
