# NotebookLM: public mechanisms and useful transfers

Checked 2026-10-18. This is a scoped primary-source review, not Google's internal design or a replica recipe.
The familiar NotebookLM name is retained here for discovery; Google announced the standalone product's rename
to Gemini Notebook on 2026-07-16 [G1]. Consumer, Enterprise and Gemini API documentation are separate evidence.
The [donor register](donors.md) counts source repositories separately from these closed products/services.
The [manifesto](../architecture/ELIOT_RESEARCH.md) stays unchanged; choices below refine existing implementation.

## What Google actually discloses

| Evidence and date | Confirmed mechanism | Not established by that evidence |
|---|---|---|
| NotebookLM engineering announcement, 2025-10-29 [G2] | Large context, multi-turn history and retrieval/ranking work together; source exploration uses multiple angles before one synthesized response. The announced window was one million tokens. | That every stored source is passed in full, or that this dated window is a universal current API limit. No exact chunking, top-k, vector database, reranker weights, subagent count or prompt is published there. |
| Product/engineering announcement, 2026-06-08, updated 2026-07-16 [G3] | Gemini 3.5 and Antigravity; a notebook cloud computer can execute code and produce artifacts. Source discovery can use Google Search while the user controls additions. | Access for every account or an instruction to create a permanent computer, 100-skill catalogue and automatic tool loop in Eliot. Reported internal win rates are not our measurements. |
| Current source help [G4] and chat/notes help [G5], [G6] | Explicit source selection, imported representations, source-opening citations, saved outputs and selectable notes. | A citation chip proves neither exact quotation nor factual correctness; source storage quotas are not generation-context capacity. |
| DeepMind speech research, 2024-10-30 [G7] | Audio Overviews use research on long multi-speaker generation. The disclosed speech system takes a dialogue script with speaker markers, predicts hierarchical acoustic tokens and decodes them to a waveform. | That the 2023 SoundStorm architecture is the unchanged current production model, or that audio generation describes the text-retrieval pipeline. Script planning details/current weights are not specified. |

The useful abstraction is selected material → appropriate retrieval/reading → grounded synthesis → inspectable
saved output, with tools for work that benefits from them. This is our interpretation of public behavior,
not a claim that Google's internal call graph has four functions. A longer context and retrieval are complementary.
There is no evidence in these inspected sources that NotebookLM uses GraphRAG or the Gemini File Search product
as its backend. Neither conclusion follows from a common vendor, citation UI or the word RAG.

## Source lifetime and representation are product-specific

Consumer help now documents automatically refreshed Drive sources; loss of Drive access makes them unavailable.
The Enterprise overview still describes static imported copies, including in its consumer comparison [G4], [G8].
This is a documentation/edition discrepancy, not permission to assert identical synchronization behavior.
For an actual integration, resolve that edition's supported behavior; do not create a compatibility layer around
both descriptions or treat a refreshed upstream file as the same bytes previously cited.

The current help distinguishes HTML text, YouTube transcripts and audio transcribed at import. A URL is not
proof that embedded media or linked pages were read. Source guides summarize; they are not original evidence [G4].
Eliot should retain the actual imported representation and revision, with a direct origin link and truthful
unavailable/partial status. Refresh only when the selected import behavior requires it, not on every question.
A changed parse creates new coordinates; old saved citations must not silently move.

Notes and saved answers can be selected as context in the current product [G6]. For Eliot, explicit reuse of a
report/Wiki note is useful, but it remains a derivative. Preserve its source references; do not turn yesterday's
model answer into an independent primary source through re-import. Unselected notes are not hidden memory.

## Three interfaces that must not be conflated

