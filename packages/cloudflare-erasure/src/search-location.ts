import type {
  ErasureRequest,
  AbsenceVerificationReceipt,
  ErasureFence,
  PurgeAttemptReceipt,
  PurgeTarget,
} from "@eliotr/contracts";
import {
  assertErasureIdentifier,
  canonicalErasureJson,
  erasureSha256Utf8,
  erasureFail,
  isoFromMs,
  stableErasureId,
} from "./canonical.js";
import type { ErasureLocationPort } from "./types.js";

interface SearchTarget {
  readonly source_revision_ref: string;
  readonly projection_generation: string;
}

function parseTarget(target: PurgeTarget): SearchTarget | null {
  if (target.target_kind === "LOCATION_EMPTY_PROOF") return null;
  if (!target.canonical_ref.startsWith("d1-search:")) {
    erasureFail("ERASURE_INPUT_INVALID", `unsupported D1 Search erasure target ${target.canonical_ref}`);
  }
  const body = target.canonical_ref.slice("d1-search:".length);
  const separator = body.lastIndexOf(":");
  if (separator < 1) erasureFail("ERASURE_INPUT_INVALID", "D1 Search erasure target is incomplete");
  return {
    source_revision_ref: assertErasureIdentifier(body.slice(0, separator), "search source revision"),
    projection_generation: assertErasureIdentifier(body.slice(separator + 1), "search projection generation"),
  };
}

async function itemKeys(
  database: D1Database,
  parsed: SearchTarget,
): Promise<readonly string[]> {
  const result = await database.prepare(
    "SELECT item_key FROM projection_item WHERE source_revision_ref=?1 " +
    "AND projection_generation=?2 ORDER BY item_key LIMIT 100000",
  ).bind(parsed.source_revision_ref, parsed.projection_generation).all<{ item_key: unknown }>();
  if ((result as { readonly success?: boolean }).success === false) erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "D1 Search item inventory failed", true);
  return (result.results ?? []).map((row) => assertErasureIdentifier(row.item_key, "search item key"));
}

async function count(
  database: D1Database,
  parsed: SearchTarget,
): Promise<number> {
  const row = await database.prepare(
    "SELECT COUNT(*) AS count FROM projection_item WHERE source_revision_ref=?1 " +
    "AND projection_generation=?2",
  ).bind(parsed.source_revision_ref, parsed.projection_generation).first<{ count: number }>();
  if (row === null || !Number.isSafeInteger(row.count) || row.count < 0) {
    erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "D1 Search absence count is malformed", true);
  }
  return row.count;
}

async function receipt(
  prefix: string,
  request: ErasureRequest,
  target: PurgeTarget,
  state: string,
): Promise<string> {
  return stableErasureId(
    prefix,
    request.erasure_ref.id,
    String(request.erasure_ref.revision),
    target.target_id,
    state,
  );
}

export interface D1SearchErasureLocationDependencies {
  readonly database: D1Database;
  readonly now?: () => number;
}

export function createD1SearchErasureLocationPort(
  dependencies: D1SearchErasureLocationDependencies,
): ErasureLocationPort {
  const database = dependencies.database;
  const clock = dependencies.now ?? Date.now;

  return {
    async purge(request, _fence, target): Promise<PurgeAttemptReceipt> {
      const parsed = parseTarget(target);
      if (parsed === null) {
        return {
          target_id: target.target_id,
          disposition: "ALREADY_ABSENT",
          receipt_ref: await receipt("delete-search", request, target, "empty"),
        };
      }
      const keys = await itemKeys(database, parsed);
      if (keys.length === 0) {
        return {
          target_id: target.target_id,
          disposition: "ALREADY_ABSENT",
          receipt_ref: await receipt("delete-search", request, target, "already-absent"),
        };
      }
      const statements: D1PreparedStatement[] = [];
      for (const key of keys) {
        statements.push(database.prepare("DELETE FROM section_fts WHERE item_key=?1").bind(key));
        statements.push(database.prepare("DELETE FROM literal_gram WHERE item_key=?1").bind(key));
        statements.push(database.prepare("DELETE FROM exact_identifier WHERE item_key=?1").bind(key));
        statements.push(database.prepare("DELETE FROM projection_span WHERE item_key=?1").bind(key));
        statements.push(database.prepare("DELETE FROM projection_item WHERE item_key=?1").bind(key));
      }
      statements.push(database.prepare(
        "DELETE FROM projection_activation_guard WHERE source_revision_ref=?1 " +
        "AND projection_generation=?2",
      ).bind(parsed.source_revision_ref, parsed.projection_generation));
      statements.push(database.prepare(
        "DELETE FROM projection_generation_receipt WHERE source_revision_ref=?1 " +
        "AND projection_generation=?2",
      ).bind(parsed.source_revision_ref, parsed.projection_generation));
      for (let index = 0; index < statements.length; index += 100) {
        await database.batch(statements.slice(index, index + 100));
      }
      return {
        target_id: target.target_id,
        disposition: "DELETE_ACCEPTED",
        receipt_ref: await receipt("delete-search", request, target, "accepted"),
      };
    },

    async verifyAbsent(
      request,
      fence: ErasureFence,
      target,
    ): Promise<AbsenceVerificationReceipt> {
      const parsed = parseTarget(target);
      const remaining = parsed === null ? 0 : await count(database, parsed);
      const absent = remaining === 0;
      const receiptRef = await receipt("absence-search", request, target, absent ? "absent" : "present");
      if (parsed !== null) {
        const payload = {
          erasure_id: fence.erasure_id,
          erasure_revision: fence.revision,
          target_id: target.target_id,
          source_revision_ref: parsed.source_revision_ref,
          projection_generation: parsed.projection_generation,
          remaining_item_count: remaining,
          absence_verified: absent,
          receipt_ref: receiptRef,
        };
        const digest = await erasureSha256Utf8(canonicalErasureJson(payload));
        await database.prepare(
          "INSERT INTO erasure_search_receipt(erasure_id,erasure_revision,target_id," +
          "source_revision_ref,projection_generation,deleted_item_count,remaining_item_count," +
          "absence_verified,receipt_ref,receipt_digest,created_at) VALUES " +
          "(?1,?2,?3,?4,?5,0,?6,?7,?8,?9,?10) " +
          "ON CONFLICT(erasure_id,erasure_revision,target_id) DO UPDATE SET " +
          "remaining_item_count=excluded.remaining_item_count," +
          "absence_verified=excluded.absence_verified,receipt_ref=excluded.receipt_ref," +
          "receipt_digest=excluded.receipt_digest,created_at=excluded.created_at",
        ).bind(
          fence.erasure_id,
          fence.revision,
          target.target_id,
          parsed.source_revision_ref,
          parsed.projection_generation,
          remaining,
          absent ? 1 : 0,
          receiptRef,
          digest,
          isoFromMs(clock()),
        ).run();
      }
      return {
        target_id: target.target_id,
        absent,
        receipt_ref: receiptRef,
        ...(absent ? {} : { reason_code: "D1_SEARCH_ROWS_REMAIN" }),
      };
    },
  };
}
