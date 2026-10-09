// C2-R owner-client move of packages/pwa-source-workspace/src/library-readiness-api.ts.
// Wire/value implementation moves here verbatim; only the transport and epoch seams are injected.
// No new DTO, schema, endpoint, identifier or retry rule is introduced.
import {
  IdentifierSchema,
  LibraryReadinessSchema,
  type LibraryCurrentnessObservation,
  type LibraryReadiness,
} from "@eliotr/contracts";
import type { LegacyErrorFactory, LegacyHttpAdapter } from "../../legacy/http.js";
import type { EpochPort } from "../../transport/client.js";

export type LibraryReadinessView = LibraryReadiness;
export interface LibrarySelectionContext {
  readonly sourceRevisionRef?: string;
  readonly deploymentGeneration: string;
  readonly catalogGeneration?: string;
  readonly currentness?: LibraryCurrentnessObservation;
}

/** Read-only decoder transport. Byte, status and header policy stays in the injected owner client. */
export type ReadinessHttp = Pick<LegacyHttpAdapter, "requestApi">;

/** Factory-owned error construction: legacy `instanceof` stays with the caller factory. */
export type ReadinessErrors = LegacyErrorFactory;

export interface ReadinessApi {
  /** Pure decoder. No epoch, no transport, no ambient state. */
  readonly decodeLibraryReadiness: (
    raw: unknown, sourceId: string,
    expectedDeploymentGeneration?: string,
    expectedSourceRevisionRef?: string,
  ) => LibraryReadinessView;
  readonly readLibraryReadiness: (
    sourceId: string,
    expectedDeploymentGeneration?: string,
    signal?: AbortSignal,
    expectedSourceRevisionRef?: string,
  ) => Promise<LibraryReadinessView>;
}

export function createReadinessApi(
  http: ReadinessHttp,
  errors: ReadinessErrors,
  epoch: EpochPort,
): ReadinessApi {
  const invalid: () => never = () => {
    throw errors({
      status: 502,
      code: "LIBRARY_READINESS_RESPONSE_INVALID",
      message: "Search readiness is invalid; refresh the Library",
      traceId: null,
      retryable: false,
    });
  };

  const record = (raw: unknown, keys: readonly string[]): Record<string, unknown> => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
        keys.some((key) => !Object.hasOwn(raw, key)) ||
        Object.keys(raw).some((key) => !keys.includes(key))) invalid();
    return raw as Record<string, unknown>;
  };

  const id = (raw: unknown): string => {
    const parsed = IdentifierSchema.safeParse(raw);
    if (!parsed.success) invalid();
    return parsed.data;
  };

  const changed = (code: "LIBRARY_DEPLOYMENT_CHANGED" | "LIBRARY_SOURCE_HEAD_CHANGED", message: string): never => {
    throw errors({ status: 409, code, message, traceId: null, retryable: true });
  };

  /** Re-checks the caller epoch after the await closes the transport fence. */
  const closed = (): never => {
    throw errors({
      status: 503,
      code: "API_SESSION_CLOSED",
      message: "Response belongs to a closed owner session",
      traceId: null,
      retryable: false,
    });
  };

  const decodeLibraryReadiness = (
    raw: unknown, sourceId: string,
    expectedDeploymentGeneration?: string,
    expectedSourceRevisionRef?: string,
  ): LibraryReadinessView => {
    const envelope = record(raw, ["data", "trace_id", "deployment_generation"]);
    const deployment = id(envelope.deployment_generation);
    id(envelope.trace_id);
    if (expectedDeploymentGeneration !== undefined && deployment !== expectedDeploymentGeneration) {
      changed("LIBRARY_DEPLOYMENT_CHANGED", "The application changed; refresh the Library");
    }
    const parsed = LibraryReadinessSchema.safeParse(envelope.data);
    if (!parsed.success || parsed.data.source_id !== sourceId || parsed.data.deployment_generation !== deployment) invalid();
    if (expectedSourceRevisionRef !== undefined && parsed.data.source_revision_ref !== expectedSourceRevisionRef) {
      changed("LIBRARY_SOURCE_HEAD_CHANGED", "The selected source changed; refresh the Library");
    }
    return parsed.data;
  };

  const readLibraryReadiness = async (
    sourceId: string,
    expectedDeploymentGeneration?: string,
    signal?: AbortSignal,
    expectedSourceRevisionRef?: string,
  ): Promise<LibraryReadinessView> => {
    const parsedId = IdentifierSchema.safeParse(sourceId);
    if (!parsedId.success) invalid();
    const generation = expectedDeploymentGeneration === undefined ? undefined : id(expectedDeploymentGeneration);
    const query = new URLSearchParams({ source_id: parsedId.data });
    const capture = epoch.capture();
    if (!capture || !epoch.isCurrent(capture)) closed();
    const raw = await http.requestApi(`/api/v1/library/readiness?${query}`, signal === undefined ? {} : { signal });
    const view = decodeLibraryReadiness(raw, parsedId.data, generation,
      expectedSourceRevisionRef === undefined ? undefined : id(expectedSourceRevisionRef));
    if (!epoch.isCurrent(capture)) closed();
    return view;
  };

  return { decodeLibraryReadiness, readLibraryReadiness };
}
