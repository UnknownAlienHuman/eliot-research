import {
  canonicalModelGatewayJson,
  dynamicRouteQualificationProbeInputSha256,
  executeObservedModelGatewayCall,
  modelGatewayRequestParametersSha256,
  modelGatewaySha256,
  ModelGatewayExecutionError,
  parseDynamicRouteQualificationProbeInput,
  type DynamicRouteQualificationProbeInput,
  type ModelGatewayExecutionObservation,
  type ModelGatewayPromptCompilerPort,
} from "@eliotr/cloudflare-ai";
import {
  decodeModelCallReceipt,
  decodeModelRouteDeployment,
  type ModelRouteDeployment,
  type RouteFingerprint,
} from "@eliotr/platform-cloudflare";
import {
  createResearchQualificationPromptCompiler,
  parseResearchQualificationPromptConfig,
  type ResearchQualificationPromptConfig,
} from "./research-qualification-prompt.js";
import {
  createResearchModelQualificationNativeExecution,
  type ResearchModelQualificationNativeDependencies,
} from "./research-model-qualification.js";

const IDENTIFIER = /^[A-Za-z0-9._:@/-]{1,256}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const DISPATCH_INPUT_KEYS = new Set([
  "probe",
  "prompt",
  "probe_input_sha256",
  "claim_ref",
]);
const OBSERVATION_KEYS = new Set([
  "receipt",
  "route_fingerprint",
  "gateway_log_id",
  "pricing_quote_ref",
  "request_body_sha256",
  "request_parameters_sha256",
  "response_body_sha256",
  "response_model",
  "successful_step",
]);
const RECEIPT_KEYS = new Set([
  "billed_usd",
  "input_tokens",
  "output_object_ref",
  "output_sha256",
  "output_tokens",
  "receipt_ref",
  "route_fingerprint_ref",
]);
const FINGERPRINT_KEYS = new Set([
  "route_ref",
  "route_version",
  "prompt_generation",
  "schema_generation",
  "parameters_digest",
  "pricing_snapshot_ref",
  "provider",
  "exact_model_id",
]);
const PROBE_COLUMNS = "probe_idempotency_key,probe_input_sha256,claim_ref,execution_probe_ref";
const DISPATCH_COLUMNS = "probe_idempotency_key,probe_input_sha256,claim_ref,state,observation_sha256,observation_json,started_at,completed_at";

interface ProbeRow {
  readonly probe_idempotency_key: unknown;
  readonly probe_input_sha256: unknown;
  readonly claim_ref: unknown;
  readonly execution_probe_ref: unknown;
}

interface DispatchRow {
  readonly probe_idempotency_key: unknown;
  readonly probe_input_sha256: unknown;
  readonly claim_ref: unknown;
  readonly state: unknown;
  readonly observation_sha256: unknown;
  readonly observation_json: unknown;
  readonly started_at: unknown;
  readonly completed_at: unknown;
}

export interface ResearchModelQualificationDispatchDependencies {
  readonly core_database: D1Database;
  readonly search_database: D1Database;
  readonly work_bucket: R2Bucket;
  readonly evidence_bucket: R2Bucket;
  readonly gateway: ResearchModelQualificationNativeDependencies["gateway"];
  readonly now: () => string;
}

export interface ResearchModelQualificationDispatchAccess {
  readonly principal_ref: string;
  readonly client_class: "owner_pwa";
  readonly credential_generation: string;
}

export interface ResearchModelQualificationDispatchInput {
  readonly probe: DynamicRouteQualificationProbeInput;
  readonly prompt: unknown;
  readonly probe_input_sha256: string;
  readonly claim_ref: string;
}

export interface ResearchModelQualificationDispatchPort {
  execute(
    input: ResearchModelQualificationDispatchInput,
    access: ResearchModelQualificationDispatchAccess,
  ): Promise<ModelGatewayExecutionObservation>;
}

function modelFailure(
  code: "MODEL_GATEWAY_REQUEST_INVALID" | "MODEL_GATEWAY_PROMPT_COMPILE_FAILED" | "MODEL_GATEWAY_OUTPUT_PERSIST_FAILED" | "MODEL_GATEWAY_TRANSPORT_FAILED",
  message: string,
  cause?: unknown,
): never {
  throw new ModelGatewayExecutionError(code, message, { cause, retryable: false });
}

