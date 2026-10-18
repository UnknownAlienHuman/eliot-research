# Ordinary answer and whole-source context

Updated 2026-10-17. Target behavior, not a deployed API advertisement.
Use the [current architecture](../architecture/ELIOT_RESEARCH.md) and existing run/client/result owners.
The old proposal's settings endpoints, token journal and new use of `research-run-request.v5` are withdrawn.

## One request and one result

Extend the actual current owner-run schema and its client together. `research-run-request.v5` already
exists in Core `research-run-service.ts` and owner-client `research/runs/authority.ts`; do not redefine it
as though unused. Add a new incompatible wire version only when needed for a real boundary, not because
this document's filename contains v1. No second run API, persistent settings service or capability registry
is a prerequisite to implementing the answer path. Do not advertise an unimplemented feature.

Capture the selected source revisions, model and context choice once with the original request/attempt.
AUTO uses whole selected sources when they fit; otherwise it uses existing retrieval and reports omissions.
FULL rejects overflow instead of truncating; FRAGMENTS uses retrieval. These are context behaviors, not
separate pipelines. A UI preference may reuse existing configuration; it does not need another data owner.
Reading admitted whole sources does not depend on search projection readiness.

Token capacity, serialized provider-request bytes, receipt size and memory are independent bounds.
Honor each without loading the whole corpus or repeatedly encoding the same bodies. Large immutable
inputs live behind an existing locator; compact checkpoints do not repeat source bodies or full planning manifests.

## Streaming and saving

Use one synthesis call through the existing transport. Align the selected prompt/output schema, parser and
materializer: the `answer_markdown` extraction path and deep `material_claims` response are not automatically
the same format. Read their actual callers, choose one coherent ordinary representation and delete replaced
bridges/decoders. No second generic parser or speculative fallback between incompatible shapes.

Only public answer text reaches the browser. Do not expose reasoning, prompts, credentials or raw provider
frames. Label partial text provisional until stored. The existing evidence resolver issues references after
matching quote candidates to exact source revisions/ranges; quote matching alone is not an EvidenceHandle.
Ambiguous or missing matches stay explicitly unresolved. Save answer, citations and summary in existing report storage.

Reconnect reads the same run's current projection and saved result. It must not create a run or re-dispatch
an uncertain effect. Replaying every provisional token is not required; disclose a provisional-text gap
instead of adding a persisted per-token journal. Transport can use the existing stream/session primitives;
there is no mandatory new `answer-events` database, monotonic global event protocol or transcript service.

## Optional audit and completion

An explicitly requested audit follows the usable saved answer and does not gate first text.
Invalid/missing verifier output means unverified, not refuted or successful. Local size/shape checks precede
any paid verification. Preserve cancellation, the selected attempt/model and a practical spend bound.

Done means an integrated ask → stream → save → reopen → exact citation path in the existing app,
with honest omissions and no duplicate paid effect. During implementation compile/lint; execute applicable
product checks after assembly. Do not infer success from a fixture screen, provider response or this document.
