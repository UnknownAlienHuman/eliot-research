# Agent work packets

New to the repository? Read [`docs/START-HERE.md`](../START-HERE.md) first.

The manifest plus validated fragments reserve exclusive write ownership. A packet is not complete without its
mandatory negative case and any named live/human gate. Product work still follows the active checkpoint and
repository stop/resume state.

## Use

1. Run `pnpm work-packets:check`.
2. Select a dependency-ready leaf packet, or claim an owner-authorized ER-47/ER-48 manager packet and use its
   exact leaf map plus [frontend-autonomous-manager-runbook.md](frontend-autonomous-manager-runbook.md).
3. Read this index, packet document and only contracts/source named by exact checkpoint.
4. Claim one checkpoint, not an undefined subsystem portion.
5. Edit only packet-owned and exact delegated leaf paths.
6. Record paths, contract/generation effect, commands, negative case, evidence and unresolved gates.

Do not edit another packet's barrel, package manifest, migration, claim directory, fixture or shared
configuration. A contract conflict returns to its owner; do not create a leaf-local schema.

## Packet and checkpoint semantics

Most packets are leaf-sized. ER-47/48 are manager/reservation packets spanning disjoint feature families while
preserving one client and one UI authority. ER-49 is their independent scheduler packet. The manager follows
`frontend-autonomous-manager-runbook.md` and `frontend-notebooklm-material-reference.md` and continues F1-F4
through U5-X without intermediate owner prompts.

For ER-47/48:

- one manager owns one direct-main or single worktree/review context explicitly authorized by the owner;
- subagents receive one exact checkpoint from
  [`frontend-owner-execution-map.md`](frontend-owner-execution-map.md);
- subagents create no branch/worktree, shared barrel, manifest or competing framework;
- manager serializes package-local shared files and coherent publication;
- coarse packet dependencies are intentionally empty; exact prerequisites/handoffs live in execution map;
- ER-25 is compatibility baseline, not completion dependency;
- manager context does not lift implementation stop or authorize deployment; a tranche authorization lets the
  manager continue through its ready checkpoints without repeated owner prompts.

ER-49 owns static definitions/checker only. ER-47/48 own separate claim directories and cannot edit registry
or each other's claims.

Before ER-49 acceptance, maximum concurrency is one frontend manager plus one leaf. Afterward:

- every source edit is covered by an active claim committed in a strict ancestor;
- claim and covered source cannot first appear in the same commit;
- one checkpoint ID has at most one active claim;
- all active claims in a packet share one owner-authorized manager context;
- parallel claims use dependency-ready IDs and disjoint canonical paths;
- predecessor refs identify checkpoint and ancestor commit; manager/external gates also require an approval
  reference;
- ER-49 validates structure/scope/ancestry, while manager/operator review decides whether evidence and approval
  are substantively valid.

ER-49 is optional for parallelism. If its implementation becomes a general workflow engine, stay sequential.

The execution map grants no new root/Worker/CI/deploy ownership. ER-00 may integrate accepted scheduler command
into root CI without taking scheduler authority.

