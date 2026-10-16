import { ScopeExpressionSchema, type ScopeExpression } from "@eliotr/contracts";

/** An excluded project is not a project the research was performed in. */
export function scopeIncludesProject(value: unknown, projectId: string): boolean {
  const parsed = ScopeExpressionSchema.safeParse(value);
  if (!parsed.success) return false;
  const visit = (scope: ScopeExpression): boolean => {
    if (scope.kind === "PROJECT") return scope.project_id === projectId;
    if (scope.kind === "EXCEPT") return visit(scope.left);
    if (scope.kind === "UNION" || scope.kind === "INTERSECT") return visit(scope.left) || visit(scope.right);
    return false;
  };
  return visit(parsed.data);
}
