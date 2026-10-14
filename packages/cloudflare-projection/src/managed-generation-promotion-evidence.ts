import { canonicalProjectionJson, projectionDigest } from "./canonical.js";
import { type ManagedGenerationPromotionEvidenceAuthorityPort, type ManagedGenerationPromotionEvidenceV2, type ManagedGenerationPromotionTarget, type ManagedGenerationDesiredManifestReadback, type ManagedGenerationCurrentAuthorityV1, type ManagedGenerationArchiveAuthorizationRequest, type ManagedGenerationArchiveAuthorizationV1 } from "./managed-generation-promotion-evidence-contract.js";
import { fail, validateManagedGenerationArchiveAuthorization, validateManagedGenerationCurrentAuthority } from "./managed-generation-promotion-evidence-validation.js";
import { validateManagedGenerationDesiredManifest, validateManagedGenerationPromotionEvidence } from "./managed-generation-promotion-evidence-manifest.js";

export * from "./managed-generation-promotion-evidence-contract.js";
export { validateManagedGenerationArchiveAuthorization, validateManagedGenerationCurrentAuthority, validateManagedGenerationPromotionHold } from "./managed-generation-promotion-evidence-validation.js";
export { validateManagedGenerationDesiredManifest, validateManagedGenerationPromotionEvidence, validateStoredManagedGenerationPromotionEvidence } from "./managed-generation-promotion-evidence-manifest.js";
export async function readManagedGenerationDesiredManifest(
  authority: ManagedGenerationPromotionEvidenceAuthorityPort,
  target: ManagedGenerationPromotionTarget,
): Promise<ManagedGenerationDesiredManifestReadback> {
  let raw: unknown;
  try {
    raw = await authority.readDesiredManifest(target);
  } catch (cause) {
    fail("MANAGED_GENERATION_EVIDENCE_UNAVAILABLE", "authoritative current desired manifest read failed", cause);
  }
  return validateManagedGenerationDesiredManifest(raw, target);
}

export async function readManagedGenerationPromotionEvidence(
  authority: ManagedGenerationPromotionEvidenceAuthorityPort,
  target: ManagedGenerationPromotionTarget,
): Promise<ManagedGenerationPromotionEvidenceV2> {
  let raw: unknown;
  try {
    raw = await authority.readCurrentEvidence(target);
  } catch (cause) {
    fail("MANAGED_GENERATION_EVIDENCE_UNAVAILABLE", "authoritative promotion evidence read failed", cause);
  }
  return validateManagedGenerationPromotionEvidence(raw, target);
}

export async function readManagedGenerationCurrentAuthority(
  authority: ManagedGenerationPromotionEvidenceAuthorityPort,
  target: ManagedGenerationPromotionTarget,
  evidence: ManagedGenerationPromotionEvidenceV2,
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
  left: ManagedGenerationPromotionEvidenceV2 | null,
  right: ManagedGenerationPromotionEvidenceV2,
): Promise<boolean> {
  if (left === null) return false;
  const { evidence_sha256: leftDigest, ...leftBody } = left;
  return leftDigest === right.evidence_sha256 &&
    (await projectionDigest(leftBody)) === right.evidence_sha256 &&
    canonicalProjectionJson(left) === canonicalProjectionJson(right);
}
