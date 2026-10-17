/**
 * C3-RC research configuration readiness.
 *
 * Mechanically moved from `packages/pwa-research-workspace/src/research-configuration-api.ts`. Every strict
 * decoder rule, both protocol families, the readiness cross-field validation and each error code are
 * preserved unchanged. Requests ride the injected legacy seam, which owns path policy, protected
 * headers, deadlines and authorization observation.
 */

import type { LegacyErrorFactory, LegacyHttpAdapter } from '../../legacy/http';
import type { EpochPort } from '../../transport/client';

const RESEARCH_CONFIGURATION_PATH = "/api/v1/system/research-configuration";
const RESEARCH_CONFIGURATION_PROTOCOL = "eliotr.research-configuration-readiness.v1";
const RESEARCH_METHOD_READINESS_PROTOCOL = "eliotr.research-configuration-method-readiness.v1";
const LEGACY_RESEARCH_CONFIGURATION_PROTOCOL = "eliotr.research-configuration-status.v1";
const SAFE_GENERATION = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const SAFE_TRACE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

type JsonRecord = Record<string, unknown>;

export type ResearchConfigurationState = "missing" | "present" | "invalid";
export type ResearchModelTransport = "available" | "unavailable";
export type ResearchQualificationState = "current" | "renewal_required" | "unavailable";
export type ResearchRunReadiness = "ready" | "lazy_renewal" | "blocked";
export type ResearchConfigurationReadinessReason =
  | "CONFIGURATION_NOT_READY"
  | "MODEL_TRANSPORT_UNAVAILABLE"
  | "QUALIFICATION_PROOFS_CURRENT"
  | "QUALIFICATION_RENEWAL_AT_RUN"
  | "QUALIFICATION_RENEWAL_READ_TOKEN_REQUIRED"
  | "QUALIFICATION_UNAVAILABLE";

export interface ResearchConfigurationView {
  readonly protocol: typeof RESEARCH_CONFIGURATION_PROTOCOL | typeof LEGACY_RESEARCH_CONFIGURATION_PROTOCOL;
  readonly configuration: ResearchConfigurationState;
  readonly model_transport: ResearchModelTransport;
  readonly qualification_state: ResearchQualificationState;
  readonly run_readiness: ResearchRunReadiness;
  readonly readiness_reason: ResearchConfigurationReadinessReason;
  readonly model_route: string | null;
  readonly qualification_expires_at: string | null;
  readonly missing_fields: readonly string[];
  readonly invalid_fields: readonly string[];
  readonly checked_at: string;
  readonly trace_id: string;
  readonly deployment_generation: string;
}

export interface ReadResearchConfigurationOptions {
  readonly projectId?: string;
  readonly signal?: AbortSignal;
}

export interface ResearchConfigurationMethodReadinessPin {
  readonly configuration_project_id: string;
  readonly configuration_ref: string;
  readonly configuration_sha256: string;
  readonly selection_revision: number;
}

export type EvidenceReviewHandlerGeneration = "V7" | "V9";
export type EvidenceReviewUnavailableReason = "CURRENT_SELECTION_REQUIRED" | "MODEL_READINESS_UNAVAILABLE" |
  "STAGE_BINDINGS_UNAVAILABLE" | "V9_BRANCH_BUDGET_UNAVAILABLE" | "V9_MANAGED_SEARCH_UNAVAILABLE";

export interface ResearchConfigurationMethodReadinessView {
  readonly protocol: typeof RESEARCH_METHOD_READINESS_PROTOCOL;
  readonly project_id: string;
  readonly selected_pin: ResearchConfigurationMethodReadinessPin;
  readonly evidence_review_ready: boolean;
  readonly evidence_review_handler_generation: EvidenceReviewHandlerGeneration | null;
  readonly evidence_review_unavailable_reason: EvidenceReviewUnavailableReason | null;
  readonly checked_at: string;
  readonly trace_id: string;
  readonly deployment_generation: string;
}

export type ReadinessHttp = Pick<LegacyHttpAdapter, 'requestApi'>;

