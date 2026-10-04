import {
  canonicalModelGatewayJson,
  modelGatewaySha256,
  validateModelGatewayTransportPolicy,
  type ModelGatewayTransportPolicyV1,
} from "@eliotr/cloudflare-ai";

export const RESEARCH_PROJECT_MODEL_CONFIGURATION_PROTOCOL =
  "eliotr.research-project-model-configuration.v1" as const;
export const RESEARCH_PROJECT_MODEL_CONFIGURATION_MAX_BYTES = 262_144;
export const RESEARCH_PROJECT_MODEL_CONFIGURATION_MAX_REVISIONS = 256;
export const RESEARCH_PROJECT_MODEL_CONFIGURATION_MAX_PAGE = 50;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
export const CONFIG_REF = /^rpmc-[a-f0-9]{64}$/u;
const SEMANTIC_REF = /^scr-[a-f0-9]{12}$/u;
const REVISION_PREFIX = "rpmc-";
const RUNTIME_VAR_KEYS = [
  "ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON",
  "ELIOTR_MODEL_PROFILE_DEFINITION_JSON",
  "ELIOTR_MODEL_PROFILE_PROVENANCE_REF",
  "ELIOTR_MODEL_SPEND_POLICY_JSON",
  "ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF",
  "ELIOTR_RESEARCH_REPORT_CONFIG_JSON",
  "ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF",
] as const;
const BUNDLE_KEYS = new Set(["protocol", "semantic_revision", "model_selections", "vars"]);
const SEMANTIC_REVISION_KEYS = new Set(["revision_ref", "config_sha256"]);
const MODEL_SELECTION_KEYS = new Set([
  "stage", "route_ref", "route_version", "candidate_ref", "candidate_sha256",
  "qualification_ref", "qualification_sha256", "transport_policy",
]);
const VAR_KEYS = new Set<string>(RUNTIME_VAR_KEYS);

export type ResearchProjectModelConfigurationErrorCode =
  | "RESEARCH_PROJECT_MODEL_CONFIGURATION_INPUT_INVALID"
  | "RESEARCH_PROJECT_MODEL_CONFIGURATION_NOT_FOUND"
  | "RESEARCH_PROJECT_MODEL_CONFIGURATION_CONFLICT"
  | "RESEARCH_PROJECT_MODEL_CONFIGURATION_STORAGE_UNAVAILABLE"
  | "RESEARCH_MODEL_CONFIGURATION_QUALIFICATION_REQUIRED";

export class ResearchProjectModelConfigurationError extends Error {
  public constructor(
    public readonly code: ResearchProjectModelConfigurationErrorCode,
    message: string,
    public readonly status: number,
    public readonly retryable = false,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ResearchProjectModelConfigurationError";
  }
}
export interface ResearchProjectModelRuntimeVars {
  readonly ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON: string;
  readonly ELIOTR_MODEL_PROFILE_DEFINITION_JSON: string;
  readonly ELIOTR_MODEL_PROFILE_PROVENANCE_REF: string;
  readonly ELIOTR_MODEL_SPEND_POLICY_JSON: string;
  readonly ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF: string;
  readonly ELIOTR_RESEARCH_REPORT_CONFIG_JSON: string;
  readonly ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF: string;
}

export interface ResearchProjectModelSelection {
  readonly stage: string;
  readonly route_ref: string;
  readonly route_version: string;
  readonly candidate_ref: string;
  readonly candidate_sha256: string;
  readonly qualification_ref: string;
  readonly qualification_sha256: string;
  readonly transport_policy: ModelGatewayTransportPolicyV1;
}

export interface ResearchProjectModelConfigurationBundle {
  readonly protocol: typeof RESEARCH_PROJECT_MODEL_CONFIGURATION_PROTOCOL;
  readonly semantic_revision: {
    readonly revision_ref: string;
    readonly config_sha256: string;
  };
  readonly model_selections: readonly ResearchProjectModelSelection[];
  readonly vars: ResearchProjectModelRuntimeVars;
}

export interface ResearchProjectModelConfigurationRevision {
  readonly owner_id: string;
  readonly project_id: string;
  readonly configuration_ref: string;
  readonly configuration_sha256: string;
  readonly configuration_json: string;
  readonly byte_length: number;
  readonly protocol: typeof RESEARCH_PROJECT_MODEL_CONFIGURATION_PROTOCOL;
  readonly created_at: string;
  readonly created_by_principal_ref: string;
  readonly configuration: ResearchProjectModelConfigurationBundle;
}

export interface ResearchProjectModelConfigurationSelection {
  readonly owner_id: string;
  readonly project_id: string;
  readonly selection_revision: number;
  readonly configuration_ref: string;
  readonly configuration_sha256: string;
  readonly selected_at: string;
  readonly selected_by_principal_ref: string;
  readonly revision: ResearchProjectModelConfigurationRevision;
}

