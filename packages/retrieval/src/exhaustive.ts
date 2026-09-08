// IMPLEMENTED_NOT_LIVE: ER-07 sharded exhaustive exact scan over frozen scopes with earned coverage; R2/D1 composition, Q7 loop and live qualification remain separate.
import type { ScopeSnapshot } from "@eliotr/contracts";
import {
  ExactVerificationError,
  verifyPinnedExactEvidence,
  type VerifyPinnedExactInput,
} from "./evidence-resolver.js";

export interface ExactScanShard {
  readonly shard_id: string;
  readonly source_revision_refs: readonly string[];
  readonly section_object_refs: readonly string[];
  readonly target_uncompressed_bytes: number;
  readonly hard_uncompressed_bytes: number;
  readonly max_sections: number;
}

export interface ExactScanPlan {
  readonly plan_id: string;
  readonly scope_snapshot: ScopeSnapshot;
  readonly probes: readonly string[];
  readonly shards: readonly ExactScanShard[];
  readonly coverage_denominator_ref: string;
  readonly output_manifest_ref: string;
}

export interface ExhaustiveScanPlanner {
  plan(scope: ScopeSnapshot, probes: readonly string[]): Promise<ExactScanPlan>;
}

export interface ExhaustiveScanExecutor {
  executeShard(shard: ExactScanShard, probes: readonly string[]): Promise<{ partial_result_ref: string; scanned_sections: number; matches: number }>;
  merge(plan: ExactScanPlan, partialResultRefs: readonly string[]): Promise<{ result_artifact_ref: string; coverage_receipt_ref: string }>;
}

export const EXACT_SCAN_LIMITS = {
  target_uncompressed_bytes: 2 * 1024 * 1024,
  hard_uncompressed_bytes: 8 * 1024 * 1024,
  max_sections: 128,
} as const;

/**
 * Q5 sharded exact scan: plan, execute, merge.
 *
 * Pure deterministic layer with no D1/R2/network/clock access and no
 * source-grant minting (there is deliberately no grant port: a scan never
 * grants coverage). The caller derives section descriptors from the frozen
 * scope (D1 candidate cursor plus the admissible R2 normalized manifest) and
 * supplies pinned section bytes through the reader port; per-section
 * exactness reuses the Q2 verifier (`verifyPinnedExactEvidence`), so no
 * second verifier can drift from the first.
 *
 * Coverage is earned, never raised: `COMPLETE` requires every denominator
 * shard settled. A shard that timed out is an unknown outcome
 * (`failure-model.md:3`) — it keeps its denominator seat and is never
 * counted as a miss. COMPLETE merge claims are pure here; the Q3 D1 result
 * store still caps stored coverage at SAMPLED, so persisting a COMPLETE
 * claim plus the Q7 ordered loop remain follow-up work.
 */

export interface ExhaustiveSectionDescriptor {
  readonly section_ref: string;
  readonly source_revision_ref: string;
  readonly uncompressed_bytes: number;
}

export const EXHAUSTIVE_PLAN_CAP = {
  max_probes: 64,
  max_probe_bytes: 8 * 1024,
  max_sections: 4096,
} as const;

export type ExhaustivePlanErrorCode =
  | "EXHAUSTIVE_SCOPE_INVALID"
  | "EXHAUSTIVE_EMPTY_SCOPE"
  | "EXHAUSTIVE_PROBES_INVALID"
  | "EXHAUSTIVE_SECTION_INVALID"
  | "EXHAUSTIVE_SECTION_OUT_OF_SCOPE"
  | "EXHAUSTIVE_SECTION_OVERSIZED"
  | "EXHAUSTIVE_SECTION_DUPLICATE"
  | "EXHAUSTIVE_SCOPE_MEMBER_UNCOVERED"
  | "EXHAUSTIVE_PLAN_TOO_LARGE";

export class ExhaustivePlanError extends Error {
  public readonly code: ExhaustivePlanErrorCode;

  public constructor(code: ExhaustivePlanErrorCode, message: string) {
    super(message);
    this.name = "ExhaustivePlanError";
    this.code = code;
  }
}

export type ExhaustiveExecuteErrorCode =
  | "EXHAUSTIVE_SHARD_INVALID"
  | "EXHAUSTIVE_PROBES_INVALID";

export class ExhaustiveExecuteError extends Error {
  public readonly code: ExhaustiveExecuteErrorCode;

  public constructor(code: ExhaustiveExecuteErrorCode, message: string) {
    super(message);
    this.name = "ExhaustiveExecuteError";
    this.code = code;
  }
}

