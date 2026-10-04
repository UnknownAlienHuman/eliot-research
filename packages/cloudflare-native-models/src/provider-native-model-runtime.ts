import type {
  ResearchModelPricingSnapshot,
  ResearchModelPricingSnapshotStore,
} from "@eliotr/cloudflare-model-control";
import {
  PROVIDER_NATIVE_MODEL_CANDIDATE_KIND,
  ProviderNativeModelAuthorityError,
  assertProviderNativeModelProbeBinding,
  createProviderNativeModelPreparation,
  decodeProviderNativeModelPreparationInput,
  decodeProviderNativeModelSelection,
  providerNativeModelFailure,
  type ProviderNativeModelPreparationInputV1,
  type ProviderNativeModelPreparationV1,
  type ProviderNativeModelPreparationReceiptV1,
  type ProviderNativeModelSelectionV1,
} from "./provider-native-model-candidate.js";
import {
  validateProviderNativeModelKeyBinding,
  type ProviderNativeModelKeyConfigurationReaderPort,
  type ProviderNativeModelProviderScopeV1,
} from "./provider-native-model-key-binding.js";
import {
  createProviderNativeModelObservation,
  type StoredProviderNativeModelObservationV1,
} from "./provider-native-model-observation.js";
import {
  createProviderNativeModelCandidateProofBundle,
} from "./provider-native-model-proof.js";
import {
  createD1ProviderNativeModelStore,
  type ProviderNativeModelStorePort,
  type ProviderNativeQualificationAttemptIdentityV1,
  type ProviderNativeQualificationAttemptReadV1,
  type ProviderNativeModelRevocationInputV1,
} from "./provider-native-model-store.js";
import { canonicalModelGatewayJson } from "@eliotr/cloudflare-ai";
import type { ProviderNativeModelProbeExecutionV1 } from "./provider-native-model-observation.js";

const DEFAULT_PREPARATION_TTL_MS = 10 * 60 * 1000;
const DEFAULT_QUALIFICATION_TTL_MS = 60 * 60 * 1000;
const MAX_TTL_MS = 60 * 60 * 1000;
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface ProviderNativeModelQualificationExecutorPort {
  executeOnce(input: ProviderNativeModelQualificationExecutionInputV1): Promise<ProviderNativeModelProbeExecutionV1>;
}

export interface ProviderNativeModelQualificationExecutionInputV1 {
  readonly preparation_ref: string;
  readonly preparation_sha256: string;
  readonly preparation: ProviderNativeModelPreparationV1;
}

export interface ProviderNativeModelAuthorityOptions {
  readonly database: D1Database;
  readonly key_configurations: ProviderNativeModelKeyConfigurationReaderPort;
  readonly provider_scope: ProviderNativeModelProviderScopeV1;
  readonly pricing_snapshots: ResearchModelPricingSnapshotStore;
  readonly now?: () => string;
  readonly preparation_ttl_ms?: number;
  readonly qualification_ttl_ms?: number;
  readonly store?: ProviderNativeModelStorePort;
}

export interface ProviderNativeModelAuthorityPort {
  prepare(input: ProviderNativeModelPreparationInputV1): Promise<ProviderNativeModelPreparationReceiptV1>;
  qualify(input: ProviderNativeQualificationRequestV1): Promise<ProviderNativeModelSelectionV1>;
  readQualificationOperation(input: ProviderNativeQualificationAttemptIdentityV1): Promise<ProviderNativeQualificationAttemptReadV1>;
  resolvePinned(input: Readonly<{
    selection: unknown;
    owner_ref: string;
    project_id: string;
    /** True only when the persisted run configuration is snapshot-v2. */
    allow_expired_snapshot_v2: boolean;
  }>): Promise<ResolvedProviderNativeModelSelectionV1>;
  revoke(input: ProviderNativeModelRevocationInputV1): Promise<void>;
}