export function createResearchConfigurationApi(
  http: ReadinessHttp,
  errors: LegacyErrorFactory,
  epoch: EpochPort,
) {
  function isRecord(value: unknown): value is JsonRecord {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  function schemaMismatch(message: string): never {
    throw errors({
      status: 502,
      code: "API_RESPONSE_SCHEMA_MISMATCH",
      message,
      traceId: null,
      retryable: false,
    });
  }

  function generationMismatch(message: string): never {
    throw errors({
      status: 409,
      code: "API_GENERATION_MISMATCH",
      message,
      traceId: null,
      retryable: true,
    });
  }

  function exactRecord(value: unknown, keys: readonly string[], label: string): JsonRecord {
    if (!isRecord(value) || Object.keys(value).length !== keys.length ||
        keys.some((key) => !Object.hasOwn(value, key)) ||
        Object.keys(value).some((key) => !keys.includes(key))) {
      schemaMismatch(`${label} has missing or unknown fields`);
    }
    return value;
  }

  function boundedText(value: unknown, label: string, maximumLength: number): string {
    if (typeof value !== "string" || value.length === 0 || value.length > maximumLength ||
        value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
      schemaMismatch(`${label} is not a valid bounded string`);
    }
    return value;
  }

  function generation(value: unknown, label: string): string {
    const text = boundedText(value, label, 256);
    if (!SAFE_GENERATION.test(text)) schemaMismatch(`${label} is not a valid deployment generation`);
    return text;
  }

  function traceId(value: unknown): string {
    const text = boundedText(value, "trace_id", 128);
    if (!SAFE_TRACE_ID.test(text)) schemaMismatch("trace_id is invalid");
    return text;
  }

  function timestamp(value: unknown, label = "checked_at"): string {
    const text = boundedText(value, label, 64);
    const parsed = Date.parse(text);
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== text) {
      schemaMismatch(`${label} must be a canonical ISO timestamp`);
    }
    return text;
  }

  function nullableRoute(value: unknown): string | null {
    if (value === null) return null;
    const route = boundedText(value, "model_route", 256);
    if (!SAFE_GENERATION.test(route)) schemaMismatch("model_route is invalid");
    return route;
  }

  function nullableTimestamp(value: unknown): string | null {
    return value === null ? null : timestamp(value, "qualification_expires_at");
  }

  function fieldList(value: unknown, label: string): readonly string[] {
    if (!Array.isArray(value) || value.length > 128) {
      schemaMismatch(`${label} must be a bounded string array`);
    }
    const fields = value.map((item, index) => boundedText(item, `${label}[${index}]`, 256));
    if (new Set(fields).size !== fields.length) schemaMismatch(`${label} contains duplicates`);
    return fields;
  }

  function expectedGeneration(value: string): string {
    if (typeof value !== "string" || value.length === 0 || value !== value.trim() ||
        !SAFE_GENERATION.test(value)) {
      generationMismatch("The current deployment generation is unavailable.");
    }
    return value;
  }

  function commonFields(data: JsonRecord): {
    readonly configuration: ResearchConfigurationState;
    readonly model_transport: ResearchModelTransport;
    readonly missing_fields: readonly string[];
    readonly invalid_fields: readonly string[];
    readonly checked_at: string;
  } {
    const configuration = data.configuration;
    if (configuration !== "missing" && configuration !== "present" && configuration !== "invalid") {
      schemaMismatch("research configuration state is invalid");
    }
    const modelTransport = data.model_transport;
    if (modelTransport !== "available" && modelTransport !== "unavailable") {
      schemaMismatch("research model transport state is invalid");
    }
    return {
      configuration,
      model_transport: modelTransport,
      missing_fields: fieldList(data.missing_fields, "missing_fields"),
      invalid_fields: fieldList(data.invalid_fields, "invalid_fields"),
      checked_at: timestamp(data.checked_at),
    };
  }

  function readinessReason(value: unknown): ResearchConfigurationReadinessReason {
    const reasons: readonly ResearchConfigurationReadinessReason[] = [
      "CONFIGURATION_NOT_READY",
      "MODEL_TRANSPORT_UNAVAILABLE",
      "QUALIFICATION_PROOFS_CURRENT",
      "QUALIFICATION_RENEWAL_AT_RUN",
      "QUALIFICATION_RENEWAL_READ_TOKEN_REQUIRED",
      "QUALIFICATION_UNAVAILABLE",
    ];
    if (typeof value !== "string" || !reasons.includes(value as ResearchConfigurationReadinessReason)) {
      schemaMismatch("research readiness reason is invalid");
    }
    return value as ResearchConfigurationReadinessReason;
  }

  /** The readiness cross-field contract; an inconsistent row is a schema mismatch, never a guess. */
  function validateReadiness(
    configuration: ResearchConfigurationState,
    modelTransport: ResearchModelTransport,
    qualification: ResearchQualificationState,
    run: ResearchRunReadiness,
    reason: ResearchConfigurationReadinessReason,
  ): void {
    if (configuration !== "present" && reason !== "CONFIGURATION_NOT_READY") schemaMismatch("research readiness configuration is inconsistent");
    if (configuration === "present" && modelTransport !== "available" && reason !== "MODEL_TRANSPORT_UNAVAILABLE") schemaMismatch("research readiness transport is inconsistent");
    if (run === "ready" && (qualification !== "current" || reason !== "QUALIFICATION_PROOFS_CURRENT")) schemaMismatch("ready research state is inconsistent");
    if (run === "lazy_renewal" && (qualification !== "renewal_required" || reason !== "QUALIFICATION_RENEWAL_AT_RUN")) schemaMismatch("lazy research state is inconsistent");
    if (reason === "QUALIFICATION_RENEWAL_READ_TOKEN_REQUIRED" && (qualification !== "renewal_required" || run !== "blocked")) schemaMismatch("research renewal blocker is inconsistent");
    if (reason === "QUALIFICATION_UNAVAILABLE" && (qualification !== "unavailable" || run !== "blocked")) schemaMismatch("research qualification state is inconsistent");
    if (reason === "CONFIGURATION_NOT_READY" && run !== "blocked") schemaMismatch("research configuration blocker is inconsistent");
    if (reason === "MODEL_TRANSPORT_UNAVAILABLE" && run !== "blocked") schemaMismatch("research transport blocker is inconsistent");
  }

  /**
   * Pure decode, exposed so callers keep the original entry point. It performs no epoch check: a pure
   * decode of already-verified bytes cannot be made stale by a session change.
   */
  function decode(value: unknown, expected: string): ResearchConfigurationView {
    const envelope = exactRecord(value, ["data", "trace_id", "deployment_generation"], "research configuration envelope");
    const envelopeGeneration = generation(envelope.deployment_generation, "deployment_generation");
    if (envelopeGeneration !== expected) generationMismatch("The application changed; refresh the research configuration.");
    const trace = traceId(envelope.trace_id);
    if (!isRecord(envelope.data) || typeof envelope.data.protocol !== "string") schemaMismatch("research configuration data is invalid");
    const protocol = envelope.data.protocol;
    if (protocol === RESEARCH_CONFIGURATION_PROTOCOL) {
      const data = exactRecord(envelope.data, [
        "protocol", "configuration", "model_transport", "qualification_state", "run_readiness",
        "readiness_reason", "model_route", "qualification_expires_at", "missing_fields", "invalid_fields", "checked_at",
      ], "research configuration readiness data");
      const common = commonFields(data);
      const qualification = data.qualification_state;
      if (qualification !== "current" && qualification !== "renewal_required" && qualification !== "unavailable") schemaMismatch("research qualification state is invalid");
      const run = data.run_readiness;
      if (run !== "ready" && run !== "lazy_renewal" && run !== "blocked") schemaMismatch("research run readiness is invalid");
      const reason = readinessReason(data.readiness_reason);
      validateReadiness(common.configuration, common.model_transport, qualification, run, reason);
      return {
        protocol: RESEARCH_CONFIGURATION_PROTOCOL,
        ...common,
        qualification_state: qualification,
        run_readiness: run,
        readiness_reason: reason,
        model_route: nullableRoute(data.model_route),
        qualification_expires_at: nullableTimestamp(data.qualification_expires_at),
        trace_id: trace,
        deployment_generation: envelopeGeneration,
      };
    }
    if (protocol !== LEGACY_RESEARCH_CONFIGURATION_PROTOCOL) schemaMismatch("research configuration protocol is invalid");
    const data = exactRecord(envelope.data, [
      "protocol", "configuration", "model_transport", "missing_fields", "invalid_fields", "checked_at",
    ], "legacy research configuration data");
    const common = commonFields(data);
    const legacyReason = common.configuration !== "present"
      ? "CONFIGURATION_NOT_READY"
      : common.model_transport !== "available" ? "MODEL_TRANSPORT_UNAVAILABLE" : "QUALIFICATION_UNAVAILABLE";
    return {
      protocol: LEGACY_RESEARCH_CONFIGURATION_PROTOCOL,
      ...common,
      qualification_state: "unavailable",
      run_readiness: "blocked",
      readiness_reason: legacyReason,
      model_route: null,
      qualification_expires_at: null,
      trace_id: trace,
      deployment_generation: envelopeGeneration,
    };
  }

  function decodeMethodReadiness(value: unknown, expected: string, expectedProjectId: string,
    expectedPin: ResearchConfigurationMethodReadinessPin): ResearchConfigurationMethodReadinessView {
    const envelope = exactRecord(value, ["data", "trace_id", "deployment_generation"], "research method readiness envelope");
    const envelopeGeneration = generation(envelope.deployment_generation, "deployment_generation");
    if (envelopeGeneration !== expected) generationMismatch("The application changed; refresh method readiness.");
    const trace = traceId(envelope.trace_id);
    const data = exactRecord(envelope.data, ["protocol", "project_id", "selected_pin", "evidence_review_ready",
      "evidence_review_handler_generation", "evidence_review_unavailable_reason", "checked_at"],
      "research method readiness data");
    if (data.protocol !== RESEARCH_METHOD_READINESS_PROTOCOL) schemaMismatch("research method readiness protocol is invalid");
    const projectId = boundedText(data.project_id, "project_id", 256);
    if (!SAFE_GENERATION.test(projectId) || projectId !== expectedProjectId) {
      schemaMismatch("research method readiness belongs to a different project");
    }
    const rawPin = exactRecord(data.selected_pin, ["configuration_project_id", "configuration_ref",
      "configuration_sha256", "selection_revision"], "research method readiness pin");
    const pinProject = boundedText(rawPin.configuration_project_id, "configuration_project_id", 256);
    const pinRef = boundedText(rawPin.configuration_ref, "configuration_ref", 256);
    const pinSha = boundedText(rawPin.configuration_sha256, "configuration_sha256", 64);
    const revision = rawPin.selection_revision;
    if (!SAFE_GENERATION.test(pinProject) || !/^rpmc-[a-f0-9]{64}$/u.test(pinRef) ||
        !/^[a-f0-9]{64}$/u.test(pinSha) || !Number.isSafeInteger(revision) || (revision as number) < 1 ||
        (revision as number) > 1_000_000 || pinProject !== expectedProjectId ||
        pinProject !== expectedPin.configuration_project_id || pinRef !== expectedPin.configuration_ref ||
        pinSha !== expectedPin.configuration_sha256 || revision !== expectedPin.selection_revision) {
      schemaMismatch("research method readiness pin does not match the requested current selection");
    }
    if (typeof data.evidence_review_ready !== "boolean") schemaMismatch("evidence review readiness is invalid");
    const handlerGeneration = data.evidence_review_handler_generation;
    if (handlerGeneration !== null && handlerGeneration !== "V7" && handlerGeneration !== "V9") {
      schemaMismatch("evidence review handler generation is invalid");
    }
    const unavailableReason = data.evidence_review_unavailable_reason;
    const unavailableReasons: readonly EvidenceReviewUnavailableReason[] = ["CURRENT_SELECTION_REQUIRED", "MODEL_READINESS_UNAVAILABLE",
      "STAGE_BINDINGS_UNAVAILABLE", "V9_BRANCH_BUDGET_UNAVAILABLE", "V9_MANAGED_SEARCH_UNAVAILABLE"];
    if (unavailableReason !== null && (typeof unavailableReason !== "string" ||
        !unavailableReasons.includes(unavailableReason as EvidenceReviewUnavailableReason))) {
      schemaMismatch("evidence review unavailability reason is invalid");
    }
    if (data.evidence_review_ready !== (handlerGeneration !== null) ||
        (handlerGeneration === null) !== (unavailableReason !== null)) {
      schemaMismatch("evidence review availability fields are inconsistent");
    }
    return { protocol: RESEARCH_METHOD_READINESS_PROTOCOL, project_id: projectId,
      selected_pin: { configuration_project_id: pinProject, configuration_ref: pinRef,
        configuration_sha256: pinSha, selection_revision: revision as number },
      evidence_review_ready: data.evidence_review_ready, evidence_review_handler_generation: handlerGeneration,
      evidence_review_unavailable_reason: unavailableReason as EvidenceReviewUnavailableReason | null,
      checked_at: timestamp(data.checked_at),
      trace_id: trace, deployment_generation: envelopeGeneration };
  }

  /** Reads readiness for the selected project, or owner-installed readiness when no project is supplied. */
  async function readResearchConfiguration(
    expectedDeploymentGeneration: string,
    options: ReadResearchConfigurationOptions = {},
  ): Promise<ResearchConfigurationView> {
    // Preflight fence: an already-closed session never starts a request.
    const preflight = epoch.capture();
    if (!epoch.isCurrent(preflight)) {
      throw errors({
        code: "API_SESSION_CLOSED",
        status: 503,
        message: "Response belongs to a closed owner session",
        traceId: null,
        retryable: false,
      });
    }
    const expected = expectedGeneration(expectedDeploymentGeneration);
    let path = RESEARCH_CONFIGURATION_PATH;
    if (options.projectId !== undefined) {
      const projectId = options.projectId;
      if (typeof projectId !== "string" || projectId.length === 0 || projectId.length > 256 ||
          projectId !== projectId.trim() || !SAFE_GENERATION.test(projectId)) {
        throw errors({ status: 400, code: "RESEARCH_PROJECT_ID_INVALID", message: "Project id is invalid.", traceId: null, retryable: false });
      }
      const query = new URLSearchParams({ project_id: projectId });
      path = `${path}?${query.toString()}`;
    }
    const raw = await http.requestApi(path, options.signal === undefined ? {} : { signal: options.signal });
    const view = decode(raw, expected);
    // Final fence: a result that crossed a session change is stale output, never usable readiness.
    if (!epoch.isCurrent(preflight)) stale();
    return view;
  }

  /** Explicit opt-in read for V5 methods; it never changes the strict V1 response contract. */
  async function readResearchMethodReadiness(
    expectedDeploymentGeneration: string,
    projectId: string,
    selectionPin: ResearchConfigurationMethodReadinessPin,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<ResearchConfigurationMethodReadinessView> {
    const preflight = epoch.capture();
    if (!epoch.isCurrent(preflight)) {
      throw errors({ code: "API_SESSION_CLOSED", status: 503, message: "Response belongs to a closed owner session",
        traceId: null, retryable: false });
    }
    const expected = expectedGeneration(expectedDeploymentGeneration);
    const pinKeys = ["configuration_project_id", "configuration_ref", "configuration_sha256", "selection_revision"];
    if (typeof projectId !== "string" || projectId.length === 0 || projectId.length > 256 ||
        projectId !== projectId.trim() || !SAFE_GENERATION.test(projectId) ||
        !isRecord(selectionPin) || Object.keys(selectionPin).length !== pinKeys.length ||
        Object.keys(selectionPin).some(key => !pinKeys.includes(key)) ||
        selectionPin.configuration_project_id !== projectId ||
        !/^rpmc-[a-f0-9]{64}$/u.test(selectionPin.configuration_ref) ||
        !/^[a-f0-9]{64}$/u.test(selectionPin.configuration_sha256) ||
        !Number.isSafeInteger(selectionPin.selection_revision) || selectionPin.selection_revision < 1 ||
        selectionPin.selection_revision > 1_000_000) {
      throw errors({ status: 400, code: "RESEARCH_METHOD_SELECTION_INVALID",
        message: "The method readiness selection is invalid.", traceId: null, retryable: false });
    }
    const query = new URLSearchParams({ project_id: projectId, capability: "research-methods-v1",
      configuration_project_id: selectionPin.configuration_project_id,
      configuration_ref: selectionPin.configuration_ref, configuration_sha256: selectionPin.configuration_sha256,
      selection_revision: String(selectionPin.selection_revision) });
    const raw = await http.requestApi(`${RESEARCH_CONFIGURATION_PATH}?${query.toString()}`,
      options.signal === undefined ? {} : { signal: options.signal });
    const view = decodeMethodReadiness(raw, expected, projectId, selectionPin);
    if (!epoch.isCurrent(preflight)) stale();
    return view;
  }

  function stale(): never {
    throw errors({
      code: "API_SESSION_CLOSED",
      status: 503,
      message: "Response belongs to a closed owner session",
      traceId: null,
      retryable: false,
    });
  }

  return { decode, readResearchConfiguration, readResearchMethodReadiness };
}
