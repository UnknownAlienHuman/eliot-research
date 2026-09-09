import { ExhaustivePlanError } from "./exhaustive.js";
import type { ExhaustiveSectionDescriptor, ExhaustiveSectionReader, ExhaustiveShardOutcome } from "./exhaustive.js";
import type { EvidenceHandle, ScopeSnapshot } from "@eliotr/contracts";
import type { AdmittedCoordinateMap, PinnedSourceAuthority, VerifyPinnedExactInput } from "./evidence-resolver.js";
import type { RetrievalQueryAccess, RetrievalQueryD1 } from "./query-persistence.js";

declare global {
  interface ImportMeta {
    glob(pattern: string, options: { eager: true; query: string; import: string }): Record<string, string>;
  }
}

// Committed Core migration stream is the only schema authority; no in-test DDL.
export const CORE_MIGRATIONS = import.meta.glob("../../../infra/d1/core/migrations/*.sql", {
  eager: true, query: "?raw", import: "default",
});

export interface RawStatement {
  get(...args: unknown[]): unknown;
  all(...args: unknown[]): unknown[];
  run(...args: unknown[]): { changes?: unknown };
}
export interface RawDatabase {
  prepare(sql: string): RawStatement;
  exec(sql: string): void;
}
// @ts-expect-error - node:sqlite runtime types ship with Node 22.13+, not @types/node
import { DatabaseSync } from "node:sqlite";

function spread(params: readonly unknown[]): never[] {
  return params as never[];
}

export function makeD1(database: RawDatabase): RetrievalQueryD1 {
  return {
    prepare: (sql: string) => ({
      bind: (...params: unknown[]) => ({
        async first<T>() {
          const statement = database.prepare(sql);
          const row = (params.length === 0 ? statement.get() : statement.get(...spread(params))) as T | undefined;
          return (row ?? null) as T | null;
        },
        async all<T>() {
          const statement = database.prepare(sql);
          const rows = (params.length === 0 ? statement.all() : statement.all(...spread(params))) as unknown as T[];
          return { results: rows };
        },
        async run() {
          const statement = database.prepare(sql);
          if (params.length === 0) statement.run();
          else statement.run(...spread(params));
          return { meta: { changes: 0 } };
        },
      }),
    }),
  };
}

export const CREATED = "2026-09-08T00:00:00.000Z";
export const EXPIRY = "2026-09-09T00:00:00.000Z";
export const ACCESS: RetrievalQueryAccess = {
  principal_ref: "q5-owner",
  client_class: "owner_pwa",
  credential_generation: "cred-1",
};
export const hex64 = (seed: string): string => seed.repeat(64).slice(0, 64);
export const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

