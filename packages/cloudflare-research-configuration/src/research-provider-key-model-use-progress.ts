import { ResearchProviderKeyModelUseReceiptSchema, RESEARCH_PROVIDER_KEY_MODEL_USE_PROTOCOL } from "@eliotr/contracts";
import type { ResearchProviderKeyModelUseFailureCode, ResearchProviderKeyModelUseReceipt } from "@eliotr/contracts";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import type {
  createResearchProviderKeyModelUseStore,
  ResearchProviderKeyModelUseDbPhase,
  ResearchProviderKeyModelUseDbState,
  ResearchProviderKeyModelUseRow,
  ResearchProviderKeyModelUseStage,
  ResearchProviderKeyModelUseStageDbState,
  ResearchProviderKeyModelUseStageRow,
} from "./research-provider-key-model-use-store.js";

export type ResearchProviderKeyModelUseStore = ReturnType<typeof createResearchProviderKeyModelUseStore>;
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function sameResearchProviderKeyModelUseSourceSelection(
  selected: { readonly configuration_ref: string; readonly configuration_sha256: string; readonly selection_revision: number } | null,
  row: ResearchProviderKeyModelUseRow,
): boolean {
  return selected === null
    ? row.source_configuration_ref === null && row.expected_selection_revision === null
    : selected.configuration_ref === row.source_configuration_ref &&
      selected.configuration_sha256 === row.source_configuration_sha256 &&
      selected.selection_revision === row.expected_selection_revision;
}

export class ResearchProviderKeyModelUseServiceError extends Error {
  public constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
    public readonly retryable = false,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ResearchProviderKeyModelUseServiceError";
  }
}

export function requireResearchProviderKeyModelUseOwner(context: AuthenticatedRequestContext): void {
  if (context.client_class !== "owner_pwa" || !context.request || context.request.signal.aborted ||
      !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(context.principal_ref) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(context.credential_generation) ||
      (context.access !== undefined && (context.access.principal_ref !== context.principal_ref ||
        context.access.credential_generation !== context.credential_generation ||
        !Number.isFinite(Date.parse(context.access.expires_at)) || Date.parse(context.access.expires_at) <= Date.now()))) {
    throw new ResearchProviderKeyModelUseServiceError(
      "PROVIDER_KEY_MODEL_USE_OWNER_REQUIRED", 403, "An active authenticated project owner is required",
    );
  }
}

export async function readResearchProviderKeyModelUseProjectGeneration(
  database: D1Database,
  owner: string,
  project: string,
): Promise<number> {
  try {
    const row = await database.prepare("SELECT p.generation FROM project p JOIN project_owner o ON o.project_id=p.project_id " +
      "WHERE p.project_id=?1 AND o.principal_ref=?2 LIMIT 1").bind(project, owner)
      .first<{ readonly generation: number }>();
    if (row === null) throw new ResearchProviderKeyModelUseServiceError("PROVIDER_KEY_MODEL_USE_PROJECT_NOT_FOUND", 404,
      "Project was not found for this owner");
    if (!Number.isSafeInteger(row.generation) || row.generation < 1) {
      throw new ResearchProviderKeyModelUseServiceError("PROVIDER_KEY_MODEL_USE_STORAGE_UNAVAILABLE", 503,
        "Project generation readback is invalid", true);
    }
    return row.generation;
  } catch (cause) {
    if (cause instanceof ResearchProviderKeyModelUseServiceError) throw cause;
    throw new ResearchProviderKeyModelUseServiceError("PROVIDER_KEY_MODEL_USE_STORAGE_UNAVAILABLE", 503,
      "Project generation readback is unavailable", true, cause);
  }
}

export async function readResearchProviderKeyModelUseOperation(input: {
  readonly store: ResearchProviderKeyModelUseStore;
  readonly database: D1Database;
  readonly context: AuthenticatedRequestContext;
  readonly project_id: string;
  readonly operation_id: string;
}): Promise<ResearchProviderKeyModelUseRow> {
  if (!OPERATION_ID.test(input.operation_id)) {
    throw new ResearchProviderKeyModelUseServiceError("PROVIDER_KEY_MODEL_USE_INPUT_INVALID", 400,
      "Model-key use operation ID is invalid");
  }
  requireResearchProviderKeyModelUseOwner(input.context);
  await readResearchProviderKeyModelUseProjectGeneration(input.database, input.context.principal_ref, input.project_id);
  const row = await input.store.read(input.context.principal_ref, input.project_id, input.operation_id);
  if (row === null) throw new ResearchProviderKeyModelUseServiceError("PROVIDER_KEY_MODEL_USE_NOT_FOUND", 404,
    "Model-key use operation was not found for this owner project");
  return row;
}

