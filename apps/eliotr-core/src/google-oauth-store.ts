import { GoogleCredentialError, credentialSnapshot, intentBinding, oauthClock, oauthConfiguration, oauthDigest, oauthFail, oauthIdentifier, oauthOwner,
  sameGoogleCredentials, validateOAuthIntent, type GoogleCredentialSnapshot, type GoogleOAuthConfiguration,
  type GoogleOAuthIntent, type GoogleOAuthIntentStore, type GoogleOAuthOwner } from "@eliotr/google-drive-exchange";
import { createD1GoogleCredentialStore } from "./google-token-store.js";
const SCHEMA = `EXISTS (SELECT 1 FROM schema_state WHERE key='google_oauth_intents_generation' AND value='google-oauth-intents-v1')
  AND EXISTS (SELECT 1 FROM schema_state WHERE key='google_credentials_generation' AND value='google-credentials-v1')`;
const COLUMNS = `intent_id,operation_ref,principal_id,session_generation,configuration_json,state_sha256,encrypted_secrets,
  secret_nonce,secret_key_version,created_at_epoch_ms,expires_at_epoch_ms,state,attempt_id,code_sha256,id_token_sha256,credential_sha256`;
function bytes(value: unknown): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (Array.isArray(value) && value.length <= 4112 && value.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) return new Uint8Array(value);
  return oauthFail("GOOGLE_OAUTH_INTENT_INVALID");
}
function comparable(intent: GoogleOAuthIntent): string {
  const value = validateOAuthIntent(intent);
  return JSON.stringify({ ...value, secrets: { ...value.secrets, ciphertext: Array.from(value.secrets.ciphertext), nonce: Array.from(value.secrets.nonce) } });
}
function credentialDigest(row: GoogleCredentialSnapshot): Promise<string> {
  const value = credentialSnapshot(row);
  return oauthDigest(JSON.stringify({ ...value, token: { ...value.token, ciphertext: Array.from(value.token.ciphertext), nonce: Array.from(value.token.nonce) } }));
}
/** Trusted owner/configuration inputs must come from the authenticated owner transport and operator config. */
export function createD1GoogleOAuthIntentStore(database: D1Database, config: GoogleOAuthConfiguration,
  actor: GoogleOAuthOwner, now: () => number = Date.now,
  lifecycle: { readonly expected_generation: string; readonly expected_revision: number } | "auto" | undefined = undefined): GoogleOAuthIntentStore {
  const configuration = oauthConfiguration(config); const owner = oauthOwner(actor);
  const serialized = JSON.stringify(configuration); const db = database.withSession("first-primary");
  const check = (signal: AbortSignal) => { if (signal.aborted) oauthFail("GOOGLE_OAUTH_CANCELLED"); };
  const scope = (input: GoogleOAuthIntent): GoogleOAuthIntent => {
    const intent = validateOAuthIntent(input);
    if (JSON.stringify(intent.configuration) !== serialized || JSON.stringify(intent.owner) !== JSON.stringify(owner)) return oauthFail("GOOGLE_OAUTH_INTENT_UNAVAILABLE");
    return intent;
  };
  const load = async (column: "operation_ref" | "state_sha256", value: string, signal: AbortSignal) => {
    check(signal);
    const row = await db.prepare(`SELECT ${COLUMNS} FROM google_oauth_intent WHERE ${column}=?1
      AND principal_id=?2 AND session_generation=?3 AND configuration_json=?4 AND ${SCHEMA}
      AND length(configuration_json)<=4096 AND length(encrypted_secrets)<=4112 AND length(secret_nonce)=12`)
      .bind(value, owner.principal_id, owner.session_generation, serialized).first<Record<string, unknown>>()
      .catch(() => oauthFail("GOOGLE_OAUTH_STORE_UNAVAILABLE"));
    check(signal); if (!row) return oauthFail("GOOGLE_OAUTH_INTENT_UNAVAILABLE");
    try {
      return scope({ intent_id: row.intent_id as string, operation_ref: row.operation_ref as string,
        owner: { principal_id: row.principal_id as string, session_generation: row.session_generation as string },
        configuration: JSON.parse(row.configuration_json as string), state_sha256: row.state_sha256 as string,
        secrets: { ciphertext: bytes(row.encrypted_secrets), nonce: bytes(row.secret_nonce), key_version: row.secret_key_version as number },
        created_at_epoch_ms: row.created_at_epoch_ms as number, expires_at_epoch_ms: row.expires_at_epoch_ms as number,
        status: row.state as GoogleOAuthIntent["status"], attempt_id: row.attempt_id as string | null,
        code_sha256: row.code_sha256 as string | null, id_token_sha256: row.id_token_sha256 as string | null, credential_sha256: row.credential_sha256 as string | null });
    } catch { return oauthFail("GOOGLE_OAUTH_INTENT_INVALID"); }
  };
  const find = (hash: string, signal: AbortSignal) => {
    if (!/^[a-f0-9]{64}$/u.test(hash)) return Promise.reject(new GoogleCredentialError("GOOGLE_OAUTH_INPUT_INVALID"));
    return load("state_sha256", hash, signal);
  };
  const fresh = (intent: GoogleOAuthIntent, signal: AbortSignal) => {
    check(signal); if (oauthClock(now) >= intent.expires_at_epoch_ms) return oauthFail("GOOGLE_OAUTH_INTENT_EXPIRED");
  };
  const assertClaim = async (input: GoogleOAuthIntent, signal: AbortSignal) => {
    const intent = scope(input); fresh(intent, signal);
    if (intent.status !== "EXCHANGING" || comparable(await find(intent.state_sha256, signal)) !== comparable(intent)) return oauthFail("GOOGLE_OAUTH_CLAIM_CHANGED");
    fresh(intent, signal);
  };
  const activeClaimSql = `intent_id=?1 AND principal_id=?2 AND session_generation=?3 AND configuration_json=?4
    AND state='EXCHANGING' AND attempt_id=?5 AND code_sha256=?6 AND expires_at_epoch_ms>?7 AND ${SCHEMA}`;
  const claimValues = (intent: GoogleOAuthIntent) => [intent.intent_id, owner.principal_id, owner.session_generation, serialized,
    intent.attempt_id, intent.code_sha256, oauthClock(now)];
  return {
    find, assertClaim,
    async put(raw, signal) {
      const intent = scope(raw); fresh(intent, signal);
      if (intent.status !== "PENDING") return oauthFail("GOOGLE_OAUTH_INTENT_INVALID");
      try {
        if (lifecycle !== undefined && lifecycle !== "auto") {
          if (!oauthIdentifier(lifecycle.expected_generation) || !Number.isSafeInteger(lifecycle.expected_revision) || lifecycle.expected_revision < 1) return oauthFail("GOOGLE_OAUTH_INPUT_INVALID");
          const result = await db.batch([
            db.prepare(`INSERT INTO google_oauth_intent(${COLUMNS}) SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'PENDING',NULL,NULL,NULL,NULL
              WHERE ${SCHEMA} AND EXISTS (SELECT 1 FROM google_exchange_connection c WHERE c.connection_id=?12
                AND c.principal_id=?3 AND c.oauth_client_id=?15 AND c.google_subject=?16 AND c.google_email=?17
                AND c.credential_generation=?13 AND c.credential_revision=?14 AND c.oauth_publishing_status='In production')
              AND (SELECT count(*) FROM google_oauth_intent WHERE principal_id=?3 AND state='PENDING' AND expires_at_epoch_ms>?10)<16
              ON CONFLICT DO NOTHING`).bind(intent.intent_id, intent.operation_ref, owner.principal_id, owner.session_generation, serialized,
              intent.state_sha256, new Uint8Array(intent.secrets.ciphertext).buffer, new Uint8Array(intent.secrets.nonce).buffer,
              intent.secrets.key_version, intent.created_at_epoch_ms, intent.expires_at_epoch_ms, configuration.connection_id,
              lifecycle.expected_generation, lifecycle.expected_revision, configuration.oauth_client_id, configuration.google_subject, configuration.google_email),
            db.prepare(`INSERT INTO google_oauth_reconnect_intent(intent_id,connection_id,expected_credential_generation,expected_credential_revision,created_at)
              VALUES(?1,?2,?3,?4,?5) ON CONFLICT(intent_id) DO NOTHING`).bind(intent.intent_id, configuration.connection_id,
              lifecycle.expected_generation, lifecycle.expected_revision, new Date(intent.created_at_epoch_ms).toISOString()),
          ]);
          void result;
        } else {
        await db.prepare(`INSERT INTO google_oauth_intent(${COLUMNS}) SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'PENDING',NULL,NULL,NULL,NULL
          WHERE ${SCHEMA} AND NOT EXISTS(SELECT 1 FROM google_exchange_connection WHERE connection_id=?12)
          AND (SELECT count(*) FROM google_oauth_intent WHERE principal_id=?3 AND state='PENDING' AND expires_at_epoch_ms>?10)<16
          ON CONFLICT DO NOTHING`).bind(intent.intent_id, intent.operation_ref, owner.principal_id, owner.session_generation, serialized,
          intent.state_sha256, new Uint8Array(intent.secrets.ciphertext).buffer, new Uint8Array(intent.secrets.nonce).buffer,
          intent.secrets.key_version, intent.created_at_epoch_ms, intent.expires_at_epoch_ms, configuration.connection_id).run();
        }
      } catch { /* Read existing exact operation after a lost ACK; no new intent or retry. */ }
      const actual = await load("operation_ref", intent.operation_ref, signal); fresh(actual, signal); return actual;
    },
    async claim(raw, attemptId, codeHash, signal) {
      const intent = scope(raw); fresh(intent, signal); oauthIdentifier(attemptId);
      if (intent.status !== "PENDING" || !/^[a-f0-9]{64}$/u.test(codeHash)) return oauthFail("GOOGLE_OAUTH_INTENT_INVALID");
      const next = scope({ ...intent, status: "EXCHANGING", attempt_id: attemptId, code_sha256: codeHash });
      try {
        await db.prepare(`UPDATE google_oauth_intent SET state='EXCHANGING',attempt_id=?1,code_sha256=?2 WHERE intent_id=?3
          AND principal_id=?4 AND session_generation=?5 AND configuration_json=?6 AND state='PENDING' AND expires_at_epoch_ms>?7
          AND ${SCHEMA} ${lifecycle === undefined ? "AND NOT EXISTS(SELECT 1 FROM google_exchange_connection WHERE connection_id=?8)" : ""}`)
          .bind(attemptId, codeHash, intent.intent_id, owner.principal_id, owner.session_generation, serialized,
            oauthClock(now), ...(lifecycle === undefined ? [configuration.connection_id] : [])).run();
      } catch { /* Only the exact attempt owner may continue after readback. */ }
      const actual = await find(intent.state_sha256, signal);
      if (comparable(actual) !== comparable(next)) return oauthFail("GOOGLE_OAUTH_ALREADY_ATTEMPTED");
      fresh(actual, signal); return actual;
    },
    async deny(raw, signal) {
      const intent = scope(raw); fresh(intent, signal);
      if (intent.status !== "PENDING") return oauthFail("GOOGLE_OAUTH_ALREADY_ATTEMPTED");
      try {
        await db.prepare(`UPDATE google_oauth_intent SET state='DENIED' WHERE intent_id=?1 AND principal_id=?2 AND session_generation=?3
          AND configuration_json=?4 AND state='PENDING' AND expires_at_epoch_ms>?5 AND ${SCHEMA}`)
          .bind(intent.intent_id, owner.principal_id, owner.session_generation, serialized, oauthClock(now)).run();
      } catch { /* A denied callback never sends a Google request. */ }
      const actual = await find(intent.state_sha256, signal);
      if (comparable(actual) !== comparable({ ...intent, status: "DENIED" })) return oauthFail("GOOGLE_OAUTH_ALREADY_ATTEMPTED");
    },
    async admit(raw, nextCredential, idTokenHash, signal) {
      const intent = scope(raw); const credential = credentialSnapshot(nextCredential); await assertClaim(intent, signal);
      const reconnect = await readReconnect(intent.intent_id, signal);
      const expectedRevision = reconnect?.expected_revision ?? 0;
      if (JSON.stringify(credential.binding) !== JSON.stringify(intentBinding(intent, "grant")) || credential.revision !== (reconnect === null ? 1 : expectedRevision + 1)
          || credential.state !== "AUTHORIZING" || !/^[a-f0-9]{64}$/u.test(idTokenHash)
          || (credential.refresh_expires_at_epoch_ms !== null && credential.refresh_expires_at_epoch_ms <= oauthClock(now))) return oauthFail("GOOGLE_OAUTH_ADMISSION_INVALID");
      const b = credential.binding; const time = new Date(oauthClock(now)).toISOString();
      const token = credential.token; const credentialHash = await credentialDigest(credential); fresh(intent, signal); const values = claimValues(intent);
      if (reconnect !== null) {
        const update = db.prepare(`UPDATE google_exchange_connection SET google_subject=?1,google_email=?2,scopes_json=?3,
          encrypted_refresh_token=?4,token_nonce=?5,token_key_version=?6,state='AUTHORIZING',updated_at=?7,oauth_client_id=?8,
          credential_generation=?9,credential_revision=?10,oauth_publishing_status='In production',refresh_expires_at_epoch_ms=?11,admission_intent_id=?12
          WHERE connection_id=?13 AND principal_id=?14 AND oauth_client_id=?8 AND google_subject=?15 AND google_email=?16
            AND credential_generation=?17 AND credential_revision=?18 AND state IN ('ACTIVE','DEGRADED','REAUTH_REQUIRED','REVOKED','DISCONNECTED','AUTHORIZING')
            AND ${SCHEMA}`)
          .bind(b.google_subject, b.google_email, JSON.stringify(credential.granted_scopes), new Uint8Array(token.ciphertext).buffer,
            new Uint8Array(token.nonce).buffer, token.key_version, time, b.oauth_client_id, b.credential_generation, credential.revision,
            credential.refresh_expires_at_epoch_ms, intent.intent_id, b.connection_id, owner.principal_id, reconnect.current_subject,
            reconnect.current_email, reconnect.expected_generation, reconnect.expected_revision);
        const completeReconnect = db.prepare(`UPDATE google_oauth_intent SET state='ADMITTED',id_token_sha256=?8,credential_sha256=?9
          WHERE ${activeClaimSql} AND EXISTS(SELECT 1 FROM google_exchange_connection c WHERE c.connection_id=?10
            AND c.admission_intent_id=?11 AND c.credential_generation=?12 AND c.credential_revision=?13 AND c.state='AUTHORIZING')`)
          .bind(...values, idTokenHash, credentialHash, b.connection_id, intent.intent_id, b.credential_generation, credential.revision);
        check(signal); try { await db.batch([update, completeReconnect]); } catch { /* Reconcile below. */ }
      } else {
      const insert = db.prepare(`INSERT INTO google_exchange_connection(connection_id,google_subject,google_email,scopes_json,
        encrypted_refresh_token,token_nonce,token_key_version,state,created_at,updated_at,principal_id,oauth_client_id,
        credential_generation,credential_revision,oauth_publishing_status,refresh_expires_at_epoch_ms,admission_intent_id)
        SELECT ?8,?9,?10,?11,?12,?13,?14,'AUTHORIZING',?15,?15,?2,?16,?17,1,'In production',?18,?1
        FROM google_oauth_intent WHERE ${activeClaimSql} ON CONFLICT(connection_id) DO NOTHING`)
        .bind(...values, b.connection_id, b.google_subject, b.google_email, JSON.stringify(credential.granted_scopes),
          new Uint8Array(token.ciphertext).buffer, new Uint8Array(token.nonce).buffer, token.key_version, time,
          b.oauth_client_id, b.credential_generation, credential.refresh_expires_at_epoch_ms);
      const complete = db.prepare(`UPDATE google_oauth_intent SET state='ADMITTED',id_token_sha256=?8,credential_sha256=?14 WHERE ${activeClaimSql}
        AND EXISTS(SELECT 1 FROM google_exchange_connection c WHERE c.connection_id=?9 AND c.admission_intent_id=?1
          AND c.principal_id=?2 AND c.credential_generation=?10 AND c.credential_revision=1 AND c.state='AUTHORIZING'
          AND c.encrypted_refresh_token=?11 AND c.token_nonce=?12 AND c.token_key_version=?13)`)
        .bind(...values, idTokenHash, b.connection_id, b.credential_generation,
          new Uint8Array(token.ciphertext).buffer, new Uint8Array(token.nonce).buffer, token.key_version, credentialHash);
      check(signal);
      try { await db.batch([insert, complete]); }
      catch { /* Atomic batch may have committed. Never repeat the token POST or overwrite an existing connection. */ }
      }
      const actual = await find(intent.state_sha256, signal);
      const stored = await createD1GoogleCredentialStore(database, b, now).load(signal);
      if (comparable(actual) !== comparable({ ...intent, status: "ADMITTED", id_token_sha256: idTokenHash, credential_sha256: credentialHash })
          || !sameGoogleCredentials(stored, credential)) return oauthFail("GOOGLE_OAUTH_ADMISSION_UNCONFIRMED");
      fresh(intent, signal);
    },
    async readAdmission(raw, signal) {
      const intent = scope(raw); fresh(intent, signal);
      const actual = await find(intent.state_sha256, signal);
      if (intent.status !== "ADMITTED" || comparable(actual) !== comparable(intent)) return oauthFail("GOOGLE_OAUTH_ADMISSION_UNCONFIRMED");
      const binding = intentBinding(intent, "grant");
      const stored = await createD1GoogleCredentialStore(database, binding, now).load(signal);
      const reconnect = await readReconnect(intent.intent_id, signal);
      if (stored.state !== "AUTHORIZING" || stored.revision !== (reconnect?.expected_revision ?? 0) + 1 || await credentialDigest(stored) !== intent.credential_sha256
          || (stored.refresh_expires_at_epoch_ms !== null && stored.refresh_expires_at_epoch_ms <= oauthClock(now))) return oauthFail("GOOGLE_OAUTH_ADMISSION_UNCONFIRMED");
      fresh(intent, signal);
      return { protocol: "eliotr.google-oauth-admission.v1", intent_id: intent.intent_id, connection_id: binding.connection_id,
        credential_generation: binding.credential_generation, connector_state: "AUTHORIZING", exchange_ready: false };
    },
    expectedCredentialRevision: async (intent, signal) => (await readReconnect(intent.intent_id, signal))?.expected_revision ?? null,
  };

  async function readReconnect(intentId: string, signal: AbortSignal): Promise<null | { readonly expected_generation: string; readonly expected_revision: number; readonly current_subject: string; readonly current_email: string }> {
    check(signal);
    const row = await db.prepare(`SELECT r.expected_credential_generation,r.expected_credential_revision,c.google_subject,c.google_email
      FROM google_oauth_reconnect_intent r JOIN google_exchange_connection c ON c.connection_id=r.connection_id
      WHERE r.intent_id=?1 AND r.connection_id=?2 AND ${SCHEMA}`).bind(intentId, configuration.connection_id)
      .first<Record<string, unknown>>().catch(() => oauthFail("GOOGLE_OAUTH_STORE_UNAVAILABLE"));
    check(signal);
    if (!row) return null;
    const revision = row.expected_credential_revision;
    if (typeof row.expected_credential_generation !== "string" || typeof revision !== "number" || !Number.isSafeInteger(revision)
        || revision < 1 || typeof row.google_subject !== "string" || typeof row.google_email !== "string") return oauthFail("GOOGLE_OAUTH_INTENT_INVALID");
    return { expected_generation: row.expected_credential_generation, expected_revision: revision,
      current_subject: row.google_subject, current_email: row.google_email };
  }
}

