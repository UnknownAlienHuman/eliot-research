import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as CloudflareResearchModule from "@eliotr/cloudflare-research";
import type * as CloudflareWorkflowsModule from "@eliotr/cloudflare-workflows";
import type * as RetrievalModule from "@eliotr/retrieval";
import type * as RetrievalCompositionModule from "./research-retrieval-composition.js";
import type * as EvidenceFreezeCompositionModule from "./research-evidence-freeze-composition.js";
import {
  MANAGED_RANKING_OUTCOME_PROTOCOL,
  MANAGED_RETRIEVAL_TRACE_PROTOCOL,
  type ScopeSnapshot,
} from "@eliotr/contracts";
import { retrievalRequestDigest, type RetrievalRequestBudgets } from "@eliotr/retrieval";
import { textDigest } from "@eliotr/cloudflare-research";
import { BRANCH_QUERY_HANDLER_GENERATION } from "@eliotr/cloudflare-research";
import type { ResearchBranchQueryBudgetSelection } from
  "@eliotr/cloudflare-research-configuration/research-run-configuration.js";
import { createResearchSemanticWorkflowHandlerFactory } from "./research-semantic-composition.js";
import {
  createRetrieveBranchesStageHandler,
  readRetrieveBranchesCheckpoint,
  type RetrieveBranchesStageDependencies,
} from "./research-retrieve-branches.js";
import { SERVER_OWNED_BRANCH_QUERY_HANDLER_GENERATION } from "./research-stage-handlers.js";

const seams = vi.hoisted(() => ({
  heldScope: vi.fn(),
  retrieve: vi.fn(),
  readFreeze: vi.fn(),
  readWorkflowObject: vi.fn(),
  readCommittedStageRequest: vi.fn(),
  readReceipt: vi.fn(),
  loadStoredResult: vi.fn(),
  requireProfileBinding: vi.fn(),
  readerRetrieve: undefined as unknown,
}));

vi.mock("./research-retrieval-composition.js", async (importOriginal) => {
  const actual = await importOriginal<typeof RetrievalCompositionModule>();
  return { ...actual, loadHeldResearchScope: seams.heldScope, retrieveWithHeldScope: seams.retrieve };
});

vi.mock("@eliotr/cloudflare-research", async (importOriginal) => {
  const actual = await importOriginal<typeof CloudflareResearchModule>();
  return {
    ...actual,
    readFreezeProtocolAndScopeCheckpoint: seams.readFreeze,
    readWorkflowObject: seams.readWorkflowObject,
  };
});

vi.mock("@eliotr/cloudflare-workflows", async (importOriginal) => {
  const actual = await importOriginal<typeof CloudflareWorkflowsModule>();
  return {
    ...actual,
    WorkflowCheckpointStore: class {
      readCommittedStageRequest(...args: Parameters<typeof seams.readCommittedStageRequest>) {
        return seams.readCommittedStageRequest(...args);
      }
      receipt(...args: Parameters<typeof seams.readReceipt>) {
        return seams.readReceipt(...args);
      }
    },
  };
});

vi.mock("@eliotr/retrieval", async (importOriginal) => {
  const actual = await importOriginal<typeof RetrievalModule>();
  return {
    ...actual,
    createD1RetrievalResultStore: vi.fn(() => ({ load: seams.loadStoredResult })),
    createD1ScopeProfilePort: vi.fn(() => ({
      recordBinding: vi.fn(),
      requireBinding: seams.requireProfileBinding,
    })),
    serializeRetrieveBranchesCheckpoint: (value: unknown) =>
      new TextEncoder().encode(JSON.stringify(value)),
    decodeRetrieveBranchesCheckpoint: (bytes: Uint8Array) =>
      JSON.parse(new TextDecoder().decode(bytes)),
  };
});

