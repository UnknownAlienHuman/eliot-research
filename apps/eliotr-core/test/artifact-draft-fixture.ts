import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { ScopeSnapshot } from "@eliotr/contracts";
import {
  createArtifactDraftStore,
  type ArtifactDraftReferencedObjectInput,
  type ArtifactDraftSectionInput,
  type PrepareArtifactDraftInput,
} from "@eliotr/cloudflare-research";
import type { EvidenceAccessContext } from "@eliotr/cloudflare-evidence";
import { createD1ScopeService } from "@eliotr/cloudflare-navigation";
import { canonicalDigest } from "@eliotr/platform-cloudflare";
import type { Env } from "../src/env.js";

export const runtime = env as unknown as Env & {
  readonly CORE_MIGRATIONS: D1Migration[];
  readonly SEARCH_MIGRATIONS: D1Migration[];
};

export async function initializeArtifactDraftRuntime(): Promise<void> {
  await applyD1Migrations(runtime.CORE_DB, runtime.CORE_MIGRATIONS);
  await applyD1Migrations(runtime.SEARCH_DB, runtime.SEARCH_MIGRATIONS);
}

async function digest(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(hash)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function residency(domain: string, digestValue: string) {
  return {
    scope_domain_id: `scope-${domain}`,
    access_domain_id: `access-${domain}`,
    confidentiality_domain_id: `confidential-${domain}`,
    encryption_key_domain_id: `key-${domain}`,
    retention_domain_id: `retention-${domain}`,
    erasure_domain_id: `erasure-${domain}`,
    content_digest: { algorithm: "sha256" as const, digest: digestValue },
  };
}

export interface DraftInputOptions {
  readonly artifact_id?: string;
  readonly artifact_revision?: number;
  readonly content_tag?: string;
  readonly residency_domain?: string;
  readonly expected_head_revision?: number | null;
  readonly scope_snapshot_id?: string;
}

export async function draftInput(tag: string, options: DraftInputOptions = {}): Promise<PrepareArtifactDraftInput> {
  const artifactId = options.artifact_id ?? `artifact-${tag}`;
  const artifactRevision = options.artifact_revision ?? 1;
  const contentTag = options.content_tag ?? tag;
  const domain = options.residency_domain ?? tag;
  const scopeSnapshotId = options.scope_snapshot_id ?? `scope-snapshot-${tag}`;
  const sectionBytes = bytes(`section body ${contentTag}\n`);
  const sectionSha = await digest(sectionBytes);
  const spec = {
    spec_ref: { id: `spec-${tag}`, revision: 1 }, kind: "technical_audit" as const,
    title: `Draft ${tag}`, scope_snapshot_ref: { id: scopeSnapshotId, revision: 1 },
    inquiry_protocol_ref: { id: `inquiry-${tag}`, revision: 1 }, audience: "owner",
    language: "en", section_contracts: [{ section_id: "summary", title: "Summary", purpose: "Fixture summary",
      required_claim_kinds: ["claim"], required_evidence_classes: ["source"], maximum_utf8_bytes: 4096 }],
    citation_policy_ref: `citation-${tag}`, verification_policy_ref: `verification-policy-${tag}`,
    include_counterevidence: true, include_methodology: true, length_policy_ref: `length-${tag}`,
    export_formats: ["markdown" as const], budget_ref: `budget-${tag}`,
  };
  const revision = {
    artifact_ref: { id: artifactId, revision: artifactRevision }, spec_ref: spec.spec_ref,
    spec_digest: await canonicalDigest(spec), evidence_freeze_ref: { id: `freeze-${tag}`, revision: 1 },
    sections: [{ section_ref: { id: `section-${tag}`, revision: 1 }, contract_id: "summary",
      body_object_ref: `section-body-${tag}`, body_sha256: sectionSha,
      statement_labels: { claim: "SOURCE_SUPPORTED" as const }, evidence_ledger_ref: `ledger-${tag}`,
      verification_receipt_ref: `verification-${tag}` }], dependency_manifest_ref: `dependency-${tag}`,
    deterministic_export_refs: { markdown: `export-${tag}` }, status: "DRAFT" as const,
    created_at: "2026-09-10T00:00:00.000Z",
  };
  const summarySection = revision.sections[0];
  if (!summarySection) throw new Error("fixture must contain a summary section");
  const referenceValues = [
    ["DEPENDENCY_MANIFEST", revision.dependency_manifest_ref, bytes(`dependency ${contentTag}`)],
    ["EVIDENCE_LEDGER", summarySection.evidence_ledger_ref, bytes(`evidence ${contentTag}`)],
    ["VERIFICATION_RECEIPT", summarySection.verification_receipt_ref, bytes(`verification ${contentTag}`)],
    ["EXPORT", revision.deterministic_export_refs.markdown, bytes(`export ${contentTag}`)],
  ] as const;
  const references: ArtifactDraftReferencedObjectInput[] = [];
  for (const [object_kind, object_ref, objectBytes] of referenceValues) {
    references.push({ object_ref, object_kind, bytes: objectBytes, residency: residency(domain, await digest(objectBytes)) });
  }
  const manifestDigest = await canonicalDigest({ spec, revision });
  const section: ArtifactDraftSectionInput = {
    section: summarySection, bytes: sectionBytes, residency: residency(domain, sectionSha),
  };
  return {
    intent: { intent_ref: { id: `draft-intent-${tag}`, revision: 1 }, operation_kind: "REPORT",
      principal_ref: `owner-${tag}`, idempotency_key: `draft-${tag}`, payload_ref: `payload-${tag}`,
      policy_decision_ref: `policy-${tag}`, created_at: revision.created_at },
    expected_draft_head_revision: options.expected_head_revision ?? null,
    spec, revision, sections: [section], referenced_objects: references,
    manifest_residency: residency(domain, manifestDigest),
  };
}

export function createArtifactDraftRuntime(database: D1Database = runtime.CORE_DB, bucket: R2Bucket = runtime.WORK_BUCKET) {
  return createArtifactDraftStore(database, bucket);
}

export interface ArtifactDraftReadFixture {
  readonly input: PrepareArtifactDraftInput;
  readonly scope: ScopeSnapshot;
  readonly access: EvidenceAccessContext;
  readonly requireCurrent: (scope: ScopeSnapshot) => Promise<ScopeSnapshot>;
  readonly now: () => number;
}

export async function readableArtifactDraft(tag: string): Promise<ArtifactDraftReadFixture> {
  const now = Date.parse("2026-09-10T12:00:00.000Z");
  const access = {
    principal_ref: `owner-${tag}`,
    client_class: "owner_pwa" as const,
    credential_generation: `credential-${tag}`,
  };
  const scopeAuthority = {
    resolveAtom: async () => ({ atom_generation_ref: `atom-generation-${tag}`, members: [] }),
    resolveAuthorityClosure: async () => ({
      policy_authority_ref: `policy-authority-${tag}`,
      disclosure_closure_digest: "d".repeat(64),
      purge_ledger_revision: 0,
      client_fence_valid: true,
      denied_source_revision_refs: [],
    }),
  };
  const scopes = createD1ScopeService(runtime.CORE_DB, scopeAuthority, { now: () => now, ttl_ms: 3_600_000 });
  const scope = await scopes.freeze({ kind: "PROJECT", project_id: `project-${tag}` }, access.credential_generation);
  await runtime.CORE_DB.prepare(
    "INSERT INTO scope_access_grant (snapshot_id, snapshot_revision, principal_ref, client_class, credential_generation, policy_authority_ref, allowed_use_json, disclosure_ceiling, authorization_receipt_ref, state, expires_at, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'ACTIVE',?10,?11)",
  ).bind(scope.snapshot_id, scope.revision, access.principal_ref, access.client_class, access.credential_generation,
    scope.policy_authority_ref, '["research"]', "private", `grant-${tag}`, scope.expires_at, scope.created_at).run();
  return {
    input: await draftInput(tag, { scope_snapshot_id: scope.snapshot_id }),
    scope,
    access,
    requireCurrent: (requested) => scopes.requireCurrent(requested),
    now: () => now,
  };
}

export function failResidencyPut(bucket: R2Bucket, failAt: number): R2Bucket {
  let puts = 0;
  const proxy = Object.create(bucket) as R2Bucket;
  proxy.head = bucket.head.bind(bucket);
  proxy.get = bucket.get.bind(bucket);
  proxy.put = async (...args: Parameters<R2Bucket["put"]>) => {
    puts += 1;
    if (puts === failAt) throw new Error("controlled partial R2 failure");
    return bucket.put(...args);
  };
  return proxy;
}

export function countResidencyPuts(bucket: R2Bucket): { readonly bucket: R2Bucket; readonly puts: () => number } {
  let count = 0;
  const proxy = Object.create(bucket) as R2Bucket;
  proxy.head = bucket.head.bind(bucket);
  proxy.get = bucket.get.bind(bucket);
  proxy.put = async (...args: Parameters<R2Bucket["put"]>) => {
    count += 1;
    return bucket.put(...args);
  };
  return { bucket: proxy, puts: () => count };
}

export function finalBatchFailure(database: D1Database, lostAck = false): D1Database {
  const proxy = Object.create(database) as D1Database;
  const sqlByStatement = new WeakMap<D1PreparedStatement, string>();
  proxy.prepare = (sql: string) => {
    const prepared = database.prepare(sql);
    const value = Object.create(prepared) as D1PreparedStatement;
    value.bind = (...params: unknown[]) => {
      const bound = prepared.bind(...params);
      sqlByStatement.set(bound, sql);
      return bound;
    };
    return value;
  };
  proxy.batch = async <T = unknown>(statements: D1PreparedStatement[]) => {
    const finalBatch = statements.length > 2;
    const objectIndex = statements.findIndex((statement) => sqlByStatement.get(statement)?.startsWith("INSERT INTO artifact_draft_object") === true);
    const result = finalBatch
      ? await database.batch<T>(lostAck || objectIndex < 0 ? statements : statements.filter((_, index) => index !== objectIndex))
      : await database.batch<T>(statements);
    if (lostAck && finalBatch) throw new Error("controlled lost D1 acknowledgement");
    return result;
  };
  return proxy;
}
