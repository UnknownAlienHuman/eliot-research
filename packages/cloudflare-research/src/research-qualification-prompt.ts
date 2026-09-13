import { z } from "zod";
import {
  ModelGatewayExecutionError,
  canonicalModelGatewayJson,
  parseDynamicRouteQualificationProbeInput,
  type ModelCallInput,
  type ModelGatewayPromptCompilerPort,
  type DynamicRouteQualificationProbeInput,
} from "@eliotr/cloudflare-ai";
import {
  createCloudflareEvidenceResolver,
  createD1EvidenceAuthorityPort,
  createNavigationReadAuthority,
  createR2EvidenceContentPort,
} from "@eliotr/cloudflare-evidence";
import {
  IdentifierSchema,
  IsoDateTimeSchema,
  ObjectResidencyKeySchema,
  VersionedRefSchema,
  type VersionedRef,
} from "@eliotr/contracts";
import { createD1ScopePorts } from "@eliotr/retrieval";
import type { ModelRouteDeployment } from "@eliotr/platform-cloudflare";
import type { ReferenceManifestStore } from "@eliotr/policy";
import {
  createResearchReferenceManifestService,
  type BuildReferenceManifestInput,
  type ReferenceManifestPolicyProfile,
  type ResearchReferenceManifestService,
} from "./research-reference-manifest.js";
import { createResearchModelPromptCompiler, type TrustedModelPromptParameters } from "./research-model-prompt.js";
import { createResearchQualificationManifestStore } from "./research-qualification-manifest-store.js";

const PolicySchema = z.object({
  allowed_tool_definition_refs: z.array(IdentifierSchema),
  allowed_verifier_refs: z.array(IdentifierSchema),
  permitted_anchor_and_precision_ceilings: z.array(IdentifierSchema),
  provider_and_policy_generations: z.record(IdentifierSchema, IdentifierSchema),
  stale_or_revoked_entries: z.array(IdentifierSchema).optional(),
  permitted_acquisition_or_expansion_routes: z.array(IdentifierSchema),
  disclosure_ceiling: IdentifierSchema,
  allowed_use: z.array(IdentifierSchema),
  expires_at: IsoDateTimeSchema,
}).strict();

const TrustedParametersSchema = z.object({
  prompt: z.string().min(1),
  max_tokens: z.number().int().positive().safe(),
  response_format: z.unknown().optional(),
  seed: z.number().int().safe().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  temperature: z.number().finite().optional(),
  top_p: z.number().finite().optional(),
}).strict();

const QualificationPromptConfigSchema = z.object({
  access: z.object({
    principal_ref: IdentifierSchema,
    client_class: z.literal("owner_pwa"),
    credential_generation: IdentifierSchema,
  }).strict(),
  policy: PolicySchema,
  manifest_ref: VersionedRefSchema,
  manifest_residency_template: ObjectResidencyKeySchema.omit({ content_digest: true }),
  trusted_parameters: TrustedParametersSchema,
  request_timeout_ms: z.number().int().min(1).max(300_000).safe(),
}).strict();

export type ResearchQualificationPromptConfig = z.infer<typeof QualificationPromptConfigSchema>;

export interface ResearchQualificationPromptCompilerInput {
  readonly core_database: D1Database;
  readonly search_database: D1Database;
  readonly evidence_bucket: R2Bucket;
  readonly work_bucket: R2Bucket;
  readonly probe: DynamicRouteQualificationProbeInput;
  readonly config: ResearchQualificationPromptConfig;
  readonly now?: () => number;
}

function invalid(message: string, cause?: unknown): never {
  throw new ModelGatewayExecutionError("MODEL_GATEWAY_REQUEST_INVALID", message, {
    ...(cause === undefined ? {} : { cause }),
  });
}

function compileFailure(message: string, cause?: unknown): never {
  throw new ModelGatewayExecutionError("MODEL_GATEWAY_PROMPT_COMPILE_FAILED", message, {
    ...(cause === undefined ? {} : { cause }),
  });
}

function freezeTree(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) freezeTree(item);
  } else {
    for (const item of Object.values(value)) freezeTree(item);
  }
  return Object.freeze(value);
}

function snapshot<T>(value: T, label: string): T {
  try {
    return freezeTree(JSON.parse(canonicalModelGatewayJson(value))) as T;
  } catch (cause) {
    invalid(`${label} is not canonical JSON`, cause);
  }
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) invalid(`${label} contains duplicate entries`);
}

function parsePolicyConfig(value: ResearchQualificationPromptConfig): void {
  const policy = value.policy;
  unique(policy.allowed_tool_definition_refs, "allowed tool definitions");
  unique(policy.allowed_verifier_refs, "allowed verifiers");
  unique(policy.permitted_anchor_and_precision_ceilings, "precision ceilings");
  unique(policy.stale_or_revoked_entries ?? [], "stale or revoked entries");
  unique(policy.permitted_acquisition_or_expansion_routes, "acquisition routes");
  unique(policy.allowed_use, "allowed use");
}

export function parseResearchQualificationPromptConfig(raw: unknown): ResearchQualificationPromptConfig {
  const parsed = QualificationPromptConfigSchema.safeParse(raw);
  if (!parsed.success) invalid("qualification prompt configuration is invalid");
  parsePolicyConfig(parsed.data);
  return snapshot(parsed.data, "qualification prompt configuration");
}

function nowMilliseconds(clock: () => number): number {
  let value: unknown;
  try { value = clock(); }
  catch (cause) { compileFailure("qualification clock is unavailable", cause); }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    compileFailure("qualification clock is invalid");
  }
  return value;
}

