import {
  ModelProfileBindingError,
  createModelProfileBindingProducer,
  type ModelProfileBindingProducerInput,
  type ModelProfileCurrentAuthority,
  type ModelProfileBindingSource,
} from "./research-model-profile-binding.js";
import { canonicalEvidenceJson } from "@eliotr/cloudflare-evidence";
import type { NavigationReadAuthority } from "@eliotr/cloudflare-evidence";
import type { WorkflowPrincipal } from "@eliotr/cloudflare-workflows";

/** The Worker configuration binding consumed by the server-owned profile source. */
export const MODEL_PROFILE_DEFINITION_JSON_ENV = "ELIOTR_MODEL_PROFILE_DEFINITION_JSON" as const;

export interface ModelProfileDefinitionConfigSourceOptions {
  /** The raw value of MODEL_PROFILE_DEFINITION_JSON_ENV, if installed. */
  readonly raw: string | undefined;
  /** The server-owned provenance label expected by the strict profile producer. */
  readonly provenance_ref: string;
}

export interface PersistedModelProfileAuthorityReaderOptions {
  readonly database: D1Database;
  readonly navigation: NavigationReadAuthority;
  readonly operation_id: string;
  readonly investigation_id: string;
  readonly principal: Pick<WorkflowPrincipal, "principal_ref" | "credential_generation" | "deployment_generation">;
}

interface StoredModelProfileAuthorityRow {
  readonly operation_id: unknown;
  readonly investigation_id: unknown;
  readonly state: unknown;
  readonly principal_ref: unknown;
  readonly credential_generation: unknown;
  readonly deployment_generation: unknown;
  readonly policy_generation: unknown;
  readonly policy_authority_ref: unknown;
  readonly scope_snapshot_id: unknown;
  readonly scope_snapshot_revision: unknown;
  readonly current_revision: unknown;
  readonly ledger_revision: unknown;
  readonly model_profile_ref: unknown;
}

interface ModelProfileAuthorityRow {
  readonly operation_id: string;
  readonly investigation_id: string;
  readonly state: "ACTIVE";
  readonly principal_ref: string;
  readonly credential_generation: string;
  readonly deployment_generation: string;
  readonly policy_generation: string;
  readonly policy_authority_ref: string;
  readonly scope_snapshot_id: string;
  readonly scope_snapshot_revision: number;
  readonly current_revision: number;
  readonly ledger_revision: number;
  readonly model_profile_ref: string;
}

function authorityStale(message: string, cause?: unknown): never {
  throw new ModelProfileBindingError("MODEL_PROFILE_BINDING_AUTHORITY_STALE", message, true, cause);
}

function authorityInput(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256) {
    throw new ModelProfileBindingError("MODEL_PROFILE_BINDING_INPUT_INVALID", `${label} is invalid`);
  }
  return value;
}

function authorityRevision(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 1_000_000) {
    authorityStale(`${label} is invalid`);
  }
  return value as number;
}

function decodeAuthorityRow(row: StoredModelProfileAuthorityRow | null, input: PersistedModelProfileAuthorityReaderOptions): ModelProfileAuthorityRow {
  if (row === null) authorityStale("persisted workflow authority is unavailable");
  const decoded: ModelProfileAuthorityRow = {
    operation_id: authorityInput(row.operation_id, "workflow operation"),
    investigation_id: authorityInput(row.investigation_id, "workflow investigation"),
    state: row.state === "ACTIVE" ? "ACTIVE" : authorityStale("workflow is not active"),
    principal_ref: authorityInput(row.principal_ref, "workflow principal"),
    credential_generation: authorityInput(row.credential_generation, "workflow credential generation"),
    deployment_generation: authorityInput(row.deployment_generation, "workflow deployment generation"),
    policy_generation: authorityInput(row.policy_generation, "workflow policy generation"),
    policy_authority_ref: authorityInput(row.policy_authority_ref, "workflow policy authority"),
    scope_snapshot_id: authorityInput(row.scope_snapshot_id, "workflow scope snapshot"),
    scope_snapshot_revision: authorityRevision(row.scope_snapshot_revision, "workflow scope revision"),
    current_revision: authorityRevision(row.current_revision, "workflow current revision"),
    ledger_revision: authorityRevision(row.ledger_revision, "ledger revision"),
    model_profile_ref: authorityInput(row.model_profile_ref, "workflow model profile"),
  };
  if (decoded.operation_id !== input.operation_id || decoded.investigation_id !== input.investigation_id ||
      decoded.principal_ref !== input.principal.principal_ref ||
      decoded.credential_generation !== input.principal.credential_generation ||
      decoded.deployment_generation !== input.principal.deployment_generation ||
      decoded.current_revision !== decoded.ledger_revision) {
    authorityStale("persisted workflow authority does not match the requested owner run");
  }
  return Object.freeze(decoded);
}

