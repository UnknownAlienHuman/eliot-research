import {
  evidenceSha256Bytes,
  evidenceUtf8Bytes,
} from "@eliotr/cloudflare-evidence";
import { canonicalJson } from "@eliotr/platform-cloudflare";
import {
  createD1ResearchRunConfigurationStore,
  RESEARCH_RUN_CONFIGURATION_PROTOCOL,
  ResearchRunConfigurationStoreError,
  type ResearchRunConfigurationAssociation,
  type ResearchRunConfigurationRecord,
  type ResearchRunConfigurationMode,
} from "@eliotr/cloudflare-research";
import { WorkflowCheckpointError } from "@eliotr/cloudflare-workflows";
import { resolveResearchSemanticConfig, type ResearchSemanticConfigInput } from "./research-semantic-config-revision.js";
import { parseResearchRunModelSelections as parseModelSelections,
  type ResearchRunModelSelection } from "./research-run-model-selection-codec.js";
import { parseResearchNativeAcquisitionSelection,
  parseResearchNativeAcquisitionSelectionJson,
  type ResearchNativeAcquisitionSelection } from "./research-native-acquisition-selection.js";

export type { ResearchRunModelSelection } from "./research-run-model-selection-codec.js";

export type ResearchRunConfigurationModeWithLegacy = "legacy-installed" | ResearchRunConfigurationMode;

export interface SelectedResearchProjectConfiguration {
  /** Supplied by run admission only after resolving the exact current owner/project scope. */
  readonly owner_ref?: string;
  readonly project_id?: string;
  readonly configuration_ref: string;
  readonly configuration_sha256: string;
  readonly selection_revision: number;
  readonly configuration_json: string;
}

export interface ResolvedResearchRunConfiguration<RuntimeEnvironment = unknown> {
  readonly env: RuntimeEnvironment;
  readonly mode: ResearchRunConfigurationModeWithLegacy;
  readonly configuration_ref: string | null;
  readonly configuration_sha256: string | null;
  readonly model_selections: readonly ResearchRunModelSelection[];
  readonly project_configuration_ref: string | null;
  readonly project_configuration_sha256: string | null;
  readonly project_owner_ref: string | null;
  readonly project_id: string | null;
  readonly native_acquisition_selection?: ResearchNativeAcquisitionSelection;
}

export interface CaptureResearchRunConfigurationInput extends ResearchRunConfigurationAssociation {
  /** Called lazily after the per-run snapshot lookup; retries never read current project selection. */
  readonly select_project_configuration?: () => Promise<SelectedResearchProjectConfiguration | null>;
}

export interface ResearchRunConfigurationRuntimeSnapshot {
  readonly semantic: {
    readonly source: "revision" | "legacy-installed";
    readonly config_json: string;
    readonly revision_ref: string | null;
    readonly config_sha256: string;
  };
  readonly model_profile: { readonly config_json: string; readonly provenance_ref: string };
  readonly spend_policy: { readonly config_json: string; readonly provenance_ref: string };
  readonly report: { readonly config_json: string; readonly provenance_ref: string };
  readonly native_acquisition_selection?: ResearchNativeAcquisitionSelection;
}

/** Core supplies runtime-bound environment, semantic-source and auth/error adapters explicitly. */
export interface ResearchRunConfigurationRuntimePort<RuntimeEnvironment> {
  readonly database: D1Database;
  readonly semantic_source: (environment: RuntimeEnvironment) => ResearchSemanticConfigInput;
  readonly model_transport_available: (environment: RuntimeEnvironment) => boolean;
  readonly overlay_snapshot: (
    environment: RuntimeEnvironment,
    snapshot: ResearchRunConfigurationRuntimeSnapshot,
  ) => RuntimeEnvironment;
  readonly translate_project_selection_failure?: (error: unknown) => unknown | null;
  readonly is_project_selection_failure?: (error: unknown) => boolean;
}

interface SnapshotEnvelope {
  readonly protocol: typeof RESEARCH_RUN_CONFIGURATION_PROTOCOL;
  readonly mode: ResearchRunConfigurationMode;
  readonly association: ResearchRunConfigurationAssociation;
  readonly project_configuration: {
    readonly configuration_ref: string;
    readonly configuration_sha256: string;
    readonly selection_revision: number;
    readonly owner_ref?: string;
    readonly project_id?: string;
  } | null;
  readonly model_selections: readonly ResearchRunModelSelection[];
  readonly semantic: {
    readonly source: "revision" | "legacy-installed";
    readonly config_json: string;
    readonly revision_ref: string | null;
    readonly config_sha256: string;
  };
  readonly model_profile: { readonly config_json: string; readonly provenance_ref: string };
  readonly spend_policy: { readonly config_json: string; readonly provenance_ref: string };
  readonly report: { readonly config_json: string; readonly provenance_ref: string };
  readonly native_acquisition_selection?: ResearchNativeAcquisitionSelection;
}

