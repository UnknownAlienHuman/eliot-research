import { BackupError, backupSha256Hex, canonicalBackupJson, failBackup } from "@eliotr/backup-o2";

export const PRIMARY_WRITER_BOOTSTRAP_ADMISSION_PROTOCOL = "eliotr.backup-primary-writer-admission.v1" as const;
export const PRIMARY_WRITER_BOOTSTRAP_ADMISSION_PURPOSE = "BOOTSTRAP" as const;
export const PRIMARY_WRITER_BOOTSTRAP_BINDING_REF = "BACKUP_PARTS_BUCKET" as const;

const SHA256 = /^[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const ADMISSION_KEYS = [
  "access_expires_at", "admission_ref", "authentication_method", "bucket_binding_ref",
  "client_class", "credential_generation", "deployment_generation", "issuer", "principal_ref",
  "protocol", "purpose", "version_id",
] as const;
const HASHED_ADMISSION_KEYS = [...ADMISSION_KEYS, "admission_sha256"] as const;

export interface PrimaryWriterBootstrapRequestGuardDenial {
  readonly code: "BACKUP_PRIMARY_ORIGIN_CSRF_DENIED";
  readonly status: 403;
  readonly message: "Primary writer admission requires a same-origin owner request";
}

/** Pure browser-mutation guard shared by the Core route and its focused tests. */
export function validatePrimaryWriterBootstrapRequestSecurity(input: {
  readonly request: Request;
  readonly url: URL;
}): PrimaryWriterBootstrapRequestGuardDenial | null {
  const { request, url } = input;
  const site = request.headers.get("Sec-Fetch-Site");
  if (request.method !== "POST" || request.headers.get("Origin") !== url.origin || request.headers.get("x-eliotr-csrf") !== "1" ||
      (site !== null && site !== "same-origin" && site !== "none")) {
    return {
      code: "BACKUP_PRIMARY_ORIGIN_CSRF_DENIED",
      status: 403,
      message: "Primary writer admission requires a same-origin owner request",
    };
  }
  return null;
}

export interface PrimaryWriterBootstrapAdmission {
  readonly protocol: typeof PRIMARY_WRITER_BOOTSTRAP_ADMISSION_PROTOCOL;
  readonly admission_ref: string;
  readonly purpose: typeof PRIMARY_WRITER_BOOTSTRAP_ADMISSION_PURPOSE;
  readonly principal_ref: string;
  readonly client_class: "owner_pwa";
  readonly credential_generation: string;
  readonly issuer: string;
  readonly authentication_method: "cloudflare_access";
  readonly access_expires_at: string;
  readonly deployment_generation: string;
  readonly version_id: string;
  readonly bucket_binding_ref: typeof PRIMARY_WRITER_BOOTSTRAP_BINDING_REF;
}

export interface PrimaryWriterBootstrapAdmissionActor {
  readonly principal_ref: string;
  readonly client_class: string;
  readonly credential_generation: string;
  readonly access?: {
    readonly principal_ref: string;
    readonly credential_generation: string;
    readonly expires_at: string;
    readonly issuer?: string;
    readonly authentication_method?: "cloudflare_access" | "service_token";
  };
}

export interface IssuePrimaryWriterBootstrapAdmissionInput {
  readonly database: D1Database;
  readonly actor: PrimaryWriterBootstrapAdmissionActor;
  readonly deployment_generation: string;
  readonly version_id: string;
  readonly bucket_binding_ref: string;
}

export interface PrimaryWriterBootstrapAdmissionResult {
  readonly admission: PrimaryWriterBootstrapAdmission;
  readonly admission_sha256: string;
  /** D1-generated timestamp. It is deliberately outside the hashed admission body. */
  readonly created_at: string;
}

export type PrimaryWriterBootstrapAdmissionRouteResult =
  | { readonly ok: true; readonly data: PrimaryWriterBootstrapAdmissionResult }
  | {
      readonly ok: false;
      readonly status: 403 | 409 | 500 | 503;
      readonly code: string;
      readonly title: string;
      readonly retryable: boolean;
    };

interface StoredAdmissionRow extends Record<string, unknown> {
  readonly admission_ref: unknown;
  readonly protocol: unknown;
  readonly purpose: unknown;
  readonly admission_json: unknown;
  readonly admission_sha256: unknown;
  readonly principal_ref: unknown;
  readonly client_class: unknown;
  readonly credential_generation: unknown;
  readonly issuer: unknown;
  readonly authentication_method: unknown;
  readonly access_expires_at: unknown;
  readonly deployment_generation: unknown;
  readonly version_id: unknown;
  readonly bucket_binding_ref: unknown;
  readonly created_at: unknown;
}

interface ActorTuple {
  readonly principal_ref: string;
  readonly client_class: "owner_pwa";
  readonly credential_generation: string;
  readonly issuer: string;
  readonly authentication_method: "cloudflare_access";
  readonly access_expires_at: string;
  readonly deployment_generation: string;
  readonly version_id: string;
  readonly bucket_binding_ref: typeof PRIMARY_WRITER_BOOTSTRAP_BINDING_REF;
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.trim() !== value || CONTROL.test(value)) {
    failBackup("BACKUP_INPUT_INVALID", `primary writer bootstrap ${label} is malformed`);
  }
  return value;
}

