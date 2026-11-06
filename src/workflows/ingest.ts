// K1 ingest workflow. Started once per revision by the Library API with the
// deterministic id `ingest-<revisionId>`; this class never starts itself.
// Bodies stay in R2. Only storage load/commit retry; convert/store runs once.
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { decodeOriginal, getSupportedFormats, hasUtf8Bom, isImageInput, isSupportedFormat } from "../ingest";
import { nativeConverter, readableTextWarning, stripBomOnce, withTimeout } from "../ingest";
import { scanBlocks } from "../blocks";
import type { Block } from "../blocks";
import { safeErrorLogProjection } from "../model-transport";
import { commitRevision, loadRevision, recordStorageFailure } from "../ingest-completion";
import type { LoadedRevision, Stored } from "../ingest-completion";

// Single conversion attempt bound: a stated workflow bound, not a documented hard limit.
const CONVERT_TIMEOUT_MS = 60_000;
// K1 rule: no model-assisted image/OCR conversion.
const NO_MODEL_IMAGES = { convert: false, maxConvertedImages: 0 } as const;
const AI_OPTIONS = {
  conversionOptions: {
    output: { format: "markdown" },
    html: { images: { ...NO_MODEL_IMAGES } },
    docx: { images: { ...NO_MODEL_IMAGES } },
    pdf: { images: { ...NO_MODEL_IMAGES }, metadata: false },
  },
} as const;
const CONVERT_FAILED = "Eliot could not convert this file to readable text. The original is kept.";

const NO_RETRY = { retries: { limit: 0, delay: "1 second" } } as const;
const STORAGE_RETRY = { retries: { limit: 2, delay: "1 second" }, timeout: "30 seconds" } as const;

export class IngestWorkflow extends WorkflowEntrypoint<Env, { revisionId: string }> {
  async run(event: Readonly<WorkflowEvent<{ revisionId: string }>>, step: WorkflowStep): Promise<unknown> {
    const revisionId = event.payload.revisionId;
    let stored: Stored | undefined;
    try {
      const loaded = await step.do("load revision", STORAGE_RETRY, async () => loadRevision(this.env, revisionId));
      if (loaded === null) return { revisionId, outcome: "unknown-revision" };
      stored = await step.do("convert and store", NO_RETRY, async () => convertAndStore(this.env, loaded));
      const completed = stored;
      const outcome = await step.do("commit revision", STORAGE_RETRY, async () => commitRevision(this.env, loaded, completed));
      return { revisionId, stored, ...outcome };
    } catch {
      try { await step.do("record storage failure", STORAGE_RETRY, () => recordStorageFailure(this.env, revisionId, stored)); } catch { /* Source read exposes unconfirmed storage status. */ }
      return { revisionId, stored, completionPending: true };
    }
  }
}

