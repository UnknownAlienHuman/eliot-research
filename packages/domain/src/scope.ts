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

function union(left: ReadonlySet<string>, right: ReadonlySet<string>): Set<string> {
  return new Set([...left, ...right]);
}
function intersect(left: ReadonlySet<string>, right: ReadonlySet<string>): Set<string> {
  return new Set([...left].filter((value) => right.has(value)));
}
function except(left: ReadonlySet<string>, right: ReadonlySet<string>): Set<string> {
  return new Set([...left].filter((value) => !right.has(value)));
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
        if (revision === undefined) return err(domainError("SCOPE_REFERENCE_UNKNOWN", `unknown source ${sourceId}`));
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
      const result = expression.kind === "UNION" ? union(left.value, right.value)
        : expression.kind === "INTERSECT" ? intersect(left.value, right.value)
          : except(left.value, right.value);
      return ok(result);
    }
  }
}