function canonicalInstant(value: unknown, label: string): string {
  const text = boundedText(value, label, 40);
  const parsed = new Date(text);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== text) {
    failBackup("BACKUP_INPUT_INVALID", `primary writer bootstrap ${label} is not canonical UTC`);
  }
  return text;
}

function actorTuple(input: IssuePrimaryWriterBootstrapAdmissionInput): ActorTuple {
  const actor = input.actor;
  const access = actor?.access;
  if (actor?.client_class !== "owner_pwa" || access === undefined ||
      access.authentication_method !== "cloudflare_access" ||
      typeof access.issuer !== "string" || access.issuer.length === 0 ||
      access.principal_ref !== actor.principal_ref ||
      access.credential_generation !== actor.credential_generation) {
    failBackup("BACKUP_INPUT_INVALID", "primary writer bootstrap requires a matching verified owner Access identity");
  }
  const principal = boundedText(actor.principal_ref, "principal", 512);
  const generation = boundedText(actor.credential_generation, "credential generation", 256);
  const issuer = boundedText(access.issuer, "issuer", 512);
  const expiry = canonicalInstant(access.expires_at, "Access expiry");
  const deployment = boundedText(input.deployment_generation, "deployment generation", 256);
  const version = boundedText(input.version_id, "Worker version", 256);
  if (input.bucket_binding_ref !== PRIMARY_WRITER_BOOTSTRAP_BINDING_REF) {
    failBackup("BACKUP_INPUT_INVALID", "primary writer bootstrap binding reference is not the fixed Worker binding");
  }
  return {
    principal_ref: principal,
    client_class: "owner_pwa",
    credential_generation: generation,
    issuer,
    authentication_method: "cloudflare_access",
    access_expires_at: expiry,
    deployment_generation: deployment,
    version_id: version,
    bucket_binding_ref: PRIMARY_WRITER_BOOTSTRAP_BINDING_REF,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rowText(row: StoredAdmissionRow, key: keyof StoredAdmissionRow): string {
  const value = row[key];
  if (typeof value !== "string") failBackup("BACKUP_ROW_INVALID", `primary writer bootstrap readback ${key} is malformed`);
  return value;
}

function sameTuple(admission: PrimaryWriterBootstrapAdmission, tuple: ActorTuple): boolean {
  return admission.principal_ref === tuple.principal_ref &&
    admission.client_class === tuple.client_class &&
    admission.credential_generation === tuple.credential_generation &&
    admission.issuer === tuple.issuer &&
    admission.authentication_method === tuple.authentication_method &&
    admission.access_expires_at === tuple.access_expires_at &&
    admission.deployment_generation === tuple.deployment_generation &&
    admission.version_id === tuple.version_id &&
    admission.bucket_binding_ref === tuple.bucket_binding_ref;
}

/** Strict parser used by the native qualification operator before it installs authority. */
export async function parsePrimaryWriterBootstrapAdmission(value: unknown): Promise<PrimaryWriterBootstrapAdmission> {
  if (!isRecord(value) || canonicalBackupJson(Object.keys(value).sort()) !== canonicalBackupJson([...HASHED_ADMISSION_KEYS].sort())) {
    failBackup("BACKUP_ROW_INVALID", "primary writer bootstrap admission envelope has unknown or missing fields");
  }
  const digest = value.admission_sha256;
  if (typeof digest !== "string" || !SHA256.test(digest)) {
    failBackup("BACKUP_ROW_INVALID", "primary writer bootstrap admission digest is malformed");
  }
  const body = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "admission_sha256"));
  if (canonicalBackupJson(Object.keys(body).sort()) !== canonicalBackupJson([...ADMISSION_KEYS].sort()) ||
      await backupSha256Hex(canonicalBackupJson(body)) !== digest) {
    failBackup("BACKUP_ROW_INVALID", "primary writer bootstrap admission digest or body shape is invalid");
  }
  if (body.protocol !== PRIMARY_WRITER_BOOTSTRAP_ADMISSION_PROTOCOL ||
      body.purpose !== PRIMARY_WRITER_BOOTSTRAP_ADMISSION_PURPOSE ||
      body.client_class !== "owner_pwa" || body.authentication_method !== "cloudflare_access" ||
      body.bucket_binding_ref !== PRIMARY_WRITER_BOOTSTRAP_BINDING_REF) {
    failBackup("BACKUP_ROW_INVALID", "primary writer bootstrap admission protocol or authority fields diverge");
  }
  if (typeof body.admission_ref !== "string" || !UUID.test(body.admission_ref)) {
    failBackup("BACKUP_ROW_INVALID", "primary writer bootstrap admission reference is not a generated UUID");
  }
  boundedText(body.principal_ref, "stored principal", 512);
  boundedText(body.credential_generation, "stored credential generation", 256);
  boundedText(body.issuer, "stored issuer", 512);
  canonicalInstant(body.access_expires_at, "stored Access expiry");
  boundedText(body.deployment_generation, "stored deployment generation", 256);
  boundedText(body.version_id, "stored Worker version", 256);
  return body as unknown as PrimaryWriterBootstrapAdmission;
}

