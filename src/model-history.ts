import type { Citation } from "./citations";
import { MATERIALIZATION_BYTES, reserve } from "./context";
import type { ContextHistoryReader, HistoryExchange, HistoryStep, Materialization } from "./context";
import { LibraryError } from "./library";

// A query returns one bounded identity plus scalar metadata, never a page of bodies.
// 512 bytes cover the bounded UTF-16 identity; the remaining 512 cover the scalar
// fields/result wrapper. This is not a row-count or history-retention limit.
const QUERY_BYTES = 1024;
const UNAVAILABLE = "Conversation history changed while preparing this answer. Try again.";
type Identity = { id: string | null; createdAt: number; version: number; payloadBytes: number };
type Metadata = {
  eligible: number; partial: number; inScope: number;
  questionBytes: number; answerBytes: number; revisionsBytes: number; citationsBytes: number;
  revisionCount: number; citationCount: number;
};
type Fragments = { question: string; answer: string; revisionIds: string; citations: string };

function fits(assembly: Materialization, bytes: number): boolean {
  return Number.isSafeInteger(bytes) && bytes >= 0 && bytes <= MATERIALIZATION_BYTES - assembly.used;
}
function unavailable(): never { throw new LibraryError("unavailable", UNAVAILABLE, 503); }

/** Independent from owner-visible paging: advance one immutable raw-row key at a
 * time, then let context assembly decide how many complete exchanges fit. */
