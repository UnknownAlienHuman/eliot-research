import {
  assertEvidenceIdentifier,
  assertEvidenceInteger,
  assertEvidenceIso,
  assertEvidenceSha256,
  canonicalEvidenceJson,
  type EvidenceAccessContext,
  type ScopeAuthorization,
} from "@eliotr/cloudflare-evidence";
import { VersionedRefSchema } from "@eliotr/contracts";
import type { NavigationReadAuthority } from "@eliotr/cloudflare-evidence";

const MAX_SOURCES = 64;
const MAX_ALLOWED_USE = 16;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_REF_BYTES = 512;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9:._/@%+-]{0,511}$/u;

const WITNESS_KEYS = [
  "guard_id", "page_id", "page_revision", "proposal_id", "proposal_revision", "expected_head_revision",
  "manifest_ref", "page_sha256", "body_object_ref", "body_sha256", "committer_ref", "principal_ref",
  "client_class", "credential_generation", "authorization_receipt_ref", "scope_snapshot_id",
  "scope_snapshot_revision", "scope_snapshot_digest", "policy_generation", "policy_authority_ref",
  "deployment_generation", "global_purge_revision", "scope_purge_revision", "orientation_epoch", "ledger_epoch",
  "source_revision_refs_json", "source_owner_generations_json", "allowed_use_json", "disclosure_ceiling",
  "scope_expires_at", "grant_expires_at", "observed_at", "expires_at",
] as const;

export class WikiOwnerPublicationGuardError extends Error {
  readonly code = "WIKI_OWNER_PUBLICATION_GUARD_INPUT_INVALID" as const;

  constructor() {
    super("Wiki owner publication guard witness is invalid");
    this.name = "WikiOwnerPublicationGuardError";
  }
}

/**
 * Server-owned currentness witness. Values are read from the reauthorized
 * owner scope and current D1 authority before the publication batch begins.
 * `policy_authority_ref` is the canonical identity shared by the scope,
 * grant, and investigation current-policy rows.
 */
export interface WikiOwnerPublicationGuardWitness {
  readonly guard_id: string;
  readonly page_id: string;
  readonly page_revision: number;
  readonly proposal_id: string;
  readonly proposal_revision: number;
  readonly expected_head_revision: number | null;
  readonly manifest_ref: string;
  readonly page_sha256: string;
  readonly body_object_ref: string;
  readonly body_sha256: string;
  readonly committer_ref: string;
  readonly principal_ref: string;
  readonly client_class: "owner_pwa";
  readonly credential_generation: string;
  readonly authorization_receipt_ref: string;
  readonly scope_snapshot_id: string;
  readonly scope_snapshot_revision: number;
  readonly scope_snapshot_digest: string;
  readonly policy_generation: string;
  readonly policy_authority_ref: string;
  readonly deployment_generation: string;
  readonly global_purge_revision: number;
  readonly scope_purge_revision: number;
  readonly orientation_epoch: number;
  readonly ledger_epoch: number;
  readonly source_revision_refs_json: string;
  readonly source_owner_generations_json: string;
  readonly allowed_use_json: string;
  readonly disclosure_ceiling: string;
  readonly scope_expires_at: string;
  readonly grant_expires_at: string;
  readonly observed_at: string;
  readonly expires_at: string;
}

function invalid(): never {
  throw new WikiOwnerPublicationGuardError();
}

function identifier(value: unknown): string {
  try { return assertEvidenceIdentifier(value, "Wiki guard identifier"); }
  catch { return invalid(); }
}

function safeRef(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_REF_BYTES ||
      !SAFE_REF.test(value) || value.includes("..") || value.includes("\\")) invalid();
  return value;
}

function integer(value: unknown, minimum: number, label: string): number {
  try { return assertEvidenceInteger(value, label, minimum, 1_000_000_000); }
  catch { return invalid(); }
}

function digest(value: unknown): string {
  try { return assertEvidenceSha256(value, "Wiki guard digest"); }
  catch { return invalid(); }
}

function iso(value: unknown): string {
  try { return assertEvidenceIso(value, "Wiki guard timestamp"); }
  catch { return invalid(); }
}