export interface ResearchProjectModelConfigurationPage {
  readonly revisions: readonly ResearchProjectModelConfigurationRevision[];
  readonly next_cursor: string | null;
}

export interface ResearchProjectModelConfigurationStore {
  readSelected(ownerId: string, projectId: string): Promise<ResearchProjectModelConfigurationSelection | null>;
  readRevision(ownerId: string, projectId: string, configurationRef: string): Promise<ResearchProjectModelConfigurationRevision | null>;
  listRevisions(ownerId: string, projectId: string, limit?: number, after?: string): Promise<ResearchProjectModelConfigurationPage>;
  saveAndSelect(input: {
    readonly owner_id: string;
    readonly project_id: string;
    /** Private commit fence, never included in the canonical configuration bundle. */
    readonly expected_project_generation: number;
    readonly expected_revision: number | null;
    readonly configuration: unknown;
  }): Promise<ResearchProjectModelConfigurationSelection>;
  selectExisting(input: {
    readonly owner_id: string;
    readonly project_id: string;
    /** Private commit fence, never included in the canonical configuration bundle. */
    readonly expected_project_generation: number;
    readonly expected_revision: number | null;
    readonly configuration_ref: string;
  }): Promise<ResearchProjectModelConfigurationSelection>;
}

export interface RevisionRow {
  readonly owner_id: unknown;
  readonly project_id: unknown;
  readonly configuration_ref: unknown;
  readonly configuration_sha256: unknown;
  readonly configuration_json: unknown;
  readonly byte_length: unknown;
  readonly protocol: unknown;
  readonly created_at: unknown;
  readonly created_by_principal_ref: unknown;
}

export interface SelectionRow {
  readonly selection_revision: unknown;
  readonly configuration_ref: unknown;
  readonly configuration_sha256: unknown;
  readonly selected_at: unknown;
  readonly selected_by_principal_ref: unknown;
}

export function failure(
  code: ResearchProjectModelConfigurationErrorCode,
  message: string,
  status = 400,
  retryable = false,
  cause?: unknown,
): never {
  throw new ResearchProjectModelConfigurationError(code, message, status, retryable, cause);
}

export function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    failure("RESEARCH_PROJECT_MODEL_CONFIGURATION_INPUT_INVALID", `${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    failure("RESEARCH_PROJECT_MODEL_CONFIGURATION_INPUT_INVALID", `${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

export function exactKeys(value: Record<string, unknown>, keys: ReadonlySet<string>, label: string): void {
  if (Object.keys(value).length !== keys.size || Object.keys(value).some((key) => !keys.has(key))) {
    failure("RESEARCH_PROJECT_MODEL_CONFIGURATION_INPUT_INVALID", `${label} contains missing or unsupported fields`);
  }
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    failure("RESEARCH_PROJECT_MODEL_CONFIGURATION_INPUT_INVALID", `${label} is invalid`);
  }
  return value;
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    failure("RESEARCH_PROJECT_MODEL_CONFIGURATION_INPUT_INVALID", `${label} is not a lowercase SHA-256`);
  }
  return value;
}

