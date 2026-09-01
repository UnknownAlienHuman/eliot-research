from pathlib import Path


def replace_once(path: Path, before: str, after: str, label: str) -> None:
    source = path.read_text(encoding="utf-8")
    if before not in source:
        raise SystemExit(f"expected {label} target missing in {path}")
    path.write_text(source.replace(before, after, 1), encoding="utf-8")


resolver = Path("packages/cloudflare-evidence/src/resolver.ts")
replace_once(resolver, "  type EvidenceResolutionReceipt,\n", "", "unused evidence receipt import")
replace_once(
    resolver,
    'import { citationResolutionReceiptDigestPayload } from "./citation-registry.js";\n',
    "",
    "unused citation registry import",
)
replace_once(
    resolver,
    "  evidenceHandleIdentityPayload,\n  evidenceResolutionReceiptDigestPayload,\n",
    "  evidenceHandleIdentityPayload,\n",
    "unused evidence digest import",
)

policy_test = Path("packages/policy/src/evidence-boundary.test.ts")
old_manifest = "\n".join([
    '    allowed_source_revision_refs: ["revision-1"],',
    "    allowed_evidence_handle_refs: [handle.handle_ref],",
    "    allowed_federation_exchange_refs: [],",
    "    allowed_web_capture_refs: [],",
    '    scope_snapshot_ref: { id: "scope-1", revision: 1 },',
    '    provider_and_policy_generations: { policy: "policy-1" },',
    "    stale_or_revoked_entries: [],",
    '    client_fence_ref: "credential-1",',
    '    created_at: "2026-08-31T21:00:00.000Z",',
    '    expires_at: "2026-09-01T21:00:00.000Z",',
    "",
])
new_manifest = "\n".join([
    '    scope_snapshot_ref: { id: "scope-1", revision: 1 },',
    '    allowed_source_revision_refs: ["revision-1"],',
    "    allowed_evidence_handle_refs: [handle.handle_ref],",
    "    allowed_tool_definition_refs: [],",
    "    allowed_verifier_refs: [],",
    '    permitted_anchor_and_precision_ceilings: ["normalized_byte_range"],',
    '    provider_and_policy_generations: { policy: "policy-1" },',
    "    stale_or_revoked_entries: [],",
    "    permitted_acquisition_or_expansion_routes: [],",
    '    disclosure_ceiling: "private",',
    '    allowed_use: ["research"],',
    '    expires_at: "2026-09-01T21:00:00.000Z",',
    '    client_fence_ref: "credential-1",',
    "",
])
replace_once(policy_test, old_manifest, new_manifest, "AllowedReferenceManifest fixture")
old_claim = "\n".join([
    "  return {",
    '    claim_id: "claim-1",',
    '    claim_text: "alpha",',
    '    claim_class: "FACTUAL",',
    '    disposition: "SUPPORTED",',
    "    exact_support_handles: [handle],",
    "    counterevidence_handles: [],",
    "    coverage_receipt_refs: [],",
    '    completion_disposition: "SUCCEEDED_COMPLETE",',
    "    reason_codes: [],",
    "  };",
    "",
])
new_claim = "\n".join([
    "  return {",
    '    claim_id: "claim-1",',
    "    claim_text_digest: ALPHA,",
    '    claim_kind: "observation",',
    "    exact_support_handles: [handle],",
    "    counterevidence_handles: [],",
    '    reference_verification: "PASS",',
    '    value_or_measurement_verification: "NOT_APPLICABLE",',
    '    specification_compliance: "NOT_APPLICABLE",',
    '    method_artifact_alignment: "NOT_APPLICABLE",',
    "    source_satisfies_requirement: true,",
    "    supplied_excerpt_supports_requirement: true,",
    "    independence_and_fidelity_notes: [],",
    '    evidence_grade: "E2",',
    '    lane: "confirmatory",',
    "    coverage_limitations: [],",
    "    unsupported_precision: [],",
    '    disposition: "SUPPORTED",',
    "  };",
    "",
])
replace_once(policy_test, old_claim, new_claim, "ClaimAuditItem fixture")
replace_once(
    policy_test,
    'completion_disposition: "SUCCEEDED_COMPLETE" as const,',
    'completion_disposition: "ANSWERED_WITH_SUPPORTED_RESULT" as const,',
    "publication completion disposition",
)

service = Path("apps/eliotr-core/src/evidence-service.ts")
replace_once(
    service,
    "      return new Response(selected.bytes, { status: selected.partial ? 206 : 200, headers });\n",
    "      const responseBody = new ArrayBuffer(selected.bytes.byteLength);\n"
    "      new Uint8Array(responseBody).set(selected.bytes);\n"
    "      return new Response(responseBody, { status: selected.partial ? 206 : 200, headers });\n",
    "Worker ArrayBuffer response body",
)

print("Exact evidence source repairs: PASS")
