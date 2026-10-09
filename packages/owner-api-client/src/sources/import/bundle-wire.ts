// C2-I owner-client move of packages/pwa-source-workspace/src/bundle-import-api.ts.
// Decoder and status implementation moves here verbatim; only the transport and error seams
// are injected. No new endpoint, schema, identifier or retry rule is introduced.
import { BundleAdmissionReceiptSchema, type BundleAdmissionReceipt } from "@eliotr/contracts";
import type { LegacyHttpAdapter } from "../../legacy/http.js";
import type { EpochPort, BinaryUploadOptions } from "../../transport/client.js";
import type { RawBinaryTransport } from "./raw.js";
import type { LegacyErrorFactory } from "../../legacy/http.js";

/** Thin envelope transport returning the decoded unknown payload and the observed generation. */
export type BundleWireTransport = Pick<LegacyHttpAdapter, 'requestApi'>;

export type BundleWireErrors = LegacyErrorFactory;

export interface ImportIdentity {
  readonly operation: string;
  readonly manifestDigest: string;
  readonly sourceRevision: string;
  readonly generation: string;
}

export type ImportTransport = (path: string, init?: RequestInit) => Promise<unknown>;

export interface PreparedImport {
  readonly identity: ImportIdentity;
  readonly session?: string;
  readonly expiry: number;
  readonly files: readonly { path: string; maxPart: number }[];
  readonly existing?: BundleAdmissionReceipt;
  readonly rejected: boolean;
  readonly reasons: readonly string[];
}

export interface ImportStatus {
  readonly state: string;
  readonly receipt?: BundleAdmissionReceipt;
}

export interface BundleWireApi {
  readonly mismatch: () => never;
  readonly importCall: (path: string, init: RequestInit, generation?: string) => Promise<{ data: unknown; generation: string }>;
  readonly importBytesCall: (path: string, input: BinaryUploadOptions, generation?: string) => Promise<{data: unknown; generation: string}>;
  readonly decodePrepared: (data: unknown, manifest: unknown,
    sourceRevision: string, fileCount: number, hashes: Readonly<Record<string, string>>,
    generation: string) => PreparedImport;
  readonly decodeImportStatus: (value: unknown, identity: ImportIdentity,
    session?: string) => ImportStatus;
  readonly receiptFor: (value: unknown, identity: ImportIdentity) => BundleAdmissionReceipt;
}

