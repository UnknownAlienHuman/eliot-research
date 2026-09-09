import type { D1Database } from "@cloudflare/workers-types";
import type { ExchangeGeneration } from "@eliotr/contracts";
import { createGoogleAccessLeaseProvider, type GoogleTokenLeaseOptions } from "./token-lease.js";
import { credentialSnapshot, sameGoogleCredentials, type GoogleCredentialSnapshot, type GoogleCredentialStore, type GoogleDisconnectReceiptFence } from "./token-credentials.js";
import { encryptedToken, GoogleCredentialError, tokenBinding, type GoogleConnectionState,
  type EncryptedRefreshToken, type GoogleTokenBinding } from "./token-vault.js";
import { validateExchangeGeneration } from "./serializer.js";

const COLUMNS = `connection_id, principal_id, oauth_client_id, google_subject, google_email, credential_generation,
  credential_revision, state, scopes_json, oauth_publishing_status, refresh_expires_at_epoch_ms,
  encrypted_refresh_token, token_nonce, token_key_version`;
const SCHEMA = `EXISTS (SELECT 1 FROM schema_state WHERE key='google_credentials_generation' AND value='google-credentials-v1')`;
const WHERE = `connection_id=?1 AND principal_id=?2 AND oauth_client_id=?3 AND google_subject=?4 AND google_email=?5
  AND credential_generation=?6 AND credential_revision=?7 AND state=?8 AND scopes_json=?9
  AND oauth_publishing_status=?10 AND refresh_expires_at_epoch_ms IS ?11 AND encrypted_refresh_token=?12
  AND token_nonce=?13 AND token_key_version=?14`;