vi.mock("./research-evidence-freeze-composition.js", async (importOriginal) => {
  const actual = await importOriginal<typeof EvidenceFreezeCompositionModule>();
  return {
    ...actual,
    createEvidenceFreezeWorkflowReaders: (...args: Parameters<typeof actual.createEvidenceFreezeWorkflowReaders>) => {
      seams.readerRetrieve = args[0].retrieve;
      return actual.createEvidenceFreezeWorkflowReaders(...args);
    },
  };
});

const BUDGETS: RetrievalRequestBudgets = {
  candidate_limit: 9,
  scan_limit: 23,
  evidence_limit: 2,
  max_evidence_bytes: 2048,
};
const QUESTION = "Compare the positional embeddings in the two papers";
const SCOPE: ScopeSnapshot = {
  snapshot_id: "budget-scope",
  revision: 1,
  resolved_scope_expression: { kind: "PROJECT", project_id: "budget-project" },
  participant_generations: {},
  member_source_revision_refs: ["source-revision-1"],
  source_owner_generations: { "source-revision-1": "owner-generation-1" },
  policy_authority_ref: "budget-policy",
  disclosure_closure_digest: "a".repeat(64),
  purge_ledger_revision: 0,
  digest: "b".repeat(64),
  created_at: "2026-10-17T00:00:00.000Z",
  expires_at: "2026-10-18T00:00:00.000Z",
};
const SCOPE_REF = { id: SCOPE.snapshot_id, revision: SCOPE.revision };
const PRINCIPAL = {
  principal_ref: "budget-owner",
  credential_generation: "budget-credential",
  deployment_generation: "budget-deployment",
};
const ACCESS = { ...PRINCIPAL, client_class: "owner_pwa" as const };
const PROFILE = { version: "scope-profile-v1", max_sources: 8, max_results: 16 };

function stageRequest(stage: string, revision: number, generation: string = BRANCH_QUERY_HANDLER_GENERATION) {
  return {
    protocol: "eliotr.workflow-stage.v1" as const,
    operation_id: "budget-operation",
    investigation_ref: { id: "budget-investigation", revision },
    stage: stage as "FREEZE_PROTOCOL_AND_SCOPE" | "RETRIEVE_BRANCHES" | "FREEZE_EVIDENCE",
    idempotency_key: `budget-${stage.toLowerCase()}`,
    handler_generation: generation,
    input_manifest: {
      object_ref: `workflow/${stage.toLowerCase()}`,
      sha256: "c".repeat(64),
      byte_length: 1,
      residency: {
        scope_domain_id: SCOPE.snapshot_id,
        access_domain_id: PRINCIPAL.principal_ref,
        confidentiality_domain_id: "private",
        encryption_key_domain_id: "test-key",
        retention_domain_id: "test-retention",
        erasure_domain_id: "test-erasure",
        content_digest: { algorithm: "sha256" as const, digest: "c".repeat(64) },
      },
    },
  };
}

function protocolScope() {
  return {
    scope_snapshot_ref: SCOPE_REF,
    protocol_digest: "d".repeat(64),
    denominator_digest: "e".repeat(64),
    protocol_profile: { question: QUESTION },
    coverage_denominator: {
      expires_at: SCOPE.expires_at,
      eligible_source_revision_refs: [...SCOPE.member_source_revision_refs],
    },
  };
}