async function decodeStoredAdmission(row: StoredAdmissionRow): Promise<PrimaryWriterBootstrapAdmissionResult> {
  const raw = rowText(row, "admission_json");
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch (cause) { failBackup("BACKUP_ROW_INVALID", "primary writer bootstrap admission JSON is invalid", false, {}, cause); }
  if (!isRecord(value) || canonicalBackupJson(value) !== raw) {
    failBackup("BACKUP_ROW_INVALID", "primary writer bootstrap admission is not the exact canonical protocol shape");
  }
  const admissionSha = rowText(row, "admission_sha256");
  const admission = await parsePrimaryWriterBootstrapAdmission({ ...value, admission_sha256: admissionSha });
  const expectedColumns: Readonly<Record<string, string>> = {
    admission_ref: admission.admission_ref,
    protocol: admission.protocol,
    purpose: admission.purpose,
    principal_ref: admission.principal_ref,
    client_class: admission.client_class,
    credential_generation: admission.credential_generation,
    issuer: admission.issuer,
    authentication_method: admission.authentication_method,
    access_expires_at: admission.access_expires_at,
    deployment_generation: admission.deployment_generation,
    version_id: admission.version_id,
    bucket_binding_ref: admission.bucket_binding_ref,
  };
  for (const [key, expected] of Object.entries(expectedColumns)) {
    if (rowText(row, key as keyof StoredAdmissionRow) !== expected) failBackup("BACKUP_ROW_INVALID", `primary writer bootstrap ${key} column differs from its canonical body`);
  }
  const createdAt = canonicalInstant(rowText(row, "created_at"), "database creation time");
  return { admission, admission_sha256: admissionSha, created_at: createdAt };
}

function tableMissing(cause: unknown): boolean {
  return cause instanceof Error && /no such table:\s*backup_primary_writer_(?:admission|qualification)/iu.test(cause.message);
}

async function readOutstanding(
  database: D1Database,
  tuple: ActorTuple,
): Promise<readonly StoredAdmissionRow[]> {
  try {
    const result = await database.prepare(`
      SELECT a.admission_ref,a.protocol,a.purpose,a.admission_json,a.admission_sha256,a.principal_ref,
        a.client_class,a.credential_generation,a.issuer,a.authentication_method,a.access_expires_at,
        a.deployment_generation,a.version_id,a.bucket_binding_ref,a.created_at
      FROM backup_primary_writer_admission a
      WHERE a.principal_ref=?1 AND a.deployment_generation=?2 AND a.version_id=?3
        AND a.bucket_binding_ref=?4 AND julianday(a.access_expires_at)>julianday('now')
        AND NOT EXISTS (SELECT 1 FROM backup_primary_writer_admission_revocation r
          WHERE r.admission_ref=a.admission_ref AND r.admission_sha256=a.admission_sha256)
        AND NOT EXISTS (SELECT 1 FROM backup_primary_writer_qualification q
          WHERE q.owner_admission_ref=a.admission_ref AND q.owner_admission_sha256=a.admission_sha256)
      ORDER BY a.created_at LIMIT 2
    `).bind(tuple.principal_ref, tuple.deployment_generation, tuple.version_id, tuple.bucket_binding_ref)
      .all<StoredAdmissionRow>();
    if (result.success !== true || !Array.isArray(result.results) || result.results.length > 2) {
      failBackup("BACKUP_TABLE_MISSING", "primary writer bootstrap admission read is unavailable");
    }
    return result.results;
  } catch (cause) {
    if (tableMissing(cause)) failBackup("BACKUP_TABLE_MISSING", "primary writer bootstrap admission migration is not installed", false, {}, cause);
    throw cause;
  }
}

