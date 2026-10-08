import { fail as failWorkflow } from "@eliotr/cloudflare-workflows";
import type { ResearchModelGatewayRuntimeConfig } from "@eliotr/cloudflare-model-control";
import type {
  ResearchSemanticAuditPrompt,
  ResearchSemanticCompositionDependencies,
  ResearchSemanticSynthesisPrompt,
} from "./research-semantic-composition-contract.js";

function inputInvalid(message: string): never {
  void message;
  failWorkflow("WORKFLOW_INPUT_INVALID");
}

function configurationMissing(message: string): never {
  void message;
  failWorkflow("WORKFLOW_CONFIGURATION_MISSING");
}

function configurationInvalid(message: string): never {
  void message;
  failWorkflow("WORKFLOW_CONFIGURATION_INVALID");
}

function qualificationStale(message: string): never {
  void message;
  failWorkflow("WORKFLOW_QUALIFICATION_STALE");
}

function requireObject(value: unknown, label: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) inputInvalid(label);
}

function requireFunction(value: unknown, label: string): void {
  if (value === undefined) configurationMissing(label);
  if (typeof value !== "function") configurationInvalid(label);
}

function validateSynthesisPrompt(prompt: ResearchSemanticSynthesisPrompt): void {
  const hasInstalledParameters = prompt.trusted_parameters !== undefined;
  const hasManifestOverride = prompt.manifest_service !== undefined;
  const hasManifestInputOverride = prompt.build_manifest_input !== undefined;
  const hasParametersOverride = prompt.resolve_trusted_parameters !== undefined;
  if (hasInstalledParameters) {
    if (hasManifestOverride || hasManifestInputOverride || hasParametersOverride) {
      inputInvalid("model.synthesis.prompt mixes installed parameters with explicit compiler overrides");
    }
    requireObject(prompt.trusted_parameters, "model.synthesis.prompt.trusted_parameters");
    return;
  }
  requireFunction(prompt.build_manifest_input, "model.synthesis.prompt.build_manifest_input");
  requireFunction(prompt.resolve_trusted_parameters, "model.synthesis.prompt.resolve_trusted_parameters");
  if (prompt.manifest_service !== undefined) {
    requireFunction(prompt.manifest_service.buildAndPersist, "model.synthesis.prompt.manifest_service.buildAndPersist");
  }
}

function validateAuditPrompt(prompt: ResearchSemanticAuditPrompt): void {
  const hasInstalledParameters = prompt.trusted_parameters !== undefined;
  const hasManifestOverride = prompt.manifest_service !== undefined;
  const hasManifestInputOverride = prompt.build_manifest_input !== undefined;
  const hasParametersOverride = prompt.resolve_trusted_parameters !== undefined;
  if (hasInstalledParameters) {
    if (hasManifestOverride || hasManifestInputOverride || hasParametersOverride) {
      inputInvalid("model.audit.prompt mixes installed parameters with explicit compiler overrides");
    }
    requireObject(prompt.trusted_parameters, "model.audit.prompt.trusted_parameters");
    return;
  }
  requireFunction(prompt.build_manifest_input, "model.audit.prompt.build_manifest_input");
  requireFunction(prompt.resolve_trusted_parameters, "model.audit.prompt.resolve_trusted_parameters");
  if (prompt.manifest_service !== undefined) {
    requireFunction(prompt.manifest_service.buildAndPersist, "model.audit.prompt.manifest_service.buildAndPersist");
  }
}

function requireGateway(value: ResearchModelGatewayRuntimeConfig, label: string): void {
  if (value === undefined) configurationMissing(`${label}.reasoning_gateway_base_url`);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    configurationInvalid(`${label} must be an object`);
  }
  if (value.reasoning_gateway_base_url === undefined || value.reasoning_gateway_base_url === "") {
    configurationMissing(`${label}.reasoning_gateway_base_url`);
  }
  if (typeof value.reasoning_gateway_base_url !== "string") configurationInvalid(`${label}.reasoning_gateway_base_url`);
  const hasToken = Object.prototype.hasOwnProperty.call(value, "gateway_token");
  const hasBinding = Object.prototype.hasOwnProperty.call(value, "ai_gateway_binding");
  if (!hasToken && !hasBinding) configurationMissing(`${label} must select one server-owned gateway transport`);
  if (hasToken && hasBinding) configurationInvalid(`${label} must select one server-owned gateway transport`);
  if (hasToken && value.gateway_token === undefined) configurationMissing(`${label}.gateway_token`);
  if (hasBinding && value.ai_gateway_binding === undefined) configurationMissing(`${label}.ai_gateway_binding`);
  if (hasBinding && (value.ai_gateway_binding === null || typeof value.ai_gateway_binding !== "object" || Array.isArray(value.ai_gateway_binding))) {
    configurationInvalid(`${label}.ai_gateway_binding`);
  }
}

