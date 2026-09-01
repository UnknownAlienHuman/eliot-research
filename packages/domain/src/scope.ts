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

export type ScopeAtom = Exclude<
  ScopeExpression,
  { kind: "UNION" | "INTERSECT" | "EXCEPT"; left: ScopeExpression; right: ScopeExpression }
>;

export interface ScopeExpressionMetrics {
  readonly depth: number;
  readonly atom_count: number;
  readonly selected_source_count: number;
}

function isSetExpression(
  expression: ScopeExpression,
): expression is Extract<ScopeExpression, { kind: "UNION" | "INTERSECT" | "EXCEPT" }> {
  return expression.kind === "UNION" || expression.kind === "INTERSECT" || expression.kind === "EXCEPT";
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function union(left: ReadonlySet<string>, right: ReadonlySet<string>): Set<string> {
  return new Set([...left, ...right]);
}

function intersect(left: ReadonlySet<string>, right: ReadonlySet<string>): Set<string> {
  return new Set([...left].filter((value) => right.has(value)));
}

function except(left: ReadonlySet<string>, right: ReadonlySet<string>): Set<string> {
  return new Set([...left].filter((value) => !right.has(value)));
}

function normalizeAtom(expression: ScopeAtom): ScopeAtom {
  switch (expression.kind) {
    case "GLOBAL_LIBRARY":
      return { kind: "GLOBAL_LIBRARY" };
    case "PROJECT":
      return { kind: "PROJECT", project_id: expression.project_id };
    case "SOURCE_CLASS":
      return { kind: "SOURCE_CLASS", source_class: expression.source_class };
    case "TAG":
      return { kind: "TAG", tag: expression.tag };
    case "SELECTED_SOURCES":
      return {
        kind: "SELECTED_SOURCES",
        source_ids: [...new Set(expression.source_ids)].sort(compareText),
      };
  }
}

function flattenCommutative(
  expression: ScopeExpression,
  kind: "UNION" | "INTERSECT",
): readonly ScopeExpression[] {
  if (expression.kind !== kind) return [expression];
  return [
    ...flattenCommutative(expression.left, kind),
    ...flattenCommutative(expression.right, kind),
  ];
}

/**
 * Returns one deterministic AST for equivalent commutative/associative scope expressions.
 * EXCEPT remains ordered. Selected source identities are sorted and deduplicated.
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
    unique.set(scopeExpressionIdentity(normalized), normalized);
  }
  const operands = [...unique.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([, operand]) => operand);
  const first = operands[0];
  if (first === undefined) throw new Error("scope set expression contains no operands");
  return operands.slice(1).reduce<ScopeExpression>(
    (left, right) => ({ kind: expression.kind, left, right }),
    first,
  );
}

/** Stable, content-free identity text for a normalized scope AST. */
export function scopeExpressionIdentity(expression: ScopeExpression): string {
  return JSON.stringify(normalizeScopeExpression(expression));
}

/** Returns unique normalized atoms in deterministic identity order. */
export function scopeExpressionAtoms(expression: ScopeExpression): readonly ScopeAtom[] {
  const atoms = new Map<string, ScopeAtom>();
  const visit = (current: ScopeExpression): void => {
    if (isSetExpression(current)) {
      visit(current.left);
      visit(current.right);
      return;
    }
    const normalized = normalizeAtom(current);
    atoms.set(JSON.stringify(normalized), normalized);
  };
  visit(normalizeScopeExpression(expression));
  return [...atoms.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([, atom]) => atom);
}

export function inspectScopeExpression(expression: ScopeExpression): ScopeExpressionMetrics {
  let depth = 0;
  let atomCount = 0;
  let selectedSourceCount = 0;
  const stack: Array<readonly [ScopeExpression, number]> = [[expression, 1]];
  while (stack.length > 0) {
    const entry = stack.pop();
    if (entry === undefined) break;
    const [current, currentDepth] = entry;
    depth = Math.max(depth, currentDepth);
    if (isSetExpression(current)) {
      stack.push([current.right, currentDepth + 1], [current.left, currentDepth + 1]);
      continue;
    }
    atomCount += 1;
    if (current.kind === "SELECTED_SOURCES") {
      selectedSourceCount += current.source_ids.length;
    }
  }
  return {
    depth,
    atom_count: atomCount,
    selected_source_count: selectedSourceCount,
  };
}

export function resolveScopeExpression(
  expression: ScopeExpression,
  universe: ScopeUniverse,
): Result<ReadonlySet<string>, DomainError> {
  switch (expression.kind) {
    case "GLOBAL_LIBRARY":
      return ok(new Set(universe.globalSourceRevisionRefs));
    case "PROJECT": {
      const refs = universe.projects.get(expression.project_id);
      return refs === undefined
        ? err(domainError("SCOPE_REFERENCE_UNKNOWN", `unknown project ${expression.project_id}`))
        : ok(new Set(refs));
    }
    case "SOURCE_CLASS": {
      const refs = universe.sourceClasses.get(expression.source_class);
      return refs === undefined
        ? err(domainError("SCOPE_REFERENCE_UNKNOWN", `unknown source class ${expression.source_class}`))
        : ok(new Set(refs));
    }
    case "TAG": {
      const refs = universe.tags.get(expression.tag);
      return refs === undefined
        ? err(domainError("SCOPE_REFERENCE_UNKNOWN", `unknown tag ${expression.tag}`))
        : ok(new Set(refs));
    }
    case "SELECTED_SOURCES": {
      const revisions = new Set<string>();
      for (const sourceId of expression.source_ids) {
        const revision = universe.selectedSourceHeads.get(sourceId);
        if (revision === undefined) {
          return err(domainError("SCOPE_REFERENCE_UNKNOWN", `unknown source ${sourceId}`));
        }
        revisions.add(revision);
      }
      return ok(revisions);
    }
    case "UNION":
    case "INTERSECT":
    case "EXCEPT": {
      const left = resolveScopeExpression(expression.left, universe);
      if (!left.ok) return left;
      const right = resolveScopeExpression(expression.right, universe);
      if (!right.ok) return right;
      const result = expression.kind === "UNION"
        ? union(left.value, right.value)
        : expression.kind === "INTERSECT"
          ? intersect(left.value, right.value)
          : except(left.value, right.value);
      return ok(result);
    }
  }
}
