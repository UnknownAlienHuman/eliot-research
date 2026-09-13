import { IdentifierSchema, VersionedRefSchema, type VersionedRef } from "@eliotr/contracts";
import { canonicalJson } from "@eliotr/platform-cloudflare";
import {
  parseResearchClaimAuditPolicy,
  parseResearchOwnerOutputFormat,
  selectResearchOwnerPrompt,
  type ResearchClaimAuditPolicy,
  type ResearchOwnerJsonResponseFormat,
  type ResearchOwnerOutputFormat,
} from "@eliotr/cloudflare-research-stages";

const PROTOCOL = "eliotr.research-semantic-config.v1" as const;
const MAX_CONFIGURATION_BYTES = 65_536;
const MAX_VERIFIER_REFS = 512;
const MAX_REQUEST_TIMEOUT_MS = 300_000;

export type ResearchOwnerReasoningEffort = "low" | "medium" | "high";

export function parseResearchOwnerReasoningEffort(
  value: unknown,
): ResearchOwnerReasoningEffort | undefined {
  if (value === undefined) return undefined;
  if (value === "low" || value === "medium" || value === "high") return value;
  throw new Error("research owner reasoning_effort is invalid");
}

export type ResearchOwnerPromptLimits = Readonly<{
  max_tokens: number;
  request_timeout_ms: number;
  reasoning_effort?: ResearchOwnerReasoningEffort;
}>;

export type ResearchOwnerNormalizationInput = Readonly<{
  section_ref: VersionedRef;
  required_precision: string;
  required_source_class: string;
}>;

export type ResearchOwnerAuditConfigurationInput = ResearchOwnerPromptLimits & Readonly<{
  verifier_ref: string;
  verifier_schema_generation: string;
  allowed_verifier_refs: readonly string[];
  policy: ResearchClaimAuditPolicy;
}>;

export type ResearchOwnerSemanticConfigurationInput = Readonly<{
  readonly output_format?: ResearchOwnerOutputFormat;
  synthesis: ResearchOwnerPromptLimits;
  audit: ResearchOwnerAuditConfigurationInput;
  normalization: ResearchOwnerNormalizationInput;
}>;

export type ResearchSemanticPromptConfiguration = Readonly<{
  trusted_parameters: Readonly<{
    prompt: string;
    max_tokens: number;
    reasoning_effort?: ResearchOwnerReasoningEffort;
    response_format?: ResearchOwnerJsonResponseFormat;
  }>;
  request_timeout_ms: number;
}>;

export type ResearchSemanticServerConfiguration = Readonly<{
  protocol: typeof PROTOCOL;
  synthesis: ResearchSemanticPromptConfiguration;
  audit: ResearchSemanticPromptConfiguration & Readonly<{
    verifier_ref: string;
    verifier_schema_generation: string;
    allowed_verifier_refs: readonly string[];
    policy: ResearchClaimAuditPolicy;
  }>;
  normalization: Readonly<{
    section_ref: VersionedRef;
    required_precision: string;
    required_source_class: string;
  }>;
}>;

export type ResearchOwnerSemanticConfigurationErrorCode = "RESEARCH_OWNER_SEMANTIC_CONFIG_INVALID";

export class ResearchOwnerSemanticConfigurationError extends Error {
  public readonly code: ResearchOwnerSemanticConfigurationErrorCode = "RESEARCH_OWNER_SEMANTIC_CONFIG_INVALID";

  public constructor(message = "research owner semantic configuration is invalid") {
    super(message);
    this.name = "ResearchOwnerSemanticConfigurationError";
  }
}

function invalid(message: string): never {
  throw new ResearchOwnerSemanticConfigurationError(message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...expected, ...optional]);
  const keys = Object.keys(value);
  if (keys.length < expected.length || keys.some((key) => !allowed.has(key)) ||
      expected.some((key) => !keys.includes(key))) {
    invalid(`${label} contains unsupported fields`);
  }
}

function identifier(value: unknown, label: string): string {
  const parsed = IdentifierSchema.safeParse(value);
  if (!parsed.success) invalid(`${label} is invalid`);
  return parsed.data;
}

function versionedRef(value: unknown, label: string): VersionedRef {
  const parsed = VersionedRefSchema.safeParse(value);
  if (!parsed.success) invalid(`${label} is invalid`);
  return Object.freeze({ id: parsed.data.id, revision: parsed.data.revision });
}

function positiveSafeInteger(value: unknown, label: string, maximum?: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 ||
      (maximum !== undefined && value > maximum)) {
    invalid(`${label} is invalid`);
  }
  return value;
}

function promptLimits(value: unknown, label: string): ResearchOwnerPromptLimits {
  const input = record(value, label);
  exactKeys(input, ["max_tokens", "request_timeout_ms"], label, ["reasoning_effort"]);
  let reasoningEffort: ResearchOwnerReasoningEffort | undefined;
  try {
    reasoningEffort = parseResearchOwnerReasoningEffort(input.reasoning_effort);
  } catch {
    invalid("reasoning_effort is invalid for " + label);
  }
  return Object.freeze({
    max_tokens: positiveSafeInteger(input.max_tokens, `${label}.max_tokens`),
    request_timeout_ms: positiveSafeInteger(input.request_timeout_ms, `${label}.request_timeout_ms`, MAX_REQUEST_TIMEOUT_MS),
    ...(reasoningEffort === undefined ? {} : { reasoning_effort: reasoningEffort }),
  });
}

