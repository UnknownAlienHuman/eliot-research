import {
  IdentifierSchema,
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
import { orientationCurrentness } from "./orientation-currentness.js";
import { createOwnerScopeAuthority, createProjectClientArtifactAuthority, splitExhaustiveSourceRefs, type OwnerScopeAuthority } from "./orientation-authority.js";
import { ScopeServiceError } from "./scope-service.js";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { issueClientArtifactScopeGrant, requireClientScopeProvenance, type ClientArtifactScopeOrigin } from "./client-scope-grant.js";

import { createD1ScopeProfilePort } from "@eliotr/retrieval";
import { readOwnerScopeProfile, OWNER_RESEARCH_SCOPE_PROFILE } from "./owner-scope-profile.js";

export interface OwnerHistoricalScopeInput {
  readonly database: D1Database;
  readonly access: EvidenceAccessContext;
  readonly original_ref: VersionedRef;
  readonly original: ScopeSnapshot;
  readonly now?: () => number;
  readonly max_snapshot_members?: number;
}

export interface OwnerArtifactHistoricalScopeInput extends OwnerHistoricalScopeInput {
  readonly artifact_ref: VersionedRef;
  readonly original_principal_ref: string;
}

export interface ClientArtifactHistoricalScopeInput extends OwnerHistoricalScopeInput {
  readonly access: AuthenticatedRequestContext;
  readonly origin: ClientArtifactScopeOrigin;
  readonly original_principal_ref: string;
}

export interface OwnerHistoricalScopeAuthorization {
  /** Fresh scope used for this read; its members retain the historical revisions. */
  readonly scope: ScopeSnapshot;
  /** Rechecks the same historical member set and all current owner/policy fences. */
  readonly requireCurrent: (scope: ScopeSnapshot) => Promise<ScopeSnapshot>;
}

type OrientationSource = Awaited<ReturnType<OwnerScopeAuthority["exhaustiveSources"]>>[number];

interface SourceHeadWitnessRow {
  readonly source_revision_ref: unknown;
  readonly source_owner_generation: unknown;
  readonly purge_state: unknown;
  readonly head_revision_ref: unknown;
}

function stale(): never {
  throw new ScopeServiceError(
    "SCOPE_SNAPSHOT_STALE",
    "historical scope cannot be reauthorized under the current owner authority",
  );
}

function validMaximum(value: number | undefined, recordedMaximum: number): number {
  const maximum = value ?? recordedMaximum;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > recordedMaximum) stale();
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

/** SCOPE_INPUT_CHANGED is reusable only when the persisted source revisions are
 * still live and the source table proves an actual head advance. */
async function provesSourceHeadAdvance(
  database: D1Database,
  original: ScopeSnapshot,
): Promise<boolean> {
  const refs = original.member_source_revision_refs;
  if (refs.length === 0) return false;
  const expected = new Set(refs);
  let advanced = false;
  for (const batch of splitExhaustiveSourceRefs(refs)) {
    const result = await database.prepare(
      "SELECT sr.source_revision_ref AS source_revision_ref, sr.source_owner_generation AS source_owner_generation, " +
        "sr.purge_state AS purge_state, s.head_rev AS head_revision_ref " +
        "FROM source_revision sr JOIN source s ON s.source_id=sr.source_id " +
        "WHERE sr.source_revision_ref IN (SELECT value FROM json_each(?1)) " +
        "ORDER BY sr.source_revision_ref LIMIT ?2",
    ).bind(JSON.stringify(batch), batch.length + 1).all<SourceHeadWitnessRow>();
    if (!result.success || !Array.isArray(result.results) || result.results.length !== batch.length) return false;
    const requested = new Set(batch);
    for (const row of result.results) {
      if (typeof row.source_revision_ref !== "string" || !requested.delete(row.source_revision_ref) ||
          !expected.delete(row.source_revision_ref) || row.purge_state !== "LIVE" ||
          row.source_owner_generation !== original.source_owner_generations[row.source_revision_ref] ||
          typeof row.head_revision_ref !== "string" || row.head_revision_ref.length === 0) return false;
      if (row.head_revision_ref !== row.source_revision_ref) advanced = true;
    }
  }
  return expected.size === 0 && advanced;
}

/** Check immutable original bytes and the one supported head-advance invalidation.
 * Expiry is not renewal: callers must independently authorize every current read. */
export async function requireHistoricalScopeOrigin(
  database: D1Database, originalRef: VersionedRef, original: ScopeSnapshot,
): Promise<void> {
  await requireHistoricalScopeRecord(database, originalRef, original, false);
}

async function requireHistoricalScopeRecord(
  database: D1Database, originalRef: VersionedRef, original: ScopeSnapshot,
  independentMachineOwner: boolean,
): Promise<void> {
  const persisted = await loadScopeAuthority(database, originalRef);
  if (persisted === null || canonicalEvidenceJson(persisted.snapshot) !== canonicalEvidenceJson(original)) stale();
  if (persisted.invalidated_at === null) return;
  // Only the exact machine report's independently authorized original grantor
  // may retain historical provenance after the service grant was invalidated.
  // This never changes the old snapshot or the old service's effective authority.
  if (independentMachineOwner && persisted.invalidation_reason === "CLIENT_DELEGATION_STALE") return;
  if (persisted.invalidation_reason !== "SCOPE_INPUT_CHANGED" ||
      !(await provesSourceHeadAdvance(database, original))) stale();
}

async function requireOriginalGrantNotRevoked(
  database: D1Database,
  originalRef: VersionedRef,
  principalRef: string,
  clientClass: EvidenceAccessContext["client_class"],
): Promise<void> {
  const revoked = await database.prepare(
    "SELECT state FROM scope_access_grant WHERE snapshot_id=?1 AND snapshot_revision=?2 " +
      "AND principal_ref=?3 AND client_class=?4 AND state='REVOKED' LIMIT 1",
  ).bind(originalRef.id, originalRef.revision, principalRef, clientClass)
    .first<{ readonly state: unknown }>();
  if (revoked !== null) stale();
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
  if (input.access.client_class !== "owner_pwa") stale();
  return reauthorizeHistoricalScope(input);
}

export async function reauthorizeClientArtifactScope(
  input: ClientArtifactHistoricalScopeInput,
): Promise<OwnerHistoricalScopeAuthorization> {
  return reauthorizeHistoricalScope(input, input);
}

/** Independent owner entitlement to this exact saved report. The current reader
 * never adopts the machine's identity, token, grant, budget or execution deadline. */
export async function reauthorizeOwnerArtifactScope(
  input: OwnerArtifactHistoricalScopeInput,
): Promise<OwnerHistoricalScopeAuthorization> {
  if (input.access.client_class !== "owner_pwa") stale();
  const artifact = VersionedRefSchema.parse(input.artifact_ref);
  const originalRef = VersionedRefSchema.parse(input.original_ref);
  const marker = await input.database.prepare("SELECT value FROM schema_state WHERE key='owner_artifact_read_generation'")
    .first<{ value: unknown }>();
  if (marker?.value !== "owner-artifact-read-v1") {
    throw new ScopeServiceError("SCOPE_PERSISTENCE_INVALID", "Owner report reads require migration 0079");
  }
  const readOrigin = () => input.database.prepare(
    "SELECT origin_client_class, project_id, project_generation FROM owner_artifact_read_origin " +
    "WHERE artifact_id=?1 AND artifact_revision=?2 AND scope_snapshot_id=?3 AND scope_snapshot_revision=?4 " +
    "AND principal_ref=?5 AND reader_principal_ref=?6 LIMIT 1",
  ).bind(artifact.id, artifact.revision, originalRef.id, originalRef.revision,
    input.original_principal_ref, input.access.principal_ref)
    .first<{ origin_client_class: unknown; project_id: unknown; project_generation: unknown }>();
  const origin = await readOrigin();
  if (origin === null) stale();
  if (origin.origin_client_class === "owner_pwa") {
    if (input.original_principal_ref !== input.access.principal_ref ||
        origin.project_id !== null || origin.project_generation !== null) stale();
  } else if (!["trusted_agent", "named_api_client"].includes(String(origin.origin_client_class)) ||
      !IdentifierSchema.safeParse(origin.project_id).success ||
      typeof origin.project_generation !== "number" || !Number.isSafeInteger(origin.project_generation) || origin.project_generation < 1 ||
      input.original.resolved_scope_expression.kind !== "PROJECT" ||
      input.original.resolved_scope_expression.project_id !== origin.project_id) stale();
  const expected = canonicalEvidenceJson(origin);
  const requireOrigin = async () => {
    const current = await readOrigin();
    if (current === null || canonicalEvidenceJson(current) !== expected) stale();
  };
  // A revoked machine grant does not revoke an independently authorized owner.
  // Ordinary owner-authored reports retain the view's original-grant revoke guard.
  return reauthorizeHistoricalScope(input, undefined, {
    requireCurrent: requireOrigin, independentMachine: origin.origin_client_class !== "owner_pwa",
  });
}

async function reauthorizeHistoricalScope(
  input: OwnerHistoricalScopeInput, client?: ClientArtifactHistoricalScopeInput,
  ownerArtifactOrigin?: { readonly requireCurrent: () => Promise<void>; readonly independentMachine: boolean },
): Promise<OwnerHistoricalScopeAuthorization> {
  const originalRef = VersionedRefSchema.safeParse(input.original_ref);
  const parsed = ScopeSnapshotSchema.safeParse(input.original);
  if (!originalRef.success || !parsed.success) stale();
  const profile = await readOwnerScopeProfile(input.database, parsed.data);
  const maximumMembers = validMaximum(input.max_snapshot_members, profile.max_sources);
  if (parsed.data.member_source_revision_refs.length > maximumMembers) stale();
  await ownerArtifactOrigin?.requireCurrent();
  const requireHistoricalOrigin = () => requireHistoricalScopeRecord(input.database, originalRef.data,
    parsed.data, ownerArtifactOrigin?.independentMachine === true);
  await requireHistoricalOrigin();
  const original = parsed.data;
  const now = input.now ?? Date.now;
  const delegated = client === undefined ? undefined : await createProjectClientArtifactAuthority(
    input.database, client.access, original, client.origin, client.original_principal_ref, now,
  );
  const requireOriginalGrant = ownerArtifactOrigin?.requireCurrent ?? (() => requireOriginalGrantNotRevoked(input.database, originalRef.data,
    client?.original_principal_ref ?? input.access.principal_ref,
    delegated?.original_client_class ?? input.access.client_class));
  await requireOriginalGrant();
  const owner = delegated?.authority ?? createOwnerScopeAuthority(input.database, input.access, now);
  if (profile.version === OWNER_RESEARCH_SCOPE_PROFILE.version) await owner.exhaustiveRequireReadPolicy();
  else await owner.requireReadPolicy();
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
  const requireScopeCurrent = ownerArtifactOrigin === undefined
    ? (scope: ScopeSnapshot) => scopes.requireCurrent(scope)
    : orientationCurrentness(input.database, scopes, input.access.principal_ref, now);
  const fresh = await scopes.freeze(original.resolved_scope_expression, input.access.credential_generation);
  requireExactHistoricalIdentity(original, fresh);
  await requireScopeCurrent(fresh);
  await createD1ScopeProfilePort(input.database).recordBinding(fresh, profile);
  if (delegated !== undefined && client !== undefined) {
    await issueClientArtifactScopeGrant({ database: input.database, context: client.access, snapshot: fresh,
      lease: delegated.lease, sources: () => owner.exhaustiveSources(fresh.member_source_revision_refs),
      require_current: (scope) => scopes.requireCurrent(scope), now }, client.origin);
  } else if (profile.version === OWNER_RESEARCH_SCOPE_PROFILE.version) await owner.exhaustiveGrant(fresh);
  else await owner.grant(fresh);
  await requireOriginalGrant();
  const requireCurrent = async (scope: ScopeSnapshot): Promise<ScopeSnapshot> => {
    await requireOriginalGrant();
    await requireHistoricalOrigin();
    const checked = await requireScopeCurrent(scope);
    if (delegated !== undefined && client !== undefined) {
      await delegated.requireOrigin();
      await requireClientScopeProvenance(input.database, client.access, checked, delegated.lease, client.origin);
    }
    await ownerArtifactOrigin?.requireCurrent();
    return checked;
  };
  return {
    scope: fresh,
    requireCurrent,
  };
}
