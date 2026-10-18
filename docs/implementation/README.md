# Implementation references

Keep the [product manifesto](../architecture/ELIOT_RESEARCH.md) in the lead developer's context. For one task,
open the relevant row below and its actual source callers. Do not load every old audit, launch packet or status file.

## Current route

| Need | Reference |
|---|---|
| What to implement and remove | [Implementation plan](backend-entrypoints.md) |
| Intake, source revisions, indexing and compact citations | [Source lifecycle](source-lifecycle.md) |
| Existing code/data owners | [Code map](dependency-map.md) |
| Storage, effects, access and limits | [Runtime notes](runtime-contract.md) |
| Native Cloudflare mechanisms | [Native path](cloudflare-native-path.md) |
| Ordinary source-backed answer | [Ordinary answer](research-full-answer-v1.md) |
| Explicit bounded deep research | [Deep research](deep-research.md) |
| Owner lists, history and reopening | [Owner reads](owner-read-paths.md) |
| React/Vite cutover and old UI removal | [Frontend cutover](frontend-platform-migration.md) |
| Old run retirement | [Execution retirement](workflow-checkpoints.md) |
| Donor catalogue and exclusions | [Donor register](donors.md) |
| Perplexity mechanisms | [Perplexity review](perplexity-donor.md) |
| NotebookLM public mechanisms | [NotebookLM review](notebooklm-donor.md) |
| EdgeQuake mechanisms and counterexamples | [EdgeQuake review](edgequake-donor.md) |
| Scoped development checks | [Verification](scoped-verification.md) |
| Publication/concurrent work | [Branch discipline](branch-discipline.md) |

Supporting notes such as [failure handling](failure-model.md),
[Rust/Wasm integration](rust-kernel-abi-versioning.md) and the
[security checklist](security-checklist.md) apply only when the selected change reaches that boundary.

Files not listed here are historical evidence, deployment records or superseded plans. They are not required
context or another queue. Distil any still-useful fact into a current document, then remove the historical file
from the working tree when its last real reference is gone. Git history is the archive.

A conflict is corrected in the current owning document. Do not add another status registry, exception layer or
compatibility note around it.
