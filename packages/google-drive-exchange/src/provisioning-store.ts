import type { D1Database } from "@cloudflare/workers-types";
import type { ExchangeGeneration } from "@eliotr/contracts";
import { validateExchangeGeneration } from "./serializer.js";
import type { ExchangeGenerationRepository } from "./provisioner.js";

export interface ProvisioningIntent {
  readonly principal_id: string;
  readonly operation_ref: string;
  readonly connection_id: string;
  readonly expected_credential_generation: string;
  readonly expected_credential_revision: number;
  readonly created_at: string;
  /** Allocated before the external lease so retries cannot silently choose another resource identity. */
  readonly generation_id?: string;
}

export interface ProvisioningRecord extends ProvisioningIntent {
  readonly state: "PENDING" | "QUALIFIED" | "ACTIVATED" | "FAILED";
  readonly folder_id?: string;
  readonly results_folder_id?: string;
  readonly spreadsheet_id?: string;
  readonly sheet_ids_json?: string;
  readonly start_page_token?: string;
  readonly generation_id?: string;
  readonly failure_code?: string;
  /** Exact durable ownership of an in-flight external create. */
  readonly create_attempt_id?: string;
  readonly create_attempt_purpose?: "folder" | "results" | "spreadsheet";
}

export interface ExchangeProvisioningIntentStore {
  begin(input: ProvisioningIntent): Promise<ProvisioningRecord>;
  markCreateAttempt(input: ProvisioningIntent, purpose: "folder" | "results" | "spreadsheet"): Promise<ProvisioningRecord>;
  clearCreateAttempt(input: ProvisioningIntent, purpose: "folder" | "results" | "spreadsheet", attemptId: string): Promise<ProvisioningRecord>;
  recordAssets(input: { readonly intent: ProvisioningIntent; readonly generation_id: string; readonly folder_id: string; readonly results_folder_id: string; readonly spreadsheet_id: string; readonly sheet_ids_json: string }): Promise<ProvisioningRecord>;
  qualify(input: { readonly intent: ProvisioningIntent; readonly generation_id: string; readonly start_page_token: string }): Promise<ProvisioningRecord>;
  read(input: Pick<ProvisioningIntent, "principal_id" | "operation_ref">): Promise<ProvisioningRecord | null>;
}

export interface ExchangeGenerationD1Repository extends ExchangeGenerationRepository, ExchangeProvisioningIntentStore {
  initializeCursor(connectionId: string, startPageToken: string): Promise<string>;
}

