import type { ScopeExpression } from "@eliotr/contracts";

type ScopeSetExpression = {
  readonly kind: "UNION" | "INTERSECT" | "EXCEPT";
  readonly left: ScopeExpression;
  readonly right: ScopeExpression;
};

export type DeterministicScopeAtom = Exclude<ScopeExpression, ScopeSetExpression>;

export interface DeterministicScopeMember {
  readonly source_revision_ref: string;
  readonly source_owner_generation: string;
  readonly policy_closure_ref: string;
}

export interface DeterministicScopeAtomResolution {
  readonly atom_generation_ref: string;
  readonly members: readonly DeterministicScopeMember[];
}

export interface DeterministicScopeAtomResolver {
  resolve(atom: DeterministicScopeAtom): Promise<DeterministicScopeAtomResolution>;
}

export interface DeterministicScopeResolutionDraft {
  readonly canonical_expression: string;
  readonly participant_generation_refs: readonly string[];
  readonly members: readonly DeterministicScopeMember[];
}

export class DeterministicScopeResolutionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "DeterministicScopeResolutionError";
  }
}

function isScopeSetExpression(expression: ScopeExpression): expression is ScopeSetExpression {
  return "left" in expression && "right" in expression;
}

function requireCanonicalIdentifier(value: string, label: string): string {
  if (value.length === 0 || value.length > 256) {
    throw new DeterministicScopeResolutionError(`${label} must contain 1-256 characters`);
  }
  if (value !== value.trim()) {
    throw new DeterministicScopeResolutionError(`${label} must not contain surrounding whitespace`);
  }
  return value;
}

function canonicalAtom(atom: DeterministicScopeAtom): string {
  switch (atom.kind) {
    case "GLOBAL_LIBRARY":
      return "GLOBAL_LIBRARY";
    case "PROJECT":
      return `project(${JSON.stringify(requireCanonicalIdentifier(atom.project_id, "project_id"))})`;
    case "SELECTED_SOURCES": {
      const ids = [...new Set(atom.source_ids.map((id) =>
        requireCanonicalIdentifier(id, "source_id"),
      ))].sort();
      return `selected_sources(${ids.map((id) => JSON.stringify(id)).join(",")})`;
    }
    case "SOURCE_CLASS":
      return `source_class(${JSON.stringify(requireCanonicalIdentifier(atom.source_class, "source_class"))})`;
    case "TAG":
      return `tag(${JSON.stringify(requireCanonicalIdentifier(atom.tag, "tag"))})`;
  }
}

function flattenCommutative(
  expression: ScopeExpression,
  kind: "UNION" | "INTERSECT",
): readonly ScopeExpression[] {
  if (!isScopeSetExpression(expression) || expression.kind !== kind) return [expression];
  return [
    ...flattenCommutative(expression.left, kind),
    ...flattenCommutative(expression.right, kind),
  ];
}

export function canonicalizeDeterministicScopeExpression(expression: ScopeExpression): string {
  if (!isScopeSetExpression(expression)) return canonicalAtom(expression);
  if (expression.kind === "EXCEPT") {
    return `(${canonicalizeDeterministicScopeExpression(expression.left)} EXCEPT ${canonicalizeDeterministicScopeExpression(expression.right)})`;
  }

  const operands = [...new Set(
    flattenCommutative(expression, expression.kind)
      .map((operand) => canonicalizeDeterministicScopeExpression(operand)),
  )].sort();
  return `(${operands.join(` ${expression.kind} `)})`;
}

function normalizeMember(member: DeterministicScopeMember): DeterministicScopeMember {
  return {
    source_revision_ref: requireCanonicalIdentifier(
      member.source_revision_ref,
      "source_revision_ref",
    ),
    source_owner_generation: requireCanonicalIdentifier(
      member.source_owner_generation,
      "source_owner_generation",
    ),
    policy_closure_ref: requireCanonicalIdentifier(
      member.policy_closure_ref,
      "policy_closure_ref",
    ),
  };
}

