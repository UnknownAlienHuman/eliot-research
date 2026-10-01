import { describe, expect, it } from "vitest";
import { StageRequestSchema, textDigest, type StageRequest } from "@eliotr/cloudflare-workflows";
import type { NavigationReadAuthority } from "@eliotr/cloudflare-evidence";
import type { ResearchBranchRole } from "@eliotr/contracts";
import { deriveModelAttemptIdentity, type ModelAttemptPreparationContext } from "./model-attempt-handler.js";
import { ModelAttemptError } from "./model-attempt-types.js";
import { deriveBranchRoleStageRequest } from "./research-branch-role-model.js";
import type { ResearchModelSpendAdmissionInput } from "./research-model-spend-admission.js";
import {
  createResearchModelSpendPolicyService,
  readResearchModelSpendPolicy,
  type ResearchModelSpendPolicy,
} from "./research-model-spend-policy.js";

const SHA = "b".repeat(64);
const FUTURE = "2030-01-01T00:00:00.000Z";
const NOW = Date.parse("2026-10-01T12:00:00.000Z");
const PRINCIPAL = { principal_ref: "principal-1", credential_generation: "cred-1", deployment_generation: "dep-1" };

// Mirrors COLUMNS in research-model-spend-admission.ts (role sits at index 7,
// right after stage_request_json). The mock D1 below rebuilds stored rows by
// this order.
const COLUMN_ORDER = [
  "authorization_ref", "operation_id", "workflow_operation_id", "stage_index", "stage_attempt_ref",
  "stage_request_sha256", "stage_request_json", "role", "workflow_budget_receipt_ref", "intent_id",
  "intent_revision", "intent_json", "reservation_id", "quote_ref", "quote_json", "authority_json",
  "principal_ref", "client_class", "credential_generation", "deployment_generation", "policy_decision_ref",
  "policy_generation", "currentness_digest", "scope_snapshot_id", "scope_snapshot_revision",
  "workflow_authorization_receipt_ref", "route_ref", "expected_deployment_json", "approval_json",
  "admission_revision", "admission_sha256", "decision_digest", "max_input_bytes", "max_output_bytes",
  "expires_at", "created_at",
] as const;

const OBJECT = {
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
};

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

function stageRequest(stage: "ANALYZE_BRANCHES" | "COUNTER_SEARCH" | "SYNTHESIZE"): StageRequest {
  return StageRequestSchema.parse({
    protocol: "eliotr.workflow-stage.v1",
    operation_id: "op-1",
    investigation_ref: { id: "inv-1", revision: 2 },
    stage,
    idempotency_key: `op-1:${stage}`,
    handler_generation: "gen-1",
    input_manifest: OBJECT,
  });
}

const STAGE_INDEX = { ANALYZE_BRANCHES: 8, COUNTER_SEARCH: 9, SYNTHESIZE: 12 } as const;

interface CurrentRow {
  readonly [key: string]: unknown;
}

async function currentRow(stageJson: string, stageIndex: number): Promise<CurrentRow> {
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

/** In-memory D1 stand-in: honors ON CONFLICT(operation_id,stage_index) DO NOTHING. */
function mockDatabase(row: CurrentRow | null) {
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
                const key = `${params[1]}:${params[3]}`;
                if (byKey.has(key)) return null; // conflict: DO NOTHING
                const stored: Record<string, unknown> = {};
                COLUMN_ORDER.forEach((column, index) => {
                  stored[column] = params[index];
                });
                byKey.set(key, stored);
                inserted.push(stored);
                return stored as T;
              }
              if (sql.startsWith("SELECT authorization_ref,operation_id")) {
                return (byKey.get(`${params[0]}:${params[1]}`) ?? null) as T | null;
              }
              if (sql.startsWith("SELECT authorization_ref FROM research_model_spend_admission")) {
                const found = inserted.find((candidate) => candidate.authorization_ref === params[0]);
                return (found === undefined ? null : { authorization_ref: found.authorization_ref }) as T | null;
              }
              throw new Error(`unexpected SQL: ${sql.slice(0, 60)}`);
            },
          };
        },
      };
    },
  };
  return { database: database as unknown as D1Database, inserted };
}

const GRANT = {
  authorization_receipt_ref: "authz-1",
  policy_authority_ref: "auth-1",
  allowed_use: ["research"],
  disclosure_ceiling: "EXACT",
  expires_at: FUTURE,
};

const NAVIGATION = {
  scope: { snapshot_id: "scope-1", revision: 1, digest: "d".repeat(64) },
  access: { principal_ref: "principal-1", client_class: "owner_pwa", credential_generation: "cred-1" },
  current: async () => GRANT,
  sources: async () => [],
  timestamp: () => new Date(NOW).toISOString(),
} as unknown as NavigationReadAuthority;

async function setup(stage: "ANALYZE_BRANCHES" | "COUNTER_SEARCH" | "SYNTHESIZE") {
  const request = stageRequest(stage);
  const stageJson = JSON.stringify(request);
  const row = await currentRow(stageJson, STAGE_INDEX[stage]);
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
  return { service, request, stageJson, inserted, spendPolicy };
}