function validText(value: unknown, code: string, max = 256): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(code);
  return value;
}
function validRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error("GOOGLE_PROVISIONING_REVISION_INVALID");
  return value as number;
}
function row(value: Record<string, unknown>): ProvisioningRecord {
  const attemptPurpose = value.create_attempt_purpose;
  if (attemptPurpose !== null && attemptPurpose !== undefined && attemptPurpose !== "folder" && attemptPurpose !== "results" && attemptPurpose !== "spreadsheet") {
    throw new Error("GOOGLE_PROVISIONING_RECORD_INVALID");
  }
  if ((value.create_attempt_id === null) !== (attemptPurpose === null) || (value.failure_code === null) !== (attemptPurpose === null)) {
    throw new Error("GOOGLE_PROVISIONING_RECORD_INVALID");
  }
  const result = {
    principal_id: validText(value.principal_id, "GOOGLE_PROVISIONING_RECORD_INVALID"),
    operation_ref: validText(value.operation_ref, "GOOGLE_PROVISIONING_RECORD_INVALID"),
    connection_id: validText(value.connection_id, "GOOGLE_PROVISIONING_RECORD_INVALID"),
    expected_credential_generation: validText(value.expected_credential_generation, "GOOGLE_PROVISIONING_RECORD_INVALID"),
    expected_credential_revision: validRevision(value.expected_credential_revision),
    state: value.state,
    ...(value.folder_id === null ? {} : { folder_id: validText(value.folder_id, "GOOGLE_PROVISIONING_RECORD_INVALID") }),
    ...(value.results_folder_id === null ? {} : { results_folder_id: validText(value.results_folder_id, "GOOGLE_PROVISIONING_RECORD_INVALID") }),
    ...(value.spreadsheet_id === null ? {} : { spreadsheet_id: validText(value.spreadsheet_id, "GOOGLE_PROVISIONING_RECORD_INVALID") }),
    ...(value.sheet_ids_json === null ? {} : { sheet_ids_json: validText(value.sheet_ids_json, "GOOGLE_PROVISIONING_RECORD_INVALID", 4096) }),
    ...(value.start_page_token === null ? {} : { start_page_token: validText(value.start_page_token, "GOOGLE_PROVISIONING_RECORD_INVALID", 1024) }),
    ...(value.generation_id === null ? {} : { generation_id: validText(value.generation_id, "GOOGLE_PROVISIONING_RECORD_INVALID") }),
    ...(value.failure_code === null ? {} : { failure_code: validText(value.failure_code, "GOOGLE_PROVISIONING_RECORD_INVALID", 128) }),
    ...(value.create_attempt_id === null ? {} : { create_attempt_id: validText(value.create_attempt_id, "GOOGLE_PROVISIONING_RECORD_INVALID", 128) }),
    ...(value.create_attempt_purpose === null ? {} : { create_attempt_purpose: value.create_attempt_purpose }),
    created_at: validText(value.created_at, "GOOGLE_PROVISIONING_RECORD_INVALID", 64),
  } as ProvisioningRecord;
  if (!["PENDING", "QUALIFIED", "ACTIVATED", "FAILED"].includes(result.state)) throw new Error("GOOGLE_PROVISIONING_RECORD_INVALID");
  if (result.sheet_ids_json !== undefined) JSON.parse(result.sheet_ids_json);
  return Object.freeze(result);
}
function intent(input: ProvisioningIntent): ProvisioningIntent {
  return { principal_id: validText(input.principal_id, "GOOGLE_PROVISIONING_INPUT_INVALID"), operation_ref: validText(input.operation_ref, "GOOGLE_PROVISIONING_INPUT_INVALID"),
    connection_id: validText(input.connection_id, "GOOGLE_PROVISIONING_INPUT_INVALID"), expected_credential_generation: validText(input.expected_credential_generation, "GOOGLE_PROVISIONING_INPUT_INVALID"),
    expected_credential_revision: validRevision(input.expected_credential_revision), created_at: validText(input.created_at, "GOOGLE_PROVISIONING_INPUT_INVALID", 64),
    ...(input.generation_id === undefined ? {} : { generation_id: validText(input.generation_id, "GOOGLE_PROVISIONING_INPUT_INVALID") }) };
}

const PROVISIONING_COLUMNS = `principal_id,operation_ref,connection_id,expected_credential_generation,expected_credential_revision,state,
  folder_id,results_folder_id,spreadsheet_id,sheet_ids_json,start_page_token,generation_id,failure_code,create_attempt_id,create_attempt_purpose,created_at,updated_at`;

