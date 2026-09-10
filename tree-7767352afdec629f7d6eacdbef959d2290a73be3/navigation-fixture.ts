import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import type { ScopeSnapshot, SourceAdmissionDecision, SourceRevision } from "@eliotr/contracts";
import { canonicalEvidenceJson, createD1NavigationStore, evidenceSha256, type D1NavigationStoreInput } from "@eliotr/cloudflare-evidence";
import { buildDocumentMap, buildProjectAtlas, buildSourceCard } from "@eliotr/retrieval";
import { createD1ScopeService, type ScopeRepository } from "../src/scope-service.js";

interface Migration { name: string; queries: string[]; }
const runtime = env as unknown as { CORE_DB: D1Database; SEARCH_DB: D1Database; CORE_MIGRATIONS: Migration[]; SEARCH_MIGRATIONS: Migration[] };

export const db = runtime.CORE_DB;
export const NOW = Date.parse("2026-09-05T00:00:00.000Z");
export const TIME = new Date(NOW).toISOString();
export const access = { principal_ref: "owner-1", client_class: "owner_pwa" as const, credential_generation: "credential-1" };
export const project = { id: "project-1", revision: 1 };
export const A = "a".repeat(64);
export const B = "b".repeat(64);
export async function setupDatabase(): Promise<void> {
  // N1 FIX3: the full current core/search migrations (idempotent —
  // applyD1Migrations tracks applied entries). The E2E drives the real Worker
  // research.orient route, whose readiness gate requires the schema_state
  // generation markers, and the real ingest commit guard path, which needs
  // every authority table plus the production guard/epoch triggers. Smaller
  // hand-picked DDL cannot satisfy either gate honestly. No migration change.
  await applyD1Migrations(db, runtime.CORE_MIGRATIONS);
  await applyD1Migrations(runtime.SEARCH_DB, runtime.SEARCH_MIGRATIONS);
}
export async function clearDatabase(): Promise<void> {
  // Child-first against the current migration FOREIGN KEYs: receipts and
  // staging rows before operations, operations before revisions, revisions
  // before sources, grants/requests/handles before snapshots.
  for (const table of ["navigation_artifact", "evidence_handle", "bundle_ingest_commit_guard",
    "source_acquisition_candidate", "qualification_report", "source_admission_decision",
    "operation_receipt", "operation_attempt", "outbox", "operation_intent",
    "scope_access_grant", "orientation_request", "source_readiness",
    "project_source_membership", "source_tag", "bundle_ingest_operation", "project", "purge_ledger",
    "scope_snapshot", "scope_read_policy",
    "source_revision", "source", "source_namespace_ownership", "source_admission_policy"]) await db.prepare(`DELETE FROM ${table}`).run();
}
async function insert(table: string, fields: Record<string, string | number | null>): Promise<void> {
  await db.prepare(`INSERT INTO ${table} (${Object.keys(fields).join(",")}) VALUES (${Object.keys(fields).map((_, i) => `?${i + 1}`).join(",")})`)
    .bind(...Object.values(fields)).run();
}
export function source(ref = "revision-1"): SourceRevision {
  return { source_revision_ref: ref, source_id: `source-${ref}`, source_namespace_id: `namespace-${ref}`,
    source_owner_system_id: "owner-system-1", source_owner_generation: "owner-generation-1", ownership_mode: "immutable_import",
    content_sha256: A, object_residency_key_digest: B, normalized_artifact_ref: `normalized/${ref}`,
    captured_at: TIME, parser_profile_generation: "parser-1", quality_state: "standard", purge_state: "LIVE" };
}
export async function seedSource(revision: SourceRevision): Promise<void> {
  const ref = revision.source_revision_ref;
  const namespace = revision.source_namespace_id;
  await insert("source_namespace_ownership", { source_namespace_id: namespace, ownership_record_revision: 1,
    owner_system_id: "owner-system-1", owner_incarnation_ref: "incarnation-1", source_owner_generation: "owner-generation-1",
    source_admission_policy_revision: 1, status: "ACTIVE", created_at: TIME });
  await insert("source", { source_id: revision.source_id, source_namespace_id: namespace, source_owner_system_id: "owner-system-1",
    source_owner_generation: "owner-generation-1", ownership_mode: "immutable_import", kind: "document", title: "Rust memory",
    default_storage_policy: "storage-1", default_residency_profile_id: "residency-1", source_class: "document",
    license_policy_ref: "license-1", default_retention_policy_id: "retention-1", created_at: TIME });
  await insert("source_revision", { source_revision_ref: ref, source_id: revision.source_id, source_owner_generation: "owner-generation-1",
    content_sha256: A, object_residency_key_digest: B, normalized_artifact_ref: `normalized/${ref}`, captured_at: TIME,
    quality_state: "standard", purge_state: "LIVE", source_view_ref: `view-${ref}`, admitted_at: TIME });
  await insert("bundle_ingest_operation", { operation_id: `op-${ref}`, principal_ref: "owner-1", origin_authentication_receipt_ref: "auth-1",
    idempotency_key: `idem-${ref}`, input_fingerprint: A, manifest_sha256: A, manifest_json: "{}", file_hashes_json: "{}", total_bytes: 10,
    source_namespace_id: namespace, owner_system_id: "owner-system-1", source_owner_generation: "owner-generation-1", source_revision_ref: ref,
    source_id: revision.source_id, residency_key_json: "{}", residency_key_digest: B, policy_revision: 1, policy_snapshot_json: "{}",
    policy_snapshot_sha256: A, candidate_id: `candidate-${ref}`, state: "COMMITTED", created_at: TIME, updated_at: TIME,
    expires_at: "2026-09-06T00:00:00.000Z" });
  const decision: SourceAdmissionDecision = { source_namespace_id: namespace, owner_system_id: "owner-system-1",
    source_owner_generation: "owner-generation-1", source_revision_ref: ref, origin_authentication_receipt_ref: "auth-1",
    source_class: "document", assurance_ceiling: "QUALIFIED", instruction_taint: "DATA_ONLY", allowed_effects: "READ_ONLY",
    object_residency_key_digest: B, allowed_use: ["research"], disclosure_ceiling: "private", license_policy_ref: "license-1",
    decision: "ADMITTED", reason_codes: [], decision_receipt_ref: `decision-${ref}` };
  const { allowed_use: _allowed, reason_codes: _reasons, expires_at: _expiry, ...scalars } = decision;
  await insert("source_admission_decision", { ...scalars, operation_id: `op-${ref}`, allowed_use_json: '["research"]',
    reason_codes_json: "[]", decision_json: canonicalEvidenceJson(decision), decision_sha256: await evidenceSha256(decision), created_at: TIME });
}
export function scopeAuthority(refs: readonly string[]): Pick<ScopeRepository, "resolveAtom" | "resolveAuthorityClosure"> {
  return { async resolveAtom() { return { atom_generation_ref: "project-generation-1", members: refs.map((ref) => ({
    source_revision_ref: ref, source_owner_generation: "owner-generation-1", policy_closure_ref: "policy-closure-1",
  })) }; }, async resolveAuthorityClosure() { return { policy_authority_ref: "policy-authority-1", disclosure_closure_digest: A,
    purge_ledger_revision: 1, client_fence_valid: true, denied_source_revision_refs: [] }; } };
}
export async function fixture(refs = ["revision-1"]) {
  for (const ref of refs) await seedSource(source(ref));
  const repository = scopeAuthority(refs);
  const scopes = createD1ScopeService(db, repository, { now: () => NOW });
  const snapshot = await scopes.freeze({ kind: "PROJECT", project_id: project.id }, access.credential_generation);
  const input: D1NavigationStoreInput = { database: db, scope_snapshot: snapshot, access, now: () => NOW,
    require_current: (scope) => scopes.requireCurrent(scope) };
  return { snapshot, scopes, repository, input, store: createD1NavigationStore(input) };
}
export async function grant(snapshot: ScopeSnapshot, principal = access.principal_ref): Promise<void> {
  await db.prepare("INSERT INTO scope_access_grant VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'ACTIVE',?10,?11)")
    .bind(snapshot.snapshot_id, snapshot.revision, principal, access.client_class, access.credential_generation,
      snapshot.policy_authority_ref, '["research"]', "private", `grant-${principal}-${snapshot.snapshot_id}`, snapshot.expires_at, TIME).run();
}
export async function artifacts(snapshot: ScopeSnapshot, ref = "revision-1", title = "Rust memory") {
  const revision = source(ref);
  const card = await buildSourceCard({ source_revision: revision, generator_generation: "navigation-1", created_at: TIME,
    draft: { title, authors: ["Ada"], language: "en", source_kind: "document", document_role: "primary", authority_hint: "qualified",
      abstract: "Research metadata", main_topics: ["rust"], controlled_vocabulary: ["memory"], outline: [{ section_ref: "intro", label: "Introduction" }],
      important_section_refs: ["intro"], likely_uses: ["orientation"] } });
  const map = await buildDocumentMap({ source_revision: revision, generator_generation: "navigation-1", created_at: TIME,
    fragments: [{ fragment_id: "fragment-1", source_revision_ref: ref, section_hierarchy: [{ section_ref: "intro", label: "Introduction",
      normalized_start_byte: 0, normalized_end_byte: 10 }], key_terms: ["rust"] }] });
  const atlas = await buildProjectAtlas({ project_ref: project, scope_snapshot: snapshot, source_cards: [card], document_maps: [map],
    generator_generation: "navigation-1", created_at: TIME });
  return { card, map, atlas };
}
export async function seedHandle(snapshot: ScopeSnapshot): Promise<void> {
  await insert("evidence_handle", { handle_id: "handle-1", revision: 1, source_namespace_id: "namespace-revision-1",
    source_owner_generation: "owner-generation-1", source_revision_ref: "revision-1", scope_snapshot_id: snapshot.snapshot_id,
    scope_snapshot_revision: snapshot.revision, anchor_json: canonicalEvidenceJson({ kind: "normalized_byte_range", start: 0, end: 10 }),
    excerpt_sha256: A, excerpt_byte_length: 10, object_residency_key_digest: B, source_assurance_ceiling: "QUALIFIED",
    materializer_assurance_ceiling: "QUALIFIED", terminal_state: "LIVE", created_at: TIME });
}
export const countArtifacts = () => db.prepare("SELECT COUNT(*) AS n FROM navigation_artifact").first<number>("n");
export function wrappedDatabase(hook: (sql: string, phase: "before" | "after") => Promise<void>): D1Database {
  return { prepare(sql: string) {
    const statement = db.prepare(sql);
    return { bind(...values: (string | number | null)[]) {
      const bound = statement.bind(...values);
      return { async first() { await hook(sql, "before"); const value = await bound.first(); await hook(sql, "after"); return value; },
        async all() { await hook(sql, "before"); const value = await bound.all(); await hook(sql, "after"); return value; } };
    } };
  } } as unknown as D1Database;
}