export interface ProviderNativeQualificationRequestV1 extends ProviderNativeQualificationAttemptIdentityV1 {
  readonly executor: ProviderNativeModelQualificationExecutorPort;
}

type StoredProviderNativeModelCandidate = NonNullable<Awaited<ReturnType<ProviderNativeModelStorePort["readCandidate"]>>>;
type StoredProviderNativeModelProof = NonNullable<Awaited<ReturnType<ProviderNativeModelStorePort["readProof"]>>>;

export interface ResolvedProviderNativeModelSelectionV1 {
  readonly selection: ProviderNativeModelSelectionV1;
  readonly candidate: StoredProviderNativeModelCandidate;
  readonly proof: StoredProviderNativeModelProof;
  readonly observation: StoredProviderNativeModelObservationV1;
  readonly pricing_snapshot: ResearchModelPricingSnapshot;
}

function canonicalNow(now: () => string): Readonly<{ value: string; milliseconds: number }> {
  let value: string;
  try { value = now(); } catch (cause) { providerNativeModelFailure("PROVIDER_NATIVE_MODEL_STORAGE_UNCERTAIN", "native model clock is unavailable", cause); }
  const milliseconds = Date.parse(value);
  if (!Number.isSafeInteger(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_STORAGE_UNCERTAIN", "native model clock is not canonical UTC");
  }
  return Object.freeze({ value, milliseconds });
}

function ttl(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 60_000 || result > MAX_TTL_MS) {
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_INPUT_INVALID", `${label} is outside its allowed bound`);
  }
  return result;
}

function receipt(preparation: Readonly<{
  preparation_ref: string;
  preparation_sha256: string;
  preparation: ProviderNativeModelPreparationV1;
}>): ProviderNativeModelPreparationReceiptV1 {
  const authority: ProviderNativeModelPreparationReceiptV1 = {
    protocol: "eliotr.provider-native-model-preparation.v1",
    preparation_ref: preparation.preparation_ref,
    preparation_sha256: preparation.preparation_sha256,
    owner_operation_id: preparation.preparation.owner_operation_id,
    stage: preparation.preparation.stage,
    route_ref: preparation.preparation.deployment.route_ref,
    route_version: preparation.preparation.deployment.route_version,
    provider: "openrouter",
    exact_model_id: preparation.preparation.transport_policy.model,
    preparation_expires_at: preparation.preparation.preparation_expires_at,
  };
  return Object.freeze(authority);
}

function selectionFrom(
  candidate: StoredProviderNativeModelCandidate,
  proof: StoredProviderNativeModelProof,
): ProviderNativeModelSelectionV1 {
  return decodeProviderNativeModelSelection({
    candidate_kind: PROVIDER_NATIVE_MODEL_CANDIDATE_KIND,
    stage: candidate.candidate.preparation.stage,
    route_ref: candidate.candidate.preparation.deployment.route_ref,
    route_version: candidate.candidate.preparation.deployment.route_version,
    candidate_ref: candidate.candidate_ref,
    candidate_sha256: candidate.candidate_sha256,
    qualification_ref: proof.qualification_ref,
    qualification_sha256: proof.qualification_sha256,
    transport_policy: candidate.candidate.preparation.transport_policy,
  });
}

function preparationInput(
  preparation: ProviderNativeModelPreparationV1 & Readonly<{ key_binding: { operation_id: string } }>,
): ProviderNativeModelPreparationInputV1 {
  return Object.freeze({
    owner_operation_id: preparation.owner_operation_id,
    owner_ref: preparation.owner_ref,
    project_id: preparation.project_id,
    stage: preparation.stage,
    deployment: preparation.deployment,
    probe_deployment: preparation.probe_deployment,
    transport_policy: preparation.transport_policy,
    key_configuration_operation_id: preparation.key_binding.operation_id,
    pricing_snapshot_ref: preparation.pricing_snapshot_ref,
    pricing_snapshot_sha256: preparation.pricing_snapshot_sha256,
    prompt_sha256: preparation.prompt_sha256,
    schema_sha256: preparation.schema_sha256,
    parameters_sha256: preparation.parameters_sha256,
    probe_prompt_sha256: preparation.probe_prompt_sha256,
    probe_schema_sha256: preparation.probe_schema_sha256,
    probe_parameters_sha256: preparation.probe_parameters_sha256,
  });
}

