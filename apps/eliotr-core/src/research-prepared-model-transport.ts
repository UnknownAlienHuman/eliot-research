import {
  canonicalModelGatewayJson,
  validateModelGatewayTransportPolicy,
  type ModelGatewayTransportPolicyV1,
} from "@eliotr/cloudflare-ai";
import type { ResearchModelGatewayRuntimeConfig } from "@eliotr/cloudflare-research";

export const RESEARCH_PREPARED_MODEL_TRANSPORT_PROTOCOL =
  "eliotr.research-model-transport-policies.v1" as const;

export const RESEARCH_PREPARED_MODEL_TRANSPORT_STAGES = Object.freeze([
  "ANALYZE_BRANCHES",
  "COUNTER_SEARCH",
  "SYNTHESIZE",
  "AUDIT_CLAIMS",
] as const);

export type ResearchPreparedModelTransportStage =
  typeof RESEARCH_PREPARED_MODEL_TRANSPORT_STAGES[number];

export interface ResearchPreparedModelTransportSelectionV1 {
  readonly stage: ResearchPreparedModelTransportStage;
  readonly route_ref: string;
  readonly route_version: string;
  readonly provider: string;
  readonly model: string;
  readonly transport_policy: ModelGatewayTransportPolicyV1;
}

export interface ResearchPreparedModelTransportPoliciesV1 {
  readonly protocol: typeof RESEARCH_PREPARED_MODEL_TRANSPORT_PROTOCOL;
  readonly model_selections: readonly ResearchPreparedModelTransportSelectionV1[];
}

export interface ResearchPreparedModelTransportIdentity {
  readonly stage: ResearchPreparedModelTransportStage;
  readonly route_ref: string;
  readonly route_version: string;
  readonly provider: string;
  readonly model: string;
}

export type ResearchPreparedModelTransportErrorCode =
  | "RESEARCH_MODEL_TRANSPORT_CONFIGURATION_INVALID"
  | "RESEARCH_MODEL_TRANSPORT_CONFIGURATION_REQUIRED"
  | "RESEARCH_MODEL_TRANSPORT_SELECTION_MISMATCH";

export class ResearchPreparedModelTransportError extends Error {
  public constructor(
    public readonly code: ResearchPreparedModelTransportErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ResearchPreparedModelTransportError";
  }
}

const ROOT_KEYS = new Set(["model_selections", "protocol"]);
const SELECTION_KEYS = new Set([
  "model",
  "provider",
  "route_ref",
  "route_version",
  "stage",
  "transport_policy",
]);
const STAGES = new Set<string>(RESEARCH_PREPARED_MODEL_TRANSPORT_STAGES);
const MAX_BYTES = 64 * 1024;
const IDENTIFIER = /^[A-Za-z0-9._:@/+~-]{1,128}$/u;

function invalid(message: string, cause?: unknown): never {
  throw new ResearchPreparedModelTransportError(
    "RESEARCH_MODEL_TRANSPORT_CONFIGURATION_INVALID",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function required(message: string): never {
  throw new ResearchPreparedModelTransportError(
    "RESEARCH_MODEL_TRANSPORT_CONFIGURATION_REQUIRED",
    message,
  );
}

function mismatch(message: string): never {
  throw new ResearchPreparedModelTransportError(
    "RESEARCH_MODEL_TRANSPORT_SELECTION_MISMATCH",
    message,
  );
}

function exactObject(
  value: unknown,
  keys: ReadonlySet<string>,
  label: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalid(`${label} must be a plain object`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!keys.has(key)) invalid(`${label} contains unsupported field ${key}`);
  }
  return record;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    invalid(`${label} is invalid`);
  }
  return value;
}

function isStage(value: unknown): value is ResearchPreparedModelTransportStage {
  return typeof value === "string" && STAGES.has(value);
}

/**
 * Decode the canonical server-owned prepared transport envelope. An absent
 * variable preserves the installed legacy path; a present empty or malformed
 * value is a configuration error and must never downgrade to legacy behavior.
 */