const fail = (code: string): never => { throw new GoogleCredentialError(code); };
function blob(value: unknown): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (Array.isArray(value) && value.length <= 4112 && value.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) return new Uint8Array(value);
  return fail("GOOGLE_CREDENTIAL_RECORD_INVALID");
}
function matches(row: GoogleCredentialSnapshot) {
  const b = row.binding;
  return [b.connection_id, b.principal_id, b.oauth_client_id, b.google_subject, b.google_email, b.credential_generation,
    row.revision, row.state, JSON.stringify(row.granted_scopes), row.oauth_publishing_status, row.refresh_expires_at_epoch_ms,
    new Uint8Array(row.token.ciphertext).buffer, new Uint8Array(row.token.nonce).buffer, row.token.key_version];
}
/** Existing admitted rows only. This is NOT a public connect endpoint or an identity verifier. */
// IMPLEMENTED_NOT_LIVE: ER-20 encrypted credential CAS/readback plus explicit
// revoke; live Google qualification and full Drive activation remain separate.
export function createD1GoogleCredentialStore(database: D1Database, expected: GoogleTokenBinding,
  now: () => number = Date.now): GoogleCredentialStore {
  const binding = tokenBinding(expected);
  const db = database.withSession("first-primary");
  const cancelled = (signal: AbortSignal) => { if (signal.aborted) fail("GOOGLE_CREDENTIAL_CANCELLED"); };
  const load = async (signal: AbortSignal): Promise<GoogleCredentialSnapshot> => {
    cancelled(signal);
    // Reject invalid/unbounded records in SQL before bringing ciphertext or JSON into Worker memory.
    const row = await db.prepare(`SELECT ${COLUMNS} FROM google_exchange_connection WHERE connection_id=?1 AND principal_id=?2
      AND length(scopes_json)<=512 AND length(encrypted_refresh_token) BETWEEN 17 AND 4112 AND length(token_nonce)=12
      AND length(oauth_client_id)<=256 AND length(google_subject)<=256 AND length(google_email)<=256
      AND length(credential_generation)<=256 AND ${SCHEMA}`)
      .bind(binding.connection_id, binding.principal_id).first<Record<string, unknown>>().catch(() => fail("GOOGLE_CREDENTIAL_UNAVAILABLE"));
    cancelled(signal);
    if (!row) return fail("GOOGLE_CREDENTIAL_UNAVAILABLE");
    try {
      const loadedBinding = tokenBinding({ connection_id: row.connection_id as string, principal_id: row.principal_id as string,
        oauth_client_id: row.oauth_client_id as string, google_subject: row.google_subject as string,
        google_email: row.google_email as string, credential_generation: row.credential_generation as string });
      if (JSON.stringify(loadedBinding) !== JSON.stringify(binding)) return fail("GOOGLE_CREDENTIAL_CHANGED");
      const scopes: unknown = JSON.parse(row.scopes_json as string);
      if (JSON.stringify(scopes) !== row.scopes_json) return fail("GOOGLE_CREDENTIAL_RECORD_INVALID");
      return credentialSnapshot({ binding: loadedBinding, revision: row.credential_revision as number,
        state: row.state as GoogleCredentialSnapshot["state"], granted_scopes: scopes as string[],
        oauth_publishing_status: row.oauth_publishing_status as "In production", refresh_expires_at_epoch_ms: row.refresh_expires_at_epoch_ms as number | null,
        token: { ciphertext: blob(row.encrypted_refresh_token), nonce: blob(row.token_nonce), key_version: row.token_key_version as number } });
    } catch { return fail("GOOGLE_CREDENTIAL_RECORD_INVALID"); }
  };
  const assertCurrent = async (snapshot: GoogleCredentialSnapshot, signal: AbortSignal) => {
    const frozen = credentialSnapshot(snapshot);
    if (!sameGoogleCredentials(frozen, await load(signal))) fail("GOOGLE_CREDENTIAL_CHANGED");
  };
  const change = async (expectedRow: GoogleCredentialSnapshot, nextToken: EncryptedRefreshToken | null,
    expiresAt: number | null, signal: AbortSignal) => {
    cancelled(signal); const previous = credentialSnapshot(expectedRow);
    if (!["ACTIVE", "DEGRADED"].includes(previous.state) || JSON.stringify(previous.binding) !== JSON.stringify(binding)) {
      return fail("GOOGLE_CREDENTIAL_CHANGED");
    }
    const next = credentialSnapshot({ ...previous, revision: previous.revision + 1,
      state: nextToken === null ? "REAUTH_REQUIRED" : previous.state, token: nextToken ?? previous.token,
      refresh_expires_at_epoch_ms: expiresAt });
    if (next.token.key_version < previous.token.key_version) return fail("GOOGLE_TOKEN_KEY_DOWNGRADE");
    const time = now(); if (!Number.isSafeInteger(time) || time < 0 || time > 8640000000000000) return fail("GOOGLE_CLOCK_INVALID");
    const sql = nextToken === null
      ? `UPDATE google_exchange_connection SET state='REAUTH_REQUIRED',credential_revision=?15,last_error_code='GOOGLE_REAUTH_REQUIRED',updated_at=?16 WHERE ${WHERE} AND ${SCHEMA}`
      : `UPDATE google_exchange_connection SET credential_revision=?15,updated_at=?16,encrypted_refresh_token=?17,token_nonce=?18,
         token_key_version=?19,refresh_expires_at_epoch_ms=?20 WHERE ${WHERE} AND ${SCHEMA}`;
    const values = [...matches(previous), next.revision, new Date(time).toISOString(),
      ...(nextToken === null ? [] : [new Uint8Array(next.token.ciphertext).buffer, new Uint8Array(next.token.nonce).buffer,
        next.token.key_version, next.refresh_expires_at_epoch_ms])];
    try { await db.prepare(sql).bind(...values).run(); }
    catch { /* A lost ACK is resolved below; never reissue the mutation. */ }
    const actual = await load(signal);
    if (!sameGoogleCredentials(actual, next)) return fail("GOOGLE_CREDENTIAL_WRITE_UNCONFIRMED");
    return actual;
  };
  const revocationPlan = (expectedRow: GoogleCredentialSnapshot, signal: AbortSignal) => {
    cancelled(signal); const previous = credentialSnapshot(expectedRow);
    if (JSON.stringify(previous.binding) !== JSON.stringify(binding)) return fail("GOOGLE_CREDENTIAL_CHANGED");
    const next = credentialSnapshot({ ...previous, revision: previous.revision + 1, state: "REVOKED" });
    const time = now(); if (!Number.isSafeInteger(time) || time < 0 || time > 8640000000000000) return fail("GOOGLE_CLOCK_INVALID");
    return { previous, next, timestamp: new Date(time).toISOString() } as const;
  };
  const revoke = async (expectedRow: GoogleCredentialSnapshot, signal: AbortSignal): Promise<GoogleCredentialSnapshot> => {
    const { previous, next, timestamp } = revocationPlan(expectedRow, signal);
    let changed = false; let uncertain = false;
    try {
      const result = await db.prepare(`UPDATE google_exchange_connection SET state='REVOKED',credential_revision=?15,last_error_code='GOOGLE_REVOKED',updated_at=?16
        WHERE ${WHERE} AND state IN ('ACTIVE','DEGRADED','REAUTH_REQUIRED','AUTHORIZING') AND ${SCHEMA}`)
        .bind(...matches(previous), next.revision, timestamp).run();
      changed = result.meta.changes === 1;
    } catch { uncertain = true; /* Lost ACK is reconciled by the exact readback. */ }
    const actual = await load(signal);
    if (!sameGoogleCredentials(actual, next) || (!changed && !uncertain)) return fail("GOOGLE_CREDENTIAL_WRITE_UNCONFIRMED");
    return actual;
  };
  const revokeWithDisconnectReceipt = async (expectedRow: GoogleCredentialSnapshot, receipt: GoogleDisconnectReceiptFence,
    signal: AbortSignal): Promise<GoogleCredentialSnapshot> => {
    const { previous, next, timestamp } = revocationPlan(expectedRow, signal);
    if (receipt.connection_id !== binding.connection_id || receipt.principal_id !== binding.principal_id
        || receipt.expected_credential_generation !== previous.binding.credential_generation
        || receipt.expected_credential_revision !== previous.revision) return fail("GOOGLE_CREDENTIAL_CHANGED");
    const credentialUpdate = db.prepare(`UPDATE google_exchange_connection SET state='REVOKED',credential_revision=?15,last_error_code='GOOGLE_REVOKED',updated_at=?16
      WHERE ${WHERE} AND state IN ('ACTIVE','DEGRADED','REAUTH_REQUIRED','AUTHORIZING') AND ${SCHEMA}
        AND EXISTS (SELECT 1 FROM google_oauth_disconnect_receipt r WHERE r.principal_id=?17 AND r.operation_ref=?18
          AND r.connection_id=?19 AND r.configuration_json=?20 AND r.expected_credential_generation=?21
          AND r.expected_credential_revision=?22 AND r.result_state IS NULL)`)
      .bind(...matches(previous), next.revision, timestamp, receipt.principal_id, receipt.operation_ref, receipt.connection_id,
        receipt.configuration_json, receipt.expected_credential_generation, receipt.expected_credential_revision);
    const receiptUpdate = db.prepare(`UPDATE google_oauth_disconnect_receipt SET result_credential_generation=?3,result_credential_revision=?4,result_state='REVOKED'
      WHERE principal_id=?1 AND operation_ref=?2 AND connection_id=?5 AND configuration_json=?6
        AND expected_credential_generation=?7 AND expected_credential_revision=?8 AND result_state IS NULL
        AND EXISTS (SELECT 1 FROM google_exchange_connection c WHERE c.connection_id=?5 AND c.principal_id=?1
          AND c.oauth_client_id=?9 AND c.google_subject=?10 AND c.google_email=?11
          AND c.credential_generation=?3 AND c.credential_revision=?4 AND c.state='REVOKED' AND c.updated_at=?12 AND ${SCHEMA})`)
      .bind(receipt.principal_id, receipt.operation_ref, next.binding.credential_generation, next.revision, receipt.connection_id,
        receipt.configuration_json, receipt.expected_credential_generation, receipt.expected_credential_revision,
        binding.oauth_client_id, binding.google_subject, binding.google_email, timestamp);
    try { await db.batch([credentialUpdate, receiptUpdate]); }
    catch { /* Reconcile both effects by exact credential and receipt readback. */ }
    const actual = await load(signal);
    if (!sameGoogleCredentials(actual, next)) return fail("GOOGLE_CREDENTIAL_WRITE_UNCONFIRMED");
    return actual;
  };
  return { load, assertCurrent,
    replaceToken: (snapshot, token, expiry, signal) => change(snapshot, encryptedToken(token), expiry, signal),
    requireReauthorization: async (snapshot, signal) => { await change(snapshot, null, snapshot.refresh_expires_at_epoch_ms, signal); }, revoke,
    revokeWithDisconnectReceipt,
  };
}