async function roleContext(role: ResearchBranchRole, request: StageRequest) {
  const roleRequest = deriveBranchRoleStageRequest(request, role);
  const roleSha = await textDigest(JSON.stringify(roleRequest));
  const identity = await deriveModelAttemptIdentity({
    stage_request_sha256: roleSha,
    principal_ref: PRINCIPAL.principal_ref,
    credential_generation: PRINCIPAL.credential_generation,
    deployment_generation: PRINCIPAL.deployment_generation,
  });
  const deployment = policy().rules.find((value) => value.stage === request.stage)?.deployment;
  if (deployment === undefined) throw new Error("no deployment for stage");
  return {
    context: {
      request: roleRequest,
      principal: PRINCIPAL,
      input_bytes: new TextEncoder().encode("input"),
      attempt_ref: "attempt-1",
      budget_receipt_ref: "budget-1",
      model_output_object_ref: "outputs/model",
      stage_request_sha256: roleSha,
      model_operation_id: identity.operation_id,
      model_idempotency_key: identity.idempotency_key,
    } satisfies ModelAttemptPreparationContext,
    roleSha,
    deployment,
  };
}

async function admitBranchRole(
  stage: "ANALYZE_BRANCHES" | "COUNTER_SEARCH",
  role: ResearchBranchRole,
  stageShaOverride?: string,
) {
  const { service, request, stageJson, inserted } = await setup(stage);
  const { context, roleSha, deployment } = await roleContext(role, request);
  const record = await service.admitBranchRole({
    stage_request: request,
    stage_request_sha256: stageShaOverride ?? (await textDigest(stageJson)),
    role_context: context,
    role,
    deployment,
  });
  return { service, record, roleSha, request, stageJson, inserted };
}

/** Rebuild the exact port input from a stored row so the port can be driven directly. */
async function inputFromRow(row: Record<string, unknown>): Promise<ResearchModelSpendAdmissionInput> {
  const stageIndex = row.stage_index as 8 | 9 | 12 | 13 | 14;
  const branchStage = stageIndex === 8 || stageIndex === 9;
  const rowRole = row.role as ResearchBranchRole | null;
  // Branch stages address the W2 authority by the stage-level request sha, both
  // on the read request and on the top-level admission input.
  const workflowStageSha = branchStage ? await textDigest(row.stage_request_json as string) : undefined;
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
      ...(workflowStageSha === undefined ? {} : { workflow_stage_request_sha256: workflowStageSha }),
    },
    workflow_operation_id: row.workflow_operation_id as string,
    stage_index: stageIndex,
    ...(rowRole === null ? {} : { role: rowRole }),
    stage_request_json: row.stage_request_json as string,
    ...(workflowStageSha === undefined ? {} : { workflow_stage_request_sha256: workflowStageSha }),
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

async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ModelAttemptError);
    return (error as ModelAttemptError).code;
  }
  throw new Error("expected the call to fail closed");
}

