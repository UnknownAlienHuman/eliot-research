import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createAesGcmTokenVault, createD1ExchangeGenerationRepository, createD1GoogleAuthorizingBootstrapLeaseProvider, importGoogleTokenKey,
  REQUIRED_GOOGLE_SCOPES, type ProvisioningIntent, type GoogleTokenBinding } from "@eliotr/google-drive-exchange";
import type { Env } from "../src/env.js";

const runtime = env as unknown as Env & { CORE_MIGRATIONS: { name: string; queries: string[] }[] };
const db = runtime.CORE_DB;
const suffix = "g4-real-d1";
const input: ProvisioningIntent = { principal_id: `owner-${suffix}`, operation_ref: `operation-${suffix}`, connection_id: `connection-${suffix}`,
  expected_credential_generation: `grant-${suffix}`, expected_credential_revision: 1, created_at: "2026-09-09T00:00:00Z", generation_id: `generation-${suffix}` };

beforeAll(async () => {
  await applyD1Migrations(db, runtime.CORE_MIGRATIONS);
  await db.prepare(`INSERT OR IGNORE INTO google_exchange_connection(connection_id,google_subject,google_email,scopes_json,encrypted_refresh_token,token_nonce,token_key_version,state,created_at,updated_at)
    VALUES (?1,'subject-g4','g4@example.test','[]',zeroblob(16),zeroblob(12),1,'AUTHORIZING',?2,?2)`).bind(input.connection_id,input.created_at).run();
});

