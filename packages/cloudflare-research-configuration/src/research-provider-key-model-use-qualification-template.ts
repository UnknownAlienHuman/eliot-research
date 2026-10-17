import { canonicalModelGatewayJson, modelGatewaySha256 } from "@eliotr/cloudflare-ai";
import { BranchQueryPlanSchema, IdentifierSchema, Sha256Schema } from "@eliotr/contracts";
import { createResearchSemanticConfigRevisionStore } from "@eliotr/cloudflare-research";
import { evidenceSha256Bytes, evidenceUtf8Bytes } from "@eliotr/cloudflare-evidence";
import { canonicalJson } from "@eliotr/platform-cloudflare";
import { z } from "zod";
import type { SelectedResearchProjectConfiguration } from "./research-project-configuration.js";
import { parseResearchSemanticConfiguration } from "./research-semantic-configuration-schema.js";
import { readResearchOwnerSpendPolicyTemplate } from "@eliotr/cloudflare-research";

export const RESEARCH_PROVIDER_KEY_MODEL_USE_QUALIFICATION_TEMPLATE_PROTOCOL =
  "eliotr.research.provider-key-model-use-qualification-template.v1" as const;
export const RESEARCH_PROVIDER_KEY_MODEL_USE_QUALIFICATION_TEMPLATE_MAX_BYTES = 5_000;

const TemplateSchema = z.object({
  protocol: z.literal(RESEARCH_PROVIDER_KEY_MODEL_USE_QUALIFICATION_TEMPLATE_PROTOCOL),
  project_id: IdentifierSchema,
  provider_id: IdentifierSchema,
  provider_operation_id: IdentifierSchema,
  route_provider_id: IdentifierSchema,
  model_id: IdentifierSchema,
  alias: IdentifierSchema,
  provider_config_id: IdentifierSchema,
  binding_metadata_sha256: Sha256Schema,
  baseline: z.object({
    configuration_ref: z.string().regex(/^rpmc-[a-f0-9]{64}$/u),
    configuration_sha256: Sha256Schema,
    selection_revision: z.number().int().positive().max(1_000_000),
    semantic_revision_ref: z.string().regex(/^scr-[a-f0-9]{12}$/u),
    semantic_config_sha256: Sha256Schema,
  }).strict(),
  semantic_revision_ref: z.string().regex(/^scr-[a-f0-9]{12}$/u),
  semantic_config_sha256: Sha256Schema,
  branch_spend_rules: z.array(z.unknown()).length(2),
  branch_query_budget_profile_json: z.string().min(2).max(2048),
  template_sha256: Sha256Schema,
}).strict();

export type ResearchProviderKeyModelUseQualificationTemplateV1 = z.infer<typeof TemplateSchema>;

export interface ResearchProviderKeyModelUseQualificationTemplateIdentityV1 {
  readonly project_id: string;
  readonly provider_id: string;
  readonly provider_operation_id: string;
  readonly route_provider_id: string;
  readonly model_id: string;
  readonly alias: string;
  readonly provider_config_id: string;
  readonly binding_metadata_sha256: string;
}

export class ResearchProviderKeyModelUseQualificationTemplateError extends Error {
  public constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ResearchProviderKeyModelUseQualificationTemplateError";
  }
}

