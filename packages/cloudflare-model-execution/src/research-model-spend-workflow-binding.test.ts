/// <reference types="node" />
import { describe, expect, it } from "vitest";
import type { ResearchBranchRole } from "@eliotr/contracts";
import type { NavigationReadAuthority } from "@eliotr/cloudflare-evidence";
import { StageRequestSchema, textDigest } from "@eliotr/cloudflare-workflows";
import { deriveModelAttemptIdentity, type ModelAttemptPreparationContext } from "./model-attempt-handler.js";
import { ModelAttemptError } from "./model-attempt-types.js";
import type { ResearchModelSpendAdmissionInput } from "./research-model-spend-admission.js";
import {
  createResearchModelSpendPolicyService,
  readResearchModelSpendPolicy,
  type ResearchModelSpendPolicy,
} from "./research-model-spend-policy.js";

// S40 prerequisite for migration 0139: the durable admission row must persist the
// exact W2 stage-level request digest, because the 0139 trigger binds
// NEW.workflow_stage_request_sha256 against the W2 attempt digest for stages
// 8/9 and forbids that value on every other stage. These cases drive the real
// admission port and the real policy service, so the causal write and readback
// path is proven rather than a mirrored column list.

const SHA = "b".repeat(64);
const FUTURE = "2030-01-01T00:00:00.000Z";
const NOW = Date.parse("2026-10-01T12:00:00.000Z");
const PRINCIPAL = { principal_ref: "principal-1", credential_generation: "cred-1", deployment_generation: "dep-1" };
type StageName = "ANALYZE_BRANCHES" | "COUNTER_SEARCH" | "SYNTHESIZE";
type BranchRole = "SUPPORT" | "COUNTER";
interface Row { readonly [key: string]: unknown }

function stageRequest(stage: StageName) {
  return StageRequestSchema.parse({
    protocol: "eliotr.workflow-stage.v1",
    operation_id: "op-1",
    investigation_ref: { id: "inv-1", revision: 2 },
    stage,
    idempotency_key: "op-1:" + stage,
    handler_generation: "gen-1",
    input_manifest: {
      object_ref: "objects/k",
      sha256: SHA,
      byte_length: 4,
      residency: {
        scope_domain_id: "scope",
        access_domain_id: "access",
        confidentiality_domain_id: "conf",
        encryption_key_domain_id: "enc",
        retention_domain_id: "ret",
        erasure_domain_id: "erase",
        content_digest: { algorithm: "sha256", digest: SHA },
      },
    },
  });
}

function rule(stage: string) {
  return {
    stage,
    deployment: {
      route_ref: "dynamic/eliotr-economy",
      route_version: "v1",
      prompt_generation: "pg-1",
      schema_generation: "sg-1",
      parameters_digest: "a".repeat(64),
      pricing_snapshot_ref: "price-1",
    },
    max_input_bytes: 1024,
    max_output_bytes: 1024,
    quote: {
      estimated_model_calls: 1,
      estimated_input_tokens: 10,
      estimated_output_tokens: 10,
      estimated_embedding_tokens: 0,
      quoted_neurons: 0,
      platform_usd: 0,
      workers_ai_usd: 0,
      byok_usd: 0,
      max_total_usd: 0.01,
      workflow_steps: 1,
      expected_sources: 1,
      expected_sections: 1,
      confidence: 0.5,
    },
  };
}

function policy(): ResearchModelSpendPolicy {
  return readResearchModelSpendPolicy(
    JSON.stringify({
      protocol: "eliotr.research-model-spend-policy.v1",
      approved: true,
      policy_ref: "policy-1",
      config_provenance_ref: "test-provenance",
      principal_ref: "principal-1",
      client_class: "owner_pwa",
      credential_generation: "cred-1",
      deployment_generation: "dep-1",
      policy_generation: "polgen-1",
      policy_authority_ref: "auth-1",
      expires_at: FUTURE,
      rules: [rule("ANALYZE_BRANCHES"), rule("COUNTER_SEARCH"), rule("SYNTHESIZE"), rule("AUDIT_CLAIMS")],
    }),
    "test-provenance",
  );
}

