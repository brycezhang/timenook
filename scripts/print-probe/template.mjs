export const TEMPLATE_VERSION = "t20-a5-v3";
export const CSS = `
@page { size: 148mm 210mm; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { font-family: ProbeSans; font-size: 14px; line-height: 1.8; color: #25332e; -webkit-print-color-adjust: exact; }
.page { position: relative; width: 148mm; height: 210mm; break-after: page; background: white; }
.page:last-child { break-after: auto; }
.content { position: absolute; top: 20mm; left: 16mm; width: 116mm; height: 172mm; }
.header { position: absolute; top: 8mm; left: 16mm; color: #718178; font-size: 9px; }
.footer { position: absolute; bottom: 7mm; right: 16mm; font-size: 10px; color: #718178; }
h1 { font-size: 26px; line-height: 1.5; margin: 40mm 0 12mm; font-weight: normal; overflow-wrap: anywhere; }
h2 { font-size: 21px; line-height: 1.6; margin: 0 0 8mm; font-weight: normal; overflow-wrap: anywhere; }
p { margin: 0 0 10px; white-space: pre-wrap; overflow-wrap: anywhere; }
.toc-row { display: flex; align-items: flex-start; gap: 4mm; padding: 3mm 0; border-bottom: 1px solid #dce4df; }
.toc-row span:first-child { flex: 1; overflow-wrap: anywhere; }
.toc-row span:last-child { flex: 0 0 10mm; text-align: right; }
figure { margin: 0 0 6mm; } .photo { display: block; object-fit: contain; }
.qr { display: block; width: 32mm; height: 32mm; image-rendering: pixelated; }
figcaption, .photo-caption { font-size: 10px; color: #718178; }
.photo-caption { margin: 0 0 6mm; }
.cover-title { font-size:22px; line-height:1.3; margin:4mm 0; }
.cover-salutation { font-size:14px; line-height:1.6; margin:0 0 4mm; overflow-wrap:anywhere; white-space:normal; }
.cover-photo { display:block; margin:0 auto 3mm; object-fit:contain; }
.cover-notice { font-size:10px; line-height:1.6; margin:0; }
`;