function canonicalJson(value: unknown, label: string): { readonly text: string; readonly parsed: unknown } {
  if (typeof value !== "string") invalid();
  const bytes = new TextEncoder().encode(value).byteLength;
  if (bytes < 2 || bytes > MAX_JSON_BYTES) invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return invalid(); }
  try {
    if (canonicalEvidenceJson(parsed) !== value) return invalid();
  } catch { return invalid(); }
  void label;
  return { text: value, parsed };
}

function validateJsonWitness(witness: WikiOwnerPublicationGuardWitness, refs: readonly string[]): void {
  const sourceJson = canonicalJson(witness.source_revision_refs_json, "source revision refs");
  if (!Array.isArray(sourceJson.parsed) || sourceJson.parsed.length > MAX_SOURCES) invalid();
  const sourceRefs = sourceJson.parsed.map((value) => identifier(value));
  if (new Set(sourceRefs).size !== sourceRefs.length ||
      canonicalEvidenceJson([...sourceRefs].sort()) !== canonicalEvidenceJson(sourceRefs) ||
      canonicalEvidenceJson(sourceRefs) !== canonicalEvidenceJson(refs)) invalid();

  const ownerJson = canonicalJson(witness.source_owner_generations_json, "source owner generations");
  if (ownerJson.parsed === null || typeof ownerJson.parsed !== "object" || Array.isArray(ownerJson.parsed)) invalid();
  const owners = ownerJson.parsed as Readonly<Record<string, unknown>>;
  const ownerKeys = Object.keys(owners).sort();
  if (canonicalEvidenceJson(ownerKeys) !== canonicalEvidenceJson(sourceRefs)) invalid();
  for (const key of ownerKeys) identifier(owners[key]);

  const allowedJson = canonicalJson(witness.allowed_use_json, "allowed use");
  if (!Array.isArray(allowedJson.parsed) || allowedJson.parsed.length > MAX_ALLOWED_USE) invalid();
  const uses = allowedJson.parsed.map((value) => identifier(value));
  if (new Set(uses).size !== uses.length || !uses.includes("research")) invalid();
}

function validateWitness(value: WikiOwnerPublicationGuardWitness): WikiOwnerPublicationGuardWitness {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid();
  const keys = Object.keys(value).sort();
  if (keys.length !== WITNESS_KEYS.length || keys.some((key, index) => key !== WITNESS_KEYS.slice().sort()[index])) invalid();

  const parsedProposal = VersionedRefSchema.safeParse({ id: value.proposal_id, revision: value.proposal_revision });
  if (!parsedProposal.success) invalid();
  const pageId = identifier(value.page_id);
  const pageRevision = integer(value.page_revision, 1, "Wiki page revision");
  const proposalId = identifier(parsedProposal.data.id);
  const proposalRevision = integer(parsedProposal.data.revision, 1, "Wiki proposal revision");
  const expectedHead = value.expected_head_revision === null
    ? null : integer(value.expected_head_revision, 0, "Wiki expected head revision");
  const guardId = identifier(value.guard_id);
  const manifest = safeRef(value.manifest_ref);
  const bodyObject = safeRef(value.body_object_ref);
  const pageSha = digest(value.page_sha256);
  const bodySha = digest(value.body_sha256);
  const principal = identifier(value.principal_ref);
  const committer = identifier(value.committer_ref);
  if (value.client_class !== "owner_pwa" || committer !== principal) invalid();
  const credential = identifier(value.credential_generation);
  const authorizationReceipt = identifier(value.authorization_receipt_ref);
  const scopeId = identifier(value.scope_snapshot_id);
  const scopeRevision = integer(value.scope_snapshot_revision, 1, "Wiki scope revision");
  const scopeDigest = digest(value.scope_snapshot_digest);
  const policyGeneration = identifier(value.policy_generation);
  const policyAuthority = identifier(value.policy_authority_ref);
  const deployment = identifier(value.deployment_generation);
  const disclosure = identifier(value.disclosure_ceiling);
  const globalPurge = integer(value.global_purge_revision, 0, "Wiki global purge revision");
  const scopePurge = integer(value.scope_purge_revision, 0, "Wiki scope purge revision");
  const orientationEpoch = integer(value.orientation_epoch, 1, "Wiki orientation epoch");
  const ledgerEpoch = integer(value.ledger_epoch, 1, "Wiki ledger epoch");
  const scopeExpires = iso(value.scope_expires_at);
  const grantExpires = iso(value.grant_expires_at);
  const observed = iso(value.observed_at);
  const expires = iso(value.expires_at);
  const observedMs = Date.parse(observed);
  const expiryMs = Date.parse(expires);
  if (expiryMs <= observedMs || Date.parse(scopeExpires) <= observedMs || Date.parse(grantExpires) <= observedMs ||
      expiryMs > Date.parse(scopeExpires) || expiryMs > Date.parse(grantExpires)) invalid();
  const sourceRefs = canonicalJson(value.source_revision_refs_json, "source revision refs").parsed;
  if (!Array.isArray(sourceRefs)) invalid();
  validateJsonWitness(value, sourceRefs.map((entry) => identifier(entry)));
  return Object.freeze({
    ...value,
    guard_id: guardId, page_id: pageId, page_revision: pageRevision,
    proposal_id: proposalId, proposal_revision: proposalRevision, expected_head_revision: expectedHead,
    manifest_ref: manifest, page_sha256: pageSha, body_object_ref: bodyObject, body_sha256: bodySha,
    committer_ref: committer, principal_ref: principal, credential_generation: credential,
    authorization_receipt_ref: authorizationReceipt, scope_snapshot_id: scopeId,
    scope_snapshot_revision: scopeRevision, scope_snapshot_digest: scopeDigest,
    policy_generation: policyGeneration, policy_authority_ref: policyAuthority,
    deployment_generation: deployment, global_purge_revision: globalPurge, scope_purge_revision: scopePurge,
    orientation_epoch: orientationEpoch, ledger_epoch: ledgerEpoch,
    disclosure_ceiling: disclosure,
    scope_expires_at: scopeExpires, grant_expires_at: grantExpires, observed_at: observed, expires_at: expires,
  });
}

