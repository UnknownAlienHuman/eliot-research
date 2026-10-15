import { ScopeSnapshotSchema, type ScopeExpression, type ScopeSnapshot } from "@eliotr/contracts";
import {
  resolveDeterministicScopeSnapshotDraft,
  scopeExpressionIdentity,
  type DeterministicScopeAtom,
  type DeterministicScopeAtomResolution,
} from "@eliotr/domain";
import {
  assertAiSearchScopeFilterBudget,
  canonicalProjectionJson,
  createD1ManagedRequiredSetPort,
  enumerateManagedRequiredSet,
  MANAGED_PROJECT_FOLDER_FILTER_MAX_BYTES,
  managedProjectFolderPrefix,
  managedProjectGenerationMetadataValue,
  projectionDigest,
  stableProjectionId,
  type AiSearchAuthorizedProjectCopy,
  type AiSearchManagedProjectCopyScopeResolver,
  type AiSearchProjectCopyScope,
  type ManagedTargetIdentity,
  type ManagedRequiredSetReceipt,
  type ManagedTargetSelectionReceipt,
} from "@eliotr/cloudflare-projection";
import type { EvidenceAccessContext } from "@eliotr/cloudflare-evidence";
import { createOwnerScopeAuthority } from "./orientation-authority.js";

type ScopeSetExpression = Extract<
  ScopeExpression,
  { readonly kind: "UNION" | "INTERSECT" | "EXCEPT" }
>;

export interface ProjectCopyMembershipFact {
  readonly source_revision_ref: string;
  readonly source_owner_generation: string;
  readonly project_id: string;
  readonly project_membership_id: string;
  readonly stable_project_membership_id: string;
  readonly legacy_project_membership_id: string | null;
  readonly project_membership_identity_version: 1 | 2;
  readonly membership_id: string;
  readonly membership_revision: number;
  readonly membership_generation: number;
  readonly project_membership_generation: number;
  readonly assignment_decision_version: 1 | 2;
}

type ProjectCopySelectionReceipt = ManagedTargetSelectionReceipt;

type ProjectCopyV2Selection = Extract<ProjectCopySelectionReceipt, { readonly decision_version: 2 }>;

type ProjectCopyV2MembershipCopy = AiSearchAuthorizedProjectCopy & (
  | {
    readonly membership_identity_version: 1;
    readonly legacy_project_membership_id: string;
  }
  | {
    readonly membership_identity_version: 2;
    readonly stable_project_membership_id: string;
    readonly membership_revision: number;
    readonly project_membership_generation: number;
  }
);

/** Internal versioned copy receipt; Root ports this shape to public consumers. */
export interface ProjectCopyScopeV2 {
  readonly layout: "PROJECT_COPY_V2";
  readonly scope_snapshot_id: string;
  readonly scope_snapshot_revision: number;
  readonly scope_snapshot_digest: string;
  readonly target: AiSearchProjectCopyScope["target"];
  readonly generation_metadata_value: string;
  readonly representative_policy: "ONE_CANONICAL_COPY_PER_SOURCE_REVISION";
  readonly target_selection: ProjectCopyV2Selection;
  readonly copies: readonly ProjectCopyV2MembershipCopy[];
}

export type ProjectCopyResolvedScope = AiSearchProjectCopyScope | ProjectCopyScopeV2;

export type ProjectCopyRequiredSetFacts = ManagedRequiredSetReceipt & {
  /** Bounded projection of the existing #356 read model, already Core-fenced. */
  readonly copies: readonly ProjectCopyMembershipFact[];
};

