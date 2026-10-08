import {
  canonicalModelGatewayJson,
  modelGatewaySha256,
} from "@eliotr/cloudflare-ai";
import {
  decodeCanonicalBase64Bytes,
  encodeCanonicalBase64Bytes,
} from "@eliotr/platform-cloudflare";
import {
  decodeProviderNativeModelCandidate,
  decodeProviderNativeModelPreparation,
  providerNativeModelFailure,
  type ProviderNativeModelPreparationV1,
} from "./provider-native-model-candidate.js";
import {
  decodeStoredProviderNativeModelObservation,
  type StoredProviderNativeModelObservationV1,
} from "./provider-native-model-observation.js";
import {
  createProviderNativeModelCandidateProofBundle,
  type ProviderNativeModelCandidateProofBundleV1,
} from "./provider-native-model-proof.js";
import {
  readProviderNativeModelCandidate,
  readProviderNativeModelProof,
  readProviderNativeModelRevocation,
  type ProviderNativeModelStoredCandidateV1,
  type ProviderNativeModelStoredProofV1,
  type ProviderNativeModelStoredRevocationV1,
} from "./provider-native-model-immutable-readers.js";

export type ProviderNativeQualificationAttemptState = "NOT_STARTED" | "CLAIMED" | "STARTED" | "OBSERVED" | "COMPLETED";

export interface ProviderNativeQualificationAttemptIdentityV1 {
  readonly owner_ref: string;
  readonly project_id: string;
  readonly owner_operation_id: string;
  readonly stage: ProviderNativeModelPreparationV1["stage"];
  readonly preparation_ref: string;
  readonly preparation_sha256: string;
}

export interface ProviderNativeQualificationAttemptReadV1 extends ProviderNativeQualificationAttemptIdentityV1 {
  readonly status: Exclude<ProviderNativeQualificationAttemptState, "CLAIMED">;
  readonly observation_ref?: string;
  readonly observation_sha256?: string;
  readonly candidate_ref?: string;
  readonly candidate_sha256?: string;
  readonly qualification_ref?: string;
  readonly qualification_sha256?: string;
}

export interface ProviderNativeModelRevocationInputV1 {
  readonly owner_ref: string;
  readonly project_id: string;
  readonly qualification_ref: string;
  readonly qualification_sha256: string;
  readonly revoked_by: string;
  readonly reason: string;
}

export interface ProviderNativeModelStorePort {
  putPreparation(input: Readonly<{
    preparation_ref: string;
    preparation_sha256: string;
    preparation_json: string;
    preparation: ProviderNativeModelPreparationV1;
    request_sha256: string;
  }>): Promise<void>;
  readPreparation(input: Readonly<{ preparation_ref: string; preparation_sha256: string }>): Promise<ProviderNativeModelPreparationV1 | null>;
  readPreparationForOperation(input: Readonly<{
    owner_ref: string;
    project_id: string;
    owner_operation_id: string;
    stage: ProviderNativeModelPreparationV1["stage"];
  }>): Promise<Readonly<{ preparation_ref: string; preparation_sha256: string; preparation: ProviderNativeModelPreparationV1 }> | null>;
  claimQualification(input: ProviderNativeQualificationAttemptIdentityV1): Promise<ProviderNativeQualificationAttemptState>;
  readQualificationOperation(input: ProviderNativeQualificationAttemptIdentityV1): Promise<ProviderNativeQualificationAttemptReadV1>;
  readObservation(input: ProviderNativeQualificationAttemptIdentityV1): Promise<StoredProviderNativeModelObservationV1 | null>;
  putObservation(input: ProviderNativeQualificationAttemptIdentityV1 & {
    readonly observation: StoredProviderNativeModelObservationV1;
  }): Promise<void>;
  putCandidateProof(input: ProviderNativeQualificationAttemptIdentityV1 & {
    readonly bundle: ProviderNativeModelCandidateProofBundleV1;
  }): Promise<void>;
  readCandidate(input: Readonly<{ candidate_ref: string; candidate_sha256: string }>): Promise<ProviderNativeModelStoredCandidateV1 | null>;
  readProof(input: Readonly<{ qualification_ref: string; qualification_sha256: string }>): Promise<ProviderNativeModelStoredProofV1 | null>;
  readRevocation(input: Readonly<{ qualification_ref: string; qualification_sha256: string }>): Promise<ProviderNativeModelStoredRevocationV1 | null>;
  revoke(input: ProviderNativeModelRevocationInputV1): Promise<void>;
}