export interface GoogleCredentialStatus {
  readonly binding: GoogleTokenBinding;
  readonly revision: number;
  readonly state: GoogleConnectionState;
}

/** Read only the nonsecret connection fence for an authenticated owner. */
export async function readD1GoogleCredentialStatus(database: D1Database, expected: Omit<GoogleTokenBinding, "credential_generation">,
  signal: AbortSignal): Promise<GoogleCredentialStatus | null> {
  if (signal.aborted) throw new GoogleCredentialError("GOOGLE_CREDENTIAL_CANCELLED");
  const db = database.withSession("first-primary");
  const row = await db.prepare(`SELECT connection_id,principal_id,oauth_client_id,google_subject,google_email,credential_generation,credential_revision,state,
      oauth_publishing_status,admission_intent_id,
      CASE WHEN admission_intent_id IS NOT NULL AND EXISTS (SELECT 1 FROM google_oauth_intent i
        WHERE i.intent_id=google_exchange_connection.admission_intent_id AND i.state='ADMITTED') THEN 1 ELSE 0 END AS admission_confirmed
    FROM google_exchange_connection WHERE connection_id=?1 AND principal_id=?2 AND oauth_client_id=?3 AND google_subject=?4 AND google_email=?5
      AND length(connection_id)<=256 AND length(principal_id)<=256 AND length(oauth_client_id)<=256 AND length(google_subject)<=256
      AND length(google_email)<=256 AND length(credential_generation)<=256 AND ${SCHEMA}`)
    .bind(expected.connection_id, expected.principal_id, expected.oauth_client_id, expected.google_subject, expected.google_email)
    .first<Record<string, unknown>>().catch(() => { throw new GoogleCredentialError("GOOGLE_CREDENTIAL_UNAVAILABLE"); });
  if (signal.aborted) throw new GoogleCredentialError("GOOGLE_CREDENTIAL_CANCELLED");
  if (!row) return null;
  try {
    if (!["connection_id", "principal_id", "oauth_client_id", "google_subject", "google_email", "credential_generation"]
      .every((key) => typeof row[key] === "string")) throw new GoogleCredentialError("GOOGLE_CREDENTIAL_RECORD_INVALID");
    const loaded = tokenBinding({ connection_id: row.connection_id as string, principal_id: row.principal_id as string,
      oauth_client_id: row.oauth_client_id as string, google_subject: row.google_subject as string,
      google_email: row.google_email as string, credential_generation: row.credential_generation as string });
    const states: GoogleConnectionState[] = ["DISCONNECTED", "AUTHORIZING", "ACTIVE", "DEGRADED", "REAUTH_REQUIRED", "REVOKED"];
    if (loaded.connection_id !== expected.connection_id || loaded.principal_id !== expected.principal_id
        || loaded.oauth_client_id !== expected.oauth_client_id || loaded.google_subject !== expected.google_subject || loaded.google_email !== expected.google_email
        || !Number.isSafeInteger(row.credential_revision) || (row.credential_revision as number) < 1
        || !states.includes(row.state as GoogleConnectionState) || row.oauth_publishing_status !== "In production"
        || typeof row.admission_intent_id !== "string" || row.admission_confirmed !== 1) throw new GoogleCredentialError("GOOGLE_CREDENTIAL_RECORD_INVALID");
    return { binding: loaded, revision: row.credential_revision as number, state: row.state as GoogleConnectionState };
  } catch (error) {
    if (error instanceof GoogleCredentialError) throw error;
    throw new GoogleCredentialError("GOOGLE_CREDENTIAL_RECORD_INVALID");
  }
}