async function currentRow(stageJson: string, stageIndex: number): Promise<Row> {
  return {
    operation_id: "op-1",
    principal_ref: "principal-1",
    credential_generation: "cred-1",
    deployment_generation: "dep-1",
    policy_generation: "polgen-1",
    policy_authority_ref: "auth-1",
    authorization_receipt_ref: "authz-1",
    scope_snapshot_id: "scope-1",
    scope_snapshot_revision: 1,
    purge_revision: 1,
    stage_index: stageIndex,
    attempt_ref: "attempt-1",
    request_sha256: await textDigest(stageJson),
    request_json: stageJson,
    budget_receipt_ref: "budget-1",
    budget_expires_at_ms: Date.parse(FUTURE),
    grant_expires_at: FUTURE,
    scope_expires_at: FUTURE,
    started_at: "2026-10-01T09:00:00.000Z",
  };
}

const GRANT = {
  authorization_receipt_ref: "authz-1",
  policy_authority_ref: "auth-1",
  allowed_use: ["research"],
  disclosure_ceiling: "EXACT",
  expires_at: FUTURE,
};

const NAVIGATION = {
  scope: { snapshot_id: "scope-1", revision: 1, digest: SHA },
  access: { principal_ref: "principal-1", client_class: "owner_pwa", credential_generation: "cred-1" },
  current: async () => GRANT,
  sources: async () => [],
  timestamp: () => new Date(NOW).toISOString(),
} as unknown as NavigationReadAuthority;

/**
 * D1 stand-in that rebuilds stored rows from the production INSERT column list,
 * so a missing or misplaced bind is a readback failure instead of a silently
 * dropped value. It honors ON CONFLICT(operation_id,stage_index) DO NOTHING.
 */
function mockDatabase(row: Row | null) {
  const inserted: Record<string, unknown>[] = [];
  const byKey = new Map<string, Record<string, unknown>>();
  const database = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return {
            async first<T>(): Promise<T | null> {
              if (sql.startsWith("SELECT r.operation_id")) return (row ?? null) as T | null;
              if (sql.startsWith("INSERT INTO research_model_spend_admission")) {
                const columns = /INSERT INTO research_model_spend_admission\(([^)]+)\)/.exec(sql)?.[1] ?? "";
                const names = columns.split(",");
                const key = String(params[1]) + ":" + String(params[3]);
                if (byKey.has(key)) return null;
                const stored: Record<string, unknown> = {};
                names.forEach((name, index) => { stored[name] = params[index]; });
                byKey.set(key, stored);
                inserted.push(stored);
                return stored as T;
              }
              if (sql.startsWith("SELECT authorization_ref,operation_id")) {
                return (byKey.get(String(params[0]) + ":" + String(params[1])) ?? null) as T | null;
              }
              if (sql.startsWith("SELECT authorization_ref FROM research_model_spend_admission")) {
                const found = inserted.find((candidate) => candidate.authorization_ref === params[0]);
                return (found === undefined ? null : { authorization_ref: found.authorization_ref }) as T | null;
              }
              throw new Error("unexpected SQL: " + sql.slice(0, 60));
            },
          };
        },
      };
    },
  };
  return { database: database as unknown as D1Database, inserted };
}

async function setup(stage: StageName) {
  const stageJson = JSON.stringify(stageRequest(stage));
  const stageIndex = stage === "ANALYZE_BRANCHES" ? 8 : stage === "COUNTER_SEARCH" ? 9 : 12;
  const row = await currentRow(stageJson, stageIndex);
  const { database, inserted } = mockDatabase(row);
  const spendPolicy = policy();
  const service = createResearchModelSpendPolicyService({
    database,
    navigation: NAVIGATION,
    operation_id: "op-1",
    policy: spendPolicy,
    deployment_registry: {
      resolve: async (route: string) =>
        spendPolicy.rules.find((value) => value.deployment.route_ref === route)?.deployment ?? null,
    },
    now: () => NOW,
  });
  return { service, stageJson, stageIndex: stageIndex as 8 | 9 | 12, inserted };
}

