import { env as generatedEnv } from "cloudflare:test";
import type * as ModelControl from "@eliotr/cloudflare-model-control";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import type { DynamicRouteControlPlanePort, DynamicRouteCreateRequest, DynamicRouteProviderSnapshot } from "@eliotr/cloudflare-ai";
import { canonicalModelGatewayJson, modelGatewaySha256 } from "@eliotr/cloudflare-ai";
import { readResearchOwnerSpendPolicyTemplate, readOwnerModelProfileTemplateV2, createOwnerModelProfileTemplateV2 } from "@eliotr/cloudflare-research";
import type { InstalledNativeResearchConfiguration } from "@eliotr/cloudflare-research-configuration/research-run-configuration.js";
import { createResearchCatalogModelUseComposition } from "../src/research-catalog-model-use-composition.js";
import { createOwnerResearchProjectConfigurationService } from "../src/research-project-configuration-composition.js";
import { resolveResearchSemanticConfig } from "../src/research-semantic-config-revision.js";
import { createNativeUseEnvironment } from "./research-provider-key-model-use-fixture.js";
import { freezeFixture, principal } from "./research-evidence-freeze-fixture.js";
import type { Env } from "../src/env.js";

const seams = vi.hoisted(() => ({ installed: vi.fn(), context: vi.fn(), route: vi.fn(), failures: [] as unknown[], control: {} as DynamicRouteControlPlanePort }));
vi.mock("../src/research-run-configuration.js", async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(), readInstalledNativeResearchRunConfiguration: seams.installed,
}));
vi.mock("../src/research-catalog-native-builtin-context.js", async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(), readNativeBuiltinQualificationContext: seams.context,
  readNativeBuiltinRouteDefinition: seams.route,
}));
vi.mock("@eliotr/cloudflare-ai", async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(), createCloudflareDynamicRouteRestControlPlane: () => seams.control,
}));
vi.mock("@eliotr/cloudflare-model-control", async importOriginal => {
  const actual = await importOriginal<typeof ModelControl>();
  return { ...actual, createResearchModelQualification: (...args: Parameters<typeof actual.createResearchModelQualification>) => {
    const service = actual.createResearchModelQualification(...args);
    return { qualify: async (...probe: Parameters<typeof service.qualify>) => {
      try { return await service.qualify(...probe); }
      catch (cause) { seams.failures.push(cause); throw cause; }
    } };
  } };
});