export type ExhaustiveMergeErrorCode =
  | "EXHAUSTIVE_PLAN_INVALID"
  | "EXHAUSTIVE_UNKNOWN_SHARD"
  | "EXHAUSTIVE_DUPLICATE_SHARD";

export class ExhaustiveMergeError extends Error {
  public readonly code: ExhaustiveMergeErrorCode;

  public constructor(code: ExhaustiveMergeErrorCode, message: string) {
    super(message);
    this.name = "ExhaustiveMergeError";
    this.code = code;
  }
}

function failPlan(code: ExhaustivePlanErrorCode, message: string): never {
  throw new ExhaustivePlanError(code, message);
}

function failExecute(code: ExhaustiveExecuteErrorCode, message: string): never {
  throw new ExhaustiveExecuteError(code, message);
}

function failMerge(code: ExhaustiveMergeErrorCode, message: string): never {
  throw new ExhaustiveMergeError(code, message);
}

function utf8Bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function checkProbes(probes: readonly string[]): readonly string[] {
  if (!Array.isArray(probes) || probes.length < 1 || probes.length > EXHAUSTIVE_PLAN_CAP.max_probes) {
    failPlan("EXHAUSTIVE_PROBES_INVALID", "exhaustive scan requires 1..64 exact probes");
  }
  for (const probe of probes) {
    if (typeof probe !== "string" || probe.length === 0) {
      failPlan("EXHAUSTIVE_PROBES_INVALID", "empty probes never match pinned evidence");
    }
    if (utf8Bytes(probe).byteLength > EXHAUSTIVE_PLAN_CAP.max_probe_bytes) {
      failPlan("EXHAUSTIVE_PROBES_INVALID", "a single exact probe exceeds its byte bound");
    }
  }
  return [...probes];
}

function checkExecuteProbes(probes: readonly string[]): readonly string[] {
  if (!Array.isArray(probes) || probes.length < 1 || probes.length > EXHAUSTIVE_PLAN_CAP.max_probes) {
    failExecute("EXHAUSTIVE_PROBES_INVALID", "exhaustive scan requires 1..64 exact probes");
  }
  for (const probe of probes) {
    if (typeof probe !== "string" || probe.length === 0) {
      failExecute("EXHAUSTIVE_PROBES_INVALID", "empty probes never match pinned evidence");
    }
    if (utf8Bytes(probe).byteLength > EXHAUSTIVE_PLAN_CAP.max_probe_bytes) {
      failExecute("EXHAUSTIVE_PROBES_INVALID", "a single exact probe exceeds its byte bound");
    }
  }
  return [...probes];
}

function checkScope(scope: ScopeSnapshot): ScopeSnapshot {
  if (
    scope === null || typeof scope !== "object" ||
    typeof scope.snapshot_id !== "string" || scope.snapshot_id.length === 0 ||
    !Number.isSafeInteger(scope.revision) || scope.revision < 1 ||
    typeof scope.digest !== "string" || scope.digest.length === 0 ||
    !Array.isArray(scope.member_source_revision_refs)
  ) {
    failPlan("EXHAUSTIVE_SCOPE_INVALID", "exhaustive scan requires a frozen ScopeSnapshot");
  }
  if (scope.member_source_revision_refs.length === 0) {
    failPlan("EXHAUSTIVE_EMPTY_SCOPE", "an empty frozen scope has no exhaustive denominator");
  }
  return scope;
}