export function parseResearchPreparedModelTransportPolicies(
  raw: string | undefined,
): ResearchPreparedModelTransportPoliciesV1 | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.length === 0 ||
      new TextEncoder().encode(raw).byteLength > MAX_BYTES) {
    invalid("prepared model transport policy JSON is empty or exceeds its byte bound");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw) as unknown;
  } catch (cause) {
    invalid("prepared model transport policy JSON is invalid", cause);
  }

  const root = exactObject(decoded, ROOT_KEYS, "prepared model transport policies");
  if (root.protocol !== RESEARCH_PREPARED_MODEL_TRANSPORT_PROTOCOL ||
      !Array.isArray(root.model_selections) || root.model_selections.length < 1 ||
      root.model_selections.length > RESEARCH_PREPARED_MODEL_TRANSPORT_STAGES.length) {
    invalid("prepared model transport policy protocol or selection count is invalid");
  }

  const seenStages = new Set<string>();
  const selections: ResearchPreparedModelTransportSelectionV1[] = [];
  let previousStageIndex = -1;
  for (const [index, value] of root.model_selections.entries()) {
    const row = exactObject(value, SELECTION_KEYS, `prepared model transport selection ${index}`);
    if (!isStage(row.stage) || seenStages.has(row.stage)) {
      invalid("prepared model transport stages are invalid or duplicated");
    }
    const stageIndex = RESEARCH_PREPARED_MODEL_TRANSPORT_STAGES.indexOf(row.stage);
    if (stageIndex <= previousStageIndex) {
      invalid("prepared model transport selections are not in canonical stage order");
    }
    previousStageIndex = stageIndex;
    seenStages.add(row.stage);
    const routeRef = identifier(row.route_ref, "prepared model route reference");
    const routeVersion = identifier(row.route_version, "prepared model route version");
    let policy: ModelGatewayTransportPolicyV1;
    try {
      policy = validateModelGatewayTransportPolicy(row.transport_policy);
    } catch (cause) {
      invalid("prepared model transport policy is invalid", cause);
    }
    if (row.provider !== policy.provider || row.model !== policy.model) {
      invalid("prepared model identity differs from its transport policy");
    }
    selections.push(Object.freeze({
      stage: row.stage,
      route_ref: routeRef,
      route_version: routeVersion,
      provider: policy.provider,
      model: policy.model,
      transport_policy: policy,
    }));
  }

  let canonical: string;
  try {
    canonical = canonicalModelGatewayJson({
      protocol: RESEARCH_PREPARED_MODEL_TRANSPORT_PROTOCOL,
      model_selections: selections,
    });
  } catch (cause) {
    invalid("prepared model transport policy cannot be canonicalized", cause);
  }
  if (canonical !== raw) invalid("prepared model transport policy JSON is not canonical");

  return Object.freeze({
    protocol: RESEARCH_PREPARED_MODEL_TRANSPORT_PROTOCOL,
    model_selections: Object.freeze(selections),
  });
}

/** Resolve only the exact server-approved stage, route revision, provider and model tuple. */
export function resolveResearchPreparedModelTransportPolicy(
  policies: ResearchPreparedModelTransportPoliciesV1 | undefined,
  identity: ResearchPreparedModelTransportIdentity,
): ResearchPreparedModelTransportSelectionV1 | undefined {
  if (policies === undefined) return undefined;
  const selection = policies.model_selections.find((candidate) => candidate.stage === identity.stage);
  if (selection === undefined) {
    required(`prepared model transport policy is missing for ${identity.stage}`);
  }
  if (selection.route_ref !== identity.route_ref ||
      selection.route_version !== identity.route_version ||
      selection.provider !== identity.provider || selection.model !== identity.model) {
    mismatch("prepared model transport policy does not match the exact qualification route and model");
  }
  return selection;
}

/** Bind an operator-prepared policy to the selected server gateway before effects. */
export function bindResearchPreparedModelTransportPolicy(
  gateway: ResearchModelGatewayRuntimeConfig,
  selection: ResearchPreparedModelTransportSelectionV1 | undefined,
): ResearchModelGatewayRuntimeConfig {
  if (selection === undefined) return gateway;
  if (selection.transport_policy.billing.mode === "byok") {
    const usesHttpGateway = Object.prototype.hasOwnProperty.call(gateway, "gateway_token") &&
      !Object.prototype.hasOwnProperty.call(gateway, "ai_gateway_binding") &&
      typeof gateway.gateway_token === "string" && gateway.gateway_token.trim() !== "";
    if (!usesHttpGateway) {
      required("prepared BYOK alias requires the configured HTTP AI Gateway credential route");
    }
  }
  const existing = gateway.transport_policy;
  if (existing !== undefined &&
      canonicalModelGatewayJson(existing) !==
        canonicalModelGatewayJson(selection.transport_policy)) {
    mismatch("gateway transport policy differs from the prepared model transport policy");
  }
  return Object.freeze({ ...gateway, transport_policy: selection.transport_policy });
}