interface PreparationRow {
  readonly preparation_ref: unknown;
  readonly preparation_sha256: unknown;
  readonly preparation_json: unknown;
  readonly owner_ref: unknown;
  readonly project_id: unknown;
  readonly owner_operation_id: unknown;
  readonly stage: unknown;
  readonly route_ref: unknown;
  readonly route_version: unknown;
  readonly request_sha256: unknown;
}

interface AttemptRow {
  readonly owner_ref: unknown;
  readonly project_id: unknown;
  readonly owner_operation_id: unknown;
  readonly stage: unknown;
  readonly preparation_ref: unknown;
  readonly preparation_sha256: unknown;
  readonly state: unknown;
  readonly observation_ref: unknown;
  readonly observation_sha256: unknown;
  readonly candidate_ref: unknown;
  readonly candidate_sha256: unknown;
  readonly qualification_ref: unknown;
  readonly qualification_sha256: unknown;
  readonly started_at: unknown;
  readonly completed_at: unknown;
}

interface ObservationRow {
  readonly observation_ref: unknown;
  readonly observation_sha256: unknown;
  readonly observation_json: unknown;
  readonly request_body_base64: unknown;
  readonly response_body_base64: unknown;
}

const PREPARATION_COLUMNS = "preparation_ref,preparation_sha256,preparation_json,owner_ref,project_id,owner_operation_id,stage,route_ref,route_version,request_sha256";
const ATTEMPT_COLUMNS = "owner_ref,project_id,owner_operation_id,stage,preparation_ref,preparation_sha256,state,observation_ref,observation_sha256,candidate_ref,candidate_sha256,qualification_ref,qualification_sha256,started_at,completed_at";
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9:._/@-]{0,255}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
function valid(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}

function d1Base64Bytes(value: unknown, label: string): Uint8Array {
  if (typeof value !== "string") safeFailure(`native ${label} Base64 readback is malformed`);
  try { return decodeCanonicalBase64Bytes(value, { max_bytes: 32_768 }); }
  catch (cause) { safeFailure(`native ${label} Base64 readback is malformed`, cause); }
}

function d1Base64Text(value: Uint8Array, label: string): string {
  try { return encodeCanonicalBase64Bytes(value, 32_768); }
  catch (cause) { safeFailure(`native ${label} bytes cannot be encoded canonically`, cause); }
}

function safeFailure(message: string, cause?: unknown): never {
  providerNativeModelFailure("PROVIDER_NATIVE_MODEL_STORAGE_UNCERTAIN", message, cause);
}

function canonicalClock(now: () => string): string {
  let value: string;
  try { value = now(); } catch (cause) { providerNativeModelFailure("PROVIDER_NATIVE_MODEL_STORAGE_UNCERTAIN", "native model authority clock is unavailable", cause); }
  if (!valid(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u) || !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value) {
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_STORAGE_UNCERTAIN", "native model authority clock is not canonical UTC");
  }
  return value;
}

async function storedPreparation(row: PreparationRow): Promise<Readonly<{
  preparation_ref: string;
  preparation_sha256: string;
  preparation_json: string;
  preparation: ProviderNativeModelPreparationV1;
  request_sha256: string;
}>> {
  if (!valid(row.preparation_ref, IDENTIFIER) || !valid(row.preparation_sha256, SHA256) ||
      typeof row.preparation_json !== "string" || new TextEncoder().encode(row.preparation_json).byteLength > 65536 ||
      !valid(row.request_sha256, SHA256)) safeFailure("stored native preparation is malformed");
  let parsed: unknown;
  try { parsed = JSON.parse(row.preparation_json) as unknown; }
  catch (cause) { safeFailure("stored native preparation JSON is invalid", cause); }
  let preparation: ProviderNativeModelPreparationV1;
  try { preparation = decodeProviderNativeModelPreparation(parsed); }
  catch (cause) { safeFailure("stored native preparation failed strict validation", cause); }
  const canonical = canonicalModelGatewayJson(preparation);
  const sha = await modelGatewaySha256(canonical);
  if (canonical !== row.preparation_json || sha !== row.preparation_sha256 ||
      row.preparation_ref !== `provider-native-model-preparation-${sha}` ||
      preparation.request_sha256 !== row.request_sha256 ||
      row.owner_ref !== preparation.owner_ref || row.project_id !== preparation.project_id ||
      row.owner_operation_id !== preparation.owner_operation_id || row.stage !== preparation.stage ||
      row.route_ref !== preparation.deployment.route_ref || row.route_version !== preparation.deployment.route_version) {
    safeFailure("stored native preparation identity differs from its canonical bytes");
  }
  return Object.freeze({
    preparation_ref: row.preparation_ref,
    preparation_sha256: sha,
    preparation_json: canonical,
    preparation,
    request_sha256: row.request_sha256,
  });
}