/** Role-scoped preparation context for a branch stage, as the executor supplies it. */
async function branchContext(stageJson: string, role: BranchRole) {
  const parsed = StageRequestSchema.parse(JSON.parse(stageJson));
  const roleRequest = StageRequestSchema.parse({
    ...JSON.parse(stageJson),
    idempotency_key: parsed.idempotency_key + ":branch-role:" + role,
  });
  const roleSha = await textDigest(JSON.stringify(roleRequest));
  const identity = await deriveModelAttemptIdentity({
    stage_request_sha256: roleSha,
    principal_ref: PRINCIPAL.principal_ref,
    credential_generation: PRINCIPAL.credential_generation,
    deployment_generation: PRINCIPAL.deployment_generation,
  });
  const deployment = policy().rules.find((value) => value.stage === parsed.stage)?.deployment;
  if (deployment === undefined) throw new Error("no deployment for stage");
  const context = {
    request: roleRequest,
    principal: PRINCIPAL,
    input_bytes: new TextEncoder().encode("input"),
    attempt_ref: "attempt-1",
    budget_receipt_ref: "budget-1",
    model_output_object_ref: "outputs/model",
    stage_request_sha256: roleSha,
    model_operation_id: identity.operation_id,
    model_idempotency_key: identity.idempotency_key,
  } satisfies ModelAttemptPreparationContext;
  return { context, roleSha, deployment };
}

async function admitBranchRole(
  service: Awaited<ReturnType<typeof setup>>["service"],
  stageJson: string,
  role: BranchRole,
  stageSha?: string,
) {
  const { context, deployment } = await branchContext(stageJson, role);
  return service.admitBranchRole({
    stage_request: StageRequestSchema.parse(JSON.parse(stageJson)),
    stage_request_sha256: stageSha ?? (await textDigest(stageJson)),
    role_context: context,
    role,
    deployment,
  });
}

async function admitSynthesis(service: Awaited<ReturnType<typeof setup>>["service"], stageJson: string) {
  const stageSha = await textDigest(stageJson);
  const identity = await deriveModelAttemptIdentity({
    stage_request_sha256: stageSha,
    principal_ref: PRINCIPAL.principal_ref,
    credential_generation: PRINCIPAL.credential_generation,
    deployment_generation: PRINCIPAL.deployment_generation,
  });
  const deployment = policy().rules.find((value) => value.stage === "SYNTHESIZE")?.deployment;
  if (deployment === undefined) throw new Error("no synthesis deployment");
  return service.admit(
    {
      request: StageRequestSchema.parse(JSON.parse(stageJson)),
      principal: PRINCIPAL,
      input_bytes: new TextEncoder().encode("input"),
      attempt_ref: "attempt-1",
      budget_receipt_ref: "budget-1",
      model_output_object_ref: "outputs/model",
      stage_request_sha256: stageSha,
      model_operation_id: identity.operation_id,
      model_idempotency_key: identity.idempotency_key,
    },
    deployment,
  );
}

async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ModelAttemptError);
    return (error as ModelAttemptError).code;
  }
  throw new Error("expected the call to fail closed");
}

/** Rebuild the port input from a stored row so the port can be driven directly. */
function admissionInputFromRow(
  row: Record<string, unknown>,
  stageJson: string,
  stageIndex: 8 | 9 | 12,
): ResearchModelSpendAdmissionInput {
  const workflowStageSha = row.workflow_stage_request_sha256;
  const branchStage = stageIndex === 8 || stageIndex === 9;
  return {
    request: {
      operation_id: row.operation_id as string,
      principal_ref: row.principal_ref as string,
      stage_attempt_ref: row.stage_attempt_ref as string,
      stage_request_sha256: row.stage_request_sha256 as string,
      reservation_id: row.reservation_id as string,
      quote_ref: row.quote_ref as string,
      route_ref: row.route_ref as string,
      scope_snapshot_ref: { id: row.scope_snapshot_id as string, revision: row.scope_snapshot_revision as number },
      workflow_authorization_receipt_ref: row.workflow_authorization_receipt_ref as string,
      ...(branchStage && typeof workflowStageSha === "string" ? { workflow_stage_request_sha256: workflowStageSha } : {}),
    },
    workflow_operation_id: row.workflow_operation_id as string,
    stage_index: stageIndex,
    ...(row.role === null ? {} : { role: row.role as ResearchBranchRole }),
    stage_request_json: stageJson,
    ...(branchStage && typeof workflowStageSha === "string" ? { workflow_stage_request_sha256: workflowStageSha } : {}),
    workflow_budget_receipt_ref: row.workflow_budget_receipt_ref as string,
    intent: JSON.parse(row.intent_json as string),
    quote: JSON.parse(row.quote_json as string),
    authority: JSON.parse(row.authority_json as string),
    expected_deployment: JSON.parse(row.expected_deployment_json as string),
    approval: JSON.parse(row.approval_json as string),
    max_input_bytes: row.max_input_bytes as number,
    max_output_bytes: row.max_output_bytes as number,
  };
}

