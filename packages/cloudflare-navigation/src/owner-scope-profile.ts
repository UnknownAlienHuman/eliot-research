import type { ScopeSnapshot } from "@eliotr/contracts";
import { createD1ScopeProfilePort, type ScopeProfileBinding } from "@eliotr/retrieval";
import { createD1ScopeService } from "./d1-scope-service.js";
import type { OwnerScopeAuthority } from "./orientation-authority.js";
import { ORIENTATION_MAX_RESULTS, ORIENTATION_MAX_SOURCES } from "./orientation-input.js";
import { ScopeServiceError } from "./scope-service.js";

/** The existing exhaustive owner-loader ceiling, not the generic 50,000-member ceiling. */
export const OWNER_RESEARCH_MAX_SOURCES = 4096;
/** The generic scope parser's existing explicit-selection envelope. */
export const OWNER_RESEARCH_MAX_SELECTED_SOURCES = 1000;
export const OWNER_RESEARCH_SCOPE_PROFILE = Object.freeze({
  version: "retrieval-scope-v2", max_sources: OWNER_RESEARCH_MAX_SOURCES, max_results: ORIENTATION_MAX_RESULTS,
});
export const OWNER_LEGACY_SCOPE_PROFILE = Object.freeze({
  version: "retrieval-scope-v1", max_sources: ORIENTATION_MAX_SOURCES, max_results: ORIENTATION_MAX_RESULTS,
});

export function requireOwnerScopeProfile(profile: ScopeProfileBinding, scope?: ScopeSnapshot): ScopeProfileBinding {
  const maximum = profile.version === OWNER_RESEARCH_SCOPE_PROFILE.version ? OWNER_RESEARCH_MAX_SOURCES
    : profile.version === OWNER_LEGACY_SCOPE_PROFILE.version ? ORIENTATION_MAX_SOURCES : 0;
  if (!Number.isSafeInteger(profile.max_sources) || profile.max_sources < 1 || profile.max_sources > maximum ||
      !Number.isSafeInteger(profile.max_results) || profile.max_results < 1 || profile.max_results > ORIENTATION_MAX_RESULTS ||
      (scope !== undefined && scope.member_source_revision_refs.length > profile.max_sources)) {
    throw new ScopeServiceError("SCOPE_SNAPSHOT_STALE", "saved scope profile is unsupported or its membership exceeds the recorded bound");
  }
  return Object.freeze({ ...profile });
}

/** Missing profiles are compatible only with the original bounded owner scope. */
export async function readOwnerScopeProfile(database: D1Database, scope: ScopeSnapshot): Promise<ScopeProfileBinding> {
  const present = await database.prepare(
    "SELECT 1 AS present FROM retrieval_scope_profile WHERE snapshot_id=?1 AND revision=?2",
  ).bind(scope.snapshot_id, scope.revision).first();
  return requireOwnerScopeProfile(present === null ? OWNER_LEGACY_SCOPE_PROFILE
    : await createD1ScopeProfilePort(database).loadBinding(scope), scope);
}

/** Reconcile a crash between freezing, profile recording and reservation binding. */
export async function bindOwnerResearchScopeProfile(database: D1Database, scope: ScopeSnapshot,
  maximumResults: number): Promise<void> {
  const present = await database.prepare(
    "SELECT 1 AS present FROM retrieval_scope_profile WHERE snapshot_id=?1 AND revision=?2",
  ).bind(scope.snapshot_id, scope.revision).first();
  if (present === null) {
    const binding = requireOwnerScopeProfile({ ...OWNER_RESEARCH_SCOPE_PROFILE, max_results: maximumResults }, scope);
    await createD1ScopeProfilePort(database).recordBinding(scope, binding);
  }
  const recorded = await readOwnerScopeProfile(database, scope);
  if (recorded.max_results !== maximumResults) {
    throw new ScopeServiceError("SCOPE_SNAPSHOT_STALE", "saved scope profile conflicts with the original result bound");
  }
}

/** Same resolver and currentness algorithm; only the recorded I/O envelope differs. */
export function createProfiledOwnerScopeService(database: D1Database, owner: OwnerScopeAuthority,
  profile: ScopeProfileBinding, now: () => number = Date.now) {
  requireOwnerScopeProfile(profile);
  return createD1ScopeService(database, owner, {
    now, max_snapshot_members: profile.max_sources,
    preserve_resolution_errors: profile.version === OWNER_RESEARCH_SCOPE_PROFILE.version,
    ...(profile.version === OWNER_RESEARCH_SCOPE_PROFILE.version ? {
      resolveAtom: owner.exhaustiveResolveAtom,
      resolveAuthorityClosure: owner.exhaustiveResolveAuthorityClosure,
    } : {}),
  });
}
