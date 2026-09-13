import { NormalizedBundleManifestSchema } from "@eliotr/contracts";
import { canonicalJson, sha256Utf8 } from "@eliotr/platform-cloudflare";
import { verifySnapshotViewWitness } from "./raw-normalized-snapshot-view.js";
import {
  RAW_NORMALIZED_CANDIDATE_PROTOCOL,
  RAW_NORMALIZED_MAX_OUTPUT_BYTES,
  type RawNormalizedBundleCandidate,
  type RawNormalizedCandidatePolicy,
  type RawNormalizedCapture,
  type RawNormalizedConversion,
  type RawNormalizedOutputReadback,
  type SnapshotViewWitness,
} from "./raw-normalized-types.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const MIME = /^[^\u0000-\u001f\u007f]{1,256}$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;

export class RawNormalizedCandidateError extends Error {
  public readonly code: "RAW_NORMALIZED_INVALID" | "RAW_NORMALIZED_OUTPUT_MISMATCH" | "RAW_NORMALIZED_WITNESS_REQUIRED";

  public constructor(code: RawNormalizedCandidateError["code"], message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "RawNormalizedCandidateError";
    this.code = code;
  }
}

function fail(code: RawNormalizedCandidateError["code"], message: string, cause?: unknown): never {
  throw new RawNormalizedCandidateError(code, message, cause);
}

function id(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) fail("RAW_NORMALIZED_INVALID", `${label} is invalid`);
}

function digest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) fail("RAW_NORMALIZED_INVALID", `${label} is invalid`);
}

function validateCapture(capture: RawNormalizedCapture): void {
  const keys = ["capture_id", "principal_ref", "owner_system_id", "source_namespace_id", "source_revision_ref", "source_logical_id", "source_owner_generation", "original_file_name", "content_sha256", "size_bytes", "content_type", "residency_key_digest"];
  if (Object.keys(capture).length !== keys.length || keys.some((key) => !Object.hasOwn(capture, key))) fail("RAW_NORMALIZED_INVALID", "capture contains unknown or missing fields");
  for (const [label, value] of Object.entries(capture)) {
    if (label === "original_file_name" || label === "content_type") continue;
    if (label === "content_sha256" || label === "residency_key_digest") digest(value, label);
    else if (label === "size_bytes") {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) fail("RAW_NORMALIZED_INVALID", "capture size is invalid");
    } else id(value, label);
  }
  if (capture.original_file_name.length === 0 || capture.original_file_name.length > 512 || /[\u0000-\u001f\u007f/\\]/u.test(capture.original_file_name) ||
      !MIME.test(capture.content_type)) fail("RAW_NORMALIZED_INVALID", "capture file name or content type is invalid");
}

function validateConversion(conversion: RawNormalizedConversion, capture: RawNormalizedCapture): void {
  const keys = ["protocol", "state", "operation_id", "capture_id", "content_sha256", "output_sha256", "output_bytes", "detected_mime", "format", "tokens"];
  if (Object.keys(conversion).length !== keys.length || keys.some((key) => !Object.hasOwn(conversion, key))) fail("RAW_NORMALIZED_INVALID", "conversion contains unknown or missing fields");
  if (conversion.protocol !== "eliotr.raw-markdown-conversion.v1" || conversion.state !== "COMPLETE") {
    fail("RAW_NORMALIZED_INVALID", "only a complete durable conversion candidate may be admitted");
  }
  id(conversion.operation_id, "conversion operation_id");
  if (conversion.capture_id !== capture.capture_id || conversion.content_sha256 !== capture.content_sha256) {
    fail("RAW_NORMALIZED_OUTPUT_MISMATCH", "conversion candidate is bound to another capture");
  }
  if (conversion.format !== "markdown" && conversion.format !== "text") fail("RAW_NORMALIZED_INVALID", "conversion format is invalid");
  digest(conversion.content_sha256, "conversion content_sha256");
  digest(conversion.output_sha256, "conversion output_sha256");
  if (!Number.isSafeInteger(conversion.output_bytes) || conversion.output_bytes < 1 || conversion.output_bytes > RAW_NORMALIZED_MAX_OUTPUT_BYTES ||
      !MIME.test(conversion.detected_mime) || !Number.isSafeInteger(conversion.tokens) || conversion.tokens < 0) {
    fail("RAW_NORMALIZED_INVALID", "conversion output is outside the bounded normalized envelope");
  }
}

