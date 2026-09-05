import type { ScopeExpression } from "@eliotr/contracts";
import { domainError, type DomainError } from "./errors.js";
import { err, ok, type Result } from "./result.js";

export interface ScopeUniverse {
  readonly globalSourceRevisionRefs: ReadonlySet<string>;
  readonly projects: ReadonlyMap<string, ReadonlySet<string>>;
  readonly sourceClasses: ReadonlyMap<string, ReadonlySet<string>>;
  readonly tags: ReadonlyMap<string, ReadonlySet<string>>;
  readonly selectedSourceHeads: ReadonlyMap<string, string>;
}

type ScopeSetExpression = Extract<
  ScopeExpression,
  { kind: "UNION" | "INTERSECT" | "EXCEPT" }
>;
export type ScopeAtom = Exclude<ScopeExpression, ScopeSetExpression>;

export interface ScopeExpressionMetrics {
  readonly depth: number;
  readonly atom_count: number;
  readonly selected_source_count: number;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isSetExpression(expression: ScopeExpression): expression is ScopeSetExpression {
  return expression.kind === "UNION" ||
    expression.kind === "INTERSECT" ||
    expression.kind === "EXCEPT";
}

function resolveAtom(
  expression: ScopeAtom,
  universe: ScopeUniverse,
): Result<ReadonlySet<string>, DomainError> {
  switch (expression.kind) {
    case "GLOBAL_LIBRARY":
      return ok(new Set(universe.globalSourceRevisionRefs));
    case "PROJECT": {
      const value = universe.projects.get(expression.project_id);
      return value === undefined
        ? err(domainError("SCOPE_REFERENCE_UNKNOWN", `project:${expression.project_id}`))
        : ok(new Set(value));
    }
    case "SELECTED_SOURCES": {
      const revisions = new Set<string>();
      for (const sourceId of expression.source_ids) {
        const revision = universe.selectedSourceHeads.get(sourceId);
        if (revision === undefined) {
          return err(domainError("SCOPE_REFERENCE_UNKNOWN", `source:${sourceId}`));
        }
        revisions.add(revision);
      }
      return ok(revisions);
    }
    case "SOURCE_CLASS": {
      const value = universe.sourceClasses.get(expression.source_class);
      return value === undefined
        ? err(domainError("SCOPE_REFERENCE_UNKNOWN", `class:${expression.source_class}`))
        : ok(new Set(value));
    }
    case "TAG": {
      const value = universe.tags.get(expression.tag);
      return value === undefined
        ? err(domainError("SCOPE_REFERENCE_UNKNOWN", `tag:${expression.tag}`))
        : ok(new Set(value));
    }
  }
}

function union(left: ReadonlySet<string>, right: ReadonlySet<string>): ReadonlySet<string> {
  return new Set([...left, ...right]);
}

function intersect(left: ReadonlySet<string>, right: ReadonlySet<string>): ReadonlySet<string> {
  return new Set([...left].filter((value) => right.has(value)));
}

function except(left: ReadonlySet<string>, right: ReadonlySet<string>): ReadonlySet<string> {
  return new Set([...left].filter((value) => !right.has(value)));
}

export function resolveScopeExpression(
  expression: ScopeExpression,
  universe: ScopeUniverse,
): Result<ReadonlySet<string>, DomainError> {
  if (!isSetExpression(expression)) return resolveAtom(expression, universe);
  const left = resolveScopeExpression(expression.left, universe);
  if (!left.ok) return left;
  const right = resolveScopeExpression(expression.right, universe);
  if (!right.ok) return right;
  if (expression.kind === "UNION") return ok(union(left.value, right.value));
  if (expression.kind === "INTERSECT") return ok(intersect(left.value, right.value));
  return ok(except(left.value, right.value));
}

function normalizeAtom(expression: ScopeAtom): ScopeAtom {
  if (expression.kind !== "SELECTED_SOURCES") return expression;
  return {
    kind: "SELECTED_SOURCES",
    source_ids: [...new Set(expression.source_ids)].sort(compareText),
  };
}

function flattenCommutative(
  expression: ScopeExpression,
  kind: "UNION" | "INTERSECT",
): readonly ScopeExpression[] {
  if (!isSetExpression(expression) || expression.kind !== kind) return [expression];
  return [
    ...flattenCommutative(expression.left, kind),
    ...flattenCommutative(expression.right, kind),
  ];
}

function normalizedIdentity(expression: ScopeExpression): string {
  return JSON.stringify(expression);
}

/**
 * Canonicalizes the recursive scope AST without changing its set semantics.
 *
 * `UNION` and `INTERSECT` are flattened, deduplicated and sorted. `EXCEPT` keeps operand order.
 * Selected source IDs are deduplicated and sorted, so equivalent temporary scopes share one identity.
 */
export function normalizeScopeExpression(expression: ScopeExpression): ScopeExpression {
  if (!isSetExpression(expression)) return normalizeAtom(expression);
  if (expression.kind === "EXCEPT") {
    return {
      kind: "EXCEPT",
      left: normalizeScopeExpression(expression.left),
      right: normalizeScopeExpression(expression.right),
    };
  }

  const unique = new Map<string, ScopeExpression>();
  for (const operand of flattenCommutative(expression, expression.kind)) {
    const normalized = normalizeScopeExpression(operand);
    unique.set(normalizedIdentity(normalized), normalized);
  }
  const operands = [...unique.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([, operand]) => operand);
  const first = operands[0];
  if (first === undefined) return normalizeScopeExpression(expression.left);
  return operands.slice(1).reduce<ScopeExpression>((left, right) => ({
    kind: expression.kind,
    left,
    right,
  }), first);
}

export function scopeExpressionIdentity(expression: ScopeExpression): string {
  return normalizedIdentity(normalizeScopeExpression(expression));
}

export function scopeExpressionAtoms(expression: ScopeExpression): readonly ScopeAtom[] {
  const normalized = normalizeScopeExpression(expression);
  const byIdentity = new Map<string, ScopeAtom>();
  const pending: ScopeExpression[] = [normalized];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) continue;
    if (isSetExpression(current)) {
      pending.push(current.right, current.left);
    } else {
      byIdentity.set(normalizedIdentity(current), current);
    }
  }
  return [...byIdentity.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([, atom]) => atom);
}

export function inspectScopeExpression(expression: ScopeExpression): ScopeExpressionMetrics {
  let depth = 0;
  let atomCount = 0;
  let selectedSourceCount = 0;
  const pending: { readonly expression: ScopeExpression; readonly depth: number }[] = [{
    expression,
    depth: 1,
  }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) continue;
    depth = Math.max(depth, current.depth);
    if (isSetExpression(current.expression)) {
      pending.push(
        { expression: current.expression.right, depth: current.depth + 1 },
        { expression: current.expression.left, depth: current.depth + 1 },
      );
    } else {
      atomCount += 1;
      if (current.expression.kind === "SELECTED_SOURCES") {
        selectedSourceCount += current.expression.source_ids.length;
      }
    }
  }
  return {
    depth,
    atom_count: atomCount,
    selected_source_count: selectedSourceCount,
  };
}

export * from "./scope/snapshot-identity.js";