async function convertAndStore(env: Env, loaded: LoadedRevision): Promise<Stored> {
  const started = Date.now();
  // Unknown until measured: NULL in the row means Cloudflare reported nothing.
  let tokens: number | null = null;
  let calls = 0;
  const fail = (error: string): Stored => ({ outcome: "failed", error, tokens, calls, ms: Date.now() - started });
  // Every stage settles to a Stored row: with step retries at 0 a throw here
  // would otherwise leave the revision pending forever.
  try {
    const object = await env.BUCKET.get(loaded.originalKey);
    if (object === null) return fail("The stored original is missing. Upload the file again to retry.");
    const bytes = await object.arrayBuffer();
    const native = nativeConverter(loaded.mime, loaded.filename);
    if (native !== null) {
      tokens = 0; // Native conversion makes no model call: zero usage is known.
      const text = decodeOriginal(bytes);
      if (text === null) return fail("This file is not valid UTF-8 text. Upload a UTF-8 or Markdown version.");
      if (text.trim().length === 0) return fail("This file contains no readable text.");
      // No BOM means the stored bytes already are the canonical encoding.
      return await storeReadable(env, loaded, text, native, null, tokens, calls, started, hasUtf8Bom(bytes) ? null : bytes);
    }
    if (isImageInput(loaded.mime, loaded.filename)) {
      return { outcome: "needs_conversion", warning: "Preview is not available for this file yet; the original is kept.", tokens, calls, ms: Date.now() - started };
    }
    // Missing AI binding fails visible with calls 0: nothing is dispatched.
    if (env.AI === undefined || typeof env.AI.toMarkdown !== "function") {
      return fail("Document conversion is not configured. The original is kept.");
    }
    if (!isSupportedFormat(loaded.mime, loaded.filename, await getSupportedFormats(env.AI))) {
      return { outcome: "needs_conversion", warning: "Preview is not available for this file yet; the original is kept.", tokens, calls, ms: Date.now() - started };
    }
    // Code controls risk: usage is accounted before dispatch. If this persist
    // fails, the file is never sent for conversion. Converter is set here so a
    // failed row honestly shows which path was attempted.
    try {
      const claimed = await env.DB.prepare("UPDATE source_revision SET conversion_calls = 1, converter = 'workers_ai_markdown' WHERE id = ? AND conversion_calls=0 AND readable_state='pending' AND deleted_at IS NULL").bind(loaded.revisionId).run();
      if (claimed.meta.changes !== 1) return fail("Conversion was already claimed or its outcome is unknown. It will not be sent again; replace the source to retry deliberately.");
    } catch {
      return fail("Eliot could not record conversion usage, so the file was not sent for conversion. Try again.");
    }
    calls = 1;
    let data: string;
    try {
      // The service validates the Blob MIME as a non-empty string: isolated run
      // failed with AiInternalError on an untyped Blob, so pass the stored MIME.
      const response = await withTimeout(env.AI.toMarkdown().transform({ name: loaded.filename, blob: new Blob([bytes], { type: loaded.mime }) }, AI_OPTIONS), CONVERT_TIMEOUT_MS);
      if (response.format === "error") {
        console.error("ingest conversion provider error", { code: "provider_error" });
        return fail(CONVERT_FAILED);
      }
      if (response.format !== "markdown") {
        console.error("ingest conversion unexpected format", { code: "unexpected_format" });
        return fail(CONVERT_FAILED);
      }
      // Tokens are recorded when Cloudflare returns them, otherwise NULL
      // (unknown); valid text is never failed for missing usage.
      tokens = Number.isSafeInteger(response.tokens) && response.tokens >= 0 ? response.tokens : null;
      data = stripBomOnce(response.data);
    } catch (error) {
      console.error("ingest conversion threw", safeErrorLogProjection(error));
      return fail(CONVERT_FAILED);
    }
    // Empty AI output means a scan with no extractable text: keep the original
    // and report needs_conversion, not failure. The call already happened.
    if (data.trim().length === 0) {
      return { outcome: "needs_conversion", warning: "No extractable text was found in this file; the original is kept.", tokens, calls, ms: Date.now() - started };
    }
    return await storeReadable(env, loaded, data, "workers_ai_markdown", null, tokens, calls, started, null);
  } catch (error) {
    console.error("ingest convert/store threw", safeErrorLogProjection(error));
    return fail(CONVERT_FAILED);
  }
}

async function storeReadable(env: Env, loaded: LoadedRevision, text: string, converter: string, warning: string | null, tokens: number | null, calls: number, started: number, reuseBytes: ArrayBuffer | null): Promise<Stored> {
  const blocks: Block[] = scanBlocks(text);
  // K1 scan fallback (no OCR): PDF output with no body blocks is a scan, not
  // readable text. Native/Markdown paths are exempt: their headings are real.
  if (loaded.mime === "application/pdf" && (blocks.length === 0 || blocks.every((block) => block.type === "heading"))) {
    return { outcome: "needs_conversion", warning: "No extractable text was found in this file; the original is kept.", tokens, calls, ms: Date.now() - started };
  }
  warning ??= readableTextWarning(text);
  // A Uint8Array view over the stored bytes: zero-copy reuse for BOM-free
  // 25 MiB natives instead of a second full-size allocation.
  const body: Uint8Array = reuseBytes !== null ? new Uint8Array(reuseBytes) : new TextEncoder().encode(text);
  const textObject = await env.BUCKET.put(`source/${loaded.revisionId}/text.md`, body, { onlyIf: { etagDoesNotMatch: "*" }, httpMetadata: { contentType: "text/markdown; charset=utf-8" } });
  if (!textObject) throw new Error("Canonical text already exists; it is not overwritten.");
  const blocksObject = await env.BUCKET.put(`source/${loaded.revisionId}/blocks.json`, JSON.stringify(blocks), { onlyIf: { etagDoesNotMatch: "*" }, httpMetadata: { contentType: "application/json; charset=utf-8" } });
  if (!blocksObject) throw new Error("Canonical blocks already exist; they are not overwritten.");
  return { outcome: "readable", converter, readableSize: body.byteLength, blockCount: blocks.length, warning, tokens, calls, ms: Date.now() - started, textEtag: textObject.etag, blocksEtag: blocksObject.etag };
}