export function createResearchProviderKeyModelUseProgress(
  store: ResearchProviderKeyModelUseStore,
  now: () => number,
) {
  function mapReceipt(row: ResearchProviderKeyModelUseRow): ResearchProviderKeyModelUseReceipt {
    const data = ResearchProviderKeyModelUseReceiptSchema.safeParse({
      protocol: RESEARCH_PROVIDER_KEY_MODEL_USE_PROTOCOL,
      project_id: row.project_id,
      operation_id: row.operation_id,
      key_operation_id: row.key_operation_id,
      state: row.state.toLowerCase(),
      phase: row.phase.toLowerCase(),
      selected_configuration_ref: row.selected_configuration_ref,
      selection_revision: row.selection_revision,
      failure_code: row.failure_code,
      created_at: row.created_at,
      updated_at: row.updated_at,
    });
    if (!data.success) {
      throw new ResearchProviderKeyModelUseServiceError(
        "PROVIDER_KEY_MODEL_USE_RECEIPT_INVALID", 503, "Model-key use receipt is unavailable", true, data.error,
      );
    }
    return data.data;
  }

  async function transitionOperation(
    row: ResearchProviderKeyModelUseRow,
    state: ResearchProviderKeyModelUseDbState,
    phase: ResearchProviderKeyModelUseDbPhase,
    activeStage: ResearchProviderKeyModelUseStage | null,
    extra: {
      readonly failure_code?: ResearchProviderKeyModelUseFailureCode | null;
      readonly target_configuration?: { readonly ref: string; readonly sha256: string; readonly json: string };
      readonly selection?: { readonly ref: string; readonly revision: number };
    } = {},
  ): Promise<ResearchProviderKeyModelUseRow> {
    const changed = await store.transitionOperation({
      owner: row.owner_id, project: row.project_id, operation_id: row.operation_id,
      expected_state: row.state, expected_phase: row.phase, state, phase, active_stage: activeStage,
      expected_active_stage: row.active_stage,
      project_generation: row.project_generation, updated_at: new Date(now()).toISOString(), ...extra,
    });
    const result = await store.read(row.owner_id, row.project_id, row.operation_id);
    if (result === null) throw new ResearchProviderKeyModelUseServiceError(
      "PROVIDER_KEY_MODEL_USE_STORAGE_UNAVAILABLE", 503, "Model-key use state is unavailable", true,
    );
    if (!changed && (result.state !== state || result.phase !== phase || result.active_stage !== activeStage)) {
      throw new ResearchProviderKeyModelUseServiceError("PROVIDER_KEY_MODEL_USE_STATE_CONFLICT", 409,
        "Model-key operation changed; reconcile its exact operation ID");
    }
    return result;
  }

  async function transitionStage(
    row: ResearchProviderKeyModelUseRow,
    stage: ResearchProviderKeyModelUseStage,
    expected: ResearchProviderKeyModelUseStageDbState,
    state: ResearchProviderKeyModelUseStageDbState,
    extra: {
      readonly pricing?: { readonly ref: string; readonly sha256: string };
      readonly preparation?: { readonly ref: string; readonly sha256: string };
      readonly qualification?: { readonly candidate_ref: string; readonly candidate_sha256: string;
        readonly qualification_ref: string; readonly qualification_sha256: string };
      readonly failure_code?: ResearchProviderKeyModelUseFailureCode | null;
    } = {},
  ): Promise<readonly ResearchProviderKeyModelUseStageRow[]> {
    const changed = await store.transitionStage({
      owner: row.owner_id, project: row.project_id, operation_id: row.operation_id, stage,
      expected_operation_state: row.state, expected_operation_phase: row.phase,
      expected_state: expected, state, project_generation: row.project_generation,
      updated_at: new Date(now()).toISOString(), ...extra,
    });
    const stages = await store.readStages(row.owner_id, row.project_id, row.operation_id);
    const observed = stages.find((entry) => entry.stage === stage);
    if (observed === undefined || (!changed && observed.state !== state)) {
      throw new ResearchProviderKeyModelUseServiceError("PROVIDER_KEY_MODEL_USE_STATE_CONFLICT", 409,
        "Model-key stage changed; reconcile its exact operation ID");
    }
    return stages;
  }

  async function markFailure(
    row: ResearchProviderKeyModelUseRow,
    code: ResearchProviderKeyModelUseFailureCode,
    state: "BLOCKED" | "CONFLICT" | "UNCERTAIN",
  ): Promise<ResearchProviderKeyModelUseRow> {
    const stages = await store.readStages(row.owner_id, row.project_id, row.operation_id);
    const active = row.active_stage === null ? undefined : stages.find((entry) => entry.stage === row.active_stage);
    if (active !== undefined && ["PENDING", "PREPARED", "QUALIFYING"].includes(active.state)) {
      await transitionStage(row, active.stage, active.state, state === "UNCERTAIN" ? "UNCERTAIN" : "BLOCKED",
        { failure_code: state === "UNCERTAIN" ? "QUALIFICATION_OUTCOME_UNCERTAIN" : code });
    }
    return transitionOperation(row, state, row.phase, row.active_stage, { failure_code: code });
  }

  return Object.freeze({ mapReceipt, transitionOperation, transitionStage, markFailure });
}