export interface ResolveProjectCopyScopeInput {
  readonly scope_snapshot: ScopeSnapshot;
  readonly observed_at: string;
  readonly target: ManagedTargetIdentity;
  readonly selection?: ProjectCopySelectionReceipt;
  /** Existing scope currentness service; includes project membership-head fencing. */
  readonly require_current_scope: (snapshot: ScopeSnapshot) => Promise<unknown>;
  /** Existing canonical Core atom resolver, never a PROJECT-token scan. */
  readonly resolve_atom: (
    atom: DeterministicScopeAtom,
    observed_at: string,
  ) => Promise<DeterministicScopeAtomResolution>;
  /** Existing target-specific current required-set read model; no duplicate SQL query. */
  readonly load_required_set: (
    target: ManagedTargetIdentity,
    as_of: string,
    source_revision_refs: readonly string[],
    selection?: ProjectCopySelectionReceipt,
  ) => Promise<ProjectCopyRequiredSetFacts>;
}

export type ProjectCopyScopeErrorCode =
  | "PROJECT_COPY_SCOPE_INPUT_INVALID"
  | "PROJECT_COPY_SCOPE_STALE"
  | "PROJECT_COPY_SCOPE_REQUIRED_SET_INVALID"
  | "PROJECT_COPY_SCOPE_MEMBERSHIP_MISSING"
  | "PROJECT_COPY_SCOPE_MEMBERSHIP_AMBIGUOUS";

export class ProjectCopyScopeError extends Error {
  public constructor(public readonly code: ProjectCopyScopeErrorCode, message: string) {
    super(message);
    this.name = "ProjectCopyScopeError";
  }
}

interface CopySelection {
  readonly all_memberships: boolean;
  readonly membership_ids: ReadonlySet<string>;
}

interface AnnotatedScope {
  readonly source_revisions: ReadonlySet<string>;
  readonly selection_by_source: ReadonlyMap<string, CopySelection>;
}