/**
 * Build the first statement of the Wiki publication D1 batch. The caller
 * must obtain this witness after R2 readback and place this statement before
 * revision/head/outbox/proposal writes; migration 0059 makes stale witness
 * dimensions abort the entire transaction.
 */
export function buildWikiOwnerPublicationGuardStatement(
  database: D1Database,
  witness: WikiOwnerPublicationGuardWitness,
): D1PreparedStatement {
  const checked = validateWitness(witness);
  const columns = WITNESS_KEYS.join(",");
  const placeholders = WITNESS_KEYS.map((_, index) => `?${index + 1}`).join(",");
  const values: readonly (string | number | null)[] = [
    checked.guard_id, checked.page_id, checked.page_revision, checked.proposal_id, checked.proposal_revision,
    checked.expected_head_revision, checked.manifest_ref, checked.page_sha256, checked.body_object_ref,
    checked.body_sha256, checked.committer_ref, checked.principal_ref, checked.client_class,
    checked.credential_generation, checked.authorization_receipt_ref, checked.scope_snapshot_id,
    checked.scope_snapshot_revision, checked.scope_snapshot_digest, checked.policy_generation,
    checked.policy_authority_ref, checked.deployment_generation, checked.global_purge_revision,
    checked.scope_purge_revision, checked.orientation_epoch, checked.ledger_epoch,
    checked.source_revision_refs_json, checked.source_owner_generations_json, checked.allowed_use_json,
    checked.disclosure_ceiling, checked.scope_expires_at, checked.grant_expires_at, checked.observed_at,
    checked.expires_at,
  ];
  return database.prepare(
    `INSERT INTO wiki_owner_publication_guard (${columns}) VALUES (${placeholders})`,
  ).bind(...values);
}

export type WikiOwnerPublicationGuardNavigation = Pick<NavigationReadAuthority, "scope" | "access" | "timestamp">;
export type WikiOwnerPublicationGuardAuthorization = Pick<ScopeAuthorization, "authorization_receipt_ref" | "policy_authority_ref" | "allowed_use" | "disclosure_ceiling" | "expires_at">;
export type WikiOwnerPublicationGuardAccess = Pick<EvidenceAccessContext, "principal_ref" | "client_class" | "credential_generation">;
