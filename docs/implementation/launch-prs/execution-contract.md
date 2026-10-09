# Agent execution and acceptance contract

Applies to the owner-requested launch themes and accepted additive packet amendments. Reviewed against
ELIOT_RESEARCH **29.1**, LANGUAGE_RUNTIME_CONTRACT **1.0**, and current accepted ADRs. This is an
implementation assignment, not a claim that an unchecked feature exists. Use current main plus the active
checkpoint; old PR comments are historical when contradicted by reviewed current authority.

## 1. Mandatory reading and authority

Read `AGENTS.md`, `docs/START-HERE.md`, the selected ER packet, its explicit canonical sections, adjacent
public schemas, `docs/implementation/{runtime-contract,failure-model,security-checklist}.md`, current
`implementation-status.json` and `gap-register.md`.

Canonical authority:

- `docs/architecture/ELIOT_RESEARCH.md`: product, state ownership, precision, privacy and T0–T6;
- `docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md`: TS/Rust/SQL ownership, ABI and test/budget gates;
- accepted `docs/adr/` decisions qualify those contracts and may supersede an older implementation direction;
- `docs/agent-work/manifest.json` plus validated fragments in `docs/agent-work/packets/` define exact path
  ownership.

ADR-0006 scopes legacy Google Cloud/custom OAuth requirements to explicit `drive-exchange`. Selected
`gemini-mcp` has its own authenticated candidate-admission/readback gate and does not require custom Google
Cloud setup.

ADR-0016/0017 replace the owner-web implementation direction without changing backend authority: ER-25 keeps
the served legacy PWA and accepted behavior, ER-47 owns new React UI paths, and ER-48 owns owner-client
extraction/legacy compatibility. Do not treat older “Astro-only” or “all UI belongs ER-25” prose as current
permission.

Checkpoints are subdivisions of packets, not new state owners. Another owner still controls shared changes.
Register a new source/test path in packet document and manifest/fragment together before use. Proposed
paths/commands are work to create, not assertions they already run. Do not copy contract SQL sketches over
current migrations.

## 2. Claim, branch and integration procedure

Post: checkpoint ID, current main SHA, exact files, ER owner, predecessor SHAs and intended tests. Read active
claims. One agent owns one checkpoint at a time.

Owner-directed source implementation is normally direct-main without extra worktrees/task branches. An
explicit owner-requested review PR may be used for documentation/planning such as PR #329; it does not lift
the implementation stop or authorize source work. Preserve concurrent main commits and verify the exact
resulting tree. Branch count/age are not cleanup authority.

One integrator serializes Worker composition/routes/Env, barrels, package/Cargo manifests, lockfiles, CI,
generated bindings, schema registry, migration numbers, canonical Vite/Worker build and deployment scripts.
ER-13 allocates migrations; ER-00 owns toolchain/locks; ER-21/24 own public DTO/route/runtime composition;
ER-25 owns legacy PWA; ER-47 owns new owner-web/UI paths; ER-48 owns owner-client extraction; ER-27 owns
`tests/integration/**`. An unclaimed shared edit is not permission.

Finish or explicitly hand off before another checkpoint.

## 3. Implement each checkpoint this way

1. Reproduce missing behavior at the stated real boundary. Reuse existing ports/adapters; a sentinel is not
   permission for a parallel stack.
2. Implement the narrow state transition/adapter and caller. Mutations use
   `Intent → Attempt → Receipt → Readback → Reconciliation`. No HTTP/model/R2/crypto inside D1 transactions.
   Lost ACK is UNKNOWN, not permission for replacement identity or blind paid retry. Recheck authority after
   external work.
3. Add negative tests and inspect persisted rows/objects, not only mock calls. Show duplicate, stale CAS,
   purge/revoke, expiry, cancellation and bounds at the expensive boundary.
4. Wire through the existing Worker/API and the correct owner UI packet. Dead helpers, disabled buttons,
   interface-only ports and success fixtures do not complete a loop.
