import { canonicalEvidenceJson } from "@eliotr/cloudflare-evidence";
import { IdentifierSchema, VersionedRefSchema } from "@eliotr/contracts";
import { fail, WorkflowCheckpointError } from "@eliotr/cloudflare-workflows";
import { z } from "zod";

type ResearchClaimAuditInputFailurePhase =
  | "VERIFIER"
  | "VERIFY_INPUT"
  | "CONTEXT"
  | "SYNTHESIS"
  | "NORMALIZE"
  | "SOURCES"
  | "RESOLVE"
  | "SOURCE_COMPARE"
  | "FINAL_AUTHORITY"
  | "MATERIAL";

export interface ResearchClaimAuditInputDiagnosticState {
  phase: ResearchClaimAuditInputFailurePhase;
  material_bytes?: number;
  max_context_bytes?: number;
}

function logResearchClaimAuditInputFailure(
  state: ResearchClaimAuditInputDiagnosticState,
  error: unknown,
): void {
  console.error(JSON.stringify({
    event: "research_claim_audit_input_failed",
    phase: state.phase,
    code: error instanceof WorkflowCheckpointError
      ? error.code
      : "UNCLASSIFIED",
    ...(state.material_bytes === undefined ? {} : {
      material_bytes: state.material_bytes,
      max_context_bytes: state.max_context_bytes,
    }),
  }));
}

export async function withResearchClaimAuditInputDiagnostics<T>(
  state: ResearchClaimAuditInputDiagnosticState,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    logResearchClaimAuditInputFailure(state, error);
    throw error;
  }
}

export const ResearchClaimAuditNormalizationConfigSchema = z.object({
  section_ref: VersionedRefSchema,
  required_precision: IdentifierSchema,
  required_source_class: IdentifierSchema,
}).strict();

export type ResearchClaimAuditNormalizationConfig = z.infer<typeof ResearchClaimAuditNormalizationConfigSchema>;
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/** Canonical clone prevents caller-owned nested objects from changing after an await. */
export function detached<T>(value: T, code: "WORKFLOW_INPUT_INVALID" | "WORKFLOW_OUTPUT_CORRUPT" | "WORKFLOW_AUTHORITY_STALE" = "WORKFLOW_INPUT_INVALID"): T {
  let text: string;
  try { text = canonicalEvidenceJson(value); }
  catch { fail(code); }
  try {
    const parsed = JSON.parse(text) as T;
    if (canonicalEvidenceJson(parsed) !== text) fail(code);
    return deepFreeze(parsed);
  } catch {
    fail(code);
  }
}

export function snapshotNormalization(value: ResearchClaimAuditNormalizationConfig): ResearchClaimAuditNormalizationConfig {
  const parsed = ResearchClaimAuditNormalizationConfigSchema.safeParse(value);
  if (!parsed.success) fail("WORKFLOW_INPUT_INVALID");
  return detached(parsed.data);
}
