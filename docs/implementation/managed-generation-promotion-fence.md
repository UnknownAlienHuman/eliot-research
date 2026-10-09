# Managed-generation acceptance gaps

Recorded 2026-10-09 from PR #244, ER-16/ER-38 and the shared main worktree at `ee5d1138`. These gaps defer only managed-generation acceptance; independent backend work continues and the Goal remains active.

## New item keys require shadow cutover

Status: **IMPLEMENTATION_IN_PROGRESS**.

[PR #244](https://github.com/UnknownAlienHuman/eliot-research/pull/244) requires a new key layout to be built and qualified as a shadow generation before the existing expected-head promotion CAS. It forbids rewriting an ACTIVE generation in place. A separate physical AI Search instance is not required by that rule.

The target-bound Core projection ID changes `ProjectionItem.item_key`: the structural projector hashes the projection generation, and the managed writer uses `<item_key>.md` as the provider key. The previous writer checked ACTIVE readiness only after upload. The correction must deny new-key dispatch to an ACTIVE target before provider I/O, retain exact readback recovery without resend, and preserve historical terminal replay. It must consume an existing selected shadow target; no generation, profile or instance is invented here.

## Complete required-set authority

Status: **IMPLEMENTATION_PENDING**. A selected retrieval snapshot is insufficient promotion evidence.

PR #244 requires builder and promoter to share the complete required set, including manifest/count/hash/ACL sanity and writer drain/readback. ER-16 requires every expected item to be read back before `SHADOW_COMPLETE`; architecture sections 6.4.1-6.4.2 include indexed project-membership copies in the item denominator.

The prepared `packages/cloudflare-ai/src/managed-generation-source-manifest.ts` compares supplied per-source proofs to `ScopeSnapshot.member_source_revision_refs`. This establishes equality to that selected snapshot. It does not establish equality to all canonical source/item assignments for the target managed instance. Per-source terminal receipts and a settled-row scan cannot prove that an eligible source was omitted.

The required integration is a complete-or-raise canonical enumeration of the target's assigned source revisions and desired items, bound to current owner, admission, membership and purge authority. Missing projection work must remain missing work. Caller arrays and configured counts cannot substitute for that denominator. The snapshot-based helper remains unpublished and is not used to promote a generation.

## Preserve the documented pointer owner

ER-38's Active managed-generation authority section makes the SEARCH_DB generation registry canonical. PR #244 requires its existing expected-head CAS. Moving that pointer to Core, creating a replacement registry or introducing another indexer would change the documented authority and is not an accepted implementation path in this checkpoint.

Complete required-set checks must also be fenced against source mutations and unsettled writers through promotion/readback. Cross-D1 pre/post observations can detect drift but cannot be described as one atomic transaction. No new schema or pointer-ownership decision is implied by this note.

## Evidence limits

Local source review and scoped fixtures are separate from native provider qualification. Remote indexing, target-wide required-set/drain acceptance, promotion/rollback, T2/T3 qualification and live routing readback remain pending. No Issue, PR or Goal is closed by these checkpoints.
