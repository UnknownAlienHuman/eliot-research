from pathlib import Path

helper = '''import type { FederationRequest } from "@eliotr/contracts";

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
'''
Path("apps/eliotr-core/src/federation-request-authorities.ts").write_text(
    helper,
    encoding="utf-8",
)

service_path = Path("apps/eliotr-core/src/federation-service.ts")
service = service_path.read_text(encoding="utf-8")
import_anchor = 'import { federationScopeExceedsDepth } from "./federation-scope-limits.js";\n'
import_line = 'import { federationRequestAuthorityRefs } from "./federation-request-authorities.js";\n'
if service.count(import_anchor) != 1 or import_line in service:
    raise SystemExit("request-authority import anchor missing or already applied")
service = service.replace(import_anchor, import_anchor + import_line)
authority_anchor = '''  const authorityRefs = [
    request.privacy_policy_ref,
    request.disclosure_policy_ref,
    request.retention_policy_ref,
    request.license_policy_ref,
    request.residency_profile_ref,
    request.budget_ref,
    request.stop_rule_ref,
  ];'''
authority_replacement = "  const authorityRefs = federationRequestAuthorityRefs(request);"
if service.count(authority_anchor) != 1:
    raise SystemExit("request-authority list anchor missing or ambiguous")
service_path.write_text(
    service.replace(authority_anchor, authority_replacement),
    encoding="utf-8",
)

test_path = Path("apps/eliotr-core/src/federation-service.test.ts")
test = test_path.read_text(encoding="utf-8")
title_anchor = '  it("rejects revoked handles and policy references outside the signed manifest", async () => {'
title_replacement = '  it("rejects revoked or undeclared execution authorities before reservation", async () => {'
if test.count(title_anchor) != 1:
    raise SystemExit("request-authority test title anchor missing or ambiguous")
test = test.replace(title_anchor, title_replacement)
generation_anchor = '''      "budget-1": "budget-generation-1",
      "stop-rule-1": "stop-generation-1",'''
generation_replacement = '''      "budget-1": "budget-generation-1",
      "stop-rule-1": "stop-generation-1",
      "progress-contract-1": "progress-generation-1",
      "result-schema-1": "result-schema-generation-1",'''
if test.count(generation_anchor) != 1:
    raise SystemExit("manifest generation anchor missing or ambiguous")
test = test.replace(generation_anchor, generation_replacement)
assertion_anchor = '''    await expectCode(
      createFederationService(missingBudget).submit(context(), request()),
      "FEDERATION_REFERENCE_DENIED",
    );
  });'''
assertion_replacement = '''    await expectCode(
      createFederationService(missingBudget).submit(context(), request()),
      "FEDERATION_REFERENCE_DENIED",
    );
    expect(missingBudget.jobs.reserve).not.toHaveBeenCalled();

    const { "progress-contract-1": _progressGeneration, ...withoutProgress } =
      generations;
    const missingProgress = dependencies(
      record(),
      allowedUses,
      () => manifest(allowedUses, {
        provider_and_policy_generations: withoutProgress,
      }),
    );
    await expectCode(
      createFederationService(missingProgress).submit(context(), request()),
      "FEDERATION_REFERENCE_DENIED",
    );
    expect(missingProgress.jobs.reserve).not.toHaveBeenCalled();

    const { "result-schema-1": _resultSchemaGeneration, ...withoutResultSchema } =
      generations;
    const missingResultSchema = dependencies(
      record(),
      allowedUses,
      () => manifest(allowedUses, {
        provider_and_policy_generations: withoutResultSchema,
      }),
    );
    await expectCode(
      createFederationService(missingResultSchema).submit(context(), request()),
      "FEDERATION_REFERENCE_DENIED",
    );
    expect(missingResultSchema.jobs.reserve).not.toHaveBeenCalled();

    const undeclaredExport = dependencies();
    await expectCode(
      createFederationService(undeclaredExport).submit(
        context(),
        request({ export_manifest_ref: "export-manifest-1" }),
      ),
      "FEDERATION_REFERENCE_DENIED",
    );
    expect(undeclaredExport.jobs.reserve).not.toHaveBeenCalled();
  });'''
if test.count(assertion_anchor) != 1:
    raise SystemExit("request-authority negative-test anchor missing or ambiguous")
test_path.write_text(
    test.replace(assertion_anchor, assertion_replacement),
    encoding="utf-8",
)

document_path = Path("docs/agent-work/ER-22-generic-federation-boundary.md")
document = document_path.read_text(encoding="utf-8")
document_anchor = "- `apps/eliotr-core/src/federation-scope-limits.ts`\n- `apps/eliotr-core/src/federation-service.test.ts`"
document_replacement = "- `apps/eliotr-core/src/federation-scope-limits.ts`\n- `apps/eliotr-core/src/federation-request-authorities.ts`\n- `apps/eliotr-core/src/federation-service.test.ts`"
if document.count(document_anchor) != 1:
    raise SystemExit("ER-22 document ownership anchor missing or ambiguous")
document_path.write_text(
    document.replace(document_anchor, document_replacement),
    encoding="utf-8",
)

manifest_path = Path("docs/agent-work/manifest.json")
work_manifest = manifest_path.read_text(encoding="utf-8")
manifest_anchor = '        "apps/eliotr-core/src/federation-scope-limits.ts",\n        "apps/eliotr-core/src/federation-service.test.ts"'
manifest_replacement = '        "apps/eliotr-core/src/federation-scope-limits.ts",\n        "apps/eliotr-core/src/federation-request-authorities.ts",\n        "apps/eliotr-core/src/federation-service.test.ts"'
if work_manifest.count(manifest_anchor) != 1:
    raise SystemExit("ER-22 manifest ownership anchor missing or ambiguous")
manifest_path.write_text(
    work_manifest.replace(manifest_anchor, manifest_replacement),
    encoding="utf-8",
)
