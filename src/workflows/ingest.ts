// K1 ingest workflow. Started once per revision by the Library API with the
// deterministic id `ingest-<revisionId>`; this class never starts itself.
// Bodies stay in R2, steps carry IDs and counts only. No automatic retry:
// every failure path marks the revision and returns normally.
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { decodeOriginal, getSupportedFormats, hasUtf8Bom, isImageInput, isSupportedFormat } from "../ingest";
import { nativeConverter, stripBomOnce, withTimeout } from "../ingest";
import { scanBlocks } from "../blocks";
import type { Block } from "../blocks";

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

// Every step runs once: a retried convert/store step would repeat toMarkdown
// (spend) and silently overwrite the canonical R2 keys it just wrote.
const NO_RETRY = { retries: { limit: 0, delay: "1 second" } } as const;

// Operator diagnostic: error name/message only, bounded. Never headers,
// response bodies, file bytes, or secrets.
function boundedError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 300);
  return "unknown error";
}

interface LoadedRevision {
  revisionId: string;
  sourceId: string;
  revisionNo: number;
  mime: string;
  filename: string;
  originalKey: string;
}

type Stored =
  | { outcome: "failed"; error: string; tokens: number | null; calls: number; ms: number }
  | { outcome: "needs_conversion"; warning: string; tokens: number | null; calls: number; ms: number }
  | { outcome: "readable"; converter: string; readableSize: number; blockCount: number; warning: string | null; tokens: number | null; calls: number; ms: number };

export class IngestWorkflow extends WorkflowEntrypoint<Env, { revisionId: string }> {
  async run(event: Readonly<WorkflowEvent<{ revisionId: string }>>, step: WorkflowStep): Promise<unknown> {
    const revisionId = event.payload.revisionId;
    const loaded = await step.do("load revision", NO_RETRY, async () => loadRevision(this.env, revisionId));
    if (loaded === null) return { revisionId, outcome: "unknown-revision" };
    const stored = await step.do("convert and store", NO_RETRY, async () => convertAndStore(this.env, loaded));
    const outcome = await step.do("commit revision", NO_RETRY, async () => commitRevision(this.env, loaded, stored));
    return { revisionId, ...outcome };
  }
}

async function loadRevision(env: Env, revisionId: string): Promise<LoadedRevision | null> {
  const row = await env.DB.prepare("SELECT id, source_id, revision_no, original_key, original_mime, original_filename FROM source_revision WHERE id = ?").bind(revisionId).first<{
    id: string; source_id: string; revision_no: number; original_key: string | null; original_mime: string | null; original_filename: string | null;
  }>();
  if (row === null) return null;
  return {
    revisionId: row.id, sourceId: row.source_id, revisionNo: row.revision_no,
    mime: row.original_mime ?? "application/octet-stream", filename: row.original_filename ?? row.id,
    originalKey: row.original_key ?? `source/${row.id}/original`,
  };
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
      await env.DB.prepare("UPDATE source_revision SET conversion_calls = 1, converter = 'workers_ai_markdown' WHERE id = ?").bind(loaded.revisionId).run();
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
        const detail = typeof response.error === "string" && response.error.length > 0 ? response.error.slice(0, 200) : "no detail";
        console.error("ingest conversion provider error", detail);
        return fail(`${CONVERT_FAILED} Provider said: ${detail}`);
      }
      if (response.format !== "markdown") {
        // Shape metadata only, never data or file bytes: determines the
        // runtime array-vs-object binding behavior on unexpected shapes.
        const shape = response as unknown as Record<string, unknown>;
        console.error(
          "ingest conversion unexpected format",
          JSON.stringify({ isArray: Array.isArray(response), keys: Object.keys(response).slice(0, 12), format: shape.format }).slice(0, 600),
        );
        return fail(CONVERT_FAILED);
      }
      // Tokens are recorded when Cloudflare returns them, otherwise NULL
      // (unknown); valid text is never failed for missing usage.
      tokens = Number.isSafeInteger(response.tokens) && response.tokens >= 0 ? response.tokens : null;
      data = stripBomOnce(response.data);
    } catch (error) {
      console.error("ingest conversion threw", boundedError(error));
      return fail(CONVERT_FAILED);
    }
    // Empty AI output means a scan with no extractable text: keep the original
    // and report needs_conversion, not failure. The call already happened.
    if (data.trim().length === 0) {
      return { outcome: "needs_conversion", warning: "No extractable text was found in this file; the original is kept.", tokens, calls, ms: Date.now() - started };
    }
    return await storeReadable(env, loaded, data, "workers_ai_markdown", null, tokens, calls, started, null);
  } catch (error) {
    console.error("ingest convert/store threw", boundedError(error));
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
  // A Uint8Array view over the stored bytes: zero-copy reuse for BOM-free
  // 25 MiB natives instead of a second full-size allocation.
  const body: Uint8Array = reuseBytes !== null ? new Uint8Array(reuseBytes) : new TextEncoder().encode(text);
  await env.BUCKET.put(`source/${loaded.revisionId}/text.md`, body, { httpMetadata: { contentType: "text/markdown; charset=utf-8" } });
  await env.BUCKET.put(`source/${loaded.revisionId}/blocks.json`, JSON.stringify(blocks), { httpMetadata: { contentType: "application/json; charset=utf-8" } });
  return { outcome: "readable", converter, readableSize: body.byteLength, blockCount: blocks.length, warning, tokens, calls, ms: Date.now() - started };
}

