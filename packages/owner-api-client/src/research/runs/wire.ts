/** C3-RR shared research-run wire helpers, moved mechanically from the legacy workspace.
 *
 * Every fence, bound and rejection message is preserved exactly. The only change is that the error
 * factory is injected, so this module imports no legacy package and never builds its own error class.
 * All helpers are declared functions, so no inferred return type exists anywhere in this file.
 */

import { IdentifierSchema, VersionedRefSchema, type VersionedRef } from "@eliotr/contracts";
import type { LegacyErrorFactory } from "../../legacy/http";

const SAFE_TRACE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export interface ResearchRunWire {
  invalid: (message?: string) => never;
  objectRecord: (value: unknown) => Record<string, unknown>;
  record: (value: unknown, required: readonly string[], optional?: readonly string[]) => Record<string, unknown>;
  boundedString: (value: unknown, label: string, maximum?: number) => string;
  isoTimestamp: (value: unknown, label: string) => string;
  identifier: (value: unknown, label: string) => string;
  versionedRef: (value: unknown, label: string) => { readonly id: string; readonly revision: number };
  sameRef: (left: VersionedRef, right: VersionedRef) => boolean;
  envelope: (value: unknown) => { readonly data: Record<string, unknown>; readonly deployment_generation: string };
  checkGeneration: (actual: string, expected: string | undefined) => void;
}

export function createResearchRunWire(errors: LegacyErrorFactory): ResearchRunWire {
  function invalid(message = "Research run response is invalid; try again"): never {
    throw errors({ code: "RESEARCH_RUN_RESPONSE_INVALID", status: 502, message, traceId: null, retryable: false });
  }

  function objectRecord(value: unknown): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) invalid();
    return value as Record<string, unknown>;
  }

  function record(
    value: unknown,
    required: readonly string[],
    optional: readonly string[] = [],
  ): Record<string, unknown> {
    const object = objectRecord(value);
    const allowed = new Set([...required, ...optional]);
    if (required.some((key) => !Object.hasOwn(object, key)) || Object.keys(object).some((key) => !allowed.has(key))) invalid();
    return object;
  }

  function boundedString(value: unknown, label: string, maximum = 256): string {
    if (typeof value !== "string" || value.length === 0 || value.length > maximum || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) invalid(`${label} is invalid`);
    return value;
  }

  function isoTimestamp(value: unknown, label: string): string {
    const timestamp = boundedString(value, label, 64);
    if (!Number.isFinite(Date.parse(timestamp)) || new Date(timestamp).toISOString() !== timestamp) invalid(`${label} is invalid`);
    return timestamp;
  }

  function identifier(value: unknown, label: string): string {
    try { return IdentifierSchema.parse(value); } catch { invalid(`${label} is invalid`); }
  }

  function versionedRef(value: unknown, label: string): { readonly id: string; readonly revision: number } {
    try { return VersionedRefSchema.parse(value); } catch { invalid(`${label} is invalid`); }
  }

  function sameRef(left: VersionedRef, right: VersionedRef): boolean {
    return left.id === right.id && left.revision === right.revision;
  }

  function envelope(value: unknown): { readonly data: Record<string, unknown>; readonly deployment_generation: string } {
    const outer = record(value, ["data", "trace_id", "deployment_generation"]);
    const trace = boundedString(outer.trace_id, "trace_id", 128);
    if (!SAFE_TRACE_ID.test(trace)) invalid("trace_id is invalid");
    return { data: objectRecord(outer.data), deployment_generation: identifier(outer.deployment_generation, "deployment_generation") };
  }

  function checkGeneration(actual: string, expected: string | undefined): void {
    if (expected !== undefined && actual !== expected) {
      throw errors({
        code: "RESEARCH_RUN_DEPLOYMENT_CHANGED",
        status: 409,
        message: "Application changed; refresh the Research run",
        traceId: null,
        retryable: true,
      });
    }
  }

  return { invalid, objectRecord, record, boundedString, isoTimestamp, identifier, versionedRef, sameRef, envelope, checkGeneration };
}
