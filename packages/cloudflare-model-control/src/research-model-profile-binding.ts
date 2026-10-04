import {
  ScopeSnapshotSchema,
  VersionedRefSchema,
  type ScopeSnapshot,
  type VersionedRef,
} from "@eliotr/contracts";
import { decodeModelRouteDeployment, type ModelRouteDeployment } from "@eliotr/platform-cloudflare";
import { canonicalModelGatewayJson, modelGatewaySha256 } from "@eliotr/cloudflare-ai";
import type { ReferenceManifestPolicyProfile } from "@eliotr/cloudflare-evidence";
import type { PinnedModelSelection } from "./model-gateway-deployment-registry-d1.js";

const SCHEMA = "eliotr.research.model-profile-binding.v1";
const DEFINITION_SCHEMA = "eliotr.research.model-profile-definition.v1";
export const OWNER_MODEL_PROFILE_TEMPLATE_V2_SCHEMA = "eliotr.research.model-profile-definition.v2" as const;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const DEFINITION_KEYS = new Set([
  "config_provenance_ref", "definition_ref", "definition_sha256", "deployment", "expires_at",
  "max_context_bytes", "model_profile_ref", "policy", "schema",
]);
const POLICY_KEYS = new Set([
  "allowed_tool_definition_refs", "allowed_verifier_refs",
  "permitted_anchor_and_precision_ceilings", "provider_and_policy_generations",
  "stale_or_revoked_entries", "permitted_acquisition_or_expansion_routes",
  "disclosure_ceiling", "allowed_use", "expires_at",
]);
const OWNER_POLICY_TEMPLATE_KEYS = new Set([...POLICY_KEYS].filter((key) => key !== "expires_at"));
const OWNER_PROFILE_TEMPLATE_KEYS = new Set([
  "config_provenance_ref", "definition_ref", "definition_sha256", "deployment", "expires_at",
  "max_context_bytes", "model_profile_ref", "policy", "schema",
]);
const STAGE_KEYS = new Set([
  "deployment_generation", "model_profile_ref", "policy_authority_ref", "policy_generation",
  "scope_snapshot_digest", "scope_snapshot_ref",
]);
const CURRENT_KEYS = new Set([...STAGE_KEYS, "deployment_state", "policy_state", "scope_snapshot", "state",
  "grant_expires_at", "run_budget_expires_at_ms"]);

export type ModelProfileBindingErrorCode =
  | "MODEL_PROFILE_BINDING_INPUT_INVALID"
  | "MODEL_PROFILE_BINDING_CONFIG_MISSING"
  | "MODEL_PROFILE_BINDING_CONFIG_INVALID"
  | "MODEL_PROFILE_BINDING_AUTHORITY_STALE"
  | "MODEL_PROFILE_BINDING_DEPLOYMENT_MISSING"
  | "MODEL_PROFILE_BINDING_DEPLOYMENT_MISMATCH"
  | "MODEL_PROFILE_BINDING_EXPIRED";

export class ModelProfileBindingError extends Error {
  public readonly code: ModelProfileBindingErrorCode;
  public readonly retryable: boolean;