export function createModelHistoryReader(sql: SqlStorage, currentTurnId: string): ContextHistoryReader {
  return (frozen, assembly) => {
    let before: { id: string; createdAt: number } | undefined;
    let scannedBytes = 0, done = false;
    let frozenJson: string | undefined;
    const limited = (): HistoryStep => { done = true; return { kind: "limited" }; };
    return { next(): HistoryStep {
      if (done) return { kind: "end" };
      if (!fits(assembly, QUERY_BYTES)) return limited();
      reserve(assembly, QUERY_BYTES);
      // octet_length(column) reads SQLite's stored length without loading/parsing
      // the JSON. CASE also bounds corrupt IDs before they cross into JavaScript;
      // accepted turn IDs contain at most 128 characters (at most 512 UTF-8 bytes).
      // Qualify ORDER BY: bare id resolves to the CASE alias and defeats the index.
      const row = sql.exec<Identity>(
        "SELECT CASE WHEN octet_length(id)<=512 AND length(id)<=128 THEN id END AS id,created_at AS createdAt," +
        "history_version AS version,octet_length(payload) AS payloadBytes FROM turns " +
        (before ? "WHERE (created_at,id)<(?,?) " : "") +
        "ORDER BY turns.created_at DESC,turns.id DESC LIMIT 1", ...(before ? [before.createdAt, before.id] : []),
      ).toArray()[0];
      if (!row) { done = true; return { kind: "end" }; }
      if (row.id === null) return limited();
      const id = row.id;
      before = { id, createdAt: row.createdAt };
      if (id === currentTurnId) return { kind: "ignored" };
      if (!Number.isSafeInteger(row.payloadBytes) || row.payloadBytes < 0 ||
        row.payloadBytes > MATERIALIZATION_BYTES - scannedBytes) return limited();
      // One cumulative raw-byte allowance covers JSON metadata and lazy fragment
      // reads, including failed/scope-rejected rows. No JSON WHERE predicate can
      // scan an unbounded run of ineligible rows behind LIMIT.
      if (frozenJson === undefined) {
        let bytes = 128;
        for (const id of frozen) bytes += 32 + 12 * id.length;
        if (!fits(assembly, bytes)) return limited();
        reserve(assembly, bytes);
        frozenJson = JSON.stringify([...frozen]);
      }
      if (!fits(assembly, QUERY_BYTES)) return limited();
      reserve(assembly, QUERY_BYTES);
      scannedBytes += row.payloadBytes;
      const metadata = sql.exec<Metadata>(
        "SELECT (json_extract(payload,'$.state')='completed' OR " +
        "(json_extract(payload,'$.state')='partial' AND json_array_length(payload,'$.citations')>0)) AS eligible," +
        "(json_extract(payload,'$.state')='partial') AS partial," +
        "NOT EXISTS (SELECT 1 FROM json_each(payload,'$.citations') AS c WHERE json_extract(c.value,'$.revisionId') IS NULL OR " +
        "json_extract(c.value,'$.revisionId') NOT IN (SELECT value FROM json_each(?))) AS inScope," +
        "octet_length(payload -> '$.question') AS questionBytes,octet_length(payload -> '$.answer') AS answerBytes," +
        "octet_length(coalesce(payload -> '$.revisionIds','[]')) AS revisionsBytes," +
        "octet_length(coalesce(payload -> '$.citations','[]')) AS citationsBytes," +
        "coalesce(json_array_length(payload,'$.revisionIds'),0) AS revisionCount," +
        "coalesce(json_array_length(payload,'$.citations'),0) AS citationCount " +
        "FROM turns WHERE id=? AND created_at=? AND history_version=?",
        frozenJson, id, row.createdAt, row.version,
      ).toArray()[0];
      if (!metadata) unavailable();
      if (!metadata.eligible) return { kind: "ignored" };
      if (!metadata.inScope) return { kind: "omitted" };
      const sizes = [metadata.questionBytes, metadata.answerBytes, metadata.revisionsBytes, metadata.citationsBytes,
        metadata.revisionCount, metadata.citationCount];
      if (sizes.some(size => !Number.isSafeInteger(size) || size < 0)) unavailable();
      // Reserve the possible second raw read now so later metadata reads cannot
      // consume its allowance while this candidate waits for source assembly.
      if (row.payloadBytes > MATERIALIZATION_BYTES - scannedBytes) return limited();
      scannedBytes += row.payloadBytes;
      const bytes = QUERY_BYTES + 4 * (metadata.questionBytes + metadata.answerBytes + metadata.revisionsBytes + metadata.citationsBytes)
        + 64 * metadata.revisionCount + 512 * metadata.citationCount;
      let cached: HistoryExchange | undefined;
      return { kind: "candidate", candidate: {
        tokens: Math.ceil((27 + metadata.questionBytes) / 3) + 32 + Math.ceil((32 + metadata.answerBytes) / 3) + 32,
        get bytes() { return cached ? 0 : bytes; }, partial: !!metadata.partial,
        load(): HistoryExchange {
          if (cached) return cached;
          // Includes UTF-16 transfer strings, JSON.parse strings/arrays/objects,
          // citation-derived revision references, and the bounded result row.
          reserve(assembly, bytes);
          const fragments = sql.exec<Fragments>(
            "SELECT payload -> '$.question' AS question,payload -> '$.answer' AS answer," +
            "coalesce(payload -> '$.revisionIds','[]') AS revisionIds,coalesce(payload -> '$.citations','[]') AS citations " +
            "FROM turns WHERE id=? AND created_at=? AND history_version=?",
            id, row.createdAt, row.version,
          ).toArray()[0];
          if (!fragments) unavailable();
          // JSON fragments, rather than SQLite TEXT extraction, preserve NUL and
          // escaped lone UTF-16 surrogates exactly through the SQLite boundary.
          const question: unknown = JSON.parse(fragments.question), answer: unknown = JSON.parse(fragments.answer);
          const revisionIds: unknown = JSON.parse(fragments.revisionIds), citations: Citation[] = JSON.parse(fragments.citations) as Citation[];
          if (typeof question !== "string" || typeof answer !== "string" || !Array.isArray(revisionIds) || !Array.isArray(citations)) unavailable();
          cached = {
            user: { role: "user", content: question, revisionIds: revisionIds as string[] },
            assistant: { role: "assistant", content: answer, turnId: id, revisionIds: citations.map(citation => citation.revisionId),
              citations, ...(metadata.partial ? { partial: true } : {}) },
          };
          return cached;
        },
      } };
    } };
  };
}
