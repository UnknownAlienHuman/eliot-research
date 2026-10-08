import type { D1Database } from "@cloudflare/workers-types";
import type { GoogleOAuthConfiguration } from "./oauth-types.js";
import { GoogleCredentialError, tokenBinding } from "./token-vault.js";
import { createD1GoogleCredentialStore } from "./google-token-store.js";

export interface GoogleConnectionDisconnectResult {
  readonly protocol: "eliotr.google-oauth-disconnect.v1";
  readonly connection_id: string;
  readonly credential_generation: string | null;
  readonly credential_revision: number | null;
  readonly state: "REVOKED" | null;
}

export type GoogleConnectionDisconnectOutcome =
  | { readonly ok: true; readonly result: GoogleConnectionDisconnectResult }
  | { readonly ok: false; readonly phase: "receipt" | "revoke"; readonly error: GoogleCredentialError };

export interface GoogleConnectionDisconnectApplicationInput {
  readonly database: D1Database;
  readonly configuration: GoogleOAuthConfiguration;
  readonly principal_id: string;
  readonly operation_ref: string;
  readonly expected_credential_generation: string;
  readonly expected_credential_revision: number;
  readonly signal: AbortSignal;
  readonly assert_owner_current: () => Promise<void>;
}

interface DisconnectReceipt {
  readonly expected_credential_generation: string;
  readonly expected_credential_revision: number;
  readonly result_credential_generation: string | null;
  readonly result_credential_revision: number | null;
  readonly result_state: "REVOKED" | null;
}

/** Idempotently records the disconnect intent, then CAS-revokes and verifies both durable rows. */
export async function disconnectGoogleConnectionApplication(
  input: GoogleConnectionDisconnectApplicationInput,
): Promise<GoogleConnectionDisconnectOutcome> {
  const { configuration } = input;
  const configurationJson = JSON.stringify(configuration);
  const receiptKey = { principal_id: input.principal_id, operation_ref: input.operation_ref };

  const readReceipt = async (): Promise<DisconnectReceipt | null> => {
    const row = await input.database.prepare(`SELECT expected_credential_generation,expected_credential_revision,result_credential_generation,
      result_credential_revision,result_state,connection_id,configuration_json FROM google_oauth_disconnect_receipt
      WHERE principal_id=?1 AND operation_ref=?2`).bind(receiptKey.principal_id, receiptKey.operation_ref).first<Record<string, unknown>>()
      .catch(() => { throw new GoogleCredentialError("GOOGLE_CREDENTIAL_UNAVAILABLE"); });
    if (!row) return null;
    if (row.connection_id !== configuration.connection_id || row.configuration_json !== configurationJson
        || typeof row.expected_credential_generation !== "string" || typeof row.expected_credential_revision !== "number"
        || !Number.isSafeInteger(row.expected_credential_revision) || row.expected_credential_revision < 1
        || (row.result_credential_generation !== null && typeof row.result_credential_generation !== "string")
        || (row.result_credential_revision !== null && typeof row.result_credential_revision !== "number")
        || (row.result_state !== null && row.result_state !== "REVOKED")) {
      throw new GoogleCredentialError("GOOGLE_CREDENTIAL_CHANGED");
    }
    return {
      expected_credential_generation: row.expected_credential_generation,
      expected_credential_revision: row.expected_credential_revision,
      result_credential_generation: row.result_credential_generation as string | null,
      result_credential_revision: row.result_credential_revision as number | null,
      result_state: row.result_state as "REVOKED" | null,
    };
  };
  const result = (receipt: DisconnectReceipt): GoogleConnectionDisconnectResult => ({
    protocol: "eliotr.google-oauth-disconnect.v1",
    connection_id: configuration.connection_id,
    credential_generation: receipt.result_credential_generation,
    credential_revision: receipt.result_credential_revision,
    state: receipt.result_state,
  });

  let receipt: DisconnectReceipt;
  try {
    await input.database.prepare(`INSERT OR IGNORE INTO google_oauth_disconnect_receipt
      (principal_id,operation_ref,connection_id,configuration_json,expected_credential_generation,expected_credential_revision,created_at)
      VALUES(?1,?2,?3,?4,?5,?6,?7)`).bind(receiptKey.principal_id, receiptKey.operation_ref, configuration.connection_id,
      configurationJson, input.expected_credential_generation, input.expected_credential_revision, new Date().toISOString()).run();
    const loaded = await readReceipt();
    if (loaded === null || loaded.expected_credential_generation !== input.expected_credential_generation ||
        loaded.expected_credential_revision !== input.expected_credential_revision) {
      throw new GoogleCredentialError("GOOGLE_CREDENTIAL_CHANGED");
    }
    receipt = loaded;
  } catch (error) {
    if (error instanceof GoogleCredentialError) return { ok: false, phase: "receipt", error };
    throw error;
  }

  // Keep this guard outside either error-mapping phase, matching the HTTP handler's original boundary.
  if (receipt.result_state !== null) {
    await input.assert_owner_current();
    return { ok: true, result: result(receipt) };
  }

  const binding = tokenBinding({ connection_id: configuration.connection_id, principal_id: input.principal_id,
    oauth_client_id: configuration.oauth_client_id, google_subject: configuration.google_subject,
    google_email: configuration.google_email, credential_generation: input.expected_credential_generation });
  const store = createD1GoogleCredentialStore(input.database, binding);
  try {
    const current = await store.load(input.signal);
    if (current.revision !== input.expected_credential_revision ||
        current.binding.credential_generation !== input.expected_credential_generation || store.revoke === undefined) {
      if (current.revision === input.expected_credential_revision + 1 &&
          current.binding.credential_generation === input.expected_credential_generation && current.state === "REVOKED") {
        const settled = await readReceipt();
        if (settled?.result_state === "REVOKED") {
          await input.assert_owner_current();
          return { ok: true, result: result(settled) };
        }
      }
      throw new GoogleCredentialError("GOOGLE_CREDENTIAL_CHANGED");
    }
    if (store.revokeWithDisconnectReceipt === undefined) {
      throw new GoogleCredentialError("GOOGLE_CREDENTIAL_WRITE_UNCONFIRMED");
    }
    await store.revokeWithDisconnectReceipt(current, {
      principal_id: receiptKey.principal_id,
      operation_ref: receiptKey.operation_ref,
      connection_id: configuration.connection_id,
      configuration_json: configurationJson,
      expected_credential_generation: input.expected_credential_generation,
      expected_credential_revision: input.expected_credential_revision,
    }, input.signal);
    const settled = await readReceipt();
    if (settled?.result_state !== "REVOKED") {
      throw new GoogleCredentialError("GOOGLE_CREDENTIAL_WRITE_UNCONFIRMED");
    }
    receipt = settled;
    await input.assert_owner_current();
    return { ok: true, result: result(receipt) };
  } catch (error) {
    if (error instanceof GoogleCredentialError) return { ok: false, phase: "revoke", error };
    throw error;
  }
}
