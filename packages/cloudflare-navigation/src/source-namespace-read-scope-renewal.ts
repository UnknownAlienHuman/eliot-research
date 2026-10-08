import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import {
  createSourceNamespaceLeaseRefreshProof,
  prepareSourceNamespaceLeaseRefreshApply,
  prepareSourceNamespaceLeaseRefreshInsert,
  readAppliedSourceNamespaceLeaseRefresh,
  readSourceNamespaceLeaseRefreshReceipt,
  sourceNamespaceLeaseRefreshReceiptMatches,
  type SourceNamespaceLeaseRefreshReceiptRow,
  type SourceNamespaceLeaseRefreshSession,
} from "./source-namespace-read-scope-lease-receipt.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const CLIENT_CLASS = "owner_pwa" as const;
const OWNER_SYSTEM_ID = "eliotr";
const MAX_GENERATION = 2_147_483_646;
const MAX_TITLE_BYTES = 120;

export type SourceNamespaceReadScopeRenewalErrorCode =
  | "NAMESPACE_OWNER_REQUIRED"
  | "NAMESPACE_INPUT_INVALID"
  | "NAMESPACE_READ_SCOPE_UNAVAILABLE"
  | "NAMESPACE_READ_SCOPE_REVOKED"
  | "NAMESPACE_READ_SCOPE_CONFLICT"
  | "NAMESPACE_STORAGE_UNAVAILABLE"
  | "NAMESPACE_SETTLEMENT_UNCERTAIN";

export class SourceNamespaceReadScopeRenewalError extends Error {
  public readonly code: SourceNamespaceReadScopeRenewalErrorCode;
  public readonly status: number;
  public readonly retryable: boolean;
  public readonly failureCause: unknown;

  public constructor(
    code: SourceNamespaceReadScopeRenewalErrorCode,
    status: number,
    message: string,
    retryable = false,
    failureCause?: unknown,
  ) {
    super(message, failureCause === undefined ? undefined : { cause: failureCause });
    this.name = "SourceNamespaceReadScopeRenewalError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.failureCause = failureCause;
  }
}

export interface SourceNamespaceReadScopeRenewalRequest {
  readonly expected_generation: number;
}

export interface SourceNamespaceReadScopeRenewalResult {
  readonly protocol: "eliotr.owner-namespace-renewal.v1";
  readonly source_namespace_id: string;
  readonly title: string;
  readonly read_policy_generation: number;
  readonly read_expires_at: string;
  readonly read_access: "ACTIVE";
}

interface ScopeRenewalRow {
  readonly init_namespace: unknown;
  readonly init_principal: unknown;
  readonly init_owner_incarnation: unknown;
  readonly init_owner_generation: unknown;
  readonly init_owner_revision: unknown;
  readonly init_policy_revision: unknown;
  readonly init_scope_ref: unknown;
  readonly init_title: unknown;
  readonly owner_namespace: unknown;
  readonly owner_system_id: unknown;
  readonly owner_status: unknown;
  readonly owner_incarnation: unknown;
  readonly owner_generation: unknown;
  readonly owner_revision: unknown;
  readonly owner_policy_revision: unknown;
  readonly policy_namespace: unknown;
  readonly policy_revision: unknown;
  readonly policy_authorized: unknown;
  readonly policy_modes: unknown;
  readonly policy_allowed_use: unknown;
  readonly policy_disclosure: unknown;
  readonly policy_taint: unknown;
  readonly policy_effects: unknown;
  readonly scope_namespace: unknown;
  readonly scope_principal: unknown;
  readonly scope_client_class: unknown;
  readonly scope_policy_ref: unknown;
  readonly scope_generation: unknown;
  readonly scope_allowed_use: unknown;
  readonly scope_disclosure: unknown;
  readonly scope_state: unknown;
  readonly scope_created_at: unknown;
  readonly scope_expires_at: unknown;
}