/** Bounded cleanup of obsolete OAuth proof rows; only non-admitted terminal
 * intents are deleted and a digest-only receipt is retained. */
export async function cleanupExpiredGoogleOAuthIntents(database: D1Database, now: () => number = Date.now, limit = 32): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32) throw new GoogleCredentialError("GOOGLE_OAUTH_INPUT_INVALID");
  const time = now(); if (!Number.isSafeInteger(time) || time < 0) throw new GoogleCredentialError("GOOGLE_CLOCK_INVALID");
  const db = database.withSession("first-primary");
  const rows = await db.prepare(`SELECT intent_id,operation_ref,state_sha256,state FROM google_oauth_intent
    WHERE expires_at_epoch_ms<=?1 AND state IN ('PENDING','DENIED','FAILED') ORDER BY expires_at_epoch_ms,intent_id LIMIT ?2`)
    .bind(time, limit).all<Record<string, unknown>>().catch(() => oauthFail("GOOGLE_OAUTH_STORE_UNAVAILABLE"));
  const statements: D1PreparedStatement[] = [];
  for (const row of rows.results) {
    if (typeof row.intent_id !== "string" || typeof row.operation_ref !== "string" || typeof row.state_sha256 !== "string"
        || typeof row.state !== "string" || !["PENDING", "DENIED", "FAILED"].includes(row.state)) continue;
    const terminal = row.state === "PENDING" ? "EXPIRED" : row.state;
    const timestamp = new Date(time).toISOString();
    statements.push(db.prepare(`INSERT OR IGNORE INTO google_oauth_intent_receipt(intent_id,operation_ref,state_sha256,terminal_state,terminal_at,retained_at)
      VALUES(?1,?2,?3,?4,?5,?5)`).bind(row.intent_id, row.operation_ref, row.state_sha256, terminal, timestamp));
    statements.push(db.prepare("DELETE FROM google_oauth_reconnect_intent WHERE intent_id=?1").bind(row.intent_id));
    statements.push(db.prepare(`DELETE FROM google_oauth_intent WHERE intent_id=?1 AND expires_at_epoch_ms<=?2 AND state IN ('PENDING','DENIED','FAILED')`)
      .bind(row.intent_id, time));
  }
  if (statements.length > 0) await db.batch(statements).catch(() => oauthFail("GOOGLE_OAUTH_STORE_UNAVAILABLE"));
  return Math.floor(statements.length / 3);
}