function canonicalJsonText(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string" || value.length === 0 || utf8Length(value) > maxBytes) {
    failure("RESEARCH_PROJECT_MODEL_CONFIGURATION_INPUT_INVALID", `${label} is missing or exceeds its byte limit`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    failure("RESEARCH_PROJECT_MODEL_CONFIGURATION_INPUT_INVALID", `${label} is not valid JSON`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    failure("RESEARCH_PROJECT_MODEL_CONFIGURATION_INPUT_INVALID", `${label} must contain a JSON object`);
  }
  let canonical: string;
  try {
    canonical = canonicalModelGatewayJson(parsed);
  } catch (cause) {
    failure("RESEARCH_PROJECT_MODEL_CONFIGURATION_INPUT_INVALID", `${label} is not canonical JSON`, 400, false, cause);
  }
  if (canonical !== value) {
    failure("RESEARCH_PROJECT_MODEL_CONFIGURATION_INPUT_INVALID", `${label} must use canonical JSON bytes`);
  }
  return value;
}

function runtimeVars(value: unknown): ResearchProjectModelRuntimeVars {
  const record = plainObject(value, "configuration.vars");
  exactKeys(record, VAR_KEYS, "configuration.vars");
  const result = {} as Record<(typeof RUNTIME_VAR_KEYS)[number], string>;
  for (const key of RUNTIME_VAR_KEYS) {
    const raw = record[key];
    if (typeof raw !== "string" || raw.length === 0 || utf8Length(raw) > 65_536 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(raw)) {
      failure("RESEARCH_PROJECT_MODEL_CONFIGURATION_INPUT_INVALID", `configuration.vars.${key} is invalid or oversized`);
    }
    if (key.endsWith("_PROVENANCE_REF")) identifier(raw, `configuration.vars.${key}`);
    else canonicalJsonText(raw, `configuration.vars.${key}`, 65_536);
    result[key] = raw;
  }
  return Object.freeze(result);
}

function routeSelection(value: unknown): ResearchProjectModelSelection {
  const record = plainObject(value, "configuration.model_selections[]");
  exactKeys(record, MODEL_SELECTION_KEYS, "configuration.model_selections[]");
  let transportPolicy: ModelGatewayTransportPolicyV1;
  try {
    transportPolicy = validateModelGatewayTransportPolicy(record.transport_policy);
  } catch (cause) {
    failure("RESEARCH_PROJECT_MODEL_CONFIGURATION_INPUT_INVALID", "model selection transport policy is invalid", 400, false, cause);
  }
  return Object.freeze({
    stage: identifier(record.stage, "model selection stage"),
    route_ref: identifier(record.route_ref, "model selection route_ref"),
    route_version: identifier(record.route_version, "model selection route_version"),
    candidate_ref: identifier(record.candidate_ref, "model selection candidate_ref"),
    candidate_sha256: sha256(record.candidate_sha256, "model selection candidate_sha256"),
    qualification_ref: identifier(record.qualification_ref, "model selection qualification_ref"),
    qualification_sha256: sha256(record.qualification_sha256, "model selection qualification_sha256"),
    transport_policy: transportPolicy,
  });
}

export async function decodeResearchProjectModelConfigurationBundle(
  value: unknown,
): Promise<Readonly<{ bundle: ResearchProjectModelConfigurationBundle; json: string; configuration_ref: string; configuration_sha256: string; byte_length: number }>> {
  const record = plainObject(value, "configuration");
  exactKeys(record, BUNDLE_KEYS, "configuration");
  if (record.protocol !== RESEARCH_PROJECT_MODEL_CONFIGURATION_PROTOCOL) {
    failure("RESEARCH_PROJECT_MODEL_CONFIGURATION_INPUT_INVALID", "configuration protocol is unsupported");
  }
  const semantic = plainObject(record.semantic_revision, "configuration.semantic_revision");
  exactKeys(semantic, SEMANTIC_REVISION_KEYS, "configuration.semantic_revision");
  const semanticRef = semantic.revision_ref;
  const semanticSha = sha256(semantic.config_sha256, "configuration.semantic_revision.config_sha256");
  if (typeof semanticRef !== "string" || !SEMANTIC_REF.test(semanticRef) || semanticRef !== `scr-${semanticSha.slice(0, 12)}`) {
    failure("RESEARCH_PROJECT_MODEL_CONFIGURATION_INPUT_INVALID", "semantic revision reference does not match its exact digest");
  }
  const vars = runtimeVars(record.vars);
  const semanticBytesSha = await modelGatewaySha256(vars.ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON);
  if (semanticBytesSha !== semanticSha) {
    failure("RESEARCH_PROJECT_MODEL_CONFIGURATION_INPUT_INVALID", "semantic config bytes do not match their revision digest");
  }
  const selectionsRaw = record.model_selections;
  if (!Array.isArray(selectionsRaw) || selectionsRaw.length < 1 || selectionsRaw.length > 16) {
    failure("RESEARCH_PROJECT_MODEL_CONFIGURATION_INPUT_INVALID", "model_selections must contain 1 to 16 stage selections");
  }
  const selections = selectionsRaw.map(routeSelection).sort((left, right) => left.stage.localeCompare(right.stage));
  if (new Set(selections.map((item) => item.stage)).size !== selections.length) {
    failure("RESEARCH_PROJECT_MODEL_CONFIGURATION_INPUT_INVALID", "model_selections contains duplicate stages");
  }
  const bundle: ResearchProjectModelConfigurationBundle = Object.freeze({
    protocol: RESEARCH_PROJECT_MODEL_CONFIGURATION_PROTOCOL,
    semantic_revision: Object.freeze({ revision_ref: semanticRef, config_sha256: semanticSha }),
    model_selections: Object.freeze(selections),
    vars,
  });
  const json = canonicalModelGatewayJson(bundle);
  const byteLength = utf8Length(json);
  if (byteLength > RESEARCH_PROJECT_MODEL_CONFIGURATION_MAX_BYTES) {
    failure("RESEARCH_PROJECT_MODEL_CONFIGURATION_INPUT_INVALID", "configuration bundle exceeds its byte limit");
  }
  const configurationSha256 = await modelGatewaySha256(json);
  return Object.freeze({
    bundle,
    json,
    configuration_ref: `${REVISION_PREFIX}${configurationSha256}`,
    configuration_sha256: configurationSha256,
    byte_length: byteLength,
  });
}

export function projectIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    failure("RESEARCH_PROJECT_MODEL_CONFIGURATION_INPUT_INVALID", `${label} is invalid`);
  }
  return value;
}