| Interface | Public evidence | Eliot decision |
|---|---|---|
| NotebookLM / Gemini Notebook consumer application | Product UI and help; internal storage/retrieval implementation is not disclosed by these pages. | Behavior reference. No undocumented browser RPC/cookie adapter or claim that a third-party wrapper is an official chat API. |
| Gemini Notebook Enterprise API | Preview `v1alpha` guides expose notebook management, source batch creation/upload/get/delete and audio-overview generation [G9], [G10], [G11]. Upload identity and processing-complete status are separate observations. | Do not say NotebookLM has no API. These reviewed guides do not establish a supported general conversational endpoint; don't invent one. Enterprise administration is not Eliot's runtime architecture. |
| Gemini API File Search | A separately documented managed retrieval service with import/indexing, metadata filters and citation annotations [G12], [G13]. | A vendor-specific capability reference, not proof of NotebookLM internals and not a second default index beside Cloudflare. No provider migration is selected. |

File Search documentation checked at its 2026-10-13 revision excludes Live API use and combining File Search
with Google Search or URL Context in one request. Its raw upload lifetime and persistent indexed-store lifetime
are different. Current examples use Interactions response annotations; do not transplant those into another
API's response decoder. Supported inputs/citations must be read from the selected API, not inferred from what
the NotebookLM UI accepts [G12]. Its May 2026 multimodal/page-citation announcement is separate evidence [G13].
A provider page locator still needs mapping to Eliot's retained representation for an exact historical quotation.

Audio illustrates a reusable lifecycle, not a new selected feature: captured sources → requested transformation
→ retained result. Speech-rendering speed in the 2024 research is not full notebook processing latency.
A polished spoken summary can still be wrong. Do not build or train a speech stack to borrow this interaction.

## Changes to the existing Eliot implementation

| Existing owner / entrypoint | Concrete change | Remove or avoid |
|---|---|---|
| Core `research-run-service.ts` and owner-client `research/runs/authority.ts` | Capture explicit source revisions and the relevant existing follow-up/run reference at admission. Omitted selection uses the defined default; explicit empty selection stays empty. | Treating empty as the whole Library; a second admission/settings/thread service. A source-backed question with no sources reports that state. |
| `cloudflare-ai/src/project-search.ts` and research retrieval composition | Standalone question: existing scoped native search. A follow-up needing disambiguation can use bounded conversation `messages` with native rewriting; keep the same source filter. | Toggling a boolean while still sending only one message; native rewrite plus another local rewrite/planner. |
| `policy/src/context-compiler.ts`, source/evidence readers and synthesis prompt | Prepare on the server from selected references. Keep source text, conversational context and derived notes distinct. Count the actual emitted request, including history and wrappers. | Server → browser → server transfer of the assembled corpus; silently skipped selected sources; counting a different DTO string. |
| Existing structural navigation and `retrieval/src/structural-navigation.ts` | Use titles/outline/source guides for orientation, then open relevant passages or whole selected sources within the budget. | Mandatory model summaries or complete entity extraction before a source can answer a question. A guide is not a substitute for reading evidence. |
| Existing report/Wiki/Inbox writers | Save usable output with references; reuse selected notes explicitly and refresh only affected derived work. | Another knowledge store, automatic memory extraction on each turn, or silently moving old citations after source refresh. |
| Existing native model/connected-agent task path | For a requested calculation or artifact, use existing structured data/functions or an appropriate supported tool and return its actual result. Keep `gemini-mcp` as selected Google transport. | Building a NotebookLM clone, a new sandbox service or a generic tool/skills framework merely because Google uses one. |

Current `searchProject` at Eliot `aefca049` sends one user message and disables rewriting. Cloudflare documents
that rewriting requires `messages`, leaves the first message as-is and uses conversational context on later
turns [C1]. Pass relevant authorized context through the actual caller and decoder; reuse existing run/result
relationships rather than creating a transcript database. Prior assistant prose is conversational context,
not evidence. Source changes apply before assembling the next turn; old material must not leak back via history.

The default remains one ordinary synthesis. That is not a rule to answer badly after one irrelevant hit.
Prefer a bounded adjacent/full-source read for a concrete gap; use additional searches for identified unresolved
questions or the explicit deep task, sharing the same prepared material. Native rewriting is extra model work,
not free intelligence. Do not recreate Google's undisclosed multi-angle implementation as a fixed agent panel.
See [ordinary answers](research-full-answer-v1.md) and [native Cloudflare choices](cloudflare-native-path.md).