interface WorkflowConfigurationBindingRow {
  readonly operation_id: unknown;
  readonly investigation_id: unknown;
  readonly principal_ref: unknown;
  readonly deployment_generation: unknown;
  readonly configuration_required: unknown;
  readonly configuration_ref: unknown;
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/u;
const OP_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u;
const SHA256_RE = /^[a-f0-9]{64}$/u;
const ROOT_KEYS_LEGACY = new Set(["protocol", "mode", "association", "project_configuration", "model_selections",
  "semantic", "model_profile", "spend_policy", "report"]);
const ROOT_KEYS_WITH_ACQUISITION = new Set([...ROOT_KEYS_LEGACY, "native_acquisition_selection"]);
const PROJECT_CONFIGURATION_KEYS = new Set(["protocol", "semantic_revision", "model_selections", "vars"]);
const PROJECT_RUNTIME_KEYS_LEGACY = new Set([
  "ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON",
  "ELIOTR_MODEL_PROFILE_DEFINITION_JSON",
  "ELIOTR_MODEL_PROFILE_PROVENANCE_REF",
  "ELIOTR_MODEL_SPEND_POLICY_JSON",
  "ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF",
  "ELIOTR_RESEARCH_REPORT_CONFIG_JSON",
  "ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF",
]);
const NATIVE_ACQUISITION_SELECTION_VAR = "ELIOTR_RESEARCH_NATIVE_ACQUISITION_SELECTION_JSON";
const PROJECT_RUNTIME_KEYS_WITH_ACQUISITION = new Set([...PROJECT_RUNTIME_KEYS_LEGACY, NATIVE_ACQUISITION_SELECTION_VAR]);
function checkpoint(code: ConstructorParameters<typeof WorkflowCheckpointError>[0]): never {
  throw new WorkflowCheckpointError(code);
}

function object(value: unknown, _label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) checkpoint("WORKFLOW_CONFIGURATION_INVALID");
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: ReadonlySet<string>): void {
  const actual = Object.keys(value);
  if (actual.length !== expected.size || actual.some((key) => !expected.has(key))) checkpoint("WORKFLOW_CONFIGURATION_INVALID");
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !ID_RE.test(value)) checkpoint("WORKFLOW_CONFIGURATION_INVALID");
  return value;
}

function digest(value: unknown): string {
  if (typeof value !== "string" || !SHA256_RE.test(value)) checkpoint("WORKFLOW_CONFIGURATION_INVALID");
  return value;
}

function association(input: ResearchRunConfigurationAssociation): ResearchRunConfigurationAssociation {
  if (!OP_RE.test(input.operation_id)) checkpoint("WORKFLOW_INPUT_INVALID");
  return Object.freeze({ operation_id: input.operation_id, investigation_id: identifier(input.investigation_id),
    principal_ref: identifier(input.principal_ref), deployment_generation: identifier(input.deployment_generation) });
}

function requiredJson(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") checkpoint("WORKFLOW_CONFIGURATION_MISSING");
  try { object(JSON.parse(value) as unknown, label); }
  catch (error) {
    if (error instanceof WorkflowCheckpointError) throw error;
    checkpoint("WORKFLOW_CONFIGURATION_INVALID");
  }
  return value;
}

function provenance(value: unknown): string {
  return identifier(value);
}