ER-25 retains served compatibility behavior. Its bounded cutover exception is U6 retirement-safe rollback:
accepted online legacy behavior with root `/sw.js` registration disabled, old fetch/cache worker never restored,
and exact retirement helper retained. It is release safety, not a second product direction. Permanent inert
`/sw.js` remains after rollback artifact retirement.

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
| [ER-10](ER-10-evidence-freeze-claim-audit-and-coverage.md) | 4 | Evidence freeze, claim audit and coverage | ER-07, ER-08 |
| [ER-11](ER-11-artifact-compiler.md) | 5 | Artifact compiler | ER-09, ER-10 |
| [ER-12](ER-12-research-wiki-and-draft-promotion.md) | 2 | Research Wiki and draft promotion | ER-10, ER-13, ER-14 |
| [ER-13](ER-13-d1-authority-and-migrations.md) | 0 | D1 authority and migrations | ER-00, ER-01, ER-23 |
| [ER-14](ER-14-r2-staging-residency-and-ingest.md) | 1 | R2 staging, residency and ingest | ER-01, ER-03, ER-13 |
| [ER-15](ER-15-outbox-queue-and-retry-discipline.md) | 0 | Outbox Queue and retry discipline | ER-13 |
| [ER-16](ER-16-ai-search-and-model-gateway-adapters.md) | 1 | AI Search and model gateway adapters | ER-00, ER-03 |
| [ER-17](ER-17-access-observability-and-runtime-limits.md) | 0 | Access, observability and runtime limits | ER-00, ER-13 |
| [ER-18](ER-18-drive-exchange-protocol-and-provisioner.md) | 0 | Drive exchange protocol and provisioner | ER-01, ER-03 |
| [ER-19](ER-19-drive-cursor-reconciliation-and-tamper-audit.md) | 0 | Drive cursor reconciliation and tamper audit | ER-13, ER-14, ER-18 |
| [ER-20](ER-20-google-oauth-port-and-result-publication.md) | 0 | Google OAuth port and result publication | ER-13, ER-14, ER-18 |
| [ER-21](ER-21-owner-and-semantic-apis.md) | 1 | Owner and semantic APIs | ER-03, ER-04, ER-13 |
| [ER-22](ER-22-generic-federation-boundary.md) | 2 | Generic federation boundary | ER-01, ER-03, ER-08, ER-21 |
| [ER-23](ER-23-testkit-and-golden-corpus-harness.md) | 0 | Testkit and Golden Corpus harness | ER-00, ER-01, ER-02, ER-03 |
| [ER-24](ER-24-worker-composition-do-queue-and-schedules.md) | 0 | Worker composition, DO, Queue and schedules | ER-13, ER-15, ER-17, ER-21 |
| [ER-25](ER-25-owner-pwa.md) | 1 | Legacy owner PWA and accepted browser behavior | ER-21, ER-24 |
| [ER-26](ER-26-cloudflare-provisioning-and-deployment.md) | 0 | Cloudflare provisioning and deployment | ER-00, ER-13, ER-16, ER-24 |
| [ER-27](ER-27-vertical-integration-and-live-conformance.md) | 0 | Vertical integration and live conformance | ER-09, ER-12, ER-19, ER-20, ER-22, ER-24, ER-26 |
| [ER-28](ER-28-privacy-erasure-and-purge-closure.md) | 6 | Privacy, erasure and purge closure | ER-02, ER-03, ER-13, ER-14, ER-34 |
| [ER-29](ER-29-source-acquisition-admission-and-qualification.md) | 1 | Source acquisition, admission and qualification | ER-02, ER-03, ER-13, ER-14 |
| [ER-30](ER-30-global-library-projects-and-scope-snapshots.md) | 1 | Global library, projects and scope snapshots | ER-02, ER-13, ER-29 |
| [ER-31](ER-31-corpus-lens-navigation.md) | 3 | Corpus Lens navigation | ER-04, ER-05, ER-30 |
| [ER-32](ER-32-selective-distillation-and-argument-maps.md) | 5 | Selective distillation and argument maps | ER-07, ER-10, ER-31 |
| [ER-33](ER-33-research-steward.md) | 5 | Research Steward | ER-07, ER-12, ER-15, ER-17, ER-32 |
| [ER-34](ER-34-backup-restore-and-platform-exit.md) | 6 | Backup, restore and platform exit | ER-13, ER-14, ER-17 |
| [ER-35](ER-35-specialist-corpus-profiles.md) | 7 | Specialist corpus profiles | ER-07, ER-31, ER-32 |
| [ER-40](ER-40-rust-canonical-identity-and-serialization.md) | — | Rust canonical identity and serialization | ER-00, ER-01, ER-02, ER-23 |

## Additive packet fragments

Fragments under [`packets/`](packets/) use protocol `eliotr.agent-work.packet.v1`.
`scripts/check-work-packets.mjs` merges them after checking duplicate IDs, ownership overlap, document/path
synchronization and dependency cycles. A fragment cannot override an existing packet.

| Packet | Slice | Title | Depends on |
|---|---:|---|---|
| [ER-36](ER-36-gemini-spark-mcp-and-google-orchestration.md) | — | Gemini Spark / Antigravity MCP and Google orchestration | ER-17, ER-18, ER-20, ER-21, ER-24, ER-26 |
| [ER-37](ER-37-governed-ingest-admission-composition.md) | — | Governed ingest admission composition | ER-13, ER-14, ER-21, ER-24, ER-29 |
| [ER-38](ER-38-governed-projection-generation-execution.md) | — | Governed projection-generation execution | ER-05, ER-06, ER-13, ER-15, ER-16, ER-24, ER-29, ER-37 |
| [ER-39](ER-39-exact-evidence-resolution.md) | — | Exact evidence resolution and citation gate | ER-01, ER-02, ER-03, ER-06, ER-07, ER-11, ER-13, ER-19, ER-21, ER-24, ER-37, ER-38 |
| [ER-41](ER-41-federation-d1-runtime.md) | — | Federation D1 runtime authority | ER-13, ER-22, ER-24 |
| [ER-43](ER-43-local-launch.md) | — | Local runtime isolation and restart regression | ER-00, ER-24, ER-26 |
| [ER-44](ER-44-local-owner-session.md) | — | Local signed owner session and explicit read-policy setup | ER-21, ER-24, ER-26, ER-43 |
| [ER-45](ER-45-authenticated-research-changes.md) | — | Authenticated research changes feed | ER-13, ER-21, ER-24, ER-36 |
| [ER-46](ER-46-outbox-lifecycle-reconciliation.md) | — | Outbox lifecycle reconciliation | ER-13, ER-15, ER-24 |
| [ER-47](ER-47-owner-web-interface.md) | — | React owner web manager packet | — |
| [ER-48](ER-48-owner-api-client-extraction.md) | — | Owner API client manager packet and legacy compatibility | — |
| [ER-49](ER-49-frontend-leaf-scheduler.md) | — | Frontend leaf scheduler and claim validation | — |

ER-47 owns React/UI/harness paths and its claims. ER-48 owns mixed legacy browser packages, extracts one pure
owner client and owns its claims. ER-49 owns static scheduling definitions/checks. Shared root, Worker, CI and
cutover work remains serialized with named owner.

## Before starting

Read `../implementation/implementation-status.json` and `../implementation/gap-register.md`, then the exact
execution-map block. A compiling DTO, configured client, claim, component story, package-local build or pretty screenshot is not
implemented/live-qualified product behavior. U1-D and U2-X are internal manager gates; final owner review occurs
after the complete U5-X interface is ready.