function validateOutput(output: RawNormalizedOutputReadback, conversion: RawNormalizedConversion): void {
  const keys = ["object_key", "bytes", "sha256", "size_bytes"];
  if (Object.keys(output).length !== keys.length || keys.some((key) => !Object.hasOwn(output, key))) fail("RAW_NORMALIZED_INVALID", "output readback contains unknown or missing fields");
  id(output.object_key, "output object key");
  digest(output.sha256, "output sha256");
  if (!(output.bytes instanceof Uint8Array) || output.size_bytes !== output.bytes.byteLength ||
      output.size_bytes !== conversion.output_bytes || output.sha256 !== conversion.output_sha256) {
    fail("RAW_NORMALIZED_OUTPUT_MISMATCH", "normalized output readback does not match the durable conversion receipt");
  }
}

function validatePolicy(policy: RawNormalizedCandidatePolicy): void {
  const keys = ["policy_snapshot_sha256", "policy_revision", "ownership_mode", "origin_location_class", "residency_and_disclosure", "analyzer", "analyzer_version", "profile", "config_hash", "purpose", "workspace_view_revision_ref", "ownership_cutover_receipt_ref"];
  const required = ["policy_snapshot_sha256", "policy_revision", "ownership_mode", "origin_location_class", "residency_and_disclosure", "analyzer", "analyzer_version", "profile", "config_hash", "purpose"];
  if (Object.keys(policy).some((key) => !keys.includes(key)) || required.some((key) => !Object.hasOwn(policy, key))) fail("RAW_NORMALIZED_INVALID", "policy contains unknown or missing fields");
  for (const [label, value] of Object.entries(policy)) {
    if (label === "residency_and_disclosure") continue;
    if (label.endsWith("_ref") || ["ownership_mode", "origin_location_class", "analyzer", "analyzer_version", "profile", "purpose", "config_hash"].includes(label)) id(value, label);
  }
  digest(policy.config_hash, "policy config_hash");
  digest(policy.policy_snapshot_sha256, "policy_snapshot_sha256");
  if (!Number.isSafeInteger(policy.policy_revision) || policy.policy_revision < 1) fail("RAW_NORMALIZED_INVALID", "policy_revision is invalid");
  const r = policy.residency_and_disclosure;
  const residencyKeys = ["scope_domain_id", "access_domain_id", "confidentiality_domain_id", "encryption_key_domain_id", "retention_domain_id", "erasure_domain_id", "disclosure_ceiling", "allowed_use", "expiry"];
  const requiredResidency = residencyKeys.filter((key) => key !== "expiry");
  if (Object.keys(r).some((key) => !residencyKeys.includes(key)) || requiredResidency.some((key) => !Object.hasOwn(r, key))) fail("RAW_NORMALIZED_INVALID", "residency policy contains unknown or missing fields");
  for (const [label, value] of Object.entries(r)) {
    if (label === "allowed_use") {
      if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || !IDENTIFIER.test(v))) fail("RAW_NORMALIZED_INVALID", "allowed_use is invalid");
    } else if (label !== "expiry") id(value, `residency ${label}`);
  }
  if (r.expiry !== undefined && !ISO.test(r.expiry)) fail("RAW_NORMALIZED_INVALID", "residency expiry is invalid");
  if (policy.ownership_mode === "ownership_cutover" && policy.ownership_cutover_receipt_ref === undefined) fail("RAW_NORMALIZED_INVALID", "ownership cutover receipt is required");
  if (policy.ownership_mode !== "ownership_cutover" && policy.ownership_cutover_receipt_ref !== undefined) fail("RAW_NORMALIZED_INVALID", "ownership cutover receipt is not allowed");
}