// Executed in fixed Chromium; only textContent and prevalidated local data URLs enter DOM.
export function paginate({ book, guesses }) {
  document.body.replaceChildren();
  const pages = [],
    entries = [];
  function page() {
    const sheet = document.createElement("section");
    sheet.className = "page";
    const header = document.createElement("div");
    header.className = "header";
    header.textContent =
      book.scope === "synthetic-product-book"
        ? "书稿预览 · 制作规格待核验"
        : "本地合成样书";
    const content = document.createElement("div");
    content.className = "content";
    const footer = document.createElement("div");
    footer.className = "footer";
    footer.textContent = `第${pages.length + 1}页`;
    sheet.append(header, content, footer);
    document.body.append(sheet);
    pages.push(sheet);
    return content;
  }
  let content = page();
  function fits(node) {
    const a = node.getBoundingClientRect(),
      b = content.getBoundingClientRect();
    return (
      a.bottom <= b.bottom + 0.1 &&
      a.right <= b.right + 0.1 &&
      content.scrollWidth <= content.clientWidth + 1
    );
  }
  function block(node) {
    content.append(node);
    if (!fits(node)) {
      node.remove();
      content = page();
      content.append(node);
      if (!fits(node)) throw Error("BLOCK_TOO_LARGE");
    }
  }
  function text(tag, value) {
    const n = document.createElement(tag);
    n.textContent = value;
    return n;
  }
  function flowText(value, className) {
    let chars = Array.from(value);
    while (chars.length) {
      const p = text("p", chars.join(""));
      if (className) p.className = className;
      content.append(p);
      if (fits(p)) break;
      let low = 0,
        high = chars.length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        p.textContent = chars.slice(0, mid).join("");
        if (fits(p)) low = mid;
        else high = mid - 1;
      }
      // Keep a closing mark with its preceding character and an opening mark
      // with its following character across a physical page boundary.
      while (
        low > 0 &&
        (/^[，。！？、；：）】》」』”’]$/.test(chars[low] ?? "") ||
          /^[（【《「『“‘]$/.test(chars[low - 1] ?? ""))
      )
        low--;
      if (low === 0) {
        p.remove();
        if (content.children.length === 0) throw Error("BLOCK_TOO_LARGE");
        content = page();
        continue;
      }
      p.textContent = chars.slice(0, low).join("");
      chars = chars.slice(low);
      content = page();
    }
  }
  if (book.scope === "synthetic-product-book") {
    const cover = document.createElement("div"),
      title = text("h1", book.title);
    title.className = "cover-title";
    cover.append(title);
    if (book.salutation) {
      const salutation = text("div", book.salutation);
      salutation.className = "cover-salutation";
      cover.append(salutation);
    }
    if (book.coverPhoto) {
      const img = document.createElement("img");
      img.className = "cover-photo";
      img.src = book.coverPhoto.data;
      img.style.width = `${book.coverPhoto.widthMm}mm`;
      img.style.height = `${book.coverPhoto.heightMm}mm`;
      cover.append(img);
    }
    const notice = text("p", "技术试验文件 · 规格待印厂确认");
    notice.className = "cover-notice";
    cover.append(notice);
    content.append(cover);
    if (!fits(cover)) throw Error("COVER_LAYOUT_OVERFLOW");
    content = page();
    block(text("h2", book.title));
    block(text("p", "岁月成书 · 本人讲述"));
  } else {
    block(text("h1", book.title));
    block(text("p", "技术试验文件 · 规格待印厂确认"));
  }
  content = page();
  block(text("h2", "目录"));
  const tocStart = pages.length;
  for (let i = 0; i < book.chapters.length; i++) {
    if (book.chapters[i].sectionTitle)
      block(text("p", book.chapters[i].sectionTitle));
    const row = document.createElement("div");
    row.className = "toc-row";
    row.append(
      text("span", book.chapters[i].title),
      text("span", String(guesses[i] ?? 0)),
    );
    block(row);
  }
  const tocPages = pages.length - tocStart + 1;
  function originalEntry(chapter) {
    const figure = document.createElement("figure"),
      img = document.createElement("img");
    img.className = "qr";
    img.src = chapter.qr;
    figure.append(
      img,
      text(
        "figcaption",
        book.scope === "synthetic-product-book"
          ? "本人原声入口 · 访问需授权"
          : "合成原声入口 · 需测试身份",
      ),
    );
    block(figure);
  }
  for (const chapter of book.chapters) {
    content = page();
    const heading = text("h2", chapter.title);
    if (chapter.sectionTitle) block(text("p", chapter.sectionTitle));
    content.append(heading);
    if (!fits(heading)) throw Error("BLOCK_TOO_LARGE");
    entries.push({ title: chapter.title, page: pages.length });
    if (book.scope === "synthetic-product-book") {
      if (chapter.provenance) block(text("p", chapter.provenance));
      if (chapter.qr) originalEntry(chapter);
    }
    for (const paragraph of chapter.paragraphs) flowText(paragraph);
    for (const photo of chapter.photos ??
      (chapter.photo ? [chapter.photo] : [])) {
      const figure = document.createElement("figure"),
        img = document.createElement("img");
      img.className = "photo";
      img.src = photo.data;
      img.style.width = `${photo.widthMm}mm`;
      img.style.height = `${photo.heightMm}mm`;
      figure.append(img);
      if (book.scope === "synthetic-product-book" && photo.caption) {
        figure.style.marginBottom = "0";
        block(figure);
        flowText(photo.caption, "photo-caption");
      } else {
        if (photo.caption) figure.append(text("figcaption", photo.caption));
        block(figure);
      }
    }
    if (chapter.qr && book.scope !== "synthetic-product-book")
      originalEntry(chapter);
    for (const note of chapter.notes ?? []) flowText(note);
    if (chapter.provenance && book.scope !== "synthetic-product-book")
      block(text("p", chapter.provenance));
    if (pages.length > 128) throw Error("PAGE_LIMIT");
  }
  if (book.provenanceNotice) {
    content = page();
    block(text("h2", "制作说明"));
    block(text("p", book.provenanceNotice));
  }
  for (const sheet of pages) {
    const box = sheet.querySelector(".content");
    for (const child of box.children) {
      const r = child.getBoundingClientRect(),
        b = box.getBoundingClientRect();
      if (r.bottom > b.bottom + 0.1 || r.right > b.right + 0.1)
        throw Error("LAYOUT_OVERFLOW");
    }
  }
  return { entries, pageCount: pages.length, tocPages };
}