export function createBundleWireApi(http: BundleWireTransport, binary: RawBinaryTransport, errors: BundleWireErrors, epoch: EpochPort, clock: {readonly now: () => number}):
  BundleWireApi {
  const mismatch: () => never = () => {
    throw errors({ status: 502, code: "INGEST_RESPONSE_MISMATCH",
      message: "Ingest response identity or schema differs from the requested operation. Inspect durable status.",
      traceId: null, retryable: false });
  };
  const record = (value: unknown, required: readonly string[],
    optional: readonly string[] = []): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        required.some((key) => !Object.hasOwn(value, key)) ||
        Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) {
      mismatch();
    }
    return value as Record<string, unknown>;
  };
  const identifier = (value: unknown): string => {
    if (typeof value !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(value)) mismatch();
    return value;
  };
  const _opaque = (value: unknown): string => {
    if (typeof value !== "string" || value.length === 0 || value !== value.trim() ||
        new TextEncoder().encode(value).byteLength > 1024 ||
        /[\u0000-\u001f\u007f]/u.test(value)) mismatch();
    return value;
  };
  const digest = (value: unknown): string => {
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) mismatch();
    return value;
  };
  const time = (value: unknown): number => {
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) mismatch();
    return Date.parse(value);
  };
  const capture = (): object => {const stamp=epoch.capture();if(!stamp || !epoch.isCurrent(stamp))throw errors({status:503,code:'API_SESSION_CLOSED',message:'Owner session is closed',traceId:null,retryable:false});return stamp;};
  const result = (stamp: object, value: unknown, generation?: string): {data:unknown;generation:string} => {
    if (!epoch.isCurrent(stamp)) throw errors({status:503,code:'API_SESSION_CLOSED',message:'Owner session is closed',traceId:null,retryable:false});
    const envelope=record(value,['data','trace_id','deployment_generation']);
    identifier(envelope.trace_id);
    const observed=identifier(envelope.deployment_generation);
    if(generation!==undefined && generation!==observed)mismatch();
    return {data:envelope.data,generation:observed};
  };
  const importBytesCall = async (path:string,input:BinaryUploadOptions,generation?:string):Promise<{data:unknown;generation:string}> => {
    const stamp=capture();
    return result(stamp,await binary.requestBinaryJson(path,input),generation);
  };
  const importCall = async (path: string, init: RequestInit,
    generation?: string): Promise<{ data: unknown; generation: string }> => {
    const stamp=capture();
    const envelope = record(await http.requestApi(path, init),
      ["data", "trace_id", "deployment_generation"]);
    result(stamp,envelope,generation);
    identifier(envelope.trace_id);
    const observed = identifier(envelope.deployment_generation);
    if (generation !== undefined && generation !== observed) mismatch();
    return { data: envelope.data, generation: observed };
  };

  const receiptFor = (value: unknown, identity: ImportIdentity): BundleAdmissionReceipt => {
    const parsed = BundleAdmissionReceiptSchema.safeParse(value);
    if (!parsed.success || parsed.data.operation_id !== identity.operation ||
        parsed.data.manifest_sha256 !== identity.manifestDigest ||
        parsed.data.source_revision_ref !== identity.sourceRevision) mismatch();
    return parsed.data;
  };

  const decodePrepared = (data: unknown, manifest: unknown, sourceRevision: string,
    fileCount: number, hashes: Readonly<Record<string, string>>,
    generation: string): PreparedImport => {
    const row = record(data, ["operation_id", "manifest_sha256", "disposition",
      "expires_at", "reason_codes"],
      ["multipart_session_ref", "files", "existing_receipt"]);
    const identity: ImportIdentity = {
      operation: identifier(row.operation_id),
      manifestDigest: digest(row.manifest_sha256),
      sourceRevision,
      generation,
    };
    if (!Array.isArray(row.reason_codes) || row.reason_codes.length > 128) mismatch();
    const reasons = (row.reason_codes as unknown[]).map((item) => identifier(item));
    if (new Set(reasons).size !== reasons.length) mismatch();
    const expiry = time(row.expires_at);
    const existing = row.existing_receipt === undefined ? undefined
      : receiptFor(row.existing_receipt, identity);
    if (row.disposition === "DUPLICATE" || row.disposition === "REJECTED") {
      if (row.files !== undefined || row.multipart_session_ref !== undefined ||
          (row.disposition === "DUPLICATE" &&
            (!existing || !["ADMITTED", "DUPLICATE"].includes(existing.decision))) ||
          (row.disposition === "REJECTED" && existing &&
            !["REJECTED", "QUARANTINED"].includes(existing.decision))) mismatch();
      return { identity, expiry, files: [], rejected: row.disposition === "REJECTED",
        reasons, ...(existing ? { existing } : {}) };
    }
    if (row.disposition !== "UPLOAD_REQUIRED" || existing ||
        !Array.isArray(row.files) || row.files.length !== fileCount ||
        expiry <= clock.now()) mismatch();
    const paths = new Set<string>();
    const files = (row.files as unknown[]).map((raw) => {
      const item = record(raw, ["path", "expected_sha256", "max_part_bytes"]);
      if (typeof item.path !== "string" || item.path.length > 512) mismatch();
      const path = item.path;
      if (paths.has(path) || hashes[path] !== digest(item.expected_sha256) ||
          typeof item.max_part_bytes !== "number" ||
          !Number.isSafeInteger(item.max_part_bytes) ||
          item.max_part_bytes < 5 * 1024 * 1024 ||
          item.max_part_bytes > 8 * 1024 * 1024) mismatch();
      paths.add(path);
      return { path, maxPart: item.max_part_bytes as number };
    });
    return { identity, expiry, files, session: identifier(row.multipart_session_ref),
      rejected: false, reasons };
  };
  const decodeImportStatus = (value: unknown, identity: ImportIdentity,
    session?: string): ImportStatus => {
    const row = record(value, ["operation_id", "state", "source_revision_ref", "expires_at",
      "updated_at"], ["staging_session_ref", "qualification_report_ref",
      "decision_receipt_ref", "promotion_receipt_ref", "receipt"]);
    if (row.operation_id !== identity.operation ||
        row.source_revision_ref !== identity.sourceRevision ||
        !["PREPARING", "UPLOAD_REQUIRED", "VERIFIED", "AUTHORIZED", "PROMOTED", "COMMITTED",
          "QUARANTINED", "REJECTED"].includes(String(row.state))) mismatch();
    time(row.expires_at);
    time(row.updated_at);
    for (const key of ["staging_session_ref", "qualification_report_ref",
      "decision_receipt_ref", "promotion_receipt_ref"]) {
      if (row[key] !== undefined) identifier(row[key]);
    }
    const receipt = row.receipt === undefined ? undefined : receiptFor(row.receipt, identity);
    if (row.state === "COMMITTED" && (!receipt ||
        !["ADMITTED", "DUPLICATE"].includes(receipt.decision))) mismatch();
    if (receipt && row.state !== "COMMITTED" && row.state !== receipt.decision) mismatch();
    if (session !== undefined && ((!receipt && time(row.expires_at) <= clock.now()) ||
        row.staging_session_ref !== session)) mismatch();
    return { state: String(row.state), ...(receipt ? { receipt } : {}) };
  };

  return { mismatch, importCall, importBytesCall, decodePrepared, decodeImportStatus, receiptFor };
}
