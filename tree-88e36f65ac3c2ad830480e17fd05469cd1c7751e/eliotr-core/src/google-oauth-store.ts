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
  actor: GoogleOAuthOwner, now: () => number = Date.now): GoogleOAuthIntentStore {
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
        await db.prepare(`INSERT INTO google_oauth_intent(${COLUMNS}) SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'PENDING',NULL,NULL,NULL,NULL
          WHERE ${SCHEMA} AND NOT EXISTS(SELECT 1 FROM google_exchange_connection WHERE connection_id=?12)
          AND (SELECT count(*) FROM google_oauth_intent WHERE principal_id=?3 AND state='PENDING' AND expires_at_epoch_ms>?10)<16
          ON CONFLICT DO NOTHING`).bind(intent.intent_id, intent.operation_ref, owner.principal_id, owner.session_generation, serialized,
          intent.state_sha256, new Uint8Array(intent.secrets.ciphertext).buffer, new Uint8Array(intent.secrets.nonce).buffer,
          intent.secrets.key_version, intent.created_at_epoch_ms, intent.expires_at_epoch_ms, configuration.connection_id).run();
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
          AND ${SCHEMA} AND NOT EXISTS(SELECT 1 FROM google_exchange_connection WHERE connection_id=?8)`)
          .bind(attemptId, codeHash, intent.intent_id, owner.principal_id, owner.session_generation, serialized,
            oauthClock(now), configuration.connection_id).run();
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
      if (JSON.stringify(credential.binding) !== JSON.stringify(intentBinding(intent, "grant")) || credential.revision !== 1
          || credential.state !== "AUTHORIZING" || !/^[a-f0-9]{64}$/u.test(idTokenHash)
          || (credential.refresh_expires_at_epoch_ms !== null && credential.refresh_expires_at_epoch_ms <= oauthClock(now))) return oauthFail("GOOGLE_OAUTH_ADMISSION_INVALID");
      const b = credential.binding; const time = new Date(oauthClock(now)).toISOString();
      const token = credential.token; const credentialHash = await credentialDigest(credential); fresh(intent, signal); const values = claimValues(intent);
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
      if (stored.state !== "AUTHORIZING" || stored.revision !== 1 || await credentialDigest(stored) !== intent.credential_sha256
          || (stored.refresh_expires_at_epoch_ms !== null && stored.refresh_expires_at_epoch_ms <= oauthClock(now))) return oauthFail("GOOGLE_OAUTH_ADMISSION_UNCONFIRMED");
      fresh(intent, signal);
      return { protocol: "eliotr.google-oauth-admission.v1", intent_id: intent.intent_id, connection_id: binding.connection_id,
        credential_generation: binding.credential_generation, connector_state: "AUTHORIZING", exchange_ready: false };
    },
  };
}