function traceFor(product: "RESEARCH" | "FAST_SEARCH", managed: boolean) {
  const base = {
    trace_ref: { id: "query-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", revision: 1 },
    raw_query: QUESTION,
    scope_snapshot: SCOPE,
    query_product: product,
    lanes_used: ["SEM"] as const,
    lanes_skipped: [],
    exact_probes: [],
    index_generations: ["index-generation-1"],
    context_expansion: product === "RESEARCH" ? 2 : 0,
    candidates_by_lane: {
      IDENT: 0, EXACT: 0, LEX: 0, SEM: 1, LITERAL: 0, SOURCECARD: 0, ATLAS: 0, ATOM: 0,
      ARGUMENT: 0, STRUCTURE: 0, WEB: 0, VERIFY: 0, EXHAUSTIVE: 0, WIKI: 0, ARTIFACT: 0, CODE: 0,
    },
    expansion_refs: [],
    represented_source_refs: [],
    omitted_sources: [],
    stale_or_degraded_channels: [],
    budget_receipt_ref: "budget-receipt-1",
    evidence_pack_ref: "pack-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  };
  return managed
    ? {
        ...base,
        protocol: MANAGED_RETRIEVAL_TRACE_PROTOCOL,
        managed_ranking_outcomes: [{
          protocol: MANAGED_RANKING_OUTCOME_PROTOCOL,
          provider: "cloudflare_ai_search",
          request_digest: "f".repeat(64),
          scoped_invocation_id: "invocation-1",
          provider_execution_identity: {
            available: false,
            provider_execution_id: null,
            reason: "BINDING_RESPONSE_HAS_NO_EXECUTION_ID",
          },
          output_digest: "1".repeat(64),
          provider_authority: {
            namespace: "eliotr", instance_id: "private-prose-g2", registry_revision: 1,
            registry_artifact_sha256: "2".repeat(64),
          },
          authority_generations: {
            policy_generation: null, execution_generation: null, index_generation: "index-generation-1",
            query_compiler_generation: null,
          },
          executed_query: QUESTION,
          contributing_signals: [{ signal: "VECTOR", basis: "EXECUTED_QUERY" }],
          list_semantics: "ONE_PHYSICAL_MANAGED_LIST",
          scope_absence_proven: false,
          rerank_requested: false,
          rerank_attempted: false,
          rerank_succeeded: false,
          rerank_provider: null,
          rerank_model: null,
          fallback_used: false,
          failure_class: null,
          processing_state: "NO_HIT",
          ordered_candidates: [],
        }],
      }
    : base;
}

function checkpointFor(trace: ReturnType<typeof traceFor>, digest: string) {
  return {
    protocol: "eliotr.research.retrieve-branches.v1" as const,
    workflow_stage: "RETRIEVE_BRANCHES" as const,
    operation_id: "budget-operation",
    investigation_ref: { id: "budget-investigation", revision: 7 },
    principal_ref: PRINCIPAL.principal_ref,
    scope_snapshot_ref: SCOPE_REF,
    protocol_digest: protocolScope().protocol_digest,
    denominator_digest: protocolScope().denominator_digest,
    retrieval_request_digest: digest,
    evidence_pack: {
      pack_ref: { id: trace.evidence_pack_ref, revision: 1 },
      scope_snapshot_ref: SCOPE_REF,
      resolved_evidence: [],
      omitted_candidates: [],
      trace_ref: trace.trace_ref,
      total_utf8_bytes: 0,
    },
    trace,
    coverage_claim: "SAMPLED" as const,
  };
}

function dependencies(budgets?: RetrievalRequestBudgets): RetrieveBranchesStageDependencies {
  const navigation = {
    scope: SCOPE,
    access: ACCESS,
    current: vi.fn(async () => ({ current: true })),
  } as unknown as RetrieveBranchesStageDependencies["navigation"];
  return {
    database: {} as D1Database,
    search_database: {} as D1Database,
    work_bucket: {} as R2Bucket,
    evidence_bucket: {} as R2Bucket,
    access: ACCESS,
    navigation,
    ledger: { read: vi.fn() } as unknown as RetrieveBranchesStageDependencies["ledger"],
    profile: PROFILE as RetrieveBranchesStageDependencies["profile"],
    ...(budgets === undefined ? {} : { budgets }),
  };
}

function configureStageReads(generation: string = BRANCH_QUERY_HANDLER_GENERATION) {
  const stage0 = stageRequest("FREEZE_PROTOCOL_AND_SCOPE", 1, generation);
  const stage5 = stageRequest("RETRIEVE_BRANCHES", 7, generation);
  seams.readCommittedStageRequest.mockImplementation(async (_operationId: string, stage: string) => {
    if (stage === "FREEZE_PROTOCOL_AND_SCOPE") {
      return { request: stage0, request_sha256: "a".repeat(64), attempt_ref: "stage-zero-attempt" };
    }
    if (stage === "RETRIEVE_BRANCHES") {
      return { request: stage5, request_sha256: "b".repeat(64), attempt_ref: "stage-five-attempt" };
    }
    return null;
  });
  seams.readFreeze.mockResolvedValue(protocolScope());
  seams.heldScope.mockResolvedValue({ scope_snapshot_ref: SCOPE_REF, scope_snapshot: SCOPE });
  seams.readReceipt.mockResolvedValue({
    request_sha256: "b".repeat(64),
    attempt_ref: "stage-five-attempt",
    output_manifest: { object_ref: "stage-five-output", sha256: "c".repeat(64), byte_length: 1 },
  });
  return { stage0, stage5 };
}

async function configureReadback(input: {
  readonly product: "RESEARCH" | "FAST_SEARCH";
  readonly managed: boolean;
  readonly budgets?: RetrievalRequestBudgets;
  readonly storedDigestKind: "budgeted" | "legacy";
  readonly handlerGeneration?: string;
}) {
  const generation = input.handlerGeneration ?? BRANCH_QUERY_HANDLER_GENERATION;
  const { stage5 } = configureStageReads(generation);
  const trace = traceFor(input.product, input.managed);
  const requestDigestInput = {
    raw_query: QUESTION,
    product: input.product,
    literals: [],
    requested_limit: PROFILE.max_results,
    scope_digest: SCOPE.digest,
  };
  const digestWithBudgets = await retrievalRequestDigest({
    ...requestDigestInput,
    ...(input.budgets === undefined ? {} : { budgets: input.budgets }),
  });
  const legacyDigest = await retrievalRequestDigest(requestDigestInput);
  const checkpoint = checkpointFor(trace, input.storedDigestKind === "budgeted" ? digestWithBudgets : legacyDigest);
  const checkpointBytes = new TextEncoder().encode(JSON.stringify(checkpoint));
  seams.readWorkflowObject.mockResolvedValue(checkpointBytes);
  seams.requireProfileBinding.mockResolvedValue(undefined);
  seams.loadStoredResult.mockResolvedValue({
    idempotency_key: `retrieve-branches:${await textDigest(JSON.stringify(stage5))}`,
    request_digest: checkpoint.retrieval_request_digest,
    result: { evidence_pack: checkpoint.evidence_pack, trace: checkpoint.trace, coverage_claim: checkpoint.coverage_claim },
  });
  return { stage5, trace, checkpoint, dependencies: dependencies(input.budgets) };
}

beforeEach(() => {
  vi.clearAllMocks();
  seams.readerRetrieve = undefined;
  configureStageReads();
  seams.retrieve.mockResolvedValue({
    evidence_pack: {
      pack_ref: { id: "pack-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", revision: 1 },
      scope_snapshot_ref: SCOPE_REF, resolved_evidence: [], omitted_candidates: [],
      trace_ref: { id: "query-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", revision: 1 }, total_utf8_bytes: 0,
    },
    trace: traceFor("RESEARCH", true),
    coverage_claim: "SAMPLED",
  });
  configureStageReads();
});

describe("initial retrieval budget handoff", () => {
  it("passes the exact server tuple into V9 retrieval and binds it into the checkpoint digest", async () => {
    const deps = dependencies(BUDGETS);
    const request = stageRequest("RETRIEVE_BRANCHES", 7);
    const handler = createRetrieveBranchesStageHandler(deps);
    const bytes = await handler({ request, principal: PRINCIPAL, input_bytes: new Uint8Array(), attempt_ref: "retrieve-attempt", budget_receipt_ref: "workflow-budget" });
    const input = seams.retrieve.mock.calls[0]?.[1] as { budgets?: RetrievalRequestBudgets };
    const output = JSON.parse(new TextDecoder().decode(bytes)) as { retrieval_request_digest: string };
    expect(input.budgets).toEqual(BUDGETS);
    expect(input.budgets).not.toBe(BUDGETS);
    expect(output.retrieval_request_digest).toBe(await retrievalRequestDigest({
      raw_query: QUESTION, product: "RESEARCH", literals: [], requested_limit: PROFILE.max_results,
      scope_digest: SCOPE.digest, budgets: BUDGETS,
    }));
  });

  it("fails V9 without captured budgets before retrieval dispatch", async () => {
    const handler = createRetrieveBranchesStageHandler(dependencies());
    await expect(handler({
      request: stageRequest("RETRIEVE_BRANCHES", 7), principal: PRINCIPAL,
      input_bytes: new Uint8Array(), attempt_ref: "retrieve-attempt", budget_receipt_ref: "workflow-budget",
    })).rejects.toMatchObject({ code: "WORKFLOW_CONFIGURATION_MISSING" });
    expect(seams.retrieve).not.toHaveBeenCalled();
  });

  it("assembles the same captured tuple into the V9 semantic stage-5 reader", () => {
    const base = semanticWorkflowInput();
    createResearchSemanticWorkflowHandlerFactory(base);
    expect(seams.readerRetrieve).toMatchObject({ budgets: BUDGETS });
    expect((seams.readerRetrieve as { budgets: RetrievalRequestBudgets }).budgets).not.toBe(BUDGETS);
  });

  it("recomputes managed readback digest with budgets and rejects no-budget or missing-budget variants", async () => {
    const managed = await configureReadback({ product: "RESEARCH", managed: true, budgets: BUDGETS, storedDigestKind: "budgeted" });
    await expect(readRetrieveBranchesCheckpoint(managed.dependencies, stageRequest("FREEZE_EVIDENCE", 8), PRINCIPAL))
      .resolves.toMatchObject({ checkpoint: managed.checkpoint });

    const noBudgetStored = await configureReadback({ product: "RESEARCH", managed: true, budgets: BUDGETS, storedDigestKind: "legacy" });
    await expect(readRetrieveBranchesCheckpoint(noBudgetStored.dependencies, stageRequest("FREEZE_EVIDENCE", 8), PRINCIPAL))
      .rejects.toMatchObject({ code: "WORKFLOW_OUTPUT_CORRUPT" });

    const missingCapture = await configureReadback({ product: "RESEARCH", managed: true, storedDigestKind: "legacy" });
    await expect(readRetrieveBranchesCheckpoint(missingCapture.dependencies, stageRequest("FREEZE_EVIDENCE", 8), PRINCIPAL))
      .rejects.toMatchObject({ code: "WORKFLOW_CONFIGURATION_MISSING" });
  });

  it("validates a budgeted V9 legacy trace with the budgeted digest when SEM was not managed", async () => {
    const budgetedLegacy = await configureReadback({
      product: "RESEARCH", managed: false, budgets: BUDGETS, storedDigestKind: "budgeted",
    });
    await expect(readRetrieveBranchesCheckpoint(
      budgetedLegacy.dependencies, stageRequest("FREEZE_EVIDENCE", 8), PRINCIPAL,
    )).resolves.toMatchObject({ checkpoint: budgetedLegacy.checkpoint });
  });

  it("keeps managed V9 strict to RESEARCH and preserves both historical no-budget products", async () => {
    const managedFastSearch = await configureReadback({ product: "FAST_SEARCH", managed: true, budgets: BUDGETS, storedDigestKind: "legacy" });
    await expect(readRetrieveBranchesCheckpoint(managedFastSearch.dependencies, stageRequest("FREEZE_EVIDENCE", 8), PRINCIPAL))
      .rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });

    for (const product of ["FAST_SEARCH", "RESEARCH"] as const) {
      const historical = await configureReadback({ product, managed: false, budgets: BUDGETS, storedDigestKind: "legacy" });
      await expect(readRetrieveBranchesCheckpoint(historical.dependencies, stageRequest("FREEZE_EVIDENCE", 8), PRINCIPAL))
        .resolves.toMatchObject({ checkpoint: historical.checkpoint });
    }
  });
});

