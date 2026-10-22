# Eliot Research — Architecture

Target design, revised 2026-10-22. This document defines the product and its boundaries; it does not
claim that the replacement is built or deployed. [Implementation](IMPLEMENTATION.md) chooses
the mechanics; [map](MAP.md) locates the work; [donors](DONORS.md) justify reuse;
[audits](../.github/audits/README.md) retain evidence.

## Purpose

A NotebookLM-style research workspace for one human owner and connected agents.
Turn a changing library of papers, documents and web material into useful, inspectable knowledge.
The owner should spend time researching, comparing and deciding, rather than administering a platform.

The core loop is **collect → understand → locate evidence → distil → save → revise and reuse**.
The application must make both a document's short meaning and its exact relevant passages easy to obtain.
Distillation, Wiki maintenance and removing obsolete material belong to this product.

## Product requirements

| Capability | What must work |
|---|---|
| Library and notebooks | Store a source once; attach it to several notebooks. Upload batches, add URLs/text, inspect extraction quality, replace a source, exclude it from search, detach it or delete it deliberately. |
| Several projects | Work in multiple notebooks concurrently, including separate browser tabs. Keep each project's chats, drafts, selection, model defaults and jobs independent. Explicitly search/compare several selected projects without duplicating shared sources. |
| Reading and orientation | Open the original and readable text; navigate its outline; obtain a short guide with stated coverage. Large collections use paginated lists and bounded overviews. |
| Retrieval | Find exact terms and semantic matches, including Russian questions over English papers. Return coherent evidence with headings, table context and links to retained revisions; avoid duplicate excerpts. Distinguish a relevant-passage answer from coverage of every selected document. |
| Models and settings | Connect supported providers, Cloudflare models and compatible custom endpoints; manage credentials through Cloudflare. Choose global/project defaults and a model for a chat or job. Show the selected route and billing mode without recurring qualification steps. |
| Answers | Stream an ordinary answer quickly. Visible source selection, model, response preferences and follow-ups remain under the owner's control. Citations open actual passages; insufficient evidence is stated. Ordinary questions do not start deep research. |
| Distillation | Produce concise source digests and comparative reports with findings, methods, limitations, disagreements and evidence. Show what was read and what remains uncovered. |
| Saved knowledge | Save, reopen, edit, compare and export notes, digests, reports and Wiki pages with immutable history. Refresh affected knowledge when sources change; preserve useful dissent and owner edits. |
| Deep research | An explicit background investigation with visible progress, sources, spending limits and cancellation. It can research the library or use explicitly enabled web discovery and capture. |
| Agents | Connect through standard MCP, discover projects, search/read, contribute sources, accept or decline owner-offered work and save results. External agents can use their own models; reading and writing do not require Eliot to buy another model call. |
| Collaboration | Attribute changes; prevent lost edits; review agent proposals in Inbox or enable direct edits for a chosen notebook. Tasks and saved results survive reconnects. |
| Data ownership | Download originals and retained text, export knowledge with citations and revision metadata, and preserve real content during replacement of the old implementation. |

A notebook is the project's stored/UI unit; do not create parallel project and notebook hierarchies.
It is a view over the shared library, not ownership of a separate copy of each document.
A source revision is an immutable captured/extracted representation. A page revision is derived knowledge.
A citation refers to source revision bytes; a model's statement and a source's statement remain distinguishable.

## What users can rely on

**Evidence stays inspectable.** Search results and generated guides help locate material. They are not
substitutes for the original. Source replacement, parser changes and reindexing do not move old citations.
A citation shows where a claim came from; it does not certify that the claim is true.
An unavailable or deleted source is shown honestly. A top-k search never claims whole-corpus coverage.
Tables, exceptions, contradictory findings and exact identifiers need their surrounding meaning. Native
search locates candidates; canonical section reads and explicit coverage make them useful evidence.

