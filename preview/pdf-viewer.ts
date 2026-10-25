import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  RenderTask,
} from "pdfjs-dist";

interface DocumentOptions {
  filePath: string;
  fileType: string;
  success?: (result: { errMsg: string }) => void;
  fail?: (result: { errMsg: string }) => void;
}
interface OpenDocument {
  filePath: string;
  close: () => void;
}
let current: OpenDocument | null = null;

export function closePdfDocument(filePath?: string) {
  if (current && (!filePath || current.filePath === filePath)) current.close();
}

// The preview reads pages from the downloaded PDF; it never lays out the source again.
export async function openPdfDocument(
  overlay: HTMLElement,
  options: DocumentOptions,
  releaseFile: (filePath: string) => void,
) {
  if (
    options.fileType !== "pdf" ||
    typeof options.filePath !== "string" ||
    !options.filePath.startsWith(`blob:${location.origin}/`)
  ) {
    options.fail?.({ errMsg: "openDocument:fail" });
    return;
  }
  closePdfDocument();
  const box = document.createElement("div"),
    controls = document.createElement("div"),
    pages = document.createElement("div"),
    canvas = document.createElement("canvas"),
    label = document.createElement("div");
  box.className = "modal pdf-viewer";
  box.style.cssText = "padding:16px;max-height:90%;overflow:auto";
  controls.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;margin:8px 0";
  pages.className = "pdf-page-viewport";
  canvas.className = "pdf-page";
  pages.style.cssText =
    "max-height:58vh;overflow:auto;background:#fff;border:1px solid #e2dace";
  canvas.setAttribute("aria-label", "完整书稿页面");
  canvas.style.display = "block";
  label.className = "pdf-page-number";
  label.setAttribute("aria-live", "polite");
  label.textContent = "正在打开完整书稿…";
  const button = (text: string, className: string) => {
    const value = document.createElement("button");
    value.textContent = text;
    value.className = className;
    value.style.cssText =
      "min-height:48px;min-width:64px;flex:1;padding:8px;background:#eee7dc;border-radius:12px";
    return value;
  };
  const previous = button("上一页", "pdf-prev"),
    next = button("下一页", "pdf-next"),
    smaller = button("缩小", "pdf-smaller"),
    larger = button("放大", "pdf-larger"),
    download = button("下载 PDF", "pdf-download"),
    close = button("关闭完整书稿", "pdf-close");
  controls.append(previous, next, smaller, larger);
  pages.append(canvas);
  box.append(label, controls, pages, download, close);
  overlay.replaceChildren(box);
  close.style.cssText += ";width:100%;margin-top:8px";
  download.style.cssText += ";width:100%;margin-top:8px";
  let closed = false,
    settled = false,
    pdfDocument: PDFDocumentProxy | null = null,
    loading: PDFDocumentLoadingTask | null = null,
    rendering: RenderTask | null = null,
    pageNumber = 1,
    zoom = 1,
    busy = true;
  const controller = new AbortController();
  const fail = () => {
    if (!settled) {
      settled = true;
      options.fail?.({ errMsg: "openDocument:fail" });
    }
  };
  const active: OpenDocument = {
    filePath: options.filePath,
    close() {
      if (closed) return;
      closed = true;
      controller.abort();
      rendering?.cancel();
      box.remove();
      releaseFile(options.filePath);
      if (current === active) current = null;
      void (pdfDocument ? pdfDocument.destroy() : loading?.destroy())?.catch(
        () => {},
      );
      canvas.width = canvas.height = 0;
      fail();
    },
  };
  current = active;
  close.onclick = () => active.close();
  const update = () => {
    previous.disabled = busy || pageNumber <= 1;
    next.disabled = busy || !pdfDocument || pageNumber >= pdfDocument.numPages;
    smaller.disabled = busy || zoom <= 1;
    larger.disabled = busy || zoom >= 2;
    download.disabled = busy || !pdfDocument;
  };
  update();
  const showPage = async (number: number) => {
    if (!pdfDocument || closed) return;
    busy = true;
    update();
    const page = await pdfDocument.getPage(number),
      base = page.getViewport({ scale: 1 }),
      ratio = Math.min(window.devicePixelRatio || 1, 2),
      width = Math.max(160, pages.clientWidth - 2) * zoom;
    if (closed) return;
    const viewport = page.getViewport({ scale: (width / base.width) * ratio });
    if (viewport.width * viewport.height > 4_000_000)
      throw Error("PDF preview page exceeds the pixel limit");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    canvas.style.width = `${Math.ceil(viewport.width / ratio)}px`;
    canvas.style.height = `${Math.ceil(viewport.height / ratio)}px`;
    rendering = page.render({ canvas, viewport });
    await rendering.promise;
    if (closed) return;
    rendering = null;
    page.cleanup();
    pageNumber = number;
    busy = false;
    canvas.dataset.pageNumber = String(number);
    label.textContent = `第 ${number} / ${pdfDocument.numPages} 页`;
    pages.scrollTo(0, 0);
    update();
  };
  const navigate = (number: number, nextZoom = zoom) => {
    if (busy || closed) return;
    zoom = nextZoom;
    void showPage(number).catch(() => active.close());
  };
  previous.onclick = () => navigate(pageNumber - 1);
  next.onclick = () => navigate(pageNumber + 1);
  smaller.onclick = () => navigate(pageNumber, Math.max(1, zoom - 0.5));
  larger.onclick = () => navigate(pageNumber, Math.min(2, zoom + 0.5));
  download.onclick = () => {
    if (closed || !pdfDocument) return;
    const link = window.document.createElement("a");
    link.href = options.filePath;
    link.download = "时光里-完整书稿.pdf";
    link.click();
  };
  try {
    const [pdfjs, { default: workerUrl }, response] = await Promise.all([
      import("pdfjs-dist"),
      import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
      fetch(options.filePath, { signal: controller.signal }),
    ]);
    if (closed) return;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (closed) return;
    if (!response.ok || bytes.length > 32 * 1024 * 1024)
      throw Error("Invalid PDF download");
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    loading = pdfjs.getDocument({
      data: bytes,
      useSystemFonts: false,
      isEvalSupported: false,
    });
    pdfDocument = await loading.promise;
    if (closed) {
      await pdfDocument.destroy();
      return;
    }
    if (pdfDocument.numPages > 128)
      throw Error("PDF preview page count exceeds the limit");
    await showPage(1);
    if (!closed) {
      settled = true;
      options.success?.({ errMsg: "openDocument:ok" });
    }
  } catch {
    if (!closed) active.close();
  }
}

window.addEventListener("pagehide", () => closePdfDocument());
document.addEventListener("visibilitychange", () => {
  if (document.hidden) closePdfDocument();
});