interface DecodedScopeRenewalRow {
  readonly source_namespace_id: string;
  readonly title: string;
  readonly policy_ref: string;
  readonly generation: number;
  readonly allowed_use_json: string;
  readonly disclosure_ceiling: string;
  readonly created_at: string;
  readonly state: "ACTIVE" | "REVOKED";
  readonly expires_at: string;
  readonly expires_at_ms: number;
  readonly owner_incarnation_ref: string;
  readonly source_owner_generation: string;
  readonly ownership_record_revision: number;
  readonly source_admission_policy_revision: number;
  readonly policy_authorized_json: string;
  readonly policy_modes_json: string;
  readonly policy_allowed_use_json: string;
  readonly policy_disclosure_ceiling: string;
}

type VerifiedOwnerSession = SourceNamespaceLeaseRefreshSession;

function fail(
  code: SourceNamespaceReadScopeRenewalErrorCode,
  status: number,
  message: string,
  retryable = false,
  cause?: unknown,
): never {
  throw new SourceNamespaceReadScopeRenewalError(code, status, message, retryable, cause);
}

function canonicalTime(value: unknown, label: string): { readonly iso: string; readonly millis: number } {
  if (typeof value !== "string") fail("NAMESPACE_STORAGE_UNAVAILABLE", 503, `${label} is unavailable`, true);
  const millis = Date.parse(value);
  if (!Number.isSafeInteger(millis) || new Date(millis).toISOString() !== value) {
    fail("NAMESPACE_STORAGE_UNAVAILABLE", 503, `${label} is not canonical`, true);
  }
  return { iso: value, millis };
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    fail("NAMESPACE_STORAGE_UNAVAILABLE", 503, `${label} is invalid`, true);
  }
  return value;
}

function jsonStrings(value: unknown, label: string): readonly string[] {
  if (typeof value !== "string") fail("NAMESPACE_STORAGE_UNAVAILABLE", 503, `${label} is unavailable`, true);
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch (cause) {
    fail("NAMESPACE_STORAGE_UNAVAILABLE", 503, `${label} is invalid`, true, cause);
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string") || new Set(parsed).size !== parsed.length) {
    fail("NAMESPACE_STORAGE_UNAVAILABLE", 503, `${label} is invalid`, true);
  }
  return parsed;
}

function integerValue(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MAX_GENERATION) {
    fail("NAMESPACE_STORAGE_UNAVAILABLE", 503, `${label} is invalid`, true);
  }
  return value;
}

function trustedNow(now: () => number): { readonly iso: string; readonly millis: number } {
  let millis: number;
  try { millis = now(); } catch (cause) {
    fail("NAMESPACE_INPUT_INVALID", 400, "server clock is unavailable", false, cause);
  }
  if (!Number.isSafeInteger(millis) || millis < 0 || millis > 8_640_000_000_000) {
    fail("NAMESPACE_INPUT_INVALID", 400, "server clock is invalid");
  }
  return { millis, iso: new Date(millis).toISOString() };
}

function accessExpiry(
  context: AuthenticatedRequestContext,
  nowMs: number,
  expected?: VerifiedOwnerSession,
): VerifiedOwnerSession {
  if (context.client_class !== CLIENT_CLASS || !IDENTIFIER.test(context.principal_ref) ||
      !IDENTIFIER.test(context.credential_generation)) {
    fail("NAMESPACE_OWNER_REQUIRED", 403, "a current owner access session is required");
  }
  const access = context.access;
  if (access === undefined || typeof access !== "object") {
    fail("NAMESPACE_OWNER_REQUIRED", 403, "a current owner access session is required");
  }
  if (access.authentication_method !== "cloudflare_access" || access.principal_ref !== context.principal_ref) {
    fail("NAMESPACE_OWNER_REQUIRED", 403, "owner access principal does not match the request");
  }
  if (access.credential_generation !== context.credential_generation) {
    fail("NAMESPACE_OWNER_REQUIRED", 403, "owner access credential does not match the request");
  }
  const expiry = canonicalTime(access.expires_at, "owner access expiry");
  if (expiry.millis <= nowMs) fail("NAMESPACE_OWNER_REQUIRED", 403, "a current owner access session is required");
  if (expected !== undefined && (context.principal_ref !== expected.principal_ref ||
      context.credential_generation !== expected.credential_generation || access.principal_ref !== expected.principal_ref ||
      access.credential_generation !== expected.credential_generation || expiry.iso !== expected.expires_at)) {
    fail("NAMESPACE_OWNER_REQUIRED", 403, "owner access session changed during namespace renewal");
  }
  return {
    principal_ref: context.principal_ref,
    credential_generation: context.credential_generation,
    expires_at: expiry.iso,
    expires_at_ms: expiry.millis,
  };
}

