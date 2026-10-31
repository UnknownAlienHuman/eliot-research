import type { PDFPageProxy, RenderTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { OCR_LIMITS } from "../shared/api";

export async function loadPdfPages(bytes: ArrayBuffer, signal?: AbortSignal): Promise<{
  pageCount: number;
  sha256: string;
  renderPage(pageNumber: number): Promise<Blob>;
  destroy(): Promise<void>;
}> {
  signal?.throwIfAborted();
  // PDF.js transfers the data buffer to its worker; hash before handing it over.
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  // The package's typed entry resolves to build/pdf.mjs in the pinned release.
  const { getDocument, GlobalWorkerOptions } = await import("pdfjs-dist");
  signal?.throwIfAborted();
  const worker = new URL(workerUrl, window.location.href);
  if (worker.origin !== window.location.origin) throw new Error("The PDF worker must use the same origin.");
  GlobalWorkerOptions.workerSrc = worker.href;
  // PDF.js 6 removed isEvalSupported and its dynamic-eval implementation.
  // No resource base URLs: missing embedded resources must not fetch from a CDN.
  const loading = getDocument({ data: new Uint8Array(bytes), useWorkerFetch: false, useWasm: false,
    enableXfa: false, stopAtErrors: true });
  let closed = false;
  let rendering: RenderTask | undefined;
  let pending: Promise<Blob> | undefined;
  let destroyed: Promise<void> | undefined;
  function destroy(): Promise<void> {
    if (destroyed) return destroyed;
    closed = true;
    signal?.removeEventListener("abort", abort);
    rendering?.cancel();
    destroyed = (async () => {
      try { await loading.destroy(); }
      finally { await pending?.catch(() => undefined); }
    })();
    return destroyed;
  }
  function abort() { void destroy().catch(() => undefined); }
  function assertOpen() {
    signal?.throwIfAborted();
    if (closed) throw new Error("This PDF renderer is closed.");
  }
  signal?.addEventListener("abort", abort, { once: true });
  try {
    assertOpen();
    const pdf = await loading.promise;
    assertOpen();
    if (!Number.isSafeInteger(pdf.numPages) || pdf.numPages < 1 || pdf.numPages > OCR_LIMITS.maxPages)
      throw new Error(`The PDF must contain 1–${OCR_LIMITS.maxPages} pages; no pages were truncated.`);
    return { pageCount: pdf.numPages, sha256, destroy,
      async renderPage(pageNumber: number): Promise<Blob> {
        assertOpen();
        if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > pdf.numPages)
          throw new Error("Choose an existing PDF page number.");
        if (pending) throw new Error("Render one PDF page at a time.");
        pending = (async () => {
          let page: PDFPageProxy | undefined;
          const canvas = document.createElement("canvas");
          try {
            page = await pdf.getPage(pageNumber);
            assertOpen();
            const base = page.getViewport({ scale: 1 }); // Includes the page's intrinsic rotation.
            if (![base.width, base.height].every((value) => Number.isFinite(value) && value > 0))
              throw new Error("The PDF page has invalid dimensions.");
            const longest = Math.max(base.width, base.height);
            const minimumEdge = 768;
            let edge: number = OCR_LIMITS.renderLongEdge;
            for (;;) {
              assertOpen();
              canvas.width = Math.max(1, Math.floor(edge * base.width / longest));
              canvas.height = Math.max(1, Math.floor(edge * base.height / longest));
              if (canvas.width * canvas.height > OCR_LIMITS.pagePixels)
                throw new Error("The PDF page exceeds the raster pixel limit.");
              // Fit the complete viewport inside integer canvas dimensions, without cropping.
              const viewport = page.getViewport({ scale: Math.min(canvas.width / base.width, canvas.height / base.height) });
              rendering = page.render({ canvas, viewport, background: "white" });
              await rendering.promise;
              rendering = undefined;
              assertOpen();
              const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => {
                if (blob && blob.size > 0 && blob.type === "image/png") resolve(blob);
                else reject(new Error("The browser could not encode this PDF page as PNG."));
              }, "image/png"));
              assertOpen();
              if (png.size <= OCR_LIMITS.pageBytes) return png;
              if (edge <= minimumEdge)
                throw new Error("The complete page PNG exceeds 1 MiB at the minimum raster size. No page was cropped.");
              edge = Math.max(minimumEdge, Math.floor(edge * 0.75));
            }
          } catch (error) {
            signal?.throwIfAborted();
            throw error;
          } finally {
            rendering = undefined;
            page?.cleanup();
            canvas.width = canvas.height = 0;
          }
        })();
        try { return await pending; }
        finally { pending = undefined; }
      },
    };
  } catch (error) {
    await destroy();
    signal?.throwIfAborted();
    throw error;
  }
}
