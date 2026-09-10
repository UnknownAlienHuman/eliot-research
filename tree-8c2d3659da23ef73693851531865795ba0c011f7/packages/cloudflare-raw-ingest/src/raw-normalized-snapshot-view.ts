import { canonicalJson, sha256Utf8 } from "@eliotr/platform-cloudflare";
import {
  SNAPSHOT_VIEW_PROTOCOL,
  SNAPSHOT_VIEW_REF_PREFIX,
  type RawNormalizedCapture,
  type SnapshotViewObservationFreshness,
  type SnapshotViewWitness,
} from "./raw-normalized-types.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;

export class SnapshotViewError extends Error {
  public readonly code: "SNAPSHOT_VIEW_INVALID" | "SNAPSHOT_VIEW_MISMATCH";

  public constructor(code: SnapshotViewError["code"], message: string) {
    super(message);
    this.name = "SnapshotViewError";
    this.code = code;
  }
}

function fail(code: SnapshotViewError["code"], message: string): never {
  throw new SnapshotViewError(code, message);
}

function id(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) fail("SNAPSHOT_VIEW_INVALID", `${label} is invalid`);
}

function digest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) fail("SNAPSHOT_VIEW_INVALID", `${label} is invalid`);
}

function descriptor(witness: SnapshotViewWitness): Record<string, unknown> {
  return {
    protocol: witness.protocol,
    capture_id: witness.capture_id,
    source_revision_ref: witness.source_revision_ref,
    source_logical_id: witness.source_logical_id,
    verified_principal_ref: witness.verified_principal_ref,
    owner_system_id: witness.owner_system_id,
    source_namespace_id: witness.source_namespace_id,
    source_owner_generation: witness.source_owner_generation,
    original_sha256: witness.original_sha256,
    original_size_bytes: witness.original_size_bytes,
    residency_key_digest: witness.residency_key_digest,
    policy_snapshot_sha256: witness.policy_snapshot_sha256,
    policy_revision: witness.policy_revision,
    observed_at: witness.observed_at,
    observation_freshness: witness.observation_freshness,
  };
}

export async function snapshotViewRef(witness: SnapshotViewWitness): Promise<string> {
  const digestValue = await sha256Utf8(canonicalJson(descriptor(witness)));
  return `${SNAPSHOT_VIEW_REF_PREFIX}${digestValue}`;
}

export async function createSnapshotViewWitness(input: {
  readonly capture: RawNormalizedCapture;
  readonly policy_snapshot_sha256: string;
  readonly policy_revision: number;
  readonly observed_at: string;
  readonly observation_freshness: SnapshotViewObservationFreshness;
}): Promise<SnapshotViewWitness> {
  const witness: SnapshotViewWitness = {
    protocol: SNAPSHOT_VIEW_PROTOCOL,
    source_view_ref: "pending",
    capture_id: input.capture.capture_id,
    source_revision_ref: input.capture.source_revision_ref,
    source_logical_id: input.capture.source_logical_id,
    verified_principal_ref: input.capture.principal_ref,
    owner_system_id: input.capture.owner_system_id,
    source_namespace_id: input.capture.source_namespace_id,
    source_owner_generation: input.capture.source_owner_generation,
    original_sha256: input.capture.content_sha256,
    original_size_bytes: input.capture.size_bytes,
    residency_key_digest: input.capture.residency_key_digest,
    policy_snapshot_sha256: input.policy_snapshot_sha256,
    policy_revision: input.policy_revision,
    observed_at: input.observed_at,
    observation_freshness: input.observation_freshness,
  };
  return Object.freeze({ ...witness, source_view_ref: await snapshotViewRef(witness) });
}

export async function verifySnapshotViewWitness(
  witness: SnapshotViewWitness,
  capture: RawNormalizedCapture,
  expected: { readonly policy_snapshot_sha256: string; readonly policy_revision: number },
): Promise<void> {
  const witnessKeys = ["protocol", "source_view_ref", "capture_id", "source_revision_ref", "source_logical_id", "verified_principal_ref", "owner_system_id", "source_namespace_id", "source_owner_generation", "original_sha256", "original_size_bytes", "residency_key_digest", "policy_snapshot_sha256", "policy_revision", "observed_at", "observation_freshness"];
  if (Object.keys(witness).length !== witnessKeys.length || witnessKeys.some((key) => !Object.hasOwn(witness, key))) {
    fail("SNAPSHOT_VIEW_INVALID", "snapshot view contains unknown or missing fields");
  }
  if (witness.protocol !== SNAPSHOT_VIEW_PROTOCOL ||
      !witness.source_view_ref.startsWith(SNAPSHOT_VIEW_REF_PREFIX) ||
      witness.source_view_ref.length !== SNAPSHOT_VIEW_REF_PREFIX.length + 64) {
    fail("SNAPSHOT_VIEW_INVALID", "snapshot view does not use the reserved versioned reference family");
  }
  for (const [label, value] of Object.entries({
    capture_id: witness.capture_id,
    source_revision_ref: witness.source_revision_ref,
    source_logical_id: witness.source_logical_id,
    verified_principal_ref: witness.verified_principal_ref,
    owner_system_id: witness.owner_system_id,
    source_namespace_id: witness.source_namespace_id,
    source_owner_generation: witness.source_owner_generation,
  })) id(value, label);
  digest(witness.original_sha256, "original_sha256");
  digest(witness.residency_key_digest, "residency_key_digest");
  digest(witness.policy_snapshot_sha256, "policy_snapshot_sha256");
  if (!Number.isSafeInteger(witness.original_size_bytes) || witness.original_size_bytes < 1 ||
      !Number.isSafeInteger(witness.policy_revision) || witness.policy_revision < 1 ||
      !ISO.test(witness.observed_at) || new Date(witness.observed_at).toISOString() !== witness.observed_at ||
      (witness.observation_freshness !== "observed_with_age" && witness.observation_freshness !== "unknown")) {
    fail("SNAPSHOT_VIEW_INVALID", "snapshot view bounds or observation timestamp are invalid");
  }
  if (witness.capture_id !== capture.capture_id || witness.source_revision_ref !== capture.source_revision_ref ||
      witness.source_logical_id !== capture.source_logical_id || witness.verified_principal_ref !== capture.principal_ref ||
      witness.owner_system_id !== capture.owner_system_id || witness.source_namespace_id !== capture.source_namespace_id ||
      witness.source_owner_generation !== capture.source_owner_generation || witness.original_sha256 !== capture.content_sha256 ||
      witness.original_size_bytes !== capture.size_bytes || witness.residency_key_digest !== capture.residency_key_digest ||
      witness.policy_snapshot_sha256 !== expected.policy_snapshot_sha256 || witness.policy_revision !== expected.policy_revision) {
    fail("SNAPSHOT_VIEW_MISMATCH", "snapshot view is not bound to the captured source and current policy snapshot");
  }
  if (await snapshotViewRef(witness) !== witness.source_view_ref) {
    fail("SNAPSHOT_VIEW_MISMATCH", "snapshot view reference does not match its immutable descriptor");
  }
}