function validateAttemptIdentity(row: AttemptRow, input: ProviderNativeQualificationAttemptIdentityV1): void {
  if (row.owner_ref !== input.owner_ref || row.project_id !== input.project_id ||
      row.owner_operation_id !== input.owner_operation_id || row.stage !== input.stage ||
      row.preparation_ref !== input.preparation_ref || row.preparation_sha256 !== input.preparation_sha256) {
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_CONFLICT", "native qualification operation identity conflicts with its durable claim");
  }
}

function attemptState(row: AttemptRow): Exclude<ProviderNativeQualificationAttemptState, "CLAIMED"> {
  if (row.state !== "STARTED" && row.state !== "OBSERVED" && row.state !== "COMPLETED") safeFailure("stored native qualification state is invalid");
  if (row.state === "STARTED" && (row.observation_ref !== null || row.observation_sha256 !== null || row.completed_at !== null) ||
      row.state === "OBSERVED" && (row.observation_ref === null || row.observation_sha256 === null || row.candidate_ref !== null || row.candidate_sha256 !== null || row.qualification_ref !== null || row.qualification_sha256 !== null || row.completed_at !== null) ||
      row.state === "COMPLETED" && (row.observation_ref === null || row.observation_sha256 === null || row.candidate_ref === null || row.candidate_sha256 === null || row.qualification_ref === null || row.qualification_sha256 === null || row.completed_at === null)) {
    safeFailure("stored native qualification state is incomplete");
  }
  return row.state;
}