function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function assertNonemptyPack(input: ModelCallInput): void {
  if (input === null || typeof input !== "object" || input.evidence_pack === null ||
      typeof input.evidence_pack !== "object" || !Array.isArray(input.evidence_pack.resolved_evidence) ||
      input.evidence_pack.resolved_evidence.length === 0) {
    invalid("qualification requires a nonempty resolved evidence pack");
  }
}

export async function createResearchQualificationPromptCompiler(
  input: ResearchQualificationPromptCompilerInput,
): Promise<ModelGatewayPromptCompilerPort> {
  const config = parseResearchQualificationPromptConfig(input.config);
  let parsedProbe: ReturnType<typeof parseDynamicRouteQualificationProbeInput>;
  try {
    parsedProbe = parseDynamicRouteQualificationProbeInput(input.probe);
  } catch (cause) {
    invalid("qualification probe input is invalid", cause);
  }
  const probe = snapshot(parsedProbe, "qualification probe input");
  assertNonemptyPack(probe.model_call);
  const expectedModelCall = canonicalModelGatewayJson(probe.model_call);
  const expectedDeployment = canonicalModelGatewayJson(probe.provisioning.deployment);
  const clock = input.now ?? Date.now;

  const evidenceAuthority = createD1EvidenceAuthorityPort({
    core_database: input.core_database,
    search_database: input.search_database,
    now: () => nowMilliseconds(clock),
  });
  const evidenceContent = createR2EvidenceContentPort({ evidence_bucket: input.evidence_bucket });
  const resolver = createCloudflareEvidenceResolver({
    authority: evidenceAuthority,
    content: evidenceContent,
    now: () => nowMilliseconds(clock),
  });
  const scopePorts = createD1ScopePorts(input.core_database, config.access, () => {
    return new Date(nowMilliseconds(clock)).toISOString();
  });

  function assertExactProbeBinding(modelInput: ModelCallInput, deployment: ModelRouteDeployment): void {
    let modelJson: string;
    let deploymentJson: string;
    try {
      modelJson = canonicalModelGatewayJson(modelInput);
      deploymentJson = canonicalModelGatewayJson(deployment);
    } catch (cause) {
      invalid("qualification model input is not canonical JSON", cause);
    }
    if (modelJson !== expectedModelCall || deploymentJson !== expectedDeployment) {
      compileFailure("qualification model input or deployment differs from the prepared probe");
    }
    assertNonemptyPack(modelInput);
  }

  async function navigationFor(modelInput: ModelCallInput) {
    const pack = modelInput.evidence_pack;
    const authority = await evidenceAuthority.loadScope(pack.scope_snapshot_ref);
    if (authority === null) compileFailure("qualification evidence scope is unavailable");
    const scope = authority.snapshot;
    if (!sameRef(pack.scope_snapshot_ref, { id: scope.snapshot_id, revision: scope.revision }) ||
        config.manifest_residency_template.scope_domain_id !== scope.snapshot_id ||
        config.manifest_residency_template.access_domain_id !== config.access.principal_ref) {
      compileFailure("qualification evidence scope is not bound to the configured owner authority");
    }
    return createNavigationReadAuthority({
      database: input.core_database,
      scope_snapshot: scope,
      access: config.access,
      require_current: async (requested) => {
        await scopePorts.requireCurrentScope(requested);
        return requested;
      },
      now: () => nowMilliseconds(clock),
    });
  }

  const manifestService: ResearchReferenceManifestService = {
    async buildAndPersist(request) {
      const store: ReferenceManifestStore = createResearchQualificationManifestStore({
        work_bucket: input.work_bucket,
        navigation: request.navigation,
        residency_template: config.manifest_residency_template,
      });
      return createResearchReferenceManifestService({
        navigation: request.navigation,
        resolver: request.resolver,
        store,
      }).buildAndPersist(request);
    },
  };

  const baseCompiler = createResearchModelPromptCompiler({
    manifest_service: manifestService,
    build_manifest_input: async (
      modelInput: ModelCallInput,
      deployment: ModelRouteDeployment,
    ): Promise<BuildReferenceManifestInput> => {
      assertExactProbeBinding(modelInput, deployment);
      const navigation = await navigationFor(modelInput);
      return Object.freeze({
        evidence_pack: modelInput.evidence_pack,
        navigation,
        resolver,
        policy: config.policy as ReferenceManifestPolicyProfile,
        manifest_ref: config.manifest_ref,
        model_route_ref: deployment.route_ref,
        max_context_bytes: modelInput.max_input_bytes,
      });
    },
    resolve_trusted_parameters: async (
      modelInput: ModelCallInput,
      deployment: ModelRouteDeployment,
    ): Promise<TrustedModelPromptParameters> => {
      assertExactProbeBinding(modelInput, deployment);
      const params = config.trusted_parameters;
      return {
        prompt: params.prompt,
        max_tokens: params.max_tokens,
        ...(params.response_format === undefined ? {} : { response_format: params.response_format }),
        ...(params.seed === undefined ? {} : { seed: params.seed }),
        ...(params.stop === undefined ? {} : { stop: params.stop }),
        ...(params.temperature === undefined ? {} : { temperature: params.temperature }),
        ...(params.top_p === undefined ? {} : { top_p: params.top_p }),
      };
    },
    request_timeout_ms: config.request_timeout_ms,
  });

  return Object.freeze({
    async compile(
      rawModelInput: ModelCallInput,
      rawDeployment: ModelRouteDeployment,
    ) {
      const modelInput = snapshot(rawModelInput, "qualification model input");
      const deployment = snapshot(rawDeployment, "qualification deployment");
      assertExactProbeBinding(modelInput, deployment);
      try {
        return await baseCompiler.compile(modelInput, deployment);
      } catch (cause) {
        if (cause instanceof ModelGatewayExecutionError) throw cause;
        compileFailure("qualification prompt compilation failed", cause);
      }
    },
  });
}
