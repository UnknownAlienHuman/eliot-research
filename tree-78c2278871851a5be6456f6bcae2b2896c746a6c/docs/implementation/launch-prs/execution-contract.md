# Agent execution and acceptance contract

Applies to the nine owner-requested launch themes. Reviewed against executable baseline
`f94bd7a2a8e94df7d5365f120927708d7a287b43`, ELIOT_RESEARCH **29.1** and LANGUAGE_RUNTIME_CONTRACT
**1.0**. This is an implementation assignment, not a change to either canonical contract and not a
claim that an unchecked feature exists. Use current main plus the theme plan; old PR comments are
historical when contradicted by these reviewed tasks.

## 1. Mandatory reading and authority

Read `AGENTS.md`, the theme's named ER packet, its explicit canonical sections, adjacent public schemas,
`docs/implementation/{runtime-contract,failure-model,security-checklist}.md`, current
`implementation-status.json` and `gap-register.md`. Canonical files:

- `docs/architecture/ELIOT_RESEARCH.md`: product, state ownership, precision, privacy and T0–T6.
- `docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md`: TS control plane, pure Rust authority, SQL,
  versioned ABI, test/budget gates and M5 shadow / M6 promotion / M7 removal.
- Accepted `docs/adr/` decisions qualify those contracts; a task cannot silently supersede them.

Checkpoints below are subdivisions of existing packets, NOT new state owners. `Files` means the named
owner's edit scope; another owner still controls shared changes. Register a new source/test file in the
owning packet document and manifest together before use. Proposed paths/commands in a task are explicitly
work to create, not an assertion they already run. Do not copy contract SQL sketches over current migrations.

## 2. Claim, branch and integration procedure

Post in the existing theme PR: checkpoint ID, current main SHA, exact files, ER owner, predecessors'
accepted SHAs and intended tests. Read other active claims. One agent = one task/worktree/branch.
Reuse the theme's reserved head; incorporate current main without force/reset or dropping other work.
Resolve conflicts before implementation and verify the resulting tree. The nine planning reservations
in branch-discipline.md do not authorize nine simultaneous implementation worktrees.

One integrator serializes `composition-root.ts`, HTTP/routes/Env, barrels, package/Cargo manifests,
lockfiles, CI, generated bindings, schema registry and migration numbers. ER-13 allocates additive
migrations against current main; ER-00 owns toolchain/locks; ER-21/24 own public DTO/route/runtime
composition; ER-25 owns all PWA work; ER-27 owns `tests/integration/**`. An unclaimed shared edit is not
permission. Finish or explicitly hand off the current checkpoint before taking another.

