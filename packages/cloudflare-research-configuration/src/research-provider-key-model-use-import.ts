import {
  decodeResearchProjectModelConfigurationBundle,
  type ResearchProjectModelSelection,
} from "@eliotr/cloudflare-research";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import {
  ResearchProjectModelConfigurationAuthorityError,
  type ResearchProjectModelConfigurationService,
  type SelectedResearchProjectConfiguration,
} from "./research-project-configuration.js";
import {
  buildResearchProviderKeyModelUseTarget,
  parseResearchProviderKeyModelUseBasis,
} from "./research-provider-key-model-use-plan.js";
import type {
  createResearchProviderKeyModelUseProgress,
} from "./research-provider-key-model-use-progress.js";
import {
  ResearchProviderKeyModelUseServiceError,
  sameResearchProviderKeyModelUseSourceSelection,
} from "./research-provider-key-model-use-progress.js";
import type {
  createResearchProviderKeyModelUseStore,
  ResearchProviderKeyModelUseRow,
} from "./research-provider-key-model-use-store.js";

type ResearchProviderKeyModelUseStore = ReturnType<typeof createResearchProviderKeyModelUseStore>;
type ResearchProviderKeyModelUseProgress = ReturnType<typeof createResearchProviderKeyModelUseProgress>;

function unavailable(cause?: unknown): never {
  throw new ResearchProviderKeyModelUseServiceError(
    "PROVIDER_KEY_MODEL_USE_UNAVAILABLE", 503, "Model-key check/use is temporarily unavailable", true, cause,
  );
}

