import {
  ScopeSnapshotSchema,
  VersionedRefSchema,
  type ScopeSnapshot,
  type VersionedRef,
  type WikiPageRevision,
} from "@eliotr/contracts";
import {
  canonicalEvidenceJson,
  createNavigationReadAuthority,
  loadScopeAuthority,
  type EvidenceAccessContext,
  type NavigationReadAuthority,
  type ScopeAuthorization,
} from "@eliotr/cloudflare-evidence";
import {
  createD1ScopeService,
  createOwnerScopeAuthority,
  reauthorizeOwnerHistoricalScope,
} from "@eliotr/cloudflare-navigation";
import { CatalogInputError } from "./catalog-service.js";
import type { Env } from "./env.js";

export interface WikiProposalReadAuthorization {
  /** The immutable scope reference stored in the Wiki proposal page. */
  readonly original_scope_snapshot_ref: VersionedRef;
  /** The scope used for this request; it may be a fresh owner reauthorization. */
  readonly authorization_scope_snapshot_ref: VersionedRef;
  readonly navigation: NavigationReadAuthority;
  readonly authorization: ScopeAuthorization;
  readonly source_fingerprint: string;
  /** Recheck grant and exact source authorities after every asynchronous read. */
  readonly requireCurrent: () => Promise<void>;
}

function stale(message: string, status: 403 | 410 = 410): never {
  throw new CatalogInputError("WIKI_POLICY_DENIED", message, status);
}

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object" || !("code" in error)) return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function canReauthorize(error: unknown): boolean {
  switch (errorCode(error)) {
    case "WIKI_POLICY_DENIED":
    case "SCOPE_SNAPSHOT_STALE":
    case "NAVIGATION_SCOPE_NOT_CURRENT":
    case "NAVIGATION_SCOPE_MISMATCH":
    case "EVIDENCE_SCOPE_EXPIRED":
    case "EVIDENCE_AUTHORIZATION_DENIED":
    case "EVIDENCE_SCOPE_INVALIDATED":
    case "EVIDENCE_SOURCE_NOT_LIVE":
    case "EVIDENCE_OWNER_GENERATION_MISMATCH":
    case "EVIDENCE_SCOPE_MISMATCH":
      return true;
    default:
      return false;
  }
}

function sameScopeForReauthorization(original: ScopeSnapshot, fresh: ScopeSnapshot): boolean {
  return canonicalEvidenceJson(original.resolved_scope_expression) === canonicalEvidenceJson(fresh.resolved_scope_expression) &&
    canonicalEvidenceJson([...original.member_source_revision_refs].sort()) === canonicalEvidenceJson([...fresh.member_source_revision_refs].sort()) &&
    canonicalEvidenceJson(original.source_owner_generations) === canonicalEvidenceJson(fresh.source_owner_generations) &&
    canonicalEvidenceJson(original.participant_generations) === canonicalEvidenceJson(fresh.participant_generations) &&
    original.disclosure_closure_digest === fresh.disclosure_closure_digest &&
    fresh.purge_ledger_revision >= original.purge_ledger_revision;
}

async function sourceFingerprint(
  navigation: NavigationReadAuthority,
  authorization: ScopeAuthorization,
  expectedOwnerGenerations: Readonly<Record<string, string>>,
): Promise<string> {
  if (!authorization.allowed_use.includes("research")) {
    stale("Wiki proposal read authorization denied", 403);
  }
  const refs = navigation.scope.member_source_revision_refs;
  const sources = await navigation.sources(refs, authorization);
  if (sources.length !== refs.length) stale("Wiki proposal source authorization is incomplete");
  const actualRefs = sources.map((source) => source.source_revision_ref).sort();
  const expectedRefs = [...refs].sort();
  if (canonicalEvidenceJson(actualRefs) !== canonicalEvidenceJson(expectedRefs)) {
    stale("Wiki proposal source set changed");
  }
  for (const source of sources) {
    if (source.purge_state !== "LIVE" ||
        expectedOwnerGenerations[source.source_revision_ref] !== source.source_owner_generation ||
        !source.allowed_use.includes("research") ||
        source.disclosure_ceiling !== authorization.disclosure_ceiling ||
        source.allowed_use.some((use) => !authorization.allowed_use.includes(use))) {
      stale("Wiki proposal source authorization is stale");
    }
  }
  return canonicalEvidenceJson([...sources].sort((left, right) =>
    left.source_revision_ref < right.source_revision_ref ? -1 : 1));
}

function refForScope(scope: ScopeSnapshot): VersionedRef {
  return VersionedRefSchema.parse({ id: scope.snapshot_id, revision: scope.revision });
}

function bindAuthorization(
  originalRef: VersionedRef,
  navigation: NavigationReadAuthority,
  authorization: ScopeAuthorization,
): Promise<WikiProposalReadAuthorization> {
  return sourceFingerprint(navigation, authorization, navigation.scope.source_owner_generations)
    .then((fingerprint) => ({
      original_scope_snapshot_ref: originalRef,
      authorization_scope_snapshot_ref: refForScope(navigation.scope),
      navigation,
      authorization,
      source_fingerprint: fingerprint,
      requireCurrent: async () => {
        const currentAuthorization = await navigation.current();
        if (canonicalEvidenceJson(currentAuthorization) !== canonicalEvidenceJson(authorization)) {
          stale("Wiki proposal authorization changed during read");
        }
        const currentFingerprint = await sourceFingerprint(
          navigation,
          currentAuthorization,
          navigation.scope.source_owner_generations,
        );
        if (currentFingerprint !== fingerprint) stale("Wiki proposal source authorization changed during read");
      },
    }));
}

