import {
  ScopeSnapshotSchema,
  VersionedRefSchema,
  type ScopeSnapshot,
  type VersionedRef,
} from "@eliotr/contracts";
import {
  canonicalEvidenceJson,
  evidenceSha256Bytes,
  loadScopeAuthority,
  type EvidenceAccessContext,
} from "@eliotr/cloudflare-evidence";
import {
  scopeExpressionIdentity,
  type DeterministicScopeAtom,
  type DeterministicScopeAtomResolution,
  type DeterministicScopeMember,
} from "@eliotr/domain";
import { createD1ScopeService } from "./d1-scope-service.js";
import { createOwnerScopeAuthority, type OwnerScopeAuthority } from "./orientation-authority.js";
import { ScopeServiceError } from "./scope-service.js";

const DEFAULT_MAX_SNAPSHOT_MEMBERS = 64;

export interface OwnerHistoricalScopeInput {
  readonly database: D1Database;
  readonly access: EvidenceAccessContext;
  readonly original_ref: VersionedRef;
  readonly original: ScopeSnapshot;
  readonly now?: () => number;
  readonly max_snapshot_members?: number;
}

export interface OwnerHistoricalScopeAuthorization {
  /** Fresh scope used for this read; its members retain the historical revisions. */
  readonly scope: ScopeSnapshot;
  /** Rechecks the same historical member set and all current owner/policy fences. */
  readonly requireCurrent: (scope: ScopeSnapshot) => Promise<ScopeSnapshot>;
}

type OrientationSource = Awaited<ReturnType<OwnerScopeAuthority["exhaustiveSources"]>>[number];

function stale(): never {
  throw new ScopeServiceError(
    "SCOPE_SNAPSHOT_STALE",
    "historical scope cannot be reauthorized under the current owner authority",
  );
}

function validMaximum(value: number | undefined): number {
  const maximum = value ?? DEFAULT_MAX_SNAPSHOT_MEMBERS;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > DEFAULT_MAX_SNAPSHOT_MEMBERS) stale();
  return maximum;
}

async function participantKey(atom: DeterministicScopeAtom): Promise<string> {
  const identity = scopeExpressionIdentity(atom);
  const digest = await evidenceSha256Bytes(
    new TextEncoder().encode(`eliotr.scope.participant.v1\0${identity}`),
  );
  return `participant-${digest.slice(0, 48)}`;
}

function historicalMember(
  source: OrientationSource,
  original: ScopeSnapshot,
): DeterministicScopeMember {
  const revision = source.revision.source_revision_ref;
  const generation = original.source_owner_generations[revision];
  if (generation === undefined || generation !== source.revision.source_owner_generation) stale();
  return {
    source_revision_ref: revision,
    source_owner_generation: generation,
    // This is the closure for the exact historical revision, not the current head.
    policy_closure_ref: source.policy_closure_ref,
  };
}

function indexHistoricalSources(
  sources: readonly OrientationSource[],
  original: ScopeSnapshot,
): ReadonlyMap<string, DeterministicScopeMember> {
  if (sources.length !== original.member_source_revision_refs.length) stale();
  const bySourceId = new Map<string, DeterministicScopeMember>();
  for (const source of sources) {
    const member = historicalMember(source, original);
    if (bySourceId.has(source.revision.source_id)) stale();
    bySourceId.set(source.revision.source_id, member);
  }
  return bySourceId;
}

