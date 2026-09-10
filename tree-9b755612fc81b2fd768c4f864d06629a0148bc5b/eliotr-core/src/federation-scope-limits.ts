interface ScopeFrame {
  readonly value: unknown;
  readonly depth: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function federationScopeExceedsDepth(
  scope: unknown,
  maximumDepth: number,
): boolean {
  const stack: ScopeFrame[] = [{ value: scope, depth: 1 }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    if (current.depth > maximumDepth) return true;
    if (!isRecord(current.value)) continue;
    const kind = current.value.kind;
    if (kind === "UNION" || kind === "INTERSECT" || kind === "EXCEPT") {
      stack.push(
        { value: current.value.left, depth: current.depth + 1 },
        { value: current.value.right, depth: current.depth + 1 },
      );
    }
  }
  return false;
}
