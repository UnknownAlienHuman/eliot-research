# Launch 04 — Governed Research Workflow and durable sessions

Status: queued draft, unclaimed. Integration dependency: #90 retrieval; #91 only for protocols that use
structural navigation. Owners ER-08/09/10/20; ER-24 DO/HTTP composition; ER-25 job UI. Read those packets,
`apps/eliotr-core/src/research-workflow.ts`, `research-session.ts`, `packages/research`, Workflow stage
contracts and exact nine CompletionDisposition definitions. Scope and evidence ports are reused.

## Small sequential checkpoints

- [ ] W1. Persist Investigation/protocol/checkpoint identity under principal, scope, policy, generation,
  request digest and idempotency key. Add guarded create/replay/attempt/readback; retries never invent
  completion. Allocate schema changes against current main with ER-13 permission.
- [ ] W2. Implement one monotone stage transition at a time through existing pure domain decisions.
  Durable D1/R2 checkpoints are authoritative; Workflow engine state and Queue ACK are not.
- [ ] W3. Compose retrieval/provider/model boundaries with cancellation and budget checks before and
  after expensive calls. Persist attempts and raw result receipts; reconcile uncertain/lost ACK. Where
  a provider cannot guarantee idempotency, surface uncertainty rather than promise no double charge.
- [ ] W4. Implement Evidence Freeze, explicit reopen, counter-search, hypothesis/obligation accounting,
  claim audit and one of exactly nine honest terminal dispositions. Unresolved citations block output.
- [ ] W5. Implement hibernation-safe ResearchSession transport with D1/R2 reconstruction, bounded
  WebSocket subscribers/backpressure and reconnect cursor. Deleting transient DO/Queue state cannot
  delete an Investigation. Sessions cannot grant domain authority or report transport completion as proof.
- [ ] W6. Wire `research.run`, status/progress/result/cancel and ER-25 investigation/job panels; define
  versioned transport additions with ER-21 rather than inventing parallel route families.
- [ ] W7. Exercise every checkpoint interruption, budget stop, cancellation race, provider loss, duplicate
  delivery, DO restart/reconnect and partial terminal evidence in actual Workers/D1/R2 tests; add the
  browser start -> observe -> disconnect/reconnect -> cancel/result loop and representative protocols.

Each checkpoint is multiple small commits when needed: one transition/adapter plus negative tests, not
one oversized task. Rust migration remains Launch 09; keep one transitional authority per decision and
feed stable behavior into differential fixtures. No new agent framework or alternate workflow service.

## Completion

Replace the two registered Workflow/Session scaffolds only with executable negative-tested paths and
honest implementation state. Run repository and Rust gates, strict Workers tests, exact-head CI,
local boot and browser integration. Keep draft until W1–W7 pass. Code completion can be local;
Workflow/DO real retry, hibernation and provider cost receipts remain separate NOT_EXECUTED gates until
the complete staging trial. No partial product deployment and no mocked research marked complete.
