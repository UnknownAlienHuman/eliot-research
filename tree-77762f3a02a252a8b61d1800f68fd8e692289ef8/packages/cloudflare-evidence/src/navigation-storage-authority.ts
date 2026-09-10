import type { ScopeSnapshot } from "@eliotr/contracts";
import { NavigationError } from "@eliotr/retrieval";
import { authorizeScopeAuthority, loadScopeAuthority, loadSourceAuthorities } from "./authority-load.js";
import { assertEvidenceIdentifier, assertEvidenceIso, canonicalEvidenceJson, evidenceSha256 } from "./canonical.js";
import { boundedScopeValue, validateStoredScope } from "./scope-codec.js";
import { navigationStorageFailure } from "./navigation-storage-codec.js";
import type { EvidenceAccessContext, EvidenceSourceAuthority, ScopeAuthorization } from "./types.js";

export interface NavigationSourceBinding {
  readonly source_revision_ref: string;
  readonly source_owner_generation: string;
  readonly content_sha256: string;
  readonly object_residency_key_digest: string;
  readonly authority_digest: string;
}
export interface D1NavigationStoreInput {
  readonly database: D1Database;
  readonly scope_snapshot: ScopeSnapshot;
  readonly access: EvidenceAccessContext;
  /** Must be the authoritative ScopeService.requireCurrent, never a caller's validity flag. */
  readonly require_current: (scope: ScopeSnapshot) => Promise<ScopeSnapshot>;
  readonly now?: () => number;
}
export interface NavigationReadAuthority {
  readonly scope: ScopeSnapshot;
  readonly access: EvidenceAccessContext;
  current(requested?: ScopeSnapshot): Promise<ScopeAuthorization>;
  sources(refs: readonly string[], grant: ScopeAuthorization): Promise<readonly EvidenceSourceAuthority[]>;
  timestamp(): string;
}

export function createNavigationReadAuthority(input: D1NavigationStoreInput): NavigationReadAuthority {
  if (!input.database || typeof input.database.prepare !== "function" || typeof input.require_current !== "function") {
    navigationStorageFailure("navigation requires D1 and current scope authority");
  }
  boundedScopeValue(input.scope_snapshot);
  // Pin per-instance state before the first await; concurrent requests never share mutable current-scope state.
  const scope = JSON.parse(canonicalEvidenceJson(input.scope_snapshot)) as ScopeSnapshot;
  const access: EvidenceAccessContext = {
    principal_ref: assertEvidenceIdentifier(input.access.principal_ref, "navigation principal"),
    client_class: input.access.client_class,
    credential_generation: assertEvidenceIdentifier(input.access.credential_generation, "navigation credential generation"),
  };
  if (!["owner_pwa", "named_api_client", "trusted_agent", "federation_client"].includes(access.client_class)) {
    navigationStorageFailure("unknown navigation client class");
  }
  const pinned = canonicalEvidenceJson(scope);
  const requireCurrent = input.require_current;
  const database = input.database;
  const now = input.now ?? Date.now;
  function timestamp(): string {
    const value = now();
    if (!Number.isSafeInteger(value)) navigationStorageFailure("invalid navigation clock");
    return assertEvidenceIso(new Date(value).toISOString(), "navigation clock");
  }
  async function current(requested = scope): Promise<ScopeAuthorization> {
    boundedScopeValue(requested);
    if (canonicalEvidenceJson(requested) !== pinned) navigationStorageFailure("navigation store is bound to a different snapshot");
    await validateStoredScope(scope);
    const observed = await requireCurrent(JSON.parse(pinned) as ScopeSnapshot);
    boundedScopeValue(observed);
    if (canonicalEvidenceJson(observed) !== pinned) navigationStorageFailure("scope currentness readback changed identity");
    const stored = await loadScopeAuthority(database, { id: scope.snapshot_id, revision: scope.revision });
    if (!stored || canonicalEvidenceJson(stored.snapshot) !== pinned) {
      throw new NavigationError("NAVIGATION_SCOPE_NOT_CURRENT", "persisted navigation scope unavailable or changed");
    }
    const unavailable = await database.prepare(
      "SELECT 1 AS unavailable FROM scope_snapshot snapshot, json_each(snapshot.member_source_revision_refs_json) member " +
      "WHERE snapshot.snapshot_id=?1 AND snapshot.revision=?2 AND NOT EXISTS (" +
      "SELECT 1 FROM source_revision sr JOIN source s ON s.source_id=sr.source_id " +
      "JOIN source_namespace_ownership o ON o.source_namespace_id=s.source_namespace_id AND o.status='ACTIVE' " +
      "JOIN json_each(snapshot.source_owner_generations_json) gen ON gen.key=member.value " +
      "WHERE sr.source_revision_ref=member.value AND sr.purge_state='LIVE' " +
      "AND sr.source_owner_generation=o.source_owner_generation AND gen.value=sr.source_owner_generation) LIMIT 1"
    ).bind(scope.snapshot_id, scope.revision).first();
    if (unavailable !== null) throw new NavigationError("NAVIGATION_SCOPE_NOT_CURRENT", "snapshot member no longer live or current");
    const grant = await authorizeScopeAuthority(database, stored, access, Date.parse(timestamp()));
    if (!grant.allowed_use.includes("research")) {
      throw new NavigationError("NAVIGATION_SCOPE_NOT_CURRENT", "scope grant does not permit research navigation");
    }
    return grant;
  }
  async function sources(refs: readonly string[], grant: ScopeAuthorization): Promise<readonly EvidenceSourceAuthority[]> {
    if (refs.length > 4096 || new Set(refs).size !== refs.length) navigationStorageFailure("invalid navigation source set");
    const members = new Set(scope.member_source_revision_refs);
    for (const ref of refs) {
      assertEvidenceIdentifier(ref, "navigation source revision");
      if (!members.has(ref)) throw new NavigationError("NAVIGATION_SCOPE_MISMATCH", "navigation source outside frozen scope");
    }
    const result: EvidenceSourceAuthority[] = [];
    const instant = Date.parse(timestamp());
    for (let offset = 0; offset < refs.length; offset += 64) {
      result.push(...await loadSourceAuthorities(database, refs.slice(offset, offset + 64), instant));
    }
    if (result.length !== refs.length) navigationStorageFailure("navigation source has no exact admitted authority");
    for (const source of result) {
      if (source.purge_state !== "LIVE" || scope.source_owner_generations[source.source_revision_ref] !== source.source_owner_generation ||
          source.disclosure_ceiling !== grant.disclosure_ceiling ||
          source.allowed_use.some((use) => !grant.allowed_use.includes(use)) || !source.allowed_use.includes("research")) {
        throw new NavigationError("NAVIGATION_SCOPE_NOT_CURRENT", "navigation source is not currently authorized");
      }
    }
    return result.sort((a, b) => a.source_revision_ref < b.source_revision_ref ? -1 : 1);
  }
  return { scope, access, current, sources, timestamp };
}

export async function navigationSourceBindings(sources: readonly EvidenceSourceAuthority[]): Promise<readonly NavigationSourceBinding[]> {
  return Promise.all(sources.map(async (source) => ({
    source_revision_ref: source.source_revision_ref,
    source_owner_generation: source.source_owner_generation,
    content_sha256: source.content_sha256,
    object_residency_key_digest: source.object_residency_key_digest,
    authority_digest: await evidenceSha256(source),
  })));
}
