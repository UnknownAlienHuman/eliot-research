/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { canonicalJson } from "@eliotr/platform-cloudflare";
import type { ProjectClientGrant } from "@eliotr/contracts";
import { WorkflowCheckpointError } from "@eliotr/cloudflare-workflows";
import type { ModelGatewayTransportPolicyV1 } from "@eliotr/cloudflare-ai";
import {
  resolveResearchRunConfigurationAdmission,
  type ResearchRunConfigurationAdmissionDependenciesV1,
  type ResearchRunConfigurationAdmissionInputV1,
} from "@eliotr/cloudflare-research-configuration/research-run-configuration-admission.js";
import type { ResearchProjectConfigurationGrantReadAuthority } from
  "@eliotr/cloudflare-research-configuration/research-project-configuration.js";
import {
  createD1ResearchRunConfigurationStore,
  RESEARCH_RUN_CONFIGURATION_PROTOCOL,
  type ResearchRunConfigurationAssociation,
} from "@eliotr/cloudflare-research";
import type { Env } from "./env.js";
import {
  attachResearchRunConfiguration,
  captureResearchRunConfiguration,
  readResearchRunConfiguration,
  type SelectedResearchProjectConfiguration,
} from "./research-run-configuration.js";
import {
  RESEARCH_BRANCH_QUERY_BUDGET_PROFILE_JSON_KEY,
  RESEARCH_BRANCH_QUERY_BUDGET_PROFILE_PROTOCOL,
  type ResearchBranchQueryBudgetSelection,
} from "@eliotr/cloudflare-research-configuration/research-run-configuration.js";
import {
  captureResearchRunConfiguration as captureFrozenRunConfiguration,
  type InstalledNativeResearchConfiguration,
  type ResearchRunConfigurationRuntimePort,
} from "@eliotr/cloudflare-research-configuration/research-run-configuration.js";

const actor = Object.freeze({
  operation_id: "run-config-core-1",
  investigation_id: "research-config-core-1",
  principal_ref: "owner-config-core-1",
  deployment_generation: "deployment-original-1",
});

const semantic = canonicalJson({ protocol: "eliotr.research-semantic-config.v1", marker: "captured-semantic" });
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const transport_policy = { version: 1, transport: "cloudflare-ai-gateway", api: "compat-chat-completions",
  provider: "workers-ai", model: "@cf/example/model", billing: { mode: "unified" },
  capabilities: { max_output_tokens_field: "max_tokens", reasoning_efforts: ["low", "medium", "high"] } } satisfies ModelGatewayTransportPolicyV1;

function snapshotJson(
  mode: "snapshot-v1" | "snapshot-v2" = "snapshot-v1",
  routes = ["dynamic/eliotr-balanced", "dynamic/eliotr-audit-verifier"],
  branchQueryBudgetSelection?: ResearchBranchQueryBudgetSelection,
): string {
  const spend = { protocol: mode === "snapshot-v2" ? "eliotr.research-owner-spend-template.v2" : "eliotr.research-owner-spend-template.v1" };
  const modelSelection = (stage: string, route: string) => ({ stage, route_ref: route, route_version: "version-1",
    candidate_ref: `candidate-${stage.toLowerCase()}`, candidate_sha256: "b".repeat(64),
    qualification_ref: `qualification-${stage.toLowerCase()}`, qualification_sha256: "c".repeat(64), transport_policy });
  const selectedConfiguration = branchQueryBudgetSelection?.selected_configuration;
  return canonicalJson({
    protocol: RESEARCH_RUN_CONFIGURATION_PROTOCOL,
    mode,
    association: actor,
    project_configuration: {
      configuration_ref: selectedConfiguration?.configuration_ref ?? "project-config-1",
      configuration_sha256: selectedConfiguration?.configuration_sha256 ?? "d".repeat(64),
      selection_revision: selectedConfiguration?.selection_revision ?? 1,
      ...(selectedConfiguration === undefined ? {} : {
        owner_ref: selectedConfiguration.owner_ref,
        project_id: selectedConfiguration.project_id,
      }),
    },
    model_selections: [modelSelection("SYNTHESIZE", routes[0] ?? ""), modelSelection("AUDIT_CLAIMS", routes[1] ?? "")],
    semantic: { source: "revision", config_json: semantic, revision_ref: "scr-123456789abc", config_sha256: sha256(semantic) },
    model_profile: { config_json: canonicalJson({ profile: "captured" }), provenance_ref: "profile-provenance-1" },
    spend_policy: { config_json: canonicalJson(spend), provenance_ref: "spend-provenance-1" },
    report: { config_json: canonicalJson({ report: "captured" }), provenance_ref: "report-provenance-1" },
    ...(branchQueryBudgetSelection === undefined ? {} : {
      branch_query_budget_selection: branchQueryBudgetSelection,
    }),
  });
}