/** Request-scoped composition of the real D1 credential/generation authority and REST lease. */
export function createD1GoogleAccessLeaseProvider(options: Omit<GoogleTokenLeaseOptions, "store" | "assertGenerationCurrent"> & {
  readonly database: D1Database;
  readonly generation: ExchangeGeneration;
}) {
  const generation = validateExchangeGeneration(options.generation);
  if (generation.connection_id !== options.binding.connection_id || generation.generation_id !== options.exchangeGenerationId
      || generation.status === "retired") fail("GOOGLE_EXCHANGE_CHANGED");
  const db = options.database.withSession("first-primary");
  return createGoogleAccessLeaseProvider({ ...options, store: createD1GoogleCredentialStore(options.database, options.binding, options.now),
    assertGenerationCurrent: async (signal) => {
      if (signal.aborted) fail("GOOGLE_CREDENTIAL_CANCELLED");
      const raw = await db.prepare(`SELECT generation_id,connection_id,folder_id,spreadsheet_id,sheet_ids_json,protocol_version,state,created_at,retired_at
        FROM exchange_generation WHERE generation_id=?1 AND connection_id=?2 AND length(sheet_ids_json)<=1024
        AND length(folder_id)<=256 AND length(spreadsheet_id)<=256 AND length(protocol_version)<=256
        AND length(created_at)<=64 AND (retired_at IS NULL OR length(retired_at)<=64)`)
        .bind(generation.generation_id, generation.connection_id).first<Record<string, unknown>>().catch(() => fail("GOOGLE_CREDENTIAL_UNAVAILABLE"));
      if (signal.aborted) fail("GOOGLE_CREDENTIAL_CANCELLED");
      if (!raw) return fail("GOOGLE_EXCHANGE_CHANGED");
      let actual;
      try { actual = validateExchangeGeneration({ generation_id: raw.generation_id, connection_id: raw.connection_id,
        folder_id: raw.folder_id, spreadsheet_id: raw.spreadsheet_id, sheet_ids: JSON.parse(raw.sheet_ids_json as string),
        protocol_version: raw.protocol_version, status: raw.state, created_at: raw.created_at,
        ...(raw.retired_at === null ? {} : { retired_at: raw.retired_at }) } as ExchangeGeneration); }
      catch { return fail("GOOGLE_EXCHANGE_CHANGED"); }
      if (JSON.stringify(actual) !== JSON.stringify(generation)) fail("GOOGLE_EXCHANGE_CHANGED");
    },
  });
}