async function hasQualification(database: D1Database): Promise<boolean> {
  try {
    const result = await database.prepare("SELECT qualification_ref FROM backup_primary_writer_qualification LIMIT 1").all<{ qualification_ref: string }>();
    if (result.success !== true || !Array.isArray(result.results)) failBackup("BACKUP_TABLE_MISSING", "primary writer qualification state is unavailable");
    return result.results.length > 0;
  } catch (cause) {
    if (tableMissing(cause)) failBackup("BACKUP_TABLE_MISSING", "primary writer qualification migration is not installed", false, {}, cause);
    throw cause;
  }
}

async function resolveOutstanding(
  rows: readonly StoredAdmissionRow[],
  tuple: ActorTuple,
): Promise<PrimaryWriterBootstrapAdmissionResult | null> {
  if (rows.length === 0) return null;
  if (rows.length !== 1) failBackup("BACKUP_ROW_INVALID", "multiple live primary writer bootstrap admissions exist for one owner/runtime");
  const row = rows[0];
  if (row === undefined) failBackup("BACKUP_ROW_INVALID", "primary writer bootstrap admission read returned no row");
  const existing = await decodeStoredAdmission(row);
  if (!sameTuple(existing.admission, tuple)) {
    failBackup("BACKUP_INTENT_CONFLICT", "a different live owner credential already has a primary writer bootstrap admission for this runtime");
  }
  return existing;
}

/**
 * Issues a single-use BOOTSTRAP admission from verified request identity and the
 * running Worker's own generation/version bindings. Retries of the exact token
 * tuple return its immutable row; a different live token must wait for expiry,
 * revocation, or qualification consumption.
 */
export async function issuePrimaryWriterBootstrapAdmission(
  input: IssuePrimaryWriterBootstrapAdmissionInput,
): Promise<PrimaryWriterBootstrapAdmissionResult> {
  const tuple = actorTuple(input);
  const existing = await resolveOutstanding(await readOutstanding(input.database, tuple), tuple);
  if (existing !== null) return existing;
  if (await hasQualification(input.database)) {
    failBackup("BACKUP_INTENT_CONFLICT", "primary writer qualification already exists; bootstrap admission is one-time");
  }

  const admission: PrimaryWriterBootstrapAdmission = {
    protocol: PRIMARY_WRITER_BOOTSTRAP_ADMISSION_PROTOCOL,
    admission_ref: crypto.randomUUID(),
    purpose: PRIMARY_WRITER_BOOTSTRAP_ADMISSION_PURPOSE,
    ...tuple,
  };
  const admissionJson = canonicalBackupJson(admission);
  const admissionSha = await backupSha256Hex(admissionJson);
  try {
    const inserted = await input.database.prepare(`
      INSERT INTO backup_primary_writer_admission(
        admission_ref,protocol,purpose,admission_json,admission_sha256,principal_ref,client_class,
        credential_generation,issuer,authentication_method,access_expires_at,deployment_generation,
        version_id,bucket_binding_ref
      ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)
    `).bind(
      admission.admission_ref, admission.protocol, admission.purpose, admissionJson, admissionSha,
      admission.principal_ref, admission.client_class, admission.credential_generation, admission.issuer,
      admission.authentication_method, admission.access_expires_at, admission.deployment_generation,
      admission.version_id, admission.bucket_binding_ref,
    ).run();
    if (inserted.success !== true || Number(inserted.meta?.changes ?? 0) !== 1) {
      failBackup("BACKUP_ROW_INVALID", "primary writer bootstrap admission insert did not commit exactly one row");
    }
  } catch (cause) {
    if (tableMissing(cause)) failBackup("BACKUP_TABLE_MISSING", "primary writer bootstrap admission migration is not installed", false, {}, cause);
    if (cause instanceof Error && /BACKUP_PRIMARY_ADMISSION_UNAVAILABLE/u.test(cause.message)) {
      const raced = await resolveOutstanding(await readOutstanding(input.database, tuple), tuple);
      if (raced !== null) return raced;
      if (await hasQualification(input.database)) failBackup("BACKUP_INTENT_CONFLICT", "primary writer qualification already exists; bootstrap admission is one-time");
      failBackup("BACKUP_INPUT_INVALID", "owner Access credential expired or bootstrap admission is otherwise unavailable");
    }
    throw cause;
  }

  try {
    const row = await input.database.prepare(`
      SELECT admission_ref,protocol,purpose,admission_json,admission_sha256,principal_ref,client_class,
        credential_generation,issuer,authentication_method,access_expires_at,deployment_generation,
        version_id,bucket_binding_ref,created_at
      FROM backup_primary_writer_admission a
      WHERE a.admission_ref=?1 AND julianday(a.access_expires_at)>julianday('now')
        AND NOT EXISTS (SELECT 1 FROM backup_primary_writer_admission_revocation r
          WHERE r.admission_ref=a.admission_ref AND r.admission_sha256=a.admission_sha256)
        AND NOT EXISTS (SELECT 1 FROM backup_primary_writer_qualification q
          WHERE q.owner_admission_ref=a.admission_ref AND q.owner_admission_sha256=a.admission_sha256)
      LIMIT 2
    `).bind(admission.admission_ref).all<StoredAdmissionRow>();
    if (row.success !== true || !Array.isArray(row.results) || row.results.length !== 1) {
      failBackup("BACKUP_ROW_INVALID", "primary writer bootstrap admission readback is missing or ambiguous");
    }
    const persistedRow = row.results[0];
    if (persistedRow === undefined) failBackup("BACKUP_ROW_INVALID", "primary writer bootstrap admission readback is missing");
    const persisted = await decodeStoredAdmission(persistedRow);
    if (persisted.admission_sha256 !== admissionSha || canonicalBackupJson(persisted.admission) !== admissionJson) {
      failBackup("BACKUP_ROW_INVALID", "primary writer bootstrap admission readback differs from the issued identity");
    }
    return persisted;
  } catch (cause) {
    if (tableMissing(cause)) failBackup("BACKUP_TABLE_MISSING", "primary writer bootstrap admission migration is not installed", false, {}, cause);
    throw cause;
  }
}