async function parseSnapshotRecord(record: ResearchRunConfigurationRecord): Promise<SnapshotEnvelope> {
  let parsed: unknown;
  try { parsed = JSON.parse(record.configuration_json) as unknown; }
  catch { checkpoint("WORKFLOW_CONFIGURATION_INVALID"); }
  const root = object(parsed, "run configuration");
  const hasNativeAcquisition = Object.prototype.hasOwnProperty.call(root, "native_acquisition_selection");
  exactKeys(root, hasNativeAcquisition ? ROOT_KEYS_WITH_ACQUISITION : ROOT_KEYS_LEGACY);
  if (root.protocol !== RESEARCH_RUN_CONFIGURATION_PROTOCOL || root.mode !== record.mode ||
      canonicalJson(root) !== record.configuration_json) checkpoint("WORKFLOW_CONFIGURATION_INVALID");
  const bound = object(root.association, "association");
  exactKeys(bound, new Set(["operation_id", "investigation_id", "principal_ref", "deployment_generation"]));
  if (bound.operation_id !== record.operation_id || bound.investigation_id !== record.investigation_id ||
      bound.principal_ref !== record.principal_ref || bound.deployment_generation !== record.deployment_generation) {
    checkpoint("WORKFLOW_AUTHORITY_STALE");
  }
  let projectConfiguration: SnapshotEnvelope["project_configuration"] = null;
  if (root.project_configuration !== null) {
    const source = object(root.project_configuration, "project configuration provenance");
    const oldKeys = new Set(["configuration_ref", "configuration_sha256", "selection_revision"]);
    const nativeKeys = new Set([...oldKeys, "owner_ref", "project_id"]);
    if (Object.keys(source).length === oldKeys.size) exactKeys(source, oldKeys);
    else exactKeys(source, nativeKeys);
    if (!Number.isSafeInteger(source.selection_revision) || (source.selection_revision as number) < 1) {
      checkpoint("WORKFLOW_CONFIGURATION_INVALID");
    }
    projectConfiguration = Object.freeze({ configuration_ref: identifier(source.configuration_ref),
      configuration_sha256: digest(source.configuration_sha256), selection_revision: source.selection_revision as number,
      ...(source.owner_ref === undefined ? {} : { owner_ref: identifier(source.owner_ref) }),
      ...(source.project_id === undefined ? {} : { project_id: identifier(source.project_id) }) });
  }
  const semantic = object(root.semantic, "semantic configuration");
  exactKeys(semantic, new Set(["source", "config_json", "revision_ref", "config_sha256"]));
  const semanticSource = semantic.source;
  const semanticJson = requiredJson(semantic.config_json, "semantic configuration");
  const semanticSha = digest(semantic.config_sha256);
  if (await evidenceSha256Bytes(evidenceUtf8Bytes(semanticJson)) !== semanticSha) {
    checkpoint("WORKFLOW_CONFIGURATION_INVALID");
  }
  let semanticRevision: string | null = null;
  if (semanticSource === "revision") {
    semanticRevision = identifier(semantic.revision_ref);
    if (!/^scr-[0-9a-f]{12}$/u.test(semanticRevision)) checkpoint("WORKFLOW_CONFIGURATION_INVALID");
  } else if (semanticSource !== "legacy-installed" || semantic.revision_ref !== null) {
    checkpoint("WORKFLOW_CONFIGURATION_INVALID");
  }
  const modelProfile = object(root.model_profile, "model profile");
  exactKeys(modelProfile, new Set(["config_json", "provenance_ref"]));
  const spendPolicy = object(root.spend_policy, "spend policy");
  exactKeys(spendPolicy, new Set(["config_json", "provenance_ref"]));
  const report = object(root.report, "report configuration");
  exactKeys(report, new Set(["config_json", "provenance_ref"]));
  const nativeAcquisitionSelection = hasNativeAcquisition
    ? parseResearchNativeAcquisitionSelection(root.native_acquisition_selection) : undefined;
  let spend: unknown;
  try { spend = JSON.parse(requiredJson(spendPolicy.config_json, "spend policy")) as unknown; }
  catch (error) { if (error instanceof WorkflowCheckpointError) throw error; checkpoint("WORKFLOW_CONFIGURATION_INVALID"); }
  const expectedMode = typeof object(spend, "spend policy").protocol === "string" &&
    (object(spend, "spend policy").protocol as string).endsWith("template.v2") ? "snapshot-v2" : "snapshot-v1";
  if (record.mode !== expectedMode) checkpoint("WORKFLOW_CONFIGURATION_INVALID");
  const modelSelections = parseModelSelections(root.model_selections);
  const hasNativeSelection = modelSelections.some((selection) => selection.candidate_kind === "provider-native-v1");
  if (hasNativeSelection && (projectConfiguration?.owner_ref === undefined || projectConfiguration.project_id === undefined)) {
    checkpoint("WORKFLOW_CONFIGURATION_INVALID");
  }
  return Object.freeze({ protocol: RESEARCH_RUN_CONFIGURATION_PROTOCOL, mode: record.mode,
    association: Object.freeze({ operation_id: record.operation_id, investigation_id: record.investigation_id,
      principal_ref: record.principal_ref, deployment_generation: record.deployment_generation }),
    project_configuration: projectConfiguration,
    model_selections: modelSelections,
    semantic: Object.freeze({ source: semanticSource as SnapshotEnvelope["semantic"]["source"], config_json: semanticJson,
      revision_ref: semanticRevision, config_sha256: semanticSha }),
    model_profile: Object.freeze({ config_json: requiredJson(modelProfile.config_json, "model profile"),
      provenance_ref: provenance(modelProfile.provenance_ref) }),
    spend_policy: Object.freeze({ config_json: requiredJson(spendPolicy.config_json, "spend policy"),
      provenance_ref: provenance(spendPolicy.provenance_ref) }),
    report: Object.freeze({ config_json: requiredJson(report.config_json, "report configuration"),
      provenance_ref: provenance(report.provenance_ref) }),
    ...(nativeAcquisitionSelection === undefined ? {} : { native_acquisition_selection: nativeAcquisitionSelection }),
  });
}

