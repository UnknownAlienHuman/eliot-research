import type { ScopeSnapshot } from "@eliotr/contracts";
import { canonicalJson } from "@eliotr/platform-cloudflare";
import type { EvidenceAccessContext, EvidenceSourceAuthority, ScopeAuthorization } from "@eliotr/cloudflare-evidence";
import { failArtifactDraftRead as fail } from "./artifact-draft-reader-contracts.js";

export function sameScopeForReauthorization(original: ScopeSnapshot, fresh: ScopeSnapshot, leaseRefreshProven = false): boolean {
  const originalParticipants = { ...original.participant_generations };
  const freshParticipants = { ...fresh.participant_generations };
  if (leaseRefreshProven) {
    delete originalParticipants["member-policy-closure"];
    delete freshParticipants["member-policy-closure"];
  }
  return canonicalJson(original.resolved_scope_expression) === canonicalJson(fresh.resolved_scope_expression) &&
    canonicalJson([...original.member_source_revision_refs].sort()) === canonicalJson([...fresh.member_source_revision_refs].sort()) &&
    canonicalJson(original.source_owner_generations) === canonicalJson(fresh.source_owner_generations) &&
    canonicalJson(originalParticipants) === canonicalJson(freshParticipants) &&
    original.disclosure_closure_digest === fresh.disclosure_closure_digest &&
    fresh.purge_ledger_revision >= original.purge_ledger_revision;
}

export function reauthorizedSourceFingerprint(
  sources: readonly EvidenceSourceAuthority[],
  refs: readonly string[],
  scope: ScopeSnapshot,
  grant: ScopeAuthorization,
): string {
  if (sources.length !== refs.length) fail("ARTIFACT_DRAFT_READ_STALE", 410, "draft source authorization is incomplete");
  const expectedRefs = [...refs].sort();
  const actualRefs = sources.map((source) => source.source_revision_ref).sort();
  if (canonicalJson(expectedRefs) !== canonicalJson(actualRefs)) fail("ARTIFACT_DRAFT_READ_STALE", 410, "draft source authorization changed");
  if (!grant.allowed_use.includes("research")) fail("ARTIFACT_DRAFT_READ_DENIED", 403, "draft read authorization denied");
  for (const source of sources) {
    if (source.purge_state !== "LIVE" || scope.source_owner_generations[source.source_revision_ref] !== source.source_owner_generation ||
        source.disclosure_ceiling !== grant.disclosure_ceiling || source.allowed_use.some((use) => !grant.allowed_use.includes(use)) ||
        !source.allowed_use.includes("research")) {
      fail("ARTIFACT_DRAFT_READ_STALE", 410, "draft source authorization is stale");
    }
  }
  return canonicalJson([...sources].sort((left, right) => left.source_revision_ref < right.source_revision_ref ? -1 : 1));
}

export function reauthorizedAccessMatches(left: EvidenceAccessContext, right: EvidenceAccessContext): boolean {
  return left.principal_ref === right.principal_ref && left.client_class === right.client_class &&
    left.credential_generation === right.credential_generation;
}
