# Working on Eliot Research

Read and keep the complete [product manifesto](docs/architecture/ELIOT_RESEARCH.md) in the lead
developer's working context. When resuming or rebuilding context, reload it rather than reconstructing
product intent from old issues. The current user task sets the scope; the manifesto supplies its boundaries.

## Read only what the task needs

[Implementation](IMPLEMENTATION.md) routes to the current work plan, code map and technical notes.
Load the selected task and relevant source, not the entire documentation archive. [START-HERE](docs/START-HERE.md)
explains the document roles. Implementation explains how; it cannot silently expand what the product is for.
Old ADRs, ER/S packets, inventories and audit findings are reference evidence, not competing instructions.
Correct a conflicting current note where it lives instead of adding another override document.

## Make the change complete

Change a behavior with its real callers, writers and readers. Remove replaced implementations, exports,
decoders, dependencies and obsolete fixtures in the same coherent integration. No speculative compatibility,
success stubs, permanent transition wrappers or new framework merely to accommodate a refactor.
A source-size delta is not proof of simpler behavior; name the responsibility or duplicate that disappeared.

Preserve actual user content and acknowledged effects. Convert data when necessary; do not retain an old
executor to read its completed output. Unknown live data blocks a destructive migration, not unrelated coding.
Do not deploy, reset data or change credentials as an incidental part of documentation/source cleanup.

## Coordination

One manager uses one checkout/worktree and publication branch. Give available subagents one outcome and
exact disjoint files; serialize shared routes, manifests, migrations and integration. No claim JSON,
ancestry ceremony, packet lock or extra approval queue. Preserve concurrent work and use the expected remote
head when publishing. Do not claim subagent review that did not happen. After two failed approaches,
diagnose the failure and change approach rather than repeat it.

## Verification and documentation

Implement first. During development use scoped compilation/lint and minimal Clippy for changed Rust;
check changed SQL with the existing relevant tooling. Tests and product acceptance follow assembly.
Do not build a testing/coverage programme before the product. Existing automatic CI is separate;
report actual commands, failures and unrun checks accurately.

Architecture holds purpose, scope and principles. Implementation holds source paths, concrete decisions,
donor references and integration details. Update the relevant document; do not duplicate the manifesto,
write an execution diary or create another status registry. The PR needs the result, removals, checks and
remaining limitations. [Branch discipline](docs/implementation/branch-discipline.md) covers publication.
