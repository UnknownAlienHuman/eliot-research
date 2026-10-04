import {
  canonicalModelGatewayJson,
  type DynamicRouteActiveGeneration,
  type DynamicRouteControlPlanePort,
  type DynamicRouteQualificationProbeInput,
  type ModelGatewayPromptCompilerPort,
} from "@eliotr/cloudflare-ai";
import { ResolvedEvidenceSchema, VersionedRefSchema, type VersionedRef } from "@eliotr/contracts";
import type { ModelRouteDeployment } from "@eliotr/platform-cloudflare";
import type { DynamicRouteQualificationLatestExpectation } from "./model-gateway-qualification-d1.js";
import type { ResearchQualificationPromptConfig } from "./research-qualification-prompt.js";
import type { ResearchEvidencePack } from "./research-reference-manifest.js";
const IDENTIFIER = /^[A-Za-z0-9._:@/-]{1,256}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_MODEL_BYTES = 256 * 1024;
const INPUT_KEYS = new Set(["candidate_ref", "candidate_sha256", "evidence_pack", "renewal_ref"]);
const PACK_KEYS = new Set(["pack_ref", "scope_snapshot_ref", "resolved_evidence", "omitted_candidates", "trace_ref", "total_utf8_bytes"]);
const OMITTED_KEYS = new Set(["candidate_id", "reason_code"]);
const ACTIVE_KEYS = new Set(["candidate_ref", "candidate_sha256", "route_ref", "route_version"]);
export type ResearchOwnerQualificationRenewalErrorCode =
  | "RESEARCH_OWNER_QUALIFICATION_RENEWAL_INPUT_INVALID"
  | "RESEARCH_OWNER_QUALIFICATION_RENEWAL_CONFIGURATION_MISSING"
  | "RESEARCH_OWNER_QUALIFICATION_RENEWAL_CONFIGURATION_INVALID"
  | "RESEARCH_OWNER_QUALIFICATION_RENEWAL_CANDIDATE_UNAVAILABLE"
  | "RESEARCH_OWNER_QUALIFICATION_RENEWAL_AUTHORITY_STALE"
  | "RESEARCH_OWNER_QUALIFICATION_RENEWAL_ROUTE_UNAVAILABLE"
  | "RESEARCH_OWNER_QUALIFICATION_RENEWAL_OBSERVATION_UNAVAILABLE"
  | "RESEARCH_OWNER_QUALIFICATION_RENEWAL_PRICING_UNAVAILABLE";
export class ResearchOwnerQualificationRenewalError extends Error {
  public readonly code: ResearchOwnerQualificationRenewalErrorCode;
  public readonly retryable: boolean;
  public constructor(
    code: ResearchOwnerQualificationRenewalErrorCode,
    message: string,
    retryable = false,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ResearchOwnerQualificationRenewalError";
    this.code = code;
    this.retryable = retryable;
  }
}
export interface ResearchOwnerQualificationRenewalAssemblerDependencies {
  readonly database: D1Database;
  readonly search_database: D1Database;
  readonly evidence_bucket: R2Bucket;
  readonly work_bucket: R2Bucket;
  readonly control_plane: Pick<DynamicRouteControlPlanePort, "get">;
  readonly prompt: ResearchQualificationPromptConfig;
  readonly max_input_bytes: number;
  readonly max_output_bytes: number;
  readonly now: () => string;
}
export interface ResearchOwnerQualificationRenewalInput {
  readonly candidate_ref: string;
  readonly candidate_sha256: string;
  readonly renewal_ref: string;
  readonly evidence_pack: ResearchEvidencePack;
}
export interface ResearchOwnerQualificationRenewalAssembly {
  readonly candidate_ref: string;
  readonly candidate_sha256: string;
  readonly fresh: DynamicRouteQualificationProbeInput;
  readonly expected_latest: DynamicRouteQualificationLatestExpectation | null;
  readonly prompt_compiler: ModelGatewayPromptCompilerPort;
}
export interface ResearchOwnerQualificationRenewalAssembler {
  assemble(input: ResearchOwnerQualificationRenewalInput): Promise<ResearchOwnerQualificationRenewalAssembly>;
}
export function fail(
  code: ResearchOwnerQualificationRenewalErrorCode,
  message: string,
  retryable = false,
  cause?: unknown,
): never {
  throw new ResearchOwnerQualificationRenewalError(code, message, retryable, cause);
}

