# Agent work packets

The manifest is the swarm scheduler contract. One agent claims one packet and edits only its exact
`owned_paths`. Dependencies must be complete before implementation is merged; independent packets may
run in parallel. A packet is not complete without its mandatory negative case and, where named, its
real live gate.

## Use

1. Run `pnpm work-packets:check`.
2. Select a dependency-ready packet from `manifest.json`.
3. Read only this README, the packet document, its `read_only_paths`, and named architecture sections.
4. Implement, test, and hand off only the outputs named by the packet.
5. Record changed paths, contract/generation impact, commands, negative case, receipts, and unresolved
   live gates in the PR.

Do not edit another packet's barrel, package manifest, migration, fixture, or shared configuration.
Contract conflicts return to ER-01/ER-00; do not create a leaf-local alternate schema.

## Packet index

| Packet | Slice | Title | Depends on |
|---|---:|---|---|
| [ER-00](ER-00-workspace-and-verification-gates.md) | 0 | Workspace and verification gates | — |
| [ER-01](ER-01-versioned-contracts-and-schemas.md) | 0 | Versioned contracts and schemas | ER-00 |
| [ER-02](ER-02-core-deterministic-domain-state-machines.md) | 1 | Core deterministic domain state machines | ER-01 |
| [ER-03](ER-03-policy-disclosure-and-injection-boundary.md) | 1 | Policy disclosure and injection boundary | ER-01, ER-02 |
| [ER-04](ER-04-query-planner-and-fusion.md) | 1 | Query planner and fusion | ER-03, ER-30 |
| [ER-05](ER-05-structural-projector.md) | 1 | Structural projector | ER-01, ER-29 |
| [ER-06](ER-06-retrieval-lane-adapters.md) | 1 | Retrieval lane adapters | ER-05, ER-13, ER-16 |
| [ER-07](ER-07-exact-evidence-resolver-and-exhaustive-scan.md) | 1 | Exact evidence resolver and exhaustive scan | ER-02, ER-05, ER-06, ER-14 |
| [ER-08](ER-08-investigation-ledger-and-protocol.md) | 4 | Investigation ledger and protocol | ER-02, ER-03, ER-04 |
| [ER-09](ER-09-durable-research-workflow.md) | 4 | Durable research workflow | ER-08, ER-15, ER-16 |
| [ER-10](ER-10-evidence-freeze-claim-audit-and-coverage.md) | 4 | Evidence freeze claim audit and coverage | ER-07, ER-08 |
| [ER-11](ER-11-artifact-compiler.md) | 5 | Artifact compiler | ER-09, ER-10 |
| [ER-12](ER-12-research-wiki-and-draft-promotion.md) | 2 | Research Wiki and draft promotion | ER-10, ER-13, ER-14 |
| [ER-13](ER-13-d1-authority-and-migrations.md) | 0 | D1 authority and migrations | ER-00, ER-01, ER-23 |
| [ER-14](ER-14-r2-staging-residency-and-ingest.md) | 1 | R2 staging residency and ingest | ER-01, ER-03, ER-13 |
| [ER-15](ER-15-outbox-queue-and-retry-discipline.md) | 0 | Outbox Queue and retry discipline | ER-13 |
| [ER-16](ER-16-ai-search-and-model-gateway-adapters.md) | 1 | AI Search and model gateway adapters | ER-00, ER-03 |
| [ER-17](ER-17-access-observability-and-runtime-limits.md) | 0 | Access observability and runtime limits | ER-00, ER-13 |
| [ER-18](ER-18-drive-exchange-protocol-and-provisioner.md) | 0 | Drive exchange protocol and provisioner | ER-01, ER-03 |
| [ER-19](ER-19-drive-cursor-reconciliation-and-tamper-audit.md) | 0 | Drive cursor reconciliation and tamper audit | ER-13, ER-14, ER-18 |
| [ER-20](ER-20-google-oauth-port-and-result-publication.md) | 0 | Google OAuth port and result publication | ER-13, ER-14, ER-18 |
| [ER-21](ER-21-owner-and-semantic-apis.md) | 1 | Owner and semantic APIs | ER-03, ER-04, ER-13 |
| [ER-22](ER-22-generic-federation-boundary.md) | 2 | Generic federation boundary | ER-01, ER-03, ER-08, ER-21 |
| [ER-23](ER-23-testkit-and-golden-corpus-harness.md) | 0 | Testkit and Golden Corpus harness | ER-00, ER-01, ER-02, ER-03 |
| [ER-24](ER-24-worker-composition-do-queue-and-schedules.md) | 0 | Worker composition DO Queue and schedules | ER-13, ER-15, ER-17, ER-21 |
| [ER-25](ER-25-owner-pwa.md) | 1 | Owner PWA | ER-21, ER-24 |
| [ER-26](ER-26-cloudflare-provisioning-and-deployment.md) | 0 | Cloudflare provisioning and deployment | ER-00, ER-13, ER-16, ER-24 |
| [ER-27](ER-27-vertical-integration-and-live-conformance.md) | 0 | Vertical integration and live conformance | ER-09, ER-12, ER-19, ER-20, ER-22, ER-24, ER-26 |
| [ER-28](ER-28-privacy-erasure-and-purge-closure.md) | 6 | Privacy erasure and purge closure | ER-02, ER-03, ER-13, ER-14, ER-34 |
| [ER-29](ER-29-source-acquisition-admission-and-qualification.md) | 1 | Source acquisition admission and qualification | ER-02, ER-03, ER-13, ER-14 |
| [ER-30](ER-30-global-library-projects-and-scope-snapshots.md) | 1 | Global library projects and scope snapshots | ER-02, ER-13, ER-29 |
| [ER-31](ER-31-corpus-lens-navigation.md) | 3 | Corpus Lens navigation | ER-04, ER-05, ER-30 |
| [ER-32](ER-32-selective-distillation-and-argument-maps.md) | 5 | Selective distillation and argument maps | ER-07, ER-10, ER-31 |
| [ER-33](ER-33-research-steward.md) | 5 | Research Steward | ER-07, ER-12, ER-15, ER-17, ER-32 |
| [ER-34](ER-34-backup-restore-and-platform-exit.md) | 6 | Backup restore and platform exit | ER-13, ER-14, ER-17 |
| [ER-35](ER-35-specialist-corpus-profiles.md) | 7 | Specialist corpus profiles | ER-07, ER-31, ER-32 |

## Before starting a packet

Read the machine-readable `../implementation/implementation-status.json` inventory and the prioritized
`../implementation/gap-register.md`. They identify intentional fail-closed contours and the exact
evidence required to move them from scaffold to implemented and then to live-qualified.