export function revisionNumber(value: unknown): number | null {
  if (value !== null && (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) >= 1_000_000)) {
    failure("RESEARCH_PROJECT_MODEL_CONFIGURATION_INPUT_INVALID", "expected_revision is invalid");
  }
  return value as number | null;
}

export function projectGeneration(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 2_147_483_647) {
    failure("RESEARCH_PROJECT_MODEL_CONFIGURATION_INPUT_INVALID", "expected project generation is invalid");
  }
  return value as number;
}

export function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value) {
    failure("RESEARCH_PROJECT_MODEL_CONFIGURATION_STORAGE_UNAVAILABLE", `${label} is corrupt`, 503, true);
  }
  return value;
}

export async function decodeRevision(row: RevisionRow, ownerId: string, projectId: string): Promise<ResearchProjectModelConfigurationRevision> {
  if (row.owner_id !== ownerId || row.project_id !== projectId || row.protocol !== RESEARCH_PROJECT_MODEL_CONFIGURATION_PROTOCOL ||
      typeof row.configuration_ref !== "string" || !CONFIG_REF.test(row.configuration_ref) ||
      typeof row.configuration_sha256 !== "string" || !SHA256.test(row.configuration_sha256) ||
      typeof row.configuration_json !== "string" || typeof row.byte_length !== "number" ||
      typeof row.created_at !== "string" || typeof row.created_by_principal_ref !== "string") {
    failure("RESEARCH_PROJECT_MODEL_CONFIGURATION_STORAGE_UNAVAILABLE", "stored project configuration row is corrupt", 503, true);
  }
  let decoded: Awaited<ReturnType<typeof decodeResearchProjectModelConfigurationBundle>>;
  try {
    const parsed = JSON.parse(row.configuration_json) as unknown;
    decoded = await decodeResearchProjectModelConfigurationBundle(parsed);
  } catch (cause) {
    failure("RESEARCH_PROJECT_MODEL_CONFIGURATION_STORAGE_UNAVAILABLE", "stored project configuration JSON is corrupt", 503, true, cause);
  }
  if (decoded.json !== row.configuration_json || decoded.configuration_ref !== row.configuration_ref ||
      decoded.configuration_sha256 !== row.configuration_sha256 || decoded.byte_length !== row.byte_length ||
      utf8Length(row.configuration_json) > RESEARCH_PROJECT_MODEL_CONFIGURATION_MAX_BYTES) {
    failure("RESEARCH_PROJECT_MODEL_CONFIGURATION_STORAGE_UNAVAILABLE", "stored project configuration digest or bytes differ", 503, true);
  }
  return Object.freeze({
    owner_id: ownerId,
    project_id: projectId,
    configuration_ref: row.configuration_ref,
    configuration_sha256: row.configuration_sha256,
    configuration_json: row.configuration_json,
    byte_length: row.byte_length,
    protocol: RESEARCH_PROJECT_MODEL_CONFIGURATION_PROTOCOL,
    created_at: timestamp(row.created_at, "configuration created_at"),
    created_by_principal_ref: projectIdentifier(row.created_by_principal_ref, "created_by_principal_ref"),
    configuration: decoded.bundle,
  });
}

export function decodeSelection(row: SelectionRow, ownerId: string, projectId: string): Omit<ResearchProjectModelConfigurationSelection, "revision"> {
  if (!Number.isSafeInteger(row.selection_revision) || (row.selection_revision as number) < 1 ||
      (row.selection_revision as number) > 1_000_000 || typeof row.configuration_ref !== "string" ||
      !CONFIG_REF.test(row.configuration_ref) || typeof row.configuration_sha256 !== "string" ||
      !SHA256.test(row.configuration_sha256) || typeof row.selected_by_principal_ref !== "string") {
    failure("RESEARCH_PROJECT_MODEL_CONFIGURATION_STORAGE_UNAVAILABLE", "stored selected configuration pointer is corrupt", 503, true);
  }
  return Object.freeze({
    owner_id: ownerId,
    project_id: projectId,
    selection_revision: row.selection_revision as number,
    configuration_ref: row.configuration_ref,
    configuration_sha256: row.configuration_sha256,
    selected_at: timestamp(row.selected_at, "configuration selected_at"),
    selected_by_principal_ref: projectIdentifier(row.selected_by_principal_ref, "selected_by_principal_ref"),
  });
}
