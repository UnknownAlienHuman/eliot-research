import type { PurgeLocation, PurgeTarget } from "@eliotr/contracts";
import {
  assertErasureIdentifier,
  assertErasureSha256,
  canonicalErasureJson,
  erasureSha256Utf8,
  erasureFail,
  stableErasureId,
} from "./canonical.js";

const PREFIX = "location-empty-proof:v1:";
const PROTOCOL = "eliotr.erasure.location-empty-proof.v1";
const LOCATIONS: readonly PurgeLocation[] = [
  "CanonicalPayload", "Projection", "Index", "Blob", "OperationalRecovery", "ProviderCopy", "BackupRestorePath", "RouteContinuation",
];

export interface EmptyLocationProofBody {
  readonly request_digest: string;
  readonly exact_subject_ref: string;
  readonly location: PurgeLocation;
  readonly root_identity: {
    readonly source_revision_ref: string;
    readonly source_id: string;
    readonly source_namespace_id: string;
    readonly source_owner_system_id: string;
    readonly source_owner_generation: string;
    readonly owner_incarnation_ref: string;
    readonly ownership_record_revision: string;
    readonly content_sha256: string;
    readonly object_residency_key_digest: string;
  };
  readonly namespace_snapshot: {
    readonly authority_digest: string;
    readonly namespace_digest: string;
    readonly namespace_generation: string;
    readonly namespace_ref: string;
    readonly object_count: 0;
  };
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "location-empty proof encoding is malformed");
  }
  const padded = value.replace(/-/gu, "+").replace(/_/gu, "/") + "=".repeat((4 - value.length % 4) % 4);
  let binary: string;
  try { binary = atob(padded); }
  catch (cause) { erasureFail("ERASURE_CLOSURE_INCOMPLETE", "location-empty proof encoding is invalid", false, cause); }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index]);
}

function decodeTarget(target: PurgeTarget): { readonly body: EmptyLocationProofBody; readonly proofDigest: string } {
  if (target.target_kind !== "LOCATION_EMPTY_PROOF" || !target.canonical_ref.startsWith(PREFIX)) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "location-empty target has no versioned proof bytes");
  }
  const encoded = target.canonical_ref.slice(PREFIX.length);
  const bytes = decodeBase64Url(encoded);
  if (bytes.byteLength > 16_384) erasureFail("ERASURE_CLOSURE_INCOMPLETE", "location-empty proof exceeds its byte limit");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let envelope: unknown;
  try { envelope = JSON.parse(text) as unknown; }
  catch (cause) { erasureFail("ERASURE_CLOSURE_INCOMPLETE", "location-empty proof JSON is malformed", false, cause); }
  if (!isRecord(envelope) || !exactKeys(envelope, ["protocol", "proof", "proof_digest"]) || envelope.protocol !== PROTOCOL) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "location-empty proof protocol is unknown or incomplete");
  }
  const raw = envelope.proof;
  if (!isRecord(raw) || !exactKeys(raw, ["request_digest", "exact_subject_ref", "location", "root_identity", "namespace_snapshot"])) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "location-empty proof body is incomplete");
  }
  const root = raw.root_identity;
  const snapshot = raw.namespace_snapshot;
  if (!isRecord(root) || !exactKeys(root, [
    "source_revision_ref", "source_id", "source_namespace_id", "source_owner_system_id",
    "source_owner_generation", "owner_incarnation_ref", "ownership_record_revision",
    "content_sha256", "object_residency_key_digest",
  ])) erasureFail("ERASURE_CLOSURE_INCOMPLETE", "location-empty proof root identity is malformed");
  if (!isRecord(snapshot) || !exactKeys(snapshot, [
    "authority_digest", "namespace_digest", "namespace_generation", "namespace_ref", "object_count",
  ]) || snapshot.object_count !== 0) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "location-empty proof namespace snapshot is malformed");
  }
  const body: EmptyLocationProofBody = {
    request_digest: assertErasureSha256(raw.request_digest, "empty proof request digest"),
    exact_subject_ref: assertErasureIdentifier(raw.exact_subject_ref, "empty proof exact subject"),
    location: LOCATIONS.includes(raw.location as PurgeLocation)
      ? raw.location as PurgeLocation
      : erasureFail("ERASURE_CLOSURE_INCOMPLETE", "empty proof location is unknown"),
    root_identity: {
      source_revision_ref: assertErasureIdentifier(root.source_revision_ref, "empty proof source revision"),
      source_id: assertErasureIdentifier(root.source_id, "empty proof source ID"),
      source_namespace_id: assertErasureIdentifier(root.source_namespace_id, "empty proof source namespace"),
      source_owner_system_id: assertErasureIdentifier(root.source_owner_system_id, "empty proof owner system"),
      source_owner_generation: assertErasureIdentifier(root.source_owner_generation, "empty proof owner generation"),
      owner_incarnation_ref: assertErasureIdentifier(root.owner_incarnation_ref, "empty proof owner incarnation"),
      ownership_record_revision: assertErasureIdentifier(root.ownership_record_revision, "empty proof ownership revision"),
      content_sha256: assertErasureIdentifier(root.content_sha256, "empty proof content digest"),
      object_residency_key_digest: assertErasureIdentifier(root.object_residency_key_digest, "empty proof residency digest"),
    },
    namespace_snapshot: {
      authority_digest: assertErasureSha256(snapshot.authority_digest, "empty proof authority digest"),
      namespace_digest: assertErasureSha256(snapshot.namespace_digest, "empty proof namespace digest"),
      namespace_generation: assertErasureIdentifier(snapshot.namespace_generation, "empty proof namespace generation"),
      namespace_ref: assertErasureIdentifier(snapshot.namespace_ref, "empty proof namespace ref"),
      object_count: 0,
    },
  };
  const canonical = canonicalErasureJson({ protocol: PROTOCOL, proof: body, proof_digest: envelope.proof_digest });
  if (canonical !== text || encodeBase64Url(new TextEncoder().encode(text)) !== encoded) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "location-empty proof bytes are noncanonical or truncated");
  }
  return { body, proofDigest: assertErasureSha256(envelope.proof_digest, "empty proof digest") };
}