async function resolved<RuntimeEnvironment>(environment: RuntimeEnvironment,
  record: ResearchRunConfigurationRecord,
  port: ResearchRunConfigurationRuntimePort<RuntimeEnvironment>): Promise<ResolvedResearchRunConfiguration<RuntimeEnvironment>> {
  const snapshot = await parseSnapshotRecord(record);
  const hasNativeSelection = snapshot.model_selections.some((selection) => selection.candidate_kind === "provider-native-v1");
  if (hasNativeSelection && record.mode !== "snapshot-v2") checkpoint("WORKFLOW_CONFIGURATION_INVALID");
  const env = port.overlay_snapshot(environment, snapshot);
  return Object.freeze({ env, mode: record.mode,
    configuration_ref: record.configuration_ref, configuration_sha256: record.configuration_sha256,
    model_selections: snapshot.model_selections,
    project_configuration_ref: snapshot.project_configuration?.configuration_ref ?? null,
    project_configuration_sha256: snapshot.project_configuration?.configuration_sha256 ?? null,
    project_owner_ref: snapshot.project_configuration?.owner_ref ?? null,
    project_id: snapshot.project_configuration?.project_id ?? null,
    ...(snapshot.native_acquisition_selection === undefined ? {} : {
      native_acquisition_selection: snapshot.native_acquisition_selection,
    }) });
}

function runBindingError<RuntimeEnvironment>(error: unknown,
  port: ResearchRunConfigurationRuntimePort<RuntimeEnvironment>): never {
  if (error instanceof WorkflowCheckpointError) throw error;
  if (port.is_project_selection_failure?.(error) === true) throw error;
  if (error instanceof ResearchRunConfigurationStoreError) {
    checkpoint(error.code === "RESEARCH_RUN_CONFIGURATION_INPUT_INVALID" ? "WORKFLOW_CONFIGURATION_INVALID" :
      error.code === "RESEARCH_RUN_CONFIGURATION_UNRESOLVED" ? "WORKFLOW_STORAGE_UNAVAILABLE" : "WORKFLOW_CONFIGURATION_INVALID");
  }
  checkpoint("WORKFLOW_STORAGE_UNAVAILABLE");
}

async function currentRunBinding<RuntimeEnvironment>(database: D1Database, actor: ResearchRunConfigurationAssociation,
  port: ResearchRunConfigurationRuntimePort<RuntimeEnvironment>): Promise<WorkflowConfigurationBindingRow> {
  let row: WorkflowConfigurationBindingRow | null;
  try {
    row = await database.prepare(
      "SELECT operation_id,investigation_id,principal_ref,deployment_generation,configuration_required,configuration_ref " +
      "FROM research_workflow_run WHERE operation_id=?1 LIMIT 1",
    ).bind(actor.operation_id).first<WorkflowConfigurationBindingRow>();
  } catch (error) { runBindingError(error, port); }
  if (row === null) checkpoint("WORKFLOW_AUTHORITY_STALE");
  if (row.operation_id !== actor.operation_id || row.investigation_id !== actor.investigation_id ||
      row.principal_ref !== actor.principal_ref || row.deployment_generation !== actor.deployment_generation ||
      (row.configuration_required !== 0 && row.configuration_required !== 1) ||
      (row.configuration_ref !== null && typeof row.configuration_ref !== "string")) {
    checkpoint("WORKFLOW_AUTHORITY_STALE");
  }
  return row;
}