async function commitRevision(env: Env, loaded: LoadedRevision, stored: Stored): Promise<{ outcome: string; advanced: boolean }> {
  if (stored.outcome === "failed") {
    await env.DB.prepare("UPDATE source_revision SET readable_state = 'failed', error = ?, conversion_tokens = ?, conversion_calls = ?, conversion_ms = ? WHERE id = ?").bind(stored.error, stored.tokens, stored.calls, stored.ms, loaded.revisionId).run();
    return { outcome: "failed", advanced: false };
  }
  if (stored.outcome === "needs_conversion") {
    await env.DB.prepare("UPDATE source_revision SET readable_state = 'needs_conversion', warning_summary = ?, conversion_tokens = ?, conversion_calls = ?, conversion_ms = ? WHERE id = ?").bind(stored.warning, stored.tokens, stored.calls, stored.ms, loaded.revisionId).run();
    return { outcome: "needs_conversion", advanced: false };
  }
  const state = stored.warning === null ? "readable" : "readable_with_warnings";
  await env.DB.prepare("UPDATE source_revision SET readable_state = ?, converter = ?, readable_size = ?, block_count = ?, warning_summary = ?, error = NULL, conversion_tokens = ?, conversion_calls = ?, conversion_ms = ? WHERE id = ?")
    .bind(state, stored.converter, stored.readableSize, stored.blockCount, stored.warning, stored.tokens, stored.calls, stored.ms, loaded.revisionId).run();
  // current_revision_id is the newest READABLE revision, never a pending one.
  // Advance only while this revision is still the newest readable revision.
  const newest = await env.DB.prepare("SELECT id FROM source_revision WHERE source_id = ? AND readable_state IN ('readable', 'readable_with_warnings') ORDER BY revision_no DESC LIMIT 1").bind(loaded.sourceId).first<{ id: string }>();
  if (newest === null || newest.id !== loaded.revisionId) return { outcome: state, advanced: false };
  const head = await env.DB.prepare("SELECT current_revision_id FROM source WHERE id = ?").bind(loaded.sourceId).first<{ current_revision_id: string | null }>();
  if (head === null || head.current_revision_id === loaded.revisionId) return { outcome: state, advanced: false };
  // Atomic guard: a newer readable revision committed after our select must win.
  const guard = "AND NOT EXISTS (SELECT 1 FROM source_revision WHERE source_id = ? AND id != ? AND revision_no > ? AND readable_state IN ('readable', 'readable_with_warnings'))";
  const now = Date.now();
  const advanced = head.current_revision_id === null
    ? await env.DB.prepare(`UPDATE source SET current_revision_id = ?, updated_at = ? WHERE id = ? AND current_revision_id IS NULL ${guard}`).bind(loaded.revisionId, now, loaded.sourceId, loaded.sourceId, loaded.revisionId, loaded.revisionNo).run()
    : await env.DB.prepare(`UPDATE source SET current_revision_id = ?, updated_at = ? WHERE id = ? AND current_revision_id = ? ${guard}`).bind(loaded.revisionId, now, loaded.sourceId, head.current_revision_id, loaded.sourceId, loaded.revisionId, loaded.revisionNo).run();
  if ((advanced.meta.changes ?? 0) > 0) return { outcome: state, advanced: true };
  // Lost the race: a newer readable revision is (or became) current. This text
  // stays readable for existing citations, but the conflict is visible.
  const conflict = "A newer revision is current; this text stays available for existing citations.";
  await env.DB.prepare("UPDATE source_revision SET readable_state = 'readable_with_warnings', warning_summary = ? WHERE id = ?").bind(conflict, loaded.revisionId).run();
  return { outcome: "readable_with_warnings", advanced: false };
}