  public constructor(code: ModelProfileBindingErrorCode, message: string, retryable = false, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ModelProfileBindingError";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface ModelProfileBinding {
  readonly schema: typeof SCHEMA;
  readonly binding_ref: VersionedRef;
  readonly binding_sha256: string;
  readonly definition_ref: VersionedRef;
  readonly definition_sha256: string;
  readonly config_provenance_ref: string;
  readonly model_profile_ref: string;
  readonly policy_authority_ref: string;
  readonly policy_generation: string;
  readonly deployment_generation: string;
  readonly scope_snapshot_ref: VersionedRef;
  readonly scope_snapshot_digest: string;
  readonly expires_at: string;
  readonly max_context_bytes: number;
  readonly deployment: ModelRouteDeployment;
  readonly policy: ReferenceManifestPolicyProfile;
}

export interface ModelProfileDefinition {
  readonly schema: typeof DEFINITION_SCHEMA;
  readonly definition_ref: VersionedRef;
  readonly definition_sha256: string;
  readonly config_provenance_ref: string;
  readonly model_profile_ref: string;
  readonly expires_at: string;
  readonly max_context_bytes: number;
  readonly deployment: ModelRouteDeployment;
  readonly policy: ReferenceManifestPolicyProfile;
}

export type OwnerModelProfilePolicyTemplate = Omit<ReferenceManifestPolicyProfile, "expires_at">;
export interface OwnerModelProfileTemplateV2 {
  readonly schema: typeof OWNER_MODEL_PROFILE_TEMPLATE_V2_SCHEMA;
  readonly definition_ref: VersionedRef;
  readonly definition_sha256: string;
  readonly config_provenance_ref: string;
  readonly model_profile_ref: string;
  readonly expires_at?: string;
  readonly max_context_bytes: number;
  readonly deployment: ModelRouteDeployment;
  readonly policy: OwnerModelProfilePolicyTemplate;
}
export type OwnerModelProfileTemplateV2Input = Omit<OwnerModelProfileTemplateV2,
  "schema" | "definition_ref" | "definition_sha256">;

/** Explicit operator choices; identity fields are computed from their canonical bytes. */
export type ModelProfileDefinitionInput = Omit<ModelProfileDefinition,
  "schema" | "definition_ref" | "definition_sha256">;

export async function createModelProfileDefinition(input: ModelProfileDefinitionInput): Promise<ModelProfileDefinition> {
  const material = definitionMaterial({ ...input, schema: DEFINITION_SCHEMA });
  const sha256 = await modelGatewaySha256(canonicalModelGatewayJson(material));
  return await decodeDefinition({
    ...material,
    definition_sha256: sha256,
    definition_ref: { id: `eliotr.research.model-profile-definition-${sha256}`, revision: 1 },
  }, input.config_provenance_ref) as ModelProfileDefinition;
}

function ownerPolicyTemplate(value: unknown): OwnerModelProfilePolicyTemplate {
  const code: ModelProfileBindingErrorCode = "MODEL_PROFILE_BINDING_CONFIG_INVALID";
  const record = plainObject(value, OWNER_POLICY_TEMPLATE_KEYS, "owner model profile policy template", code);
  if (typeof record.provider_and_policy_generations !== "object" || record.provider_and_policy_generations === null ||
      Array.isArray(record.provider_and_policy_generations)) fail(code, "provider_and_policy_generations must be a plain object");
  const generations = record.provider_and_policy_generations as Record<string, unknown>;
  const generationPrototype = Object.getPrototypeOf(generations);
  if (generationPrototype !== Object.prototype && generationPrototype !== null) fail(code, "provider_and_policy_generations must be a plain object");
  return Object.freeze({
    allowed_tool_definition_refs: stringList(record.allowed_tool_definition_refs, "allowed_tool_definition_refs", code),
    allowed_verifier_refs: stringList(record.allowed_verifier_refs, "allowed_verifier_refs", code),
    permitted_anchor_and_precision_ceilings: stringList(record.permitted_anchor_and_precision_ceilings, "permitted_anchor_and_precision_ceilings", code),
    provider_and_policy_generations: Object.freeze(Object.fromEntries(Object.entries(generations).map(([key, generation]) => [
      identifier(key, "provider/policy generation key", code), identifier(generation, "provider/policy generation", code),
    ]))),
    ...(record.stale_or_revoked_entries === undefined ? {} : {
      stale_or_revoked_entries: stringList(record.stale_or_revoked_entries, "stale or revoked entries", code),
    }),
    permitted_acquisition_or_expansion_routes: stringList(record.permitted_acquisition_or_expansion_routes, "acquisition routes", code),
    disclosure_ceiling: identifier(record.disclosure_ceiling, "disclosure_ceiling", code),
    allowed_use: stringList(record.allowed_use, "allowed_use", code),
  });
}

function ownerProfileTemplateMaterial(input: OwnerModelProfileTemplateV2Input): Record<string, unknown> {
  return {
    schema: OWNER_MODEL_PROFILE_TEMPLATE_V2_SCHEMA,
    config_provenance_ref: input.config_provenance_ref,
    model_profile_ref: input.model_profile_ref,
    ...(input.expires_at === undefined ? {} : { expires_at: input.expires_at }),
    max_context_bytes: input.max_context_bytes,
    deployment: input.deployment,
    policy: input.policy,
  };
}

/** Compile permanent owner model/profile settings without manufacturing a TTL. */
export async function createOwnerModelProfileTemplateV2(
  input: OwnerModelProfileTemplateV2Input,
): Promise<OwnerModelProfileTemplateV2> {
  const provenance = identifier(input.config_provenance_ref, "model profile provenance", "MODEL_PROFILE_BINDING_CONFIG_INVALID");
  const profile = identifier(input.model_profile_ref, "model profile", "MODEL_PROFILE_BINDING_CONFIG_INVALID");
  const contextBytesValue = contextBytes(input.max_context_bytes, "max_context_bytes", "MODEL_PROFILE_BINDING_CONFIG_INVALID");
  const deployment = decodeModelRouteDeployment(input.deployment);
  const policy = ownerPolicyTemplate(input.policy);
  const expires = input.expires_at === undefined ? undefined : iso(input.expires_at, "owner profile expiry", "MODEL_PROFILE_BINDING_CONFIG_INVALID");
  const material = ownerProfileTemplateMaterial({
    config_provenance_ref: provenance, model_profile_ref: profile,
    ...(expires === undefined ? {} : { expires_at: expires }),
    max_context_bytes: contextBytesValue, deployment, policy,
  });
  const sha256 = await modelGatewaySha256(canonicalModelGatewayJson(material));
  return readOwnerModelProfileTemplateV2({
    ...material,
    definition_sha256: sha256,
    definition_ref: { id: `eliotr.research.model-profile-definition-${sha256}`, revision: 1 },
  }, provenance);
}

export async function readOwnerModelProfileTemplateV2(
  raw: unknown,
  provenanceRef: string,
): Promise<OwnerModelProfileTemplateV2> {
  const code: ModelProfileBindingErrorCode = "MODEL_PROFILE_BINDING_CONFIG_INVALID";
  const value = plainObject(raw, OWNER_PROFILE_TEMPLATE_KEYS, "owner model profile template", code);
  if (value.schema !== OWNER_MODEL_PROFILE_TEMPLATE_V2_SCHEMA || value.config_provenance_ref !== provenanceRef) {
    fail(code, "owner model profile template schema or provenance is invalid");
  }
  const definitionRef = versionedRef(value.definition_ref, "definition_ref", code);
  if (definitionRef.revision !== 1) fail(code, "owner profile template revision is unsupported");
  const definitionSha = digest(value.definition_sha256, "definition_sha256", code);
  const profileRef = identifier(value.model_profile_ref, "model_profile_ref", code);
  const maxContextBytes = contextBytes(value.max_context_bytes, "max_context_bytes", code);
  const deployment = decodeModelRouteDeployment(value.deployment);
  const policy = ownerPolicyTemplate(value.policy);
  const expiresAt = value.expires_at === undefined ? undefined : iso(value.expires_at, "owner profile expiry", code);
  const material = ownerProfileTemplateMaterial({
    config_provenance_ref: provenanceRef, model_profile_ref: profileRef,
    ...(expiresAt === undefined ? {} : { expires_at: expiresAt }),
    max_context_bytes: maxContextBytes, deployment, policy,
  });
  if (await modelGatewaySha256(canonicalModelGatewayJson(material)) !== definitionSha ||
      definitionRef.id !== `eliotr.research.model-profile-definition-${definitionSha}`) {
    fail(code, "owner model profile template digest or reference does not match its canonical bytes");
  }
  return Object.freeze({
    schema: OWNER_MODEL_PROFILE_TEMPLATE_V2_SCHEMA,
    definition_ref: definitionRef,
    definition_sha256: definitionSha,
    config_provenance_ref: provenanceRef,
    model_profile_ref: profileRef,
    ...(expiresAt === undefined ? {} : { expires_at: expiresAt }),
    max_context_bytes: maxContextBytes,
    deployment,
    policy,
  });
}

export interface ModelProfileBindingSource {
  /** This reader returns stable server-owned profile definitions, never request data. */
  readonly provenance_ref: string;
  readonly read: (modelProfileRef: string) => Promise<unknown | null>;
}

export interface ModelProfileStageAuthority {
  /** This object must be loaded from the persisted W1/stage-0 readback. */
  readonly model_profile_ref: string;
  readonly policy_generation: string;
  readonly policy_authority_ref: string;
  readonly deployment_generation: string;
  readonly scope_snapshot_ref: VersionedRef;
  readonly scope_snapshot_digest: string;
}

export interface ModelProfileCurrentAuthority extends ModelProfileStageAuthority {
  readonly scope_snapshot: ScopeSnapshot;
  readonly grant_expires_at?: string;
  /** Current monotone W2 attempt deadline; not a reusable or refreshable lease. */
  readonly run_budget_expires_at_ms?: number;
  readonly policy_state: "ACTIVE";
  readonly deployment_state: "ACTIVE";
  readonly state: "ACTIVE";
}

export interface ModelProfileBindingProducerInput {
  readonly source: ModelProfileBindingSource;
  readonly readCurrentAuthority: () => Promise<ModelProfileCurrentAuthority>;
  readonly routeAuthority: {
    resolve(routeRef: string): Promise<unknown | null>;
    resolvePinned?(deployment: ModelRouteDeployment, selection: PinnedModelSelection,
      options?: Readonly<{ allow_expired_qualification?: boolean }>): Promise<unknown | null>;
  };
  readonly run_configuration?: Readonly<{
    readonly mode: "legacy-installed" | "snapshot-v1" | "snapshot-v2";
    readonly configuration_ref: string;
    readonly configuration_sha256: string;
    readonly model_selections?: readonly (PinnedModelSelection & { readonly stage: string })[];
  }>;
  readonly now?: () => number;
}

export interface ResolvedModelProfileBinding {
  readonly binding: ModelProfileBinding;
  readonly deployment: ModelRouteDeployment;
  readonly policy: ReferenceManifestPolicyProfile;
  readonly scope_snapshot: ScopeSnapshot;
}

function fail(code: ModelProfileBindingErrorCode, message: string, retryable = false, cause?: unknown): never {
  throw new ModelProfileBindingError(code, message, retryable, cause);
}

function plainObject(value: unknown, keys: ReadonlySet<string>, label: string, code: ModelProfileBindingErrorCode): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(code, `${label} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code, `${label} must be a plain object`);
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!keys.has(key)) fail(code, `${label} contains unsupported field ${key}`);
  return record;
}

function identifier(value: unknown, label: string, code: ModelProfileBindingErrorCode): string {
  if (typeof value !== "string" || !ID.test(value)) fail(code, `${label} is invalid`);
  return value;
}

function digest(value: unknown, label: string, code: ModelProfileBindingErrorCode): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail(code, `${label} is invalid`);
  return value;
}

function versionedRef(value: unknown, label: string, code: ModelProfileBindingErrorCode): VersionedRef {
  const parsed = VersionedRefSchema.safeParse(value);
  if (!parsed.success) fail(code, `${label} is invalid`);
  return Object.freeze({ id: identifier(parsed.data.id, `${label}.id`, code), revision: parsed.data.revision });
}

function iso(value: unknown, label: string, code: ModelProfileBindingErrorCode): string {
  if (typeof value !== "string") fail(code, `${label} is invalid`);
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) fail(code, `${label} is not canonical UTC time`);
  return value;
}

function contextBytes(value: unknown, label: string, code: ModelProfileBindingErrorCode): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    fail(code, `${label} must be a positive safe integer`);
  }
  return value;
}

function stringList(value: unknown, label: string, code: ModelProfileBindingErrorCode): readonly string[] {
  if (!Array.isArray(value)) fail(code, `${label} must be an array`);
  const values = value.map((item) => identifier(item, label, code));
  if (new Set(values).size !== values.length) fail(code, `${label} contains duplicates`);
  return Object.freeze([...values]);
}

function policy(value: unknown, code: ModelProfileBindingErrorCode): ReferenceManifestPolicyProfile {
  const record = plainObject(value, POLICY_KEYS, "model profile policy", code);
  if (typeof record.provider_and_policy_generations !== "object" || record.provider_and_policy_generations === null ||
      Array.isArray(record.provider_and_policy_generations)) fail(code, "provider_and_policy_generations must be a plain object");
  const generations = record.provider_and_policy_generations as Record<string, unknown>;
  const generationPrototype = Object.getPrototypeOf(generations);
  if (generationPrototype !== Object.prototype && generationPrototype !== null) fail(code, "provider_and_policy_generations must be a plain object");
  const generationEntries = Object.entries(generations).map(([key, generation]) => [
    identifier(key, "provider/policy generation key", code),
    identifier(generation, "provider/policy generation", code),
  ] as const);
  const result: ReferenceManifestPolicyProfile = {
    allowed_tool_definition_refs: stringList(record.allowed_tool_definition_refs, "allowed_tool_definition_refs", code),
    allowed_verifier_refs: stringList(record.allowed_verifier_refs, "allowed_verifier_refs", code),
    permitted_anchor_and_precision_ceilings: stringList(record.permitted_anchor_and_precision_ceilings, "permitted_anchor_and_precision_ceilings", code),
    provider_and_policy_generations: Object.freeze(Object.fromEntries(generationEntries)),
    permitted_acquisition_or_expansion_routes: stringList(record.permitted_acquisition_or_expansion_routes, "permitted_acquisition_or_expansion_routes", code),
    disclosure_ceiling: identifier(record.disclosure_ceiling, "disclosure_ceiling", code),
    allowed_use: stringList(record.allowed_use, "allowed_use", code),
    expires_at: iso(record.expires_at, "policy.expires_at", code),
  };
  if (record.stale_or_revoked_entries !== undefined) {
    return Object.freeze({ ...result, stale_or_revoked_entries: stringList(record.stale_or_revoked_entries, "stale_or_revoked_entries", code) });
  }
  return Object.freeze(result);
}

function definitionMaterial(definition: Omit<ModelProfileDefinition, "definition_ref" | "definition_sha256">): Record<string, unknown> {
  return {
    schema: definition.schema,
    config_provenance_ref: definition.config_provenance_ref,
    model_profile_ref: definition.model_profile_ref,
    max_context_bytes: definition.max_context_bytes,
    expires_at: definition.expires_at,
    deployment: definition.deployment,
    policy: definition.policy,
  };
}

function bindingMaterial(binding: Omit<ModelProfileBinding, "binding_ref" | "binding_sha256">): Record<string, unknown> {
  return {
    schema: binding.schema,
    config_provenance_ref: binding.config_provenance_ref,
    definition_ref: binding.definition_ref,
    definition_sha256: binding.definition_sha256,
    model_profile_ref: binding.model_profile_ref,
    policy_authority_ref: binding.policy_authority_ref,
    policy_generation: binding.policy_generation,
    deployment_generation: binding.deployment_generation,
    scope_snapshot_ref: binding.scope_snapshot_ref,
    scope_snapshot_digest: binding.scope_snapshot_digest,
    expires_at: binding.expires_at,
    max_context_bytes: binding.max_context_bytes,
    deployment: binding.deployment,
    policy: binding.policy,
  };
}

async function decodeDefinition(raw: unknown, provenanceRef: string): Promise<ModelProfileDefinition | OwnerModelProfileTemplateV2> {
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw) &&
      (raw as Record<string, unknown>).schema === OWNER_MODEL_PROFILE_TEMPLATE_V2_SCHEMA) {
    return readOwnerModelProfileTemplateV2(raw, provenanceRef);
  }
  const value = plainObject(raw, DEFINITION_KEYS, "model profile definition", "MODEL_PROFILE_BINDING_CONFIG_INVALID");
  if (value.schema !== DEFINITION_SCHEMA) fail("MODEL_PROFILE_BINDING_CONFIG_INVALID", "model profile definition schema is unsupported");
  if (value.config_provenance_ref !== provenanceRef) fail("MODEL_PROFILE_BINDING_CONFIG_INVALID", "binding provenance does not match the server-owned source");
  const definitionRef = versionedRef(value.definition_ref, "definition_ref", "MODEL_PROFILE_BINDING_CONFIG_INVALID");
  if (definitionRef.revision !== 1) fail("MODEL_PROFILE_BINDING_CONFIG_INVALID", "definition revision is unsupported");
  const profileRef = identifier(value.model_profile_ref, "model_profile_ref", "MODEL_PROFILE_BINDING_CONFIG_INVALID");
  const maxContextBytes = contextBytes(value.max_context_bytes, "max_context_bytes", "MODEL_PROFILE_BINDING_CONFIG_INVALID");
  const expiresAt = iso(value.expires_at, "expires_at", "MODEL_PROFILE_BINDING_CONFIG_INVALID");
  let deployment: ModelRouteDeployment;
  try { deployment = decodeModelRouteDeployment(value.deployment); }
  catch (cause) { fail("MODEL_PROFILE_BINDING_CONFIG_INVALID", "model profile deployment is invalid", false, cause); }
  const bindingPolicy = policy(value.policy, "MODEL_PROFILE_BINDING_CONFIG_INVALID");
  if (bindingPolicy.expires_at !== expiresAt) fail("MODEL_PROFILE_BINDING_CONFIG_INVALID", "binding and policy expiry differ");
  const material = definitionMaterial({ schema: DEFINITION_SCHEMA, config_provenance_ref: provenanceRef, model_profile_ref: profileRef, max_context_bytes: maxContextBytes, expires_at: expiresAt, deployment, policy: bindingPolicy });
  const definitionSha = digest(value.definition_sha256, "definition_sha256", "MODEL_PROFILE_BINDING_CONFIG_INVALID");
  const actualSha = await modelGatewaySha256(canonicalModelGatewayJson(material));
  if (actualSha !== definitionSha || definitionRef.id !== `eliotr.research.model-profile-definition-${definitionSha}`) fail("MODEL_PROFILE_BINDING_CONFIG_INVALID", "definition digest or reference does not match its canonical bytes");
  return Object.freeze({ ...material, definition_ref: definitionRef, definition_sha256: definitionSha } as ModelProfileDefinition);
}

async function resolvedBinding(definition: ModelProfileDefinition, authority: ModelProfileCurrentAuthority): Promise<ModelProfileBinding> {
  const material = bindingMaterial({
    schema: SCHEMA,
    config_provenance_ref: definition.config_provenance_ref,
    definition_ref: definition.definition_ref,
    definition_sha256: definition.definition_sha256,
    model_profile_ref: definition.model_profile_ref,
    max_context_bytes: definition.max_context_bytes,
    policy_authority_ref: authority.policy_authority_ref,
    policy_generation: authority.policy_generation,
    deployment_generation: authority.deployment_generation,
    scope_snapshot_ref: authority.scope_snapshot_ref,
    scope_snapshot_digest: authority.scope_snapshot_digest,
    expires_at: definition.expires_at,
    deployment: definition.deployment,
    policy: definition.policy,
  });
  const bindingSha = await modelGatewaySha256(canonicalModelGatewayJson(material));
  const bindingRef = { id: `eliotr.research.model-profile-binding-${bindingSha}`, revision: 1 } satisfies VersionedRef;
  return Object.freeze({ ...material, binding_ref: Object.freeze(bindingRef), binding_sha256: bindingSha } as ModelProfileBinding);
}

function assertStageCurrent(stage: ModelProfileStageAuthority, current: ModelProfileCurrentAuthority): void {
  if (stage.model_profile_ref !== current.model_profile_ref || stage.policy_generation !== current.policy_generation ||
      stage.policy_authority_ref !== current.policy_authority_ref || stage.deployment_generation !== current.deployment_generation ||
      stage.scope_snapshot_ref.id !== current.scope_snapshot_ref.id || stage.scope_snapshot_ref.revision !== current.scope_snapshot_ref.revision ||
      stage.scope_snapshot_digest !== current.scope_snapshot_digest) fail("MODEL_PROFILE_BINDING_AUTHORITY_STALE", "persisted workflow authority changed before model profile resolution");
}

function stageFields(value: unknown, label: string, code: ModelProfileBindingErrorCode): ModelProfileStageAuthority {
  const record = plainObject(value, STAGE_KEYS, label, code);
  return Object.freeze({
    model_profile_ref: identifier(record.model_profile_ref, `${label}.model_profile_ref`, code),
    policy_generation: identifier(record.policy_generation, `${label}.policy_generation`, code),
    policy_authority_ref: identifier(record.policy_authority_ref, `${label}.policy_authority_ref`, code),
    deployment_generation: identifier(record.deployment_generation, `${label}.deployment_generation`, code),
    scope_snapshot_ref: versionedRef(record.scope_snapshot_ref, `${label}.scope_snapshot_ref`, code),
    scope_snapshot_digest: digest(record.scope_snapshot_digest, `${label}.scope_snapshot_digest`, code),
  });
}

function currentAuthority(value: unknown): ModelProfileCurrentAuthority {
  const record = plainObject(value, CURRENT_KEYS, "current model profile authority", "MODEL_PROFILE_BINDING_AUTHORITY_STALE");
  if (record.state !== "ACTIVE" || record.policy_state !== "ACTIVE" || record.deployment_state !== "ACTIVE") fail("MODEL_PROFILE_BINDING_AUTHORITY_STALE", "current research authority is not active");
  const fields = stageFields({
    model_profile_ref: record.model_profile_ref,
    policy_generation: record.policy_generation,
    policy_authority_ref: record.policy_authority_ref,
    deployment_generation: record.deployment_generation,
    scope_snapshot_ref: record.scope_snapshot_ref,
    scope_snapshot_digest: record.scope_snapshot_digest,
  }, "current model profile authority", "MODEL_PROFILE_BINDING_AUTHORITY_STALE");
  const parsed = ScopeSnapshotSchema.safeParse(record.scope_snapshot);
  if (!parsed.success) fail("MODEL_PROFILE_BINDING_AUTHORITY_STALE", "current scope snapshot is invalid");
  const grantExpiry = record.grant_expires_at === undefined ? undefined : iso(
    record.grant_expires_at, "current grant expiry", "MODEL_PROFILE_BINDING_AUTHORITY_STALE",
  );
  const runBudgetExpiry = record.run_budget_expires_at_ms === undefined ? undefined : record.run_budget_expires_at_ms;
  if (runBudgetExpiry !== undefined && (!Number.isSafeInteger(runBudgetExpiry) || (runBudgetExpiry as number) < 1)) {
    fail("MODEL_PROFILE_BINDING_AUTHORITY_STALE", "current workflow budget expiry is invalid");
  }
  return Object.freeze({ ...fields, state: "ACTIVE", policy_state: "ACTIVE", deployment_state: "ACTIVE",
    scope_snapshot: parsed.data, ...(grantExpiry === undefined ? {} : { grant_expires_at: grantExpiry }),
    ...(runBudgetExpiry === undefined ? {} : { run_budget_expires_at_ms: runBudgetExpiry as number }) });
}

async function normalizeOwnerProfileTemplateV2(
  template: OwnerModelProfileTemplateV2,
  authority: ModelProfileCurrentAuthority,
  now: number,
): Promise<ModelProfileDefinition> {
  if (authority.grant_expires_at === undefined || authority.run_budget_expires_at_ms === undefined) {
    fail("MODEL_PROFILE_BINDING_AUTHORITY_STALE", "current grant or W2 budget deadline is unavailable");
  }
  const expires = Math.min(
    template.expires_at === undefined ? Number.POSITIVE_INFINITY : Date.parse(template.expires_at),
    Date.parse(authority.scope_snapshot.expires_at),
    Date.parse(authority.grant_expires_at),
    authority.run_budget_expires_at_ms,
  );
  if (!Number.isFinite(expires) || expires <= now) fail("MODEL_PROFILE_BINDING_EXPIRED", "owner profile or current run authority has expired");
  const expiresAt = new Date(expires).toISOString();
  return createModelProfileDefinition({
    config_provenance_ref: template.config_provenance_ref,
    model_profile_ref: template.model_profile_ref,
    expires_at: expiresAt,
    max_context_bytes: template.max_context_bytes,
    deployment: template.deployment,
    policy: Object.freeze({ ...template.policy, expires_at: expiresAt }),
  });
}

function selectionForProfile(input: ModelProfileBindingProducerInput, deployment: ModelRouteDeployment): PinnedModelSelection {
  const runConfiguration = input.run_configuration;
  if ((runConfiguration?.mode !== "snapshot-v1" && runConfiguration?.mode !== "snapshot-v2") ||
      runConfiguration.model_selections === undefined) {
    fail("MODEL_PROFILE_BINDING_AUTHORITY_STALE", "snapshot model profile requires an immutable run configuration selection");
  }
  if (!/^rrc-[a-f0-9]{24}$/u.test(runConfiguration.configuration_ref) || !/^[a-f0-9]{64}$/u.test(runConfiguration.configuration_sha256)) {
    fail("MODEL_PROFILE_BINDING_AUTHORITY_STALE", "run configuration identity is invalid");
  }
  const matches = runConfiguration.model_selections.filter((selection) => selection.stage === "SYNTHESIZE");
  if (matches.length !== 1) fail("MODEL_PROFILE_BINDING_AUTHORITY_STALE", "run configuration has no unique synthesis model selection");
  const selection = matches[0];
  if (selection === undefined) fail("MODEL_PROFILE_BINDING_AUTHORITY_STALE", "run configuration has no unique synthesis model selection");
  if (selection.route_ref !== deployment.route_ref || selection.route_version !== deployment.route_version) {
    fail("MODEL_PROFILE_BINDING_DEPLOYMENT_MISMATCH", "pinned synthesis selection differs from model profile deployment");
  }
  return selection;
}

function assertCurrent(binding: ModelProfileBinding, current: ModelProfileCurrentAuthority, now: number): void {
  const authority = currentAuthority(current);
  if (authority.model_profile_ref !== binding.model_profile_ref || authority.policy_generation !== binding.policy_generation ||
      authority.policy_authority_ref !== binding.policy_authority_ref || authority.deployment_generation !== binding.deployment_generation ||
      authority.scope_snapshot_ref.id !== binding.scope_snapshot_ref.id || authority.scope_snapshot_ref.revision !== binding.scope_snapshot_ref.revision ||
      authority.scope_snapshot_digest !== binding.scope_snapshot_digest) fail("MODEL_PROFILE_BINDING_AUTHORITY_STALE", "model profile binding differs from current workflow authority");
  const parsed = ScopeSnapshotSchema.safeParse(authority.scope_snapshot);
  if (!parsed.success || parsed.data.snapshot_id !== binding.scope_snapshot_ref.id || parsed.data.revision !== binding.scope_snapshot_ref.revision ||
      parsed.data.digest !== binding.scope_snapshot_digest || parsed.data.policy_authority_ref !== binding.policy_authority_ref) {
    fail("MODEL_PROFILE_BINDING_AUTHORITY_STALE", "current scope snapshot does not match the binding");
  }
  if (Date.parse(parsed.data.expires_at) <= now) fail("MODEL_PROFILE_BINDING_EXPIRED", "scope snapshot is expired");
  if (Date.parse(binding.expires_at) <= now) fail("MODEL_PROFILE_BINDING_EXPIRED", "model profile definition is expired");
}

export function createModelProfileBindingProducer(input: ModelProfileBindingProducerInput) {
  if (typeof input.source !== "object" || input.source === null || typeof input.source.read !== "function" ||
      typeof input.source.provenance_ref !== "string" || !ID.test(input.source.provenance_ref) ||
      typeof input.readCurrentAuthority !== "function" || typeof input.routeAuthority?.resolve !== "function") {
    fail("MODEL_PROFILE_BINDING_INPUT_INVALID", "model profile binding producer dependencies are invalid");
  }
  const now = input.now ?? (() => Date.now());
  return Object.freeze({
    async resolve(stage: ModelProfileStageAuthority): Promise<ResolvedModelProfileBinding> {
      const nowMs = now();
      if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) fail("MODEL_PROFILE_BINDING_INPUT_INVALID", "binding clock is invalid");
      const parsedStage = stageFields(stage, "stage model profile authority", "MODEL_PROFILE_BINDING_INPUT_INVALID");
      const profileRef = parsedStage.model_profile_ref;
      const raw = await input.source.read(profileRef);
      if (raw === null) fail("MODEL_PROFILE_BINDING_CONFIG_MISSING", "server-owned model profile binding is unavailable");
      const decodedDefinition = await decodeDefinition(raw, input.source.provenance_ref);
      if (decodedDefinition.model_profile_ref !== parsedStage.model_profile_ref) fail("MODEL_PROFILE_BINDING_AUTHORITY_STALE", "model profile definition differs from persisted workflow profile");
      const first = currentAuthority(await input.readCurrentAuthority());
      assertStageCurrent(parsedStage, first);
      const v2Template = decodedDefinition.schema === OWNER_MODEL_PROFILE_TEMPLATE_V2_SCHEMA ? decodedDefinition : null;
      if (input.run_configuration?.mode === "snapshot-v2" && v2Template === null) {
        fail("MODEL_PROFILE_BINDING_CONFIG_INVALID", "snapshot-v2 runs require the version 2 owner model profile");
      }
      if (input.run_configuration?.mode !== "snapshot-v2" && v2Template !== null) {
        fail("MODEL_PROFILE_BINDING_CONFIG_INVALID", "version 2 owner model profile requires a snapshot-v2 run");
      }
      const definition = v2Template === null
        ? decodedDefinition as ModelProfileDefinition
        : await normalizeOwnerProfileTemplateV2(v2Template, first, nowMs);
      const binding = await resolvedBinding(definition, first);
      assertCurrent(binding, first, nowMs);
      let rawDeployment: unknown | null;
      try {
        const runMode = input.run_configuration?.mode;
        const isSnapshot = runMode === "snapshot-v1" || runMode === "snapshot-v2";
        rawDeployment = !isSnapshot
          ? await input.routeAuthority.resolve(definition.deployment.route_ref)
          : await (input.routeAuthority.resolvePinned?.(definition.deployment, selectionForProfile(input, definition.deployment), {
              allow_expired_qualification: runMode === "snapshot-v2",
            }) ??
            Promise.reject(new Error("pinned model resolver is unavailable")));
      }
      catch (cause) { fail("MODEL_PROFILE_BINDING_DEPLOYMENT_MISSING", "approved model deployment could not be read", true, cause); }
      if (rawDeployment === null) fail("MODEL_PROFILE_BINDING_DEPLOYMENT_MISSING", "approved model deployment is unavailable");
      let deployment: ModelRouteDeployment;
      try { deployment = decodeModelRouteDeployment(rawDeployment); }
      catch (cause) { fail("MODEL_PROFILE_BINDING_DEPLOYMENT_MISMATCH", "approved model deployment is malformed", false, cause); }
      if (canonicalModelGatewayJson(deployment) !== canonicalModelGatewayJson(binding.deployment)) fail("MODEL_PROFILE_BINDING_DEPLOYMENT_MISMATCH", "approved model deployment differs from server-owned binding");
      const second = currentAuthority(await input.readCurrentAuthority());
      assertStageCurrent(parsedStage, second);
      const finalNow = now();
      if (typeof finalNow !== "number" || !Number.isFinite(finalNow)) fail("MODEL_PROFILE_BINDING_INPUT_INVALID", "binding clock is invalid");
      assertCurrent(binding, second, finalNow);
      if (canonicalModelGatewayJson(first) !== canonicalModelGatewayJson(second)) fail("MODEL_PROFILE_BINDING_AUTHORITY_STALE", "research authority changed during model profile resolution");
      return Object.freeze({ binding, deployment, policy: binding.policy, scope_snapshot: second.scope_snapshot });
    },
  });
}

export const MODEL_PROFILE_BINDING_SCHEMA = SCHEMA;