function sameAuthorityRow(left: ModelProfileAuthorityRow, right: ModelProfileAuthorityRow): boolean {
  return left.operation_id === right.operation_id && left.investigation_id === right.investigation_id &&
    left.state === right.state && left.principal_ref === right.principal_ref &&
    left.credential_generation === right.credential_generation && left.deployment_generation === right.deployment_generation &&
    left.policy_generation === right.policy_generation && left.policy_authority_ref === right.policy_authority_ref &&
    left.scope_snapshot_id === right.scope_snapshot_id && left.scope_snapshot_revision === right.scope_snapshot_revision &&
    left.current_revision === right.current_revision && left.ledger_revision === right.ledger_revision &&
    left.model_profile_ref === right.model_profile_ref;
}

async function readPersistedAuthorityRow(input: PersistedModelProfileAuthorityReaderOptions): Promise<ModelProfileAuthorityRow> {
  let row: StoredModelProfileAuthorityRow | null;
  try {
    row = await input.database.prepare(
      "SELECT r.operation_id, r.investigation_id, r.state, r.principal_ref, r.credential_generation, " +
      "r.deployment_generation, r.policy_generation, r.policy_authority_ref, r.scope_snapshot_id, " +
      "r.scope_snapshot_revision, r.current_revision, r.ledger_revision, h.model_profile_ref " +
      "FROM research_workflow_current r JOIN investigation_ledger_head h " +
      "ON h.investigation_id = r.investigation_id " +
      "WHERE r.operation_id = ?1 AND r.investigation_id = ?2 AND r.principal_ref = ?3 LIMIT 1",
    ).bind(input.operation_id, input.investigation_id, input.principal.principal_ref).first<StoredModelProfileAuthorityRow>();
  } catch (cause) {
    authorityStale("persisted workflow authority could not be read", cause);
  }
  return decodeAuthorityRow(row, input);
}

/**
 * Reads the owner-bound current W1/workflow authority used by the strict
 * profile producer. The navigation read is performed on both sides of the
 * durable read, and the durable row itself is read twice, so a scope/grant or
 * workflow/head change cannot be hidden by a successful first query.
 */