async function lookupSnapshot<RuntimeEnvironment>(database: D1Database, actor: ResearchRunConfigurationAssociation,
  port: ResearchRunConfigurationRuntimePort<RuntimeEnvironment>): Promise<ResearchRunConfigurationRecord | null> {
  try {
    return await createD1ResearchRunConfigurationStore(database).getByOperation(actor.operation_id);
  } catch (error) { runBindingError(error, port); }
}

function sameAssociation(record: ResearchRunConfigurationRecord, actor: ResearchRunConfigurationAssociation): boolean {
  return record.operation_id === actor.operation_id && record.investigation_id === actor.investigation_id &&
    record.principal_ref === actor.principal_ref && record.deployment_generation === actor.deployment_generation;
}

function legacy<RuntimeEnvironment>(env: RuntimeEnvironment): ResolvedResearchRunConfiguration<RuntimeEnvironment> {
  return Object.freeze({ env, mode: "legacy-installed", configuration_ref: null, configuration_sha256: null,
    model_selections: Object.freeze([]), project_configuration_ref: null, project_configuration_sha256: null,
    project_owner_ref: null, project_id: null });
}

function sourceString(value: unknown, _label: string): string {
  if (typeof value !== "string" || value.trim() === "") checkpoint("WORKFLOW_CONFIGURATION_MISSING");
  return value;
}

function sourceProvenance(value: unknown, label: string): string {
  const text = sourceString(value, label);
  return provenance(text);
}

function jsonObject(raw: string, label: string): Record<string, unknown> {
  try { return object(JSON.parse(raw) as unknown, label); }
  catch (error) { if (error instanceof WorkflowCheckpointError) throw error; checkpoint("WORKFLOW_CONFIGURATION_INVALID"); }
}

async function semanticSource(database: D1Database, source: ResearchSemanticConfigInput,
  projectSemantic?: Record<string, unknown>): Promise<SnapshotEnvelope["semantic"]> {
  let semanticInput = source;
  if (projectSemantic !== undefined) {
    const revisionRef = projectSemantic.revision_ref;
    const expectedSha = projectSemantic.config_sha256 ?? projectSemantic.sha256;
    const raw = projectSemantic.config_json;
    if (revisionRef !== null && revisionRef !== undefined) {
      semanticInput = { revision_ref: sourceString(revisionRef, "semantic revision ref"),
        config_sha256: digest(expectedSha) };
    } else {
      semanticInput = { legacy_config_json: sourceString(raw, "semantic config JSON") };
    }
  }
  const resolvedSemantic = await resolveResearchSemanticConfig({ source: semanticInput, database });
  if (projectSemantic !== undefined && typeof projectSemantic.config_json === "string" &&
      projectSemantic.config_json !== resolvedSemantic.config_json) checkpoint("WORKFLOW_CONFIGURATION_INVALID");
  return Object.freeze({ source: resolvedSemantic.revision_ref === null ? "legacy-installed" : "revision",
    config_json: resolvedSemantic.config_json, revision_ref: resolvedSemantic.revision_ref,
    config_sha256: resolvedSemantic.config_sha256 });
}

function selectedProjectSources(project: SelectedResearchProjectConfiguration): {
  readonly envelope: Record<string, unknown>;
  readonly vars: Record<string, unknown>;
  readonly native_acquisition_selection?: ResearchNativeAcquisitionSelection;
} {
  if (typeof project.configuration_json !== "string" || project.configuration_json.length === 0 ||
      typeof project.configuration_ref !== "string" || !ID_RE.test(project.configuration_ref) ||
      typeof project.configuration_sha256 !== "string" || !SHA256_RE.test(project.configuration_sha256) ||
      !Number.isSafeInteger(project.selection_revision) || project.selection_revision < 1) {
    checkpoint("WORKFLOW_CONFIGURATION_INVALID");
  }
  const envelope = jsonObject(project.configuration_json, "project configuration");
  if (canonicalJson(envelope) !== project.configuration_json) checkpoint("WORKFLOW_CONFIGURATION_INVALID");
  exactKeys(envelope, PROJECT_CONFIGURATION_KEYS);
  if (envelope.protocol !== "eliotr.research-project-model-configuration.v1") checkpoint("WORKFLOW_CONFIGURATION_INVALID");
  const vars = object(envelope.vars, "project runtime variables");
  const hasNativeAcquisition = Object.prototype.hasOwnProperty.call(vars, NATIVE_ACQUISITION_SELECTION_VAR);
  exactKeys(vars, hasNativeAcquisition ? PROJECT_RUNTIME_KEYS_WITH_ACQUISITION : PROJECT_RUNTIME_KEYS_LEGACY);
  for (const key of PROJECT_RUNTIME_KEYS_LEGACY) sourceString(vars[key], key);
  const nativeAcquisitionSelection = hasNativeAcquisition
    ? parseResearchNativeAcquisitionSelectionJson(vars[NATIVE_ACQUISITION_SELECTION_VAR]) : undefined;
  return { envelope, vars, ...(nativeAcquisitionSelection === undefined ? {} : {
    native_acquisition_selection: nativeAcquisitionSelection,
  }) };
}