function fail(code: ProjectCopyScopeErrorCode, message: string): never {
  throw new ProjectCopyScopeError(code, message);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isSetExpression(expression: ScopeExpression): expression is ScopeSetExpression {
  return expression.kind === "UNION" || expression.kind === "INTERSECT" || expression.kind === "EXCEPT";
}

function unionSet(left: ReadonlySet<string>, right: ReadonlySet<string>): Set<string> {
  return new Set([...left, ...right]);
}

function intersectSet(left: ReadonlySet<string>, right: ReadonlySet<string>): Set<string> {
  return new Set([...left].filter((value) => right.has(value)));
}

function exceptSet(left: ReadonlySet<string>, right: ReadonlySet<string>): Set<string> {
  return new Set([...left].filter((value) => !right.has(value)));
}

function mergeSelection(left: CopySelection, right: CopySelection, kind: "UNION" | "INTERSECT"): CopySelection {
  if (kind === "UNION") {
    if (left.all_memberships || right.all_memberships) {
      return { all_memberships: true, membership_ids: new Set() };
    }
    return { all_memberships: false, membership_ids: unionSet(left.membership_ids, right.membership_ids) };
  }
  if (left.all_memberships && right.all_memberships) {
    return { all_memberships: true, membership_ids: new Set() };
  }
  if (left.all_memberships) return right;
  if (right.all_memberships) return left;
  // Scope intersection is over source revisions. Either intersected project
  // copy is an authorized representative of a source present in both sets.
  return { all_memberships: false, membership_ids: unionSet(left.membership_ids, right.membership_ids) };
}

function annotateExpression(
  expression: ScopeExpression,
  atomMembers: ReadonlyMap<string, ReadonlySet<string>>,
  copiesBySource: ReadonlyMap<string, readonly ProjectCopyMembershipFact[]>,
): AnnotatedScope {
  if (!isSetExpression(expression)) {
    const refs = atomMembers.get(scopeExpressionIdentity(expression));
    if (refs === undefined) fail("PROJECT_COPY_SCOPE_REQUIRED_SET_INVALID", "canonical atom resolution is missing");
    const selected = new Map<string, CopySelection>();
    for (const sourceRevision of refs) {
      if (expression.kind === "PROJECT") {
        const projectMemberships = (copiesBySource.get(sourceRevision) ?? [])
          .filter((copy) => copy.project_id === expression.project_id);
        selected.set(sourceRevision, {
          all_memberships: false,
          membership_ids: new Set(projectMemberships.map((copy) => copy.project_membership_id)),
        });
      } else {
        selected.set(sourceRevision, { all_memberships: true, membership_ids: new Set() });
      }
    }
    return { source_revisions: new Set(refs), selection_by_source: selected };
  }

  const left = annotateExpression(expression.left, atomMembers, copiesBySource);
  const right = annotateExpression(expression.right, atomMembers, copiesBySource);
  if (expression.kind === "EXCEPT") {
    const sourceRevisions = exceptSet(left.source_revisions, right.source_revisions);
    const selections = new Map<string, CopySelection>();
    for (const sourceRevision of sourceRevisions) {
      const selection = left.selection_by_source.get(sourceRevision);
      if (selection !== undefined) selections.set(sourceRevision, selection);
    }
    return { source_revisions: sourceRevisions, selection_by_source: selections };
  }

  const sourceRevisions = expression.kind === "UNION"
    ? unionSet(left.source_revisions, right.source_revisions)
    : intersectSet(left.source_revisions, right.source_revisions);
  const selections = new Map<string, CopySelection>();
  for (const sourceRevision of sourceRevisions) {
    const leftSelection = left.selection_by_source.get(sourceRevision);
    const rightSelection = right.selection_by_source.get(sourceRevision);
    if (leftSelection !== undefined && rightSelection !== undefined) {
      selections.set(sourceRevision, mergeSelection(leftSelection, rightSelection, expression.kind));
    } else {
      const selected = leftSelection ?? rightSelection;
      if (selected !== undefined) selections.set(sourceRevision, selected);
    }
  }
  return { source_revisions: sourceRevisions, selection_by_source: selections };
}

function compareCopy(left: ProjectCopyMembershipFact, right: ProjectCopyMembershipFact): number {
  return compareText(left.project_id, right.project_id) ||
    left.membership_revision - right.membership_revision ||
    compareText(left.stable_project_membership_id, right.stable_project_membership_id);
}

function sameSelection(
  left: ProjectCopySelectionReceipt,
  right: ProjectCopySelectionReceipt,
): boolean {
  return canonicalProjectionJson(left) === canonicalProjectionJson(right);
}

async function stableMembershipFolderPrefix(
  target: ManagedTargetIdentity,
  copy: ProjectCopyMembershipFact,
): Promise<string> {
  const token = await stableProjectionId(
    "p",
    "PROJECT_COPY_V2",
    target.managed_instance_id,
    target.managed_generation,
    copy.source_revision_ref,
    copy.project_id,
    copy.stable_project_membership_id,
    String(copy.membership_revision),
  );
  const prefix = `projection/${token}/`;
  if (new TextEncoder().encode(prefix).byteLength >= MANAGED_PROJECT_FOLDER_FILTER_MAX_BYTES) {
    fail("PROJECT_COPY_SCOPE_REQUIRED_SET_INVALID", "stable membership folder prefix exceeds the provider filter bound");
  }
  return prefix;
}

/**
 * Resolve one Core-authorized versioned project-copy representative per source
 * in the frozen scope. The canonical ScopeExpression evaluator determines the
 * source set; the accompanying provenance fold retains set-operation meaning
 * while mapping each surviving source to eligible project memberships.
 */
export async function resolveProjectCopyScope(
  input: ResolveProjectCopyScopeInput,
): Promise<ProjectCopyResolvedScope> {
  const parsed = ScopeSnapshotSchema.safeParse(input.scope_snapshot);
  if (!parsed.success) fail("PROJECT_COPY_SCOPE_INPUT_INVALID", "frozen ScopeSnapshot failed strict validation");
  const snapshot = parsed.data;
  const selection: ProjectCopySelectionReceipt = input.selection ?? Object.freeze({
    protocol: "eliotr.managed-target-selection.v1",
    domain: "MANAGED_TARGET_ASSIGNMENT",
    decision_version: 1,
    selection_mode: "EXACT_GENERATION_V1",
    target: input.target,
  });
  if (selection.target.namespace !== input.target.namespace ||
      selection.target.managed_instance_id !== input.target.managed_instance_id ||
      selection.target.managed_generation !== input.target.managed_generation ||
      selection.target.target_profile_identity_sha256 !== input.target.target_profile_identity_sha256) {
    fail("PROJECT_COPY_SCOPE_INPUT_INVALID", "versioned target selection differs from the exact target");
  }
  const observedAtMs = Date.parse(input.observed_at);
  if (!Number.isFinite(observedAtMs) || new Date(observedAtMs).toISOString() !== input.observed_at) {
    fail("PROJECT_COPY_SCOPE_INPUT_INVALID", "project-copy membership observation time is not canonical UTC");
  }
  await input.require_current_scope(snapshot);

  const atomCache = new Map<string, Promise<DeterministicScopeAtomResolution>>();
  const atomResolver = {
    resolve(atom: DeterministicScopeAtom): Promise<DeterministicScopeAtomResolution> {
      const identity = scopeExpressionIdentity(atom);
      const cached = atomCache.get(identity);
      if (cached !== undefined) return cached;
      const pending = input.resolve_atom(atom, snapshot.created_at);
      atomCache.set(identity, pending);
      return pending;
    },
  };
  const draft = await resolveDeterministicScopeSnapshotDraft(snapshot.resolved_scope_expression, atomResolver);
  const resolvedMembers = [...draft.members].sort((left, right) => compareText(left.source_revision_ref, right.source_revision_ref));
  const resolvedRefs = resolvedMembers.map((member) => member.source_revision_ref);
  if (!sameStrings(snapshot.member_source_revision_refs, resolvedRefs) ||
      Object.keys(snapshot.source_owner_generations).length !== resolvedMembers.length ||
      resolvedMembers.some((member) => snapshot.source_owner_generations[member.source_revision_ref] !== member.source_owner_generation)) {
    fail("PROJECT_COPY_SCOPE_STALE", "Core scope evaluation no longer matches the frozen ScopeSnapshot");
  }

  if (resolvedRefs.length === 0) {
    await input.require_current_scope(snapshot);
    const emptyScopeBase = {
      scope_snapshot_id: snapshot.snapshot_id,
      scope_snapshot_revision: snapshot.revision,
      scope_snapshot_digest: snapshot.digest,
      target: Object.freeze({
        namespace: input.target.namespace,
        managed_instance_id: input.target.managed_instance_id,
        managed_generation: input.target.managed_generation,
        target_profile_identity_sha256: input.target.target_profile_identity_sha256,
      }),
      generation_metadata_value: await managedProjectGenerationMetadataValue(input.target.managed_generation),
      representative_policy: "ONE_CANONICAL_COPY_PER_SOURCE_REVISION",
      copies: Object.freeze([]) as readonly [],
    };
    return selection.decision_version === 2
      ? Object.freeze({ ...emptyScopeBase, layout: "PROJECT_COPY_V2", target_selection: selection })
      : Object.freeze({ ...emptyScopeBase, layout: "PROJECT_COPY_V1" });
  }

  const required = await input.load_required_set(
    input.target,
    input.observed_at,
    resolvedRefs,
    input.selection,
  );
  const stableSelection = selection.decision_version === 2;
  const selectionDigest = stableSelection ? await projectionDigest(selection) : null;
  const selectionReceiptMatches = stableSelection
    ? required.protocol === "eliotr.managed-required-project-revisions.v3" &&
      required.target_fence.protocol === "eliotr.managed-required-set-target-fence.v2" &&
      "target_selection" in required &&
      sameSelection(required.target_selection, selection) &&
      required.target_fence.target_selection_sha256 === selectionDigest
    : required.protocol === "eliotr.managed-required-project-revisions.v2" &&
      required.target_fence.protocol === "eliotr.managed-required-set-target-fence.v1" &&
      !("target_selection" in required);
  if (!selectionReceiptMatches ||
      required.as_of !== input.observed_at ||
      !/^[a-f0-9]{64}$/u.test(required.target_fence.digest) ||
      required.target_fence.required_set_sha256 !== required.required_set_digest ||
      required.target_fence.project_revision_copy_count !== required.project_revision_copy_count ||
      required.target_fence.assigned_project_count !== required.assigned_project_count ||
      required.target_fence.page_count !== required.page_count ||
      required.target.namespace !== input.target.namespace ||
      required.target.managed_instance_id !== input.target.managed_instance_id ||
      required.target.managed_generation !== input.target.managed_generation ||
      required.target.target_profile_identity_sha256 !== input.target.target_profile_identity_sha256 ||
      !Array.isArray(required.copies) ||
      required.copies.length > 102_400) {
    fail("PROJECT_COPY_SCOPE_REQUIRED_SET_INVALID", "Core required-set facts do not match the frozen target");
  }

  const sourceRefSet = new Set(resolvedRefs);
  const copiesBySource = new Map<string, ProjectCopyMembershipFact[]>();
  for (const copy of required.copies) {
    if (!sourceRefSet.has(copy.source_revision_ref)) continue;
    let rawPair: unknown;
    try {
      rawPair = JSON.parse(copy.membership_id);
    } catch {
      fail("PROJECT_COPY_SCOPE_REQUIRED_SET_INVALID", "Core membership pair is not canonical JSON");
    }
    const stableMembershipId = await stableProjectionId("project-membership", copy.membership_id);
    const legacyMembershipId = `project:${copy.project_id}:generation:${copy.membership_generation}`;
    const rowMembershipIdentityValid = copy.assignment_decision_version === 1
      ? copy.project_membership_identity_version === 1 &&
        copy.legacy_project_membership_id === legacyMembershipId &&
        copy.project_membership_id === legacyMembershipId
      : copy.assignment_decision_version === 2 &&
        copy.project_membership_identity_version === 2 &&
        copy.legacy_project_membership_id === null &&
        copy.project_membership_id === stableMembershipId;
    const assignmentSelectionValid = selection.decision_version === 1
      ? copy.assignment_decision_version === 1
      : (copy.assignment_decision_version === 1 || copy.assignment_decision_version === 2);
    if (snapshot.source_owner_generations[copy.source_revision_ref] !== copy.source_owner_generation ||
        !Array.isArray(rawPair) || rawPair.length !== 2 ||
        rawPair[0] !== copy.project_id || rawPair[1] !== copy.source_id ||
        canonicalProjectionJson(rawPair) !== copy.membership_id ||
        copy.stable_project_membership_id !== stableMembershipId ||
        !Number.isSafeInteger(copy.membership_generation) || copy.membership_generation < 1 ||
        !Number.isSafeInteger(copy.membership_revision) || copy.membership_revision < 1 ||
        !Number.isSafeInteger(copy.project_membership_generation) || copy.project_membership_generation < 1 ||
        copy.membership_generation > copy.project_membership_generation ||
        !rowMembershipIdentityValid || !assignmentSelectionValid) {
      fail("PROJECT_COPY_SCOPE_REQUIRED_SET_INVALID", "Core project copy differs from the frozen source or versioned membership identity");
    }
    const forSource = copiesBySource.get(copy.source_revision_ref) ?? [];
    if (forSource.length >= 256) fail("PROJECT_COPY_SCOPE_REQUIRED_SET_INVALID", "source exceeds the 256-project membership bound");
    if (forSource.some((prior) => prior.project_membership_id === copy.project_membership_id)) {
      fail("PROJECT_COPY_SCOPE_MEMBERSHIP_AMBIGUOUS", "Core required set repeats a project membership");
    }
    forSource.push(copy);
    copiesBySource.set(copy.source_revision_ref, forSource);
  }

  const atomMembers = new Map<string, ReadonlySet<string>>();
  for (const [identity, pending] of atomCache) {
    const resolved = await pending;
    atomMembers.set(identity, new Set(resolved.members.map((member) => member.source_revision_ref)));
  }
  const annotated = annotateExpression(snapshot.resolved_scope_expression, atomMembers, copiesBySource);
  if (!sameStrings([...annotated.source_revisions].sort(), resolvedRefs)) {
    fail("PROJECT_COPY_SCOPE_STALE", "project membership provenance differs from canonical scope evaluation");
  }

  const selected: ProjectCopyMembershipFact[] = [];
  for (const sourceRevision of resolvedRefs) {
    const eligibility = annotated.selection_by_source.get(sourceRevision);
    const memberships = copiesBySource.get(sourceRevision) ?? [];
    const candidates = memberships.filter((copy) => eligibility !== undefined &&
      (eligibility.all_memberships || eligibility.membership_ids.has(copy.project_membership_id)));
    candidates.sort(compareCopy);
    const representative = candidates[0];
    if (representative === undefined) {
      fail("PROJECT_COPY_SCOPE_MEMBERSHIP_MISSING", `source revision ${sourceRevision} has no Core-authorized project copy`);
    }
    selected.push(representative);
  }

  await input.require_current_scope(snapshot);
  const generationMetadataValue = await managedProjectGenerationMetadataValue(input.target.managed_generation);
  const projectIds = new Set(selected.map((copy) => copy.project_id));
  if (projectIds.size > 256) fail("PROJECT_COPY_SCOPE_REQUIRED_SET_INVALID", "scope exceeds the 256-project owner bound");
  assertAiSearchScopeFilterBudget(resolvedRefs, generationMetadataValue, selected.length);
  const copies: (AiSearchAuthorizedProjectCopy | ProjectCopyV2MembershipCopy)[] = await Promise.all(selected.map(async (copy) => {
    const isStableMembership = copy.project_membership_identity_version === 2;
    const membershipId = isStableMembership
      ? copy.stable_project_membership_id
      : copy.legacy_project_membership_id;
    if (membershipId === null) {
      fail("PROJECT_COPY_SCOPE_REQUIRED_SET_INVALID", "V1 membership identity lacks its preserved legacy key");
    }
    const folderPrefix = isStableMembership
      ? await stableMembershipFolderPrefix(input.target, copy)
      : await managedProjectFolderPrefix({
        instance_id: input.target.managed_instance_id,
        projection_generation: input.target.managed_generation,
        source_revision_ref: copy.source_revision_ref,
        project_id: copy.project_id,
        project_membership_id: membershipId,
        membership_generation: copy.membership_generation,
      });
    const base = {
      source_revision_ref: copy.source_revision_ref,
      source_owner_generation: copy.source_owner_generation,
      project_id: copy.project_id,
      project_membership_id: membershipId,
      membership_generation: copy.membership_generation,
      folder_prefix: folderPrefix,
    };
    return selection.decision_version === 2
      ? Object.freeze({
        ...base,
        membership_identity_version: copy.project_membership_identity_version,
        ...(isStableMembership
          ? {
            stable_project_membership_id: copy.stable_project_membership_id,
            membership_revision: copy.membership_revision,
            project_membership_generation: copy.project_membership_generation,
          }
          : { legacy_project_membership_id: copy.legacy_project_membership_id }),
      }) as ProjectCopyV2MembershipCopy
      : Object.freeze(base);
  }));
  const resolvedScopeBase = {
    scope_snapshot_id: snapshot.snapshot_id,
    scope_snapshot_revision: snapshot.revision,
    scope_snapshot_digest: snapshot.digest,
    target: Object.freeze({
      namespace: input.target.namespace,
      managed_instance_id: input.target.managed_instance_id,
      managed_generation: input.target.managed_generation,
      target_profile_identity_sha256: input.target.target_profile_identity_sha256,
    }),
    generation_metadata_value: generationMetadataValue,
    representative_policy: "ONE_CANONICAL_COPY_PER_SOURCE_REVISION",
  };
  return selection.decision_version === 2
    ? Object.freeze({
      ...resolvedScopeBase,
      layout: "PROJECT_COPY_V2",
      target_selection: selection,
      copies: Object.freeze(copies as ProjectCopyV2MembershipCopy[]),
    })
    : Object.freeze({
      ...resolvedScopeBase,
      layout: "PROJECT_COPY_V1",
      copies: Object.freeze(copies as AiSearchAuthorizedProjectCopy[]),
    });
}

export interface CreateD1ProjectCopyScopeResolverInput {
  readonly database: D1Database;
  readonly access: EvidenceAccessContext;
  readonly require_current_scope: (snapshot: ScopeSnapshot) => Promise<unknown>;
  readonly resolve_selection?: (
    authority: Parameters<AiSearchManagedProjectCopyScopeResolver>[1],
  ) => Promise<ProjectCopySelectionReceipt>;
}

/**
 * Compose the existing owner scope authority with the #356 Core required-set
 * read model. This consumes its typed, fenced facts and adds no D1 query or
 * membership index of its own.
 */
export function createD1ProjectCopyScopeResolver(
  input: CreateD1ProjectCopyScopeResolverInput,
): AiSearchManagedProjectCopyScopeResolver {
  const resolver = async (request: Parameters<AiSearchManagedProjectCopyScopeResolver>[0],
    active: Parameters<AiSearchManagedProjectCopyScopeResolver>[1]) => {
    const target = {
      namespace: active.namespace,
      managed_instance_id: active.instance_id,
      managed_generation: active.index_generation,
      target_profile_identity_sha256: active.target_profile_identity_sha256,
    };
    const selection = await input.resolve_selection?.(active);
    return resolveD1ProjectCopyScope({
      ...input,
      scope_snapshot: request.scope_snapshot,
      observed_at: new Date().toISOString(),
      target,
      ...(selection === undefined ? {} : { selection }),
    });
  };
  // The public AI Search scope type is Root-owned and still V1-only. Runtime V2
  // receipts are explicit here; Root updates that public resolver contract.
  return resolver as unknown as AiSearchManagedProjectCopyScopeResolver;
}

/** Shared Core composition for a frozen snapshot; callers never fabricate a retrieval request. */
export async function resolveD1ProjectCopyScope(
  input: CreateD1ProjectCopyScopeResolverInput & Pick<ResolveProjectCopyScopeInput, "scope_snapshot" | "observed_at" | "target" | "selection">,
): Promise<ProjectCopyResolvedScope> {
  const requiredSetPort = createD1ManagedRequiredSetPort(input.database);
  return resolveProjectCopyScope({
    scope_snapshot: input.scope_snapshot,
    observed_at: input.observed_at,
    target: input.target,
    ...(input.selection === undefined ? {} : { selection: input.selection }),
    require_current_scope: input.require_current_scope,
    resolve_atom: createOwnerScopeAuthority(input.database, input.access).exhaustiveResolveAtom,
    load_required_set: async (target, asOf, sourceRevisionRefs, selection) => {
      const selectedRefs = new Set(sourceRevisionRefs);
      const copies: ProjectCopyMembershipFact[] = [];
      const receipt = await enumerateManagedRequiredSet(requiredSetPort, {
        target,
        ...(selection === undefined ? {} : { selection }),
        as_of: asOf,
        on_copy(copy) {
          if (!selectedRefs.has(copy.source_revision_ref)) return;
          copies.push({
            source_revision_ref: copy.source_revision_ref,
            source_owner_generation: copy.source_owner_generation,
            project_id: copy.project_id,
            project_membership_id: copy.project_membership_id,
            stable_project_membership_id: copy.stable_project_membership_id,
            legacy_project_membership_id: copy.legacy_project_membership_id,
            project_membership_identity_version: copy.project_membership_identity_version,
            membership_id: copy.membership_id,
            membership_revision: copy.membership_revision,
            membership_generation: copy.membership_generation,
            project_membership_generation: copy.project_membership_generation,
            assignment_decision_version: copy.assignment_decision_version,
          });
        },
      });
      return { ...receipt, copies: Object.freeze(copies) };
    },
  });
}