/** Performs the owner-qualified configuration import and exact CAS/readback recovery. */
export function createResearchProviderKeyModelUseImporter(input: {
  readonly store: ResearchProviderKeyModelUseStore;
  readonly context: AuthenticatedRequestContext;
  readonly project_id: string;
  readonly project_configuration: ResearchProjectModelConfigurationService;
  readonly assertCurrent: (row: ResearchProviderKeyModelUseRow) => Promise<ResearchProviderKeyModelUseRow | null>;
  readonly progress: Pick<ResearchProviderKeyModelUseProgress, "transitionOperation" | "markFailure">;
}): (row: ResearchProviderKeyModelUseRow) => Promise<ResearchProviderKeyModelUseRow> {
  const { store, context, project_id, project_configuration, assertCurrent } = input;
  const { transitionOperation, markFailure } = input.progress;

  async function importAndSelect(rowRaw: ResearchProviderKeyModelUseRow): Promise<ResearchProviderKeyModelUseRow> {
    let row = rowRaw;
    const basis = parseResearchProviderKeyModelUseBasis(row.configuration_basis_json);
    const stages = await store.readStages(row.owner_id, row.project_id, row.operation_id);
    if (!stages.every((stage) => stage.state === "QUALIFIED" && stage.pricing_snapshot_ref !== null &&
        stage.candidate_ref !== null && stage.candidate_sha256 !== null && stage.qualification_ref !== null &&
        stage.qualification_sha256 !== null)) return row;
    const selections: ResearchProjectModelSelection[] = basis.stages.map((planned) => {
      const stage = stages.find((entry) => entry.stage === planned.stage);
      if (stage === undefined || stage.candidate_ref === null || stage.candidate_sha256 === null ||
          stage.qualification_ref === null || stage.qualification_sha256 === null) unavailable();
      return Object.freeze({
        candidate_kind: "provider-native-v1" as const,
        stage: planned.stage,
        route_ref: planned.route_ref,
        route_version: planned.route_version,
        candidate_ref: stage.candidate_ref,
        candidate_sha256: stage.candidate_sha256,
        qualification_ref: stage.qualification_ref,
        qualification_sha256: stage.qualification_sha256,
        transport_policy: planned.transport_policy,
      });
    });
    const pricingRefs = new Map(stages.map((stage) => [stage.stage, stage.pricing_snapshot_ref as string]));
    const target = await buildResearchProviderKeyModelUseTarget({ basis, selections, pricing_snapshot_refs: pricingRefs });
    const decoded = await decodeResearchProjectModelConfigurationBundle(target);
    if (row.target_configuration_ref !== null && (row.target_configuration_ref !== decoded.configuration_ref ||
        row.target_configuration_sha256 !== decoded.configuration_sha256 || row.target_configuration_json !== decoded.json)) {
      return markFailure(row, "NATIVE_RECEIPT_INVALID", "BLOCKED");
    }
    if (row.state === "QUALIFYING") {
      row = await transitionOperation(row, "IMPORTING", "CONFIGURATION_IMPORT", null, {
        target_configuration: { ref: decoded.configuration_ref, sha256: decoded.configuration_sha256, json: decoded.json },
      });
    } else if (row.state === "IMPORTING" && row.target_configuration_ref === null) {
      row = await transitionOperation(row, "IMPORTING", "CONFIGURATION_IMPORT", null, {
        target_configuration: { ref: decoded.configuration_ref, sha256: decoded.configuration_sha256, json: decoded.json },
      });
    }
    if (row.state !== "IMPORTING" || row.target_configuration_ref !== decoded.configuration_ref) return row;
    const current = await assertCurrent(row);
    if (current === null) {
      let selectedNow: SelectedResearchProjectConfiguration | null;
      try { selectedNow = await project_configuration.readSelected(context, project_id); }
      catch {
        const failureRow = row.phase === "SELECTION_READBACK"
          ? await transitionOperation(row, "IMPORTING", "CONFIGURATION_IMPORT", null) : row;
        return markFailure(failureRow, "AUTHORITY_CHANGED", "BLOCKED");
      }
      if (selectedNow?.configuration_ref === row.target_configuration_ref &&
          selectedNow.configuration_sha256 === row.target_configuration_sha256) {
        return transitionOperation(row, "SELECTED", "COMPLETE", null, {
          selection: { ref: selectedNow.configuration_ref, revision: selectedNow.selection_revision },
        });
      }
      if (sameResearchProviderKeyModelUseSourceSelection(selectedNow, row)) {
        const failureRow = row.phase === "SELECTION_READBACK"
          ? await transitionOperation(row, "IMPORTING", "CONFIGURATION_IMPORT", null) : row;
        return markFailure(failureRow, "AUTHORITY_CHANGED", "BLOCKED");
      }
      const phaseRow = row.phase === "SELECTION_READBACK" ? row : await transitionOperation(row, "IMPORTING", "SELECTION_READBACK", null);
      return markFailure(phaseRow, "SELECTION_CAS_CONFLICT", "CONFLICT");
    }
    const selected = await project_configuration.readSelected(context, project_id);
    if (selected?.configuration_ref === row.target_configuration_ref &&
        selected.configuration_sha256 === row.target_configuration_sha256) {
      return transitionOperation(row, "SELECTED", "COMPLETE", null, {
        selection: { ref: selected.configuration_ref, revision: selected.selection_revision },
      });
    }
    if (!sameResearchProviderKeyModelUseSourceSelection(selected, row)) {
      const phaseRow = row.phase === "SELECTION_READBACK" ? row : await transitionOperation(row, "IMPORTING", "SELECTION_READBACK", null);
      return markFailure(phaseRow, "SELECTION_CAS_CONFLICT", "CONFLICT");
    }
    if (row.phase === "SELECTION_READBACK") row = await transitionOperation(row, "IMPORTING", "CONFIGURATION_IMPORT", null);
    try {
      const result = await project_configuration.importQualifiedConfiguration(context, project_id, {
        expected_revision: row.expected_selection_revision,
        configuration: decoded.bundle,
      });
      if (result.selected.configuration_ref !== row.target_configuration_ref ||
          result.selected.configuration_sha256 !== row.target_configuration_sha256) {
        const phaseRow = await transitionOperation(row, "IMPORTING", "SELECTION_READBACK", null);
        return markFailure(phaseRow, "SELECTION_CAS_CONFLICT", "CONFLICT");
      }
      return transitionOperation(row, "SELECTED", "COMPLETE", null, {
        selection: { ref: result.selected.configuration_ref, revision: result.selection_revision },
      });
    } catch (cause) {
      const after = await project_configuration.readSelected(context, project_id).catch(() => null);
      if (after?.configuration_ref === row.target_configuration_ref &&
          after.configuration_sha256 === row.target_configuration_sha256) {
        return transitionOperation(row, "SELECTED", "COMPLETE", null, {
          selection: { ref: after.configuration_ref, revision: after.selection_revision },
        });
      }
      if (!sameResearchProviderKeyModelUseSourceSelection(after, row)) {
        const phaseRow = row.phase === "SELECTION_READBACK" ? row : await transitionOperation(row, "IMPORTING", "SELECTION_READBACK", null);
        return markFailure(phaseRow, "SELECTION_CAS_CONFLICT", "CONFLICT");
      }
      if (cause instanceof ResearchProjectModelConfigurationAuthorityError) {
        if (cause.status === 409) {
          const phaseRow = row.phase === "SELECTION_READBACK" ? row : await transitionOperation(row, "IMPORTING", "SELECTION_READBACK", null);
          return markFailure(phaseRow, "SELECTION_CAS_CONFLICT", "CONFLICT");
        }
        throw cause;
      }
      unavailable(cause);
    }
  }

  return importAndSelect;
}
