import {
  IdentifierSchema,
  LibraryReadinessSchema,
  type LibraryCurrentnessObservation,
  type LibraryReadiness,
} from "@eliotr/contracts";
import { ApiRequestError, requestApi } from "./api.js";

export type LibraryReadinessView = LibraryReadiness;
export interface LibrarySelectionContext {
  readonly sourceRevisionRef?: string;
  readonly deploymentGeneration: string;
  readonly catalogGeneration?: string;
  readonly currentness?: LibraryCurrentnessObservation;
}

function invalid(): never {
  throw new ApiRequestError({
    status: 502,
    code: "LIBRARY_READINESS_RESPONSE_INVALID",
    message: "Search readiness is invalid; refresh the Library",
  });
}

function record(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
      keys.some((key) => !Object.hasOwn(raw, key)) ||
      Object.keys(raw).some((key) => !keys.includes(key))) invalid();
  return raw as Record<string, unknown>;
}

function id(raw: unknown): string {
  const parsed = IdentifierSchema.safeParse(raw);
  if (!parsed.success) invalid();
  return parsed.data;
}

function changed(code: "LIBRARY_DEPLOYMENT_CHANGED" | "LIBRARY_SOURCE_HEAD_CHANGED", message: string): never {
  throw new ApiRequestError({ status: 409, code, message, retryable: true });
}

export function decodeLibraryReadiness(raw: unknown, sourceId: string, expectedDeploymentGeneration?: string,
  expectedSourceRevisionRef?: string): LibraryReadinessView {
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
}

export async function readLibraryReadiness(sourceId: string, expectedDeploymentGeneration?: string,
  signal?: AbortSignal, expectedSourceRevisionRef?: string): Promise<LibraryReadinessView> {
  const parsedId = IdentifierSchema.safeParse(sourceId);
  if (!parsedId.success) invalid();
  const generation = expectedDeploymentGeneration === undefined ? undefined : id(expectedDeploymentGeneration);
  const query = new URLSearchParams({ source_id: parsedId.data });
  return decodeLibraryReadiness(
    await requestApi(`/api/v1/library/readiness?${query}`, signal ? { signal } : {}),
    parsedId.data,
    generation,
    expectedSourceRevisionRef === undefined ? undefined : id(expectedSourceRevisionRef),
  );
}