function normalizeMembers(
  members: readonly DeterministicScopeMember[],
): readonly DeterministicScopeMember[] {
  const byRevision = new Map<string, DeterministicScopeMember>();
  for (const rawMember of members) {
    const member = normalizeMember(rawMember);
    const prior = byRevision.get(member.source_revision_ref);
    if (
      prior !== undefined &&
      (prior.source_owner_generation !== member.source_owner_generation ||
        prior.policy_closure_ref !== member.policy_closure_ref)
    ) {
      throw new DeterministicScopeResolutionError(
        `conflicting generation or policy closure for ${member.source_revision_ref}`,
      );
    }
    byRevision.set(member.source_revision_ref, member);
  }
  return [...byRevision.values()].sort((left, right) =>
    left.source_revision_ref.localeCompare(right.source_revision_ref),
  );
}

function assertCompatibleOverlap(
  left: readonly DeterministicScopeMember[],
  right: readonly DeterministicScopeMember[],
): void {
  const rightByRevision = new Map(right.map((member) => [member.source_revision_ref, member]));
  for (const member of left) {
    const other = rightByRevision.get(member.source_revision_ref);
    if (
      other !== undefined &&
      (other.source_owner_generation !== member.source_owner_generation ||
        other.policy_closure_ref !== member.policy_closure_ref)
    ) {
      throw new DeterministicScopeResolutionError(
        `conflicting generation or policy closure for ${member.source_revision_ref}`,
      );
    }
  }
}

function union(
  left: readonly DeterministicScopeMember[],
  right: readonly DeterministicScopeMember[],
): readonly DeterministicScopeMember[] {
  return normalizeMembers([...left, ...right]);
}

function intersect(
  left: readonly DeterministicScopeMember[],
  right: readonly DeterministicScopeMember[],
): readonly DeterministicScopeMember[] {
  assertCompatibleOverlap(left, right);
  const rightKeys = new Set(right.map((member) => member.source_revision_ref));
  return normalizeMembers(left.filter((member) => rightKeys.has(member.source_revision_ref)));
}

function except(
  left: readonly DeterministicScopeMember[],
  right: readonly DeterministicScopeMember[],
): readonly DeterministicScopeMember[] {
  assertCompatibleOverlap(left, right);
  const rightKeys = new Set(right.map((member) => member.source_revision_ref));
  return normalizeMembers(left.filter((member) => !rightKeys.has(member.source_revision_ref)));
}

interface IntermediateResolution {
  readonly generations: readonly string[];
  readonly members: readonly DeterministicScopeMember[];
}

async function evaluate(
  expression: ScopeExpression,
  resolver: DeterministicScopeAtomResolver,
): Promise<IntermediateResolution> {
  if (!isScopeSetExpression(expression)) {
    const resolved = await resolver.resolve(expression);
    return {
      generations: [requireCanonicalIdentifier(
        resolved.atom_generation_ref,
        "atom_generation_ref",
      )],
      members: normalizeMembers(resolved.members),
    };
  }

  const [left, right] = await Promise.all([
    evaluate(expression.left, resolver),
    evaluate(expression.right, resolver),
  ]);
  const generations = [...new Set([...left.generations, ...right.generations])].sort();
  const members = expression.kind === "UNION"
    ? union(left.members, right.members)
    : expression.kind === "INTERSECT"
      ? intersect(left.members, right.members)
      : except(left.members, right.members);
  return { generations, members };
}

/**
 * Produces deterministic material for a ScopeSnapshot. Persistence, purge-ledger binding,
 * disclosure closure and digesting are application-level steps and must occur before retrieval.
 */
export async function resolveDeterministicScopeSnapshotDraft(
  expression: ScopeExpression,
  resolver: DeterministicScopeAtomResolver,
): Promise<DeterministicScopeResolutionDraft> {
  const resolved = await evaluate(expression, resolver);
  return {
    canonical_expression: canonicalizeDeterministicScopeExpression(expression),
    participant_generation_refs: resolved.generations,
    members: resolved.members,
  };
}
