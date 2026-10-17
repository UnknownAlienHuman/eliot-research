# Full-source answer interface

Status: implementation contract, 2026-10-17. Not deployed. The current v1-v4 run
requests and historical generations keep their existing meaning. A UI must use
the new path only when the server advertises `full_source_answer_v1`.

## Context settings

Target owner route: `GET/PUT /api/v2/projects/{project_id}/answer-settings`.
GET returns `{ protocol: "eliotr.answer-settings.v1", project_id, revision,
context_mode: "AUTO"|"FULL"|"FRAGMENTS" }`.
PUT takes `{ protocol: "eliotr.answer-settings-update.v1", expected_revision,
context_mode }`. The server uses CAS; it never resets the model configuration.
This stores a preference. Each run freezes its effective settings and model.

The new run request version is `eliotr.research-run-request.v5`, retaining v4
fields and adding `context_mode`. The chat's selected provider/model stays in
the existing `selection`. AUTO reads all selected admitted normalized documents
when the captured model budget permits. FULL rejects a budget overflow; it never
silently truncates a document. FRAGMENTS uses retrieval. Readiness of a search
projection is not a prerequisite for whole-source reads.

## Answer stream

Target read route: `GET /api/v1/research/run/{workflow_instance_id}/answer-events?after={sequence}`.
The response is SSE, `Cache-Control: no-store, no-transform`. Each event's `id`
is a monotonic positive integer and its JSON `sequence` equals that ID. Every
event has `protocol: "eliotr.answer-event.v1"`, `workflow_instance_id`,
`sequence`, `created_at`, and `type`. Event-specific fields are:

| type | Fields |
| --- | --- |
| `answer.context` | `requested_mode`, `effective_mode` (FULL or FRAGMENTS), `source_count`, `full_source_count`, `context_bytes`, `source_snapshot_sha256`, `provider`, `model` |
| `answer.delta` | `text` (only public answer Markdown; provisional) |
| `answer.saved` | `artifact_ref`, `section_refs`, `first_text_ms` (nullable), `answer_ms`, `citation_status` (COMPLETE/PARTIAL/NONE), `audit_status` (PENDING/NOT_REQUESTED) |
| `answer.audit` | `state` (VERIFIED/PARTIAL/NOT_VERIFIED), `reason_code` (nullable), `audit_ms` |
| `answer.failed` | `code`, `message`, `phase` (PREPARE/CONTEXT/ANSWER/SAVE/AUDIT), `dispatch_state` (NOT_STARTED/STARTED/SETTLED/UNKNOWN) |

`answer.context` precedes text. `answer.saved` means the draft and exact citation
bindings have been read back, not that semantic claims have passed an audit.
The UI shows the answer while audit is PENDING, then its actual result.
Invalid verifier JSON produces NOT_VERIFIED, never a contradicted claim.

Reconnect reads retained events after the last applied sequence. Duplicate
sequences are ignored. A reconnect cannot dispatch a model, create a run or
retry an uncertain effect. Current source/owner/purge access is checked before
streaming and at each retained batch; authority loss clears protected UI data.
Expired execution authority does not by itself expire historical read access.

Only provider output-text deltas may reach `answer.delta`. Reasoning, provider
events, prompts, credentials and raw verification payloads are never public
events. Partial output is labelled provisional until saved. If the connection
closes without saved/failed, the client reads the same run; it does not resubmit.

## Execution

Five durable primary steps: PREPARE, CONTEXT, ANSWER, SAVE, AUDIT. Audit is
optional and follows visible/saved answer. PREPARE freezes scope, selected
configuration, captured capacity and idempotency identity. CONTEXT reads bounded
complete source bytes concurrently (at most four), with hash/residency bindings.
ANSWER dispatches one synthesis attempt. SAVE matches quote text against its
exact source snapshot, maps whitespace-tolerant matches to original UTF-8 byte
offsets, issues existing EvidenceHandles, and saves the draft. Ambiguous or
missing quotes cannot receive handles. AUDIT cannot delay initial answer text.

Provider quotas are independent GET reads; no quota network probe is added to
the answer path. Reranking settings are a separate versioned selection and must
not claim an adapter is available until that adapter is connected and qualified.
