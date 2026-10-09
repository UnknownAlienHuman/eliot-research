# ER-49: Frontend leaf scheduler and claim validation

**Slice:** owner-interface migration infrastructure
**Depends on:** none
**Consumers:** ER-47 and ER-48 managers
**Authority:** `docs/agent-work/frontend-owner-execution-map.md`
**Manager continuation:** `docs/agent-work/frontend-autonomous-manager-runbook.md`
**Status:** ownership reservation and execution contract only; implementation remains paused until the owner
authorizes ER-49 directly or an autonomous tranche that includes it.

## Objective

Create one small, framework-independent scheduler contract that validates the ER-47/ER-48 leaf DAG, current
claims and append-only claim history before the frontend swarm grows beyond one manager and one leaf.

ER-49 owns definitions and mechanical validation only. It does not own React, owner-client, root integration,
Worker, deployment, manager contexts, product source or claim files. It does not decide whether a test result,
design approval or cross-owner handoff is substantively correct; the manager/operator remains responsible for
that acceptance.

## Owned paths

- `docs/agent-work/frontend-owner-checkpoints.json`
- `scripts/check-frontend-owner-checkpoints.mjs`
- `scripts/test-frontend-owner-checkpoints.mjs`

## Read only

- `docs/agent-work/packets/ER-47.json`
- `docs/agent-work/packets/ER-48.json`
- `docs/agent-work/ER-47-owner-web-interface.md`
- `docs/agent-work/ER-48-owner-api-client-extraction.md`
- `docs/agent-work/frontend-owner-execution-map.md`
- `docs/agent-work/frontend-owner-claims/ER-47/**`
- `docs/agent-work/frontend-owner-claims/ER-48/**`
- ER-47/ER-48 packet-owned implementation paths for Git-history path validation
- `scripts/check-work-packets.mjs`
- root package, lockfile and CI files
- Git metadata required for bounded claim/source-history validation

## Registry contract

`frontend-owner-checkpoints.json` uses protocol `eliotr.frontend-owner-checkpoints.v1` and contains static
scheduling authority only:

```text
checkpoint ID
kind: leaf | manager_gate | external_gate
owning packet
bounded write-scope patterns
manager-only flag
claim_mode: none | single
predecessor IDs
required contracts/evidence classes
mandatory negative case
handoff owner for external gates
```

Every executable leaf uses `claim_mode: single`: one checkpoint ID has at most one `ACTIVE` claim. Parallelism
uses different dependency-ready IDs with disjoint paths. Manager/external gates use `claim_mode: none` and are
satisfied by their named manager/integrator evidence.

The registry contains no mutable assignment, branch name, timestamp, private data or completion state.
Managers publish claims only under their own packet directories:

```text
docs/agent-work/frontend-owner-claims/ER-47/<claim-id>.json
docs/agent-work/frontend-owner-claims/ER-48/<claim-id>.json
```

The filename is `<claim_id>.json`; `claim_id` is immutable and must match the filename.

## Claim contract

A claim records:

```text
claim_id
checkpoint_id
packet_id
manager_identity + manager_context_id
leaf_identity
owner_authorization_ref
base_sha
history_base_sha
canonical exact repository-relative write_paths
predecessor_refs[]:
  checkpoint_id
  commit_sha
  approval_ref when the predecessor is a manager/external gate
state: ACTIVE | HANDED_OFF
handoff_reason when HANDED_OFF: COMPLETED | BLOCKED | ABANDONED | SUPERSEDED
supersedes_claim_id when applicable
bounded evidence/blocker links
```

All active claims in one packet use the same manager identity/context. `owner_authorization_ref` and gate
`approval_ref` are immutable owner-visible issue/PR comments or accepted evidence references. The checker
validates bounded syntax, checkpoint relationship and Git reachability. It does **not** infer that a human
approval is authentic or that tests really passed; operator/review verification owns those semantic facts.

For each predecessor reference the checker proves:

- the checkpoint is an immediate or transitively permitted predecessor in the static registry;
- `commit_sha` is a full commit reachable from and strictly older than the claim base;
- an `approval_ref` is present when the predecessor kind is `manager_gate` or `external_gate`;
- duplicate, foreign, future and self references fail.

Completion authority remains the accepted implementation commit plus its reviewed evidence, not a mutable
`DONE` flag or an unverified claim assertion.

## Append-only claim and source history

Current-tree validation is insufficient: an agent could add or rewrite a claim after editing source, change
its scope or delete it before review. ER-49 therefore has a mandatory history-aware mode:

```text
node scripts/check-frontend-owner-checkpoints.mjs \
  --history-base <full ancestor SHA> \
  --head <full current HEAD SHA>
```

Rules:

- `history_base_sha` is named by the owner authorization/manager context and is an ancestor of `head`;
- when a claim exists now or existed in range, omitting base/head is failure, not reduced validation;
- scan bounded Git history under both claim directories and packet-owned implementation paths, including
  additions, modifications, renames, deletions and merge commits;
- a claim-introduction commit must be a **strict ancestor** of every commit touching its declared source paths;
  introducing a claim and editing covered source in the same commit is rejected;
- every commit touching an ER-47/ER-48 leaf scope must have exactly one `ACTIVE` claim in its parent tree that
  covers every touched exact path and whose checkpoint owns that path;
