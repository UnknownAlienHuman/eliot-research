# Implementation references

[START-HERE](../START-HERE.md) explains context use. Keep the
[product manifesto](../architecture/ELIOT_RESEARCH.md) in the lead developer's context; it is not an
implementation inventory. Open the selected task and its relevant references below, not this entire catalogue.

## Current working route

| Need | Reference |
|---|---|
| What to implement, where, donors and removals | [Implementation plan](backend-entrypoints.md) |
| Existing vocabulary, source entrypoints and data owners | [Code map](dependency-map.md) |
| Storage, execution, access and input integration | [Runtime notes](runtime-contract.md) |
| Ordinary answer: actual producer/parser/result integration | [Answer note](research-full-answer-v1.md) |
| React/Vite, served assets and old browser retirement | [Cutover note](frontend-platform-migration.md) |
| Existing runs and retirement of old executors | [Execution note](workflow-checkpoints.md) |
| Check commands for the selected change | [Scoped verification](scoped-verification.md) |
| Publication and concurrent work | [Branch discipline](branch-discipline.md) |

Technical notes refine how to implement selected behavior. They cannot revive canceled scope, create
mandatory compatibility, impose per-call proof machinery or turn every helper into a separate package.
A conflict is corrected in the affected current note, not worked around with a new permanent layer.

<details>
<summary>Existing technical notes and dated evidence — not another work queue</summary>

These links keep existing files findable. They are not required reading or a declaration that all described
features are selected or finished. Check the note's date, source version and current callers when it is useful.
Status/gap registries and old Launch/S/ER programmes do not override the current plan. Old source and check
results remain historical; no check is rerun or promoted by inclusion in this list.

