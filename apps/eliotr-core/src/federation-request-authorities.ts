import type { FederationRequest } from "@eliotr/contracts";

export function federationRequestAuthorityRefs(
  request: FederationRequest,
): readonly string[] {
  return [
    request.privacy_policy_ref,
    request.disclosure_policy_ref,
    request.retention_policy_ref,
    request.license_policy_ref,
    request.residency_profile_ref,
    request.budget_ref,
    request.stop_rule_ref,
    request.progress_contract_ref,
    request.required_result_schema_ref,
    ...(request.export_manifest_ref === undefined
      ? []
      : [request.export_manifest_ref]),
  ];
}