describe("spend policy service branch-role admission", () => {
  it("admits a branch role and binds the role into the durable record", async () => {
    const { record, roleSha, request } = await admitBranchRole("ANALYZE_BRANCHES", "SUPPORT");
    expect(record.role).toBe("SUPPORT");
    expect(record.stage_index).toBe(8);
    expect(record.stage_request_sha256).toBe(roleSha);
    expect(record.workflow_operation_id).toBe("op-1");
    expect(record.operation_id.startsWith("model-operation-")).toBe(true);
    expect(record.admission_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(request.stage).toBe("ANALYZE_BRANCHES");
  });

  it("admits COUNTER on COUNTER_SEARCH", async () => {
    const { record } = await admitBranchRole("COUNTER_SEARCH", "COUNTER");
    expect(record.role).toBe("COUNTER");
    expect(record.stage_index).toBe(9);
  });

  it("fails closed when COUNTER is admitted on ANALYZE_BRANCHES", async () => {
    await expect(admitBranchRole("ANALYZE_BRANCHES", "COUNTER")).rejects.toMatchObject({
      code: "WORKFLOW_CONFIGURATION_MISSING",
    });
  });

  it("fails closed when SUPPORT is admitted on COUNTER_SEARCH", async () => {
    await expect(admitBranchRole("COUNTER_SEARCH", "SUPPORT")).rejects.toMatchObject({
      code: "WORKFLOW_CONFIGURATION_MISSING",
    });
  });

  it("admits two roles on one stage concurrently with distinct operation ids", async () => {
    const first = await setup("ANALYZE_BRANCHES");
    const support = await roleContext("SUPPORT", first.request);
    const alternative = await roleContext("ALTERNATIVE", first.request);
    const stageSha = await textDigest(first.stageJson);
    const [supportRecord, alternativeRecord] = await Promise.all([
      first.service.admitBranchRole({
        stage_request: first.request,
        stage_request_sha256: stageSha,
        role_context: support.context,
        role: "SUPPORT",
        deployment: support.deployment,
      }),
      first.service.admitBranchRole({
        stage_request: first.request,
        stage_request_sha256: stageSha,
        role_context: alternative.context,
        role: "ALTERNATIVE",
        deployment: alternative.deployment,
      }),
    ]);
    expect(supportRecord.role).toBe("SUPPORT");
    expect(alternativeRecord.role).toBe("ALTERNATIVE");
    expect(supportRecord.operation_id).not.toBe(alternativeRecord.operation_id);
    expect(supportRecord.admission_sha256).not.toBe(alternativeRecord.admission_sha256);
    expect(first.inserted).toHaveLength(2);
    expect(first.inserted.map((row) => row.role).sort()).toEqual(["ALTERNATIVE", "SUPPORT"]);
  });

  it("is idempotent when the same role is admitted twice", async () => {
    const { service, request, stageJson, inserted } = await setup("ANALYZE_BRANCHES");
    const first = await roleContext("SUPPORT", request);
    const stageSha = await textDigest(stageJson);
    const input = {
      stage_request: request,
      stage_request_sha256: stageSha,
      role_context: first.context,
      role: "SUPPORT" as const,
      deployment: first.deployment,
    };
    const one = await service.admitBranchRole(input);
    const two = await service.admitBranchRole(input);
    expect(two.admission_sha256).toBe(one.admission_sha256);
    expect(two.operation_id).toBe(one.operation_id);
    expect(inserted).toHaveLength(1);
  });

  it("fails closed when the stage-level sha does not match the stage bytes", async () => {
    await expect(admitBranchRole("ANALYZE_BRANCHES", "SUPPORT", "f".repeat(64))).rejects.toMatchObject({
      code: "MODEL_ATTEMPT_REQUEST_MISMATCH",
    });
  });

  it("admits a synthesis stage through the service with no role bound", async () => {
    const { service, request, stageJson, inserted } = await setup("SYNTHESIZE");
    const stageSha = await textDigest(stageJson);
    const identity = await deriveModelAttemptIdentity({
      stage_request_sha256: stageSha,
      principal_ref: PRINCIPAL.principal_ref,
      credential_generation: PRINCIPAL.credential_generation,
      deployment_generation: PRINCIPAL.deployment_generation,
    });
    const deployment = policy().rules.find((value) => value.stage === "SYNTHESIZE")?.deployment;
    if (deployment === undefined) throw new Error("no synthesis deployment");
    await service.admit(
      {
        request,
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
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.role).toBeNull();
    expect(inserted[0]?.stage_index).toBe(12);
  });
});

describe("spend admission port role binding", () => {
  it("fails closed when a branch admission carries no role", async () => {
    const { service, inserted } = await admitBranchRole("ANALYZE_BRANCHES", "SUPPORT");
    const input = await inputFromRow(inserted[0] as Record<string, unknown>);
    const { role: _removed, ...withoutRole } = input;
    expect(await errorCode(service.admissions.admit(withoutRole))).toBe("MODEL_ATTEMPT_INPUT_INVALID");
  });

  it("fails closed when a branch admission carries a stage-incompatible role", async () => {
    const { service, inserted } = await admitBranchRole("ANALYZE_BRANCHES", "SUPPORT");
    const input = await inputFromRow(inserted[0] as Record<string, unknown>);
    expect(await errorCode(service.admissions.admit({ ...input, role: "COUNTER" }))).toBe(
      "MODEL_ATTEMPT_INPUT_INVALID",
    );
  });

  it("fails closed when a synthesis admission carries a role", async () => {
    const { service, request, stageJson, inserted } = await setup("SYNTHESIZE");
    const stageSha = await textDigest(stageJson);
    const identity = await deriveModelAttemptIdentity({
      stage_request_sha256: stageSha,
      principal_ref: PRINCIPAL.principal_ref,
      credential_generation: PRINCIPAL.credential_generation,
      deployment_generation: PRINCIPAL.deployment_generation,
    });
    const deployment = policy().rules.find((value) => value.stage === "SYNTHESIZE")?.deployment;
    if (deployment === undefined) throw new Error("no synthesis deployment");
    await service.admit(
      {
        request,
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
    const input = await inputFromRow(inserted[0] as Record<string, unknown>);
    expect(await errorCode(service.admissions.admit({ ...input, role: "SUPPORT" }))).toBe(
      "MODEL_ATTEMPT_INPUT_INVALID",
    );
  });

  it("keeps the role bound through the admission digest readback", async () => {
    const { service, inserted } = await admitBranchRole("ANALYZE_BRANCHES", "SUPPORT");
    const input = await inputFromRow(inserted[0] as Record<string, unknown>);
    // Re-admitting the exact same material is idempotent and returns the role.
    const reread = await service.admissions.admit(input);
    expect(reread.role).toBe("SUPPORT");
    expect(reread.admission_sha256).toBe((inserted[0] as Record<string, unknown>).admission_sha256);
  });
});