function branchQueryBudgetSelection(): ResearchBranchQueryBudgetSelection {
  return {
    protocol: "eliotr.research.branch-query-budget-selection.v1",
    profile_id: "branch-query-budget-profile-1",
    profile_generation: 2,
    budgets: {
      candidate_limit: 7,
      scan_limit: 20,
      evidence_limit: 2,
      max_evidence_bytes: 1024,
      max_query_legs: 3,
    },
    selected_configuration: {
      owner_ref: actor.principal_ref,
      project_id: "project-1",
      configuration_ref: `rpmc-${"d".repeat(64)}`,
      configuration_sha256: "d".repeat(64),
      selection_revision: 3,
    },
  };
}

function selectedProjectConfiguration(input: {
  readonly profile_json: string;
  readonly owner_ref: string;
  readonly selection_revision: number;
  readonly spend_policy_json?: string;
  readonly report_json?: string;
}): SelectedResearchProjectConfiguration {
  const modelSelection = (stage: string, route: string) => ({ stage, route_ref: route, route_version: "version-1",
    candidate_ref: `candidate-${stage.toLowerCase()}`, candidate_sha256: "b".repeat(64),
    qualification_ref: `qualification-${stage.toLowerCase()}`, qualification_sha256: "c".repeat(64), transport_policy });
  const semanticSha = sha256(semantic);
  const bundle = {
    protocol: "eliotr.research-project-model-configuration.v1",
    semantic_revision: { revision_ref: `scr-${semanticSha.slice(0, 12)}`, config_sha256: semanticSha },
    model_selections: [
      modelSelection("SYNTHESIZE", "dynamic/eliotr-balanced"),
      modelSelection("AUDIT_CLAIMS", "dynamic/eliotr-audit-verifier"),
    ],
    vars: {
      ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON: semantic,
      ELIOTR_MODEL_PROFILE_DEFINITION_JSON: canonicalJson({ profile: "selected" }),
      ELIOTR_MODEL_PROFILE_PROVENANCE_REF: "profile-provenance-1",
      ELIOTR_MODEL_SPEND_POLICY_JSON: input.spend_policy_json ??
        canonicalJson({ protocol: "eliotr.research-owner-spend-template.v2" }),
      ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF: "spend-provenance-1",
      ELIOTR_RESEARCH_REPORT_CONFIG_JSON: input.report_json ?? canonicalJson({ report: "selected" }),
      ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF: "report-provenance-1",
      [RESEARCH_BRANCH_QUERY_BUDGET_PROFILE_JSON_KEY]: input.profile_json,
    },
  };
  const configuration_json = canonicalJson(bundle);
  const configuration_sha256 = sha256(configuration_json);
  return {
    owner_ref: input.owner_ref,
    project_id: "project-1",
    selection_revision: input.selection_revision,
    configuration_ref: `rpmc-${configuration_sha256}`,
    configuration_sha256,
    configuration_json,
  };
}

function ownerProfileJson(input: {
  readonly profile_id: string;
  readonly profile_generation: number;
  readonly candidate_limit: number;
}): string {
  return canonicalJson({
    protocol: RESEARCH_BRANCH_QUERY_BUDGET_PROFILE_PROTOCOL,
    profile_id: input.profile_id,
    profile_generation: input.profile_generation,
    budgets: {
      candidate_limit: input.candidate_limit,
      scan_limit: 20,
      evidence_limit: 2,
      max_evidence_bytes: 1024,
      max_query_legs: 3,
    },
  });
}

type MemoryAssociation = { readonly operation_id: string; readonly investigation_id: string; readonly principal_ref: string;
  readonly deployment_generation: string };