async function projectConfigurationDigest(project: SelectedResearchProjectConfiguration): Promise<void> {
  const sha = await evidenceSha256Bytes(evidenceUtf8Bytes(project.configuration_json));
  if (sha !== project.configuration_sha256 || project.configuration_ref !== `rpmc-${sha}`) {
    checkpoint("WORKFLOW_CONFIGURATION_INVALID");
  }
}

function projectValue(envelope: Record<string, unknown>, vars: Record<string, unknown>, field: string, envKey: string): unknown {
  return envelope[field] ?? vars[envKey];
}

async function composeSnapshot<RuntimeEnvironment>(
  environment: RuntimeEnvironment,
  actor: ResearchRunConfigurationAssociation,
  selectedProject: SelectedResearchProjectConfiguration | undefined,
  port: ResearchRunConfigurationRuntimePort<RuntimeEnvironment>,
): Promise<{ readonly mode: ResearchRunConfigurationMode; readonly configuration_json: string }> {
  let envelope: Record<string, unknown> | undefined;
  let vars: Record<string, unknown> | undefined;
  let nativeAcquisitionSelection: ResearchNativeAcquisitionSelection | undefined;
  let projectConfiguration: SnapshotEnvelope["project_configuration"] = null;
  if (selectedProject !== undefined) {
    const source = selectedProjectSources(selectedProject);
    await projectConfigurationDigest(selectedProject);
    envelope = source.envelope;
    vars = source.vars;
    nativeAcquisitionSelection = source.native_acquisition_selection;
    projectConfiguration = Object.freeze({ configuration_ref: selectedProject.configuration_ref,
      configuration_sha256: selectedProject.configuration_sha256, selection_revision: selectedProject.selection_revision,
      ...(selectedProject.owner_ref === undefined ? {} : { owner_ref: identifier(selectedProject.owner_ref) }),
      ...(selectedProject.project_id === undefined ? {} : { project_id: identifier(selectedProject.project_id) }) });
  }
  let projectSemantic: Record<string, unknown> | undefined;
  if (envelope !== undefined && vars !== undefined) {
    const rawSemantic = envelope.semantic_revision;
    if (rawSemantic !== undefined) {
      const semanticRevision = object(rawSemantic, "project semantic config");
      exactKeys(semanticRevision, new Set(["revision_ref", "config_sha256"]));
      projectSemantic = { ...semanticRevision,
        config_json: vars.ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON };
    }
    else {
      const raw = vars.ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON;
      const ref = envelope.semantic_revision_ref ?? envelope.revision_ref;
      const sha = envelope.semantic_config_sha256 ?? envelope.config_sha256;
      projectSemantic = { config_json: raw, revision_ref: ref ?? null, config_sha256: sha };
    }
  }
  const semantic = await semanticSource(port.database, port.semantic_source(environment), projectSemantic);
  const modelProfileValue = projectValue(envelope ?? {}, vars ?? {}, "model_profile", "ELIOTR_MODEL_PROFILE_DEFINITION_JSON");
  const modelProfile = typeof modelProfileValue === "object" && modelProfileValue !== null
    ? object(modelProfileValue, "model profile") : undefined;
  const profileJson = sourceString(modelProfile?.config_json ?? modelProfileValue, "model profile JSON");
  const profileProvenance = sourceProvenance(modelProfile?.provenance_ref ??
    projectValue(envelope ?? {}, vars ?? {}, "model_profile_provenance_ref", "ELIOTR_MODEL_PROFILE_PROVENANCE_REF"), "model profile provenance");
  const spendValue = projectValue(envelope ?? {}, vars ?? {}, "spend_policy", "ELIOTR_MODEL_SPEND_POLICY_JSON");
  const spendRecord = typeof spendValue === "object" ? object(spendValue, "spend policy") : undefined;
  const spendJson = sourceString(spendRecord?.config_json ?? spendValue, "spend policy JSON");
  const spendProvenance = sourceProvenance(spendRecord?.provenance_ref ??
    projectValue(envelope ?? {}, vars ?? {}, "spend_policy_provenance_ref", "ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF"), "spend policy provenance");
  const reportValue = projectValue(envelope ?? {}, vars ?? {}, "report", "ELIOTR_RESEARCH_REPORT_CONFIG_JSON");
  const reportRecord = typeof reportValue === "object" ? object(reportValue, "report configuration") : undefined;
  const reportJson = sourceString(reportRecord?.config_json ?? reportValue, "report configuration JSON");
  const reportProvenance = sourceProvenance(reportRecord?.provenance_ref ??
    projectValue(envelope ?? {}, vars ?? {}, "report_provenance_ref", "ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF"), "report configuration provenance");
  const selectionValue = envelope?.model_selections;
  const modelSelections = selectionValue === undefined ? Object.freeze([]) : parseModelSelections(selectionValue);
  if (!modelSelections.some((selection) => selection.stage === "SYNTHESIZE") ||
      !modelSelections.some((selection) => selection.stage === "AUDIT_CLAIMS")) {
    checkpoint("WORKFLOW_CONFIGURATION_MISSING");
  }
  const hasNativeSelection = modelSelections.some((selection) => selection.candidate_kind === "provider-native-v1");
  if (hasNativeSelection && (projectConfiguration?.owner_ref === undefined || projectConfiguration.project_id === undefined)) {
    checkpoint("WORKFLOW_CONFIGURATION_INVALID");
  }
  const spend = jsonObject(spendJson, "spend policy");
  const mode: ResearchRunConfigurationMode = typeof spend.protocol === "string" && spend.protocol.endsWith("template.v2")
    ? "snapshot-v2" : "snapshot-v1";
  if (hasNativeSelection && mode !== "snapshot-v2") checkpoint("WORKFLOW_CONFIGURATION_INVALID");
  if (![profileJson, profileProvenance, spendJson, spendProvenance, reportJson, reportProvenance]
      .every((value) => typeof value === "string" && value.trim() !== "") ||
      !port.model_transport_available(environment)) {
    checkpoint("WORKFLOW_CONFIGURATION_MISSING");
  }
  const snapshot: SnapshotEnvelope = Object.freeze({ protocol: RESEARCH_RUN_CONFIGURATION_PROTOCOL, mode,
    association: actor, project_configuration: projectConfiguration, model_selections: modelSelections, semantic,
    model_profile: Object.freeze({ config_json: profileJson, provenance_ref: profileProvenance }),
    spend_policy: Object.freeze({ config_json: spendJson, provenance_ref: spendProvenance }),
    report: Object.freeze({ config_json: reportJson, provenance_ref: reportProvenance }),
    ...(nativeAcquisitionSelection === undefined ? {} : {
      native_acquisition_selection: nativeAcquisitionSelection,
    }) });
  return Object.freeze({ mode, configuration_json: canonicalJson(snapshot) });
}