export function exactRecord(value: unknown, keys: ReadonlySet<string>, label: string, code: ResearchOwnerQualificationRenewalErrorCode): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(code, `${label} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code, `${label} must be a plain object`);
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!keys.has(key)) fail(code, `${label} contains an unsupported field`);
  return record;
}

export function identifier(value: unknown, label: string, code: ResearchOwnerQualificationRenewalErrorCode): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) fail(code, `${label} is invalid`);
  return value;
}

export function digest(value: unknown, label: string, code: ResearchOwnerQualificationRenewalErrorCode): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail(code, `${label} is invalid`);
  return value;
}
export function activeGeneration(value: unknown): DynamicRouteActiveGeneration {
  const record = exactRecord(value, ACTIVE_KEYS, "active route generation", "RESEARCH_OWNER_QUALIFICATION_RENEWAL_AUTHORITY_STALE");
  return Object.freeze({
    route_ref: identifier(record.route_ref, "active route", "RESEARCH_OWNER_QUALIFICATION_RENEWAL_AUTHORITY_STALE"),
    route_version: identifier(record.route_version, "active route version", "RESEARCH_OWNER_QUALIFICATION_RENEWAL_AUTHORITY_STALE"),
    candidate_ref: identifier(record.candidate_ref, "active candidate", "RESEARCH_OWNER_QUALIFICATION_RENEWAL_AUTHORITY_STALE"),
    candidate_sha256: digest(record.candidate_sha256, "active candidate digest", "RESEARCH_OWNER_QUALIFICATION_RENEWAL_AUTHORITY_STALE"),
  });
}

export function timestamp(value: unknown, label: string, code: ResearchOwnerQualificationRenewalErrorCode): string {
  if (typeof value !== "string") fail(code, `${label} is invalid`);
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) fail(code, `${label} is invalid`);
  return value;
}
export function nonnegativeBytes(value: unknown, label: string, code: ResearchOwnerQualificationRenewalErrorCode): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MAX_MODEL_BYTES) {
    fail(code, `${label} is outside the model byte bound`);
  }
  return value;
}

function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.revision === right.revision;
}

export function sameDeployment(left: ModelRouteDeployment, right: ModelRouteDeployment): boolean {
  return canonicalModelGatewayJson(left) === canonicalModelGatewayJson(right);
}

export function detached<T>(value: T, label: string, code: ResearchOwnerQualificationRenewalErrorCode): T {
  let json: string;
  try { json = canonicalModelGatewayJson(value); }
  catch (cause) { fail(code, `${label} is not canonical JSON`, false, cause); }
  if (new TextEncoder().encode(json).byteLength > MAX_CONFIG_BYTES && label.includes("configuration")) {
    fail(code, `${label} exceeds its byte bound`);
  }
  try { return JSON.parse(json) as T; }
  catch (cause) { fail(code, `${label} is not canonical JSON`, false, cause); }
}

function parseRef(value: unknown, label: string): VersionedRef {
  const parsed = VersionedRefSchema.safeParse(value);
  if (!parsed.success) fail("RESEARCH_OWNER_QUALIFICATION_RENEWAL_INPUT_INVALID", `${label} is invalid`);
  return Object.freeze({ ...parsed.data });
}

export function clock(now: () => string): { readonly text: string; readonly milliseconds: number } {
  let text: string;
  try { text = now(); }
  catch (cause) { fail("RESEARCH_OWNER_QUALIFICATION_RENEWAL_CONFIGURATION_MISSING", "renewal clock is unavailable", true, cause); }
  const milliseconds = Date.parse(text);
  if (!Number.isSafeInteger(milliseconds) || new Date(milliseconds).toISOString() !== text) {
    fail("RESEARCH_OWNER_QUALIFICATION_RENEWAL_CONFIGURATION_INVALID", "renewal clock is not canonical UTC");
  }
  return Object.freeze({ text, milliseconds });
}

export function parseInput(raw: unknown): ResearchOwnerQualificationRenewalInput {
  const value = exactRecord(raw, INPUT_KEYS, "qualification renewal input", "RESEARCH_OWNER_QUALIFICATION_RENEWAL_INPUT_INVALID");
  const candidateRef = identifier(value.candidate_ref, "candidate reference", "RESEARCH_OWNER_QUALIFICATION_RENEWAL_INPUT_INVALID");
  const candidateSha = digest(value.candidate_sha256, "candidate digest", "RESEARCH_OWNER_QUALIFICATION_RENEWAL_INPUT_INVALID");
  const renewalRef = identifier(value.renewal_ref, "renewal reference", "RESEARCH_OWNER_QUALIFICATION_RENEWAL_INPUT_INVALID");
  return Object.freeze({
    candidate_ref: candidateRef,
    candidate_sha256: candidateSha,
    renewal_ref: renewalRef,
    evidence_pack: value.evidence_pack as ResearchEvidencePack,
  });
}

export function parseEvidencePack(raw: unknown, access: ResearchQualificationPromptConfig["access"], maximumBytes: number): ResearchEvidencePack {
  const value = exactRecord(raw, PACK_KEYS, "renewal evidence pack", "RESEARCH_OWNER_QUALIFICATION_RENEWAL_INPUT_INVALID");
  const packRef = parseRef(value.pack_ref, "evidence pack reference");
  const scopeRef = parseRef(value.scope_snapshot_ref, "evidence pack scope");
  const traceRef = parseRef(value.trace_ref, "evidence pack trace");
  if (!Array.isArray(value.resolved_evidence) || value.resolved_evidence.length === 0 || value.resolved_evidence.length > 512) {
    fail("RESEARCH_OWNER_QUALIFICATION_RENEWAL_INPUT_INVALID", "evidence pack has no bounded resolved evidence");
  }
  if (!Array.isArray(value.omitted_candidates) || value.omitted_candidates.length > 512) {
    fail("RESEARCH_OWNER_QUALIFICATION_RENEWAL_INPUT_INVALID", "evidence pack omitted candidates are invalid");
  }
  if (typeof value.total_utf8_bytes !== "number" || !Number.isSafeInteger(value.total_utf8_bytes) || value.total_utf8_bytes < 0 || value.total_utf8_bytes > maximumBytes) {
    fail("RESEARCH_OWNER_QUALIFICATION_RENEWAL_INPUT_INVALID", "evidence pack exceeds the configured input bound");
  }
  const seen = new Set<string>();
  let excerptBytes = 0;
  const resolved = value.resolved_evidence.map((rawEvidence) => {
    const parsed = ResolvedEvidenceSchema.safeParse(rawEvidence);
    if (!parsed.success || parsed.data.handle.terminal_state !== "LIVE" ||
        !sameRef(parsed.data.handle.scope_snapshot_ref, scopeRef) ||
        parsed.data.credential_generation !== access.credential_generation) {
      fail("RESEARCH_OWNER_QUALIFICATION_RENEWAL_INPUT_INVALID", "evidence pack is not bound to current live owner evidence");
    }
    const key = `${parsed.data.handle.handle_ref.id}:${parsed.data.handle.handle_ref.revision}`;
    if (seen.has(key)) fail("RESEARCH_OWNER_QUALIFICATION_RENEWAL_INPUT_INVALID", "evidence pack repeats a handle");
    seen.add(key);
    excerptBytes += new TextEncoder().encode(parsed.data.exact_excerpt).byteLength;
    return parsed.data;
  });
  if (excerptBytes > value.total_utf8_bytes) fail("RESEARCH_OWNER_QUALIFICATION_RENEWAL_INPUT_INVALID", "evidence pack byte accounting is invalid");
  const omitted = value.omitted_candidates.map((rawCandidate) => {
    const candidate = exactRecord(rawCandidate, OMITTED_KEYS, "omitted evidence candidate", "RESEARCH_OWNER_QUALIFICATION_RENEWAL_INPUT_INVALID");
    return Object.freeze({
      candidate_id: identifier(candidate.candidate_id, "omitted candidate", "RESEARCH_OWNER_QUALIFICATION_RENEWAL_INPUT_INVALID"),
      reason_code: identifier(candidate.reason_code, "omitted candidate reason", "RESEARCH_OWNER_QUALIFICATION_RENEWAL_INPUT_INVALID"),
    });
  });
  return detached({
    pack_ref: packRef,
    scope_snapshot_ref: scopeRef,
    resolved_evidence: resolved,
    omitted_candidates: omitted,
    trace_ref: traceRef,
    total_utf8_bytes: value.total_utf8_bytes,
  } as ResearchEvidencePack, "renewal evidence pack", "RESEARCH_OWNER_QUALIFICATION_RENEWAL_INPUT_INVALID");
}