5. Update current registry/gaps/checklist in the same implementation checkpoint. New deterministic semantics
   require versioned fixtures and appropriate Rust authority review. Never invent a tenth
   `CompletionDisposition` without normative review.

Minimum bounds: maximum and maximum+1, zero/negative where forbidden, malformed UTF-8/JSON, unknown
load-bearing fields, forged identifiers, foreign owner/scope/generation, partial response, timeout, restart,
lost write response and concurrent replay. Bound before allocation and use immutable handles/cursors for
larger content. Existing narrower limits win.

## 4. Commands and environment

Use pinned tools from `docs/implementation/toolchain.md`. Current legacy/general command families include:

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

`check:affected` runs the full repository/Rust chain, not an incremental shortcut. Use exact Vitest paths
while iterating, then full required gates. Federation storage also runs its package test; Rust tasks run the
applicable full Rust gates. Do not upgrade dependencies to hide failure.

For ER-47/48, these legacy commands remain acceptance inputs until U6 but are not the future React command
contract. Use the scoped families defined in `frontend-platform-migration.md`,
`frontend-agent-harness.md`, `frontend-performance-acceptance.md`, ER-47 and ER-48. U1 introduces exact pins
and executable scripts under existing owners. Ordinary combined Vite/workerd dev must select the explicit
test environment, reject remote/production bindings and remain separate from any authorized remote command.

`pnpm test:library-browser` and `pnpm test:owner-e2e` preserve current ER-25 behavior. They do not prove the
new React interface until scenarios are migrated/dispositioned. ER-47 adds one Playwright/Storybook harness,
not another browser framework. Local signed identity may replace only external issuer; D1/R2/runtime,
transactions and app routing remain real where the acceptance layer claims them.

Exact-head CI must pass its applicable verify/Rust/Windows/local-launch/browser jobs. After shared merges,
test combined main. An inherited failure is reproduced/fixed or explicitly blocks acceptance; timeout is not
PASS.

## 5. What a good result is

A checkpoint passes only when stated user/state behavior executes, negative tests reject corruption without
unauthorized effects, and restart/replay preserve durable identity. Attach command/exit/result, exact SHA,
input digest, expected/actual state, remaining work and migration/generation impact. Do not publish source
text, private paths, credentials or token-bearing URLs. External fixtures are labeled controlled and name the
real components exercised.

Frontend checkpoints additionally retain exact build/config/binding identity, component/scenario ownership,
accessibility/CSP/console/network results, bounded visual and performance receipts, page-lifecycle/private-
state results and unsupported Preview/staging gates. A screenshot, Storybook story, Local Explorer trace or
Preview URL alone is not completion.

Code-complete may remain `IMPLEMENTED_NOT_LIVE`. Never close a whole theme for a helper-only checkpoint. An
explicit partial merge retains unchecked follow-up. `LIVE_QUALIFIED` requires exact retained live receipts;
implementation PR and production release are different decisions.

## 6. First deployment versus production

No remote Cloudflare/Google mutation is authorized by these assignments. Build local probe/config/failure
checks first. T4/T6 live observations occur after the first complete staging deploy; their absence is not a
circular precondition for that trial. Missing mandatory code, product integration, local loops or critical
Rust promotion is a precondition failure.

O6/O7 in #96 own staging entry; `cloudflare-handoff.md` has per-theme live matrix. `pnpm launch:code` must
fail until code gates are complete and is not an exhaustive proof when green.

After local gates: obtain explicit target/identity/jurisdiction/budget approval, prove isolated resources,
perform read-only remote preflight, then use only the authorized deployment orchestrator with explicit
staging generation. A staging label alone does not isolate fixed resources. No raw Wrangler/`cf` bypass.
Full version, binding, schema, assets, Wasm readback plus T4/T5/T6 and recovery/cost evidence qualify
production.

For owner-web U6, deployment uses the one attested canonical Vite client+existing Worker output and generated
output configuration defined by ADR-0016. A separately rebuilt Wrangler Worker or production binding used for
Preview convenience invalidates the frontend release receipt.