export async function shaHex(text: string): Promise<string> {
  const bytes = encode(text);
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function scopeFixture(overrides: Partial<ScopeSnapshot> = {}): ScopeSnapshot {
  return {
    snapshot_id: "snap-q5",
    revision: 1,
    resolved_scope_expression: { kind: "SELECTED_SOURCES", source_ids: ["source-1", "source-2"] },
    participant_generations: { "member-policy-closure": "policy-1" },
    member_source_revision_refs: ["rev-1", "rev-2"],
    source_owner_generations: { "rev-1": "owner-gen-1", "rev-2": "owner-gen-2" },
    policy_authority_ref: "policy-1",
    disclosure_closure_digest: hex64("a"),
    purge_ledger_revision: 0,
    digest: hex64("b"),
    created_at: CREATED,
    expires_at: EXPIRY,
    ...overrides,
  };
}

export function openDatabase(): { raw: RawDatabase; d1: RetrievalQueryD1 } {
  const raw = new DatabaseSync(":memory:") as unknown as RawDatabase;
  for (const name of Object.keys(CORE_MIGRATIONS).sort()) {
    raw.exec(CORE_MIGRATIONS[name] as string);
  }
  return { raw, d1: makeD1(raw) };
}

export function insert(database: RawDatabase, table: string, fields: Record<string, string | number | null>): void {
  const keys = Object.keys(fields);
  const statement = database.prepare(
    `INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map((_, i) => `?${i + 1}`).join(",")})`,
  );
  statement.run(...(Object.values(fields) as never[]));
}

export function seedAuthority(database: RawDatabase, scope: ScopeSnapshot): void {
  for (const [index, rev] of scope.member_source_revision_refs.entries()) {
    const ns = `ns-${index + 1}`;
    const gen = scope.source_owner_generations[rev] ?? "owner-gen-1";
    insert(database, "source_namespace_ownership", {
      source_namespace_id: ns, ownership_record_revision: 1, owner_system_id: "eliotr",
      owner_incarnation_ref: "incarnation-1", source_owner_generation: gen,
      source_admission_policy_revision: 1, status: "ACTIVE", cutover_receipt_ref: null, created_at: CREATED,
    });
    insert(database, "source", {
      source_id: `source-${index + 1}`, source_namespace_id: ns, source_owner_system_id: "eliotr",
      source_owner_generation: gen, ownership_mode: "immutable_import", kind: "document",
      origin_uri: null, title: `Source ${index + 1}`, default_storage_policy: "NORMALIZED_CLOUD_ONLY",
      default_residency_profile_id: "residency-1", source_class: "document", license_policy_ref: "license-1",
      default_retention_policy_id: "retention-1", head_rev: rev, created_at: CREATED,
    });
    insert(database, "source_revision", {
      source_revision_ref: rev, source_id: `source-${index + 1}`, source_owner_generation: gen,
      content_sha256: hex64("e"), object_residency_key_digest: hex64("d"),
      original_r2_key: null, normalized_artifact_ref: `normalized/${index + 1}`, captured_at: CREATED,
      parser_profile_generation: null, quality_state: "standard", purge_state: "LIVE",
      currentness_state: "unknown", source_view_ref: `view-${index + 1}`, workspace_view_revision_ref: null,
      admitted_at: CREATED,
    });
  }
  insert(database, "scope_snapshot", {
    snapshot_id: scope.snapshot_id, revision: scope.revision,
    resolved_scope_expression_json: JSON.stringify(scope.resolved_scope_expression),
    participant_generations_json: JSON.stringify(scope.participant_generations),
    member_source_revision_refs_json: JSON.stringify(scope.member_source_revision_refs),
    source_owner_generations_json: JSON.stringify(scope.source_owner_generations),
    policy_authority_ref: scope.policy_authority_ref,
    disclosure_closure_digest: scope.disclosure_closure_digest,
    purge_ledger_revision: scope.purge_ledger_revision, client_fence_ref: null,
    snapshot_digest: scope.digest, created_at: scope.created_at, expires_at: scope.expires_at,
    invalidated_at: null, invalidation_reason: null,
  });
  insert(database, "scope_access_grant", {
    snapshot_id: scope.snapshot_id, snapshot_revision: scope.revision,
    principal_ref: ACCESS.principal_ref, client_class: ACCESS.client_class,
    credential_generation: ACCESS.credential_generation,
    policy_authority_ref: scope.policy_authority_ref, allowed_use_json: '["research"]',
    disclosure_ceiling: "private", authorization_receipt_ref: "auth-1",
    state: "ACTIVE", expires_at: EXPIRY, created_at: CREATED,
  });
}

export interface SectionHarness {
  readonly descriptor: ExhaustiveSectionDescriptor;
  readonly input: VerifyPinnedExactInput;
}

export async function sectionHarness(options: {
  section_ref: string;
  source_revision_ref: string;
  source_owner_generation: string;
  fullText: string;
  anchor: EvidenceHandle["anchor"];
  scope: ScopeSnapshot;
  coordinate_map?: AdmittedCoordinateMap | null | undefined;
  revoked_mid_read?: boolean | undefined;
  forgedHandle?: boolean | undefined;
}): Promise<SectionHarness> {
  const fullBytes = encode(options.fullText);
  const contentSha = await shaHex(options.fullText);
  let excerpt: string;
  if (options.anchor.kind === "normalized_byte_range") {
    excerpt = new TextDecoder("utf-8", { fatal: true }).decode(
      fullBytes.slice(options.anchor.start, options.anchor.end),
    );
  } else if (options.anchor.kind === "normalized_line_range") {
    const lines = options.fullText.split(/(?<=\n)/u);
    excerpt = lines.slice(options.anchor.start_line - 1, options.anchor.end_line).join("");
  } else if (options.anchor.kind === "table_cell") {
    const key = `table:${options.anchor.table_id}:${options.anchor.row}:${options.anchor.column}`;
    const entry = options.coordinate_map?.entries?.[key];
    if (
      entry !== undefined && Number.isSafeInteger(entry.start) && Number.isSafeInteger(entry.end) &&
      entry.start >= 0 && entry.end > entry.start && entry.end <= fullBytes.byteLength
    ) {
      excerpt = new TextDecoder("utf-8", { fatal: true }).decode(fullBytes.slice(entry.start, entry.end));
    } else {
      excerpt = options.fullText.slice(0, Math.min(options.fullText.length, 16));
    }
  } else {
    excerpt = options.fullText.slice(0, Math.min(options.fullText.length, 16));
  }
  const excerptSha = await shaHex(excerpt);
  const excerptBytes = encode(excerpt).byteLength;
  const source: PinnedSourceAuthority = {
    source_revision_ref: options.source_revision_ref,
    source_namespace_id: "ns-1",
    source_owner_generation: options.source_owner_generation,
    content_sha256: contentSha,
    object_residency_key_digest: hex64("d"),
    purge_state: "LIVE",
  };
  const handle = {
    handle_ref: { id: `evidence-${options.section_ref}`, revision: 1 },
    source_namespace_id: "ns-1",
    source_owner_generation: options.source_owner_generation,
    source_revision_ref: options.source_revision_ref,
    scope_snapshot_ref: { id: options.scope.snapshot_id, revision: options.scope.revision },
    anchor: options.anchor,
    excerpt_sha256: excerptSha,
    excerpt_byte_length: excerptBytes,
    object_residency_key_digest: hex64("d"),
    source_assurance_ceiling: "QUALIFIED",
    materializer_assurance_ceiling: "EXACT",
    terminal_state: "LIVE",
    created_at: CREATED,
    ...(options.anchor.kind === "table_cell" ? { coordinate_map_ref: "map-1" } : {}),
  };
  return {
    descriptor: {
      section_ref: options.section_ref,
      source_revision_ref: options.source_revision_ref,
      item_key: `item-${options.source_revision_ref}-${options.section_ref}`,
      content_sha256: contentSha,
      projection_generation: "projection-harness-v1",
      normalized_start_byte: 0,
      normalized_end_byte: fullBytes.byteLength,
      uncompressed_bytes: fullBytes.byteLength,
    },
    input: {
      handle: options.forgedHandle === true ? { forged: true } : handle,
      scope: options.scope,
      source,
      materialized: {
        exact_excerpt: excerpt,
        excerpt_sha256: excerptSha,
        excerpt_byte_length: excerptBytes,
        source_object_size: fullBytes.byteLength,
        source_object_sha256: contentSha,
      },
      pinned_object_bytes: fullBytes,
      ...(options.coordinate_map !== undefined ? { coordinate_map: options.coordinate_map } : {}),
      ...(options.revoked_mid_read !== undefined ? { revoked_mid_read: options.revoked_mid_read } : {}),
    },
  };
}

export function readerFor(harnesses: readonly SectionHarness[]): ExhaustiveSectionReader {
  const inputs = new Map(harnesses.map((harness) => [harness.descriptor.section_ref, harness.input]));
  return {
    async readSection(section_ref: string): Promise<VerifyPinnedExactInput> {
      const input = inputs.get(section_ref);
      if (input === undefined) {
        const error = new Error(`unknown section ${section_ref}`);
        error.name = "SECTION_NOT_PINNED";
        throw error;
      }
      return input;
    },
  };
}

export function settled(outcome: ExhaustiveShardOutcome): Extract<ExhaustiveShardOutcome, { disposition: "SETTLED" }> {
  if (outcome.disposition !== "SETTLED") throw new Error(`expected SETTLED, got ${outcome.disposition}`);
  return outcome;
}

export async function planError(promise: Promise<unknown>): Promise<ExhaustivePlanError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ExhaustivePlanError) return error;
    throw new Error(`expected ExhaustivePlanError, got ${String(error)}`, { cause: error });
  }
  throw new Error("expected planning to fail");
}

export function planErrorSync(task: () => unknown): ExhaustivePlanError {
  try {
    task();
  } catch (error) {
    if (error instanceof ExhaustivePlanError) return error;
    throw new Error(`expected ExhaustivePlanError, got ${String(error)}`, { cause: error });
  }
  throw new Error("expected planning to fail");
}