export async function createEmptyLocationProofTarget(
  body: EmptyLocationProofBody,
): Promise<PurgeTarget> {
  if (body.namespace_snapshot.object_count !== 0) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "nonempty namespace cannot create an empty-location proof");
  }
  const proofDigest = await erasureSha256Utf8(canonicalErasureJson(body));
  const envelope = { protocol: PROTOCOL, proof: body, proof_digest: proofDigest } as const;
  const bytes = new TextEncoder().encode(canonicalErasureJson(envelope));
  const targetId = await stableErasureId("empty-location", proofDigest);
  return {
    target_id: targetId,
    target_kind: "LOCATION_EMPTY_PROOF",
    exact_subject_ref: body.exact_subject_ref,
    location: body.location,
    canonical_ref: `${PREFIX}${encodeBase64Url(bytes)}`,
    identity_digest: proofDigest,
    shared_live_reference_count: 0,
  };
}

export async function parseEmptyLocationProof(
  target: PurgeTarget,
): Promise<EmptyLocationProofBody> {
  const { body, proofDigest } = decodeTarget(target);
  if (
    await erasureSha256Utf8(canonicalErasureJson(body)) !== proofDigest ||
    target.identity_digest !== proofDigest ||
    target.target_id !== await stableErasureId("empty-location", proofDigest) ||
    target.exact_subject_ref !== body.exact_subject_ref ||
    target.location !== body.location
  ) erasureFail("ERASURE_IDENTITY_CONFLICT", "location-empty proof target binding does not match its canonical bytes");
  return body;
}

export function assertEmptyProofSubjectRootBinding(body: EmptyLocationProofBody): void {
  const sourceRevisionSubject = `source-revision:${body.root_identity.source_revision_ref}`;
  const sourceSubject = `source:${body.root_identity.source_id}`;
  if (body.exact_subject_ref !== sourceRevisionSubject && body.exact_subject_ref !== sourceSubject) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "empty proof root does not belong to its exact selected subject");
  }
}
