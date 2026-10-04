import {
  ResearchBranchRoleSchema,
  VersionedRefSchema,
  type ResearchBranchRole,
} from "@eliotr/contracts";
import { fail } from "@eliotr/cloudflare-workflows";
import { z } from "zod";
import { refKey } from "./research-branch-execution-shared.js";

/**
 * Substantive per-role model output. The model analyzes only the branch's
 * pre-selected evidence; the selected handle refs are validated against the
 * role's evidence selection before the result is built.
 */
export const ResearchBranchRoleModelOutputSchema = z.object({
  protocol: z.literal("eliotr.research.branch-role-output.v1"),
  role: ResearchBranchRoleSchema,
  status: z.enum(["CANDIDATE_READY", "BLOCKED"]),
  evidence_handle_refs: z.array(VersionedRefSchema).max(512),
  unknowns: z.array(z.string().min(1).max(1024)).max(64),
  limitations: z.array(z.string().min(1).max(1024)).max(64),
}).strict();
export type ResearchBranchRoleModelOutput = z.infer<typeof ResearchBranchRoleModelOutputSchema>;

function corrupt(message: string): never {
  fail("WORKFLOW_OUTPUT_CORRUPT");
  throw new Error(message);
}

/**
 * Parses raw model output bytes and binds them to the role's evidence selection.
 * Every handle the model cites must be one of the role's pre-selected handles;
 * anything else is a reference-firewall violation and fails closed.
 */
export function parseBranchRoleModelOutput(
  outputBytes: Uint8Array,
  role: ResearchBranchRole,
  selectedHandleRefs: readonly { readonly id: string; readonly revision: number }[],
): ResearchBranchRoleModelOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(outputBytes));
  } catch {
    return corrupt("branch role model output is not valid JSON");
  }
  const output = ResearchBranchRoleModelOutputSchema.safeParse(parsed);
  if (!output.success) return corrupt("branch role model output does not match the installed schema");
  if (output.data.role !== role) return corrupt("branch role model output is bound to another role");
  const allowed = new Set(selectedHandleRefs.map((ref) => refKey(ref)));
  for (const ref of output.data.evidence_handle_refs) {
    if (!allowed.has(refKey(ref))) return corrupt("branch role model output cites evidence outside the role selection");
  }
  if (new Set(output.data.evidence_handle_refs.map((ref) => refKey(ref))).size !== output.data.evidence_handle_refs.length) {
    return corrupt("branch role model output contains duplicate evidence handles");
  }
  if (output.data.status === "CANDIDATE_READY" && output.data.evidence_handle_refs.length === 0 && role !== "SOURCE_AUDIT") {
    return corrupt("ready branch role output requires evidence");
  }
  if (output.data.status === "BLOCKED" && output.data.evidence_handle_refs.length !== 0) {
    return corrupt("blocked branch role output must not cite evidence");
  }
  return output.data;
}