const DEFAULT = "@cf/zai-org/glm-5.3-flash";
const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const PROJECT = "native-catalog-project";
const OPERATION = "22222222-2222-4222-8222-222222222222";
const ACCOUNT = "a".repeat(32);

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("default Core native catalog flow", () => {
  it("selects a non-default model through real native qualification, D1/R2 proof, project CAS and exact readback", async () => {
    // Only pre-existing baseline/held-context/control-plane data is mocked.
    // New qualification claims, execution, pricing, candidates, import and readback use the real stores/services.
    const frozen = await freezeFixture();
    seams.failures.length = 0;
    const db = frozen.db;
    const owner = principal.principal_ref;
    const created = new Date().toISOString();
    await db.prepare("INSERT INTO project(project_id,title,default_disclosure,retention_policy_ref,default_source_policy_ref," +
      "default_model_profile_ref,default_depth_profile_ref,generation,created_at) VALUES (?1,'Native catalog','private','retention','source','profile','depth',1,?2)")
      .bind(PROJECT, created).run();
    await db.prepare("INSERT INTO project_owner(project_id,principal_ref,deployment_generation,created_at,updated_at) VALUES (?1,?2,?3,?4,?4)")
      .bind(PROJECT, owner, "historical-project-origin", created).run();
    const base = generatedEnv as unknown as Env;
    const env = await createNativeUseEnvironment(owner, db, { ...base, CORE_DB: db,
      DEPLOYMENT_GENERATION: principal.deployment_generation,
      AI_GATEWAY_REASONING_URL: `https://gateway.ai.cloudflare.com/v1/${ACCOUNT}/eliotr-reasoning`,
      ELIOTR_MODEL_PROVIDER_CONTROL_TOKEN: "existing-local-control-authority",
    });
    const semantic = await resolveResearchSemanticConfig({ env, database: db });
    const grant = await frozen.navigation.current();
    const baseProfile = await readOwnerModelProfileTemplateV2(JSON.parse(env.ELIOTR_MODEL_PROFILE_DEFINITION_JSON ?? "{}"),
      env.ELIOTR_MODEL_PROFILE_PROVENANCE_REF ?? "");
    const profile = await createOwnerModelProfileTemplateV2({ config_provenance_ref: baseProfile.config_provenance_ref,
      model_profile_ref: baseProfile.model_profile_ref, max_context_bytes: baseProfile.max_context_bytes, deployment: baseProfile.deployment,
      policy: { ...baseProfile.policy, disclosure_ceiling: grant.disclosure_ceiling } });
    const report = JSON.parse(env.ELIOTR_RESEARCH_REPORT_CONFIG_JSON ?? "{}");
    report.admission_policy.disclosure_ceiling = grant.disclosure_ceiling;
    const spendRaw = env.ELIOTR_MODEL_SPEND_POLICY_JSON;
    const spendRef = env.ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF;
    if (spendRaw === undefined || spendRef === undefined) throw new Error("Missing owner spend fixture");
    const spend = readResearchOwnerSpendPolicyTemplate(spendRaw, spendRef);
    const vars: InstalledNativeResearchConfiguration["vars"] = {
      ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON: semantic.config_json,
      ELIOTR_MODEL_PROFILE_DEFINITION_JSON: canonicalModelGatewayJson(profile),
      ELIOTR_MODEL_PROFILE_PROVENANCE_REF: env.ELIOTR_MODEL_PROFILE_PROVENANCE_REF ?? "",
      ELIOTR_MODEL_SPEND_POLICY_JSON: spendRaw, ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF: spendRef,
      ELIOTR_RESEARCH_REPORT_CONFIG_JSON: canonicalModelGatewayJson(report),
      ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF: env.ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF ?? "",
    };
    seams.installed.mockResolvedValue({ vars, model_selections: spend.rules.map(rule => ({ stage: rule.stage,
      route_ref: rule.deployment.route_ref, route_version: rule.deployment.route_version,
      candidate_ref: `baseline-${rule.stage}`, candidate_sha256: "a".repeat(64), qualification_ref: `baseline-proof-${rule.stage}`,
      qualification_sha256: "b".repeat(64), transport_policy: { version: 1, transport: "cloudflare-ai-gateway", api: "compat-chat-completions",
        provider: "workers-ai", model: DEFAULT, billing: { mode: "unified" },
        capabilities: { max_output_tokens_field: "max_tokens", reasoning_efforts: [] } } })) } satisfies InstalledNativeResearchConfiguration);
    const held = await frozen.readers.read_stage_five({ operation_id: frozen.operation_id, investigation_id: frozen.investigation_id, principal });
    seams.context.mockResolvedValue({ evidence_pack: held.evidence_pack, scope_snapshot_id: frozen.scope.snapshot_id,
      expires_at: frozen.scope.expires_at });
    seams.route.mockImplementation(async (_env, _control, _selection, _previous, requested) => [{ id: "native", type: "model", provider: "workers-ai", model: requested }]);
    const snapshots: DynamicRouteProviderSnapshot[] = [];
    seams.control = {
      list: async () => ({ routes: snapshots.map(snapshot => ({ provider_route_id: snapshot.provider_route_id, name: snapshot.name })) }),
      get: async (_gateway, id) => {
        const found = snapshots.find(snapshot => snapshot.provider_route_id === id);
        if (found === undefined) throw new Error("Missing controlled provider route");
        return found;
      },
      create: async (request: DynamicRouteCreateRequest) => {
        const id = `native-provider-route-${snapshots.length + 1}`;
        snapshots.push({ provider_route_id: id, gateway_id: request.gateway_id, name: request.name,
          route_definition: request.route_definition, metadata: request.metadata });
        return { provider_route_id: id };
      },
    };
    const logs = new Map<string, Record<string, unknown>>();
    const calls: { model: string; inputs: Record<string, unknown> }[] = [];
    const run = vi.fn(async (model: string, inputs: Record<string, unknown>, options: AiOptions) => {
      expect(model).toBe(MODEL);
      expect(inputs).not.toHaveProperty("model");
      const index = calls.length;
      calls.push({ model, inputs });
      const id = `native-qualification-log-${index + 1}`;
      const content = index === 0 ? { schema: "eliotr.research.synthesis-claims-candidate.v3", material_claims: [{
        text: "Controlled native qualification fixture.", kind: "observation",
        support_handle_refs: [held.evidence_pack.resolved_evidence[0]?.handle.handle_ref], counterevidence_handle_refs: [],
      }] } : { schema: "eliotr.research.semantic-verifier-observation.v1", verifier_ref: "fixture-verifier",
        verifier_schema_generation: "fixture-schema", evidence_input_sha256: "a".repeat(64), claims: [{
          claim_ref: { id: "fixture-claim", revision: 1 }, claim_text_digest: "b".repeat(64), value_or_measurement_verification: "PASS",
          specification_compliance: "PASS", method_artifact_alignment: "PASS", source_satisfies_requirement: "PASS",
          supplied_excerpt_supports_requirement: "PASS", contradiction_observed: false, unsupported_precision_observed: false, notes: [],
        }] };
      logs.set(id, { id, provider: "workers-ai", model, status_code: 200, cached: false, metadata: options.gateway?.metadata });
      return new Response(JSON.stringify({ id, object: "chat.completion", created: 1_790_000_000, model,
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(content) } }],
        usage: { prompt_tokens: 32, completion_tokens: 16, total_tokens: 48 } }),
      { status: 200, headers: { "content-type": "application/json", "cf-aig-log-id": id } });
    });
    const ai = { run, gateway: () => ({ getUrl: async () => env.AI_GATEWAY_REASONING_URL,
      getLog: async (id: string) => logs.get(id), run: async () => { throw new Error("Builtin must use AI.run, without compat/BYOK fallback"); } }),
    models: async () => [{ id: "95666467-f984-4211-b48a-7c246dd4adb7", source: 1, name: MODEL, description: "Native fixture",
      task: { id: "native-text-task", name: "Text Generation", description: "Native text generation" }, tags: [], properties: [
        { property_id: "price", value: [{ unit: "per M input tokens", price: 0.15, currency: "USD" },
          { unit: "per M output tokens", price: 0.5, currency: "USD" }, { unit: "per M cached input tokens", price: 0.03, currency: "USD" }] },
        { property_id: "reasoning_effort", value: { supported_efforts: ["max", "high", "low"], default_effort: "max",
          normalizes_to: { medium: "max", none: "max", minimal: "max", xhigh: "max", null: "max" } } },
      ] }],
    };
    const runtime = { ...env, AI: ai } as unknown as Env;
    const context = { principal_ref: owner, credential_generation: principal.credential_generation, client_class: "owner_pwa",
      request: new Request("https://eliot.test/api/v1/research/project/model-use", { method: "POST" }), trace_id: "native-catalog-fixture" } as AuthenticatedRequestContext;
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("No external HTTP/model call allowed in native fixture"); }));
    const api = createResearchCatalogModelUseComposition(runtime, context, PROJECT);
    const receipt = await api.start({ protocol: "eliotr.research.catalog-model-use-request.v1", operation_id: OPERATION,
      expected_selection_revision: null, provider_id: "cloudflare-workers-ai", provider_operation_id: null, model_id: MODEL });
    if (receipt.state !== "selected") {
      const diagnostic = (cause: unknown, depth = 0): unknown => {
        if (!(cause instanceof Error) || depth > 8) return String(cause);
        return { name: cause.name, message: cause.message, code: "code" in cause ? cause.code : undefined,
          ...(cause.cause === undefined ? {} : { cause: diagnostic(cause.cause, depth + 1) }) };
      };
      throw new Error(JSON.stringify({ receipt, native_calls: calls.length, failures: seams.failures.map(cause => diagnostic(cause)) }));
    }
    expect(receipt).toMatchObject({ state: "selected", phase: "complete", model_id: MODEL, provider_operation_id: null, selection_revision: 1 });
    expect(run).toHaveBeenCalledTimes(2);
    const selected = await createOwnerResearchProjectConfigurationService(runtime, context, PROJECT).readSelected(context, PROJECT);
    expect(selected?.configuration_ref).toBe(receipt.selected_configuration_ref);
    expect(selected?.configuration.model_selections.every(selection => selection.transport_policy.provider === "workers-ai" &&
      selection.transport_policy.model === MODEL && selection.transport_policy.billing.mode === "unified")).toBe(true);
    expect((await api.read(OPERATION)).state).toBe("selected");
    expect(run).toHaveBeenCalledTimes(2);
    const active = await db.prepare("SELECT count(*) AS count FROM dynamic_route_active_generation").first<{ count: number }>();
    expect(active?.count).toBe(0);
    const prices = await db.prepare("SELECT snapshot_json FROM research_model_pricing_snapshot WHERE provider='workers-ai' AND exact_model_id=?1")
      .bind(MODEL).all<{ snapshot_json: string }>();
    expect(prices.results).toHaveLength(2);
    expect(prices.results.every(price => JSON.parse(price.snapshot_json).catalog_metadata.rates_usd_per_1k_tokens.cache_read === "0.00003")).toBe(true);
    expect(await modelGatewaySha256(canonicalModelGatewayJson(selected?.configuration))).toBe(receipt.selected_configuration_sha256);
  }, 30_000);
});