export async function captureResearchRunConfiguration<RuntimeEnvironment>(
  env: RuntimeEnvironment,
  raw: CaptureResearchRunConfigurationInput,
  port: ResearchRunConfigurationRuntimePort<RuntimeEnvironment>,
): Promise<ResolvedResearchRunConfiguration<RuntimeEnvironment>> {
  const actor = association(raw);
  const store = createD1ResearchRunConfigurationStore(port.database);
  try {
    const existing = await store.getByOperation(actor.operation_id);
    if (existing !== null) {
      if (!sameAssociation(existing, actor)) checkpoint("WORKFLOW_AUTHORITY_STALE");
      return await resolved(env, existing, port);
    }
    if (raw.select_project_configuration === undefined) checkpoint("WORKFLOW_CONFIGURATION_MISSING");
    let selectedProject: SelectedResearchProjectConfiguration | null;
    try {
      selectedProject = await raw.select_project_configuration();
    } catch (error) {
      const typed = port.translate_project_selection_failure?.(error) ?? null;
      if (typed !== null) throw typed;
      throw error;
    }
    if (selectedProject === null || selectedProject === undefined) checkpoint("WORKFLOW_CONFIGURATION_MISSING");
    const snapshot = await composeSnapshot(env, actor, selectedProject, port);
    await store.putImmutable({ ...actor, mode: snapshot.mode, configuration_json: snapshot.configuration_json });
    const persisted = await store.getByOperation(actor.operation_id);
    if (persisted === null || !sameAssociation(persisted, actor) || persisted.configuration_json !== snapshot.configuration_json) {
      checkpoint("WORKFLOW_CONFIGURATION_INVALID");
    }
    return await resolved(env, persisted, port);
  } catch (error) { runBindingError(error, port); }
}

