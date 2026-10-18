# Historical source map

Start at [START-HERE](../START-HERE.md) and use [the current plan](../implementation/backend-entrypoints.md).
These documents locate earlier implementations; their dependency lists and Owned paths are not task gates
or permanent locks. Root rules and the selected architecture supersede canceled requirements.

Frontend ER-49's checker, diagnostics, self-tests, registry and claim files have been removed from this
branch, including the optional CI provenance job and UI harness history command. Old material remains in
[Git history](https://github.com/UnknownAlienHuman/eliot-research/tree/f0f2376570216dd987f213e62631764c2232ea98/docs/agent-work),
not an optional legacy subsystem to maintain. Product/visual CI jobs remain.

The generic work-packet manifest/checker still exists. Its coordinated retirement must remove root-script,
negative-fixture and documentation-index dependencies together; this frontend cleanup does not complete that
separate task. The remaining ER-47/48 fragment paths match their documents but reserve no current scope.
Do not add packets, claim JSON, prerequisite commits or status manifests to start authorized work.

For UI work use the [delivery map](frontend-owner-execution-map.md) and [Material guidance](frontend-material-agent-playbook.md).
The owner reviews the integrated result, not each internal edit. Compile/lint during implementation;
product tests follow assembly. Unrun checks and unavailable independent review remain explicit limitations.

## Historical documents

| Reference | Earlier capability |
|---|---|
| [ER-00](ER-00-workspace-and-verification-gates.md) | Workspace and verification |
| [ER-01](ER-01-versioned-contracts-and-schemas.md) | Wire contracts |
| [ER-02](ER-02-core-deterministic-domain-state-machines.md) | Pure domain logic |
| [ER-03](ER-03-policy-disclosure-and-injection-boundary.md) | Disclosure boundaries |
| [ER-04](ER-04-query-planner-and-fusion.md) | Query planning/fusion |
| [ER-05](ER-05-structural-projector.md) | Source projections |
| [ER-06](ER-06-retrieval-lane-adapters.md) | Retrieval adapters |
| [ER-07](ER-07-exact-evidence-resolver-and-exhaustive-scan.md) | Exact evidence |
| [ER-08](ER-08-investigation-ledger-and-protocol.md) | Research records |
| [ER-09](ER-09-durable-research-workflow.md) | Research Workflow |
| [ER-10](ER-10-evidence-freeze-claim-audit-and-coverage.md) | Deep audit/coverage |
| [ER-11](ER-11-artifact-compiler.md) | Artifact writing |
| [ER-12](ER-12-research-wiki-and-draft-promotion.md) | Wiki and drafts |
| [ER-13](ER-13-d1-authority-and-migrations.md) | D1 schema |
| [ER-14](ER-14-r2-staging-residency-and-ingest.md) | R2 and source ingest |
| [ER-15](ER-15-outbox-queue-and-retry-discipline.md) | Outbox delivery |
| [ER-16](ER-16-ai-search-and-model-gateway-adapters.md) | Model/search adapters |
| [ER-17](ER-17-access-observability-and-runtime-limits.md) | Access and runtime limits |
| [ER-18](ER-18-drive-exchange-protocol-and-provisioner.md) | Unselected Drive Exchange |
| [ER-19](ER-19-drive-cursor-reconciliation-and-tamper-audit.md) | Old Drive reconciliation |
| [ER-20](ER-20-google-oauth-port-and-result-publication.md) | Google transport/publication |
| [ER-21](ER-21-owner-and-semantic-apis.md) | Owner APIs |
| [ER-22](ER-22-generic-federation-boundary.md) | Unselected general federation |
| [ER-23](ER-23-testkit-and-golden-corpus-harness.md) | Test utilities |
| [ER-24](ER-24-worker-composition-do-queue-and-schedules.md) | Worker composition |
| [ER-25](ER-25-owner-pwa.md) | Astro UI to retire |
| [ER-26](ER-26-cloudflare-provisioning-and-deployment.md) | Deployment tooling |
| [ER-27](ER-27-vertical-integration-and-live-conformance.md) | Earlier integration records |
| [ER-28](ER-28-privacy-erasure-and-purge-closure.md) | Source cleanup |
| [ER-29](ER-29-source-acquisition-admission-and-qualification.md) | Source admission |
| [ER-30](ER-30-global-library-projects-and-scope-snapshots.md) | Library and projects |
| [ER-31](ER-31-corpus-lens-navigation.md) | Lens navigation |
| [ER-32](ER-32-selective-distillation-and-argument-maps.md) | Distillation |
| [ER-33](ER-33-research-steward.md) | Earlier background research |
| [ER-34](ER-34-backup-restore-and-platform-exit.md) | Unselected backup/restore |
| [ER-35](ER-35-specialist-corpus-profiles.md) | Earlier specialist profiles |
| [ER-36](ER-36-gemini-spark-mcp-and-google-orchestration.md) | Google/MCP integrations |
| [ER-37](ER-37-governed-ingest-admission-composition.md) | Ingest composition |
| [ER-38](ER-38-governed-projection-generation-execution.md) | Projection execution |
| [ER-39](ER-39-exact-evidence-resolution.md) | Evidence resolution |
| [ER-40](ER-40-rust-canonical-identity-and-serialization.md) | Earlier Rust integration |
| [ER-41](ER-41-federation-d1-runtime.md) | Unselected federation runtime |
| [ER-43](ER-43-local-launch.md) | Local runtime isolation |
| [ER-44](ER-44-local-owner-session.md) | Local owner session |
| [ER-45](ER-45-authenticated-research-changes.md) | Research changes feed |
| [ER-46](ER-46-outbox-lifecycle-reconciliation.md) | Delivery reconciliation |
| [ER-47](ER-47-owner-web-interface.md) | Current UI capability locations |
| [ER-48](ER-48-owner-api-client-extraction.md) | Current client capability locations |