function mediaType(value: string): string {
  return value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function isIdentityTextCapture(capture: RawNormalizedCapture): boolean {
  const type = mediaType(capture.content_type);
  if (type === "text/plain" || type === "text/markdown") return true;
  if (type !== "" && type !== "application/octet-stream") return false;
  const name = capture.original_file_name.toLowerCase();
  return name.endsWith(".md") || name.endsWith(".txt");
}

function isIdentityTextCandidate(
  capture: RawNormalizedCapture,
  conversion: RawNormalizedConversion,
  output: RawNormalizedOutputReadback,
  checkedOutputSha256: string,
): boolean {
  const detectedMime = mediaType(conversion.detected_mime);
  const stringOutput = detectedMime === "text/plain"
    ? conversion.format === "text" || conversion.format === "markdown"
    : detectedMime === "text/markdown" && conversion.format === "markdown";
  return isIdentityTextCapture(capture) &&
    stringOutput &&
    checkedOutputSha256 === capture.content_sha256 && output.size_bytes === capture.size_bytes;
}

export async function readRawNormalizedCandidate(input: {
  readonly capture: RawNormalizedCapture;
  readonly conversion: RawNormalizedConversion;
  readonly output: RawNormalizedOutputReadback;
  readonly snapshot_view?: SnapshotViewWitness;
  readonly policy: RawNormalizedCandidatePolicy;
}): Promise<RawNormalizedBundleCandidate> {
  validateCapture(input.capture);
  validateConversion(input.conversion, input.capture);
  validateOutput(input.output, input.conversion);
  validatePolicy(input.policy);
  if (input.snapshot_view === undefined) fail("RAW_NORMALIZED_WITNESS_REQUIRED", "raw normalized admission requires an immutable snapshot-view witness");
  try {
    await verifySnapshotViewWitness(input.snapshot_view, input.capture, {
      policy_snapshot_sha256: input.policy.policy_snapshot_sha256,
      policy_revision: input.policy.policy_revision,
    });
  } catch (cause) {
    fail("RAW_NORMALIZED_WITNESS_REQUIRED", "snapshot-view witness failed exact verification", cause);
  }
  try { new TextDecoder("utf-8", { fatal: true }).decode(input.output.bytes); }
  catch (cause) { fail("RAW_NORMALIZED_OUTPUT_MISMATCH", "normalized output is not valid UTF-8", cause); }
  const bytes = new Uint8Array(input.output.bytes.byteLength); bytes.set(input.output.bytes);
  const rawDigest = await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer);
  const markdownSha = [...new Uint8Array(rawDigest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  if (markdownSha !== input.output.sha256) fail("RAW_NORMALIZED_OUTPUT_MISMATCH", "normalized output bytes have a different digest");
  const identityText = isIdentityTextCandidate(input.capture, input.conversion, input.output, markdownSha);
  const manifest = NormalizedBundleManifestSchema.parse({
    protocol: "eliotr.normalized.v1",
    origin: {
      owner_system_id: input.capture.owner_system_id,
      source_namespace_id: input.capture.source_namespace_id,
      source_owner_generation: input.capture.source_owner_generation,
      source_revision_ref: input.capture.source_revision_ref,
      source_view_ref: input.snapshot_view.source_view_ref,
      ...(input.policy.workspace_view_revision_ref === undefined ? {} : { workspace_view_revision_ref: input.policy.workspace_view_revision_ref }),
      ownership_mode: input.policy.ownership_mode,
      ...(input.policy.ownership_cutover_receipt_ref === undefined ? {} : { ownership_cutover_receipt_ref: input.policy.ownership_cutover_receipt_ref }),
    },
    source: {
      logical_id: input.capture.source_logical_id,
      original_name: input.capture.original_file_name,
      original_sha256: input.capture.content_sha256,
      origin_location_class: input.policy.origin_location_class,
      mime_type: input.conversion.detected_mime,
    },
    residency_and_disclosure: input.policy.residency_and_disclosure,
    normalization: {
      analyzer: input.policy.analyzer,
      analyzer_version: input.policy.analyzer_version,
      profile: input.policy.profile,
      config_hash: input.policy.config_hash,
      created_at: input.snapshot_view.observed_at,
    },
    content: { markdown: "content.md", markdown_sha256: input.output.sha256 },
    capabilities: { text_ranges: true, pages: false, bounding_boxes: false, tables: false, figures: false },
    quality: identityText
      ? { state: "standard", assurance_ceiling: "CAPTURED", warnings: [] }
      : { state: "degraded", assurance_ceiling: "CAPTURED", warnings: ["RAW_MARKDOWN_CANDIDATE_NO_SOURCE_MAP"] },
    export: { purpose: input.policy.purpose, receipt_ref: `raw-conversion:${input.conversion.operation_id}` },
  });
  const manifestBytes = new TextEncoder().encode(canonicalJson(manifest));
  const manifestSha = await sha256Utf8(canonicalJson(manifest));
  const hashesText = `${input.output.sha256}  content.md\n${manifestSha}  manifest.json\n`;
  const hashesBytes = new TextEncoder().encode(hashesText);
  const hashesSha = await sha256Utf8(hashesText);
  const candidateDigest = await sha256Utf8(canonicalJson([RAW_NORMALIZED_CANDIDATE_PROTOCOL, input.capture.capture_id, input.conversion.operation_id, input.snapshot_view.source_view_ref, input.output.sha256]));
  return {
    protocol: RAW_NORMALIZED_CANDIDATE_PROTOCOL,
    candidate_ref: `raw-normalized-candidate:${candidateDigest}`,
    capture_id: input.capture.capture_id,
    conversion_operation_id: input.conversion.operation_id,
    source_view_ref: input.snapshot_view.source_view_ref,
    output_object_key: input.output.object_key,
    output_sha256: input.output.sha256,
    output_bytes: input.output.size_bytes,
    snapshot_view: input.snapshot_view,
    manifest,
    manifest_bytes: manifestBytes,
    hashes_bytes: hashesBytes,
    file_hashes: { "content.md": input.output.sha256, "manifest.json": manifestSha, "hashes.sha256": hashesSha },
    total_bytes: input.output.size_bytes + manifestBytes.byteLength + hashesBytes.byteLength,
  };
}