const POLICY = {
  version: 1 as const, transport: "cloudflare-ai-gateway" as const, api: "openai-responses" as const,
  provider: "openai" as const, model: "openai/gpt-4.1-mini", billing: { mode: "byok" as const, alias: "default" },
  capabilities: { max_output_tokens_field: "max_output_tokens" as const, reasoning_efforts: ["high"] as const },
};
const branchBudgetSelection: ResearchBranchQueryBudgetSelection = {
  protocol: "eliotr.research.branch-query-budget-selection.v1",
  profile_id: "branch-profile-test",
  profile_generation: 2,
  budgets: { ...BUDGETS, max_query_legs: 3 },
  selected_configuration: {
    owner_ref: PRINCIPAL.principal_ref,
    project_id: "budget-project",
    configuration_ref: `rpmc-${"a".repeat(64)}`,
    configuration_sha256: "a".repeat(64),
    selection_revision: 7,
  },
};

function semanticWorkflowInput() {
  const unavailable = () => { throw new Error("factory construction must not perform effects"); };
  const prompt = { trusted_parameters: { prompt: "Use evidence.", max_tokens: 64 }, request_timeout_ms: 1000,
    selected_transport_policy: POLICY, request_capabilities: POLICY.capabilities };
  const stage = () => ({ gateway: { reasoning_gateway_base_url: "https://gateway.invalid", gateway_token: "test" },
    prompt, spend_authorization: { read: unavailable }, prepare: unavailable });
  return {
    database: { prepare: unavailable }, search_database: { prepare: unavailable },
    work_bucket: { head: unavailable, get: unavailable }, evidence_bucket: { get: unavailable },
    navigation: { scope: SCOPE, access: ACCESS, current: unavailable, sources: unavailable },
    ledger: { read: unavailable }, operation_id: "budget-operation", investigation_id: "budget-investigation",
    principal: PRINCIPAL, ai_search: {}, retrieval_profile: PROFILE,
    model_profile: { raw: "{}", provenance_ref: "profile-test" },
    semantic_config: { revision_ref: null, config_sha256: "a".repeat(64) }, deployment_environment: "TEST",
    recheck_authority: unavailable,
    manifest: { store: { get: unavailable }, residency_template: { scope_domain_id: SCOPE.snapshot_id,
      access_domain_id: PRINCIPAL.principal_ref }, max_context_bytes: 1024 },
    model: { synthesis: stage(), audit: stage() }, verification: { config: {} },
    audit: { normalization: { section_ref: { id: "section-test", revision: 1 }, required_precision: "exact",
      required_source_class: "primary" }, verifier: { authority: { allowed_verifier_refs: ["verifier-test"],
      verifier_ref: "verifier-test", verifier_schema_generation: "verifier-schema-test", deployment: {
        route_ref: "dynamic/eliotr-economy", route_version: "v1", prompt_generation: "prompt-test",
        schema_generation: "schema-test", parameters_digest: "a".repeat(64), pricing_snapshot_ref: "pricing-test" },
      deployment_generation: PRINCIPAL.deployment_generation, qualification_receipt_ref: "qualification-test",
      qualification_expires_at: "2030-01-01T00:00:00.000Z", qualified: true, current: true }, read_current: unavailable },
      policy: { required_dimensions: [], source_requirement_applicable: true, excerpt_requirement_applicable: true,
        coverage_limitations: [], unsupported_precision: [] } },
    handler_generation: SERVER_OWNED_BRANCH_QUERY_HANDLER_GENERATION,
    run_configuration: { mode: "snapshot-v2" as const, configuration_ref: "run-configuration-1",
      configuration_sha256: "b".repeat(64), project_owner_ref: PRINCIPAL.principal_ref,
      project_id: "budget-project", project_configuration_ref: branchBudgetSelection.selected_configuration.configuration_ref,
      project_configuration_sha256: branchBudgetSelection.selected_configuration.configuration_sha256,
      model_selections: [] },
    branch_query_budget_selection: branchBudgetSelection,
    report: {} as never,
  } as never;
}
