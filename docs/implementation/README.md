# Implementation references

[START-HERE](../START-HERE.md) explains how to use the documentation without loading the archive. Keep the
[product manifesto](../architecture/ELIOT_RESEARCH.md) in the lead developer's context. For one task, open the
relevant row below and its actual source callers. Do not load every old audit, launch packet or status file.

## Current route

| Need | Reference |
|---|---|
| What to implement and remove | [Implementation plan](backend-entrypoints.md) |
| Release readiness, schema conversion and rollback boundaries | [Release and schema transitions](production-readiness-plan.md) |
| Intake, source revisions, indexing and compact citations | [Source lifecycle](source-lifecycle.md) |
| Existing code/data owners | [Code map](dependency-map.md) |
| Storage, effects, access and limits | [Runtime boundaries](runtime-contract.md) |
| Native Cloudflare mechanisms | [Native path](cloudflare-native-path.md) |
| Ordinary source-backed answer and report | [Ordinary answer](research-full-answer-v1.md) |
| Explicit bounded deep research | [Deep research](deep-research.md) |
| Progress, live text and reconnect | [ResearchSession delivery](research-session-projection-protocol.md) |
| Wiki pages, Inbox proposals, decisions and edits | [Wiki and Inbox](wiki-inbox.md) |
| Owner lists, history, reopening and report edits | [Owner reads](owner-read-paths.md) |
| React/Vite cutover and old UI removal | [Frontend cutover](frontend-platform-migration.md) |
| Isolated local application and owner session | [Local launch](local-launch.md) |
| Pinned tools and task-sized commands | [Toolchain](toolchain.md) |
| Old run retirement | [Execution retirement](workflow-checkpoints.md) |
| Recovery by operation type | [Failure handling](failure-model.md) |
| Access and data boundaries | [Security checklist](security-checklist.md) |
| Existing Rust/Wasm boundary | [Rust integration](rust-kernel-abi-versioning.md) |
| Donor catalogue and exclusions | [Donor register](donors.md) |
| Perplexity mechanisms | [Perplexity review](perplexity-donor.md) |
| NotebookLM public mechanisms | [NotebookLM review](notebooklm-donor.md) |
| EdgeQuake mechanisms and counterexamples | [EdgeQuake review](edgequake-donor.md) |
| Scoped development checks | [Verification](scoped-verification.md) |
| Publication/concurrent work | [Branch discipline](branch-discipline.md) |

Only this route and its linked current documents supply implementation instructions. Files not listed here are
historical evidence, deployment observations or superseded plans. They do not create another queue, release profile,
path lock or compatibility obligation. Distil a still-useful fact into its current owner, then remove the historical
file when its last live reference is gone. Git history is the archive.

A conflict is corrected in the current owning document. Do not add another status registry, exception layer or
compatibility note around it.
