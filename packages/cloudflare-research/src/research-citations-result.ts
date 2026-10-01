import {
  ClaimAuditItemSchema,
  CitationResolutionReceiptSchema,
  Sha256Schema,
  VersionedRefSchema,
  type ClaimAuditItem,
  type CitationResolutionReceipt,
  type VersionedRef,
} from "@eliotr/contracts";
import { canonicalEvidenceJson } from "@eliotr/cloudflare-evidence";
import { MAX_WORKFLOW_OUTPUT_BYTES, WorkflowCheckpointError } from "@eliotr/cloudflare-workflows";
import { z } from "zod";

const PROTOCOL = "eliotr.research.citations.v1" as const;
const STAGE = "RESOLVE_CITATIONS" as const;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9:._/@-]{0,255}$/u;

const ResearchCitationsResultSchema = z.object({
  protocol: z.literal(PROTOCOL),
  operation_id: z.string().regex(IDENTIFIER),
  stage: z.literal(STAGE),
  stage_attempt_ref: z.string().regex(IDENTIFIER),
  stage_request_sha256: Sha256Schema,
  audit: z.object({
    stage_attempt_ref: z.string().regex(IDENTIFIER),
    stage_request_sha256: Sha256Schema,
    input_sha256: Sha256Schema,
    claim_audit_items: z.array(ClaimAuditItemSchema).max(512),
  }).strict(),
  freeze_ref: VersionedRefSchema,
  manifest_ref: VersionedRefSchema,
  scope_snapshot_ref: VersionedRefSchema,
  evidence_pack_ref: VersionedRefSchema,
  citation_resolution_receipt: CitationResolutionReceiptSchema,
}).strict();

export type ResearchCitationsResult = z.infer<typeof ResearchCitationsResultSchema>;

export interface ResearchCitationsResultInput {
  readonly operation_id: string;
  readonly stage_attempt_ref: string;
  readonly stage_request_sha256: string;
  readonly audit: {
    readonly stage_attempt_ref: string;
    readonly stage_request_sha256: string;
    readonly input_sha256: string;
    readonly claim_audit_items: readonly ClaimAuditItem[];
  };
  readonly freeze_ref: VersionedRef;
  readonly manifest_ref: VersionedRef;
  readonly scope_snapshot_ref: VersionedRef;
  readonly evidence_pack_ref: VersionedRef;
  readonly citation_resolution_receipt: CitationResolutionReceipt;
}

function refKey(ref: VersionedRef): string {
  return `${ref.id}:${ref.revision}`;
}

/** Exact union used by RESOLVE_CITATIONS; support and counterevidence are both material. */
export function citationRefsFromClaimAudit(items: readonly ClaimAuditItem[]): readonly VersionedRef[] {
  const refs = new Map<string, VersionedRef>();
  for (const item of items) {
    for (const handle of [...item.exact_support_handles, ...item.counterevidence_handles]) {
      const parsed = VersionedRefSchema.parse(handle.handle_ref);
      refs.set(refKey(parsed), Object.freeze({ ...parsed }));
    }
  }
  return Object.freeze([...refs.values()].sort((left, right) => refKey(left).localeCompare(refKey(right))));
}

function failInput(message: string, cause?: unknown): never {
  void message; void cause;
  throw new WorkflowCheckpointError("WORKFLOW_INPUT_INVALID");
}

function failCorrupt(message: string, cause?: unknown): never {
  void message; void cause;
  throw new WorkflowCheckpointError("WORKFLOW_OUTPUT_CORRUPT");
}

function decodeValue(value: unknown): ResearchCitationsResult {
  const parsed = ResearchCitationsResultSchema.safeParse(value);
  if (!parsed.success) failCorrupt("citation resolution result failed strict validation", parsed.error);
  const expected = citationRefsFromClaimAudit(parsed.data.audit.claim_audit_items);
  const actual = parsed.data.citation_resolution_receipt.requested_handle_refs;
  if (canonicalEvidenceJson(expected) !== canonicalEvidenceJson(actual)) {
    failCorrupt("citation resolution receipt is not bound to the audited support and counterevidence union");
  }
  return Object.freeze({ ...parsed.data, audit: Object.freeze({ ...parsed.data.audit }), citation_resolution_receipt: Object.freeze(parsed.data.citation_resolution_receipt) });
}

export function encodeResearchCitationsResult(input: ResearchCitationsResultInput): Uint8Array {
  let parsed: ResearchCitationsResult;
  try {
    parsed = decodeValue({ protocol: PROTOCOL, operation_id: input.operation_id, stage: STAGE,
      stage_attempt_ref: input.stage_attempt_ref, stage_request_sha256: input.stage_request_sha256,
      audit: input.audit, freeze_ref: input.freeze_ref, manifest_ref: input.manifest_ref,
      scope_snapshot_ref: input.scope_snapshot_ref, evidence_pack_ref: input.evidence_pack_ref,
      citation_resolution_receipt: input.citation_resolution_receipt });
  } catch (cause) { failInput("citation resolution result input is invalid", cause); }
  const bytes = new TextEncoder().encode(canonicalEvidenceJson(parsed));
  if (bytes.byteLength > MAX_WORKFLOW_OUTPUT_BYTES) failInput("citation resolution result exceeds the workflow output bound");
  return bytes;
}

export function decodeResearchCitationsResult(bytes: Uint8Array): ResearchCitationsResult {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAX_WORKFLOW_OUTPUT_BYTES) {
    failCorrupt("citation resolution result bytes exceed the workflow output bound");
  }
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch (cause) { failCorrupt("citation resolution result is not valid UTF-8", cause); }
  let value: unknown;
  try { value = JSON.parse(text) as unknown; }
  catch (cause) { failCorrupt("citation resolution result is not valid JSON", cause); }
  const parsed = decodeValue(value);
  if (canonicalEvidenceJson(parsed) !== text) failCorrupt("citation resolution result is not canonical JSON");
  return parsed;
}
