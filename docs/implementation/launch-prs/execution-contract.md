# Agent execution and acceptance contract

This contract applies to manager-owned implementation checkpoints. It is not a new product contract,
not a deployment authorization and not evidence that an unchecked feature exists.

Start from [`docs/START-HERE.md`](../../START-HERE.md), then
[`backend-entrypoints.md`](../backend-entrypoints.md), the active PR/passport and the owning ER packet.

## 1. Authority and reading boundary

Read only what the checkpoint needs:

- current `origin/main` code and installed schemas;
- active PR/passport and accepted predecessor SHAs;
- owning ER packet, `owned_paths` and `read_only_paths`;
- named sections of `ELIOT_RESEARCH.md` and `LANGUAGE_RUNTIME_CONTRACT.md`;
- applicable ADRs;
- `runtime-contract.md`, `failure-model.md`, `security-checklist.md`;
- current `implementation-status.json` and `gap-register.md`.

Old PR comments, launch waves and dated audits are historical when they conflict with the current router
or active PR.

A checkpoint is a subdivision of an existing owner. It may not create a new state owner, private schema,
parallel engine or hidden compatibility exception.

## 2. Manager, worktree and shared integration

- One manager owns one worktree and one bounded checkpoint at a time.
- Subagents do not create additional worktrees; they edit disjoint exact paths inside the manager tree or
  remain read-only.
- One named integrator serializes shared contracts, composition roots, public routes, migrations,
  manifests, barrels, package/Cargo manifests, lockfiles, generated bindings and CI.
- The manager records exact base SHA, branch/worktree, ownership, dependencies and gates in the active PR.
- No force-push over concurrent work. A moved expected head requires refresh and reconciliation.
- Historical theme branches are specifications/evidence, not trees to merge wholesale.
- Finish or explicitly hand off before taking another checkpoint.

Follow [`branch-discipline.md`](../branch-discipline.md).

## 3. Implementation sequence

1. Confirm the concrete current-main defect or missing composition path. Do not infer it from old prose.
2. Reuse existing contracts, stores, authority readers and platform primitives.
3. Implement the narrow behavior and its actual caller. A helper with no production caller is not the result.
4. Preserve:

```text
Intent → Attempt → Receipt → Readback → Reconciliation
```

5. Never perform model, HTTP, R2 or crypto effects inside a D1 transaction.
6. Recheck current authority after external I/O and before canonical settlement.
7. Unknown effect or lost acknowledgement is `UNKNOWN`; retryability alone never authorizes a replacement
   identity or repeated paid effect.
8. Remove or retire the replaced duplicate path. A wrapper over two live implementations is not completion.
9. Keep persisted bytes/public fields compatible unless the checkpoint owns an explicit versioned migration.
10. Update status/gap/checkpoint documentation only when the implementation identity actually changed.

Minimum negative dimensions where applicable:

```text
maximum valid / maximum+1
zero or negative values
overlong or malformed UTF-8/JSON
unknown load-bearing fields
forged/foreign owner, scope, generation or handle
partial response and timeout
restart and lost acknowledgement
concurrent same-key replay
revocation, purge, expiry and cancellation
```

Bound reads before allocation. Large data uses immutable locators/handles/cursors; never whole-corpus load.

## 4. Code-first build phase

During product assembly:

- TypeScript: repository-pinned compilation and scoped ESLint;
- Rust: compilation and minimal Clippy for the changed crate;
- SQL: installed D1 depth/target compiler when SQL changes;
- narrow reproduction required by the active PR;
- `git diff --check` before handoff.

Broad unit/browser/native/mutation/live suites run after the product code is assembled unless the active
PR explicitly requires a focused test to establish the defect or boundary now.

Every unexecuted check is written as `PENDING`, never `PASS`.

Useful command patterns are in [`scoped-verification.md`](../scoped-verification.md). Final repository
acceptance still uses `pnpm check:full` and the complete Cargo/native/browser gates applicable to the
assembled tree.

## 5. Required handoff evidence

A manager handoff must state:

```text
exact commit SHA and base SHA
changed paths
migrated callers
removed/retired duplicate functions, branches or engines
legacy codec/persisted-identity impact
net production LOC and bundle delta
D1/R2/provider-call delta
commands and exit codes
negative/replay/lost-ACK/bound evidence
remaining PENDING checks
shared integrator/downstream owner
```

Test counts alone are not correctness evidence. A controlled fixture must name which real components it
exercised and which external/native effects remain unexecuted.

## 6. Integrator acceptance

The integrator:

1. refreshes current main and manager head;
2. compares exact files and diff;
3. rejects stale planning-tree contamination and ownership overlap;
4. verifies predecessor identities;
5. runs required scoped build gates and named reproduction;
6. confirms duplicate removal, not wrapper-only coexistence;
7. publishes without rewriting history;
8. reads the resulting ref and changed-file list back;
9. records the accepted SHA and releases downstream dependencies.

A partial checkpoint does not close a full theme. `IMPLEMENTED_NOT_LIVE` remains valid until the named
native/live receipts exist.

## 7. Cloudflare-first boundary

Use Cloudflare for commodity platform behavior:

```text
AI Search retrieval/filter/rerank
Web Search/Markdown/Browser transport
Workflow retry/delay/wait
Queue redelivery/DLQ
AIChatAgent/WebSocket resume and presentation history
D1/R2/DO storage primitives
Workers Traces and AI Gateway platform controls
```

Eliot owns exact semantic authority: SourceRevision/EvidenceHandle, scope/owner/residency/purge,
coverage/omission/absence, branch/hypothesis identity, claim/citation audit, debt/dispositions/reopen,
versioned artifacts/publication and unknown external-effect settlement.

Do not add Temporal/LangGraph/Dify/RAGFlow runtime, custom vector/graph database, custom WebSocket resume
protocol, second generic DLQ or second indexer to the deterministic core.

## 8. Deployment and account effects

Implementation checkpoints do not authorize remote Cloudflare/Google mutation, paid calls, backup,
historical uncertain-run replay or production release.

After local code assembly, follow the ordered production-readiness plan:

1. exact local integration and D1 authority;
2. attested staging build/bindings/schema/assets;
3. native/security/restore/client conformance and Golden quality;
4. workload/latency/cost;
5. final release acceptance.

A successful deploy command, provider response, Workflow terminal state or local emulator result cannot
substitute for the retained readbacks required by that plan.