## Open Notebook: a useful code donor, not Google's source

Additional source reads at `lfnovo/open-notebook@a0f6f3081ae06328f0a451b3a3ef2959ca25721d`:
[context builder][D1], [chat node][D2] and [HTTP callers][D3]. No code or dependency is imported.

The builder has focused notebook/source functions. Source context separates original text from generated
insights and avoids a nested duplicate of insights; the default notebook branch batches insight loading.
The ordinary chat node has one explicit answer-model invocation, unlike its separate multi-call Ask graph.
Take focused functions and shared prepared data, not the surrounding one-node LangGraph/SQLite/thread bridge.

Important differences from Eliot's selected behavior:
- Missing/empty notebook config selects all short source/note contexts; configured inclusion uses substring
  matching on display strings. Eliot needs typed intent and explicit-empty semantics, changed with the client.
- Notebook assembly catches errors and skips individual records; its returned omission status does not describe
  those skipped records. Eliot reports missing selected material, without converting an outage into no evidence.
- `/chat/context` returns corpus content, and `/chat/execute` accepts that context back and uses it in state.
  Eliot builds once from server-resolved references. This is a data-flow observation, not a security exploit claim.
- Notebook token estimation uses concatenated `str(dict)`; Source Chat has a distinct Markdown counter and can
  truncate source text. Neither its tokenizer/word heuristic nor truncating branch implements Eliot FULL semantics.

Google Research's superconductivity example used models evaluated in December 2024, despite later publication
[G14]. It supports investigating curated source quality, not a current-model ranking or an Eliot performance
claim. No NotebookLM/Enterprise account experiment, donor benchmark or full-codebase audit ran in this review.

## Primary references

[G1]: https://blog.google/intl/de-de/produkte/suchen-entdecken/notebooklm-wird-gemini-notebook/
[G2]: https://blog.google/innovation-and-ai/models-and-research/google-labs/notebooklm-custom-personas-engine-upgrade/
[G3]: https://blog.google/innovation-and-ai/products/notebooklm/better-research-notebooklm/
[G4]: https://support.google.com/gemininotebook/answer/16215270?hl=en
[G5]: https://support.google.com/gemininotebook/answer/16179559?hl=en
[G6]: https://support.google.com/gemininotebook/answer/16262519?hl=en
[G7]: https://deepmind.google/blog/pushing-the-frontiers-of-audio-generation/
[G8]: https://docs.cloud.google.com/gemini/enterprise/notebooklm-enterprise/docs/overview
[G9]: https://docs.cloud.google.com/gemini/enterprise/notebooklm-enterprise/docs/api-notebooks
[G10]: https://docs.cloud.google.com/gemini/enterprise/notebooklm-enterprise/docs/api-notebooks-sources
[G11]: https://docs.cloud.google.com/gemini/enterprise/notebooklm-enterprise/docs/api-audio-overview
[G12]: https://ai.google.dev/gemini-api/docs/file-search
[G13]: https://blog.google/innovation-and-ai/technology/developers-tools/expanded-gemini-api-file-search-multimodal-rag/
[G14]: https://research.google/blog/testing-llms-on-superconductivity-research-questions/
[C1]: https://developers.cloudflare.com/ai-search/configuration/retrieval/query-rewriting/
[D1]: https://github.com/lfnovo/open-notebook/blob/a0f6f3081ae06328f0a451b3a3ef2959ca25721d/open_notebook/utils/context_builder.py
[D2]: https://github.com/lfnovo/open-notebook/blob/a0f6f3081ae06328f0a451b3a3ef2959ca25721d/open_notebook/graphs/chat.py
[D3]: https://github.com/lfnovo/open-notebook/blob/a0f6f3081ae06328f0a451b3a3ef2959ca25721d/api/routers/chat.py