type MemoryRun = MemoryAssociation & { readonly configuration_required: number; configuration_ref: string | null };
type MemoryConfiguration = MemoryAssociation & {
  readonly protocol: typeof RESEARCH_RUN_CONFIGURATION_PROTOCOL;
  readonly mode: "snapshot-v1" | "snapshot-v2";
  readonly configuration_ref: string;
  readonly configuration_sha256: string;
  readonly configuration_json: string;
  readonly byte_length: number;
  readonly created_at: string;
};

function memoryDatabase(requiredRun?: 0 | 1, semanticOwnerRef: string = actor.principal_ref): {
  readonly database: D1Database;
  readonly runs: Map<string, MemoryRun>;
  readonly configurations: Map<string, MemoryConfiguration>;
} {
  const runs = new Map<string, MemoryRun>();
  const configurations = new Map<string, MemoryConfiguration>();
  const database = {
    prepare(rawQuery: string) {
      const query = rawQuery.replace(/\s+/gu, " ").trim();
      return {
        bind(...values: unknown[]) {
          return {
            async first<T>() {
              if (query.includes("FROM research_semantic_config_revision")) {
                const revisionRef = `scr-${sha256(semantic).slice(0, 12)}`;
                return (String(values[0]) === revisionRef ? {
                  revision_ref: revisionRef,
                  config_sha256: sha256(semantic),
                  config_json: semantic,
                  byte_length: new TextEncoder().encode(semantic).byteLength,
                  protocol: "eliotr.research-semantic-config.v1",
                  created_at: "2026-10-14T00:00:00.000Z",
                  created_by_principal_ref: semanticOwnerRef,
                } : null) as T | null;
              }
              if (query.includes("FROM research_workflow_run")) {
                return (runs.get(String(values[0])) ?? null) as T | null;
              }
              if (query.includes("FROM research_run_configuration") && query.includes("WHERE operation_id=?1")) {
                return (configurations.get(String(values[0])) ?? null) as T | null;
              }
              if (query.includes("FROM research_run_configuration") && query.includes("WHERE configuration_ref=?1")) {
                return ([...configurations.values()].find((row) => row.configuration_ref === values[0]) ?? null) as T | null;
              }
              throw new Error(`Unexpected test D1 query: ${query}`);
            },
            async run() {
              if (query.startsWith("INSERT INTO research_run_configuration")) {
                const [operation_id, investigation_id, principal_ref, deployment_generation, protocol, mode,
                  configuration_ref, configuration_sha256, configuration_json, byte_length, created_at] = values as [
                  string, string, string, string, typeof RESEARCH_RUN_CONFIGURATION_PROTOCOL, "snapshot-v1" | "snapshot-v2",
                  string, string, string, number, string,
                ];
                if (!configurations.has(operation_id)) {
                  configurations.set(operation_id, { operation_id, investigation_id, principal_ref, deployment_generation,
                    protocol, mode, configuration_ref, configuration_sha256, configuration_json, byte_length, created_at });
                  return { success: true, meta: { changes: 1 } };
                }
                return { success: true, meta: { changes: 0 } };
              }
              if (query.startsWith("UPDATE research_workflow_run SET configuration_ref=")) {
                const [configuration_ref, operation_id] = values as [string, string];
                const run = runs.get(operation_id);
                if (run !== undefined && run.configuration_ref === null) run.configuration_ref = configuration_ref;
                return { success: true, meta: { changes: run?.configuration_ref === configuration_ref ? 1 : 0 } };
              }
              throw new Error(`Unexpected test D1 write: ${query}`);
            },
          };
        },
      };
    },
  };
  if (requiredRun !== undefined) runs.set(actor.operation_id, { ...actor, configuration_required: requiredRun, configuration_ref: null });
  return { database: database as unknown as D1Database, runs, configurations };
}

function testEnv(database: D1Database): Env {
  return { CORE_DB: database } as unknown as Env;
}