/** HTTP-facing validation/result adapter; it never exposes database error detail. */
export async function issuePrimaryWriterBootstrapAdmissionRoute(input: {
  readonly request: Request;
  readonly url: URL;
  readonly database?: D1Database;
  readonly actor?: PrimaryWriterBootstrapAdmissionActor;
  readonly deployment_generation?: string;
  readonly version_id?: string;
  readonly bucket?: R2Bucket;
}): Promise<PrimaryWriterBootstrapAdmissionRouteResult> {
  const denied = validatePrimaryWriterBootstrapRequestSecurity({ request: input.request, url: input.url });
  if (denied !== null) return { ok: false, status: denied.status, code: denied.code, title: denied.message, retryable: false };
  if (input.actor === undefined || input.actor.client_class !== "owner_pwa" ||
      input.actor.access?.authentication_method !== "cloudflare_access") {
    return {
      ok: false, status: 403, code: "BACKUP_PRIMARY_OWNER_REQUIRED",
      title: "A verified owner Access session is required", retryable: false,
    };
  }
  if (input.database === undefined || input.bucket === undefined ||
      typeof input.deployment_generation !== "string" || input.deployment_generation.length === 0 ||
      typeof input.version_id !== "string" || input.version_id.length === 0) {
    return {
      ok: false, status: 503, code: "BACKUP_PRIMARY_UNAVAILABLE",
      title: "Primary writer bootstrap runtime is not configured", retryable: false,
    };
  }
  try {
    const data = await issuePrimaryWriterBootstrapAdmission({
      database: input.database,
      actor: input.actor,
      deployment_generation: input.deployment_generation,
      version_id: input.version_id,
      bucket_binding_ref: PRIMARY_WRITER_BOOTSTRAP_BINDING_REF,
    });
    return { ok: true, data };
  } catch (cause) {
    if (cause instanceof BackupError) {
      if (cause.code === "BACKUP_INPUT_INVALID") {
        return { ok: false, status: 403, code: "BACKUP_PRIMARY_OWNER_REQUIRED", title: "A verified owner Access session is required", retryable: false };
      }
      if (cause.code === "BACKUP_INTENT_CONFLICT") {
        return { ok: false, status: 409, code: "BACKUP_PRIMARY_ADMISSION_CONFLICT", title: "A primary writer bootstrap admission is already pending or consumed", retryable: false };
      }
      if (cause.code === "BACKUP_TABLE_MISSING") {
        return { ok: false, status: 503, code: "BACKUP_PRIMARY_UNAVAILABLE", title: "Primary writer bootstrap storage is unavailable", retryable: false };
      }
    }
    return { ok: false, status: 500, code: "BACKUP_PRIMARY_ADMISSION_UNKNOWN", title: "Primary writer bootstrap admission outcome is unknown", retryable: true };
  }
}
