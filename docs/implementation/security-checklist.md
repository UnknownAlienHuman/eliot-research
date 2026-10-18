# Access and data boundaries for the selected product

Apply at the operation that needs the boundary, not as a pipeline around every helper.
The [manifesto](../architecture/ELIOT_RESEARCH.md) defines scope; [runtime notes](runtime-contract.md)
and [owner reads](owner-read-paths.md) locate the implementation. This replaces the old mandatory
AllowedReferenceManifest / SelectionIntegrityReceipt / declassification programme for owner work.

## Read and disclose

Authenticate at ingress with the existing supported mechanism. Derive owner/project access from server
records, not a caller-supplied principal, a source-system ID or a cursor. A delegated task gets its selected
operation/project access, not implicit owner access. Current authorization is distinct from the credentials
or model configuration that once produced a saved report.

List only permitted metadata with direct query predicates. Do not reauthorize the entire source corpus or
open report bodies just to return locators. Citation opening resolves the actual retained revision/range;
source-head changes and unavailable indexing do not rewrite that identity. Optional freshness/readiness
may be UNKNOWN; access failure and actual withdrawal/deletion may not be downgraded to optional metadata.

Source and model text are untrusted content. Keep them out of credentials, tool permissions and executable
instructions; render Markdown safely. Ordinary synthesis does not gain effectful tools from retrieved text.
Publication uses the owner's selected action, not model self-approval. These boundaries need no signed proof
chain, universal input hashes, per-call taint protocol or verifier call for every answer.

## Write, retain and remove

Use existing atomic expected-state changes, original operation identity for retrying a write, and the same
paid attempt after uncertain delivery. Standard storage conditions/checksums are useful at real byte writes,
not as synthetic evidence attached to every function result. [Failure handling](failure-model.md) distinguishes
an ordinary read retry from an uncertain paid invocation.

Owner deletion is a normal authorized product operation. Reuse the existing cleanup path, including private
derived copies where the requested policy requires it; distinguish removing a project attachment from deleting
a Library source. Pending cleanup is not completed deletion. Do not resurrect data through a stale cache,
report or old fallback. This document authorizes no live data deletion or credential migration.

Keep provider/connector credentials server-side in the selected supported store; never expose them in browser
payloads, logs or prompts. Replacing an actual store requires moving needed credentials before removing it.
Do not import old Drive encryption/rotation requirements into unrelated owner paths or build a new cryptosystem.

During development use scoped compile/lint. At product verification exercise the retained access, rendering,
write and deletion paths. Do not manufacture policy receipts, restore canceled modules for old fixtures,
or treat an unrun check as passed.