/** A valid template for another project/model does not affect its existing qualification path. */
export async function researchProviderKeyModelUseQualificationTemplateTargets(input: {
  readonly raw: string;
  readonly project_id: string;
  readonly provider_id: string;
  readonly provider_operation_id: string;
  readonly model_id: string;
}): Promise<boolean> {
  if (new TextEncoder().encode(input.raw).byteLength > RESEARCH_PROVIDER_KEY_MODEL_USE_QUALIFICATION_TEMPLATE_MAX_BYTES) {
    invalid("qualification template exceeds the 5 KB Worker environment-variable limit");
  }
  let value: unknown;
  try { value = JSON.parse(input.raw) as unknown; } catch (cause) { invalid("qualification template is invalid JSON", cause); }
  if (!isRecord(value)) invalid("qualification template must be a JSON object");
  // Establish applicability using only well-typed target identity fields.
  // A malformed one-shot template for another target must not block this request.
  if (typeof value.project_id === "string" && value.project_id !== input.project_id) return false;
  if (typeof value.project_id === "string" && value.project_id === input.project_id) {
    if (typeof value.provider_operation_id === "string" &&
        value.provider_operation_id !== input.provider_operation_id) return false;
    if (typeof value.provider_id === "string" && value.provider_id !== input.provider_id) return false;
    if (typeof value.model_id === "string" && value.model_id !== input.model_id) return false;
  }
  const template = await decodeTemplate(input.raw);
  return template.project_id === input.project_id && template.provider_id === input.provider_id &&
    template.provider_operation_id === input.provider_operation_id && template.model_id === input.model_id;
}

function invalid(message: string, cause?: unknown): never {
  throw new ResearchProviderKeyModelUseQualificationTemplateError(message, cause);
}

