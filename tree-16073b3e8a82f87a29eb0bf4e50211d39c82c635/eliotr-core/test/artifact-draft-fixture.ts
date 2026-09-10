import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  createArtifactDraftStore,
  type ArtifactDraftReferencedObjectInput,
  type ArtifactDraftSectionInput,
  type PrepareArtifactDraftInput,
} from "@eliotr/cloudflare-research";
import { canonicalDigest } from "@eliotr/platform-cloudflare";
import type { Env } from "../src/env.js";

export const runtime = env as unknown as Env & {
  readonly CORE_MIGRATIONS: { readonly name: string; readonly queries: readonly string[] }[];
};

export async function initializeArtifactDraftRuntime(): Promise<void> {
  await applyD1Migrations(runtime.CORE_DB, runtime.CORE_MIGRATIONS);
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
}

export async function draftInput(tag: string, options: DraftInputOptions = {}): Promise<PrepareArtifactDraftInput> {
  const artifactId = options.artifact_id ?? `artifact-${tag}`;
  const artifactRevision = options.artifact_revision ?? 1;
  const contentTag = options.content_tag ?? tag;
  const domain = options.residency_domain ?? tag;
  const sectionBytes = bytes(`section body ${contentTag}\n`);
  const sectionSha = await digest(sectionBytes);
  const spec = {
    spec_ref: { id: `spec-${tag}`, revision: 1 }, kind: "technical_audit" as const,
    title: `Draft ${tag}`, scope_snapshot_ref: { id: `scope-snapshot-${tag}`, revision: 1 },
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
  const referenceValues = [
    ["DEPENDENCY_MANIFEST", revision.dependency_manifest_ref, bytes(`dependency ${contentTag}`)],
    ["EVIDENCE_LEDGER", revision.sections[0].evidence_ledger_ref, bytes(`evidence ${contentTag}`)],
    ["VERIFICATION_RECEIPT", revision.sections[0].verification_receipt_ref, bytes(`verification ${contentTag}`)],
    ["EXPORT", revision.deterministic_export_refs.markdown, bytes(`export ${contentTag}`)],
  ] as const;
  const references: ArtifactDraftReferencedObjectInput[] = [];
  for (const [object_kind, object_ref, objectBytes] of referenceValues) {
    references.push({ object_ref, object_kind, bytes: objectBytes, residency: residency(domain, await digest(objectBytes)) });
  }
  const manifestDigest = await canonicalDigest({ spec, revision });
  const section: ArtifactDraftSectionInput = {
    section: revision.sections[0], bytes: sectionBytes, residency: residency(domain, sectionSha),
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