**Saved work remains useful.** The library is readable while indexing or optional model services are down.
Removing a notebook membership does not delete the source. Archival retains historical evidence.
Deletion stops new use immediately; cleanup can complete asynchronously. Existing reports keep their text
and indicate missing support. Erasing derived text is a separate, explicitly selected destructive scope.

**Knowledge improves selectively.** New or changed material identifies affected digests and Wiki pages.
Refresh produces an inspectable revision or proposal; it does not silently rewrite accepted knowledge or
reprocess the entire library. Summaries carry coverage and provenance, rather than claiming unread material
was analysed. Identical imports and retries reuse existing work where their identity is known.

**Execution is bounded.** Ordinary answers use one synthesis after bounded context preparation.
Deep research and long distillation run durably. Once cancellation is observed, no subsequent paid call is
admitted; an already dispatched call may still finish/be billed. Partial findings remain available.
Reconnect resumes observation of the same work. Ambiguous provider completion is disclosed, not treated as
permission for an invisible repeat charge.

**Access is practical.** Cloudflare Access handles sign-in; use its standard service-token or managed
OAuth flows for MCP and a small explicit owner/agent permission check at the application boundary.
Protect secrets, reject unsafe browser content and enforce selected source scope. Optional-service readiness,
credential refresh and historical audit programmes do not become global locks on opening the application.
Do not add signatures, encryption keys, proof receipts or repeated token exchanges between internal steps.

**Projects do not interfere.** Switching projects does not erase drafts, retarget a stream or cancel a
background job. An explicit cross-project request reads only its chosen permitted scope and saves into a
chosen destination. One project's model error or job limit cannot block another project's readable work.

## System shape

Use one Cloudflare Worker serving a React/Vite application, API and MCP. D1 owns product metadata and
relationships; R2 owns retained files and large immutable bodies. Native AI Search supplies retrieval.
Cloudflare Workflows runs background work; the Agents SDK supplies chat persistence/streaming where useful.
Use AI SDK and AI Gateway for the configured model routes. External agents connect to Eliot; Eliot does not
reimplement their harnesses.

The browser follows the established NotebookLM/Material intent: sources and navigation, a readable research
area, and saved knowledge/work in adjacent panes; light/dark themes and English/Russian text remain.
Agent and browser operations call the same product functions. Plain modules divide sources, retrieval,
knowledge, research and access; packages, adapters and deployment units are not product features.

## How to stay compact

- Implement one complete user action through its real caller, durable write and reader.
- Prefer a supported platform API or maintained library. Reuse a donor's specific useful mechanism;
  do not import its platform, scope or dependencies by association.
- Keep one owner of each fact and one current implementation of each behaviour. Replace callers and
  remove the predecessor, rather than stacking another generation around it.
- Add an abstraction when it reduces existing complexity. Avoid forwarding layers and speculative
  extension points; do not enforce arbitrary word bans, line quotas or a magic number of tables.
- Put ordinary constraints and atomic updates in SQL; put workflows and product decisions in readable
  TypeScript. Do not recreate a policy engine in triggers.
- Keep the architecture in the lead developer's context. Read the relevant implementation and actual code
  before changing them. Correct the authoritative document where it is wrong.
- Audits record reproducible findings and their consequences. They are evidence, not an approval machine.
  Build first with scoped compile/lint checks; evaluate the assembled product against real journeys.

## Scope boundaries

The first complete replacement includes the capabilities above. Build them in the order in the map;
an early vertical slice may omit later steps, but must not be called the finished product.

Do not build enterprise tenancy, a general agent governor, custom cryptography/proof chains,
index-generation promotion, a graph database, a workflow DSL, a model-qualification service or permanent
compatibility with discarded prototypes. No Rust/Wasm port is required without a measured workload and
a real caller. Audio/video studio products, public sharing and a connector marketplace are later choices.

Keep useful content, completed results and known active work from the old system. A compact replacement is
the selected direction; removing live data, deploying it or retiring production resources is separate work.
No document can guarantee correct agent behaviour. Clear scope, actual source reading, small integrations
and independent review make drift detectable while it is still cheap to fix.