async function historicalAtomResolver(
  owner: OwnerScopeAuthority,
  original: ScopeSnapshot,
  historicalBySourceId: ReadonlyMap<string, DeterministicScopeMember>,
  atom: DeterministicScopeAtom,
  observedAt: string,
): Promise<DeterministicScopeAtomResolution> {
  const generationKey = await participantKey(atom);
  const atomGeneration = original.participant_generations[generationKey];
  if (atomGeneration === undefined) stale();

  const current = await owner.exhaustiveResolveAtom(atom, observedAt);
  const currentRefs = current.members.map((member) => member.source_revision_ref);
  const currentSources = currentRefs.length === 0
    ? []
    : await owner.exhaustiveSources(currentRefs);
  const byRevision = new Map(currentSources.map((source) => [source.revision.source_revision_ref, source]));
  if (byRevision.size !== currentSources.length) stale();

  const members: DeterministicScopeMember[] = [];
  for (const currentMember of current.members) {
    const source = byRevision.get(currentMember.source_revision_ref);
    if (source === undefined) stale();
    const historical = historicalBySourceId.get(source.revision.source_id);
    // New current members are omitted. The final scope service comparison still
    // requires every original member, while additions cannot enter provenance.
    if (historical === undefined) continue;
    if (historical.source_owner_generation !== source.revision.source_owner_generation) stale();
    members.push(historical);
  }
  return { atom_generation_ref: atomGeneration, members };
}

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function requireExactHistoricalIdentity(original: ScopeSnapshot, fresh: ScopeSnapshot): void {
  if (canonicalEvidenceJson(original.resolved_scope_expression) !==
      canonicalEvidenceJson(fresh.resolved_scope_expression) ||
      !sameArray([...original.member_source_revision_refs].sort(), [...fresh.member_source_revision_refs].sort()) ||
      canonicalEvidenceJson(original.source_owner_generations) !==
        canonicalEvidenceJson(fresh.source_owner_generations) ||
      canonicalEvidenceJson(original.participant_generations) !==
        canonicalEvidenceJson(fresh.participant_generations) ||
      original.disclosure_closure_digest !== fresh.disclosure_closure_digest ||
      fresh.purge_ledger_revision < original.purge_ledger_revision) stale();
}

/**
 * Reauthorize an expired or head-stale owner scope for historical reads.
 * Current atom resolution is used only to prove that the original source IDs
 * remain members of the current owner expression; output members stay pinned to
 * the original source revisions and are rechecked by the normal authority loader.
 */
export async function reauthorizeOwnerHistoricalScope(
  input: OwnerHistoricalScopeInput,
): Promise<OwnerHistoricalScopeAuthorization> {
  const originalRef = VersionedRefSchema.safeParse(input.original_ref);
  const parsed = ScopeSnapshotSchema.safeParse(input.original);
  if (!originalRef.success || !parsed.success) stale();
  const persisted = await loadScopeAuthority(input.database, originalRef.data);
  if (persisted === null || persisted.invalidated_at !== null ||
      canonicalEvidenceJson(persisted.snapshot) !== canonicalEvidenceJson(parsed.data)) stale();
  const original = parsed.data;
  const now = input.now ?? Date.now;
  const maximumMembers = validMaximum(input.max_snapshot_members);
  const owner = createOwnerScopeAuthority(input.database, input.access, now);
  await owner.requireReadPolicy();
  const historicalSources = await owner.exhaustiveSources(original.member_source_revision_refs);
  const historicalBySourceId = indexHistoricalSources(historicalSources, original);
  const resolveAtom = (atom: DeterministicScopeAtom, observedAt: string) =>
    historicalAtomResolver(owner, original, historicalBySourceId, atom, observedAt);
  const scopes = createD1ScopeService(input.database, owner, {
    now,
    max_snapshot_members: maximumMembers,
    preserve_resolution_errors: true,
    resolveAtom,
    resolveAuthorityClosure: (request) => owner.exhaustiveResolveAuthorityClosure(request),
  });
  const fresh = await scopes.freeze(original.resolved_scope_expression, input.access.credential_generation);
  requireExactHistoricalIdentity(original, fresh);
  await scopes.requireCurrent(fresh);
  await owner.grant(fresh);
  const requireCurrent = async (scope: ScopeSnapshot): Promise<ScopeSnapshot> => {
    const persistedOriginal = await loadScopeAuthority(input.database, originalRef.data);
    if (persistedOriginal === null || persistedOriginal.invalidated_at !== null ||
        canonicalEvidenceJson(persistedOriginal.snapshot) !== canonicalEvidenceJson(original)) stale();
    return scopes.requireCurrent(scope);
  };
  return {
    scope: fresh,
    requireCurrent,
  };
}
