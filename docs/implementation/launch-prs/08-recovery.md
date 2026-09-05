# Launch 08 — Erasure, backup/restore and operational release checks

Status: queued draft, unclaimed. Final integration depends on #89, #92, #93, #94 and #95; backup format,
local failure fixtures and runbooks may be implemented first. Owners ER-28/33/34/35 with ER-17/26/27
operations and ER-24 transport. Read those packets, current erasure coordinator/adapters, purge schema,
`../production-readiness-plan.md`, deployment verifier and launch-code hold before editing.

## Small sequential checkpoints

- [ ] O1. Wire the existing erasure coordinator into an explicit authorized owner/operator workflow.
  Register every canonical/derived/cached/offsite location and block incomplete closure. Legal holds,
  lifecycle/residency and current generation remain enforced; ordinary APIs cannot hard-delete.
- [ ] O2. Implement immutable backup epochs for canonical D1 state, R2 manifests, configuration and
  required receipts with exact checksums and purge frontier. Exclude secrets and transient authority
  assumptions; use bounded streaming, resumable checkpoints and verified output before marking success.
- [ ] O3. Restore into a clean isolated local state, verify identities/heads, apply the CURRENT purge
  ledger before exposing any payload, then rebuild projections. Older backup cannot resurrect erased
  data, overwrite newer authority or authorize stale clients.
- [ ] O4. Implement independent Worker/index rollback and data-restore workflows, schema preflight,
  interruption/restart/readback, destructive-step confirmation and an operator runbook. Measure local
  recovery; real clean-account RPO/RTO remains a separately recorded test.
- [ ] O5. Finish content-free health/metrics, failure diagnosis, DLQ/outbox/erasure alerts, budgets and
  spend-stop behavior. Never log credentials, source text, prompts or evidence excerpts.
- [ ] O6. Assemble T4/T5/T6 scripts/checklists from each theme: full binding/version attestation, real
  Access/D1/R2/Queue/DO/Workflow/AI Search/Google, 5/20/50 readers, outages, cost/latency and security.
  Preserve exact enabled profile and source revisions; no reduction of tests to manufacture PASS.
- [ ] O7. Add local end-to-end erase -> backup/restore -> rebuild -> authorized read tests across source,
  Investigation, Wiki/artifact and federation dependencies, including held backups and partial deletion.
- [ ] O8. Prepare the first COMPLETE staging/canary and rollback receipt procedure. Actual live effects
  wait until all mandatory code and Rust promotion are complete and account configuration is supplied.
  A code-complete draft becoming reviewable does not imply production is live-qualified.

Each stage is small tested commits, not one whole recovery subsystem per agent task. Reuse ER-28 exact
closure; do not create another purge ledger or weaken the existing launch gate. Shared schema/binding
changes require current owner review and full local migration regression.

## Completion

Require repository/Rust gates, exact-head CI, clean-local restore tests and the applicable UI/operator
negative cases. Keep draft until O1–O8 implementation and retained LOCAL evidence are complete. Report
unexecuted remote checks explicitly; production release needs actual immutable live receipts, security
resolution, tested rollback, RPO/RTO and cost/load acceptance from the normative plan. No partial
Cloudflare deployment for continued application development and no 'backup exists' restore claim.