export function createD1ProviderNativeModelAuthority(
  options: ProviderNativeModelAuthorityOptions,
): ProviderNativeModelAuthorityPort {
  if (options === null || typeof options !== "object" || typeof options.database?.prepare !== "function" ||
      typeof options.key_configurations?.readConfigured !== "function" ||
      typeof options.pricing_snapshots?.read !== "function") {
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_INPUT_INVALID", "native model authority dependencies are incomplete");
  }
  const now = options.now ?? (() => new Date().toISOString());
  const prepTtl = ttl(options.preparation_ttl_ms, DEFAULT_PREPARATION_TTL_MS, "native preparation lifetime");
  const qualificationTtl = ttl(options.qualification_ttl_ms, DEFAULT_QUALIFICATION_TTL_MS, "native qualification lifetime");
  const providerScope = options.provider_scope;
  if (providerScope === null || typeof providerScope !== "object" ||
      typeof providerScope.account_id !== "string" || !/^[a-f0-9]{32}$/u.test(providerScope.account_id.toLowerCase()) ||
      typeof providerScope.gateway_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(providerScope.gateway_id)) {
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_INPUT_INVALID", "native model provider scope is invalid");
  }
  const store = options.store ?? createD1ProviderNativeModelStore(options.database, { now });

  async function readKey(input: ProviderNativeModelPreparationInputV1) {
    let raw: unknown;
    try {
      raw = await options.key_configurations.readConfigured({
        owner_ref: input.owner_ref,
        project_id: input.project_id,
        owner_operation_id: input.owner_operation_id,
        stage: input.stage,
        operation_id: input.key_configuration_operation_id,
      });
    } catch (cause) {
      providerNativeModelFailure("PROVIDER_NATIVE_MODEL_STORAGE_UNCERTAIN", "current configured provider key readback is unavailable", cause);
    }
    if (raw === null) providerNativeModelFailure("PROVIDER_NATIVE_MODEL_AUTHORITY_STALE", "selected provider key operation is not currently configured");
    return validateProviderNativeModelKeyBinding(raw, {
      owner_ref: input.owner_ref,
      project_id: input.project_id,
      owner_operation_id: input.owner_operation_id,
      stage: input.stage,
      operation_id: input.key_configuration_operation_id,
    }, providerScope);
  }

  async function readPricing(
    input: ProviderNativeModelPreparationInputV1,
    at: number,
    requireCurrent: boolean,
  ): Promise<ResearchModelPricingSnapshot> {
    let snapshot: ResearchModelPricingSnapshot | null;
    try {
      snapshot = await options.pricing_snapshots.read({
        pricing_snapshot_ref: input.pricing_snapshot_ref,
        route_ref: input.deployment.route_ref,
        route_version: input.deployment.route_version,
        provider: input.transport_policy.provider,
        exact_model_id: input.transport_policy.model,
      });
    } catch (cause) {
      providerNativeModelFailure("PROVIDER_NATIVE_MODEL_STORAGE_UNCERTAIN", "approved native pricing snapshot readback is unavailable", cause);
    }
    if (snapshot === null || snapshot.pricing_snapshot_ref !== input.pricing_snapshot_ref ||
        snapshot.snapshot_sha256 !== input.pricing_snapshot_sha256 || snapshot.route_ref !== input.deployment.route_ref ||
        snapshot.route_version !== input.deployment.route_version || snapshot.provider !== "openrouter" ||
        snapshot.exact_model_id !== input.transport_policy.model || snapshot.pricing_basis !== "EXACT_TOKEN_RATES_V1" ||
        snapshot.approval_receipt_ref.length === 0 || input.deployment.pricing_snapshot_ref !== snapshot.pricing_snapshot_ref) {
      providerNativeModelFailure("PROVIDER_NATIVE_MODEL_AUTHORITY_STALE", "approved pricing snapshot does not match the exact native tuple");
    }
    if (input.transport_policy.billing.mode !== "byok" ||
        (input.transport_policy.billing.free_only === true &&
          (snapshot.input_rate_usd_per_1k_tokens !== "0" || snapshot.output_rate_usd_per_1k_tokens !== "0"))) {
      providerNativeModelFailure("PROVIDER_NATIVE_MODEL_AUTHORITY_STALE", "free-only native policy requires an exact zero-rate pricing snapshot");
    }
    const effectiveAt = Date.parse(snapshot.effective_at);
    const expiresAt = Date.parse(snapshot.expires_at);
    if (!Number.isFinite(effectiveAt) || !Number.isFinite(expiresAt) || effectiveAt > at || (requireCurrent && expiresAt <= at)) {
      providerNativeModelFailure("PROVIDER_NATIVE_MODEL_AUTHORITY_STALE", "approved native pricing snapshot is not currently effective");
    }
    return snapshot;
  }

  function assertPreparedCurrent(preparation: ProviderNativeModelPreparationV1, currentAt: number) {
    if (Date.parse(preparation.preparation_expires_at) <= currentAt) {
      providerNativeModelFailure("PROVIDER_NATIVE_MODEL_AUTHORITY_STALE", "native model preparation has expired");
    }
  }

  async function finishObserved(input: ProviderNativeQualificationAttemptIdentityV1): Promise<ProviderNativeModelSelectionV1> {
    const preparation = await store.readPreparation({ preparation_ref: input.preparation_ref, preparation_sha256: input.preparation_sha256 });
    const observation = await store.readObservation(input);
    if (preparation === null || observation === null) {
      providerNativeModelFailure("PROVIDER_NATIVE_MODEL_QUALIFICATION_UNKNOWN", "native call observation is not durably available; provider retry is forbidden");
    }
    await assertProviderNativeModelProbeBinding(preparation);
    await readPricing(preparationInput(preparation), Date.parse(observation.verified_at), false);
    const bundle = await createProviderNativeModelCandidateProofBundle({
      preparation,
      preparation_ref: input.preparation_ref,
      preparation_sha256: input.preparation_sha256,
      observation,
    });
    await store.putCandidateProof({ ...input, bundle });
    const candidate = await store.readCandidate({ candidate_ref: bundle.candidate.candidate_ref, candidate_sha256: bundle.candidate.candidate_sha256 });
    const proof = await store.readProof({ qualification_ref: bundle.proof.qualification_ref, qualification_sha256: bundle.proof.qualification_sha256 });
    if (candidate === null || proof === null) providerNativeModelFailure("PROVIDER_NATIVE_MODEL_STORAGE_UNCERTAIN", "native candidate proof readback is unavailable");
    return selectionFrom(candidate, proof);
  }

  const authority: ProviderNativeModelAuthorityPort = {
    async prepare(rawInput) {
      const input = decodeProviderNativeModelPreparationInput(rawInput);
      const keyBinding = await readKey(input);
      const current = canonicalNow(now);
      const pricing = await readPricing(input, current.milliseconds, true);
      const existing = await store.readPreparationForOperation(input);
      if (existing !== null) {
        const rebuilt = await createProviderNativeModelPreparation({
          input: preparationInput(existing.preparation),
          key_binding: keyBinding,
          prepared_at: existing.preparation.prepared_at,
          preparation_expires_at: existing.preparation.preparation_expires_at,
        });
        if (rebuilt.request_sha256 !== existing.preparation.request_sha256 ||
            rebuilt.preparation_json !== canonicalModelGatewayJson(existing.preparation) ||
            pricing.snapshot_sha256 !== existing.preparation.pricing_snapshot_sha256) {
          providerNativeModelFailure("PROVIDER_NATIVE_MODEL_CONFLICT", "owner operation already has a different native preparation");
        }
        assertPreparedCurrent(existing.preparation, current.milliseconds);
        return receipt(existing);
      }
      const expiresAt = new Date(current.milliseconds + prepTtl).toISOString();
      const created = await createProviderNativeModelPreparation({
        input,
        key_binding: keyBinding,
        prepared_at: current.value,
        preparation_expires_at: expiresAt,
      });
      if (Date.parse(pricing.expires_at) < Date.parse(expiresAt)) {
        providerNativeModelFailure("PROVIDER_NATIVE_MODEL_AUTHORITY_STALE", "native preparation would outlive its approved pricing snapshot");
      }
      await store.putPreparation({
        preparation_ref: created.preparation_ref,
        preparation_sha256: created.preparation_sha256,
        preparation_json: created.preparation_json,
        preparation: created.preparation,
        request_sha256: created.request_sha256,
      });
      const persisted = await store.readPreparation({ preparation_ref: created.preparation_ref, preparation_sha256: created.preparation_sha256 });
      if (persisted === null || canonicalModelGatewayJson(persisted) !== canonicalModelGatewayJson(created.preparation)) {
        providerNativeModelFailure("PROVIDER_NATIVE_MODEL_STORAGE_UNCERTAIN", "native preparation readback does not match its immutable bytes");
      }
      return created.receipt;
    },

    async qualify(rawInput) {
      if (rawInput === null || typeof rawInput !== "object" ||
          typeof rawInput.executor?.executeOnce !== "function") {
        providerNativeModelFailure("PROVIDER_NATIVE_MODEL_INPUT_INVALID", "native qualification executor is unavailable");
      }
      const input: ProviderNativeQualificationRequestV1 = rawInput;
      const identity: ProviderNativeQualificationAttemptIdentityV1 = {
        owner_ref: input.owner_ref,
        project_id: input.project_id,
        owner_operation_id: input.owner_operation_id,
        stage: input.stage,
        preparation_ref: input.preparation_ref,
        preparation_sha256: input.preparation_sha256,
      };
      if (!OPERATION_ID.test(identity.owner_operation_id)) providerNativeModelFailure("PROVIDER_NATIVE_MODEL_INPUT_INVALID", "native qualification operation ID is invalid");
      const preparation = await store.readPreparation({ preparation_ref: identity.preparation_ref, preparation_sha256: identity.preparation_sha256 });
      if (preparation === null || preparation.owner_ref !== identity.owner_ref || preparation.project_id !== identity.project_id ||
          preparation.owner_operation_id !== identity.owner_operation_id || preparation.stage !== identity.stage) {
        providerNativeModelFailure("PROVIDER_NATIVE_MODEL_AUTHORITY_STALE", "native qualification request does not match its preparation");
      }
      const current = canonicalNow(now);
      assertPreparedCurrent(preparation, current.milliseconds);
      const preparedInput = preparationInput(preparation);
      await assertProviderNativeModelProbeBinding(preparation);
      await readKey(preparedInput);
      await readPricing(preparedInput, current.milliseconds, true);
      const state = await store.claimQualification(identity);
      if (state === "COMPLETED") {
        const readback = await store.readQualificationOperation(identity);
        if (readback.status !== "COMPLETED" || readback.candidate_ref === undefined || readback.candidate_sha256 === undefined ||
            readback.qualification_ref === undefined || readback.qualification_sha256 === undefined) {
          providerNativeModelFailure("PROVIDER_NATIVE_MODEL_STORAGE_UNCERTAIN", "completed native qualification lacks exact refs");
        }
        const candidate = await store.readCandidate({ candidate_ref: readback.candidate_ref, candidate_sha256: readback.candidate_sha256 });
        const proof = await store.readProof({ qualification_ref: readback.qualification_ref, qualification_sha256: readback.qualification_sha256 });
        if (candidate === null || proof === null) providerNativeModelFailure("PROVIDER_NATIVE_MODEL_STORAGE_UNCERTAIN", "completed native qualification evidence is missing");
        return selectionFrom(candidate, proof);
      }
      if (state === "OBSERVED") return finishObserved(identity);
      if (state !== "CLAIMED") {
        providerNativeModelFailure("PROVIDER_NATIVE_MODEL_QUALIFICATION_UNKNOWN", "native qualification is already claimed; provider retry is forbidden");
      }
      try {
        const currentBinding = await readKey(preparedInput);
        if (canonicalModelGatewayJson(currentBinding) !== canonicalModelGatewayJson(preparation.key_binding)) {
          providerNativeModelFailure("PROVIDER_NATIVE_MODEL_AUTHORITY_STALE", "provider key changed after the one-shot claim; execution is not repeated");
        }
        const execution = await input.executor.executeOnce(Object.freeze({
          preparation_ref: identity.preparation_ref,
          preparation_sha256: identity.preparation_sha256,
          preparation,
        }));
        const observed = canonicalNow(now);
        const postExecutionBinding = await readKey(preparedInput);
        if (canonicalModelGatewayJson(postExecutionBinding) !== canonicalModelGatewayJson(preparation.key_binding)) {
          providerNativeModelFailure("PROVIDER_NATIVE_MODEL_AUTHORITY_STALE", "provider key changed during qualification; its result cannot be promoted");
        }
        const snapshot = await readPricing(preparedInput, observed.milliseconds, false);
        const expiry = Math.min(observed.milliseconds + qualificationTtl, Date.parse(snapshot.expires_at));
        if (!Number.isFinite(expiry) || expiry <= observed.milliseconds) {
          providerNativeModelFailure("PROVIDER_NATIVE_MODEL_AUTHORITY_STALE", "native qualification cannot outlive its approved pricing snapshot");
        }
        const observation = await createProviderNativeModelObservation({
          preparation, preparation_ref: identity.preparation_ref, preparation_sha256: identity.preparation_sha256,
          execution, verified_at: observed.value, expires_at: new Date(expiry).toISOString(),
        });
        await store.putObservation({ ...identity, observation });
      } catch (cause) {
        if (cause instanceof ProviderNativeModelAuthorityError) throw cause;
        providerNativeModelFailure("PROVIDER_NATIVE_MODEL_QUALIFICATION_UNKNOWN", "native provider call outcome is unknown; it will not be repeated", cause);
      }
      return finishObserved(identity);
    },

    async readQualificationOperation(input) {
      return store.readQualificationOperation(input);
    },

    async resolvePinned(raw) {
      if (typeof raw.allow_expired_snapshot_v2 !== "boolean") providerNativeModelFailure("PROVIDER_NATIVE_MODEL_INPUT_INVALID", "native snapshot mode is invalid");
      if (typeof raw.owner_ref !== "string" || raw.owner_ref.length < 1 ||
          typeof raw.project_id !== "string" || raw.project_id.length < 1) {
        providerNativeModelFailure("PROVIDER_NATIVE_MODEL_INPUT_INVALID", "native pinned owner/project identity is invalid");
      }
      const selection = decodeProviderNativeModelSelection(raw.selection);
      const candidate = await store.readCandidate({ candidate_ref: selection.candidate_ref, candidate_sha256: selection.candidate_sha256 });
      const proof = await store.readProof({ qualification_ref: selection.qualification_ref, qualification_sha256: selection.qualification_sha256 });
      if (candidate === null || proof === null || candidate.candidate.candidate_kind !== selection.candidate_kind ||
          proof.qualification.candidate_ref !== selection.candidate_ref || proof.qualification.candidate_sha256 !== selection.candidate_sha256 ||
          proof.qualification.stage !== selection.stage || proof.qualification.route_ref !== selection.route_ref ||
          proof.qualification.route_version !== selection.route_version || candidate.candidate.preparation.stage !== selection.stage ||
          candidate.candidate.preparation.deployment.route_ref !== selection.route_ref ||
          candidate.candidate.preparation.deployment.route_version !== selection.route_version ||
          candidate.candidate.preparation.owner_ref !== raw.owner_ref ||
          candidate.candidate.preparation.project_id !== raw.project_id ||
          canonicalModelGatewayJson(candidate.candidate.preparation.transport_policy) !== canonicalModelGatewayJson(selection.transport_policy)) {
        providerNativeModelFailure("PROVIDER_NATIVE_MODEL_AUTHORITY_STALE", "saved native model selection does not match its pinned candidate and proof");
      }
      const revoked = await store.readRevocation({ qualification_ref: selection.qualification_ref, qualification_sha256: selection.qualification_sha256 });
      if (revoked !== null) providerNativeModelFailure("PROVIDER_NATIVE_MODEL_REVOKED", "saved native model qualification has been revoked");
      const current = canonicalNow(now);
      const qualificationExpiry = Date.parse(proof.qualification.qualification.expires_at);
      if (!raw.allow_expired_snapshot_v2 && qualificationExpiry <= current.milliseconds) {
        providerNativeModelFailure("PROVIDER_NATIVE_MODEL_AUTHORITY_STALE", "saved native qualification has expired");
      }
      const prep = candidate.candidate.preparation;
      const prepInput = preparationInput(prep);
      await assertProviderNativeModelProbeBinding(prep);
      const keyBinding = await readKey(prepInput);
      if (canonicalModelGatewayJson(keyBinding) !== canonicalModelGatewayJson(prep.key_binding)) {
        providerNativeModelFailure("PROVIDER_NATIVE_MODEL_AUTHORITY_STALE", "saved native provider key binding is no longer current");
      }
      const freeOnly = prep.transport_policy.billing.mode === "byok" &&
        prep.transport_policy.billing.free_only === true;
      const pricingSnapshot = await readPricing(
        prepInput,
        current.milliseconds,
        !raw.allow_expired_snapshot_v2 || !freeOnly,
      );
      const attemptIdentity = {
        owner_ref: prep.owner_ref, project_id: prep.project_id, owner_operation_id: prep.owner_operation_id,
        stage: prep.stage, preparation_ref: candidate.candidate.preparation_ref,
        preparation_sha256: candidate.candidate.preparation_sha256,
      };
      const observation = await store.readObservation(attemptIdentity);
      if (observation === null || observation.observation_ref !== candidate.candidate.observation_ref ||
          observation.observation_sha256 !== candidate.candidate.observation_sha256) {
        providerNativeModelFailure("PROVIDER_NATIVE_MODEL_AUTHORITY_STALE", "saved native model observation is missing or mismatched");
      }
      const expected = await createProviderNativeModelCandidateProofBundle({
        preparation: prep, preparation_ref: candidate.candidate.preparation_ref,
        preparation_sha256: candidate.candidate.preparation_sha256, observation,
      });
      if (expected.candidate.candidate_json !== candidate.candidate_json ||
          expected.proof.qualification_json !== proof.qualification_json) {
        providerNativeModelFailure("PROVIDER_NATIVE_MODEL_AUTHORITY_STALE", "saved native candidate or proof differs from the underlying observation");
      }
      return Object.freeze({ selection, candidate, proof, observation, pricing_snapshot: pricingSnapshot });
    },

    async revoke(input) {
      return store.revoke(input);
    },
  };
  return Object.freeze(authority);
}