- a source edit with no active covering claim, an edit outside declared paths, or a path covered by two active
  claims is rejected;
- manager-only and external-gate paths are never authorized by a leaf claim; they require the registry-named
  manager/integrator context and are checked separately by their owning packet;
- claim files themselves are excluded from product-path coverage but remain subject to immutable history;
- claim filename and immutable fields never change after first introduction: IDs, packet/checkpoint,
  manager/context, leaf, authorization, base/history base, paths and predecessor references;
- allowed evolution is only `ACTIVE → HANDED_OFF` once, append-only evidence/blocker links, and addition of the
  required handoff reason/receipt/supersession reference;
- `HANDED_OFF → ACTIVE`, reason replacement, evidence removal/rewrite, rename, deletion or reintroduction is
  rejected;
- rewriting an immutable field requires a new claim ID plus authorized supersession of the old claim;
- validate first blob, every intermediate blob and final tree—not only base-versus-head diff;
- shallow/incomplete history or unreachable base fails closed; fetch history rather than skipping validation.

## Claim recovery and takeover

A claim is never deleted or silently replaced because an agent is unresponsive, a branch is old or work
appears abandoned.

1. Read current head and exact active claim.
2. Obtain owner-visible authorization naming old claim ID, observed head, reason, replacement manager context
   and allowed checkpoint/path scope.
3. Transition the old claim to `HANDED_OFF` with `BLOCKED`, `ABANDONED` or `SUPERSEDED`; preserve fields and
   append authorization/blocker evidence. It cannot claim completion.
4. Publish the transition against refreshed expected head and pass history-aware validation.
5. Create a new committed `ACTIVE` claim with a new claim ID, `supersedes_claim_id`, new base and predecessor
   references.
6. Pass the checker before replacement source edits.

Old transition and replacement addition may share one atomic commit only when authorization names both and the
final tree has no active overlap. Age, silence, missing heartbeat, closed PR or absent local branch never
authorizes takeover.

## Required implementation

- Parse bounded strict JSON and reject duplicate keys before semantic validation.
- Reject unknown load-bearing fields and unsupported protocol versions.
- Verify unique checkpoint IDs, known dependencies, no self/cycle/later-generation dependency.
- Read ER-47/48 ownership from current packet fragments, not a duplicated allowlist.
- Verify each checkpoint scope is contained by its packet; external gates name owner/evidence, not foreign
  paths.
- Verify active claims use known leaf checkpoints and canonical exact paths contained by checkpoint scope.
- Reject more than one active claim per checkpoint and overlapping active paths across checkpoints.
- Reject multiple active manager contexts in one packet, manager/external gates claimed as leaves and
  cross-packet claim placement.
- Validate predecessor references structurally and by ancestry without pretending to verify human/test truth.
- Require canonical forward-slash relative paths: no absolute path, backslash, `.`, `..`, empty segment,
  control/NUL or glob in a claim.
- Enforce strict-ancestor claim-before-source ordering and per-commit active-claim coverage.
- Enforce immutable claim history and legal one-way handoff/recovery transitions.
- Permit missing claim directories only when complete history proves no claims existed in range.
- Produce deterministic bounded output without source text, credentials or private payload.
- Run directly with pinned Node and ordinary Git; no daemon, database, network service, browser or second task
  system. ER-00 may add root/CI invocation without taking ER-49 ownership.

## Mandatory negative case

Seed and prove rejection of:

- unknown/duplicate IDs, self/cycle and bad dependency generation;
- packet-scope escape and manager/external gate claimed as leaf;
- cross-packet placement;
- malformed path, filename/claim-ID mismatch or SHA;
- missing/foreign/future/self predecessor reference or required gate approval reference;
- two active claims for one checkpoint, two manager contexts or overlapping paths;
- missing/unreachable history base or incomplete history;
- source edit before claim, in the same commit as claim, outside claim paths or without any active claim;
- mutation of checkpoint, packet, manager/context, leaf, base, paths, authorization or predecessor fields;
- evidence deletion/rewrite or `HANDED_OFF → ACTIVE`;
- takeover by age/inactivity without authorization;
- replacement while old claim remains active;
- claim rename, deletion or delete/recreate;
- `COMPLETED` handoff without reviewed completion evidence reference;
- supersession pointing to a foreign/nonexistent claim.

Every mutation exits nonzero before affected leaf work is accepted.

## Acceptance and complexity boundary

- Static registry covers every C/U leaf, manager gate and B-C/B-U external gate.
- One manager context per packet and dependency-ready disjoint leaves pass.
- Every source edit is temporally covered by a previously committed active claim.
- Authorized abandoned/superseded recovery passes; unauthorized takeover fails.
- Errors are stable and bounded across Windows/Linux path separators.
- No frontend/runtime dependency or persistent scheduler service is introduced.
- ER-49 authorizes no product implementation, merge, deployment or account mutation.

ER-49 is an optimization for safe parallelism, not a product prerequisite. Until it is accepted, frontend work
may continue sequentially with one manager and one leaf. If implementation starts growing into a general
workflow engine, database, web UI or broad Git policy framework, stop and keep sequential mode rather than
building another product inside the product.

## Handoff

Produce static registry, checker, bounded Git-history reader, mutation/recovery tests and exact command
evidence. After acceptance, managers own claims; definitions change only with the scheduling contract. ER-00
may serialize root-command/CI integration separately.