function verifierRefs(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_VERIFIER_REFS) {
    invalid("audit.allowed_verifier_refs is invalid");
  }
  const parsed = value.map((item, index) => identifier(item, `audit.allowed_verifier_refs[${index}]`));
  if (new Set(parsed).size !== parsed.length) invalid("audit.allowed_verifier_refs contains duplicates");
  return Object.freeze(parsed);
}

function auditInput(value: unknown): ResearchOwnerAuditConfigurationInput {
  const input = record(value, "audit");
  exactKeys(input, [
    "max_tokens", "request_timeout_ms", "verifier_ref", "verifier_schema_generation",
    "allowed_verifier_refs", "policy",
  ], "audit", ["reasoning_effort"]);
  const limits = promptLimits({
    max_tokens: input.max_tokens,
    request_timeout_ms: input.request_timeout_ms,
    ...(input.reasoning_effort === undefined ? {} : { reasoning_effort: input.reasoning_effort }),
  }, "audit");
  const verifierRef = identifier(input.verifier_ref, "audit.verifier_ref");
  const allowedVerifierRefs = verifierRefs(input.allowed_verifier_refs);
  if (!allowedVerifierRefs.includes(verifierRef)) {
    invalid("audit.verifier_ref is not in audit.allowed_verifier_refs");
  }
  let policy: ResearchClaimAuditPolicy;
  try {
    policy = parseResearchClaimAuditPolicy(input.policy);
  } catch {
    invalid("audit.policy is invalid");
  }
  return Object.freeze({
    ...limits,
    verifier_ref: verifierRef,
    verifier_schema_generation: identifier(input.verifier_schema_generation, "audit.verifier_schema_generation"),
    allowed_verifier_refs: allowedVerifierRefs,
    policy,
  });
}

function normalizationInput(value: unknown): ResearchOwnerNormalizationInput {
  const input = record(value, "normalization");
  exactKeys(input, ["section_ref", "required_precision", "required_source_class"], "normalization");
  return Object.freeze({
    section_ref: versionedRef(input.section_ref, "normalization.section_ref"),
    required_precision: identifier(input.required_precision, "normalization.required_precision"),
    required_source_class: identifier(input.required_source_class, "normalization.required_source_class"),
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/**
 * Build the server-owned semantic configuration from explicit operator
 * choices. Prompts and response schemas are fixed trusted package assets;
 * authority, model, pricing, and budget decisions remain caller inputs.
 */
export function createResearchOwnerSemanticConfiguration(
  input: ResearchOwnerSemanticConfigurationInput,
): ResearchSemanticServerConfiguration {
  const setup = record(input, "semantic configuration");
  exactKeys(setup, ["synthesis", "audit", "normalization"], "semantic configuration", ["output_format"]);
  let outputFormat: ResearchOwnerOutputFormat;
  try {
    outputFormat = parseResearchOwnerOutputFormat(setup.output_format);
  } catch {
    invalid("output_format is invalid");
  }
  const synthesisLimits = promptLimits(setup.synthesis, "synthesis");
  const audit = auditInput(setup.audit);
  const normalization = normalizationInput(setup.normalization);
  const synthesisPrompt = selectResearchOwnerPrompt("SYNTHESIZE", outputFormat);
  const auditPrompt = selectResearchOwnerPrompt("AUDIT_CLAIMS", outputFormat);
  const configuration = {
    protocol: PROTOCOL,
    synthesis: {
      trusted_parameters: {
        prompt: synthesisPrompt.prompt,
        max_tokens: synthesisLimits.max_tokens,
        ...(synthesisLimits.reasoning_effort === undefined ? {} : {
          reasoning_effort: synthesisLimits.reasoning_effort,
        }),
        ...(synthesisPrompt.response_format === undefined ? {} : { response_format: synthesisPrompt.response_format }),
      },
      request_timeout_ms: synthesisLimits.request_timeout_ms,
    },
    audit: {
      trusted_parameters: {
        prompt: auditPrompt.prompt,
        max_tokens: audit.max_tokens,
        ...(audit.reasoning_effort === undefined ? {} : {
          reasoning_effort: audit.reasoning_effort,
        }),
        ...(auditPrompt.response_format === undefined ? {} : { response_format: auditPrompt.response_format }),
      },
      request_timeout_ms: audit.request_timeout_ms,
      verifier_ref: audit.verifier_ref,
      verifier_schema_generation: audit.verifier_schema_generation,
      allowed_verifier_refs: audit.allowed_verifier_refs,
      policy: audit.policy,
    },
    normalization,
  } satisfies ResearchSemanticServerConfiguration;
  const frozen = deepFreeze(configuration);
  try {
    if (new TextEncoder().encode(canonicalJson(frozen)).byteLength > MAX_CONFIGURATION_BYTES) {
      invalid("semantic configuration exceeds its byte bound");
    }
  } catch (error) {
    if (error instanceof ResearchOwnerSemanticConfigurationError) throw error;
    invalid("semantic configuration cannot be canonicalized");
  }
  return frozen;
}