- [implementation-status.md](implementation-status.md)
- [implementation-status.json](implementation-status.json)
- [backend-delivery-plan.md](backend-delivery-plan.md)
- [backend-checkpoint-2026-10-08.md](backend-checkpoint-2026-10-08.md)
- [r05-local-native-qualification-2026-10-09.md](r05-local-native-qualification-2026-10-09.md)
- [s40-frozen-debt-source-2026-10-10.md](s40-frozen-debt-source-2026-10-10.md)
- [backend-contract-conflicts.md](backend-contract-conflicts.md)
- [frontend-stack-validation-2026-10-08.md](frontend-stack-validation-2026-10-08.md)
- [frontend-agent-harness.md](frontend-agent-harness.md)
- [frontend-performance-acceptance.md](frontend-performance-acceptance.md)
- [frontend-transport-audit-2026-10-08.md](frontend-transport-audit-2026-10-08.md)
- [frontend-client-extraction-inventory-2026-10-08.md](frontend-client-extraction-inventory-2026-10-08.md)
- [frontend-feature-parity-inventory-2026-10-08.md](frontend-feature-parity-inventory-2026-10-08.md)
- [frontend-cutover-inventory-2026-10-08.md](frontend-cutover-inventory-2026-10-08.md)
- [frontend-preflight-2026-10-09.md](frontend-preflight-2026-10-09.md)
- [product-resume-2026-10-02.md](product-resume-2026-10-02.md)
- [product-resume-2026-10-03.md](product-resume-2026-10-03.md)
- [audit-2026-09-25-review.md](audit-2026-09-25-review.md)
- [gap-register.md](gap-register.md)
- [checkpoints/2026-09-10/README.md](checkpoints/2026-09-10/README.md)
- [checkpoints/2026-09-10/cleanup-receipt.json](checkpoints/2026-09-10/cleanup-receipt.json)
- [production-readiness-plan.md](production-readiness-plan.md)
- [slice-gates.md](slice-gates.md)
- [release-checklist.md](release-checklist.md)
- [canonical-alignment.md](canonical-alignment.md)
- [contract-index.md](contract-index.md)
- [read-extract-proposal-cutover.md](read-extract-proposal-cutover.md)
- [branch-query-budget-selection.md](branch-query-budget-selection.md)
- [workflow-conversion-admission-cutover.md](workflow-conversion-admission-cutover.md)
- [native-external-task-wait-cutover.md](native-external-task-wait-cutover.md)
- [managed-generation-promotion-fence.md](managed-generation-promotion-fence.md)
- [research-session-projection-protocol.md](research-session-projection-protocol.md)
- [rust-kernel-abi-versioning.md](rust-kernel-abi-versioning.md)
- [failure-model.md](failure-model.md)
- [security-checklist.md](security-checklist.md)
- [toolchain.md](toolchain.md)
- [launch-prs/README.md](launch-prs/README.md)
- [launch-prs/agent-start.md](launch-prs/agent-start.md)
- [launch-prs/execution-contract.md](launch-prs/execution-contract.md)
- [launch-prs/cloudflare-handoff.md](launch-prs/cloudflare-handoff.md)
- [launch-prs/01-library.md](launch-prs/01-library.md)
- [launch-prs/09-rust.md](launch-prs/09-rust.md)
- [cloudflare-runbook.md](cloudflare-runbook.md)
- [issue-319-cookie-and-log-verification.md](issue-319-cookie-and-log-verification.md)
- [http-cache-semantics-advisory.md](http-cache-semantics-advisory.md)
- [cloudflare-usage-envelope.md](cloudflare-usage-envelope.md)
- [local-launch.md](local-launch.md)
- [owner-workspace-setup.md](owner-workspace-setup.md)
- [research-runtime-configuration.md](research-runtime-configuration.md)
- [live-document-project-acceptance-2026-09-14.md](live-document-project-acceptance-2026-09-14.md)
- [audit-2026-09-14.md](audit-2026-09-14.md)
- [audit-2026-09-09.md](audit-2026-09-09.md)
- [audit-2026-09-08.md](audit-2026-09-08.md)
- [deployment-audit-2026-09-04.md](deployment-audit-2026-09-04.md)
- [drive-rest.md](drive-rest.md)
- [drive-credentials.md](drive-credentials.md)
- [drive-oauth-admission.md](drive-oauth-admission.md)
- [gemini-spark-mcp.md](gemini-spark-mcp.md)
- [muse-operator-runbook.md](muse-operator-runbook.md)
- [computer-agent-web-inbox.md](computer-agent-web-inbox.md)
- [d1-native-representation-operator-2026-10-11.md](d1-native-representation-operator-2026-10-11.md)
- [d1-nullable-check-operator-2026-10-11.md](d1-nullable-check-operator-2026-10-11.md)
- [d1-supported-schema-representation-2026-10-11.md](d1-supported-schema-representation-2026-10-11.md)
- [http-cache-semantics-advisory-2026-10-14.md](http-cache-semantics-advisory-2026-10-14.md)
- [issue-282-cli-intake-2026-10-11.md](issue-282-cli-intake-2026-10-11.md)
- [issue-282-legacy-startup-intake-2026-10-11.md](issue-282-legacy-startup-intake-2026-10-11.md)
- [issue-282-occurrence-network-source-2026-10-11.md](issue-282-occurrence-network-source-2026-10-11.md)
- [issue-282-startup-observation-2026-10-11.md](issue-282-startup-observation-2026-10-11.md)
- [issue-333-routing-local-acceptance-2026-10-10.md](issue-333-routing-local-acceptance-2026-10-10.md)
- [maintenance-owner-web-runtime-transition.md](maintenance-owner-web-runtime-transition.md)
- [managed-target-authority-2026-10-14.md](managed-target-authority-2026-10-14.md)
- [owner-web-prepared-core-startup.md](owner-web-prepared-core-startup.md)
- [research-session-readonly-native-qualification-2026-10-11.md](research-session-readonly-native-qualification-2026-10-11.md)
- [s64-dlq-quarantine-2026-10-11.md](s64-dlq-quarantine-2026-10-11.md)
- [s64-primary-queue-ownership-2026-10-11.md](s64-primary-queue-ownership-2026-10-11.md)
- [s91-managed-registry-transaction-qualification-2026-10-11.md](s91-managed-registry-transaction-qualification-2026-10-11.md)

</details>