describe("research run configuration binding", () => {
  it("preserves an explicit pre-migration legacy-installed run", async () => {
    const { database } = memoryDatabase(0);
    const env = testEnv(database);
    const result = await readResearchRunConfiguration(env, actor);
    expect(result.mode).toBe("legacy-installed");
    expect(result.configuration_ref).toBeNull();
  });

  it("persists a snapshot before binding it and reloads exact vars without replacing live credentials", async () => {
    const { database, runs } = memoryDatabase();
    const env = { ...testEnv(database), DEPLOYMENT_GENERATION: "deployment-current-2",
      ELIOTR_MODEL_GATEWAY_TOKEN: "current-secret-token", ELIOTR_MODEL_PROFILE_DEFINITION_JSON: "old-profile" } as Env;
    const json = snapshotJson();
    const receipt = await createD1ResearchRunConfigurationStore(database).putImmutable({ ...actor,
      mode: "snapshot-v1", configuration_json: json, created_at: "2026-10-03T12:00:00.000Z" });
    runs.set(actor.operation_id, { ...actor, configuration_required: 1, configuration_ref: null });
    await attachResearchRunConfiguration(env, actor, { mode: "snapshot-v1", ...receipt });

    const result = await readResearchRunConfiguration(env, actor);
    expect(result).toMatchObject({ mode: "snapshot-v1", configuration_ref: receipt.configuration_ref,
      configuration_sha256: receipt.configuration_sha256 });
    expect(result.env.ELIOTR_RESEARCH_SEMANTIC_CONFIG_REF).toBe("scr-123456789abc");
    expect(result.env.ELIOTR_RESEARCH_SEMANTIC_CONFIG_SHA256).toBe(sha256(semantic));
    expect(result.env.ELIOTR_MODEL_PROFILE_DEFINITION_JSON).toBe(canonicalJson({ profile: "captured" }));
    expect(result.env.ELIOTR_MODEL_GATEWAY_TOKEN).toBe("current-secret-token");
    expect(result.env.DEPLOYMENT_GENERATION).toBe("deployment-current-2");
    expect(result.model_selections.map((selection) => selection.transport_policy))
      .toEqual([transport_policy, transport_policy]);
  });

  it("accepts canonical dynamic routes and rejects malformed route references on snapshot readback", async () => {
    const { database, runs } = memoryDatabase(1);
    const env = testEnv(database);
    const receipt = await createD1ResearchRunConfigurationStore(database).putImmutable({ ...actor,
      mode: "snapshot-v1", configuration_json: snapshotJson("snapshot-v1", ["route-synthesis", "route-audit"]) });
    const run = runs.get(actor.operation_id);
    if (run === undefined) throw new Error("test run row missing");
    run.configuration_ref = receipt.configuration_ref;
    await expect(readResearchRunConfiguration(env, actor)).rejects.toMatchObject({ code: "WORKFLOW_CONFIGURATION_INVALID" });
  });

  it("does not resolve current selection on idempotent replay and fails closed for a missing required pointer", async () => {
    const { database } = memoryDatabase(1);
    const env = testEnv(database);
    await createD1ResearchRunConfigurationStore(database).putImmutable({ ...actor,
      mode: "snapshot-v2", configuration_json: snapshotJson("snapshot-v2", undefined, branchQueryBudgetSelection()),
      created_at: "2026-10-03T12:00:00.000Z" });
    const replay = await captureResearchRunConfiguration(env, { ...actor,
      select_project_configuration: async () => { throw new Error("current selection must not be read on retry"); } });
    expect(replay.mode).toBe("snapshot-v2");
    expect(replay.branch_query_budget_selection).toEqual(branchQueryBudgetSelection());
    await expect(readResearchRunConfiguration(env, actor)).rejects.toMatchObject({ code: "WORKFLOW_CONFIGURATION_INVALID" });
  });

  it("captures the owner-selected profile and replays its stored tuple without reading a newer selection", async () => {
    const { database } = memoryDatabase();
    const env = { ...testEnv(database), ELIOTR_MODEL_GATEWAY_TOKEN: "test-gateway-token" } as Env;
    const capturedProfile = ownerProfileJson({ profile_id: "profile-captured", profile_generation: 4, candidate_limit: 7 });
    const newerProfile = ownerProfileJson({ profile_id: "profile-newer", profile_generation: 5, candidate_limit: 9 });
    let selectedReads = 0;
    const initial = await captureResearchRunConfiguration(env, { ...actor,
      select_project_configuration: async () => {
        selectedReads += 1;
        return selectedProjectConfiguration({ profile_json: capturedProfile,
          owner_ref: actor.principal_ref, selection_revision: 3 });
      } });

    const replay = await captureResearchRunConfiguration(env, { ...actor,
      select_project_configuration: async () => {
        selectedReads += 1;
        return selectedProjectConfiguration({ profile_json: newerProfile,
          owner_ref: actor.principal_ref, selection_revision: 4 });
      } });

    expect(selectedReads).toBe(1);
    expect(initial.branch_query_budget_selection?.profile_id).toBe("profile-captured");
    expect(initial.branch_query_budget_selection?.budgets.candidate_limit).toBe(7);
    expect(replay.branch_query_budget_selection).toEqual(initial.branch_query_budget_selection);
    const expectedSelections = [
      { stage: "SYNTHESIZE", route_ref: "dynamic/eliotr-balanced", route_version: "version-1",
        candidate_ref: "candidate-synthesize", candidate_sha256: "b".repeat(64),
        qualification_ref: "qualification-synthesize", qualification_sha256: "c".repeat(64), transport_policy },
      { stage: "AUDIT_CLAIMS", route_ref: "dynamic/eliotr-audit-verifier", route_version: "version-1",
        candidate_ref: "candidate-audit_claims", candidate_sha256: "b".repeat(64),
        qualification_ref: "qualification-audit_claims", qualification_sha256: "c".repeat(64), transport_policy },
    ];
    expect(initial.model_selections).toEqual(expectedSelections);
    expect(replay.model_selections).toEqual(expectedSelections);
  });

  it.each([
    { label: "unknown selection field", patch: { fallback_model: "unselected-model" } },
    { label: "unknown transport field", patch: { transport_policy: { ...transport_policy, fallback: true } } },
    { label: "obsolete billing mode", patch: { transport_policy: { ...transport_policy, billing: { mode: "unified_billing" } } } },
    { label: "missing output token capability", patch: { transport_policy: { ...transport_policy,
      capabilities: { reasoning_efforts: transport_policy.capabilities.reasoning_efforts } } } },
  ])("rejects $label during capture without persisting an invalid model pin", async ({ patch }) => {
    const { database, configurations } = memoryDatabase();
    const env = { ...testEnv(database), ELIOTR_MODEL_GATEWAY_TOKEN: "test-gateway-token" } as Env;
    const selected = selectedProjectConfiguration({ profile_json: ownerProfileJson({
      profile_id: "profile-invalid-pin-1", profile_generation: 1, candidate_limit: 4,
    }), owner_ref: actor.principal_ref, selection_revision: 1 });
    const bundle = JSON.parse(selected.configuration_json) as { model_selections: Record<string, unknown>[] };
    bundle.model_selections = bundle.model_selections.map((selection) => ({ ...selection, ...patch }));
    const configuration_json = canonicalJson(bundle), configuration_sha256 = sha256(configuration_json);
    await expect(captureResearchRunConfiguration(env, { ...actor,
      select_project_configuration: async () => ({ ...selected, configuration_json, configuration_sha256,
        configuration_ref: `rpmc-${configuration_sha256}` }),
    })).rejects.toMatchObject({ code: "WORKFLOW_CONFIGURATION_INVALID" });
    expect(configurations.size).toBe(0);
  });

  it("freezes an explicit output language into this run's report policy and preserves omitted behavior", async () => {
    const reportJson = canonicalJson({ schema: "eliotr.research.report-config.v1", admission_policy: {},
      artifact_policy: { title: "Ответ по документам", language: "ru", section_contract: {
        title: "Ответ", purpose: "Ответ на вопрос по документу с источниками, контраргументами и ограничениями",
      } } });
    const selected = selectedProjectConfiguration({ profile_json: ownerProfileJson({
      profile_id: "profile-language-1", profile_generation: 1, candidate_limit: 4,
    }), owner_ref: actor.principal_ref, selection_revision: 5, report_json: reportJson });
    const englishState = memoryDatabase();
    const englishEnv = { ...testEnv(englishState.database), ELIOTR_MODEL_GATEWAY_TOKEN: "test-gateway-token" } as Env;
    const englishResult = await captureResearchRunConfiguration(englishEnv, { ...actor, output_language: "en",
      select_project_configuration: async () => selected });
    const englishSnapshot = JSON.parse([...englishState.configurations.values()][0]?.configuration_json ?? "{}") as {
      readonly report: { readonly config_json: string; readonly output_language?: string };
    };
    expect(englishResult.output_language).toBe("en");
    expect(englishSnapshot.report.output_language).toBe("en");
    expect(JSON.parse(englishSnapshot.report.config_json)).toMatchObject({ artifact_policy: {
      title: "Research answer", language: "en", section_contract: { title: "Answer",
        purpose: "Evidence-backed answer with sources, counterarguments, and limitations" },
    } });

    const unchangedState = memoryDatabase();
    const unchangedEnv = { ...testEnv(unchangedState.database), ELIOTR_MODEL_GATEWAY_TOKEN: "test-gateway-token" } as Env;
    await captureResearchRunConfiguration(unchangedEnv, { ...actor,
      select_project_configuration: async () => selected });
    const unchangedSnapshot = JSON.parse([...unchangedState.configurations.values()][0]?.configuration_json ?? "{}") as {
      readonly report: { readonly config_json: string; readonly output_language?: string };
    };
    expect(unchangedSnapshot.report.config_json).toBe(reportJson);
    expect(unchangedSnapshot.report.output_language).toBeUndefined();
  });

  it("does not write a run snapshot if the selected configuration becomes ineligible during capture", async () => {
    const { database, configurations } = memoryDatabase();
    const env = { ...testEnv(database), ELIOTR_MODEL_GATEWAY_TOKEN: "test-gateway-token" } as Env;
    const selected = selectedProjectConfiguration({ profile_json: ownerProfileJson({
      profile_id: "profile-revoked-1", profile_generation: 2, candidate_limit: 4,
    }), owner_ref: actor.principal_ref, selection_revision: 6 });
    let reads = 0;
    await expect(captureResearchRunConfiguration(env, { ...actor,
      selected_project_configuration_pin: { configuration_project_id: selected.project_id ?? "",
        configuration_ref: selected.configuration_ref, configuration_sha256: selected.configuration_sha256,
        selection_revision: selected.selection_revision },
      select_project_configuration: async () => {
        reads += 1;
        return reads === 1 ? selected : null;
      } })).rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
    expect(reads).toBe(2);
    expect(configurations.size).toBe(0);
  });

  it("rejects a stale selected revision before creating a snapshot or using another configuration", async () => {
    const { database, configurations } = memoryDatabase();
    const env = { ...testEnv(database), ELIOTR_MODEL_GATEWAY_TOKEN: "test-gateway-token" } as Env;
    const selected = selectedProjectConfiguration({ profile_json: ownerProfileJson({
      profile_id: "profile-stale-pin-1", profile_generation: 3, candidate_limit: 4,
    }), owner_ref: actor.principal_ref, selection_revision: 8 });
    let reads = 0;
    await expect(captureResearchRunConfiguration(env, { ...actor,
      selected_project_configuration_pin: { configuration_project_id: selected.project_id ?? "",
        configuration_ref: selected.configuration_ref, configuration_sha256: selected.configuration_sha256,
        selection_revision: 7 },
      select_project_configuration: async () => {
        reads += 1;
        return selected;
      } })).rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
    expect(reads).toBe(1);
    expect(configurations.size).toBe(0);
  });

  it("captures an explicit builtin Cloudflare model from installed qualification without a project config or key", async () => {
    const state = memoryDatabase();
    const modelId = "@cf/meta/llama-3.1-8b-instruct";
    const installedBundle = JSON.parse(selectedProjectConfiguration({
      profile_json: ownerProfileJson({ profile_id: "installed-native-1", profile_generation: 1, candidate_limit: 4 }),
      owner_ref: actor.principal_ref,
      selection_revision: 1,
      report_json: canonicalJson({ schema: "eliotr.research.report-config.v1", admission_policy: {},
        artifact_policy: { title: "Ответ по документам", language: "ru", section_contract: {
          title: "Ответ", purpose: "Ответ на вопрос по документу с источниками, контраргументами и ограничениями",
        } } }),
    }).configuration_json) as { readonly vars: InstalledNativeResearchConfiguration["vars"];
      readonly model_selections: InstalledNativeResearchConfiguration["model_selections"] };
    const installed: InstalledNativeResearchConfiguration = {
      vars: installedBundle.vars,
      model_selections: installedBundle.model_selections.map((selection) => selection.stage === "SYNTHESIZE"
        ? { ...selection, transport_policy: { ...selection.transport_policy, model: modelId } }
        : selection),
    };
    let installedReads = 0;
    const port: ResearchRunConfigurationRuntimePort<Record<string, unknown>> = {
      database: state.database,
      semantic_source: () => ({ revision_ref: `scr-${sha256(semantic).slice(0, 12)}`,
        config_sha256: sha256(semantic) }),
      model_transport_available: () => true,
      installed_native_configuration: async (_env, ownerRef, projectId) => {
        installedReads += 1;
        expect(ownerRef).toBe(actor.principal_ref);
        expect(projectId).toBeUndefined();
        return installed;
      },
      overlay_snapshot: (environment, snapshot) => ({ ...environment,
        report_config: snapshot.report.config_json,
        output_language: snapshot.report.output_language,
      }),
    };
    const result = await captureFrozenRunConfiguration({}, { ...actor,
      allow_installed_native_default: true,
      installed_native_model_pin: { expected_model_id: modelId },
      output_language: "en",
      require_current_configuration_scope: async () => {},
    }, port);
    expect(result.project_id).toBeNull();
    expect(result.project_configuration_ref).toBeNull();
    expect(result.model_selections.find((selection) => selection.stage === "SYNTHESIZE")?.transport_policy.model)
      .toBe(modelId);
    expect(result.output_language).toBe("en");
    expect(installedReads).toBe(2);
    expect(state.configurations.size).toBe(1);
  });

  it("captures grantor configuration and spend under the service actor, denying foreign or revoked grants", async () => {
    const grantor = "owner-grantor-config-1";
    let grantCurrent = true;
    const grant: ProjectClientGrant = {
      protocol: "eliotr.project-client-grant.v1",
      grant_id: "grant-config-admission-1",
      project_id: "project-1",
      grantor_principal_ref: grantor,
      revision: 4,
      state: "ACTIVE",
      grantee: { issuer: "https://test.cloudflareaccess.com", authentication_method: "service_token",
        subject: "service-config-1.access" },
      allowed_operations: ["run"],
      ingest_namespace_ids: [],
      expires_at: "2026-12-01T00:00:00.000Z",
      created_at: "2026-10-15T00:00:00.000Z",
      updated_at: "2026-10-15T00:00:00.000Z",
    };
    const authority: ResearchProjectConfigurationGrantReadAuthority = {
      lease: {
        grant,
        project_generation: 3,
        requireGrantCurrent: async () => {
          if (!grantCurrent) throw new WorkflowCheckpointError("WORKFLOW_AUTHORITY_STALE");
        },
      },
      require_current_scope: async () => {
        if (!grantCurrent) throw new WorkflowCheckpointError("WORKFLOW_AUTHORITY_STALE");
      },
    };
    const spendPolicy = canonicalJson({ protocol: "eliotr.research-owner-spend-template.v2",
      principal_ref: grantor, policy_ref: "grantor-spend-policy-1" });
    const selection = selectedProjectConfiguration({ profile_json: ownerProfileJson({
      profile_id: "grantor-profile-1", profile_generation: 8, candidate_limit: 6,
    }), owner_ref: grantor, selection_revision: 3, spend_policy_json: spendPolicy });

    const startRun = (runActor: ResearchRunConfigurationAssociation, selected: SelectedResearchProjectConfiguration) => {
      const { database, configurations } = memoryDatabase(undefined, grantor);
      const env = { ...testEnv(database), AI: { gateway: () => undefined } } as unknown as Env;
      let selectedReads = 0;
      const dependencies: ResearchRunConfigurationAdmissionDependenciesV1<
        Awaited<ReturnType<typeof captureResearchRunConfiguration>>
      > = {
        capture: (input) => captureResearchRunConfiguration(env, input),
        read: (input) => readResearchRunConfiguration(env, input),
        select_current_project_configuration: async (projectId) => {
          selectedReads += 1;
          expect(projectId).toBe(grant.project_id);
          return selected;
        },
        require_single_owned_project: (): never => { throw new Error("SINGLE_PROJECT_REQUIRED"); },
        require_valid_configuration_marker: (): never => { throw new WorkflowCheckpointError("WORKFLOW_AUTHORITY_STALE"); },
      };
      const input: ResearchRunConfigurationAdmissionInputV1 = {
        actor: runActor,
        scope_expression: { kind: "PROJECT", project_id: "project-1" },
        new_run: true,
        project_configuration_read_authority: authority,
      };
      const outcome = resolveResearchRunConfigurationAdmission(input, dependencies);
      return { outcome, configurations, selectedReads: () => selectedReads };
    };

    const serviceActor = { ...actor, operation_id: "run-config-service-1",
      investigation_id: "research-config-service-1", principal_ref: "service-config-1" };
    const acceptedState = startRun(serviceActor, selection);
    const accepted = await acceptedState.outcome;
    expect(accepted).toMatchObject({ mode: "snapshot-v2", project_owner_ref: grantor, project_id: "project-1" });
    expect(accepted.env.ELIOTR_MODEL_SPEND_POLICY_JSON).toBe(spendPolicy);
    const snapshot = JSON.parse([...acceptedState.configurations.values()][0]?.configuration_json ?? "{}") as {
      readonly association: { readonly principal_ref: string };
      readonly project_configuration: { readonly owner_ref: string; readonly project_id: string };
    };
    expect(snapshot.association.principal_ref).toBe(serviceActor.principal_ref);
    expect(snapshot.project_configuration).toEqual({
      configuration_ref: selection.configuration_ref,
      configuration_sha256: selection.configuration_sha256,
      selection_revision: selection.selection_revision,
      owner_ref: grantor,
      project_id: grant.project_id,
    });

    const foreign = startRun({ ...serviceActor, operation_id: "run-config-foreign-1",
      investigation_id: "research-config-foreign-1" }, { ...selection, owner_ref: "foreign-owner-1" });
    await expect(foreign.outcome).rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
    expect(foreign.configurations.size).toBe(0);

    grantCurrent = false;
    const revoked = startRun({ ...serviceActor, operation_id: "run-config-revoked-1",
      investigation_id: "research-config-revoked-1" }, selection);
    await expect(revoked.outcome).rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
    expect(revoked.selectedReads()).toBe(0);
    expect(revoked.configurations.size).toBe(0);
  });

  it("rejects foreign-owner and malformed declared profiles before persisting a run snapshot", async () => {
    const foreign = memoryDatabase();
    const env = { ...testEnv(foreign.database), ELIOTR_MODEL_GATEWAY_TOKEN: "test-gateway-token" } as Env;
    await expect(captureResearchRunConfiguration(env, { ...actor,
      select_project_configuration: async () => selectedProjectConfiguration({
        profile_json: ownerProfileJson({ profile_id: "profile-foreign", profile_generation: 1, candidate_limit: 3 }),
        owner_ref: "another-owner",
        selection_revision: 1,
      }) })).rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
    expect(foreign.configurations.size).toBe(0);

    const malformed = memoryDatabase();
    const malformedEnv = { ...testEnv(malformed.database), ELIOTR_MODEL_GATEWAY_TOKEN: "test-gateway-token" } as Env;
    await expect(captureResearchRunConfiguration(malformedEnv, { ...actor,
      select_project_configuration: async () => selectedProjectConfiguration({
        profile_json: "{",
        owner_ref: actor.principal_ref,
        selection_revision: 1,
      }) })).rejects.toMatchObject({ code: "WORKFLOW_CONFIGURATION_INVALID" });
    expect(malformed.configurations.size).toBe(0);
  });

  it("fails closed on a malformed declared branch budget profile before returning the stored run", async () => {
    const { database, runs } = memoryDatabase(1);
    const env = testEnv(database);
    const malformed = JSON.parse(snapshotJson("snapshot-v2", undefined, branchQueryBudgetSelection()));
    malformed.branch_query_budget_selection.profile_generation = 0;
    const receipt = await createD1ResearchRunConfigurationStore(database).putImmutable({ ...actor,
      mode: "snapshot-v2", configuration_json: canonicalJson(malformed), created_at: "2026-10-03T12:00:00.000Z" });
    const run = runs.get(actor.operation_id);
    if (run === undefined) throw new Error("test run row missing");
    run.configuration_ref = receipt.configuration_ref;

    await expect(readResearchRunConfiguration(env, actor)).rejects.toMatchObject({ code: "WORKFLOW_CONFIGURATION_INVALID" });
  });
});
