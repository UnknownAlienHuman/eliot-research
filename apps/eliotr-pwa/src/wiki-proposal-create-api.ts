import { IdentifierSchema, VersionedRefSchema, type VersionedRef } from "@eliotr/contracts";
import { ApiRequestError, requestApi } from "./api.js";

const PATH = "/api/v1/research/wiki/proposals/from-run";
const PROTOCOL = "eliotr.wiki-proposal.v1" as const;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u;
const SAFE_TRACE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const RISK_CLASSES = ["D0_MECHANICAL", "D1_LOW_RISK_ADDITIVE", "D2_ANALYTICAL", "D3_AUTHORITY_SENSITIVE"] as const;

export type WikiProposalRiskClass = typeof RISK_CLASSES[number];

export interface WikiProposalFromRunView {
  readonly protocol: typeof PROTOCOL;
  readonly proposal_ref: VersionedRef;
  readonly page_ref: VersionedRef;
  readonly risk_class: WikiProposalRiskClass;
  readonly state: "PROPOSED";
  readonly deployment_generation: string;
}

type JsonRecord = Record<string, unknown>;

function invalid(message: string): never {
  throw new ApiRequestError({ status: 502, code: "WIKI_RESPONSE_INVALID", message });
}

function record(value: unknown, keys: readonly string[], label: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(`${label} is invalid`);
  const candidate = value as JsonRecord;
  if (Object.keys(candidate).length !== keys.length || keys.some((key) => !Object.hasOwn(candidate, key))) invalid(`${label} has missing or unknown fields`);
  return candidate;
}

function identifier(value: unknown, label: string): string {
  if (!IdentifierSchema.safeParse(value).success || typeof value !== "string" || !SAFE_IDENTIFIER.test(value)) invalid(`${label} is invalid`);
  return value;
}

function ref(value: unknown, label: string): VersionedRef {
  const parsed = VersionedRefSchema.safeParse(value);
  if (!parsed.success) invalid(`${label} is invalid`);
  return parsed.data;
}

function decode(raw: unknown, expectedGeneration: string): WikiProposalFromRunView {
  const envelope = record(raw, ["data", "trace_id", "deployment_generation"], "Wiki proposal response");
  const trace = identifier(envelope.trace_id, "trace_id");
  if (!SAFE_TRACE_ID.test(trace)) invalid("trace_id is invalid");
  const generation = identifier(envelope.deployment_generation, "deployment_generation");
  if (generation !== expectedGeneration) {
    throw new ApiRequestError({ status: 409, code: "WIKI_DEPLOYMENT_CHANGED", message: "The application changed; refresh the research workspace.", retryable: true });
  }
  const data = record(envelope.data, ["protocol", "proposal_ref", "page_ref", "risk_class", "state"], "Wiki proposal data");
  if (data.protocol !== PROTOCOL || typeof data.risk_class !== "string" || !RISK_CLASSES.includes(data.risk_class as WikiProposalRiskClass) || data.state !== "PROPOSED") invalid("Wiki proposal response is invalid");
  return {
    protocol: PROTOCOL,
    proposal_ref: ref(data.proposal_ref, "proposal_ref"),
    page_ref: ref(data.page_ref, "page_ref"),
    risk_class: data.risk_class as WikiProposalRiskClass,
    state: "PROPOSED",
    deployment_generation: generation,
  };
}

function requestId(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || value !== value.trim() || /[\u0000-\u0020\u007f]/u.test(value)) {
    throw new ApiRequestError({ status: 400, code: "WIKI_INPUT_INVALID", message: `${label} is invalid` });
  }
  return value;
}

export async function createWikiProposalFromRun(
  operationId: string,
  idempotencyKey: string,
  expectedDeploymentGeneration: string,
  signal?: AbortSignal,
): Promise<WikiProposalFromRunView> {
  const operation = identifier(operationId, "operation_id");
  const idem = requestId(idempotencyKey, "idempotency-key");
  const generation = identifier(expectedDeploymentGeneration, "deployment generation");
  const raw = await requestApi(PATH, {
    method: "POST",
    body: JSON.stringify({ operation_id: operation }),
    headers: { "content-type": "application/json", "idempotency-key": idem },
    ...(signal === undefined ? {} : { signal }),
  });
  return decode(raw, generation);
}