export async function attachResearchRunConfiguration<RuntimeEnvironment>(
  env: RuntimeEnvironment,
  raw: ResearchRunConfigurationAssociation,
  expected: Pick<ResolvedResearchRunConfiguration<RuntimeEnvironment>, "mode" | "configuration_ref" | "configuration_sha256">,
  port: ResearchRunConfigurationRuntimePort<RuntimeEnvironment>,
): Promise<void> {
  const actor = association(raw);
  if (expected.mode === "legacy-installed" || expected.configuration_ref === null || expected.configuration_sha256 === null) {
    checkpoint("WORKFLOW_CONFIGURATION_INVALID");
  }
  const row = await currentRunBinding(port.database, actor, port);
  if (row.configuration_required !== 1) checkpoint("WORKFLOW_AUTHORITY_STALE");
  const record = await lookupSnapshot(port.database, actor, port);
  if (record === null || !sameAssociation(record, actor) || record.configuration_ref !== expected.configuration_ref ||
      record.configuration_sha256 !== expected.configuration_sha256 || record.mode !== expected.mode) {
    checkpoint("WORKFLOW_CONFIGURATION_INVALID");
  }
  if (row.configuration_ref === null) {
    try {
      await port.database.prepare("UPDATE research_workflow_run SET configuration_ref=?1 WHERE operation_id=?2 AND configuration_ref IS NULL")
        .bind(record.configuration_ref, actor.operation_id).run();
    } catch (error) { runBindingError(error, port); }
  } else if (row.configuration_ref !== record.configuration_ref) checkpoint("WORKFLOW_AUTHORITY_STALE");
  const readback = await currentRunBinding(port.database, actor, port);
  if (readback.configuration_required !== 1 || readback.configuration_ref !== record.configuration_ref) {
    checkpoint("WORKFLOW_CONFIGURATION_INVALID");
  }
}

/** Reconcile a crash after the immutable snapshot write but before its W2 pointer attach. */
export async function reconcileResearchRunConfigurationBinding<RuntimeEnvironment>(
  env: RuntimeEnvironment,
  raw: ResearchRunConfigurationAssociation,
  port: ResearchRunConfigurationRuntimePort<RuntimeEnvironment>,
): Promise<void> {
  const actor = association(raw);
  const row = await currentRunBinding(port.database, actor, port);
  const record = await lookupSnapshot(port.database, actor, port);
  if (row.configuration_required === 0) {
    if (row.configuration_ref !== null || record !== null) checkpoint("WORKFLOW_CONFIGURATION_INVALID");
    return;
  }
  if (record === null || !sameAssociation(record, actor)) checkpoint("WORKFLOW_CONFIGURATION_INVALID");
  await attachResearchRunConfiguration(env, actor, { mode: record.mode, configuration_ref: record.configuration_ref,
    configuration_sha256: record.configuration_sha256 }, port);
}

/** Resolve the immutable run snapshot; only pre-migration rows may use installed Worker config. */
export async function readResearchRunConfiguration<RuntimeEnvironment>(
  env: RuntimeEnvironment,
  raw: ResearchRunConfigurationAssociation,
  port: ResearchRunConfigurationRuntimePort<RuntimeEnvironment>,
): Promise<ResolvedResearchRunConfiguration<RuntimeEnvironment>> {
  const actor = association(raw);
  const row = await currentRunBinding(port.database, actor, port);
  const record = await lookupSnapshot(port.database, actor, port);
  if (row.configuration_required === 0) {
    if (row.configuration_ref !== null || record !== null) checkpoint("WORKFLOW_CONFIGURATION_INVALID");
    return legacy(env);
  }
  if (row.configuration_ref === null || record === null || !sameAssociation(record, actor) ||
      row.configuration_ref !== record.configuration_ref) checkpoint("WORKFLOW_CONFIGURATION_INVALID");
  return await resolved(env, record, port);
}
