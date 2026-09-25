import { IdentifierSchema, VersionedRefSchema, type VersionedRef } from "@eliotr/contracts";
import { ApiRequestError } from "./api.js";

const SAFE_TRACE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export function invalid(message = "Research run response is invalid; try again"): never {
  throw new ApiRequestError({ status: 502, code: "RESEARCH_RUN_RESPONSE_INVALID", message });
}

export function objectRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

export function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  const object = objectRecord(value);
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(object, key)) || Object.keys(object).some((key) => !allowed.has(key))) invalid();
  return object;
}

export function boundedString(value: unknown, label: string, maximum = 256): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) invalid(`${label} is invalid`);
  return value;
}

export function isoTimestamp(value: unknown, label: string): string {
  const timestamp = boundedString(value, label, 64);
  if (!Number.isFinite(Date.parse(timestamp)) || new Date(timestamp).toISOString() !== timestamp) invalid(`${label} is invalid`);
  return timestamp;
}

export function identifier(value: unknown, label: string): string {
  try { return IdentifierSchema.parse(value); } catch { invalid(`${label} is invalid`); }
}

export function versionedRef(value: unknown, label: string): { readonly id: string; readonly revision: number } {
  try { return VersionedRefSchema.parse(value); } catch { invalid(`${label} is invalid`); }
}

export function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.revision === right.revision;
}

export function envelope(value: unknown): { readonly data: Record<string, unknown>; readonly deployment_generation: string } {
  const outer = record(value, ["data", "trace_id", "deployment_generation"]);
  const trace = boundedString(outer.trace_id, "trace_id", 128);
  if (!SAFE_TRACE_ID.test(trace)) invalid("trace_id is invalid");
  return { data: objectRecord(outer.data), deployment_generation: identifier(outer.deployment_generation, "deployment_generation") };
}

export function checkGeneration(actual: string, expected: string | undefined): void {
  if (expected !== undefined && actual !== expected) {
    throw new ApiRequestError({ status: 409, code: "RESEARCH_RUN_DEPLOYMENT_CHANGED", message: "Application changed; refresh the Research run", retryable: true });
  }
}
