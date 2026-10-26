// K1 ingest conversion helpers. Production use only: imported by
// src/workflows/ingest.ts. No test-only exports.

export type IngestConverter = "local_text" | "owner_markdown" | "workers_ai_markdown";

export interface SupportedFormat {
  mimeType: string;
  extension: string;
}

let supportedCache: SupportedFormat[] | undefined;

export function stripBomOnce(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// Strict UTF-8 decode of the stored original with exactly one leading BOM
// removed, so canonical byte offset 0 matches the whole text. ignoreBOM keeps
// the decoder from stripping it first (that stripped two). Null when invalid.
export function decodeOriginal(bytes: ArrayBuffer): string | null {
  try {
    return stripBomOnce(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    return null;
  }
}

// Zero-copy BOM peek over the stored bytes (a view, not a copy).
export function hasUtf8Bom(bytes: ArrayBuffer): boolean {
  const prefix = new Uint8Array(bytes, 0, Math.min(3, bytes.byteLength));
  return prefix.length === 3 && prefix[0] === 0xef && prefix[1] === 0xbb && prefix[2] === 0xbf;
}

// Native text never touches Workers AI. Owner Markdown keeps its own
// converter so the reader can distinguish owner-supplied text.
export function nativeConverter(mime: string, filename: string): IngestConverter | null {
  const type = mime.toLowerCase();
  const name = filename.toLowerCase();
  if (type === "text/markdown" || name.endsWith(".md") || name.endsWith(".markdown")) {
    return "owner_markdown";
  }
  if (type === "text/plain" || name.endsWith(".txt")) {
    return "local_text";
  }
  return null;
}

// Images and scans never reach Workers AI in K1: even with image conversion
// options disabled, the image model path is model-assisted. They retain the
// original and report needs_conversion.
const IMAGE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "tif", "tiff", "avif", "heic", "heif",
]);

export function isImageInput(mime: string, filename: string): boolean {
  if (mime.toLowerCase().startsWith("image/")) return true;
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  return IMAGE_EXTENSIONS.has(ext);
}

// Cache supported() per isolate: one discovery call, reused every revision.
export async function getSupportedFormats(ai: Ai): Promise<SupportedFormat[]> {
  if (supportedCache === undefined) {
    supportedCache = await ai.toMarkdown().supported();
  }
  return supportedCache;
}

export function isSupportedFormat(
  mime: string,
  filename: string,
  supported: SupportedFormat[],
): boolean {
  const type = mime.toLowerCase();
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  return supported.some(
    (format) =>
      format.mimeType.toLowerCase() === type ||
      (ext !== "" && format.extension.toLowerCase().replace(/^\./, "") === ext),
  );
}

// Single-attempt timeout. toMarkdown runs once per revision (retries 0);
// a timeout becomes a failed revision, never an automatic retry.
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Conversion timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}