describe("research model spend workflow stage binding", () => {
  it("persists the exact W2 stage digest on a branch role admission", async () => {
    const { service, stageJson, inserted } = await setup("ANALYZE_BRANCHES");
    const { context, roleSha, deployment } = await branchContext(stageJson, "SUPPORT");
    const record = await service.admitBranchRole({
      stage_request: StageRequestSchema.parse(JSON.parse(stageJson)),
      stage_request_sha256: await textDigest(stageJson),
      role_context: context,
      role: "SUPPORT",
      deployment,
    });
    const stageSha = await textDigest(stageJson);
    expect(record.stage_index).toBe(8);
    expect(record.role).toBe("SUPPORT");
    // The role-scoped sha and the stage-level W2 sha are different values, and
    // the durable row must carry the stage-level one the SQL guard reads.
    expect(record.stage_request_sha256).toBe(roleSha);
    expect(record.workflow_stage_request_sha256).toBe(stageSha);
    expect(record.workflow_stage_request_sha256).not.toBe(record.stage_request_sha256);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.workflow_stage_request_sha256).toBe(stageSha);
  });

  it("keeps the COUNTER binding reproducible on stage 9", async () => {
    const { service, stageJson, inserted } = await setup("COUNTER_SEARCH");
    const { context, roleSha, deployment } = await branchContext(stageJson, "COUNTER");
    const record = await service.admitBranchRole({
      stage_request: StageRequestSchema.parse(JSON.parse(stageJson)),
      stage_request_sha256: await textDigest(stageJson),
      role_context: context,
      role: "COUNTER",
      deployment,
    });
    expect(record.stage_index).toBe(9);
    expect(record.role).toBe("COUNTER");
    expect(record.stage_request_sha256).toBe(roleSha);
    expect(record.workflow_stage_request_sha256).toBe(await textDigest(stageJson));
    expect(inserted).toHaveLength(1);
  });

  it("stores no workflow stage digest for a synthesis admission", async () => {
    const { service, stageJson, inserted } = await setup("SYNTHESIZE");
    await admitSynthesis(service, stageJson);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.stage_index).toBe(12);
    expect(inserted[0]?.workflow_stage_request_sha256 ?? null).toBeNull();
  });

  it("keeps a branch admission idempotent with the persisted digest", async () => {
    const { service, stageJson, inserted } = await setup("ANALYZE_BRANCHES");
    const first = await admitBranchRole(service, stageJson, "SUPPORT");
    const second = await admitBranchRole(service, stageJson, "SUPPORT");
    expect(second.admission_sha256).toBe(first.admission_sha256);
    expect(second.workflow_stage_request_sha256).toBe(first.workflow_stage_request_sha256);
    expect(inserted).toHaveLength(1);
  });

  it("rejects a branch admission whose stage digest does not match its W2 bytes", async () => {
    const { service, stageJson } = await setup("ANALYZE_BRANCHES");
    expect(await errorCode(admitBranchRole(service, stageJson, "SUPPORT", "f".repeat(64))))
      .toBe("MODEL_ATTEMPT_REQUEST_MISMATCH");
  });

  it("fails closed when a branch admission omits the stage digest", async () => {
    const { service, stageJson, inserted } = await setup("ANALYZE_BRANCHES");
    await admitBranchRole(service, stageJson, "SUPPORT");
    const input = admissionInputFromRow(inserted[0] as Record<string, unknown>, stageJson, 8);
    delete (input as { workflow_stage_request_sha256?: string }).workflow_stage_request_sha256;
    delete (input.request as { workflow_stage_request_sha256?: string }).workflow_stage_request_sha256;
    expect(await errorCode(service.admissions.admit(input))).toBe("MODEL_ATTEMPT_INPUT_INVALID");
  });

  it("fails closed when a synthesis admission carries a stage digest", async () => {
    const { service, stageJson, inserted } = await setup("SYNTHESIZE");
    await admitSynthesis(service, stageJson);
    const input = admissionInputFromRow(inserted[0] as Record<string, unknown>, stageJson, 12);
    const withDigest = { ...input, workflow_stage_request_sha256: await textDigest(stageJson) };
    expect(await errorCode(service.admissions.admit(withDigest))).toBe("MODEL_ATTEMPT_INPUT_INVALID");
  });
});
