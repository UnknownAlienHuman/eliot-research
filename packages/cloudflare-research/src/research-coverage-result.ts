import {
  CoverageReceiptSchema,
  IdentifierSchema,
  Sha256Schema,
  VersionedRefSchema,
  type CoverageReceipt,
  type VersionedRef,
} from "@eliotr/contracts";
import { canonicalEvidenceJson } from "@eliotr/cloudflare-evidence";
import { MAX_WORKFLOW_OUTPUT_BYTES, fail } from "@eliotr/cloudflare-workflows";
import { z } from "zod";

const PROTOCOL = "eliotr.research.coverage.v1" as const;
const STAGE = "CALCULATE_COVERAGE" as const;

const LineageSchema = z.object({
  stage_attempt_ref: IdentifierSchema,
  stage_request_sha256: Sha256Schema,
}).strict();

const ResearchCoverageResultSchema = z.object({
  protocol: z.literal(PROTOCOL),
  operation_id: IdentifierSchema,
  stage: z.literal(STAGE),
  stage_attempt_ref: IdentifierSchema,
  stage_request_sha256: Sha256Schema,
  protocol_scope: z.object({
    scope_snapshot_ref: VersionedRefSchema,
    denominator_ref: VersionedRefSchema,
    protocol_digest: Sha256Schema,
    denominator_digest: Sha256Schema,
    w1_revision: z.number().int().positive(),
  }).strict(),
  stage_five: LineageSchema.extend({
    trace_ref: VersionedRefSchema,
    evidence_pack_ref: VersionedRefSchema,
    coverage_claim: z.enum(["NONE", "SAMPLED"]),
  }),
  stage_fourteen: LineageSchema.extend({ claim_count: z.number().int().nonnegative() }),
  stage_fifteen: LineageSchema.extend({
    citation_receipt_ref: VersionedRefSchema,
    resolved_count: z.number().int().nonnegative(),
    requested_count: z.number().int().nonnegative(),
  }),
  coverage_receipt: CoverageReceiptSchema,
}).strict();

export type ResearchCoverageResult = z.infer<typeof ResearchCoverageResultSchema>;

export interface ResearchCoverageResultInput {
  readonly operation_id: string;
  readonly stage_attempt_ref: string;
  readonly stage_request_sha256: string;
  readonly protocol_scope: ResearchCoverageResult["protocol_scope"];
  readonly stage_five: ResearchCoverageResult["stage_five"];
  readonly stage_fourteen: ResearchCoverageResult["stage_fourteen"];
  readonly stage_fifteen: ResearchCoverageResult["stage_fifteen"];
  readonly coverage_receipt: CoverageReceipt;
}

function failInput(message: string, cause?: unknown): never {
  fail("WORKFLOW_INPUT_INVALID", message, cause);
}

function failCorrupt(message: string, cause?: unknown): never {
  fail("WORKFLOW_OUTPUT_CORRUPT", message, cause);
}

function decodeValue(value: unknown): ResearchCoverageResult {
  const parsed = ResearchCoverageResultSchema.safeParse(value);
  if (!parsed.success) failCorrupt("coverage result failed strict validation", parsed.error);
  const receipt = parsed.data.coverage_receipt;
  if (receipt.requested_count !== receipt.cited_source_refs.length && receipt.requested_count < 0) {
    failCorrupt("coverage receipt contains an invalid requested count");
  }
  return Object.freeze({
    ...parsed.data,
    protocol_scope: Object.freeze({ ...parsed.data.protocol_scope }),
    stage_five: Object.freeze({ ...parsed.data.stage_five }),
    stage_fourteen: Object.freeze({ ...parsed.data.stage_fourteen }),
    stage_fifteen: Object.freeze({ ...parsed.data.stage_fifteen }),
    coverage_receipt: Object.freeze(parsed.data.coverage_receipt),
  });
}

export function encodeResearchCoverageResult(input: ResearchCoverageResultInput): Uint8Array {
  let parsed: ResearchCoverageResult;
  try {
    parsed = decodeValue({ protocol: PROTOCOL, stage: STAGE, ...input });
  } catch (cause) {
    failInput("coverage result input is invalid", cause);
  }
  const bytes = new TextEncoder().encode(canonicalEvidenceJson(parsed));
  if (bytes.byteLength > MAX_WORKFLOW_OUTPUT_BYTES) failInput("coverage result exceeds the workflow output bound");
  return bytes;
}

export function decodeResearchCoverageResult(bytes: Uint8Array): ResearchCoverageResult {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAX_WORKFLOW_OUTPUT_BYTES) {
    failCorrupt("coverage result bytes exceed the workflow output bound");
  }
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch (cause) { failCorrupt("coverage result is not valid UTF-8", cause); }
  let value: unknown;
  try { value = JSON.parse(text) as unknown; }
  catch (cause) { failCorrupt("coverage result is not valid JSON", cause); }
  const parsed = decodeValue(value);
  if (canonicalEvidenceJson(parsed) !== text) failCorrupt("coverage result is not canonical JSON");
  return parsed;
}

