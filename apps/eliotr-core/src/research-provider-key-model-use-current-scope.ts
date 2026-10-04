import type { ProviderNativeModelKeyBindingReadRequestV1 } from "@eliotr/cloudflare-native-models";
import {
  createResearchProviderKeyModelUseStore,
  type ResearchProviderKeyModelUseDbPhase,
} from "./research-provider-key-model-use-store.js";

const NATIVE_SCOPE_PHASES: ReadonlySet<ResearchProviderKeyModelUseDbPhase> = new Set([
  "NATIVE_PREPARE", "NATIVE_QUALIFY", "CONFIGURATION_IMPORT", "SELECTION_READBACK", "COMPLETE",
]);

export interface ResearchProviderKeyModelUseNativeScopeOptions {
  /** Restrict the reader to the caller's exact lifecycle boundary. */
  readonly allowed_phases?: readonly ResearchProviderKeyModelUseDbPhase[];
}

export interface ResearchProviderKeyModelUseNativeScopeV1 {
  readonly owner_ref: string;
  readonly project_id: string;
  readonly owner_operation_id: string;
  readonly stage: ProviderNativeModelKeyBindingReadRequestV1["stage"];
  readonly project_generation: number;
  readonly scope_sha256: string;
}

/**
 * Phase-aware, read-only Native scope. The key reader independently checks the
 * exact configured key row. Completed scopes remain resolvable for immutable
 * run/COW pins after a later project selection replaces the active revision.
 */
export async function readResearchProviderKeyModelUseNativeScope(
  database: D1Database,
  request: ProviderNativeModelKeyBindingReadRequestV1,
  options: ResearchProviderKeyModelUseNativeScopeOptions = {},
): Promise<ResearchProviderKeyModelUseNativeScopeV1 | null> {
  const allowedPhases = options.allowed_phases === undefined
    ? NATIVE_SCOPE_PHASES
    : new Set(options.allowed_phases);
  if (allowedPhases.size === 0 || [...allowedPhases].some((phase) => !NATIVE_SCOPE_PHASES.has(phase))) return null;
  const store = createResearchProviderKeyModelUseStore(database);
  const [operation, stages, project] = await Promise.all([
    store.read(request.owner_ref, request.project_id, request.owner_operation_id),
    store.readStages(request.owner_ref, request.project_id, request.owner_operation_id),
    database.prepare("SELECT p.generation, o.principal_ref FROM project p JOIN project_owner o ON o.project_id=p.project_id WHERE p.project_id=?1 LIMIT 1")
      .bind(request.project_id).first<{ readonly generation: number; readonly principal_ref: string }>(),
  ]);
  if (operation === null || project === null || operation.owner_id !== request.owner_ref ||
      operation.project_id !== request.project_id || operation.operation_id !== request.owner_operation_id ||
      operation.key_operation_id !== request.operation_id || project.principal_ref !== request.owner_ref ||
      project.generation !== operation.project_generation || !Number.isSafeInteger(project.generation) ||
      project.generation < 1) return null;
  const stage = stages.find((entry) => entry.stage === request.stage);
  if (stage === undefined) return null;
  const allQualified = stages.length >= 2 && stages.length <= 4 && stages.every((entry) => entry.state === "QUALIFIED");
  const preparing = operation.state === "PREPARING" && operation.phase === "NATIVE_PREPARE" &&
    operation.active_stage === stage.stage && stage.state === "PENDING";
  const qualifying = operation.state === "QUALIFYING" && operation.phase === "NATIVE_QUALIFY" &&
    operation.active_stage === stage.stage && stage.state === "QUALIFYING";
  const importing = operation.state === "IMPORTING" &&
    (operation.phase === "CONFIGURATION_IMPORT" || operation.phase === "SELECTION_READBACK") &&
    operation.active_stage === null && operation.failure_code === null && allQualified;
  const selected = operation.state === "SELECTED" && operation.phase === "COMPLETE" &&
    operation.active_stage === null && operation.failure_code === null && allQualified;
  if ((!preparing && !qualifying && !importing && !selected) || !allowedPhases.has(operation.phase)) return null;
  return Object.freeze({
    owner_ref: request.owner_ref,
    project_id: request.project_id,
    owner_operation_id: request.owner_operation_id,
    stage: request.stage,
    project_generation: operation.project_generation,
    scope_sha256: operation.plan_sha256,
  });
}