async function readScope(database: D1Database, namespaceId: string, principalRef: string): Promise<DecodedScopeRenewalRow> {
  let row: ScopeRenewalRow | null;
  try {
    row = await database.prepare(
      "SELECT i.source_namespace_id AS init_namespace,i.principal_ref AS init_principal,i.owner_incarnation_ref AS init_owner_incarnation," +
      "i.source_owner_generation AS init_owner_generation,i.ownership_record_revision AS init_owner_revision," +
      "i.source_admission_policy_revision AS init_policy_revision,i.scope_policy_ref AS init_scope_ref,i.title AS init_title," +
      "o.source_namespace_id AS owner_namespace,o.owner_system_id,o.status AS owner_status,o.owner_incarnation_ref AS owner_incarnation," +
      "o.source_owner_generation AS owner_generation,o.ownership_record_revision AS owner_revision," +
      "o.source_admission_policy_revision AS owner_policy_revision," +
      "p.source_namespace_id AS policy_namespace,p.revision AS policy_revision,p.authorized_principal_refs_json AS policy_authorized," +
      "p.allowed_ownership_modes_json AS policy_modes,p.allowed_use_json AS policy_allowed_use,p.disclosure_ceiling AS policy_disclosure," +
      "p.instruction_taint AS policy_taint,p.allowed_effects AS policy_effects," +
      "s.source_namespace_id AS scope_namespace,s.principal_ref AS scope_principal,s.client_class AS scope_client_class," +
      "s.policy_ref AS scope_policy_ref,s.generation AS scope_generation,s.allowed_use_json AS scope_allowed_use," +
      "s.disclosure_ceiling AS scope_disclosure,s.state AS scope_state,s.created_at AS scope_created_at," +
      "s.expires_at AS scope_expires_at " +
      "FROM source_namespace_initialization i " +
      "JOIN source_namespace_ownership o ON o.source_namespace_id=i.source_namespace_id " +
      "AND o.ownership_record_revision=i.ownership_record_revision AND o.owner_incarnation_ref=i.owner_incarnation_ref " +
      "AND o.source_owner_generation=i.source_owner_generation AND o.source_admission_policy_revision=i.source_admission_policy_revision " +
      "JOIN source_admission_policy p ON p.source_namespace_id=i.source_namespace_id AND p.revision=i.source_admission_policy_revision " +
      "JOIN scope_read_policy s ON s.source_namespace_id=i.source_namespace_id AND s.principal_ref=?2 AND s.client_class='owner_pwa' " +
      "WHERE i.source_namespace_id=?1 AND i.principal_ref=?2 AND o.owner_system_id='eliotr' AND o.status='ACTIVE' LIMIT 1",
    ).bind(namespaceId, principalRef).first<ScopeRenewalRow>();
  } catch (cause) {
    fail("NAMESPACE_STORAGE_UNAVAILABLE", 503, "namespace read policy is unavailable", true, cause);
  }
  if (row === null) fail("NAMESPACE_READ_SCOPE_UNAVAILABLE", 404, "owner read policy is unavailable for this namespace");

  const initNamespace = stringValue(row.init_namespace, "namespace initialization");
  const scopeNamespace = stringValue(row.scope_namespace, "read policy namespace");
  const ownerNamespace = stringValue(row.owner_namespace, "namespace ownership");
  const policyNamespace = stringValue(row.policy_namespace, "admission policy namespace");
  if (initNamespace !== namespaceId || scopeNamespace !== namespaceId || ownerNamespace !== namespaceId || policyNamespace !== namespaceId) {
    fail("NAMESPACE_STORAGE_UNAVAILABLE", 503, "namespace identity is inconsistent", true);
  }
  if (row.init_principal !== principalRef || row.scope_principal !== principalRef || row.scope_client_class !== CLIENT_CLASS ||
      row.owner_system_id !== OWNER_SYSTEM_ID || row.owner_status !== "ACTIVE") {
    fail("NAMESPACE_READ_SCOPE_UNAVAILABLE", 404, "owner read policy is unavailable for this namespace");
  }
  const initOwnerIncarnation = stringValue(row.init_owner_incarnation, "owner incarnation");
  const initOwnerGeneration = stringValue(row.init_owner_generation, "owner generation");
  if (row.owner_incarnation !== initOwnerIncarnation || row.owner_generation !== initOwnerGeneration) {
    fail("NAMESPACE_READ_SCOPE_UNAVAILABLE", 404, "namespace ownership has changed");
  }
  const initOwnerRevision = integerValue(row.init_owner_revision, "ownership revision");
  const ownerRevision = integerValue(row.owner_revision, "current ownership revision");
  const initPolicyRevision = integerValue(row.init_policy_revision, "admission policy revision");
  const ownerPolicyRevision = integerValue(row.owner_policy_revision, "current admission policy revision");
  const policyRevision = integerValue(row.policy_revision, "admission policy row revision");
  if (ownerRevision !== initOwnerRevision || ownerPolicyRevision !== initPolicyRevision || policyRevision !== initPolicyRevision) {
    fail("NAMESPACE_READ_SCOPE_UNAVAILABLE", 404, "namespace admission identity has changed");
  }
  const scopeRef = stringValue(row.scope_policy_ref, "read policy reference");
  if (row.init_scope_ref !== scopeRef) fail("NAMESPACE_READ_SCOPE_UNAVAILABLE", 404, "read policy lineage has changed");
  const authorizedJson = typeof row.policy_authorized === "string" ? row.policy_authorized : "";
  const modesJson = typeof row.policy_modes === "string" ? row.policy_modes : "";
  const policyUsesJson = typeof row.policy_allowed_use === "string" ? row.policy_allowed_use : "";
  const authorized = jsonStrings(authorizedJson, "authorized principals");
  const modes = jsonStrings(modesJson, "ownership modes");
  const policyUses = jsonStrings(policyUsesJson, "admission uses");
  if (!authorized.includes(principalRef) || modes.length !== 1 || modes[0] !== "immutable_import" ||
      !policyUses.includes("research") || row.policy_taint !== "DATA_ONLY" || row.policy_effects !== "READ_ONLY") {
    fail("NAMESPACE_READ_SCOPE_UNAVAILABLE", 404, "namespace admission does not authorize this owner read");
  }
  const allowedUseJson = typeof row.scope_allowed_use === "string" ? row.scope_allowed_use : "";
  const scopeUses = jsonStrings(allowedUseJson, "read policy uses");
  if (!scopeUses.includes("research") || scopeUses.some((use) => !policyUses.includes(use))) {
    fail("NAMESPACE_STORAGE_UNAVAILABLE", 503, "read policy uses are inconsistent with admission", true);
  }
  const policyDisclosure = row.policy_disclosure;
  const scopeDisclosure = row.scope_disclosure;
  if (typeof policyDisclosure !== "string" || policyDisclosure.length === 0 || scopeDisclosure !== policyDisclosure) {
    fail("NAMESPACE_STORAGE_UNAVAILABLE", 503, "read policy disclosure is inconsistent", true);
  }
  const state = row.scope_state;
  if (state !== "ACTIVE" && state !== "REVOKED") fail("NAMESPACE_STORAGE_UNAVAILABLE", 503, "read policy state is invalid", true);
  const title = row.init_title;
  if (typeof title !== "string" || title.length < 1 || title.length > MAX_TITLE_BYTES || title !== title.trim() || /[\u0000-\u001f\u007f]/u.test(title)) {
    fail("NAMESPACE_STORAGE_UNAVAILABLE", 503, "namespace title is invalid", true);
  }
  const expiry = canonicalTime(row.scope_expires_at, "read policy expiry");
  const createdAt = canonicalTime(row.scope_created_at, "read policy creation time");
  return {
    source_namespace_id: namespaceId,
    title,
    policy_ref: scopeRef,
    generation: integerValue(row.scope_generation, "read policy generation"),
    allowed_use_json: allowedUseJson,
    disclosure_ceiling: scopeDisclosure,
    created_at: createdAt.iso,
    state,
    expires_at: expiry.iso,
    expires_at_ms: expiry.millis,
    owner_incarnation_ref: initOwnerIncarnation,
    source_owner_generation: initOwnerGeneration,
    ownership_record_revision: initOwnerRevision,
    source_admission_policy_revision: initPolicyRevision,
    policy_authorized_json: authorizedJson,
    policy_modes_json: modesJson,
    policy_allowed_use_json: policyUsesJson,
    policy_disclosure_ceiling: policyDisclosure,
  };
}