/** D1 adapter for immutable native preparations, one-shot claims, observations, proofs and revocations. */
export function createD1ProviderNativeModelStore(
  database: D1Database,
  options: Readonly<{ now?: () => string }> = {},
): ProviderNativeModelStorePort {
  if (database === null || typeof database?.prepare !== "function") {
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_INPUT_INVALID", "native model D1 binding is unavailable");
  }
  const now = options.now ?? (() => new Date().toISOString());

  async function preparationByOperation(input: Readonly<{
    owner_ref: string; project_id: string; owner_operation_id: string; stage: ProviderNativeModelPreparationV1["stage"];
  }>) {
    let row: PreparationRow | null;
    try {
      row = await database.prepare(`SELECT ${PREPARATION_COLUMNS} FROM provider_native_model_preparation WHERE owner_ref=?1 AND project_id=?2 AND owner_operation_id=?3 AND stage=?4 LIMIT 1`)
        .bind(input.owner_ref, input.project_id, input.owner_operation_id, input.stage).first<PreparationRow>();
    } catch (cause) { safeFailure("native model preparation readback is unavailable", cause); }
    return row === null ? null : storedPreparation(row);
  }

  async function attemptByIdentity(input: ProviderNativeQualificationAttemptIdentityV1): Promise<AttemptRow | null> {
    let row: AttemptRow | null;
    try {
      row = await database.prepare(`SELECT ${ATTEMPT_COLUMNS} FROM provider_native_model_qualification_attempt WHERE owner_ref=?1 AND project_id=?2 AND owner_operation_id=?3 AND stage=?4 LIMIT 1`)
        .bind(input.owner_ref, input.project_id, input.owner_operation_id, input.stage).first<AttemptRow>();
    } catch (cause) { safeFailure("native qualification status readback is unavailable", cause); }
    if (row !== null) validateAttemptIdentity(row, input);
    return row;
  }

  async function preparationForAttempt(input: ProviderNativeQualificationAttemptIdentityV1): Promise<ProviderNativeModelPreparationV1> {
    const value = await port.readPreparation({ preparation_ref: input.preparation_ref, preparation_sha256: input.preparation_sha256 });
    if (value === null || value.owner_ref !== input.owner_ref || value.project_id !== input.project_id ||
        value.owner_operation_id !== input.owner_operation_id || value.stage !== input.stage) {
      providerNativeModelFailure("PROVIDER_NATIVE_MODEL_AUTHORITY_STALE", "native qualification preparation is missing or mismatched");
    }
    return value;
  }

  async function readObservation(input: ProviderNativeQualificationAttemptIdentityV1): Promise<StoredProviderNativeModelObservationV1 | null> {
    const row = await attemptByIdentity(input);
    if (row === null) return null;
    const state = attemptState(row);
    if (state === "STARTED") return null;
    let observationRow: ObservationRow | null;
    try {
      observationRow = await database.prepare("SELECT observation_ref,observation_sha256,observation_json,request_body_base64,response_body_base64 FROM provider_native_model_qualification_observation WHERE observation_ref=?1 AND observation_sha256=?2 LIMIT 1")
        .bind(row.observation_ref, row.observation_sha256).first<ObservationRow>();
    } catch (cause) { safeFailure("native qualification observation readback is unavailable", cause); }
    if (observationRow === null || typeof observationRow.observation_json !== "string" ||
        !valid(observationRow.observation_sha256, SHA256) || !valid(observationRow.observation_ref, IDENTIFIER)) {
      safeFailure("native qualification observation row is missing or malformed");
    }
    const preparation = await preparationForAttempt(input);
    const observation = await decodeStoredProviderNativeModelObservation(
      observationRow.observation_json, observationRow.observation_sha256,
      d1Base64Bytes(observationRow.request_body_base64, "request"),
      d1Base64Bytes(observationRow.response_body_base64, "response"), preparation,
    );
    if (observation.observation_ref !== observationRow.observation_ref) safeFailure("native observation reference differs from its bytes");
    return observation;
  }

  const port: ProviderNativeModelStorePort = {
    async putPreparation(input) {
      if (!valid(input.preparation_ref, IDENTIFIER) || !valid(input.preparation_sha256, SHA256) ||
          !valid(input.request_sha256, SHA256) || input.preparation_json.length > 65536) {
        providerNativeModelFailure("PROVIDER_NATIVE_MODEL_INPUT_INVALID", "native preparation write is malformed");
      }
      const material = await storedPreparation({
        preparation_ref: input.preparation_ref,
        preparation_sha256: input.preparation_sha256,
        preparation_json: input.preparation_json,
        owner_ref: input.preparation.owner_ref,
        project_id: input.preparation.project_id,
        owner_operation_id: input.preparation.owner_operation_id,
        stage: input.preparation.stage,
        route_ref: input.preparation.deployment.route_ref,
        route_version: input.preparation.deployment.route_version,
        request_sha256: input.request_sha256,
      });
      if (material.preparation_json !== input.preparation_json ||
          canonicalModelGatewayJson(input.preparation) !== input.preparation_json) {
        providerNativeModelFailure("PROVIDER_NATIVE_MODEL_INPUT_INVALID", "native preparation write does not match canonical preparation bytes");
      }
      const createdAt = canonicalClock(now);
      let write: D1Result<unknown> | undefined;
      let writeError: unknown;
      try {
        write = await database.prepare(
          `INSERT INTO provider_native_model_preparation(preparation_ref,preparation_sha256,preparation_json,owner_ref,project_id,owner_operation_id,stage,route_ref,route_version,request_sha256,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11) ON CONFLICT(owner_ref,project_id,owner_operation_id,stage) DO NOTHING`,
        ).bind(input.preparation_ref, input.preparation_sha256, input.preparation_json,
          input.preparation.owner_ref, input.preparation.project_id, input.preparation.owner_operation_id,
          input.preparation.stage, input.preparation.deployment.route_ref, input.preparation.deployment.route_version,
          input.request_sha256, createdAt).run();
      } catch (cause) { writeError = cause; }
      const persisted = await preparationByOperation(input.preparation);
      if (persisted === null || persisted.request_sha256 !== input.request_sha256 ||
          persisted.preparation_ref !== input.preparation_ref || persisted.preparation_sha256 !== input.preparation_sha256 ||
          persisted.preparation_json !== input.preparation_json) {
        providerNativeModelFailure(writeError === undefined ? "PROVIDER_NATIVE_MODEL_CONFLICT" : "PROVIDER_NATIVE_MODEL_STORAGE_UNCERTAIN",
          "native preparation persistence did not read back the exact input", writeError);
      }
      if (writeError === undefined && write?.success !== true) safeFailure("native preparation write failed");
    },

    async readPreparation(input) {
      if (!valid(input.preparation_ref, IDENTIFIER) || !valid(input.preparation_sha256, SHA256)) {
        providerNativeModelFailure("PROVIDER_NATIVE_MODEL_INPUT_INVALID", "native preparation lookup is malformed");
      }
      let row: PreparationRow | null;
      try {
        row = await database.prepare(`SELECT ${PREPARATION_COLUMNS} FROM provider_native_model_preparation WHERE preparation_ref=?1 AND preparation_sha256=?2 LIMIT 1`)
          .bind(input.preparation_ref, input.preparation_sha256).first<PreparationRow>();
      } catch (cause) { safeFailure("native preparation lookup is unavailable", cause); }
      return row === null ? null : (await storedPreparation(row)).preparation;
    },

    async readPreparationForOperation(input) {
      return preparationByOperation(input);
    },

    async claimQualification(input) {
      await preparationForAttempt(input);
      const before = await attemptByIdentity(input);
      if (before !== null) return attemptState(before);
      const startedAt = canonicalClock(now);
      let write: D1Result<unknown> | undefined;
      let writeError: unknown;
      try {
        write = await database.prepare(
          `INSERT INTO provider_native_model_qualification_attempt(owner_ref,project_id,owner_operation_id,stage,preparation_ref,preparation_sha256,state,started_at) VALUES (?1,?2,?3,?4,?5,?6,'STARTED',?7) ON CONFLICT(owner_ref,project_id,owner_operation_id,stage) DO NOTHING`,
        ).bind(input.owner_ref, input.project_id, input.owner_operation_id, input.stage,
          input.preparation_ref, input.preparation_sha256, startedAt).run();
      } catch (cause) { writeError = cause; }
      const after = await attemptByIdentity(input);
      if (after === null) safeFailure("native qualification claim is unavailable", writeError);
      const state = attemptState(after);
      // Only a positively acknowledged first insert grants this invocation the one-shot call.
      if (writeError === undefined && write?.success === true && write.meta?.changes === 1 && state === "STARTED") return "CLAIMED";
      return state;
    },

    async readQualificationOperation(input) {
      const row = await attemptByIdentity(input);
      if (row === null) return Object.freeze({ ...input, status: "NOT_STARTED" as const });
      const status = attemptState(row);
      const base = { ...input, status };
      if (status === "STARTED") return Object.freeze(base);
      const observationRef = valid(row.observation_ref, IDENTIFIER) ? row.observation_ref : null;
      const observationSha = valid(row.observation_sha256, SHA256) ? row.observation_sha256 : null;
      if (observationRef === null || observationSha === null) safeFailure("native qualification observation identity is missing");
      if (status === "OBSERVED") return Object.freeze({ ...base, observation_ref: observationRef, observation_sha256: observationSha });
      if (!valid(row.candidate_ref, IDENTIFIER) || !valid(row.candidate_sha256, SHA256) ||
          !valid(row.qualification_ref, IDENTIFIER) || !valid(row.qualification_sha256, SHA256)) {
        safeFailure("completed native qualification identity is incomplete");
      }
      return Object.freeze({ ...base,
        observation_ref: observationRef, observation_sha256: observationSha,
        candidate_ref: row.candidate_ref, candidate_sha256: row.candidate_sha256,
        qualification_ref: row.qualification_ref, qualification_sha256: row.qualification_sha256,
      });
    },

    async readObservation(input) {
      return readObservation(input);
    },

    async putObservation(input) {
      const row = await attemptByIdentity(input);
      if (row === null || attemptState(row) !== "STARTED") {
        providerNativeModelFailure("PROVIDER_NATIVE_MODEL_CONFLICT", "native observation has no STARTED one-shot claim");
      }
      const observation = input.observation;
      const preparation = await preparationForAttempt(input);
      const verified = await decodeStoredProviderNativeModelObservation(
        observation.observation_json, observation.observation_sha256,
        observation.request_body_bytes, observation.response_body_bytes, preparation,
      );
      if (verified.observation_ref !== observation.observation_ref ||
          verified.preparation_ref !== input.preparation_ref || verified.preparation_sha256 !== input.preparation_sha256) {
        providerNativeModelFailure("PROVIDER_NATIVE_MODEL_AUTHORITY_STALE", "native observation differs from its claimed preparation");
      }
      const observedAt = canonicalClock(now);
      try {
        await database.batch([
          database.prepare("INSERT INTO provider_native_model_qualification_observation(observation_ref,observation_sha256,observation_json,request_body_base64,response_body_base64,owner_ref,project_id,owner_operation_id,stage,preparation_ref,preparation_sha256,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)")
            .bind(observation.observation_ref, observation.observation_sha256, observation.observation_json,
              d1Base64Text(observation.request_body_bytes, "request"),
              d1Base64Text(observation.response_body_bytes, "response"),
              input.owner_ref, input.project_id, input.owner_operation_id, input.stage,
              input.preparation_ref, input.preparation_sha256, observedAt),
          database.prepare("UPDATE provider_native_model_qualification_attempt SET state='OBSERVED',observation_ref=?1,observation_sha256=?2 WHERE owner_ref=?3 AND project_id=?4 AND owner_operation_id=?5 AND stage=?6 AND preparation_ref=?7 AND preparation_sha256=?8 AND state='STARTED'")
            .bind(observation.observation_ref, observation.observation_sha256, input.owner_ref, input.project_id,
              input.owner_operation_id, input.stage, input.preparation_ref, input.preparation_sha256),
        ]);
      } catch (cause) {
        const after = await attemptByIdentity(input);
        const stored = after !== null && attemptState(after) !== "STARTED" ? await readObservation(input) : null;
        if (stored?.observation_json === observation.observation_json) return;
        safeFailure("native qualification observation persistence is uncertain", cause);
      }
      const after = await attemptByIdentity(input);
      const stored = await readObservation(input);
      if (after === null || attemptState(after) !== "OBSERVED" || stored?.observation_json !== observation.observation_json) {
        safeFailure("native qualification observation readback differs from its one-shot result");
      }
    },

    async putCandidateProof(input) {
      const attempt = await attemptByIdentity(input);
      if (attempt === null || (attemptState(attempt) !== "OBSERVED" && attemptState(attempt) !== "COMPLETED")) {
        providerNativeModelFailure("PROVIDER_NATIVE_MODEL_CONFLICT", "native proof has no durably observed call");
      }
      const bundle = input.bundle;
      const candidate = decodeProviderNativeModelCandidate(bundle.candidate.value);
      const expectedPreparation = await preparationForAttempt(input);
      if (candidate.preparation.owner_operation_id !== input.owner_operation_id ||
          candidate.preparation.stage !== input.stage || candidate.preparation_ref !== input.preparation_ref ||
          candidate.preparation_sha256 !== input.preparation_sha256 ||
          candidate.preparation.project_id !== input.project_id || candidate.preparation.owner_ref !== input.owner_ref ||
          canonicalModelGatewayJson(candidate.preparation) !== canonicalModelGatewayJson(expectedPreparation)) {
        providerNativeModelFailure("PROVIDER_NATIVE_MODEL_AUTHORITY_STALE", "native candidate does not match its exact durable preparation");
      }
      if (attempt.observation_ref !== candidate.observation_ref || attempt.observation_sha256 !== candidate.observation_sha256) {
        providerNativeModelFailure("PROVIDER_NATIVE_MODEL_AUTHORITY_STALE", "native candidate does not match its durable observation");
      }
      const storedObservation = await readObservation(input);
      if (storedObservation === null || storedObservation.observation_ref !== candidate.observation_ref ||
          storedObservation.observation_sha256 !== candidate.observation_sha256) {
        providerNativeModelFailure("PROVIDER_NATIVE_MODEL_AUTHORITY_STALE", "native candidate observation is unavailable");
      }
      const expectedBundle = await createProviderNativeModelCandidateProofBundle({
        preparation: expectedPreparation,
        preparation_ref: input.preparation_ref,
        preparation_sha256: input.preparation_sha256,
        observation: storedObservation,
      });
      if (expectedBundle.candidate.candidate_json !== bundle.candidate.candidate_json ||
          expectedBundle.proof.qualification_json !== bundle.proof.qualification_json) {
        providerNativeModelFailure("PROVIDER_NATIVE_MODEL_AUTHORITY_STALE", "native proof bytes differ from the persisted provider response observation");
      }
      const expectedCandidate = await modelGatewaySha256(bundle.candidate.candidate_json);
      const expectedProof = await modelGatewaySha256(bundle.proof.qualification_json);
      if (expectedCandidate !== bundle.candidate.candidate_sha256 ||
          bundle.candidate.candidate_ref !== `provider-native-model-candidate-${expectedCandidate}` ||
          expectedProof !== bundle.proof.qualification_sha256 ||
          bundle.proof.qualification_ref !== `provider-native-model-qualification-${expectedProof}` ||
          bundle.proof.qualification.candidate_ref !== bundle.candidate.candidate_ref ||
          bundle.proof.qualification.candidate_sha256 !== bundle.candidate.candidate_sha256 ||
          bundle.proof.qualification.qualification.observation_ref !== candidate.observation_ref ||
          bundle.proof.qualification.qualification.observation_sha256 !== candidate.observation_sha256) {
        providerNativeModelFailure("PROVIDER_NATIVE_MODEL_INPUT_INVALID", "native candidate or proof identity is not canonical");
      }
      if (attemptState(attempt) === "COMPLETED") {
        if (attempt.candidate_ref !== bundle.candidate.candidate_ref || attempt.candidate_sha256 !== bundle.candidate.candidate_sha256 ||
            attempt.qualification_ref !== bundle.proof.qualification_ref || attempt.qualification_sha256 !== bundle.proof.qualification_sha256) {
          providerNativeModelFailure("PROVIDER_NATIVE_MODEL_CONFLICT", "completed native operation points to different immutable evidence");
        }
        return;
      }
      const completedAt = canonicalClock(now);
      try {
        await database.batch([
          database.prepare("INSERT INTO provider_native_model_candidate(candidate_ref,candidate_sha256,candidate_json,owner_ref,project_id,stage,route_ref,route_version,preparation_ref,preparation_sha256,observation_ref,observation_sha256,qualification_tier,verified_at,qualification_expires_at,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'LIVE',?13,?14,?15)")
            .bind(bundle.candidate.candidate_ref, bundle.candidate.candidate_sha256, bundle.candidate.candidate_json,
              input.owner_ref, input.project_id, input.stage, expectedPreparation.deployment.route_ref,
              expectedPreparation.deployment.route_version, input.preparation_ref, input.preparation_sha256,
              candidate.observation_ref, candidate.observation_sha256, candidate.verified_at,
              candidate.qualification_expires_at, completedAt),
          database.prepare("INSERT INTO provider_native_model_qualification_proof(qualification_ref,qualification_sha256,qualification_json,owner_ref,project_id,stage,route_ref,route_version,candidate_ref,candidate_sha256,observation_ref,observation_sha256,qualification_tier,verified_at,expires_at,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'LIVE',?13,?14,?15)")
            .bind(bundle.proof.qualification_ref, bundle.proof.qualification_sha256, bundle.proof.qualification_json,
              input.owner_ref, input.project_id, input.stage, expectedPreparation.deployment.route_ref,
              expectedPreparation.deployment.route_version, bundle.candidate.candidate_ref, bundle.candidate.candidate_sha256,
              candidate.observation_ref, candidate.observation_sha256, candidate.verified_at,
              candidate.qualification_expires_at, completedAt),
          database.prepare("UPDATE provider_native_model_qualification_attempt SET state='COMPLETED',candidate_ref=?1,candidate_sha256=?2,qualification_ref=?3,qualification_sha256=?4,completed_at=?5 WHERE owner_ref=?6 AND project_id=?7 AND owner_operation_id=?8 AND stage=?9 AND preparation_ref=?10 AND preparation_sha256=?11 AND state='OBSERVED' AND observation_ref=?12 AND observation_sha256=?13")
            .bind(bundle.candidate.candidate_ref, bundle.candidate.candidate_sha256,
              bundle.proof.qualification_ref, bundle.proof.qualification_sha256, completedAt,
              input.owner_ref, input.project_id, input.owner_operation_id, input.stage,
              input.preparation_ref, input.preparation_sha256, candidate.observation_ref, candidate.observation_sha256),
        ]);
      } catch (cause) {
        const readback = await port.readQualificationOperation(input);
        if (readback.status === "COMPLETED" && readback.candidate_ref === bundle.candidate.candidate_ref &&
            readback.candidate_sha256 === bundle.candidate.candidate_sha256 &&
            readback.qualification_ref === bundle.proof.qualification_ref &&
            readback.qualification_sha256 === bundle.proof.qualification_sha256) return;
        safeFailure("native candidate and proof persistence is uncertain", cause);
      }
      const readback = await port.readQualificationOperation(input);
      const candidateRead = await port.readCandidate({ candidate_ref: bundle.candidate.candidate_ref, candidate_sha256: bundle.candidate.candidate_sha256 });
      const proofRead = await port.readProof({ qualification_ref: bundle.proof.qualification_ref, qualification_sha256: bundle.proof.qualification_sha256 });
      if (readback.status !== "COMPLETED" || candidateRead?.candidate_json !== bundle.candidate.candidate_json ||
          proofRead?.qualification_json !== bundle.proof.qualification_json) {
        safeFailure("native candidate and proof readback differs from the durable observation");
      }
    },

    async readCandidate(input) {
      return readProviderNativeModelCandidate(database, input);
    },

    async readProof(input) {
      return readProviderNativeModelProof(database, input);
    },

    async readRevocation(input) {
      return readProviderNativeModelRevocation(database, input);
    },

    async revoke(input) {
      if (!valid(input.owner_ref, IDENTIFIER) || !valid(input.project_id, IDENTIFIER) ||
          !valid(input.qualification_ref, IDENTIFIER) || !valid(input.qualification_sha256, SHA256) ||
          !valid(input.revoked_by, IDENTIFIER) || input.revoked_by !== input.owner_ref || typeof input.reason !== "string" ||
          input.reason.trim().length < 1 || new TextEncoder().encode(input.reason).byteLength > 1024) {
        providerNativeModelFailure("PROVIDER_NATIVE_MODEL_INPUT_INVALID", "native qualification revocation is invalid");
      }
      const proof = await port.readProof({ qualification_ref: input.qualification_ref, qualification_sha256: input.qualification_sha256 });
      if (proof === null) providerNativeModelFailure("PROVIDER_NATIVE_MODEL_AUTHORITY_STALE", "native qualification proof is unavailable for revocation");
      const candidate = await port.readCandidate({ candidate_ref: proof.qualification.candidate_ref,
        candidate_sha256: proof.qualification.candidate_sha256 });
      if (candidate === null || candidate.candidate.preparation.owner_ref !== input.owner_ref ||
          candidate.candidate.preparation.project_id !== input.project_id) {
        providerNativeModelFailure("PROVIDER_NATIVE_MODEL_AUTHORITY_STALE", "native qualification belongs to another owner or project");
      }
      const revokedAt = canonicalClock(now);
      let writeError: unknown;
      try {
        await database.prepare("INSERT INTO provider_native_model_qualification_revocation(qualification_ref,qualification_sha256,owner_ref,project_id,reason,revoked_by,revoked_at) VALUES (?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(qualification_ref,qualification_sha256) DO NOTHING")
          .bind(input.qualification_ref, input.qualification_sha256, input.owner_ref, input.project_id,
            input.reason.trim(), input.revoked_by, revokedAt).run();
      } catch (cause) { writeError = cause; }
      const persisted = await port.readRevocation(input);
      if (persisted === null || persisted.owner_ref !== input.owner_ref || persisted.project_id !== input.project_id ||
          persisted.revoked_by !== input.revoked_by || persisted.reason !== input.reason.trim()) {
        providerNativeModelFailure(writeError === undefined ? "PROVIDER_NATIVE_MODEL_CONFLICT" : "PROVIDER_NATIVE_MODEL_STORAGE_UNCERTAIN",
          "native qualification revocation did not read back exactly", writeError);
      }
    },
  };

  return Object.freeze(port);
}