export function validateResearchSemanticCompositionDependencies(input: ResearchSemanticCompositionDependencies): void {
  if (input === null || typeof input !== "object") inputInvalid("dependencies");
  requireObject(input.navigation, "navigation");
  requireObject(input.navigation.scope, "navigation.scope");
  requireObject(input.navigation.access, "navigation.access");
  requireObject(input.principal, "principal");
  requireObject(input.retrieval_profile, "retrieval_profile");
  requireObject(input.model_profile, "model_profile");
  requireObject(input.manifest, "manifest");
  requireObject(input.manifest.residency_template, "manifest.residency_template");
  requireObject(input.model, "model");
  requireObject(input.model.synthesis, "model.synthesis");
  requireObject(input.model.synthesis.prompt, "model.synthesis.prompt");
  validateSynthesisPrompt(input.model.synthesis.prompt);
  requireObject(input.model.audit, "model.audit");
  requireObject(input.model.audit.prompt, "model.audit.prompt");
  validateAuditPrompt(input.model.audit.prompt);
  if (input.run_configuration !== undefined && input.run_configuration.mode !== "legacy-installed" &&
      (input.model.synthesis.prompt.request_capabilities === undefined ||
       input.model.audit.prompt.request_capabilities === undefined)) {
    configurationMissing("selected-model request capabilities are required by the immutable run configuration");
  }
  const nativeSelections = input.run_configuration?.model_selections?.filter((selection) =>
    selection.candidate_kind === "provider-native-v1") ?? [];
  if (nativeSelections.length > 0) {
    if (input.run_configuration?.mode !== "snapshot-v2") {
      configurationInvalid("Native model selections require snapshot-v2 owner/project authority");
    }
    if (input.run_configuration.project_owner_ref === undefined || input.run_configuration.project_owner_ref === null ||
        input.run_configuration.project_id === undefined || input.run_configuration.project_id === null ||
        input.native_model_authority === undefined) {
      configurationMissing("Native model selections require snapshot-v2 owner/project authority");
    }
    if (typeof input.run_configuration.project_owner_ref !== "string" || input.run_configuration.project_owner_ref.length === 0 ||
        typeof input.run_configuration.project_id !== "string" || input.run_configuration.project_id.length === 0) {
      configurationInvalid("Native model selections require snapshot-v2 owner/project authority");
    }
  }
  if (input.native_model_authority !== undefined && input.model.roles !== undefined &&
      input.model.roles.pricing_for_stage === undefined) {
    configurationMissing("Native branch execution requires stage-specific model pricing");
  }
  requireObject(input.verification, "verification");
  requireObject(input.verification.config, "verification.config");
  requireObject(input.audit, "audit");
  requireObject(input.audit.normalization, "audit.normalization");
  requireObject(input.audit.verifier, "audit.verifier");
  requireObject(input.audit.verifier.authority, "audit.verifier.authority");
  requireFunction(input.navigation?.current, "navigation.current");
  requireFunction(input.navigation?.sources, "navigation.sources");
  requireFunction(input.ledger?.read, "ledger.read");
  requireFunction(input.recheck_authority, "recheck_authority");
  if (input.manifest?.store !== undefined) requireFunction(input.manifest.store.get, "manifest.store.get");
  if (input.manifest?.store_factory !== undefined) requireFunction(input.manifest.store_factory.create, "manifest.store_factory.create");
  if (input.manifest.residency_template.scope_domain_id !== input.navigation.scope.snapshot_id ||
      input.manifest.residency_template.access_domain_id !== input.principal.principal_ref) {
    inputInvalid("manifest residency is outside the pinned scope or principal");
  }
  if (!Number.isSafeInteger(input.manifest.max_context_bytes) ||
      input.manifest.max_context_bytes < 1 || input.manifest.max_context_bytes > 64 * 1024) {
    inputInvalid("manifest.max_context_bytes is outside the freeze bound");
  }
  if (input.navigation.access.principal_ref !== input.principal.principal_ref ||
      input.navigation.access.credential_generation !== input.principal.credential_generation) {
    inputInvalid("navigation access does not match the server principal");
  }
  if (input.model_profile.raw === undefined) configurationMissing("model_profile.raw");
  if (typeof input.model_profile.raw !== "string") configurationInvalid("model_profile.raw");
  if (input.model_profile.raw.trim() === "") configurationMissing("model_profile.raw");
  if (typeof input.model_profile.provenance_ref !== "string" || input.model_profile.provenance_ref.length === 0) {
    inputInvalid("model_profile.provenance_ref");
  }
  if (input.deployment_environment === undefined) configurationMissing("deployment_environment");
  if (typeof input.deployment_environment !== "string") configurationInvalid("deployment_environment");
  if (input.deployment_environment !== "TEST" && input.deployment_environment !== "PRODUCTION") {
    configurationInvalid("deployment_environment");
  }
  if (input.now !== undefined && typeof input.now !== "function") configurationInvalid("now");

  requireGateway(input.model.synthesis.gateway, "model.synthesis.gateway");
  requireGateway(input.model.audit.gateway, "model.audit.gateway");
  if (input.model.synthesis.pricing !== undefined) {
    if (typeof input.model.synthesis.pricing.quote !== "function") configurationInvalid("model.synthesis.pricing.quote");
  }
  requireFunction(input.model.synthesis.spend_authorization?.read, "model.synthesis.spend_authorization.read");
  requireFunction(input.model.synthesis.prepare, "model.synthesis.prepare");
  if (input.model.audit.pricing !== undefined) {
    if (typeof input.model.audit.pricing.quote !== "function") configurationInvalid("model.audit.pricing.quote");
  }
  requireFunction(input.model.audit.spend_authorization?.read, "model.audit.spend_authorization.read");
  requireFunction(input.model.audit.prepare, "model.audit.prepare");
  requireFunction(input.audit.verifier?.read_current, "audit.verifier.read_current");
  if (input.audit.verifier.authority.qualified !== true || input.audit.verifier.authority.current !== true) {
    qualificationStale("audit.verifier must be currently qualified");
  }
}
