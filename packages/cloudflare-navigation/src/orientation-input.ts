import { IdentifierSchema, QueryProductSchema, ScopeExpressionSchema } from "@eliotr/contracts";
import { inspectScopeExpression } from "@eliotr/domain";
import type { QueryRequest } from "@eliotr/interfaces";
import { readStreamWithinBytes } from "@eliotr/platform-cloudflare";

export const ORIENTATION_PROFILE = "orientation-metadata-v1";
export const ORIENTATION_MAX_SOURCES = 64;
export const ORIENTATION_MAX_RESULTS = 16;
export const ORIENTATION_TTL_MS = 15 * 60 * 1000;
export class OrientationError extends Error {
  public constructor(public readonly code: string, public readonly status = 409,
    public readonly retryable = false) { super(code); this.name = "OrientationError"; }
}
export function orientationFail(code: string, status = 409, retryable = false): never {
  throw new OrientationError(code, status, retryable);
}
export function orientationId(value: unknown): string {
  const result = IdentifierSchema.safeParse(value);
  if (!result.success || result.data !== result.data.trim() || /[\u0000-\u0020\u007f]/u.test(result.data)) {
    orientationFail("ORIENTATION_INPUT_INVALID", 400);
  }
  return result.data;
}
export function parseOrientationRequest(value: unknown): QueryRequest {
  // Bound the complete object before the recursive public scope schema is invoked.
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  let nodes = 0;
  const seen = new Set<object>();
  while (pending.length) {
    const next = pending.pop();
    if (!next || ++nodes > 2048 || next.depth > 12) orientationFail("ORIENTATION_INPUT_LIMIT", 413);
    if (next.value !== null && typeof next.value === "object") {
      if (seen.has(next.value)) orientationFail("ORIENTATION_INPUT_INVALID", 400);
      seen.add(next.value);
      const entries = Object.values(next.value);
      if (entries.length > 128) orientationFail("ORIENTATION_INPUT_LIMIT", 413);
      entries.forEach((item) => pending.push({ value: item, depth: next.depth + 1 }));
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) orientationFail("ORIENTATION_INPUT_INVALID", 400);
  const record = value as Record<string, unknown>;
  const fields = ["query", "product", "scope_expression", "literals", "evidence_grade", "budget_ref", "max_results"];
  if (Object.keys(record).length !== fields.length || fields.some((key) => !Object.hasOwn(record, key))) {
    orientationFail("ORIENTATION_INPUT_INVALID", 400);
  }
  if (!QueryProductSchema.safeParse(record.product).success || record.product !== "ORIENT" ||
      record.evidence_grade !== "E0" || record.budget_ref !== ORIENTATION_PROFILE) {
    orientationFail("ORIENTATION_PROFILE_UNSUPPORTED", 422);
  }
  if (typeof record.query !== "string" || new TextEncoder().encode(record.query).byteLength > 1024 ||
      /[\u0000-\u001f\u007f]/u.test(record.query) || !Array.isArray(record.literals) || record.literals.length !== 0 ||
      !Number.isSafeInteger(record.max_results) || (record.max_results as number) < 1 ||
      (record.max_results as number) > ORIENTATION_MAX_RESULTS) orientationFail("ORIENTATION_INPUT_INVALID", 400);
  const expression = ScopeExpressionSchema.safeParse(record.scope_expression);
  if (!expression.success) orientationFail("ORIENTATION_INPUT_INVALID", 400);
  const metrics = inspectScopeExpression(expression.data);
  if (metrics.depth > 8 || metrics.atom_count > 16 || metrics.selected_source_count > ORIENTATION_MAX_SOURCES) {
    orientationFail("ORIENTATION_INPUT_LIMIT", 413);
  }
  return { query: record.query, product: "ORIENT", scope_expression: expression.data, literals: [],
    evidence_grade: "E0", budget_ref: ORIENTATION_PROFILE, max_results: record.max_results as number };
}
export async function readOrientationRequest(request: Request, maximum: number): Promise<QueryRequest> {
  const type = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") orientationFail("ORIENTATION_JSON_REQUIRED", 415);
  if (!request.body) orientationFail("ORIENTATION_INPUT_INVALID", 400);
  const bytes = await readStreamWithinBytes(request.body, { label: "http.request.orientation", max_bytes: Math.min(maximum, 16384) });
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { orientationFail("ORIENTATION_INPUT_INVALID", 400); }
  return parseOrientationRequest(value);
}