The first three independent assignments are Q1 (#90), G1 (#95), K1 (#97), scoped as in agent-start.md.
The Library browser-harness task L1 can replace one of these, not add a conflicting fourth UI worker.

## 3. Implement each checkpoint this way

1. Reproduce the missing behavior with a failing test at the stated real boundary. Inspect existing
   ports/adapters and reuse implemented code; a source sentinel is not permission to write a parallel stack.
2. Implement the narrow state transition or adapter, then its caller. Mutations use
   Intent -> Attempt -> Receipt -> Readback -> Reconciliation. Canonical mutation/outbox commit together;
   no HTTP, model, R2 or crypto effect inside D1 transactions. A lost ACK is UNKNOWN, not permission for
   a replacement identity or blind paid retry. Recheck current authority after external work.
3. Add negative tests and inspect persisted rows/objects, not just a mock invocation count. Show exact
   duplicate behavior, stale CAS, purge/revocation, expiry and cancellation at the expensive boundary.
4. Wire the tested path into the existing Worker/API/PWA in its integration checkpoint. Dead helpers,
   disabled buttons, interface-only ports and success fixtures do not complete a user loop.
5. Update registry/gaps and the theme checklist in the same implementation change. New deterministic
   semantics require versioned differential fixtures and the target Rust crate from language §5.2.
   Never rename public enums/fields or introduce a tenth CompletionDisposition without normative review.

Minimum bound tests: maximum valid and maximum+1; zero/negative where disallowed; malformed UTF-8/JSON,
unknown load-bearing keys, forged identifiers, foreign owner/scope/generation, partial response, timeout,
restart, lost write response and concurrent replay. Bound reads before allocation and use immutable
handles/cursors for larger content. Existing narrower component limits win over global ceilings.

## 4. Commands and test environment

From the repository root, use pinned tools in `docs/implementation/toolchain.md`:

```text
pnpm install --frozen-lockfile
pnpm check:affected
pnpm exec tsc -p apps/eliotr-core/test/tsconfig.json --pretty false
pnpm build:pwa
pnpm cf:types
pnpm cf:dry-run
pnpm test:local-launch
pnpm test:local-owner
pnpm local:smoke
```

`check:affected` currently runs the full repository/Rust chain; it is not an incremental shortcut.
While iterating use `pnpm exec vitest run <exact-root-test-path>` or
`pnpm --filter @eliotr/core exec vitest run <exact-Worker-test-path>`; finish with the full commands above.
Federation storage additionally runs `pnpm --filter @eliotr/cloudflare-federation test`.
Rust tasks run `pnpm rust:check`, plus applicable pinned fuzz/property/Miri/mutation/pre-release gates.
Do not substitute a system compiler or upgrade a dependency to hide a failure.

`pnpm test:library-browser` EXISTS and uses the built PWA with controlled HTTP. It is useful but does not
satisfy the complete real-storage Playwright loop. L1 in #98 must ADD a pinned dev-only Playwright
harness and `pnpm test:owner-e2e` through ER-00/25/27; that command does NOT exist at this baseline.
Other UI checkpoints add their tests to that one harness, not another browser framework. Local signed
identity fixtures may replace only the external issuer; production auth remains enabled. D1/R2/runtime,
crypto, transactions and application routing in end-to-end acceptance are real local components.

Exact-head CI must pass verify, rust, windows-tooling, local-launch Ubuntu and Windows, and the added
browser jobs where applicable. After shared merges, test combined main again. An inherited failure must
be reproduced/pinned and fixed or explicitly block acceptance; do not report a timed-out run as PASS.

## 5. What a good result is

A checkpoint passes only when its stated user/state behavior executes, its negative tests reject the
specified corruption WITHOUT unauthorized effects, and restart/replay produce the same durable identity.
Attach: before/after test, command/exit/result, exact code SHA, input digest, expected/actual state,
remaining items and migration/generation impact. No source text, private paths, credentials or token-bearing
URLs in public comments. Where external responses are recorded/faked, label them controlled and name the
real components exercised. A count of tests is not a correctness claim by itself.

Code-complete means every LOCAL checkbox for the theme passes; it may remain IMPLEMENTED_NOT_LIVE.
Never close a whole theme for a helper-only checkpoint. An explicitly authorized checkpoint merge retains
its unchecked follow-up. LIVE_QUALIFIED requires the exact retained live receipts; none are fabricated by
this task rewrite. A completed implementation PR and a production release are different decisions.

## 6. First deployment versus production

No remote Cloudflare/Google mutation is authorized by these assignments. Implement probe runners,
config validators and failure tests locally. The canonical T4/T6 live observations necessarily come
AFTER the first complete staging deploy; absence of those receipts is not a circular precondition for
that first trial. Missing mandatory CODE, product integration, tested local loops or critical Rust
promotion IS a precondition failure.

O6/O7 in #96 own the one staging entry procedure; `cloudflare-handoff.md` has the per-theme live matrix.
Run `pnpm launch:code` at staging entry; it intentionally fails today and must not be removed. It is a
negative gate, not an exhaustive completeness proof. Its passing result cannot replace the nine theme
checklists, source registry review and Rust promotion records.

After all local gates pass: obtain explicit operator target/identity/jurisdiction and budget approval,
prove isolated resources, perform read-only `pnpm cf:preflight:remote`, then use ONLY
`node scripts/deploy-cloudflare.mjs --confirm-live` with explicit staging environment and generation.
A staging label alone does not isolate fixed-name resources. No raw Wrangler bypass. Full version,
binding, schema, asset and Wasm readback plus T4/T5/T6 and recovery/cost evidence qualify production.
Targets from canonical §§1.4/15.7–15.8/19 are repository targets, not claims about current vendor quotas.