/** Deterministic non-cryptographic identity hash (FNV-1a); identity only, never authority. */
function identityHex(value: string): string {
  let hash = 0x811c9dc5;
  const bytes = utf8Bytes(value);
  for (let index = 0; index < bytes.length; index += 1) {
    hash ^= bytes[index] as number;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export interface PlanExhaustiveScanInput {
  readonly scope: ScopeSnapshot;
  readonly probes: readonly string[];
  readonly sections: readonly ExhaustiveSectionDescriptor[];
  readonly plan_id?: string;
}

/**
 * Partition a frozen scope into bounded shards.
 *
 * Every section must belong to the frozen scope membership; the denominator
 * is derived from the frozen scope identity (never from what the scan
 * reaches). A shard that would exceed its hard byte bound or its section
 * cap splits instead of stretching; the soft target bound also splits once
 * exceeded. A single section larger than the hard bound fails closed: atomic
 * sections are never silently truncated.
 */
export function planExhaustiveScan(input: PlanExhaustiveScanInput): ExactScanPlan {
  const scope = checkScope(input.scope);
  const probes = checkProbes(input.probes);
  const sections = input.sections;
  if (!Array.isArray(sections) || sections.length === 0) {
    failPlan("EXHAUSTIVE_EMPTY_SCOPE", "an inventoried scope with no sections has no exhaustive denominator");
  }
  if (sections.length > EXHAUSTIVE_PLAN_CAP.max_sections) {
    failPlan("EXHAUSTIVE_PLAN_TOO_LARGE", "exhaustive section inventory exceeds its bound");
  }
  const members = new Set(scope.member_source_revision_refs);
  const seen = new Set<string>();
  for (const section of sections) {
    if (
      section === null || typeof section !== "object" ||
      typeof section.section_ref !== "string" || section.section_ref.length === 0 ||
      typeof section.source_revision_ref !== "string" || section.source_revision_ref.length === 0 ||
      !Number.isSafeInteger(section.uncompressed_bytes) || section.uncompressed_bytes < 1
    ) {
      failPlan("EXHAUSTIVE_SECTION_INVALID", "section inventory carries an invalid descriptor");
    }
    if (!members.has(section.source_revision_ref)) {
      failPlan("EXHAUSTIVE_SECTION_OUT_OF_SCOPE", `section ${section.section_ref} is outside the frozen scope`);
    }
    if (seen.has(section.section_ref)) {
      failPlan("EXHAUSTIVE_SECTION_DUPLICATE", `section ${section.section_ref} is inventoried twice`);
    }
    seen.add(section.section_ref);
    if (section.uncompressed_bytes > EXACT_SCAN_LIMITS.hard_uncompressed_bytes) {
      failPlan("EXHAUSTIVE_SECTION_OVERSIZED", `section ${section.section_ref} exceeds the hard shard byte bound`);
    }
  }
  for (const member of members) {
    if (!sections.some((section) => section.source_revision_ref === member)) {
      // The denominator names the whole frozen scope: a member with no
      // inventoried sections would be silently excluded from every COMPLETE
      // claim built on this plan, so planning fails closed instead.
      failPlan("EXHAUSTIVE_SCOPE_MEMBER_UNCOVERED", `scope member ${member} has no inventoried sections`);
    }
  }
  const planId = typeof input.plan_id === "string" && input.plan_id.length > 0
    ? input.plan_id
    : `exhaustive-plan-${scope.snapshot_id}-r${scope.revision}-${identityHex(`${scope.digest}|${probes.join("\u0000")}|${sections.length}`)}`;
  if (planId.length > 256 || /[\u0000-\u0020\u007f]/u.test(planId)) {
    failPlan("EXHAUSTIVE_SCOPE_INVALID", "exhaustive plan identity is invalid");
  }
  const shards: ExactScanShard[] = [];
  let currentRefs: string[] = [];
  let currentRevisions: string[] = [];
  let currentBytes = 0;
  const closeShard = (): void => {
    if (currentRefs.length === 0) return;
    const index = shards.length.toString().padStart(4, "0");
    shards.push({
      shard_id: `exhaustive-shard-${planId}:${index}`,
      source_revision_refs: [...currentRevisions],
      section_object_refs: [...currentRefs],
      target_uncompressed_bytes: EXACT_SCAN_LIMITS.target_uncompressed_bytes,
      hard_uncompressed_bytes: EXACT_SCAN_LIMITS.hard_uncompressed_bytes,
      max_sections: EXACT_SCAN_LIMITS.max_sections,
    });
    currentRefs = [];
    currentRevisions = [];
    currentBytes = 0;
  };
  for (const section of sections) {
    const hardOverflow = currentBytes + section.uncompressed_bytes > EXACT_SCAN_LIMITS.hard_uncompressed_bytes;
    const countOverflow = currentRefs.length + 1 > EXACT_SCAN_LIMITS.max_sections;
    const targetOverflow = currentRefs.length > 0 &&
      currentBytes + section.uncompressed_bytes > EXACT_SCAN_LIMITS.target_uncompressed_bytes;
    if (currentRefs.length > 0 && (hardOverflow || countOverflow || targetOverflow)) closeShard();
    currentRefs.push(section.section_ref);
    if (!currentRevisions.includes(section.source_revision_ref)) {
      currentRevisions.push(section.source_revision_ref);
    }
    currentBytes += section.uncompressed_bytes;
  }
  closeShard();
  return {
    plan_id: planId,
    scope_snapshot: scope,
    probes,
    shards,
    // The denominator names the frozen scope, not the reached bytes: a plan
    // over the same frozen scope always earns the same denominator.
    coverage_denominator_ref: `coverage-denominator:${scope.snapshot_id}:r${scope.revision}:${scope.digest.slice(0, 16)}`,
    output_manifest_ref: `exhaustive-manifest:${planId}`,
  };
}

export interface ExhaustiveSectionReader {
  readSection(section_ref: string): Promise<VerifyPinnedExactInput>;
}

export type ExhaustiveSectionStatus = "MATCHED" | "NO_MATCH" | "FAILED_CLOSED";

export interface ExhaustiveSectionOutcome {
  readonly section_ref: string;
  readonly status: ExhaustiveSectionStatus;
  readonly matches: number;
  readonly failure_code?: string;
}

export type ExhaustiveShardOutcome =
  | {
    readonly shard_id: string;
    readonly disposition: "SETTLED";
    readonly partial_result_ref: string;
    readonly scanned_sections: number;
    readonly matches: number;
    readonly section_outcomes: readonly ExhaustiveSectionOutcome[];
  }
  | {
    readonly shard_id: string;
    readonly disposition: "UNSETTLED";
    readonly reason_code: string;
    readonly scanned_sections: number;
    readonly matches: number;
    readonly section_outcomes: readonly ExhaustiveSectionOutcome[];
  };

export interface ExecuteExhaustiveShardInput {
  readonly shard: ExactScanShard;
  readonly scope: ScopeSnapshot;
  readonly probes: readonly string[];
  readonly reader: ExhaustiveSectionReader;
  readonly signal?: AbortSignal;
}

function unsettledReason(error: unknown, signal: AbortSignal | undefined): string {
  if (signal?.aborted === true) return "CANCELLED";
  if (error instanceof DOMException && error.name === "AbortError") return "CANCELLED";
  const code = (error as { readonly code?: unknown } | null)?.code;
  if (typeof code === "string" && code.length > 0 && code.length <= 128) return code;
  if (error instanceof Error && error.name.length > 0 && error.name.length <= 128) return error.name;
  return "READ_UNCERTAIN";
}

/**
 * Execute one shard against pinned bytes with Q2 exactness.
 *
 * Each section resolves through `verifyPinnedExactEvidence` with the plan
 * probes: `EXACT_PROBE_ABSENT` is an honest miss, any other typed
 * verification failure is a settled `FAILED_CLOSED` section, and only an
 * unknown outcome (transport timeout, lost readback, cancellation) leaves
 * the shard `UNSETTLED` — never a silent miss and never a denominator
 * reduction.
 */
export async function executeExhaustiveShard(input: ExecuteExhaustiveShardInput): Promise<ExhaustiveShardOutcome> {
  const shard = input.shard;
  if (
    shard === null || typeof shard !== "object" ||
    typeof shard.shard_id !== "string" || shard.shard_id.length === 0 ||
    !Array.isArray(shard.section_object_refs) || shard.section_object_refs.length === 0
  ) {
    failExecute("EXHAUSTIVE_SHARD_INVALID", "exhaustive execution requires a planned non-empty shard");
  }
  if (input.scope === null || typeof input.scope !== "object") {
    failExecute("EXHAUSTIVE_SHARD_INVALID", "exhaustive execution requires its frozen scope");
  }
  const probes = checkExecuteProbes(input.probes);
  const sectionOutcomes: ExhaustiveSectionOutcome[] = [];
  let matches = 0;
  for (const sectionRef of shard.section_object_refs) {
    if (input.signal?.aborted === true) {
      return {
        shard_id: shard.shard_id,
        disposition: "UNSETTLED",
        reason_code: "CANCELLED",
        scanned_sections: sectionOutcomes.length,
        matches,
        section_outcomes: sectionOutcomes,
      };
    }
    let sectionInput: VerifyPinnedExactInput;
    try {
      sectionInput = await input.reader.readSection(sectionRef);
    } catch (error: unknown) {
      return {
        shard_id: shard.shard_id,
        disposition: "UNSETTLED",
        reason_code: unsettledReason(error, input.signal),
        scanned_sections: sectionOutcomes.length,
        matches,
        section_outcomes: sectionOutcomes,
      };
    }
    try {
      const receipt = await verifyPinnedExactEvidence({ ...sectionInput, exact_probes: [...probes] });
      const sectionMatches = receipt.probe_matches.reduce(
        (sum, match) => sum + match.byte_offsets.length,
        0,
      );
      matches += sectionMatches;
      sectionOutcomes.push({ section_ref: sectionRef, status: "MATCHED", matches: sectionMatches });
    } catch (error: unknown) {
      if (error instanceof ExactVerificationError && error.code === "EXACT_PROBE_ABSENT") {
        sectionOutcomes.push({ section_ref: sectionRef, status: "NO_MATCH", matches: 0 });
        continue;
      }
      if (error instanceof ExactVerificationError) {
        sectionOutcomes.push({
          section_ref: sectionRef,
          status: "FAILED_CLOSED",
          matches: 0,
          failure_code: error.code,
        });
        continue;
      }
      return {
        shard_id: shard.shard_id,
        disposition: "UNSETTLED",
        reason_code: unsettledReason(error, input.signal),
        scanned_sections: sectionOutcomes.length,
        matches,
        section_outcomes: sectionOutcomes,
      };
    }
  }
  return {
    shard_id: shard.shard_id,
    disposition: "SETTLED",
    partial_result_ref: `exhaustive-partial:${shard.shard_id}`,
    scanned_sections: sectionOutcomes.length,
    matches,
    section_outcomes: sectionOutcomes,
  };
}

export type ExhaustiveCoverageClaim = "COMPLETE" | "SAMPLED" | "NONE";

export interface ExhaustiveMergeResult {
  readonly coverage_claim: ExhaustiveCoverageClaim;
  readonly coverage_denominator_ref: string;
  readonly denominator_shards: number;
  readonly settled_shards: number;
  readonly unsettled_shard_ids: readonly string[];
  readonly total_scanned_sections: number;
  readonly total_matches: number;
  readonly result_artifact_ref: string;
  readonly coverage_receipt_ref: string;
}

export interface MergeExhaustiveShardsInput {
  readonly plan: ExactScanPlan;
  readonly outcomes: readonly ExhaustiveShardOutcome[];
}

/**
 * Merge shard outcomes into one coverage claim.
 *
 * `COMPLETE` only when every denominator shard settled; anything else stays
 * `SAMPLED` (at least one settled shard) or `NONE` (nothing settled).
 * Missing outcomes are unknown outcomes with their denominator seat kept —
 * the denominator never shrinks and an unsettled shard is never a miss.
 */
export function mergeExhaustiveShards(input: MergeExhaustiveShardsInput): ExhaustiveMergeResult {
  const plan = input.plan;
  if (
    plan === null || typeof plan !== "object" ||
    typeof plan.plan_id !== "string" || plan.plan_id.length === 0 ||
    !Array.isArray(plan.shards) || plan.shards.length === 0 ||
    typeof plan.coverage_denominator_ref !== "string" || plan.coverage_denominator_ref.length === 0
  ) {
    failMerge("EXHAUSTIVE_PLAN_INVALID", "merge requires a planned denominator");
  }
  const denominatorIds = plan.shards.map((shard) => shard.shard_id);
  const denominator = new Set(denominatorIds);
  if (denominator.size !== denominatorIds.length) {
    failMerge("EXHAUSTIVE_PLAN_INVALID", "planned denominator carries duplicate shards");
  }
  const byShard = new Map<string, ExhaustiveShardOutcome>();
  for (const outcome of input.outcomes) {
    if (outcome === null || typeof outcome !== "object" || !denominator.has(outcome.shard_id)) {
      failMerge("EXHAUSTIVE_UNKNOWN_SHARD", "merge outcome is outside the planned denominator");
    }
    if (byShard.has(outcome.shard_id)) {
      failMerge("EXHAUSTIVE_DUPLICATE_SHARD", `duplicate merge outcome for ${outcome.shard_id}`);
    }
    byShard.set(outcome.shard_id, outcome);
  }
  const unsettledIds: string[] = [];
  let settled = 0;
  let scanned = 0;
  let matches = 0;
  for (const shardId of denominatorIds) {
    const outcome = byShard.get(shardId);
    if (outcome === undefined || outcome.disposition === "UNSETTLED") {
      unsettledIds.push(shardId);
      continue;
    }
    settled += 1;
    scanned += outcome.scanned_sections;
    matches += outcome.matches;
  }
  const coverageClaim: ExhaustiveCoverageClaim = settled === denominatorIds.length
    ? "COMPLETE"
    : settled > 0
      ? "SAMPLED"
      : "NONE";
  return {
    coverage_claim: coverageClaim,
    coverage_denominator_ref: plan.coverage_denominator_ref,
    denominator_shards: denominatorIds.length,
    settled_shards: settled,
    unsettled_shard_ids: unsettledIds,
    total_scanned_sections: scanned,
    total_matches: matches,
    result_artifact_ref: `exhaustive-result:${plan.plan_id}`,
    coverage_receipt_ref: `coverage-receipt:${plan.plan_id}`,
  };
}