export function createD1ExchangeGenerationRepository(database: D1Database): ExchangeGenerationD1Repository {
  const db = database.withSession("first-primary");
  const read = async (input: Pick<ProvisioningIntent, "principal_id" | "operation_ref">): Promise<ProvisioningRecord | null> => {
    const raw = await db.prepare(`SELECT ${PROVISIONING_COLUMNS} FROM google_exchange_provisioning_intent WHERE principal_id=?1 AND operation_ref=?2`)
      .bind(validText(input.principal_id, "GOOGLE_PROVISIONING_INPUT_INVALID"), validText(input.operation_ref, "GOOGLE_PROVISIONING_INPUT_INVALID"))
      .first<Record<string, unknown>>();
    return raw === null ? null : row(raw);
  };
  const begin = async (raw: ProvisioningIntent): Promise<ProvisioningRecord> => {
    const input = intent(raw); const timestamp = input.created_at;
    await db.prepare(`INSERT OR IGNORE INTO google_exchange_provisioning_intent
      (principal_id,operation_ref,connection_id,expected_credential_generation,expected_credential_revision,state,generation_id,created_at,updated_at)
      VALUES (?1,?2,?3,?4,?5,'PENDING',?6,?7,?7)`).bind(input.principal_id,input.operation_ref,input.connection_id,
      input.expected_credential_generation,input.expected_credential_revision,input.generation_id ?? null,timestamp).run();
    const actual = await read(input);
    if (!actual || actual.connection_id !== input.connection_id || actual.expected_credential_generation !== input.expected_credential_generation ||
        actual.expected_credential_revision !== input.expected_credential_revision ||
        (input.generation_id !== undefined && actual.generation_id !== input.generation_id)) throw new Error("GOOGLE_PROVISIONING_INTENT_CONFLICT");
    return actual;
  };
  const markCreateAttempt = async (raw: ProvisioningIntent, purpose: "folder" | "results" | "spreadsheet") => {
    const input = intent(raw);
    const code = `GOOGLE_CREATE_OUTCOME_UNKNOWN:${purpose}`;
    const attemptId = crypto.randomUUID();
    const result = await db.prepare(`UPDATE google_exchange_provisioning_intent SET failure_code=?3,create_attempt_id=?4,create_attempt_purpose=?5,updated_at=?6
      WHERE principal_id=?1 AND operation_ref=?2 AND connection_id=?7 AND expected_credential_generation=?8
        AND expected_credential_revision=?9 AND state='PENDING' AND failure_code IS NULL AND create_attempt_id IS NULL AND create_attempt_purpose IS NULL`)
      .bind(input.principal_id,input.operation_ref,code,attemptId,purpose,input.created_at,input.connection_id,input.expected_credential_generation,input.expected_credential_revision).run();
    if (result.meta.changes !== 1) throw new Error("GOOGLE_PROVISIONING_CREATE_FENCE_CONFLICT");
    const actual = await read(input);
    if (!actual || actual.failure_code !== code || actual.create_attempt_id !== attemptId || actual.create_attempt_purpose !== purpose) throw new Error("GOOGLE_PROVISIONING_CREATE_FENCE_UNCONFIRMED");
    return actual;
  };
  const clearCreateAttempt = async (raw: ProvisioningIntent, purpose: "folder" | "results" | "spreadsheet", attemptId: string) => {
    const input = intent(raw); const code = `GOOGLE_CREATE_OUTCOME_UNKNOWN:${purpose}`;
    const claim = validText(attemptId, "GOOGLE_PROVISIONING_CREATE_FENCE_INVALID", 128);
    const result = await db.prepare(`UPDATE google_exchange_provisioning_intent SET failure_code=NULL,create_attempt_id=NULL,create_attempt_purpose=NULL,updated_at=?3
      WHERE principal_id=?1 AND operation_ref=?2 AND connection_id=?4 AND expected_credential_generation=?5
        AND expected_credential_revision=?6 AND state='PENDING' AND failure_code=?7 AND create_attempt_id=?8 AND create_attempt_purpose=?9`)
      .bind(input.principal_id,input.operation_ref,input.created_at,input.connection_id,input.expected_credential_generation,input.expected_credential_revision,code,claim,purpose).run();
    if (result.meta.changes !== 1) throw new Error("GOOGLE_PROVISIONING_CREATE_FENCE_CONFLICT");
    const actual = await read(input);
    if (!actual || actual.failure_code !== undefined || actual.create_attempt_id !== undefined || actual.create_attempt_purpose !== undefined) throw new Error("GOOGLE_PROVISIONING_CREATE_FENCE_UNCONFIRMED");
    return actual;
  };
  const recordAssets = async (input: { readonly intent: ProvisioningIntent; readonly generation_id: string; readonly folder_id: string; readonly results_folder_id: string; readonly spreadsheet_id: string; readonly sheet_ids_json: string }) => {
    const base = intent(input.intent); const folder = validText(input.folder_id, "GOOGLE_PROVISIONING_INPUT_INVALID");
    const resultsFolder = validText(input.results_folder_id, "GOOGLE_PROVISIONING_INPUT_INVALID");
    const spreadsheet = validText(input.spreadsheet_id, "GOOGLE_PROVISIONING_INPUT_INVALID"); const sheets = validText(input.sheet_ids_json, "GOOGLE_PROVISIONING_INPUT_INVALID", 4096);
    const generationId = validText(input.generation_id, "GOOGLE_PROVISIONING_INPUT_INVALID");
    JSON.parse(sheets);
    await db.prepare(`UPDATE google_exchange_provisioning_intent SET generation_id=?3,folder_id=?4,results_folder_id=?5,spreadsheet_id=?6,sheet_ids_json=?7,failure_code=NULL,create_attempt_id=NULL,create_attempt_purpose=NULL,updated_at=?8
      WHERE principal_id=?1 AND operation_ref=?2 AND connection_id=?9 AND expected_credential_generation=?10
        AND expected_credential_revision=?11 AND state='PENDING'
        AND (generation_id IS NULL OR generation_id=?3)
        AND (folder_id IS NULL OR folder_id=?4)
        AND (results_folder_id IS NULL OR results_folder_id=?5)
        AND (spreadsheet_id IS NULL OR spreadsheet_id=?6)
        AND (sheet_ids_json IS NULL OR sheet_ids_json=?7)`)
      .bind(base.principal_id,base.operation_ref,generationId,folder,resultsFolder,spreadsheet,sheets,base.created_at,base.connection_id,base.expected_credential_generation,base.expected_credential_revision).run();
    const actual = await read(base);
    if (!actual || actual.generation_id !== generationId || actual.folder_id !== folder || actual.results_folder_id !== resultsFolder || actual.spreadsheet_id !== spreadsheet || actual.sheet_ids_json !== sheets) throw new Error("GOOGLE_PROVISIONING_WRITE_UNCONFIRMED");
    return actual;
  };
  const qualify = async (input: { readonly intent: ProvisioningIntent; readonly generation_id: string; readonly start_page_token: string }) => {
    const base = intent(input.intent); const generationId = validText(input.generation_id, "GOOGLE_PROVISIONING_INPUT_INVALID"); const token = validText(input.start_page_token, "GOOGLE_PROVISIONING_INPUT_INVALID", 1024);
    await db.prepare(`UPDATE google_exchange_provisioning_intent SET generation_id=?3,start_page_token=?4,state='QUALIFIED',updated_at=?5
      WHERE principal_id=?1 AND operation_ref=?2 AND connection_id=?6 AND expected_credential_generation=?7 AND expected_credential_revision=?8
        AND state='PENDING' AND folder_id IS NOT NULL AND results_folder_id IS NOT NULL AND spreadsheet_id IS NOT NULL AND sheet_ids_json IS NOT NULL`)
      .bind(base.principal_id,base.operation_ref,generationId,token,base.created_at,base.connection_id,base.expected_credential_generation,base.expected_credential_revision).run();
    const actual = await read(base);
    if (!actual || actual.state !== "QUALIFIED" || actual.generation_id !== generationId || actual.start_page_token !== token) throw new Error("GOOGLE_PROVISIONING_QUALIFY_UNCONFIRMED");
    return actual;
  };
  const persistShadow = async (rawGeneration: ExchangeGeneration) => {
    const generation = validateExchangeGeneration(rawGeneration); if (generation.status !== "draining") throw new Error("GOOGLE_GENERATION_SHADOW_INVALID");
    await db.prepare(`INSERT OR IGNORE INTO exchange_generation(generation_id,connection_id,folder_id,spreadsheet_id,sheet_ids_json,protocol_version,state,created_at)
      VALUES (?1,?2,?3,?4,?5,?6,'draining',?7)`).bind(generation.generation_id,generation.connection_id,generation.folder_id,generation.spreadsheet_id,
      JSON.stringify(generation.sheet_ids),generation.protocol_version,generation.created_at).run();
    const actual = await db.prepare(`SELECT generation_id,connection_id,folder_id,spreadsheet_id,sheet_ids_json,protocol_version,state,created_at
      FROM exchange_generation WHERE generation_id=?1`).bind(generation.generation_id).first<Record<string, unknown>>();
    if (!actual || actual.generation_id !== generation.generation_id || actual.connection_id !== generation.connection_id || actual.folder_id !== generation.folder_id ||
        actual.spreadsheet_id !== generation.spreadsheet_id || actual.sheet_ids_json !== JSON.stringify(generation.sheet_ids) || actual.protocol_version !== generation.protocol_version ||
        !["draining", "active"].includes(String(actual.state)) || actual.created_at !== generation.created_at) throw new Error("GOOGLE_GENERATION_WRITE_UNCONFIRMED");
  };
  const activateShadow = async (generationId: string, expectedActiveGenerationId?: string) => {
    const id = validText(generationId, "GOOGLE_GENERATION_INPUT_INVALID"); const expected = expectedActiveGenerationId === undefined ? null : validText(expectedActiveGenerationId, "GOOGLE_GENERATION_INPUT_INVALID"); const now = new Date().toISOString();
    const results = await db.batch([
      db.prepare(`UPDATE exchange_generation SET state='draining',retired_at=?2 WHERE generation_id<>?1 AND state='active'
        AND connection_id=(SELECT connection_id FROM exchange_generation WHERE generation_id=?1)
        AND EXISTS (SELECT 1 FROM google_exchange_provisioning_intent AS candidate_intent
          WHERE candidate_intent.generation_id=?1 AND candidate_intent.connection_id=exchange_generation.connection_id
            AND candidate_intent.state IN ('QUALIFIED','ACTIVATED'))
        AND (?3 IS NOT NULL OR NOT EXISTS (SELECT 1 FROM exchange_generation AS current
          WHERE current.connection_id=exchange_generation.connection_id AND current.state='active'))
        AND (?3 IS NULL OR generation_id=?3)`).bind(id,now,expected),
      db.prepare(`UPDATE exchange_generation AS candidate SET state='active',retired_at=NULL WHERE generation_id=?1 AND state='draining'
        AND EXISTS (SELECT 1 FROM google_exchange_provisioning_intent AS intent
          WHERE intent.generation_id=candidate.generation_id AND intent.connection_id=candidate.connection_id AND intent.state='QUALIFIED')
        AND (changes()=1 OR (?2 IS NULL AND NOT EXISTS (SELECT 1 FROM exchange_generation AS active
          WHERE active.connection_id=candidate.connection_id AND active.state='active')))`).bind(id,expected),
      db.prepare(`UPDATE google_exchange_provisioning_intent SET state='ACTIVATED',updated_at=?2
        WHERE generation_id=?1 AND state='QUALIFIED' AND changes()=1`).bind(id,now),
    ]);
    if (results[1]?.meta?.changes !== 1 || results[2]?.meta?.changes !== 1) throw new Error("GOOGLE_GENERATION_ACTIVATION_CONFLICT");
    const actual = await db.prepare(`SELECT generation_id,state FROM exchange_generation WHERE generation_id=?1`).bind(id).first<{ generation_id: string; state: string }>();
    if (!actual || actual.state !== "active") throw new Error("GOOGLE_GENERATION_ACTIVATION_UNCONFIRMED");
  };
  const retire = async (generationId: string) => {
    const id = validText(generationId, "GOOGLE_GENERATION_INPUT_INVALID"); const now = new Date().toISOString();
    await db.prepare(`UPDATE exchange_generation SET state='retired',retired_at=?2 WHERE generation_id=?1 AND state<>'retired'`).bind(id,now).run();
    const actual = await db.prepare(`SELECT state FROM exchange_generation WHERE generation_id=?1`).bind(id).first<{ state: string }>();
    if (!actual || actual.state !== "retired") throw new Error("GOOGLE_GENERATION_RETIRE_UNCONFIRMED");
  };
  const initializeCursor = async (rawConnection: string, rawToken: string) => {
    const connectionId = validText(rawConnection, "GOOGLE_CURSOR_INPUT_INVALID"); const token = validText(rawToken, "GOOGLE_CURSOR_INPUT_INVALID", 1024);
    await db.prepare(`INSERT OR IGNORE INTO drive_cursor(connection_id,start_page_token,last_grid_extent_json,updated_at) VALUES (?1,?2,'{}',?3)`)
      .bind(connectionId,token,new Date().toISOString()).run();
    const actual = await db.prepare(`SELECT start_page_token FROM drive_cursor WHERE connection_id=?1`).bind(connectionId).first<{ start_page_token: string }>();
    if (!actual || typeof actual.start_page_token !== "string") throw new Error("GOOGLE_CURSOR_WRITE_UNCONFIRMED");
    return validText(actual.start_page_token, "GOOGLE_CURSOR_RECORD_INVALID", 1024);
  };
  return { begin, read, markCreateAttempt, clearCreateAttempt, recordAssets, qualify, persistShadow, activateShadow, retire, initializeCursor };
}