function exactObject(value: unknown, keys: ReadonlySet<string>, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) modelFailure("MODEL_GATEWAY_REQUEST_INVALID", `${label} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) modelFailure("MODEL_GATEWAY_REQUEST_INVALID", `${label} must be a plain object`);
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!keys.has(key)) modelFailure("MODEL_GATEWAY_REQUEST_INVALID", `${label} contains an unsupported field`);
  return record;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) modelFailure("MODEL_GATEWAY_REQUEST_INVALID", `${label} is invalid`);
  return value;
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) modelFailure("MODEL_GATEWAY_REQUEST_INVALID", `${label} is invalid`);
  return value;
}

function iso(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value) {
    modelFailure("MODEL_GATEWAY_REQUEST_INVALID", `${label} is invalid`);
  }
  return value;
}

function detached<T>(value: T, label: string): T {
  try {
    return JSON.parse(canonicalModelGatewayJson(value)) as T;
  } catch (cause) {
    modelFailure("MODEL_GATEWAY_REQUEST_INVALID", `${label} is not canonical JSON`, cause);
  }
}

function clockMilliseconds(now: () => string): number {
  const value = iso(now(), "qualification clock");
  return Date.parse(value);
}

function sameAccess(
  left: ResearchModelQualificationDispatchAccess,
  right: ResearchQualificationPromptConfig["access"],
): boolean {
  return left.principal_ref === right.principal_ref &&
    left.client_class === right.client_class &&
    left.credential_generation === right.credential_generation;
}

function assertAccess(
  value: ResearchModelQualificationDispatchAccess,
): ResearchModelQualificationDispatchAccess {
  if (value === null || typeof value !== "object" ||
      typeof value.principal_ref !== "string" || !IDENTIFIER.test(value.principal_ref) ||
      value.client_class !== "owner_pwa" ||
      typeof value.credential_generation !== "string" || !IDENTIFIER.test(value.credential_generation)) {
    modelFailure("MODEL_GATEWAY_REQUEST_INVALID", "qualification access context is invalid");
  }
  return Object.freeze({
    principal_ref: value.principal_ref,
    client_class: "owner_pwa",
    credential_generation: value.credential_generation,
  });
}

function assertProbeClaimInput(input: ResearchModelQualificationDispatchInput): void {
  identifier(input.claim_ref, "qualification claim reference");
  sha256(input.probe_input_sha256, "qualification probe input digest");
}

function claimIdentity(row: ProbeRow, input: ResearchModelQualificationDispatchInput): void {
  identifier(row.probe_idempotency_key, "stored qualification probe key");
  sha256(row.probe_input_sha256, "stored qualification probe input digest");
  identifier(row.claim_ref, "stored qualification claim reference");
  if (row.probe_idempotency_key !== input.probe.probe_idempotency_key ||
      row.probe_input_sha256 !== input.probe_input_sha256 ||
      row.claim_ref !== input.claim_ref) {
    modelFailure("MODEL_GATEWAY_REQUEST_INVALID", "qualification dispatch is bound to a different claim");
  }
}

function dispatchIdentity(row: DispatchRow, input: ResearchModelQualificationDispatchInput): void {
  identifier(row.probe_idempotency_key, "stored dispatch probe key");
  sha256(row.probe_input_sha256, "stored dispatch probe input digest");
  identifier(row.claim_ref, "stored dispatch claim reference");
  iso(row.started_at, "stored dispatch start time");
  if (row.probe_idempotency_key !== input.probe.probe_idempotency_key ||
      row.probe_input_sha256 !== input.probe_input_sha256 ||
      row.claim_ref !== input.claim_ref) {
    modelFailure("MODEL_GATEWAY_REQUEST_INVALID", "qualification dispatch is bound to different probe bytes");
  }
}

async function readProbeClaim(
  database: D1Database,
  key: string,
): Promise<ProbeRow | null> {
  try {
    return await database.prepare(`SELECT ${PROBE_COLUMNS} FROM model_route_qualification_probe WHERE probe_idempotency_key=?1 LIMIT 1`).bind(key).first<ProbeRow>();
  } catch (cause) {
    modelFailure("MODEL_GATEWAY_TRANSPORT_FAILED", "qualification claim read failed", cause);
  }
}

async function readDispatch(
  database: D1Database,
  key: string,
): Promise<DispatchRow | null> {
  try {
    return await database.prepare(`SELECT ${DISPATCH_COLUMNS} FROM model_route_qualification_dispatch WHERE probe_idempotency_key=?1 LIMIT 1`).bind(key).first<DispatchRow>();
  } catch (cause) {
    modelFailure("MODEL_GATEWAY_TRANSPORT_FAILED", "qualification dispatch read failed", cause);
  }
}

function routeFingerprint(raw: unknown): RouteFingerprint {
  const value = exactObject(raw, FINGERPRINT_KEYS, "stored qualification fingerprint");
  let deployment: ReturnType<typeof decodeModelRouteDeployment>;
  try {
    deployment = decodeModelRouteDeployment({
      route_ref: value.route_ref,
      route_version: value.route_version,
      prompt_generation: value.prompt_generation,
      schema_generation: value.schema_generation,
      parameters_digest: value.parameters_digest,
      pricing_snapshot_ref: value.pricing_snapshot_ref,
    });
  } catch (cause) {
    modelFailure("MODEL_GATEWAY_OUTPUT_PERSIST_FAILED", "stored qualification fingerprint is invalid", cause);
  }
  return Object.freeze({
    ...deployment,
    provider: identifier(value.provider, "stored qualification provider"),
    exact_model_id: identifier(value.exact_model_id, "stored qualification model"),
  });
}

async function decodeObservation(
  raw: unknown,
  probe: DynamicRouteQualificationProbeInput,
  expectedSha256?: string,
): Promise<ModelGatewayExecutionObservation> {
  const value = exactObject(raw, OBSERVATION_KEYS, "qualification dispatch observation");
  const fingerprint = routeFingerprint(value.route_fingerprint);
  const receiptValue = exactObject(value.receipt, RECEIPT_KEYS, "qualification model receipt");
  const fingerprintReference = identifier(receiptValue.route_fingerprint_ref, "qualification fingerprint reference");
  let receipt;
  try {
    receipt = decodeModelCallReceipt(probe.model_call, fingerprintReference, receiptValue);
  } catch (cause) {
    modelFailure("MODEL_GATEWAY_OUTPUT_PERSIST_FAILED", "qualification model receipt is invalid", cause);
  }
  const observation: ModelGatewayExecutionObservation = Object.freeze({
    receipt,
    route_fingerprint: fingerprint,
    gateway_log_id: identifier(value.gateway_log_id, "qualification gateway log ID"),
    pricing_quote_ref: identifier(value.pricing_quote_ref, "qualification pricing quote reference"),
    request_body_sha256: sha256(value.request_body_sha256, "qualification request digest"),
    request_parameters_sha256: sha256(value.request_parameters_sha256, "qualification parameter digest"),
    response_body_sha256: sha256(value.response_body_sha256, "qualification response digest"),
    response_model: identifier(value.response_model, "qualification response model"),
    ...(value.successful_step === undefined ? {} : { successful_step: identifier(value.successful_step, "qualification successful step") }),
  });
  if (expectedSha256 !== undefined) {
    const computed = await modelGatewaySha256(canonicalModelGatewayJson(observation));
    if (computed !== expectedSha256) modelFailure("MODEL_GATEWAY_OUTPUT_PERSIST_FAILED", "stored qualification dispatch observation digest differs from its bytes");
  }
  const expectedDeployment = probe.provisioning.deployment;
  const expectedFingerprintReference = `route-fingerprint-${await modelGatewaySha256(canonicalModelGatewayJson(fingerprint))}`;
  if (fingerprint.route_ref !== expectedDeployment.route_ref ||
      fingerprint.route_version !== expectedDeployment.route_version ||
      fingerprint.prompt_generation !== expectedDeployment.prompt_generation ||
      fingerprint.schema_generation !== expectedDeployment.schema_generation ||
      fingerprint.parameters_digest !== expectedDeployment.parameters_digest ||
      fingerprint.pricing_snapshot_ref !== expectedDeployment.pricing_snapshot_ref ||
      fingerprint.provider !== probe.expected_provider ||
      fingerprint.exact_model_id !== probe.expected_model ||
      fingerprintReference !== expectedFingerprintReference ||
      receipt.output_object_ref !== probe.model_call.output_object_ref ||
      receipt.output_sha256 !== observation.response_body_sha256 ||
      observation.response_model !== probe.expected_model) {
    modelFailure("MODEL_GATEWAY_OUTPUT_PERSIST_FAILED", "qualification dispatch observation is not bound to the prepared deployment");
  }
  return observation;
}

async function existingDispatchResult(
  row: DispatchRow,
  input: ResearchModelQualificationDispatchInput,
): Promise<ModelGatewayExecutionObservation | null> {
  dispatchIdentity(row, input);
  if (row.state === "STARTED") {
    if (row.observation_sha256 !== null || row.observation_json !== null || row.completed_at !== null) {
      modelFailure("MODEL_GATEWAY_OUTPUT_PERSIST_FAILED", "qualification dispatch has an incomplete STARTED record");
    }
    return null;
  }
  if (row.state !== "COMPLETED" || typeof row.observation_json !== "string" || typeof row.observation_sha256 !== "string" || row.completed_at === null) {
    modelFailure("MODEL_GATEWAY_OUTPUT_PERSIST_FAILED", "qualification dispatch state is invalid");
  }
  iso(row.completed_at, "stored dispatch completion time");
  let parsed: unknown;
  try { parsed = JSON.parse(row.observation_json); } catch (cause) { modelFailure("MODEL_GATEWAY_OUTPUT_PERSIST_FAILED", "stored qualification dispatch observation is not JSON", cause); }
  return decodeObservation(parsed, input.probe, row.observation_sha256);
}

async function claimDispatch(
  database: D1Database,
  input: ResearchModelQualificationDispatchInput,
  now: () => string,
): Promise<ModelGatewayExecutionObservation | null> {
  const startedAt = iso(now(), "qualification dispatch start time");
  let result: D1Result<unknown> | undefined;
  let writeError: unknown;
  try {
    result = await database.prepare(
      `INSERT INTO model_route_qualification_dispatch(${DISPATCH_COLUMNS}) VALUES (?1,?2,?3,'STARTED',NULL,NULL,?4,NULL) ON CONFLICT(probe_idempotency_key) DO NOTHING`,
    ).bind(input.probe.probe_idempotency_key, input.probe_input_sha256, input.claim_ref, startedAt).run();
  } catch (cause) {
    writeError = cause;
  }
  const row = await readDispatch(database, input.probe.probe_idempotency_key);
  if (row === null) modelFailure("MODEL_GATEWAY_TRANSPORT_FAILED", "qualification dispatch claim is uncertain", writeError);
  const existing = await existingDispatchResult(row, input);
  if (existing !== null) return existing;
  if (writeError !== undefined || result?.success !== true || result.meta?.changes !== 1) {
    modelFailure("MODEL_GATEWAY_TRANSPORT_FAILED", "qualification dispatch claim is already STARTED; provider retry is forbidden", writeError);
  }
  return null;
}

async function completeDispatch(
  database: D1Database,
  input: ResearchModelQualificationDispatchInput,
  observation: ModelGatewayExecutionObservation,
  now: () => string,
): Promise<ModelGatewayExecutionObservation> {
  const json = canonicalModelGatewayJson(observation);
  const digest = await modelGatewaySha256(json);
  const completedAt = iso(now(), "qualification dispatch completion time");
  let result: D1Result<unknown> | undefined;
  let writeError: unknown;
  try {
    result = await database.prepare(
      "UPDATE model_route_qualification_dispatch SET state='COMPLETED',observation_sha256=?1,observation_json=?2,completed_at=?3 WHERE probe_idempotency_key=?4 AND probe_input_sha256=?5 AND claim_ref=?6 AND state='STARTED' AND observation_json IS NULL",
    ).bind(digest, json, completedAt, input.probe.probe_idempotency_key, input.probe_input_sha256, input.claim_ref).run();
  } catch (cause) {
    writeError = cause;
  }
  const row = await readDispatch(database, input.probe.probe_idempotency_key);
  if (row === null) modelFailure("MODEL_GATEWAY_TRANSPORT_FAILED", "qualification dispatch completion is uncertain", writeError);
  const persisted = await existingDispatchResult(row, input);
  if (persisted !== null) {
    if (canonicalModelGatewayJson(persisted) !== json) modelFailure("MODEL_GATEWAY_OUTPUT_PERSIST_FAILED", "qualification dispatch completion conflicts with the executed observation");
    return persisted;
  }
  if (writeError !== undefined || result?.success !== true || result.meta?.changes !== 1) {
    modelFailure("MODEL_GATEWAY_TRANSPORT_FAILED", "qualification dispatch completion is uncertain; provider retry is forbidden", writeError);
  }
  modelFailure("MODEL_GATEWAY_TRANSPORT_FAILED", "qualification dispatch completion readback is still STARTED; provider retry is forbidden");
}

async function claimMatches(
  database: D1Database,
  input: ResearchModelQualificationDispatchInput,
): Promise<void> {
  const row = await readProbeClaim(database, input.probe.probe_idempotency_key);
  if (row === null) modelFailure("MODEL_GATEWAY_REQUEST_INVALID", "qualification observation claim is missing");
  claimIdentity(row, input);
  if (row.execution_probe_ref !== null) modelFailure("MODEL_GATEWAY_REQUEST_INVALID", "qualification observation claim is already completed");
}

function boundPromptCompiler(
  compiler: ModelGatewayPromptCompilerPort,
): ModelGatewayPromptCompilerPort {
  return Object.freeze({
    async compile(
      input: Parameters<ModelGatewayPromptCompilerPort["compile"]>[0],
      deployment: ModelRouteDeployment,
    ) {
      const raw = await compiler.compile(input, deployment);
      if (typeof raw !== "object" || raw === null || Array.isArray(raw) ||
          !("request_body" in raw) || !("request_body_sha256" in raw) || !("request_timeout_ms" in raw)) {
        modelFailure("MODEL_GATEWAY_PROMPT_COMPILE_FAILED", "qualification compiler returned an invalid compiled prompt");
      }
      const parametersDigest = await modelGatewayRequestParametersSha256(raw.request_body);
      if (parametersDigest !== deployment.parameters_digest) {
        modelFailure("MODEL_GATEWAY_PROMPT_COMPILE_FAILED", "qualification prompt parameters differ from the deployed generation");
      }
      return raw;
    },
  });
}

export function createResearchModelQualificationDispatch(
  dependencies: ResearchModelQualificationDispatchDependencies,
): ResearchModelQualificationDispatchPort {
  if (dependencies === null || typeof dependencies !== "object" ||
      typeof dependencies.core_database?.prepare !== "function" ||
      typeof dependencies.search_database?.prepare !== "function" ||
      typeof dependencies.work_bucket?.get !== "function" ||
      typeof dependencies.evidence_bucket?.get !== "function" ||
      typeof dependencies.now !== "function") {
    modelFailure("MODEL_GATEWAY_REQUEST_INVALID", "qualification dispatch dependencies are invalid");
  }
  return Object.freeze({
    async execute(
      rawInput: ResearchModelQualificationDispatchInput,
      rawAccess: ResearchModelQualificationDispatchAccess,
    ): Promise<ModelGatewayExecutionObservation> {
      if (rawInput === null || typeof rawInput !== "object" || Array.isArray(rawInput)) {
        modelFailure("MODEL_GATEWAY_REQUEST_INVALID", "qualification dispatch input is invalid");
      }
      exactObject(rawInput, DISPATCH_INPUT_KEYS, "qualification dispatch input");
      const access = assertAccess(rawAccess);
      assertProbeClaimInput(rawInput);
      let parsedProbe: DynamicRouteQualificationProbeInput;
      try {
        parsedProbe = parseDynamicRouteQualificationProbeInput(rawInput.probe);
      } catch (cause) {
        modelFailure("MODEL_GATEWAY_REQUEST_INVALID", "qualification probe is invalid", cause);
      }
      const prompt = parseResearchQualificationPromptConfig(rawInput.prompt);
      if (!sameAccess(access, prompt.access)) modelFailure("MODEL_GATEWAY_REQUEST_INVALID", "qualification prompt is bound to another owner session");
      const probe: DynamicRouteQualificationProbeInput = detached(parsedProbe, "qualification probe");
      const input = Object.freeze({
        probe,
        prompt,
        probe_input_sha256: rawInput.probe_input_sha256,
        claim_ref: rawInput.claim_ref,
      });
      const computedSha256 = await dynamicRouteQualificationProbeInputSha256(probe);
      if (computedSha256 !== input.probe_input_sha256) modelFailure("MODEL_GATEWAY_REQUEST_INVALID", "qualification probe digest differs from canonical bytes");
      await claimMatches(dependencies.core_database, input);
      const compiler = await createResearchQualificationPromptCompiler({
        core_database: dependencies.core_database,
        search_database: dependencies.search_database,
        evidence_bucket: dependencies.evidence_bucket,
        work_bucket: dependencies.work_bucket,
        probe,
        config: prompt,
        now: () => clockMilliseconds(dependencies.now),
      });
      const native = createResearchModelQualificationNativeExecution({
        database: dependencies.core_database,
        work_bucket: dependencies.work_bucket,
        gateway: dependencies.gateway,
        prompt_compiler: boundPromptCompiler(compiler),
        now: dependencies.now,
      });
      await native.assertPricingSnapshot(probe);
      const replay = await claimDispatch(dependencies.core_database, input, dependencies.now);
      if (replay !== null) return replay;
      let observed: ModelGatewayExecutionObservation;
      try {
        observed = await executeObservedModelGatewayCall(native.createExecution(probe), probe.model_call);
      } catch (cause) {
        modelFailure("MODEL_GATEWAY_TRANSPORT_FAILED", "qualification model execution failed; provider retry is forbidden", cause);
      }
      return completeDispatch(dependencies.core_database, input, observed, dependencies.now);
    },
  });
}

export type { ResearchQualificationPromptConfig };
