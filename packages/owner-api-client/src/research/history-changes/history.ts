// C3-RH run history: moved mechanically from packages/pwa-research-workspace/src/research-run-api.ts.
// Envelope, record, generation and identifier policy come from the accepted shared research-run wire.
// The nested run status is the injected RR decoder, so history never carries a second copy of it.
import type {
  ResearchRunStatusDecoder,
  ResearchRunStatusView,
  ResearchRunRequest,
  ResearchRunsApiPorts,
} from "../runs/authority.js";
import type { LegacyErrorFactory } from "../../legacy/http.js";
import type { ResearchRunWire } from "../runs/wire.js";
import type { EpochPort } from "../../transport/client.js";

const MAX_RUNS = 8;
const MAX_SAVED_DRAFTS = 8;

export type { ResearchRunStatusView } from "../runs/authority.js";

export interface ResearchRunSavedDraft {
  readonly created_at: string;
  readonly artifact_ref: { readonly id: string; readonly revision: number };
  readonly workflow_instance_id?: string;
}

export interface ResearchRunHistoryEntry {
  readonly created_at: string;
  readonly status: ResearchRunStatusView;
}

export interface ResearchRunHistoryView {
  readonly protocol: "eliotr.research-runs.v1" | "eliotr.research-runs.v2" | "eliotr.research-runs.v3";
  readonly runs: readonly ResearchRunHistoryEntry[];
  readonly saved_drafts: readonly ResearchRunSavedDraft[];
  readonly configuration_state: "INSTALLED" | "MISSING";
  readonly checked_at: string;
  readonly deployment_generation: string;
}

export interface RunHistoryApiPorts {
  /** Shared owner-request seam. `widths` mirrors the RR request signature exactly. */
  readonly request: ResearchRunRequest;
  readonly errors: LegacyErrorFactory;
  /** Shared caller-owned epoch: this leaf captures it and never advances, closes or disposes it. */
  readonly epoch: EpochPort;
}

export interface RunHistoryApi {
  readonly decodeResearchRunHistory: (raw: unknown, expectedDeploymentGeneration?: string) => ResearchRunHistoryView;
  readonly readResearchRunHistory: (expectedDeploymentGeneration?: string, signal?: AbortSignal) => Promise<ResearchRunHistoryView>;
}

/**
 * History binds to the accepted run family through these two injected members. `decodeStatus` is the
 * single status decoder from `createResearchRunsApi`; `wire` is the accepted shared run wire.
 */
export interface RunHistoryDependencies {
  readonly wire: ResearchRunWire;
  readonly decodeStatus: ResearchRunStatusDecoder;
}

type DraftEntry = { readonly created_at: string; readonly artifact_ref: { readonly id: string; readonly revision: number };
  readonly workflow_instance_id?: string };

export function createRunHistoryApi(
  ports: ResearchRunsApiPorts & RunHistoryApiPorts,
  dependencies: RunHistoryDependencies,
): RunHistoryApi {
  const { request, errors, epoch } = ports;
  const { wire, decodeStatus } = dependencies;

  const closed = (): never => {
    throw errors({
      status: 503,
      code: "API_SESSION_CLOSED",
      message: "Response belongs to a closed owner session",
      traceId: null,
      retryable: false,
    });
  };

  const decodeResearchRunHistory = (raw: unknown, expectedDeploymentGeneration?: string): ResearchRunHistoryView => {
    const parsed = wire.envelope(raw);
    wire.checkGeneration(parsed.deployment_generation, expectedDeploymentGeneration);
    const data = wire.record(parsed.data,
      ["protocol", "runs", "configuration_state", "checked_at"], ["saved_drafts"]);
    const protocol: ResearchRunHistoryView["protocol"] = data.protocol as ResearchRunHistoryView["protocol"];
    if (protocol !== "eliotr.research-runs.v1" && protocol !== "eliotr.research-runs.v2" &&
        protocol !== "eliotr.research-runs.v3") {
      wire.invalid("research run history protocol is invalid");
    }
    const configurationState: ResearchRunHistoryView["configuration_state"] =
      data.configuration_state as ResearchRunHistoryView["configuration_state"];
    if (configurationState !== "INSTALLED" && configurationState !== "MISSING") {
      wire.invalid("research run configuration state is invalid");
    }
    const checkedAt = wire.isoTimestamp(data.checked_at, "checked_at");
    if (!Array.isArray(data.runs) || (data.runs as unknown[]).length > MAX_RUNS) wire.invalid("research run history is invalid");
    const seen = new Set<string>();
    const runEntries = (data.runs as unknown[]).map((value: unknown, index: number) => {
      const entry = wire.record(value, ["created_at", "status"]);
      const createdAt = wire.isoTimestamp(entry.created_at, `runs[${index}].created_at`);
      const status = decodeStatus(
        { data: entry.status, trace_id: "research-history", deployment_generation: parsed.deployment_generation },
        parsed.deployment_generation,
      );
      if (seen.has(status.workflow_instance_id)) wire.invalid("research run history contains a duplicate run");
      seen.add(status.workflow_instance_id);
      return { created_at: createdAt, status };
    });
    const savedDrafts: DraftEntry[] = [];
    if (Object.hasOwn(data, "saved_drafts")) {
      if (!Array.isArray(data.saved_drafts) || (data.saved_drafts as unknown[]).length > MAX_SAVED_DRAFTS) {
        wire.invalid("saved research drafts are invalid");
      }
      const draftRefs = new Set<string>();
      (data.saved_drafts as unknown[]).forEach((value: unknown, index: number) => {
        const entry = wire.record(value, ["created_at", "artifact_ref"], ["workflow_instance_id"]);
        const createdAt = wire.isoTimestamp(entry.created_at, `saved_drafts[${index}].created_at`);
        const artifactRef = wire.versionedRef(entry.artifact_ref, `saved_drafts[${index}].artifact_ref`);
        const workflowInstanceId = Object.hasOwn(entry, "workflow_instance_id")
          ? wire.identifier(entry.workflow_instance_id, `saved_drafts[${index}].workflow_instance_id`)
          : undefined;
        const key = `${artifactRef.id}:${artifactRef.revision}`;
        if (draftRefs.has(key)) wire.invalid("saved research drafts contain a duplicate artifact");
        draftRefs.add(key);
        savedDrafts.push({ created_at: createdAt, artifact_ref: artifactRef,
          ...(workflowInstanceId === undefined ? {} : { workflow_instance_id: workflowInstanceId }) });
      });
    }
    if ((protocol === "eliotr.research-runs.v2" || protocol === "eliotr.research-runs.v3") &&
        !Object.hasOwn(data, "saved_drafts")) {
      wire.invalid("research run history is missing saved drafts");
    }
    return {
      protocol,
      runs: runEntries,
      saved_drafts: savedDrafts,
      configuration_state: configurationState,
      checked_at: checkedAt,
      deployment_generation: parsed.deployment_generation,
    };
  };

  const readResearchRunHistory = async (
    expectedDeploymentGeneration?: string,
    signal?: AbortSignal,
  ): Promise<ResearchRunHistoryView> => {
    // Preflight: an already-closed or missing epoch never dispatches.
    const captured = epoch.capture();
    if (captured === undefined || !epoch.isCurrent(captured)) closed();
    const raw = await request(`/api/v1/research/runs`, signal === undefined ? {} : { signal }, [200]);
    const view = decodeResearchRunHistory(raw, expectedDeploymentGeneration);
    // Post-await/post-decode fence: a stale response never reaches the caller.
    if (!epoch.isCurrent(captured)) closed();
    return view;
  };

  return { decodeResearchRunHistory, readResearchRunHistory };
}