function omitDigest(template: ResearchProviderKeyModelUseQualificationTemplateV1): Record<string, unknown> {
  const { template_sha256: _digest, ...identity } = template;
  return identity;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function budgetProfile(raw: string): void {
  let decoded: unknown;
  try { decoded = JSON.parse(raw) as unknown; } catch (cause) { invalid("branch budget profile is invalid JSON", cause); }
  if (canonicalJson(decoded) !== raw || !isRecord(decoded) ||
      decoded.protocol !== "eliotr.research.branch-query-budget-profile.v1" ||
      decoded.profile_id !== "owner-research-existing-bounds-v1" || decoded.profile_generation !== 1 ||
      !isRecord(decoded.budgets)) invalid("branch budget profile is not the approved canonical bounded profile");
  const budgets = decoded.budgets;
  if (budgets.candidate_limit !== 200 || budgets.scan_limit !== 100 || budgets.evidence_limit !== 16 ||
      budgets.max_evidence_bytes !== 65_536 || budgets.max_query_legs !== 1 ||
      !BranchQueryPlanSchema.shape.budgets.safeParse(budgets).success) {
    invalid("branch budget profile exceeds or differs from the approved existing bounds");
  }
}

export function validateResearchProviderKeyModelUseBranchBudgetProfile(raw: string): void {
  budgetProfile(raw);
}

/** Recognize the exact successful four-stage target as an idempotent one-shot-template use. */
export async function researchProviderKeyModelUseQualificationTemplateAlreadyApplied(input: {
  readonly raw: string;
  readonly expected: ResearchProviderKeyModelUseQualificationTemplateIdentityV1;
  readonly selected: SelectedResearchProjectConfiguration | null;
  readonly database: D1Database;
}): Promise<boolean> {
  if (input.selected === null) return false;
  const template = await decodeTemplate(input.raw);
  assertTemplateIdentity(template, input.expected);
  const selected = input.selected;
  if (selected.project_id !== template.project_id ||
      selected.configuration.semantic_revision.revision_ref !== template.semantic_revision_ref ||
      selected.configuration.semantic_revision.config_sha256 !== template.semantic_config_sha256 ||
      selected.configuration.vars.ELIOTR_RESEARCH_BRANCH_QUERY_BUDGET_PROFILE_JSON !==
        template.branch_query_budget_profile_json) return false;

  const revision = await createResearchSemanticConfigRevisionStore(input.database).getRevision(template.semantic_revision_ref);
  const rawSemantic = selected.configuration.vars.ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON;
  if (revision === null || revision.config_sha256 !== template.semantic_config_sha256 ||
      revision.config_json !== rawSemantic ||
      await evidenceSha256Bytes(evidenceUtf8Bytes(rawSemantic)) !== template.semantic_config_sha256) return false;
  try { parseResearchSemanticConfiguration(rawSemantic); } catch { return false; }

  const stageSet = ["ANALYZE_BRANCHES", "COUNTER_SEARCH", "SYNTHESIZE", "AUDIT_CLAIMS"];
  const selections = selected.configuration.model_selections;
  if (selections.length !== stageSet.length || stageSet.some((stage) => !selections.some((entry) =>
      entry.stage === stage && entry.transport_policy.provider === template.route_provider_id &&
      entry.transport_policy.model === template.model_id && entry.transport_policy.billing.mode === "byok" &&
      entry.transport_policy.billing.alias === template.alias))) return false;

  try {
    const spend = readResearchOwnerSpendPolicyTemplate(
      selected.configuration.vars.ELIOTR_MODEL_SPEND_POLICY_JSON,
      selected.configuration.vars.ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF,
    );
    if (spend.rules.length !== 4) return false;
    for (const rawRule of template.branch_spend_rules) {
      if (!isRecord(rawRule) || !isRecord(rawRule.deployment)) return false;
      const selectedRule = spend.rules.find((rule) => rule.stage === rawRule.stage);
      if (selectedRule === undefined || selectedRule.max_input_bytes !== rawRule.max_input_bytes ||
          selectedRule.max_output_bytes !== rawRule.max_output_bytes ||
          selectedRule.deployment.route_ref !== (rawRule.deployment as Record<string, unknown>).route_ref ||
          canonicalModelGatewayJson(selectedRule.quote) !== canonicalModelGatewayJson(rawRule.quote)) return false;
    }
  } catch { return false; }
  return true;
}

/** Parse and authenticate the compact, server-installed template binding. */
export async function parseResearchProviderKeyModelUseQualificationTemplate(input: {
  readonly raw: string;
  readonly expected: ResearchProviderKeyModelUseQualificationTemplateIdentityV1;
  readonly selected: SelectedResearchProjectConfiguration | null;
  readonly database: D1Database;
}): Promise<Readonly<{
  template: ResearchProviderKeyModelUseQualificationTemplateV1;
  semantic_config_json: string;
  branch_query_budget_profile_json: string;
  branch_spend_rules: readonly unknown[];
}>> {
  const template = await decodeTemplate(input.raw);
  const expected = input.expected;
  assertTemplateIdentity(template, expected);
  const selected = input.selected;
  if (selected === null || selected.project_id !== template.project_id ||
      selected.configuration_ref !== template.baseline.configuration_ref ||
      selected.configuration_sha256 !== template.baseline.configuration_sha256 ||
      selected.selection_revision !== template.baseline.selection_revision ||
      selected.configuration.semantic_revision.revision_ref !== template.baseline.semantic_revision_ref ||
      selected.configuration.semantic_revision.config_sha256 !== template.baseline.semantic_config_sha256) {
    invalid("qualification template baseline is stale or the project has no exact selected configuration");
  }
  const oldSelections = selected.configuration.model_selections;
  if (oldSelections.length !== 2 || !["SYNTHESIZE", "AUDIT_CLAIMS"].every((stage) =>
      oldSelections.some((entry) => entry.stage === stage && entry.transport_policy.provider === template.route_provider_id &&
        entry.transport_policy.model === template.model_id && entry.transport_policy.billing.mode === "byok" &&
        entry.transport_policy.billing.alias === template.alias))) {
    invalid("qualification template can upgrade only the exact selected two-stage provider/model baseline");
  }
  if (selected.configuration.vars.ELIOTR_RESEARCH_BRANCH_QUERY_BUDGET_PROFILE_JSON !== undefined) {
    invalid("qualification template only adds the branch budget to a baseline with no selected budget profile");
  }
  budgetProfile(template.branch_query_budget_profile_json);

  const revision = await createResearchSemanticConfigRevisionStore(input.database).getRevision(template.semantic_revision_ref);
  if (revision === null || revision.config_sha256 !== template.semantic_config_sha256 ||
      revision.revision_ref !== `scr-${revision.config_sha256.slice(0, 12)}`) {
    invalid("qualification semantic revision is missing or has a digest mismatch");
  }
  const baselineRaw = selected.configuration.vars.ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON;
  const baselineRevision = await createResearchSemanticConfigRevisionStore(input.database)
    .getRevision(selected.configuration.semantic_revision.revision_ref);
  if (baselineRevision === null || baselineRevision.config_sha256 !== selected.configuration.semantic_revision.config_sha256 ||
      baselineRevision.config_json !== baselineRaw ||
      await evidenceSha256Bytes(evidenceUtf8Bytes(baselineRaw)) !== selected.configuration.semantic_revision.config_sha256) {
    invalid("selected baseline semantic bytes do not match their immutable D1 revision");
  }
  let baselineDecoded: unknown;
  let targetDecoded: unknown;
  try {
    baselineDecoded = JSON.parse(baselineRaw) as unknown;
    targetDecoded = JSON.parse(revision.config_json) as unknown;
  } catch (cause) { invalid("baseline or target semantic configuration is invalid JSON", cause); }
  if (!isRecord(baselineDecoded) || !isRecord(targetDecoded)) invalid("semantic configuration must be an object");
  const { roles: _oldRoles, ...baselineWithoutRoles } = baselineDecoded;
  const { roles, ...targetWithoutRoles } = targetDecoded;
  if (baselineDecoded.roles !== undefined || canonicalJson(baselineWithoutRoles) !== canonicalJson(targetWithoutRoles) || roles === undefined) {
    invalid("target semantic revision must add roles and preserve every existing semantic setting");
  }
  try { parseResearchSemanticConfiguration(revision.config_json); }
  catch (cause) { invalid("target semantic revision does not satisfy the installed semantic schema", cause); }
  const stages = template.branch_spend_rules.map((rule) => isRecord(rule) ? rule.stage : undefined);
  if (stages[0] === stages[1] || !stages.includes("ANALYZE_BRANCHES") || !stages.includes("COUNTER_SEARCH")) {
    invalid("qualification template must add exactly the two branch spend stages");
  }
  const branchRules = template.branch_spend_rules.filter(isRecord);
  if (branchRules.length !== 2 || branchRules.some((rule) =>
      typeof rule.max_input_bytes !== "number" || typeof rule.max_output_bytes !== "number" || !isRecord(rule.quote))) {
    invalid("qualification template branch spend rules are malformed");
  }
  const oldSpendRaw = selected.configuration.vars.ELIOTR_MODEL_SPEND_POLICY_JSON;
  let oldSpend: unknown;
  try { oldSpend = JSON.parse(oldSpendRaw) as unknown; } catch (cause) { invalid("baseline spend policy is invalid", cause); }
  if (!isRecord(oldSpend) || !Array.isArray(oldSpend.rules) || oldSpend.rules.length !== 2 ||
      oldSpend.rules.some((rule) => !isRecord(rule) || !isRecord(rule.quote))) {
    invalid("qualification template requires the existing exact two-rule spend baseline");
  }
  const oldRules = oldSpend.rules as Record<string, unknown>[];
  if (!oldRules.some((rule) => rule.stage === "SYNTHESIZE") || !oldRules.some((rule) => rule.stage === "AUDIT_CLAIMS")) {
    invalid("qualification template baseline must retain exactly the existing SYNTHESIZE/AUDIT spend rules");
  }
  const oldRouteBindings = oldRules.flatMap((rule) => isRecord(rule.deployment) &&
    typeof rule.deployment.route_ref === "string" && typeof rule.deployment.route_version === "string"
    ? [`${rule.deployment.route_ref}\u0000${rule.deployment.route_version}`] : []);
  if (branchRules.some((rule) => !isRecord(rule.deployment) ||
      !oldRouteBindings.includes(`${String(rule.deployment.route_ref)}\u0000${String(rule.deployment.route_version)}`))) {
    invalid("qualification template branch spend rules must reuse an existing exact route binding");
  }
  const byteCaps = (key: "max_input_bytes" | "max_output_bytes") => Math.min(...oldRules.map((rule) =>
    typeof rule[key] === "number" ? rule[key] as number : 0));
  if (branchRules.some((rule) => (rule.max_input_bytes as number) > byteCaps("max_input_bytes") ||
      (rule.max_output_bytes as number) > byteCaps("max_output_bytes"))) {
    invalid("qualification template branch spend rules raise existing stage byte bounds");
  }
  const quoteKeys = ["estimated_model_calls", "estimated_input_tokens", "estimated_output_tokens", "estimated_embedding_tokens",
    "quoted_neurons", "platform_usd", "workers_ai_usd", "byok_usd", "max_total_usd", "workflow_steps",
    "expected_sources", "expected_sections"] as const;
  for (const branch of branchRules) {
    const quote = branch.quote as Record<string, unknown>;
    for (const key of quoteKeys) {
      const oldMaximum = Math.max(...oldRules.map((rule) => {
        const oldQuote = rule.quote as Record<string, unknown>;
        return typeof oldQuote[key] === "number" ? oldQuote[key] as number : 0;
      }));
      if (typeof quote[key] !== "number" || quote[key] > oldMaximum) {
        invalid("qualification template branch spend quote raises an existing approved spend bound");
      }
    }
  }
  try {
    readResearchOwnerSpendPolicyTemplate(canonicalModelGatewayJson({ ...oldSpend,
      rules: [...oldRules, ...template.branch_spend_rules] }),
    selected.configuration.vars.ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF);
  } catch (cause) { invalid("merged qualification spend policy fails the installed spend-template schema", cause); }
  return Object.freeze({ template, semantic_config_json: revision.config_json,
    branch_query_budget_profile_json: template.branch_query_budget_profile_json,
    branch_spend_rules: Object.freeze([...template.branch_spend_rules]) });
}

async function decodeTemplate(raw: string): Promise<ResearchProviderKeyModelUseQualificationTemplateV1> {
  if (new TextEncoder().encode(raw).byteLength > RESEARCH_PROVIDER_KEY_MODEL_USE_QUALIFICATION_TEMPLATE_MAX_BYTES) {
    invalid("qualification template exceeds the 5 KB Worker environment-variable limit");
  }
  let decoded: unknown;
  try { decoded = JSON.parse(raw) as unknown; } catch (cause) { invalid("qualification template is invalid JSON", cause); }
  if (canonicalModelGatewayJson(decoded) !== raw) invalid("qualification template must be canonical JSON");
  const parsed = TemplateSchema.safeParse(decoded);
  if (!parsed.success) invalid("qualification template has an invalid or unsupported shape", parsed.error);
  if (await modelGatewaySha256(canonicalModelGatewayJson(omitDigest(parsed.data))) !== parsed.data.template_sha256) {
    invalid("qualification template digest does not match its canonical contents");
  }
  budgetProfile(parsed.data.branch_query_budget_profile_json);
  return parsed.data;
}

function assertTemplateIdentity(template: ResearchProviderKeyModelUseQualificationTemplateV1,
  expected: ResearchProviderKeyModelUseQualificationTemplateIdentityV1): void {
  if (template.project_id !== expected.project_id || template.provider_id !== expected.provider_id ||
      template.provider_operation_id !== expected.provider_operation_id || template.route_provider_id !== expected.route_provider_id ||
      template.model_id !== expected.model_id || template.alias !== expected.alias ||
      template.provider_config_id !== expected.provider_config_id ||
      template.binding_metadata_sha256 !== expected.binding_metadata_sha256) {
    invalid("qualification template does not match the exact project/provider/model binding");
  }
}