async function loadOriginalScope(
  env: Pick<Env, "CORE_DB">,
  context: EvidenceAccessContext,
  scopeRef: VersionedRef,
  allowHeadInvalidation = false,
): Promise<{ readonly originalRef: VersionedRef; readonly original: ScopeSnapshot }> {
  if (context.client_class !== "owner_pwa") stale("Wiki access requires the owner profile", 403);
  const originalRef = VersionedRefSchema.parse(scopeRef);
  const originalAuthority = await loadScopeAuthority(env.CORE_DB, originalRef);
  if (originalAuthority === null ||
      (originalAuthority.invalidated_at !== null &&
       (!allowHeadInvalidation || originalAuthority.invalidation_reason !== "SCOPE_INPUT_CHANGED"))) {
    stale("Wiki proposal scope is no longer available");
  }
  return { originalRef, original: ScopeSnapshotSchema.parse(originalAuthority.snapshot) };
}

/** Build a fresh owner authorization while retaining the saved scope as provenance. */
export async function prepareOwnerScopeReauthorization(
  env: Pick<Env, "CORE_DB">,
  context: EvidenceAccessContext,
  scopeRef: VersionedRef,
): Promise<WikiProposalReadAuthorization> {
  const { originalRef, original } = await loadOriginalScope(env, context, scopeRef);
  const now = Date.now;
  const owner = createOwnerScopeAuthority(env.CORE_DB, context, now);
  await owner.requireReadPolicy();
  const scopes = createD1ScopeService(env.CORE_DB, owner, { now, max_snapshot_members: 64 });
  const fresh = await scopes.freeze(original.resolved_scope_expression, context.credential_generation);
  if (!sameScopeForReauthorization(original, fresh)) {
    stale("Wiki proposal sources or policy closure changed");
  }
  await scopes.requireCurrent(fresh);
  await owner.grant(fresh);
  const navigation = createNavigationReadAuthority({
    database: env.CORE_DB,
    scope_snapshot: fresh,
    access: context,
    require_current: (scope) => scopes.requireCurrent(scope),
    now,
  });
  const authorization = await navigation.current();
  return bindAuthorization(originalRef, navigation, authorization);
}

/** Preserve the page-based API while allowing history readers to authorize by scope. */
export async function prepareWikiProposalReauthorization(
  env: Pick<Env, "CORE_DB">,
  context: EvidenceAccessContext,
  page: WikiPageRevision,
): Promise<WikiProposalReadAuthorization> {
  return prepareOwnerScopeReauthorization(env, context, page.scope_snapshot_ref);
}

/**
 * Use the persisted grant while it is current, and reauthorize only on a
 * known scope/credential staleness result. Unknown storage failures remain
 * fatal and are never converted into a fresh authorization.
 */
export async function prepareOwnerScopeReadAuthorization(
  env: Pick<Env, "CORE_DB">,
  context: EvidenceAccessContext,
  scopeRef: VersionedRef,
): Promise<WikiProposalReadAuthorization> {
  const { originalRef, original } = await loadOriginalScope(env, context, scopeRef);
  const now = Date.now;
  const owner = createOwnerScopeAuthority(env.CORE_DB, context, now);
  const scopes = createD1ScopeService(env.CORE_DB, owner, { now, max_snapshot_members: 64 });
  const navigation = createNavigationReadAuthority({
    database: env.CORE_DB,
    scope_snapshot: original,
    access: context,
    require_current: (scope) => scopes.requireCurrent(scope),
    now,
  });
  try {
    const authorization = await navigation.current();
    return await bindAuthorization(originalRef, navigation, authorization);
  } catch (error) {
    if (!canReauthorize(error)) throw error;
    return prepareOwnerScopeReauthorization(env, context, originalRef);
  }
}

/**
 * Read-only historical reopen. The fresh grant keeps the saved revision refs;
 * current-head reauthorization remains the separate mutation path above.
 */
export async function prepareOwnerScopeHistoricalReadAuthorization(
  env: Pick<Env, "CORE_DB">,
  context: EvidenceAccessContext,
  scopeRef: VersionedRef,
): Promise<WikiProposalReadAuthorization> {
  const { originalRef, original } = await loadOriginalScope(env, context, scopeRef, true);
  const now = Date.now;
  const historical = await reauthorizeOwnerHistoricalScope({
    database: env.CORE_DB,
    access: context,
    original_ref: originalRef,
    original,
    now,
    max_snapshot_members: 64,
  });
  const navigation = createNavigationReadAuthority({
    database: env.CORE_DB,
    scope_snapshot: historical.scope,
    access: context,
    require_current: historical.requireCurrent,
    now,
  });
  const authorization = await navigation.current();
  return bindAuthorization(originalRef, navigation, authorization);
}

export async function prepareWikiProposalReadAuthorization(
  env: Pick<Env, "CORE_DB">,
  context: EvidenceAccessContext,
  page: WikiPageRevision,
): Promise<WikiProposalReadAuthorization> {
  return prepareOwnerScopeReadAuthorization(env, context, page.scope_snapshot_ref);
}

export async function prepareWikiProposalHistoricalReadAuthorization(
  env: Pick<Env, "CORE_DB">,
  context: EvidenceAccessContext,
  page: WikiPageRevision,
): Promise<WikiProposalReadAuthorization> {
  return prepareOwnerScopeHistoricalReadAuthorization(env, context, page.scope_snapshot_ref);
}
