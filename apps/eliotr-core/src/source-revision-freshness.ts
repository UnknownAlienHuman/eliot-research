import {
  canonicalEvidenceJson,
  loadScopeAuthority,
  type NavigationReadAuthority,
} from "@eliotr/cloudflare-evidence";
import type { VersionedRef } from "@eliotr/contracts";
import { CatalogInputError } from "./catalog-service.js";

const MAX_SOURCE_REFS = 64;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;

interface SourceHeadRow {
  readonly source_id: unknown;
  readonly saved_revision_ref: unknown;
  readonly head_revision_ref: unknown;
}

export interface SourceRevisionFreshness {
  readonly state: "CURRENT_REVISIONS" | "PREVIOUS_REVISIONS";
  readonly checked_at: string;
  readonly changed_sources: readonly {
    readonly source_id: string;
    readonly saved_revision_ref: string;
    readonly head_revision_ref: string;
  }[];
}

export interface SourceRevisionFreshnessAuthorization {
  readonly original_scope_snapshot_ref: VersionedRef;
  readonly navigation: NavigationReadAuthority;
  readonly requireCurrent: () => Promise<void>;
}

function corrupt(message: string): never {
  throw new CatalogInputError("WIKI_PROPOSAL_READBACK_MISMATCH", message, 409);
}

function unavailable(message: string): never {
  throw new CatalogInputError("WIKI_SOURCE_FRESHNESS_UNAVAILABLE", message, 503, true);
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) corrupt(`${label} is malformed`);
  return value;
}

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object" || !("code" in error)) return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/** Compare saved scope members with the current source heads without loading the corpus. */
export async function readSourceRevisionFreshness(
  database: D1Database,
  authorization: SourceRevisionFreshnessAuthorization,
): Promise<SourceRevisionFreshness> {
  let original: Awaited<ReturnType<typeof loadScopeAuthority>>;
  try {
    original = await loadScopeAuthority(database, authorization.original_scope_snapshot_ref);
  } catch (cause) {
    if (errorCode(cause) === "EVIDENCE_INPUT_INVALID") corrupt("saved Wiki scope is malformed");
    unavailable("saved Wiki scope freshness is unavailable");
  }
  if (original === null || original.invalidated_at !== null) {
    throw new CatalogInputError("WIKI_POLICY_DENIED", "saved Wiki scope is no longer available", 410);
  }
  const refs = original.snapshot.member_source_revision_refs.map((ref) => identifier(ref, "saved source revision"));
  if (refs.length > MAX_SOURCE_REFS || new Set(refs).size !== refs.length) corrupt("saved Wiki scope source set is malformed");
  const navigationScope = authorization.navigation.scope;
  if (canonicalEvidenceJson([...navigationScope.member_source_revision_refs].sort()) !== canonicalEvidenceJson([...refs].sort()) ||
      canonicalEvidenceJson(navigationScope.source_owner_generations) !== canonicalEvidenceJson(original.snapshot.source_owner_generations)) {
    corrupt("Wiki read authorization is not bound to the saved source scope");
  }

  await authorization.requireCurrent();
  let rows: readonly SourceHeadRow[] = [];
  if (refs.length > 0) {
    const placeholders = refs.map((_, index) => `?${index + 1}`).join(",");
    let result: D1Result<SourceHeadRow>;
    try {
      result = await database.prepare(
        "SELECT s.source_id AS source_id, sr.source_revision_ref AS saved_revision_ref, " +
        "s.head_rev AS head_revision_ref FROM source_revision sr JOIN source s ON s.source_id=sr.source_id " +
        `WHERE sr.source_revision_ref IN (${placeholders}) ORDER BY sr.source_revision_ref LIMIT ${MAX_SOURCE_REFS + 1}`,
      ).bind(...refs).all<SourceHeadRow>();
    } catch {
      unavailable("current Wiki source heads are unavailable");
    }
    if (!result.success || !Array.isArray(result.results)) unavailable("current Wiki source heads are unavailable");
    rows = result.results;
  }
  if (rows.length !== refs.length) corrupt("saved Wiki source revisions are unavailable");
  const byRevision = new Map<string, { readonly source_id: string; readonly head_revision_ref: string }>();
  for (const row of rows) {
    const savedRevisionRef = identifier(row.saved_revision_ref, "source revision");
    if (byRevision.has(savedRevisionRef) || !refs.includes(savedRevisionRef)) corrupt("Wiki source head identity is inconsistent");
    byRevision.set(savedRevisionRef, {
      source_id: identifier(row.source_id, "source id"),
      head_revision_ref: identifier(row.head_revision_ref, "source head revision"),
    });
  }
  const changedSources = refs.flatMap((savedRevisionRef) => {
    const row = byRevision.get(savedRevisionRef);
    if (row === undefined) corrupt("Wiki source head readback is incomplete");
    return row.head_revision_ref === savedRevisionRef ? [] : [{
      source_id: row.source_id,
      saved_revision_ref: savedRevisionRef,
      head_revision_ref: row.head_revision_ref,
    }];
  });
  await authorization.requireCurrent();
  return {
    state: changedSources.length === 0 ? "CURRENT_REVISIONS" : "PREVIOUS_REVISIONS",
    checked_at: authorization.navigation.timestamp(),
    changed_sources: changedSources,
  };
}
