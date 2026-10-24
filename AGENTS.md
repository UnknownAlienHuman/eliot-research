# Working on Eliot Research

Read [ARCHITECTURE](docs/ARCHITECTURE.md) in full before coding and after context compaction.
Keep it in the lead developer's context. Read the relevant [IMPLEMENTATION](docs/IMPLEMENTATION.md)
section, [MAP](docs/MAP.md) row and actual callers before editing. The current user task determines scope.

## Work from evidence

Use `rg` to find existing behaviour. Read installed dependency types and official documentation before
inventing an API. [DONORS](docs/DONORS.md) names reusable mechanisms and their limitations.
Historical ER packets, audits, issue programmes and prototype contracts are evidence for their dated
versions, not a second specification. Current executable legacy shapes remain relevant to data import
and bounded repairs, not a requirement to reproduce them in the replacement.

When documentation is incomplete, investigate and choose the smallest coherent solution within the stated
product. Update the owning section in the same change. Ask only when an unresolved choice changes user
intent, destructive scope or genuinely unavailable information; continue unaffected work.
After two failed approaches, diagnose the failure and change approach. Do not repeat it or automatically
wait for the owner.

## Implement one useful outcome

Trace browser/MCP → product function → stored result → reader. Move real callers and remove replaced
implementations, exports, dependencies and fixtures together. No fake success, swallowed failure,
permanent fallback chain, speculative framework or prototype compatibility without a real consumer.

Use Cloudflare and maintained libraries directly. Share small code when it removes actual duplication.
A folder, class or package needs a responsibility; a donor needs a concrete use. Line counts are diagnostic,
not quotas. Standard input validation, access checks, cancellation and atomic writes remain; repeated
internal proof/qualification machinery does not.

Implement first. Use scoped compilation/lint and minimal Clippy only if Rust changes. Product tests,
quality comparisons and load measurements follow assembly; do not build a testing programme first.
Existing automatic CI is separate. State exactly what ran and what did not.

## Coordinate and finish

One manager uses one checkout/worktree and one publication branch. Assign leaf agents one outcome and
disjoint files; the manager integrates shared routes, schema and configuration. Prefer GPT Luna for leaf
tasks. Do not invent claim files, packet locks, ancestry ceremonies, approval queues or status registries.
Use the expected remote head when publishing and preserve concurrent work.

Architecture owns purpose and requirements. Implementation owns technical decisions. MAP owns source
locations and build order. DONORS owns reuse evidence. Dated audits own verified problems and limitations.
Edit those documents when necessary; do not create an execution diary or duplicate their rules.
A PR explains the user-visible change, verification and material remaining limits.

This documentation change authorizes no deployment or live-data deletion. Preserve actual content and
acknowledged work during the later transition. Unknown production state blocks its destructive operation,
not independent development. Review branches and historical code remain until the relevant integration
or explicitly authorised retirement; do not purge another manager's work.