export function createPersistedModelProfileCurrentAuthorityReader(
  input: PersistedModelProfileAuthorityReaderOptions,
): () => Promise<ModelProfileCurrentAuthority> {
  if (typeof input !== "object" || input === null || typeof input.database?.prepare !== "function" ||
      typeof input.navigation?.current !== "function" || typeof input.principal !== "object" || input.principal === null) {
    throw new ModelProfileBindingError("MODEL_PROFILE_BINDING_INPUT_INVALID", "model profile authority reader dependencies are invalid");
  }
  authorityInput(input.operation_id, "workflow operation");
  authorityInput(input.investigation_id, "workflow investigation");
  authorityInput(input.principal.principal_ref, "authority principal");
  authorityInput(input.principal.credential_generation, "authority credential generation");
  authorityInput(input.principal.deployment_generation, "authority deployment generation");
  return async () => {
    let before: Awaited<ReturnType<NavigationReadAuthority["current"]>>;
    try {
      before = await input.navigation.current();
    } catch (cause) {
      authorityStale("navigation authority is no longer current", cause);
    }
    const first = await readPersistedAuthorityRow(input);
    if (input.navigation.scope.snapshot_id !== first.scope_snapshot_id ||
        input.navigation.scope.revision !== first.scope_snapshot_revision ||
        input.navigation.scope.policy_authority_ref !== first.policy_authority_ref ||
        input.navigation.access.principal_ref !== first.principal_ref ||
        input.navigation.access.credential_generation !== first.credential_generation) {
      authorityStale("navigation authority does not match the persisted workflow");
    }
    if (before.policy_authority_ref !== first.policy_authority_ref || !before.allowed_use.includes("research")) {
      authorityStale("navigation grant does not match the persisted research authority");
    }
    const second = await readPersistedAuthorityRow(input);
    let after: Awaited<ReturnType<NavigationReadAuthority["current"]>>;
    try {
      after = await input.navigation.current();
    } catch (cause) {
      authorityStale("navigation authority changed during model profile read", cause);
    }
    if (!sameAuthorityRow(first, second) ||
        after.policy_authority_ref !== second.policy_authority_ref || !after.allowed_use.includes("research") ||
        canonicalEvidenceJson(before) !== canonicalEvidenceJson(after)) {
      authorityStale("research authority changed during model profile read");
    }
    return Object.freeze({
      model_profile_ref: second.model_profile_ref,
      policy_generation: second.policy_generation,
      policy_authority_ref: second.policy_authority_ref,
      deployment_generation: second.deployment_generation,
      scope_snapshot_ref: Object.freeze({ id: second.scope_snapshot_id, revision: second.scope_snapshot_revision }),
      scope_snapshot_digest: input.navigation.scope.digest,
      scope_snapshot: input.navigation.scope,
      policy_state: "ACTIVE" as const,
      deployment_state: "ACTIVE" as const,
      state: "ACTIVE" as const,
    });
  };
}

export interface PersistedModelProfileBindingProducerOptions extends Omit<ModelProfileBindingProducerInput, "source" | "readCurrentAuthority"> {
  readonly config: ModelProfileDefinitionConfigSourceOptions;
  readonly authority: PersistedModelProfileAuthorityReaderOptions;
}

/** Composes the installed definition, durable authority reader, and route registry. */
export function createPersistedModelProfileBindingProducer(
  input: PersistedModelProfileBindingProducerOptions,
) {
  const { config, authority: authorityOptions, ...producerInput } = input;
  const authority = createPersistedModelProfileCurrentAuthorityReader(authorityOptions);
  return createModelProfileBindingProducer({
    ...producerInput,
    source: createModelProfileBindingConfigSource(config),
    readCurrentAuthority: authority,
  });
}

function invalid(message: string, cause?: unknown): never {
  throw new ModelProfileBindingError(
    "MODEL_PROFILE_BINDING_CONFIG_INVALID",
    message,
    false,
    cause,
  );
}

function source(provenanceRef: string, read: ModelProfileBindingSource["read"]): ModelProfileBindingSource {
  return Object.freeze({ provenance_ref: provenanceRef, read });
}

/**
 * Creates the single-definition source used by the production profile producer.
 * Structural and digest validation remains in createModelProfileBindingProducer;
 * this adapter only decodes the explicitly installed Worker configuration.
 */
export function createModelProfileBindingConfigSource(
  options: ModelProfileDefinitionConfigSourceOptions,
): ModelProfileBindingSource {
  if (typeof options !== "object" || options === null || typeof options.provenance_ref !== "string" ||
      options.provenance_ref.length === 0) {
    invalid("model profile configuration provenance is invalid");
  }
  if (options.raw === undefined) {
    return source(options.provenance_ref, async () => null);
  }
  if (typeof options.raw !== "string") {
    invalid("model profile configuration must be a JSON string");
  }
  if (options.raw.trim() === "") {
    return source(options.provenance_ref, async () => null);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(options.raw);
  } catch (cause) {
    invalid("model profile configuration is not valid JSON", cause);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    invalid("model profile configuration must contain one definition object");
  }
  const serialized = JSON.stringify(parsed);
  if (serialized === undefined) invalid("model profile configuration cannot be serialized");
  return source(options.provenance_ref, async (requestedRef) => {
    // A Worker has one installed definition. The strict producer compares its
    // profile reference and all other fields against the persisted stage.
    void requestedRef;
    return JSON.parse(serialized) as unknown;
  });
}