describe("G4 generation authority over real local D1", () => {
  it("keeps provisioning durable, seeds the cursor once and activates by expected head", async () => {
    const repo = createD1ExchangeGenerationRepository(db);
    const pending = await repo.begin(input); expect(pending.state).toBe("PENDING");
    const sheets = JSON.stringify({ system: 1, catalog: 2, requests: 3, payload_parts: 4, receipts: 5, results: 6, dashboard: 7 });
    await repo.recordAssets({ intent: input, generation_id: `generation-${suffix}`, folder_id: `folder-${suffix}`, results_folder_id: `results-${suffix}`, spreadsheet_id: `sheet-${suffix}`, sheet_ids_json: sheets });
    await expect(repo.recordAssets({ intent: input, generation_id: "foreign-generation", folder_id: "foreign-folder", results_folder_id: "foreign-results", spreadsheet_id: "foreign-sheet", sheet_ids_json: sheets })).rejects.toThrow("GOOGLE_PROVISIONING_WRITE_UNCONFIRMED");
    await repo.initializeCursor(input.connection_id, "cursor-g4");
    await repo.persistShadow({ generation_id: `generation-${suffix}`, connection_id: input.connection_id, folder_id: `folder-${suffix}`, spreadsheet_id: `sheet-${suffix}`,
      sheet_ids: { system: 1, catalog: 2, requests: 3, payload_parts: 4, receipts: 5, results: 6, dashboard: 7 }, protocol_version: "eliotr.drive.exchange.v1",
      status: "draining", created_at: input.created_at });
    const qualified = await repo.qualify({ intent: input, generation_id: `generation-${suffix}`, start_page_token: "cursor-g4" }); expect(qualified.state).toBe("QUALIFIED");
    await repo.activateShadow(`generation-${suffix}`);
    const active = await db.prepare("SELECT state FROM exchange_generation WHERE generation_id=?1").bind(`generation-${suffix}`).first<{ state: string }>();
    const cursor = await db.prepare("SELECT start_page_token FROM drive_cursor WHERE connection_id=?1").bind(input.connection_id).first<{ start_page_token: string }>();
    expect(active?.state).toBe("active"); expect(cursor?.start_page_token).toBe("cursor-g4");
    expect((await repo.begin(input)).state).toBe("ACTIVATED");
    const nextInput: ProvisioningIntent = { ...input, operation_ref: `${input.operation_ref}-next`, generation_id: `generation-${suffix}-next` };
    await repo.begin(nextInput);
    await repo.recordAssets({ intent: nextInput, generation_id: `generation-${suffix}-next`, folder_id: `folder-${suffix}-next`, results_folder_id: `results-${suffix}-next`, spreadsheet_id: `sheet-${suffix}-next`,
      sheet_ids_json: JSON.stringify({ system: 11, catalog: 12, requests: 13, payload_parts: 14, receipts: 15, results: 16, dashboard: 17 }) });
    await repo.qualify({ intent: nextInput, generation_id: `generation-${suffix}-next`, start_page_token: "cursor-g4-next" });
    await repo.persistShadow({ generation_id: `generation-${suffix}-next`, connection_id: input.connection_id, folder_id: `folder-${suffix}-next`, spreadsheet_id: `sheet-${suffix}-next`,
      sheet_ids: { system: 11, catalog: 12, requests: 13, payload_parts: 14, receipts: 15, results: 16, dashboard: 17 }, protocol_version: "eliotr.drive.exchange.v1",
      status: "draining", created_at: input.created_at });
    await expect(repo.activateShadow(`generation-${suffix}-next`, "wrong-active")).rejects.toThrow("GOOGLE_GENERATION_ACTIVATION_CONFLICT");
    expect((await db.prepare("SELECT state FROM exchange_generation WHERE generation_id=?1").bind(`generation-${suffix}`).first<{ state: string }>())?.state).toBe("active");
    await repo.activateShadow(`generation-${suffix}-next`, `generation-${suffix}`);
    expect((await db.prepare("SELECT state FROM exchange_generation WHERE generation_id=?1").bind(`generation-${suffix}-next`).first<{ state: string }>())?.state).toBe("active");
    await repo.persistShadow({ generation_id: `generation-${suffix}-unqualified`, connection_id: input.connection_id, folder_id: `folder-${suffix}-unqualified`, spreadsheet_id: `sheet-${suffix}-unqualified`,
      sheet_ids: { system: 21, catalog: 22, requests: 23, payload_parts: 24, receipts: 25, results: 26, dashboard: 27 }, protocol_version: "eliotr.drive.exchange.v1",
      status: "draining", created_at: input.created_at });
    await expect(repo.activateShadow(`generation-${suffix}-unqualified`, `generation-${suffix}-next`)).rejects.toThrow("GOOGLE_GENERATION_ACTIVATION_CONFLICT");
    expect((await db.prepare("SELECT state FROM exchange_generation WHERE generation_id=?1").bind(`generation-${suffix}-next`).first<{ state: string }>())?.state).toBe("active");
    const uncertain: ProvisioningIntent = { ...input, operation_ref: `${input.operation_ref}-uncertain`, generation_id: `generation-${suffix}-uncertain` };
    await repo.begin(uncertain);
    const claims = await Promise.allSettled([repo.markCreateAttempt(uncertain, "folder"), repo.markCreateAttempt(uncertain, "folder")]);
    expect(claims.filter((claim) => claim.status === "fulfilled")).toHaveLength(1);
    expect(claims.filter((claim) => claim.status === "rejected")).toHaveLength(1);
  });

  it("refreshes an admitted AUTHORIZING credential through the server-owned D1 lease", async () => {
    const binding: GoogleTokenBinding = { connection_id: `connection-${suffix}-bootstrap`, principal_id: `owner-${suffix}-bootstrap`, oauth_client_id: "g4.apps.googleusercontent.com",
      google_subject: "subject-g4-bootstrap", google_email: "g4-bootstrap@example.test", credential_generation: "grant-g4-bootstrap" };
    const key = await importGoogleTokenKey(crypto.getRandomValues(new Uint8Array(32))); const keys = new Map([[1, key]]);
    const vault = createAesGcmTokenVault({ binding, activeKeyVersion: 1, keys }); const encrypted = await vault.encrypt("refresh-g4");
    await db.prepare(`INSERT OR REPLACE INTO google_exchange_connection(connection_id,google_subject,google_email,scopes_json,encrypted_refresh_token,token_nonce,token_key_version,state,created_at,updated_at,principal_id,oauth_client_id,credential_generation,credential_revision,oauth_publishing_status)
      VALUES (?1,?2,?3,?4,?5,?6,1,'AUTHORIZING',?7,?7,?8,?9,?10,1,'In production')`).bind(binding.connection_id,binding.google_subject,binding.google_email,
      JSON.stringify(REQUIRED_GOOGLE_SCOPES),encrypted.ciphertext,encrypted.nonce,input.created_at,binding.principal_id,binding.oauth_client_id,binding.credential_generation).run();
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ access_token: "bootstrap-access", token_type: "Bearer", expires_in: 3600 }));
    const authorize = createD1GoogleAuthorizingBootstrapLeaseProvider({ database: db, binding, exchangeGenerationId: "exchange-g4-bootstrap", expectedCredentialRevision: 1,
      clientSecret: "client-secret", activeKeyVersion: 1, keys, deadlineEpochMs: Date.now() + 60000, assertOwnerCurrent: async () => {}, fetchImpl });
    const lease = await authorize(new AbortController().signal); expect(lease.access_token).toBe("bootstrap-access"); expect(lease.exchange_generation_id).toBe("exchange-g4-bootstrap");
    expect(fetchImpl).toHaveBeenCalledOnce();
    await db.prepare("UPDATE google_exchange_connection SET refresh_expires_at_epoch_ms=?1 WHERE connection_id=?2").bind(Date.now() - 1, binding.connection_id).run();
    const expired = createD1GoogleAuthorizingBootstrapLeaseProvider({ database: db, binding, exchangeGenerationId: "exchange-g4-bootstrap", expectedCredentialRevision: 1,
      clientSecret: "client-secret", activeKeyVersion: 1, keys, deadlineEpochMs: Date.now() + 60000, assertOwnerCurrent: async () => {}, fetchImpl });
    await expect(expired(new AbortController().signal)).rejects.toThrow("GOOGLE_BOOTSTRAP_EXPIRED");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
