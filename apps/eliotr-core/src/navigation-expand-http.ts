import { VersionedRefSchema, type ScopeSnapshot, type VersionedRef } from "@eliotr/contracts";
import {
  parseIdentifier,
  parseNavigationScopeSnapshot,
  type NavigationExpansionRequest,
} from "@eliotr/retrieval";
import { readJsonBodyWithinBytes } from "./bounded-json.js";
import { HttpRequestError } from "./http-errors.js";

function fail(message: string): never {
  throw new HttpRequestError("NAVIGATION_INPUT_INVALID", 400, message);
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail("navigation expansion request must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value);
  if (actual.length !== expected.length || actual.some((key) => !expected.includes(key))) {
    fail("navigation expansion request contains unknown or missing fields");
  }
}

function scopeSnapshot(value: unknown): ScopeSnapshot {
  try {
    return parseNavigationScopeSnapshot(value);
  } catch {
    fail("scope_snapshot is invalid");
  }
}

function identifier(value: unknown, label: string): string {
  try {
    return parseIdentifier(value, label);
  } catch {
    fail(`${label} is invalid`);
  }
}

function versionedRef(value: unknown, label: string): VersionedRef {
  const parsed = VersionedRefSchema.safeParse(value);
  if (!parsed.success) fail(`${label} is invalid`);
  return parsed.data;
}

/** Strict transport decoder for the already-existing NavigationExpansionRequest union. */
export function parseNavigationExpansionRequest(value: unknown): NavigationExpansionRequest {
  const record = object(value);
  if (typeof record.kind !== "string") fail("navigation expansion kind is invalid");
  const scope = scopeSnapshot(record.scope_snapshot);
  switch (record.kind) {
    case "ATLAS_NODE":
      exactKeys(record, ["kind", "scope_snapshot", "project_ref", "node_id"]);
      return {
        kind: "ATLAS_NODE",
        scope_snapshot: scope,
        project_ref: versionedRef(record.project_ref, "project_ref"),
        node_id: identifier(record.node_id, "node_id"),
      };
    case "SOURCE_CARD":
      exactKeys(record, ["kind", "scope_snapshot", "source_revision_ref"]);
      return {
        kind: "SOURCE_CARD",
        scope_snapshot: scope,
        source_revision_ref: identifier(record.source_revision_ref, "source_revision_ref"),
      };
    case "DOCUMENT_MAP":
      exactKeys(record, ["kind", "scope_snapshot", "source_revision_ref"]);
      return {
        kind: "DOCUMENT_MAP",
        scope_snapshot: scope,
        source_revision_ref: identifier(record.source_revision_ref, "source_revision_ref"),
      };
    case "SECTION":
      exactKeys(record, ["kind", "scope_snapshot", "source_revision_ref", "section_ref"]);
      return {
        kind: "SECTION",
        scope_snapshot: scope,
        source_revision_ref: identifier(record.source_revision_ref, "source_revision_ref"),
        section_ref: identifier(record.section_ref, "section_ref"),
      };
    default:
      fail("navigation expansion kind is unsupported");
  }
}

export async function readNavigationExpansionRequest(
  request: Request,
  maximumBytes: number,
): Promise<NavigationExpansionRequest> {
  return parseNavigationExpansionRequest(await readJsonBodyWithinBytes(request, maximumBytes));
}