function result(row: DecodedScopeRenewalRow): SourceNamespaceReadScopeRenewalResult {
  return {
    protocol: "eliotr.owner-namespace-renewal.v1",
    source_namespace_id: row.source_namespace_id,
    title: row.title,
    read_policy_generation: row.generation,
    read_expires_at: row.expires_at,
    read_access: "ACTIVE",
  };
}

export async function renewSourceNamespaceReadScope(input: {
  readonly database: D1Database;
  readonly context: AuthenticatedRequestContext;
  readonly namespace_id: string;
  readonly request: SourceNamespaceReadScopeRenewalRequest;
  readonly now: () => number;
}): Promise<SourceNamespaceReadScopeRenewalResult> {
  if (!IDENTIFIER.test(input.namespace_id) || !input.request || typeof input.request !== "object" ||
      !Number.isSafeInteger(input.request.expected_generation) || input.request.expected_generation < 1 ||
      input.request.expected_generation > MAX_GENERATION) {
    fail("NAMESPACE_INPUT_INVALID", 400, "namespace renewal input is invalid");
  }
  const access = accessExpiry(input.context, trustedNow(input.now).millis);
  let current = await readScope(input.database, input.namespace_id, input.context.principal_ref);
  accessExpiry(input.context, trustedNow(input.now).millis, access);
  if (current.state === "REVOKED") fail("NAMESPACE_READ_SCOPE_REVOKED", 409, "revoked owner read policy cannot be renewed");
  if (current.generation !== input.request.expected_generation) {
    let receipt: SourceNamespaceLeaseRefreshReceiptRow | null;
    try {
      receipt = await readAppliedSourceNamespaceLeaseRefresh({
        database: input.database,
        namespace_id: input.namespace_id,
        session: access,
        expected_generation: input.request.expected_generation,
      });
    } catch (cause) {
      fail("NAMESPACE_STORAGE_UNAVAILABLE", 503, "namespace lease receipt is unavailable", true, cause);
    }
    accessExpiry(input.context, trustedNow(input.now).millis, access);
    try {
      current = await readScope(input.database, input.namespace_id, input.context.principal_ref);
    } catch (cause) {
      fail("NAMESPACE_READ_SCOPE_CONFLICT", 409, "read policy changed during renewal reconciliation", false, cause);
    }
    accessExpiry(input.context, trustedNow(input.now).millis, access);
    if (receipt !== null && typeof receipt.refresh_id === "string") {
      let matched = false;
      try {
        matched = await sourceNamespaceLeaseRefreshReceiptMatches({
          receipt,
          current,
          session: access,
          expected_generation: input.request.expected_generation,
          refresh_id: receipt.refresh_id,
        });
      } catch (cause) {
        fail("NAMESPACE_STORAGE_UNAVAILABLE", 503, "namespace lease receipt could not be verified", true, cause);
      }
      accessExpiry(input.context, trustedNow(input.now).millis, access);
      if (matched) return result(current);
    }
    fail("NAMESPACE_READ_SCOPE_CONFLICT", 409, "read policy generation no longer matches the request");
  }
  if (current.expires_at_ms >= access.expires_at_ms) {
    accessExpiry(input.context, trustedNow(input.now).millis, access);
    return result(current);
  }
  const nextGeneration = current.generation + 1;
  if (nextGeneration > MAX_GENERATION) fail("NAMESPACE_READ_SCOPE_CONFLICT", 409, "read policy generation cannot advance");
  const proof = await createSourceNamespaceLeaseRefreshProof({
    namespace_id: input.namespace_id,
    session: access,
    current,
    new_generation: nextGeneration,
    created_at: trustedNow(input.now).iso,
  });
  accessExpiry(input.context, trustedNow(input.now).millis, access);
  let writeFailure: unknown;
  try {
    await input.database.batch([
      prepareSourceNamespaceLeaseRefreshInsert(input.database, proof),
      input.database.prepare(
      "UPDATE scope_read_policy SET generation=?1,expires_at=?2 WHERE source_namespace_id=?3 AND principal_ref=?4 " +
      "AND client_class='owner_pwa' AND policy_ref=?5 AND generation=?6 AND allowed_use_json=?7 AND disclosure_ceiling=?8 " +
      "AND state='ACTIVE' AND created_at=?20 AND expires_at=?9 AND julianday('now')<julianday(?2) " +
      "AND EXISTS (SELECT 1 FROM source_namespace_initialization i " +
      "JOIN source_namespace_ownership o ON o.source_namespace_id=i.source_namespace_id AND o.ownership_record_revision=i.ownership_record_revision " +
      "AND o.owner_incarnation_ref=i.owner_incarnation_ref AND o.source_owner_generation=i.source_owner_generation " +
      "AND o.source_admission_policy_revision=i.source_admission_policy_revision " +
      "JOIN source_admission_policy p ON p.source_namespace_id=i.source_namespace_id AND p.revision=i.source_admission_policy_revision " +
      "WHERE i.source_namespace_id=?3 AND i.principal_ref=?4 AND i.owner_incarnation_ref=?10 AND i.source_owner_generation=?11 " +
      "AND i.ownership_record_revision=?12 AND i.source_admission_policy_revision=?13 AND i.scope_policy_ref=?5 " +
      "AND o.owner_system_id='eliotr' AND o.status='ACTIVE' AND p.authorized_principal_refs_json=?14 " +
      "AND p.allowed_ownership_modes_json=?15 AND p.allowed_use_json=?16 AND p.disclosure_ceiling=?17 " +
      "AND p.instruction_taint='DATA_ONLY' AND p.allowed_effects='READ_ONLY' " +
      "AND EXISTS (SELECT 1 FROM json_each(p.authorized_principal_refs_json) WHERE json_each.value=?4) " +
      "AND EXISTS (SELECT 1 FROM json_each(p.allowed_ownership_modes_json) WHERE json_each.value='immutable_import') " +
      "AND EXISTS (SELECT 1 FROM json_each(p.allowed_use_json) WHERE json_each.value='research')) " +
      "AND EXISTS (SELECT 1 FROM scope_read_policy_lease_refresh_receipt r WHERE r.refresh_id=?18 " +
      "AND r.source_namespace_id=?3 AND r.principal_ref=?4 AND r.client_class='owner_pwa' " +
      "AND r.credential_generation=?19 AND r.access_expires_at=?2 AND r.owner_incarnation_ref=?10 " +
      "AND r.source_owner_generation=?11 AND r.ownership_record_revision=?12 " +
      "AND r.source_admission_policy_revision=?13 AND r.policy_ref=?5 AND r.old_generation=?6 " +
      "AND r.new_generation=?1 AND r.old_allowed_use_json=?7 AND r.old_disclosure_ceiling=?8 " +
      "AND r.old_created_at=?20 " +
         "AND r.old_expires_at=?9 AND r.new_expires_at=?2 AND r.state='PREPARED')",
      ).bind(nextGeneration, access.expires_at, input.namespace_id, input.context.principal_ref, current.policy_ref,
      input.request.expected_generation, current.allowed_use_json, current.disclosure_ceiling, current.expires_at,
      current.owner_incarnation_ref, current.source_owner_generation, current.ownership_record_revision,
      current.source_admission_policy_revision, current.policy_authorized_json, current.policy_modes_json,
      current.policy_allowed_use_json, current.policy_disclosure_ceiling, proof.refresh_id, access.credential_generation,
      current.created_at),
      prepareSourceNamespaceLeaseRefreshApply(input.database, proof),
    ]);
  } catch (cause) {
    writeFailure = cause;
  }
  accessExpiry(input.context, trustedNow(input.now).millis, access);
  try {
    current = await readScope(input.database, input.namespace_id, input.context.principal_ref);
  } catch (cause) {
    if (cause instanceof SourceNamespaceReadScopeRenewalError && cause.code === "NAMESPACE_READ_SCOPE_REVOKED") throw cause;
    fail("NAMESPACE_SETTLEMENT_UNCERTAIN", 503, "owner read policy renewal settlement is uncertain", true,
      writeFailure ?? (cause instanceof SourceNamespaceReadScopeRenewalError ? cause.failureCause : cause));
  }
  accessExpiry(input.context, trustedNow(input.now).millis, access);
  let appliedReceipt: SourceNamespaceLeaseRefreshReceiptRow | null = null;
  try {
    appliedReceipt = await readSourceNamespaceLeaseRefreshReceipt(input.database, proof.refresh_id);
  } catch (cause) {
    fail("NAMESPACE_SETTLEMENT_UNCERTAIN", 503, "owner read policy receipt settlement is uncertain", true,
      writeFailure ?? cause);
  }
  accessExpiry(input.context, trustedNow(input.now).millis, access);
  try {
    current = await readScope(input.database, input.namespace_id, input.context.principal_ref);
  } catch (cause) {
    fail("NAMESPACE_SETTLEMENT_UNCERTAIN", 503, "owner read policy final readback is uncertain", true,
      writeFailure ?? (cause instanceof SourceNamespaceReadScopeRenewalError ? cause.failureCause : cause));
  }
  accessExpiry(input.context, trustedNow(input.now).millis, access);
  let settled = false;
  if (appliedReceipt !== null) {
    try {
      settled = await sourceNamespaceLeaseRefreshReceiptMatches({
        receipt: appliedReceipt,
        current,
        session: access,
        expected_generation: input.request.expected_generation,
        refresh_id: proof.refresh_id,
      });
    } catch (cause) {
      fail("NAMESPACE_SETTLEMENT_UNCERTAIN", 503, "owner read policy receipt verification is uncertain", true,
        writeFailure ?? cause);
    }
  }
  accessExpiry(input.context, trustedNow(input.now).millis, access);
  if (settled) return result(current);
  if (current.state === "REVOKED") fail("NAMESPACE_READ_SCOPE_REVOKED", 409, "revoked owner read policy cannot be renewed");
  if (current.generation !== input.request.expected_generation) {
    fail("NAMESPACE_READ_SCOPE_CONFLICT", 409, "read policy renewal lost its generation compare-and-set");
  }
  fail("NAMESPACE_SETTLEMENT_UNCERTAIN", 503, "owner read policy renewal did not settle", true, writeFailure);
}
