import { canonicalProjectionJson, projectionDigest } from "./canonical.js";
import { type ManagedGenerationPromotionEvidenceAuthorityPort, type ManagedGenerationPromotionEvidence, type ManagedGenerationPromotionTarget, type ManagedGenerationDesiredManifestReadbackValue, type ManagedGenerationCurrentAuthorityV1, type ManagedGenerationArchiveAuthorizationRequest, type ManagedGenerationArchiveAuthorizationV1 } from "./managed-generation-promotion-evidence-contract.js";
import { fail, validateManagedGenerationArchiveAuthorization, validateManagedGenerationCurrentAuthority } from "./managed-generation-promotion-evidence-validation.js";
import { validateManagedGenerationDesiredManifest, validateManagedGenerationPromotionEvidence } from "./managed-generation-promotion-evidence-manifest.js";
import {
  validateManagedGenerationDesiredManifestV3,
  validateManagedGenerationPromotionEvidenceV3,
  validateStoredManagedGenerationPromotionEvidenceV3,
} from "./managed-generation-promotion-evidence-v3.js";
import { validateStoredManagedGenerationPromotionEvidence } from "./managed-generation-promotion-evidence-manifest.js";

export * from "./managed-generation-promotion-evidence-contract.js";
export { validateManagedGenerationArchiveAuthorization, validateManagedGenerationCurrentAuthority, validateManagedGenerationPromotionHold } from "./managed-generation-promotion-evidence-validation.js";
export { validateManagedGenerationDesiredManifest, validateManagedGenerationPromotionEvidence, validateStoredManagedGenerationPromotionEvidence } from "./managed-generation-promotion-evidence-manifest.js";
export { validateManagedGenerationDesiredManifestV3, validateManagedGenerationPromotionEvidenceV3, validateStoredManagedGenerationPromotionEvidenceV3 };

function protocolOf(raw: unknown): unknown {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>).protocol : undefined;
}

export async function validateStoredManagedGenerationPromotionEvidenceValue(raw: unknown, target: ManagedGenerationPromotionTarget): Promise<ManagedGenerationPromotionEvidence> {
  return protocolOf(raw) === "eliotr.managed-generation-promotion-evidence.v3"
    ? validateStoredManagedGenerationPromotionEvidenceV3(raw, target)
    : validateStoredManagedGenerationPromotionEvidence(raw, target);
}
export async function readManagedGenerationDesiredManifest(
  authority: ManagedGenerationPromotionEvidenceAuthorityPort,
  target: ManagedGenerationPromotionTarget,
): Promise<ManagedGenerationDesiredManifestReadbackValue> {
  let raw: unknown;
  try {
    raw = await authority.readDesiredManifest(target);
  } catch (cause) {
    fail("MANAGED_GENERATION_EVIDENCE_UNAVAILABLE", "authoritative current desired manifest read failed", cause);
  }
  return protocolOf(raw) === "eliotr.managed-target-desired-items.v3"
    ? validateManagedGenerationDesiredManifestV3(raw, target)
    : validateManagedGenerationDesiredManifest(raw, target);
}

export async function readManagedGenerationPromotionEvidence(
  authority: ManagedGenerationPromotionEvidenceAuthorityPort,
  target: ManagedGenerationPromotionTarget,
): Promise<ManagedGenerationPromotionEvidence> {
  let raw: unknown;
  try {
    raw = await authority.readCurrentEvidence(target);
  } catch (cause) {
    fail("MANAGED_GENERATION_EVIDENCE_UNAVAILABLE", "authoritative promotion evidence read failed", cause);
  }
  return protocolOf(raw) === "eliotr.managed-generation-promotion-evidence.v3"
    ? validateManagedGenerationPromotionEvidenceV3(raw, target)
    : validateManagedGenerationPromotionEvidence(raw, target);
}

export async function readManagedGenerationCurrentAuthority(
  authority: ManagedGenerationPromotionEvidenceAuthorityPort,
  target: ManagedGenerationPromotionTarget,
  evidence: ManagedGenerationPromotionEvidence,
): Promise<ManagedGenerationCurrentAuthorityV1> {
  let raw: unknown;
  try {
    raw = await authority.readFreshCurrentAuthority(target, evidence);
  } catch (cause) {
    fail(
      "MANAGED_GENERATION_EVIDENCE_UNAVAILABLE",
      "fresh trusted-time target authority read failed",
      cause,
    );
  }
  return validateManagedGenerationCurrentAuthority(raw, target, evidence);
}

export async function readManagedGenerationArchiveAuthorization(
  authority: ManagedGenerationPromotionEvidenceAuthorityPort,
  input: ManagedGenerationArchiveAuthorizationRequest,
): Promise<ManagedGenerationArchiveAuthorizationV1> {
  let raw: unknown;
  try {
    raw = await authority.readGenerationArchiveAuthorization(input);
  } catch (cause) {
    fail(
      "MANAGED_GENERATION_ARCHIVE_DENIED",
      "authoritative archive and rollback-window read failed",
      cause,
    );
  }
  return validateManagedGenerationArchiveAuthorization(raw, input);
}

export async function sameManagedGenerationPromotionEvidence(
  left: ManagedGenerationPromotionEvidence | null,
  right: ManagedGenerationPromotionEvidence,
): Promise<boolean> {
  if (left === null) return false;
  const { evidence_sha256: leftDigest, ...leftBody } = left;
  return leftDigest === right.evidence_sha256 &&
    (await projectionDigest(leftBody)) === right.evidence_sha256 &&
    canonicalProjectionJson(left) === canonicalProjectionJson(right);
}
