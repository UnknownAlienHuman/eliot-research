import type { Actor } from "./auth";
import type { Block } from "./blocks";
import { LibraryError } from "./library";

interface ReadableRevision { id: string; readable_state: string; readable_size: number | null; original_key: string; original_filename: string }
async function revision(env: Env, id: string) {
  const row = await env.DB.prepare(`SELECT r.* FROM source_revision r JOIN source s ON s.id=r.source_id
    WHERE r.id=? AND r.deleted_at IS NULL AND s.state!='deleted'`).bind(id).first<ReadableRevision>();
  if (!row) throw new LibraryError("not_found", "Source revision not found.", 404);
  return row;
}
function requireReadable(row: ReadableRevision) {
  if (!["readable", "readable_with_warnings"].includes(row.readable_state)) {
    throw new LibraryError("conflict", "Readable text is not available. You can still download the original.", 409);
  }
}
export async function readText(env: Env, _actor: Actor, id: string, range?: { start: number; end: number }) {
  const row = await revision(env, id);
  requireReadable(row);
  if (range && (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)
    || range.start < 0 || range.end <= range.start || range.end > (row.readable_size ?? 0))) {
    throw new LibraryError("invalid", "The passage range is outside this revision.", 400);
  }
  const object = await env.BUCKET.get(`source/${id}/text.md`, range ? { range: { offset: range.start, length: range.end - range.start } } : undefined);
  if (!object) throw new LibraryError("not_found", "Readable text is missing from storage.", 404);
  if (!range) return new Response(object.body, { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
  const bytes = await object.arrayBuffer();
  if (bytes.byteLength !== range.end - range.start) throw new LibraryError("unavailable", "The stored passage was incomplete.", 503);
  try { new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new LibraryError("invalid", "The passage must start and end on UTF-8 boundaries.", 400); }
  return new Response(bytes, { headers: { "Content-Type": "text/plain; charset=utf-8", "Content-Range": `bytes ${range.start}-${range.end - 1}/${row.readable_size}` } });
}
export async function readOutline(env: Env, _actor: Actor, id: string) {
  requireReadable(await revision(env, id));
  const object = await env.BUCKET.get(`source/${id}/blocks.json`);
  if (!object) throw new LibraryError("not_found", "Outline is missing from storage.", 404);
  return { blocks: await object.json<Block[]>() };
}
export async function readOriginal(env: Env, _actor: Actor, id: string) {
  const row = await revision(env, id);
  const object = await env.BUCKET.get(row.original_key);
  if (!object) throw new LibraryError("not_found", "Original file is missing from storage.", 404);
  return new Response(object.body, { headers: { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(row.original_filename)}` } });
}
